import type { ServiceName } from "@doctor-directory/shared/telemetry-events";
import type { SpanView } from "./telemetry-store";

/**
 * Longer than any run can take (cron invocations stop at 15 minutes). A span open for longer lost
 * its end event, e.g. because the Worker was evicted, and is no longer shown as running.
 */
export const MAX_RUNNING_MS = 16 * 60_000;

export type TraceStatus = "running" | "ok" | "error" | "escalated" | "unfinished";

/** A lookup that answered "unavailable": the caller got no answer and it was logged for follow-up. */
export interface Escalation {
  readonly reason: string;
  readonly at: number;
}

export interface TraceView {
  readonly traceId: string;
  /** Depth-first, parents before children, siblings by start time. */
  readonly spans: ReadonlyArray<{ readonly span: SpanView; readonly depth: number }>;
  readonly root: SpanView;
  readonly start: number;
  /** Undefined while any span is still open. */
  readonly end: number | undefined;
  readonly services: ReadonlyArray<ServiceName>;
  readonly hasError: boolean;
  readonly escalation: Escalation | undefined;
  readonly conversationId: string | undefined;
}

export function buildTraces(spans: ReadonlyMap<string, SpanView>): TraceView[] {
  const byTrace = new Map<string, SpanView[]>();
  for (const span of spans.values()) {
    const group = byTrace.get(span.traceId);
    if (group) group.push(span);
    else byTrace.set(span.traceId, [span]);
  }
  const traces: TraceView[] = [];
  for (const [traceId, members] of byTrace) {
    const ids = new Set(members.map((span) => span.spanId));
    const children = new Map<string | null, SpanView[]>();
    for (const span of members) {
      // A parent that is not here (not received, or trimmed) makes the span a root.
      const parent = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : null;
      const siblings = children.get(parent);
      if (siblings) siblings.push(span);
      else children.set(parent, [span]);
    }
    const ordered: { span: SpanView; depth: number }[] = [];
    const visit = (parent: string | null, depth: number) => {
      const level = (children.get(parent) ?? []).sort((a, b) => a.start - b.start);
      for (const span of level) {
        ordered.push({ span, depth });
        visit(span.spanId, depth + 1);
      }
    };
    visit(null, 0);
    const open = members.some((span) => span.end === undefined);
    traces.push({
      traceId,
      spans: ordered,
      root: ordered[0].span,
      start: Math.min(...members.map((span) => span.start)),
      end: open ? undefined : Math.max(...members.map((span) => span.end ?? span.start)),
      services: [...new Set(members.map((span) => span.service))],
      hasError: members.some((span) => span.outcome === "error"),
      escalation: escalationOf(members),
      conversationId: members
        .map((span) => span.attributes["elevenlabs.conversation_id"])
        .find((value): value is string => typeof value === "string"),
    });
  }
  return traces.sort((a, b) => b.start - a.start);
}

function escalationOf(spans: ReadonlyArray<SpanView>): Escalation | undefined {
  const find = spans.find((span) => span.attributes["doctor.escalated"] === true);
  if (!find) return undefined;
  const reason = find.attributes["doctor.result.reason"];
  return { reason: typeof reason === "string" ? reason : "unknown", at: find.start };
}

/** What an escalation reason means for whoever follows up. */
export function describeEscalation(reason: string): string {
  switch (reason) {
    case "data_unavailable":
      return "The directory data was unavailable (the console's Simulate outage switch, or the data store).";
    case "directory_loading":
      return "doctor-lookup had no Search DB loaded yet.";
    default:
      return `Reason: ${reason}.`;
  }
}

export function traceStatus(trace: TraceView, now: number): TraceStatus {
  if (trace.end === undefined) return now - trace.start < MAX_RUNNING_MS ? "running" : "unfinished";
  if (trace.escalation) return "escalated";
  return trace.hasError ? "error" : "ok";
}

export function isRunning(span: SpanView, now: number): boolean {
  return span.end === undefined && now - span.start < MAX_RUNNING_MS;
}

/** The console's own /health polling: noise unless asked for. */
export function isHealthCheck(trace: TraceView): boolean {
  return trace.root.attributes["http.route"] === "/health";
}

const TOOL_ROUTE = "/tools/find-doctor";

function isToolCall(trace: TraceView): boolean {
  return (
    trace.root.service === "doctor-lookup" && trace.root.attributes["http.route"] === TOOL_ROUTE
  );
}

/**
 * The backend trace behind one find_doctor call in the transcript. The tool sends the conversation
 * id, so calls from this conversation are matched first; the nearest start time picks the call
 * (browser and Cloudflare clocks differ by a little, calls in a conversation by seconds).
 */
export function traceForToolCall(
  traces: ReadonlyArray<TraceView>,
  conversationId: string | undefined,
  requestedAt: number,
): TraceView | undefined {
  const calls = traces.filter(isToolCall);
  const sameConversation = calls.filter(
    (trace) => conversationId !== undefined && trace.conversationId === conversationId,
  );
  const pool =
    sameConversation.length > 0
      ? sameConversation
      : calls.filter((trace) => Math.abs(trace.start - requestedAt) < 5000);
  let best: TraceView | undefined;
  for (const trace of pool) {
    if (!best || Math.abs(trace.start - requestedAt) < Math.abs(best.start - requestedAt)) {
      best = trace;
    }
  }
  return best;
}

/** A one-line description of what a trace did. */
export function describeTrace(trace: TraceView): string {
  const find = trace.spans.find(({ span }) => span.name === "DoctorDirectory.find")?.span;
  if (find) {
    const query = [
      find.attributes["doctor.query.name"],
      find.attributes["doctor.query.city"],
      find.attributes["doctor.query.specialty"],
      find.attributes["doctor.query.day"],
      find.attributes["doctor.query.time"],
      find.attributes["doctor.query.language"],
    ].filter((part) => typeof part === "string" && part !== "");
    const status = find.attributes["doctor.result.status"];
    return `find_doctor(${query.join(", ")})${typeof status === "string" ? ` → ${status}` : ""}`;
  }
  const run = trace.spans.find(({ span }) => span.name === "DirectorySync.run")?.span;
  if (run) {
    const trigger = run.attributes["sync.trigger"];
    return `Sync${typeof trigger === "string" ? ` (${trigger})` : ""}: pull, validate, publish`;
  }
  const { attributes, name } = trace.root;
  const target = attributes["http.route"] ?? attributes["url.path"];
  const status = attributes["http.response.status_code"];
  if (target === undefined) return name;
  return `${name.replace("http.server ", "")} ${target}${status === undefined ? "" : ` → ${status}`}`;
}

export type Link =
  | "agent-lookup"
  | "lookup-store"
  | "trigger-sync"
  | "sync-upstream"
  | "sync-store";

/** Which edge of the service map a span travels over, if any. */
export function linkOf(span: SpanView): Link | undefined {
  switch (span.service) {
    case "doctor-lookup":
      if (span.name === "http.server POST") return "agent-lookup";
      if (span.name.startsWith("SearchIndexStore.")) return "lookup-store";
      return undefined;
    case "directory-sync":
      if (span.name === "Upstream.fetchDump" || span.name.startsWith("http.client")) {
        return "sync-upstream";
      }
      if (span.name.startsWith("DoctorDb.") || span.name.startsWith("SearchIndexStore.")) {
        return "sync-store";
      }
      return undefined;
    case "directory-api":
      return "sync-upstream";
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")} min`;
}

export function formatAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour12: false });
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
