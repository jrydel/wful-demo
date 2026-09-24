/**
 * Events every Worker reports to the telemetry hub and the console streams. Plain types, so the
 * browser bundle can import them without pulling in Effect.
 */
export type ServiceName = "directory-api" | "directory-sync" | "doctor-lookup";

export type Attributes = Record<string, string | number | boolean>;

interface SpanIdentity {
  readonly service: ServiceName;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  /** Span start, epoch milliseconds. */
  readonly at: number;
}

export interface SpanStartEvent extends SpanIdentity {
  readonly kind: "span-start";
  /** Attributes known at the start, e.g. what triggered a sync; the end event has all of them. */
  readonly attributes?: Attributes;
}

export interface SpanEndEvent extends SpanIdentity {
  readonly kind: "span-end";
  readonly durationMs: number;
  readonly outcome: "ok" | "error" | "interrupted";
  readonly error?: string;
  readonly attributes: Attributes;
}

export interface LogEvent {
  readonly kind: "log";
  readonly service: ServiceName;
  /** Epoch milliseconds. */
  readonly at: number;
  readonly level: string;
  readonly message: string;
  readonly data?: string;
  readonly traceId: string | null;
  readonly spanId: string | null;
}

export type TelemetryEvent = SpanStartEvent | SpanEndEvent | LogEvent;

/** An event as stored by the hub, with its position in the stream. */
export type StoredEvent = TelemetryEvent & { readonly id: number };

/** Messages the hub sends to stream subscribers. */
export type StreamMessage =
  | { readonly type: "backlog"; readonly events: ReadonlyArray<StoredEvent> }
  | { readonly type: "events"; readonly events: ReadonlyArray<StoredEvent> };
