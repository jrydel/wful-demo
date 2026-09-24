import type {
  Attributes,
  LogEvent,
  ServiceName,
  StoredEvent,
  StreamMessage,
} from "@doctor-directory/shared/telemetry-events";
import { useSyncExternalStore } from "react";

export interface SpanView {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId: string | null;
  readonly service: ServiceName;
  readonly name: string;
  /** Epoch milliseconds. */
  readonly start: number;
  /** Set once the span has ended. */
  readonly end?: number;
  readonly outcome?: "ok" | "error" | "interrupted";
  readonly error?: string;
  readonly attributes: Attributes;
}

export type StoredLog = LogEvent & { readonly id: number };

export type StreamStatus = "connecting" | "live" | "reconnecting";

export interface TelemetrySnapshot {
  readonly status: StreamStatus;
  readonly spans: ReadonlyMap<string, SpanView>;
  readonly logs: ReadonlyArray<StoredLog>;
  /** Changes whenever anything above changes; derive with useMemo on it. */
  readonly version: number;
}

const MAX_SPANS = 8000;
const MAX_LOGS = 3000;

/** One WebSocket to the telemetry hub, shared by every component that reads the stream. */
class TelemetryStore {
  private spans = new Map<string, SpanView>();
  private logs: StoredLog[] = [];
  private status: StreamStatus = "connecting";
  private lastId = 0;
  private version = 0;
  private snapshot: TelemetrySnapshot = this.freeze();
  private readonly listeners = new Set<() => void>();
  private socket: WebSocket | undefined;
  private attempts = 0;
  private notifyScheduled = false;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.connect();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.disconnect();
    };
  };

  readonly getSnapshot = () => this.snapshot;

  private connect(): void {
    const url = new URL("/api/stream", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.setStatus("live");
    };
    socket.onmessage = (message) => this.apply(JSON.parse(message.data) as StreamMessage);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.setStatus("reconnecting");
      const delay = Math.min(1000 * 2 ** this.attempts, 15_000);
      this.attempts++;
      setTimeout(() => {
        if (this.socket === socket) this.connect();
      }, delay);
    };
  }

  private disconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private apply(message: StreamMessage): void {
    const logs: StoredLog[] = [];
    for (const event of message.events) {
      // Reconnects replay the backlog; skip what we already have.
      if (event.id <= this.lastId) continue;
      this.lastId = event.id;
      if (event.kind === "log") logs.push(event);
      else this.ingestSpan(event);
    }
    // Logs are replaced, not appended in place, so memoized views see a new array.
    if (logs.length > 0) this.logs = this.logs.concat(logs).slice(-MAX_LOGS);
    for (const spanId of this.spans.keys()) {
      // Maps iterate in insertion order, so the first keys are the oldest spans.
      if (this.spans.size <= MAX_SPANS) break;
      this.spans.delete(spanId);
    }
    this.scheduleNotify();
  }

  private ingestSpan(event: Exclude<StoredEvent, { kind: "log" }>): void {
    const known = this.spans.get(event.spanId);
    const base: SpanView = known ?? {
      spanId: event.spanId,
      traceId: event.traceId,
      parentSpanId: event.parentSpanId,
      service: event.service,
      name: event.name,
      start: event.at,
      attributes: event.kind === "span-start" ? (event.attributes ?? {}) : {},
    };
    this.spans.set(
      event.spanId,
      event.kind === "span-start"
        ? base
        : {
            ...base,
            end: event.at + event.durationMs,
            outcome: event.outcome,
            error: event.error,
            attributes: event.attributes,
          },
    );
  }

  private setStatus(status: StreamStatus): void {
    this.status = status;
    this.scheduleNotify();
  }

  // Bursts of events become one render per frame.
  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    requestAnimationFrame(() => {
      this.notifyScheduled = false;
      this.snapshot = this.freeze();
      for (const listener of this.listeners) listener();
    });
  }

  private freeze(): TelemetrySnapshot {
    this.version++;
    return { status: this.status, spans: this.spans, logs: this.logs, version: this.version };
  }
}

const store = new TelemetryStore();
const serverSnapshot: TelemetrySnapshot = {
  status: "connecting",
  spans: new Map(),
  logs: [],
  version: 0,
};

export function useTelemetry(): TelemetrySnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => serverSnapshot);
}
