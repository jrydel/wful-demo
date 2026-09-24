import { Cause, Context, Exit, Layer, Logger, Option, References, Tracer } from "effect";
import type { Attributes, ServiceName, TelemetryEvent } from "./telemetry-events";

/** A service binding to the telemetry Worker. */
export interface TelemetrySink {
  fetch(request: Request): Promise<Response>;
}

const nanosToMillis = (nanos: bigint) => Number(nanos) / 1_000_000;

function describe(value: unknown): string {
  try {
    const json = JSON.stringify(value, (_, inner) =>
      inner instanceof Error
        ? { name: inner.name, message: inner.message }
        : typeof inner === "bigint"
          ? String(inner)
          : inner,
    );
    return (json ?? String(value)).slice(0, 2000);
  } catch {
    return String(value).slice(0, 2000);
  }
}

function toAttributes(entries: Iterable<[string, unknown]>): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of entries) {
    attributes[key] =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : describe(value);
  }
  return attributes;
}

/**
 * Reports every span start, span end and log line of one Worker to the telemetry hub while it
 * runs, so the console sees a 10-minute sync progress instead of only its result. Events are
 * batched per tick; telemetry failures are swallowed and never affect the service.
 */
export class Telemetry {
  private sink: TelemetrySink | undefined;
  private buffer: TelemetryEvent[] = [];
  private flushScheduled = false;
  private readonly inFlight = new Set<Promise<void>>();
  /** Tracer and loggers to provide to the Worker's Effect program. */
  readonly layer: Layer.Layer<never>;

  constructor(readonly service: ServiceName) {
    const telemetry = this;
    const identity = (span: Tracer.NativeSpan) => ({
      service,
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: Option.match(span.parent, { onNone: () => null, onSome: (p) => p.spanId }),
      name: span.name,
      at: nanosToMillis(span.startTime),
    });

    class ReportingSpan extends Tracer.NativeSpan {
      override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
        super.end(endTime, exit);
        const failed = Exit.isFailure(exit);
        const interrupted = failed && Cause.hasInterruptsOnly(exit.cause);
        telemetry.record({
          kind: "span-end",
          ...identity(this),
          durationMs: nanosToMillis(endTime - this.startTime),
          outcome: interrupted ? "interrupted" : failed ? "error" : "ok",
          ...(failed && !interrupted ? { error: describe(Cause.squash(exit.cause)) } : {}),
          attributes: toAttributes(this.attributes),
        });
      }
    }

    const tracer = Tracer.make({
      span: (options) => {
        const span = new ReportingSpan(options);
        telemetry.record({
          kind: "span-start",
          ...identity(span),
          // Effect applies withSpan attributes right after this returns; the getter reads them
          // when the batch is serialized, a tick later.
          get attributes() {
            return toAttributes(span.attributes);
          },
        });
        return span;
      },
    });

    const logger = Logger.make(({ message, logLevel, fiber, date, cause }) => {
      const [first, ...rest] = Array.isArray(message) ? message : [message];
      const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      const details = [...rest, ...(Object.keys(annotations).length > 0 ? [annotations] : [])];
      // Lines like the HTTP access log carry no message, only annotations and a cause.
      const text =
        first === undefined
          ? cause.reasons.length > 0
            ? Cause.pretty(cause).split("\n")[0]
            : "(no message)"
          : typeof first === "string"
            ? first
            : describe(first);
      telemetry.record({
        kind: "log",
        service,
        at: date.getTime(),
        level: logLevel,
        message: text,
        ...(details.length > 0
          ? { data: describe(details.length === 1 ? details[0] : details) }
          : {}),
        traceId: span?.traceId ?? null,
        spanId: span?.spanId ?? null,
      });
    });

    this.layer = Layer.mergeAll(
      Layer.succeed(Tracer.Tracer, tracer),
      Logger.layer([Logger.consoleJson, logger]),
    );
  }

  /** Points this Worker instance at the hub binding; without one, events are dropped. */
  connect(sink: TelemetrySink | undefined): void {
    this.sink = sink;
  }

  record(event: TelemetryEvent): void {
    if (!this.sink) return;
    this.buffer.push(event);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => void this.flush(), 0);
  }

  /**
   * Sends what is buffered and waits for batches in flight: pass to ctx.waitUntil. The request
   * span ends just after the response is handed back, so it waits a few ticks for late events.
   */
  async drain(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      await this.flush();
      await Promise.all(this.inFlight);
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, 20);
      await tick.promise;
    }
  }

  private flush(): Promise<void> {
    this.flushScheduled = false;
    const sink = this.sink;
    if (!sink || this.buffer.length === 0) return Promise.resolve();
    const batch = this.buffer;
    this.buffer = [];
    const sending = sink
      .fetch(
        new Request("https://telemetry/ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
        }),
      )
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
    this.inFlight.add(sending);
    void sending.finally(() => this.inFlight.delete(sending));
    return sending;
  }
}
