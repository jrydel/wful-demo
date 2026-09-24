import { env } from "cloudflare:workers";
import {
  CLOUDFLARE_ACCOUNT_ID,
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_TOOL_ID,
} from "@doctor-directory/shared/deployment";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { Fact } from "./topology";
import { SCRIPTS, type Script } from "./usage";

const ACCOUNT = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}`;
const DATA_BUCKET = { name: "doctor-directory-data", jurisdiction: "eu" };

/** R2 location hints, as the API reports them. */
const LOCATIONS: Record<string, string> = {
  EEUR: "Eastern Europe",
  WEUR: "Western Europe",
  ENAM: "Eastern North America",
  WNAM: "Western North America",
  APAC: "Asia-Pacific",
  OC: "Oceania",
};

export interface WorkerConfig {
  readonly url: string | undefined;
  /** Storage, services and Durable Objects the Worker is connected to. */
  readonly bindings: ReadonlyArray<Fact>;
  /** Plain configuration values. */
  readonly vars: ReadonlyArray<Fact>;
  /** Names only; values are never readable. */
  readonly secrets: ReadonlyArray<string>;
  readonly compatibility: string;
  readonly crons: ReadonlyArray<string>;
  readonly deployed: { readonly at: string; readonly version: string } | undefined;
}

export interface BucketConfig {
  readonly name: string;
  readonly location: string;
  readonly jurisdiction: string;
  readonly storageClass: string;
  readonly created: string;
}

export type CloudflareConfig =
  | {
      readonly available: true;
      readonly workers: Record<Script, WorkerConfig>;
      readonly bucket: BucketConfig | undefined;
      /** API paths the token was refused; everything else is still shown. */
      readonly denied: ReadonlyArray<string>;
    }
  | { readonly available: false; readonly reason: string };

export interface AgentConfig {
  readonly available: true;
  readonly name: string;
  readonly llm: string;
  readonly temperature: number;
  readonly voice: string;
  readonly ttsModel: string;
  readonly asr: string;
  readonly languages: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  readonly maxCallSeconds: number;
  readonly concurrency: number;
  readonly dailyLimit: number;
  readonly fillerAfterSeconds: number | undefined;
  readonly tool: {
    readonly name: string;
    readonly method: string;
    readonly url: string;
    readonly timeoutSeconds: number;
    readonly headers: ReadonlyArray<string>;
  };
}

export type AgentConfigResult =
  | AgentConfig
  | { readonly available: false; readonly reason: string };

interface Binding {
  type: string;
  name: string;
  bucket_name?: string;
  jurisdiction?: string;
  service?: string;
  class_name?: string;
  text?: string;
}

async function cloudflare<T>(token: string, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${ACCOUNT}${path}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
  const body = (await response.json()) as {
    success: boolean;
    result: T;
    errors: { message: string }[];
  };
  if (!body.success)
    throw new Error(`${path}: ${body.errors[0]?.message ?? `HTTP ${response.status}`}`);
  return body.result;
}

function describeBinding(binding: Binding): string {
  switch (binding.type) {
    case "r2_bucket":
      return `R2 bucket ${binding.bucket_name}${binding.jurisdiction ? ` (${binding.jurisdiction.toUpperCase()} jurisdiction)` : ""}`;
    case "service":
      return `Worker ${binding.service}`;
    case "durable_object_namespace":
      return `Durable Object ${binding.class_name}`;
    default:
      return binding.type;
  }
}

/** Runs one API call; a refusal is recorded instead of failing the whole panel. */
function attempt(denied: string[]) {
  return async <T>(call: Promise<T>): Promise<T | undefined> => {
    try {
      return await call;
    } catch (error) {
      denied.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };
}

async function workerConfig(
  token: string,
  script: Script,
  subdomain: string | undefined,
  denied: string[],
): Promise<WorkerConfig> {
  const tryCall = attempt(denied);
  const [settings, schedules, route, deployments] = await Promise.all([
    tryCall(
      cloudflare<{
        bindings: Binding[];
        compatibility_date: string;
        compatibility_flags: string[];
      }>(token, `/workers/scripts/${script}/settings`),
    ),
    tryCall(
      cloudflare<{ schedules: { cron: string }[] }>(token, `/workers/scripts/${script}/schedules`),
    ),
    tryCall(cloudflare<{ enabled: boolean }>(token, `/workers/scripts/${script}/subdomain`)),
    tryCall(
      cloudflare<{
        deployments: {
          created_on: string;
          versions: { version_id: string }[];
        }[];
      }>(token, `/workers/scripts/${script}/deployments`),
    ),
  ]);
  const bindings = settings?.bindings ?? [];
  const latest = deployments?.deployments[0];
  return {
    url: route?.enabled && subdomain ? `https://${script}.${subdomain}.workers.dev` : undefined,
    bindings: bindings
      .filter((b) => b.type !== "plain_text" && b.type !== "secret_text")
      .map((b) => ({ label: b.name, value: describeBinding(b) })),
    vars: bindings
      .filter((b) => b.type === "plain_text")
      .map((b) => ({ label: b.name, value: b.text ?? "" })),
    secrets: bindings.filter((b) => b.type === "secret_text").map((b) => b.name),
    compatibility: settings
      ? [settings.compatibility_date, ...settings.compatibility_flags].join(", ")
      : "",
    crons: schedules?.schedules.map((sc) => sc.cron) ?? [],
    deployed: latest && {
      at: latest.created_on,
      version: latest.versions[0]?.version_id ?? "",
    },
  };
}

