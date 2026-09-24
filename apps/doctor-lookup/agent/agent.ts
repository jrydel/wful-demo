// Keeps the ElevenLabs agent in step with this directory: system-prompt.md is the agent's prompt,
// find-doctor.tool.json the find_doctor tool's name, description and parameters.
//
//   bun --env-file=.env.production run agent:check   # exit 1 on any difference
//   bun --env-file=.env.production run agent:push    # update the agent and tool, then check
//
// Check also compares the tool's specialty and language enums with the published Search DB (read
// from R2 with wrangler), so a specialty new upstream is reported instead of silently missing.
// Push changes only the prompt text and the tool's name, description and parameters; the URL, the
// secret Authorization header and the conversation-id header stay as configured.

import { ELEVENLABS_AGENT_ID, ELEVENLABS_TOOL_ID } from "@doctor-directory/shared/deployment";
import type { SearchIndex } from "@doctor-directory/shared/search-index";
import { $ } from "bun";

interface RepoParameter {
  readonly type: string;
  readonly description: string;
  readonly enum?: ReadonlyArray<string>;
}

interface RepoTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly properties: Record<string, RepoParameter>;
    readonly required: ReadonlyArray<string>;
  };
}

/** A body property as ElevenLabs stores it; fields this script does not manage are kept. */
interface LiveParameter extends Record<string, unknown> {
  type: string;
  description: string;
  enum: ReadonlyArray<string> | null;
}

interface LiveToolConfig extends Record<string, unknown> {
  name: string;
  description: string;
  api_schema: Record<string, unknown> & {
    request_body_schema: Record<string, unknown> & {
      properties: Record<string, LiveParameter>;
      required: ReadonlyArray<string>;
    };
  };
}

interface LiveAgent {
  conversation_config: { agent: { prompt: { prompt: string; tool_ids?: ReadonlyArray<string> } } };
}

const DATA_OBJECT = "doctor-directory-data/search-index.json";
const here = import.meta.dir;
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("ELEVENLABS_API_KEY is not set (bun --env-file=.env.production ...)");

async function elevenlabs<T>(path: string, init?: { method: "PATCH"; body: unknown }): Promise<T> {
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    method: init?.method ?? "GET",
    headers: { "xi-api-key": key ?? "", "content-type": "application/json" },
    body: init && JSON.stringify(init.body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

const sameList = (a: ReadonlyArray<string> | null | undefined, b: ReadonlyArray<string> | null) =>
  JSON.stringify(a ?? null) === JSON.stringify(b);

async function differences(): Promise<string[]> {
  const found: string[] = [];
  const prompt = await Bun.file(`${here}/system-prompt.md`).text();
  const repo = (await Bun.file(`${here}/find-doctor.tool.json`).json()) as RepoTool;
  const [agent, tool] = await Promise.all([
    elevenlabs<LiveAgent>(`/v1/convai/agents/${ELEVENLABS_AGENT_ID}`),
    elevenlabs<{ tool_config: LiveToolConfig }>(`/v1/convai/tools/${ELEVENLABS_TOOL_ID}`),
  ]);

  const livePrompt = agent.conversation_config.agent.prompt;
  if (livePrompt.prompt !== prompt) {
    const repoLines = prompt.split("\n");
    const line = livePrompt.prompt.split("\n").findIndex((text, i) => text !== repoLines[i]);
    found.push(`prompt: differs from system-prompt.md at line ${line + 1}`);
  }
  if (!livePrompt.tool_ids?.includes(ELEVENLABS_TOOL_ID)) {
    found.push(`agent: find_doctor (${ELEVENLABS_TOOL_ID}) is not attached`);
  }

  const live = tool.tool_config;
  if (live.name !== repo.name) found.push(`tool name: "${live.name}", repo "${repo.name}"`);
  if (live.description !== repo.description) found.push("tool description differs");
  const body = live.api_schema.request_body_schema;
  const names = new Set([
    ...Object.keys(repo.parameters.properties),
    ...Object.keys(body.properties),
  ]);
  for (const name of names) {
    const want = repo.parameters.properties[name];
    const have = body.properties[name];
    if (!want || !have) {
      found.push(`parameter ${name}: ${want ? "missing in ElevenLabs" : "not in the repo"}`);
      continue;
    }
    if (have.type !== want.type)
      found.push(`parameter ${name}: type ${have.type}, repo ${want.type}`);
    if (have.description !== want.description) found.push(`parameter ${name}: description differs`);
    if (!sameList(want.enum, have.enum)) found.push(`parameter ${name}: enum differs`);
  }
  if (!sameList([...body.required].sort(), [...repo.parameters.required].sort())) {
    found.push("required parameters differ");
  }

  // The data decides which values exist; the enum must offer every one of them.
  const index = JSON.parse(
    await $`bunx wrangler r2 object get ${DATA_OBJECT} --jurisdiction eu --remote --pipe`
      .cwd(`${here}/..`)
      .quiet()
      .text(),
  ) as SearchIndex;
  const inData = {
    specialty: new Set(index.specialties.map(([, display]) => display)),
    language: new Set(
      index.names.flatMap(({ doctors }) => doctors.flatMap((doctor) => doctor.languages)),
    ),
  };
  for (const [name, values] of Object.entries(inData)) {
    const offered = new Set(repo.parameters.properties[name]?.enum ?? []);
    const missing = [...values].filter((value) => !offered.has(value)).sort();
    const unused = [...offered].filter((value) => !values.has(value)).sort();
    if (missing.length) found.push(`${name} enum lacks values in the data: ${missing.join(", ")}`);
    if (unused.length)
      found.push(`${name} enum offers values not in the data: ${unused.join(", ")}`);
  }
  return found;
}

async function push(): Promise<void> {
  const prompt = await Bun.file(`${here}/system-prompt.md`).text();
  const repo = (await Bun.file(`${here}/find-doctor.tool.json`).json()) as RepoTool;
  const { tool_config: live } = await elevenlabs<{ tool_config: LiveToolConfig }>(
    `/v1/convai/tools/${ELEVENLABS_TOOL_ID}`,
  );
  const liveProperties = live.api_schema.request_body_schema.properties;
  const properties = Object.fromEntries(
    Object.entries(repo.parameters.properties).map(([name, want]) => [
      name,
      {
        dynamic_variable: "",
        constant_value: "",
        is_system_provided: false,
        ...liveProperties[name],
        type: want.type,
        description: want.description,
        enum: want.enum ?? null,
      },
    ]),
  );
  await elevenlabs(`/v1/convai/tools/${ELEVENLABS_TOOL_ID}`, {
    method: "PATCH",
    body: {
      tool_config: {
        ...live,
        name: repo.name,
        description: repo.description,
        api_schema: {
          ...live.api_schema,
          request_body_schema: {
            ...live.api_schema.request_body_schema,
            properties,
            required: repo.parameters.required,
          },
        },
      },
    },
  });
  await elevenlabs(`/v1/convai/agents/${ELEVENLABS_AGENT_ID}`, {
    method: "PATCH",
    body: { conversation_config: { agent: { prompt: { prompt } } } },
  });
  console.log("pushed the prompt and the find_doctor tool");
}

const mode = process.argv[2];
if (mode !== "check" && mode !== "push") throw new Error("usage: agent.ts check | push");
if (mode === "push") await push();
const found = await differences();
for (const line of found) console.log(`✗ ${line}`);
if (found.length) process.exit(1);
console.log("✓ agent, tool and enums match the repo and the published data");
