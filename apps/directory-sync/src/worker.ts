import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { constantTimeEqual } from "@doctor-directory/shared/auth";
import { type Bucket, DataBucket } from "@doctor-directory/shared/bucket";
import { buildSearchIndex, SearchIndexStore } from "@doctor-directory/shared/search-index";
import { Telemetry, type TelemetrySink } from "@doctor-directory/shared/telemetry";
import { type WorkerContext, workerRuntime } from "@doctor-directory/shared/worker";
import { Cause, Clock, Effect, Exit, Layer, Option, Tracer } from "effect";
import { DoctorDb, DumpRejected, Ingest, IngestLive } from "./ingest";
import { Upstream } from "./upstream";

// directory-sync keeps the data fresh. A run is a Cloudflare Workflow, because the upstream takes
// about 15 minutes to answer and a cron invocation may not run longer than that. The cron (or
// POST /sync) only starts a run; the Workflow pulls, validates and publishes in separate steps,
// each retried on its own, with no limit on how long the pull may wait.

type Trigger = "cron" | "manual";

interface SyncParams {
  readonly trigger: Trigger;
}

interface Published {
  readonly asOf: string;
  readonly doctors: number;
  readonly syncTraceId: string;
}

type InstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "unknown";

interface WorkflowInstance {
  readonly id: string;
  status(): Promise<{ status: InstanceStatus; error?: { message: string }; output?: unknown }>;
}

interface WorkflowBinding {
  create(options?: { params?: SyncParams }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}

interface Env {
  readonly DATA: Bucket;
  readonly SYNC_TOKEN?: string;
  readonly TELEMETRY?: TelemetrySink;
  readonly SYNC_WORKFLOW: WorkflowBinding;
}

const telemetry = new Telemetry("directory-sync");

const publishIndex = Effect.gen(function* () {
  const db = yield* DoctorDb;
  const store = yield* SearchIndexStore;
  const snapshot = yield* db.load;
  if (Option.isNone(snapshot)) {
    return yield* new DumpRejected({ reason: "no validated DB to publish" });
  }
  const { traceId } = yield* Effect.orDie(Effect.currentSpan);
  const builtAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  yield* store.publish(buildSearchIndex(snapshot.value, traceId, builtAt));
  const published: Published = {
    asOf: snapshot.value.fetchedAt,
    doctors: snapshot.value.doctors.length,
    syncTraceId: traceId,
  };
  yield* Effect.logInfo("search index published", published);
  return published;
}).pipe(Effect.withSpan("DirectorySync.publishIndex"));

interface RootSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly at: number;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Runs one step's program inside the run's trace and sends its telemetry before the step
 * returns: the Workflow may sleep or move to another machine between steps. A refused dump fails
 * the step for good; anything else is thrown for the step's retries.
 */
async function runStep<A, E extends { _tag: string; message: string }>(
  env: Env,
  root: RootSpan,
  program: Effect.Effect<A, E, Ingest | DoctorDb | SearchIndexStore>,
): Promise<A> {
  telemetry.connect(env.TELEMETRY);
  try {
    const exit = await Effect.runPromiseExit(
      program.pipe(
        Effect.tapError((error) => Effect.logError("sync step failed", error)),
        Effect.withParentSpan(Tracer.externalSpan({ traceId: root.traceId, spanId: root.spanId })),
        Effect.provide(
          Layer.mergeAll(IngestLive, SearchIndexStore.layer).pipe(
            Layer.provide(Upstream.layer),
            Layer.provide(Layer.succeed(DataBucket, env.DATA)),
            Layer.provideMerge(workerRuntime(env, telemetry)),
          ),
        ),
      ),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.findErrorOption(exit.cause);
    if (Option.isSome(error) && error.value instanceof DumpRejected) {
      throw new NonRetryableError(error.value.message, "DumpRejected");
    }
    throw Option.isSome(error)
      ? new Error(`${error.value._tag}: ${error.value.message}`)
      : new Error(Cause.pretty(exit.cause));
  } finally {
    await telemetry.drain();
  }
}

/** The root span of a run, opened and closed by hand: its steps may run in different invocations. */
function recordRoot(
  env: Env,
  root: RootSpan,
  trigger: Trigger,
  instanceId: string,
  end?: { outcome: "ok" | "error"; error?: string; attributes?: Record<string, number | string> },
) {
  telemetry.connect(env.TELEMETRY);
  const identity = {
    service: "directory-sync" as const,
    traceId: root.traceId,
    spanId: root.spanId,
    parentSpanId: null,
    name: "DirectorySync.run",
    at: root.at,
  };
  const attributes = { "sync.trigger": trigger, "workflow.instance_id": instanceId };
  telemetry.record(
    end
      ? {
          kind: "span-end",
          ...identity,
          durationMs: Date.now() - root.at,
          outcome: end.outcome,
          ...(end.error ? { error: end.error } : {}),
          attributes: { ...attributes, ...end.attributes },
        }
      : { kind: "span-start", ...identity, attributes },
  );
  return telemetry.drain();
}

export class SyncWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep): Promise<Published> {
    const { trigger } = event.payload;
    // Inside a step, so a replayed run reuses the same trace instead of opening another.
    const root = await step.do("start", async (): Promise<RootSpan> => {
      const opened = { traceId: randomHex(16), spanId: randomHex(8), at: Date.now() };
      await recordRoot(this.env, opened, trigger, event.instanceId);
      return opened;
    });
    try {
      const pulled = await step.do(
        "pull dump",
        // Waiting on the network costs no CPU time, so the 15-minute upstream fits one step.
        { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "45 minutes" },
        () =>
          runStep(
            this.env,
            root,
            Ingest.use((ingest) => ingest.pull),
          ),
      );
      const applied = await step.do(
        "validate and save DB",
        { retries: { limit: 2, delay: "10 seconds" } },
        () =>
          runStep(
            this.env,
            root,
            Ingest.use((ingest) => ingest.apply(pulled.fetchedAt)),
          ),
      );
      const published = await step.do(
        "publish Search DB",
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
        () => runStep(this.env, root, publishIndex),
      );
      await step.do("finish", () =>
        recordRoot(this.env, root, trigger, event.instanceId, {
          outcome: "ok",
          attributes: {
            "dump.bytes": pulled.bytes,
            "dump.valid": applied.doctors,
            "dump.rejected": applied.rejected,
          },
        }),
      );
      return published;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("record failure", () =>
        recordRoot(this.env, root, trigger, event.instanceId, { outcome: "error", error: message }),
      );
      throw error;
    }
  }
}

