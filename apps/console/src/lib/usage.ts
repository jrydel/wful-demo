import { env } from "cloudflare:workers";
import { CLOUDFLARE_ACCOUNT_ID, ELEVENLABS_AGENT_ID } from "@doctor-directory/shared/deployment";
import { createServerFn } from "@tanstack/react-start";

export const SCRIPTS = ["doctor-lookup", "directory-sync", "directory-api"] as const;
export type Script = (typeof SCRIPTS)[number];
/** Every Worker this project deploys, including the ones not drawn on the map. */
const PROJECT_SCRIPTS: ReadonlyArray<string> = [...SCRIPTS, "telemetry", "doctor-console"];
const PROJECT_BUCKETS: ReadonlyArray<string> = [
  "eu_doctor-directory-data",
  "doctor-directory-demo",
];

/** Cloudflare list prices (developers.cloudflare.com, checked 2026-09). */
export const PRICES = {
  workersPlanMonthly: 5,
  workersIncludedRequests: 10_000_000,
  workersIncludedCpuMs: 30_000_000,
  workersPerMillionRequests: 0.3,
  workersPerMillionCpuMs: 0.02,
  r2PerGbMonth: 0.015,
  r2PerMillionClassA: 4.5,
  r2PerMillionClassB: 0.36,
  r2IncludedGb: 10,
  r2IncludedClassA: 1_000_000,
  r2IncludedClassB: 10_000_000,
} as const;

export interface WorkerUsage {
  readonly requests: number;
  readonly errors: number;
  readonly subrequests: number;
  readonly cpuMs: number;
}

export interface BucketUsage {
  readonly classA: number;
  readonly classB: number;
  readonly objects: number;
  readonly bytes: number;
}

export type CloudflareUsage =
  | {
      readonly available: true;
      readonly since: string;
      readonly workers: Record<Script, WorkerUsage>;
      /** Every Worker on the account: the plan's included quota is shared. */
      readonly account: WorkerUsage;
      /** This project's five Workers together. */
      readonly project: WorkerUsage;
      readonly buckets: Record<string, BucketUsage>;
    }
  | { readonly available: false; readonly reason: string };

export interface CallCost {
  readonly conversationId: string;
  readonly startedAt: number;
  readonly seconds: number;
  readonly credits: number;
  readonly usd: number;
  readonly llmUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly models: ReadonlyArray<string>;
  readonly ttsCharacters: number;
  readonly ttsSeconds: number;
  readonly asrSeconds: number;
  readonly language: string;
}

