import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { AGENT_ID } from "./services";

// Call history is ElevenLabs' own record: the agent keeps every conversation (retention -1),
// so the console reads it instead of storing a copy.

export interface CallSummary {
  readonly id: string;
  readonly startedAt: number;
  readonly seconds: number;
  /** ElevenLabs processing state: "in-progress", "processing", "done", "failed". */
  readonly status: string;
  readonly successful: string;
  readonly title: string;
  readonly language: string;
  readonly tools: ReadonlyArray<string>;
}

export interface ToolUse {
  /** ElevenLabs' id for this tool request. */
  readonly id: string;
  readonly name: string;
  readonly params: string;
  readonly result: string | undefined;
  readonly isError: boolean;
  readonly latencyMs: number | undefined;
}

export interface Turn {
  /** Position in the conversation, stable for a finished call. */
  readonly id: string;
  readonly role: "agent" | "user";
  readonly text: string;
  /** Seconds into the call. */
  readonly at: number;
  readonly tools: ReadonlyArray<ToolUse>;
}

export interface CallDetail extends CallSummary {
  readonly summary: string;
  readonly endedBy: string;
  readonly usd: number;
  readonly credits: number;
  readonly llmUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: ReadonlyArray<Turn>;
}

export type CallList =
  | { readonly available: true; readonly calls: ReadonlyArray<CallSummary> }
  | { readonly available: false; readonly reason: string };

interface ListedConversation {
  conversation_id: string;
  start_time_unix_secs: number;
  call_duration_secs: number;
  status: string;
  call_successful?: string;
  call_summary_title?: string | null;
  main_language?: string | null;
  tool_names?: string[];
}

async function elevenlabs<T>(path: string): Promise<T> {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("Set the ELEVENLABS_API_KEY secret to see call history.");
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    headers: { "xi-api-key": key },
  });
  if (!response.ok) throw new Error(`ElevenLabs API: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function summarize(c: ListedConversation): CallSummary {
  return {
    id: c.conversation_id,
    startedAt: c.start_time_unix_secs * 1000,
    seconds: c.call_duration_secs,
    status: c.status,
    successful: c.call_successful ?? "unknown",
    title: c.call_summary_title || "Untitled call",
    language: c.main_language ?? "",
    tools: (c.tool_names ?? []).filter((name) => name !== "end_call"),
  };
}

/** The latest calls, newest first. */
export const listCalls = createServerFn().handler(async (): Promise<CallList> => {
  try {
    const page = await elevenlabs<{ conversations: ListedConversation[] }>(
      `/v1/convai/conversations?agent_id=${AGENT_ID}&page_size=50`,
    );
    return { available: true, calls: page.conversations.map(summarize) };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
});

interface ModelUsage {
  input?: { tokens: number };
  input_cache_read?: { tokens: number };
  input_cache_write?: { tokens: number };
  output_total?: { tokens: number };
}

export const getCall = createServerFn()
  .inputValidator((id: unknown) => {
    if (typeof id !== "string" || !/^conv_\w+$/.test(id))
      throw new Error("Expected a conversation id");
    return id;
  })
  .handler(async ({ data: id }): Promise<CallDetail> => {
    const c = await elevenlabs<
      ListedConversation & {
        // The single-call endpoint keeps these under analysis and metadata, not at the top.
        analysis?: {
          transcript_summary?: string | null;
          call_successful?: string;
          call_summary_title?: string | null;
        };
        metadata: {
          start_time_unix_secs: number;
          call_duration_secs: number;
          termination_reason?: string;
          cost?: number;
          cost_fiat?: number;
          main_language?: string;
          charging?: {
            llm_price?: number;
            llm_usage?: { irreversible_generation?: { model_usage?: Record<string, ModelUsage> } };
          };
        };
        transcript: {
          role: "agent" | "user";
          message: string | null;
          time_in_call_secs: number;
          tool_calls?: { request_id: string; tool_name: string; params_as_json: string }[];
          tool_results?: {
            request_id: string;
            result_value: string;
            is_error: boolean;
            tool_latency_secs?: number;
          }[];
        }[];
      }
    >(`/v1/convai/conversations/${id}`);
    const results = new Map(
      c.transcript.flatMap((turn) => turn.tool_results ?? []).map((r) => [r.request_id, r]),
    );
    let inputTokens = 0;
    let outputTokens = 0;
    for (const usage of Object.values(
      c.metadata.charging?.llm_usage?.irreversible_generation?.model_usage ?? {},
    )) {
      inputTokens +=
        (usage.input?.tokens ?? 0) +
        (usage.input_cache_read?.tokens ?? 0) +
        (usage.input_cache_write?.tokens ?? 0);
      outputTokens += usage.output_total?.tokens ?? 0;
    }
    const turns: Turn[] = [];
    for (const turn of c.transcript) {
      const tools = (turn.tool_calls ?? []).map((call): ToolUse => {
        const result = results.get(call.request_id);
        return {
          id: call.request_id,
          name: call.tool_name,
          params: call.params_as_json,
          result: result?.result_value,
          isError: result?.is_error ?? false,
          latencyMs:
            result?.tool_latency_secs === undefined
              ? undefined
              : Math.round(result.tool_latency_secs * 1000),
        };
      });
      const text = turn.message?.trim() ?? "";
      if (text === "" && tools.length === 0) continue;
      turns.push({
        id: `turn-${turns.length}`,
        role: turn.role,
        text,
        at: turn.time_in_call_secs,
        tools,
      });
    }
    return {
      ...summarize({
        ...c,
        start_time_unix_secs: c.metadata.start_time_unix_secs,
        call_duration_secs: c.metadata.call_duration_secs,
        call_successful: c.analysis?.call_successful ?? c.call_successful,
        call_summary_title: c.analysis?.call_summary_title ?? c.call_summary_title,
        main_language: c.metadata.main_language ?? c.main_language,
      }),
      summary: c.analysis?.transcript_summary ?? "",
      endedBy: c.metadata.termination_reason ?? "",
      usd: c.metadata.cost_fiat ?? 0,
      credits: c.metadata.cost ?? 0,
      llmUsd: c.metadata.charging?.llm_price ?? 0,
      inputTokens,
      outputTokens,
      turns,
    };
  });