export const getCloudflareConfig = createServerFn().handler(async (): Promise<CloudflareConfig> => {
  const token = env.CF_ANALYTICS_TOKEN;
  if (!token) return { available: false, reason: "Set the CF_ANALYTICS_TOKEN secret." };
  const denied: string[] = [];
  const tryCall = attempt(denied);
  // Some tokens are refused the account subdomain even with Workers Scripts: Read. This console
  // runs on the same account, so its own workers.dev hostname carries the same subdomain.
  const account = await cloudflare<{ subdomain: string }>(token, "/workers/subdomain").catch(
    (error: unknown) => {
      const host = new URL(getRequest().url).hostname.match(/^[^.]+\.([^.]+)\.workers\.dev$/);
      if (host) return { subdomain: host[1] };
      denied.push(error instanceof Error ? error.message : String(error));
      return undefined;
    },
  );
  const [configs, bucket] = await Promise.all([
    Promise.all(SCRIPTS.map((script) => workerConfig(token, script, account?.subdomain, denied))),
    tryCall(
      cloudflare<{
        name: string;
        location: string;
        jurisdiction: string;
        storage_class: string;
        creation_date: string;
      }>(token, `/r2/buckets/${DATA_BUCKET.name}`, {
        "cf-r2-jurisdiction": DATA_BUCKET.jurisdiction,
      }),
    ),
  ]);
  return {
    available: true,
    workers: Object.fromEntries(SCRIPTS.map((script, i) => [script, configs[i]])) as Record<
      Script,
      WorkerConfig
    >,
    bucket: bucket && {
      name: bucket.name,
      location: LOCATIONS[bucket.location] ?? bucket.location,
      jurisdiction: bucket.jurisdiction.toUpperCase(),
      storageClass: bucket.storage_class,
      created: bucket.creation_date,
    },
    denied,
  };
});

export const getAgentConfig = createServerFn().handler(async (): Promise<AgentConfigResult> => {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) return { available: false, reason: "Set the ELEVENLABS_API_KEY secret." };
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(`https://api.elevenlabs.io${path}`, {
      headers: { "xi-api-key": key },
    });
    if (!response.ok) throw new Error(`ElevenLabs ${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
  };
  try {
    const agent = await get<{
      name: string;
      conversation_config: {
        agent: {
          language: string;
          prompt: { llm: string; temperature: number; built_in_tools: Record<string, unknown> };
        };
        language_presets?: Record<string, unknown>;
        tts: { model_id: string; voice_id: string };
        asr: { provider: string; quality: string };
        conversation: { max_duration_seconds: number };
        turn?: { soft_timeout_config?: { timeout_seconds?: number } };
      };
      platform_settings: { call_limits: { agent_concurrency_limit: number; daily_limit: number } };
    }>(`/v1/convai/agents/${ELEVENLABS_AGENT_ID}`);
    const c = agent.conversation_config;
    const [voice, tool] = await Promise.all([
      get<{ name: string }>(`/v1/voices/${c.tts.voice_id}`),
      get<{
        tool_config: {
          name: string;
          response_timeout_secs: number;
          api_schema: { url: string; method: string; request_headers: Record<string, unknown> };
        };
      }>(`/v1/convai/tools/${ELEVENLABS_TOOL_ID}`),
    ]);
    const builtIns = Object.entries(c.agent.prompt.built_in_tools)
      .filter(([, value]) => value)
      .map(([name]) => name);
    return {
      available: true,
      name: agent.name,
      llm: c.agent.prompt.llm,
      temperature: c.agent.prompt.temperature,
      voice: voice.name,
      ttsModel: c.tts.model_id,
      asr: `${c.asr.provider} (${c.asr.quality} quality)`,
      languages: [c.agent.language, ...Object.keys(c.language_presets ?? {})],
      tools: [tool.tool_config.name, ...builtIns],
      maxCallSeconds: c.conversation.max_duration_seconds,
      concurrency: agent.platform_settings.call_limits.agent_concurrency_limit,
      dailyLimit: agent.platform_settings.call_limits.daily_limit,
      fillerAfterSeconds: c.turn?.soft_timeout_config?.timeout_seconds,
      tool: {
        name: tool.tool_config.name,
        method: tool.tool_config.api_schema.method,
        url: tool.tool_config.api_schema.url,
        timeoutSeconds: tool.tool_config.response_timeout_secs,
        headers: Object.keys(tool.tool_config.api_schema.request_headers),
      },
    };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
});