function authorized(request: Request, env: Env): boolean {
  const token = env.SYNC_TOKEN ?? "";
  return (
    token !== "" && constantTimeEqual(request.headers.get("authorization") ?? "", `Bearer ${token}`)
  );
}

export default {
  // Starts a run and returns; the Workflow does the work, so the 15-minute cron limit no longer
  // applies to the pull.
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await env.SYNC_WORKFLOW.create({ params: { trigger: "cron" } });
  },

  // POST /sync starts a run; GET /sync/<id> reports it. Disabled unless SYNC_TOKEN is set.
  async fetch(request: Request, env: Env, _ctx: WorkerContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/sync") || !env.SYNC_TOKEN) {
      return new Response("Not found", { status: 404 });
    }
    if (!authorized(request, env)) {
      return Response.json({ status: "unauthorized" }, { status: 401 });
    }
    if (request.method === "POST" && pathname === "/sync") {
      const instance = await env.SYNC_WORKFLOW.create({ params: { trigger: "manual" } });
      return Response.json({ status: "started", id: instance.id }, { status: 202 });
    }
    const id = pathname.match(/^\/sync\/([\w-]+)$/)?.[1];
    if (request.method === "GET" && id) {
      const { status, error, output } = await (await env.SYNC_WORKFLOW.get(id)).status();
      return Response.json({ id, status, error: error?.message, output });
    }
    return new Response("Not found", { status: 404 });
  },
};