export interface CallTotals {
  readonly calls: number;
  readonly seconds: number;
  readonly credits: number;
  readonly usd: number;
  readonly llmUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type AgentUsage =
  | {
      readonly available: true;
      readonly since: string;
      readonly today: CallTotals;
      readonly month: CallTotals;
      readonly last: CallCost | undefined;
      /** Calls still running or being processed; their cost is not known yet. */
      readonly pending: number;
    }
  | { readonly available: false; readonly reason: string };

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// R2 bills writes and listings as Class A, reads as Class B; deletes are free.
function r2Class(action: string): "A" | "B" | undefined {
  if (/^(Put|Copy|List|CreateMultipart|CompleteMultipart|UploadPart)/.test(action)) return "A";
  if (/^(Get|Head)/.test(action)) return "B";
  return undefined;
}

interface GraphqlWorkerRow {
  dimensions: { scriptName: string };
  sum: { requests: number; errors: number; subrequests: number; cpuTimeUs: number };
}

export const getCloudflareUsage = createServerFn().handler(async (): Promise<CloudflareUsage> => {
  const token = env.CF_ANALYTICS_TOKEN;
  if (!token) {
    return {
      available: false,
      reason: "Set the CF_ANALYTICS_TOKEN secret (Account Analytics: Read) to see usage and cost.",
    };
  }
  const now = new Date();
  const since = monthStart(now).toISOString();
  const today = new Date(now.getTime() - 86_400_000).toISOString();
  const query = `{ viewer { accounts(filter: {accountTag: "${CLOUDFLARE_ACCOUNT_ID}"}) {
    workers: workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: "${since}"}) {
      sum { requests errors subrequests cpuTimeUs } dimensions { scriptName } }
    r2ops: r2OperationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: "${since}"}) {
      sum { requests } dimensions { actionType bucketName } }
    r2storage: r2StorageAdaptiveGroups(limit: 100, filter: {datetime_geq: "${today}"}) {
      max { objectCount payloadSize } dimensions { bucketName } }
  } } }`;
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = (await response.json()) as {
    data?: {
      viewer: {
        accounts: {
          workers: GraphqlWorkerRow[];
          r2ops: {
            sum: { requests: number };
            dimensions: { actionType: string; bucketName: string };
          }[];
          r2storage: {
            max: { objectCount: number; payloadSize: number };
            dimensions: { bucketName: string };
          }[];
        }[];
      };
    };
    errors?: { message: string }[] | null;
  };
  const account = body.data?.viewer.accounts[0];
  if (!response.ok || !account) {
    return {
      available: false,
      reason: `Cloudflare analytics: ${body.errors?.[0]?.message ?? `HTTP ${response.status}`}`,
    };
  }
  const empty = (): WorkerUsage => ({ requests: 0, errors: 0, subrequests: 0, cpuMs: 0 });
  const add = (a: WorkerUsage, row: GraphqlWorkerRow): WorkerUsage => ({
    requests: a.requests + row.sum.requests,
    errors: a.errors + row.sum.errors,
    subrequests: a.subrequests + row.sum.subrequests,
    cpuMs: a.cpuMs + row.sum.cpuTimeUs / 1000,
  });
  const workers = Object.fromEntries(SCRIPTS.map((script) => [script, empty()])) as Record<
    Script,
    WorkerUsage
  >;
  let total = empty();
  let project = empty();
  for (const row of account.workers) {
    total = add(total, row);
    if (PROJECT_SCRIPTS.includes(row.dimensions.scriptName)) project = add(project, row);
    const script = row.dimensions.scriptName as Script;
    if (SCRIPTS.includes(script)) workers[script] = add(workers[script], row);
  }
  const buckets: Record<string, BucketUsage> = {};
  const bucket = (name: string) => {
    buckets[name] ??= { classA: 0, classB: 0, objects: 0, bytes: 0 };
    return buckets[name];
  };
  for (const row of account.r2ops) {
    const kind = r2Class(row.dimensions.actionType);
    const entry = bucket(row.dimensions.bucketName);
    if (kind === "A")
      buckets[row.dimensions.bucketName] = { ...entry, classA: entry.classA + row.sum.requests };
    if (kind === "B")
      buckets[row.dimensions.bucketName] = { ...entry, classB: entry.classB + row.sum.requests };
  }
  for (const row of account.r2storage) {
    const entry = bucket(row.dimensions.bucketName);
    buckets[row.dimensions.bucketName] = {
      ...entry,
      objects: Math.max(entry.objects, row.max.objectCount),
      bytes: Math.max(entry.bytes, row.max.payloadSize),
    };
  }
  return { available: true, since, workers, account: total, project, buckets };
});

interface Conversation {
  conversation_id: string;
  start_time_unix_secs: number;
  status: string;
}

interface ModelUsage {
  input?: { tokens: number; price: number };
  input_cache_read?: { tokens: number; price: number };
  input_cache_write?: { tokens: number; price: number };
  output_total?: { tokens: number; price: number };
}

// Finished conversations never change, so each isolate fetches their details once.
const finished = new Map<string, CallCost>();

async function callCost(key: string, conversation: Conversation): Promise<CallCost | undefined> {
  const cached = finished.get(conversation.conversation_id);
  if (cached) return cached;
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversations/${conversation.conversation_id}`,
    { headers: { "xi-api-key": key } },
  );
  if (!response.ok) return undefined;
  const details = (await response.json()) as {
    status: string;
    metadata: {
      call_duration_secs: number;
      cost?: number;
      cost_fiat?: number;
      main_language?: string;
      charging?: {
        llm_price?: number;
        llm_usage?: { irreversible_generation?: { model_usage?: Record<string, ModelUsage> } };
        tts_usage?: { total_characters?: number; total_audio_output_seconds?: number };
        asr_usage?: { total_audio_input_seconds?: number };
      };
    };
  };
  if (details.status !== "done") return undefined;
  const { metadata } = details;
  const models = metadata.charging?.llm_usage?.irreversible_generation?.model_usage ?? {};
  let inputTokens = 0;
  let outputTokens = 0;
  for (const usage of Object.values(models)) {
    inputTokens +=
      (usage.input?.tokens ?? 0) +
      (usage.input_cache_read?.tokens ?? 0) +
      (usage.input_cache_write?.tokens ?? 0);
    outputTokens += usage.output_total?.tokens ?? 0;
  }
  const cost: CallCost = {
    conversationId: conversation.conversation_id,
    startedAt: conversation.start_time_unix_secs * 1000,
    seconds: metadata.call_duration_secs,
    credits: metadata.cost ?? 0,
    usd: metadata.cost_fiat ?? 0,
    llmUsd: metadata.charging?.llm_price ?? 0,
    inputTokens,
    outputTokens,
    models: Object.keys(models),
    ttsCharacters: metadata.charging?.tts_usage?.total_characters ?? 0,
    ttsSeconds: metadata.charging?.tts_usage?.total_audio_output_seconds ?? 0,
    asrSeconds: metadata.charging?.asr_usage?.total_audio_input_seconds ?? 0,
    language: metadata.main_language ?? "",
  };
  finished.set(conversation.conversation_id, cost);
  return cost;
}

function totals(calls: ReadonlyArray<CallCost>): CallTotals {
  return calls.reduce<CallTotals>(
    (sum, call) => ({
      calls: sum.calls + 1,
      seconds: sum.seconds + call.seconds,
      credits: sum.credits + call.credits,
      usd: sum.usd + call.usd,
      llmUsd: sum.llmUsd + call.llmUsd,
      inputTokens: sum.inputTokens + call.inputTokens,
      outputTokens: sum.outputTokens + call.outputTokens,
    }),
    { calls: 0, seconds: 0, credits: 0, usd: 0, llmUsd: 0, inputTokens: 0, outputTokens: 0 },
  );
}

export const getAgentUsage = createServerFn().handler(async (): Promise<AgentUsage> => {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) {
    return { available: false, reason: "Set the ELEVENLABS_API_KEY secret to see call costs." };
  }
  const now = new Date();
  const since = monthStart(now);
  const conversations: Conversation[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL("https://api.elevenlabs.io/v1/convai/conversations");
    url.searchParams.set("agent_id", ELEVENLABS_AGENT_ID);
    url.searchParams.set("page_size", "100");
    url.searchParams.set("call_start_after_unix", String(Math.floor(since.getTime() / 1000)));
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { headers: { "xi-api-key": key } });
    if (!response.ok) {
      return { available: false, reason: `ElevenLabs API: HTTP ${response.status}` };
    }
    const page = (await response.json()) as {
      conversations: Conversation[];
      next_cursor: string | null;
      has_more: boolean;
    };
    conversations.push(...page.conversations);
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor && conversations.length < 1000);

  const done = conversations.filter((c) => c.status === "done");
  const costs = (await Promise.all(done.map((c) => callCost(key, c)))).filter(
    (cost): cost is CallCost => cost !== undefined,
  );
  const dayAgo = now.getTime() - 86_400_000;
  const newestFirst = costs.sort((a, b) => b.startedAt - a.startedAt);
  return {
    available: true,
    since: since.toISOString(),
    today: totals(newestFirst.filter((cost) => cost.startedAt >= dayAgo)),
    month: totals(newestFirst),
    last: newestFirst[0],
    pending: conversations.length - costs.length,
  };
});

/** What Workers usage would cost at the per-unit list price, before the plan's included amounts. */
export function workersListValue(usage: WorkerUsage): number {
  return (
    (usage.requests / 1e6) * PRICES.workersPerMillionRequests +
    (usage.cpuMs / 1e6) * PRICES.workersPerMillionCpuMs
  );
}

/** Storage for a month plus operations, at list price, before the free tier. */
export function bucketListValue(bucket: BucketUsage): number {
  return (
    (bucket.bytes / 1e9) * PRICES.r2PerGbMonth +
    (bucket.classA / 1e6) * PRICES.r2PerMillionClassA +
    (bucket.classB / 1e6) * PRICES.r2PerMillionClassB
  );
}

/** This project's own Cloudflare usage (five Workers, two buckets) at list price. */
export function projectCloudflareValue(
  usage: Extract<CloudflareUsage, { available: true }>,
): number {
  const buckets = PROJECT_BUCKETS.map((name) => usage.buckets[name]).filter(
    (bucket): bucket is BucketUsage => bucket !== undefined,
  );
  return workersListValue(usage.project) + buckets.reduce((sum, b) => sum + bucketListValue(b), 0);
}
