import { constantTimeEqual } from "@doctor-directory/shared/auth";
import { type Bucket, DataBucket } from "@doctor-directory/shared/bucket";
import { SearchIndexStore } from "@doctor-directory/shared/search-index";
import { Telemetry, type TelemetrySink } from "@doctor-directory/shared/telemetry";
import { type WorkerContext, workerRuntime } from "@doctor-directory/shared/worker";
import { Config, Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Api, NotReady, ToolAuth, Unauthorized } from "./api";
import { DoctorDirectory } from "./directory";
import { OutageSwitch } from "./outage";

// doctor-lookup serves the customers: the voice agent's find_doctor tool, answered from the
// Search DB that directory-sync publishes to R2. It never calls the upstream API.

interface Env {
  readonly DATA: Bucket;
  readonly TELEMETRY?: TelemetrySink;
}

const ToolAuthLive = Layer.effect(
  ToolAuth,
  Effect.gen(function* () {
    const expected = yield* Config.NonEmptyString("TOOL_TOKEN");
    return ToolAuth.of({
      bearer: Effect.fn(function* (httpEffect, { credential }) {
        if (!constantTimeEqual(Redacted.value(credential), expected)) {
          return yield* new Unauthorized({ message: "Missing or invalid bearer token" });
        }
        return yield* httpEffect;
      }),
    });
  }),
);

const ToolsLive = HttpApiBuilder.group(
  Api,
  "tools",
  Effect.fn(function* (handlers) {
    const directory = yield* DoctorDirectory;
    return handlers.handle(
      "findDoctor",
      Effect.fn(function* ({ payload }) {
        // The ElevenLabs tool sends its conversation id, which ties this request to the call.
        const { headers } = yield* HttpServerRequest.HttpServerRequest;
        const conversationId = headers["x-conversation-id"];
        if (conversationId) {
          yield* Effect.annotateCurrentSpan("elevenlabs.conversation_id", conversationId);
        }
        return yield* directory.find(payload, conversationId);
      }),
    );
  }),
).pipe(Layer.provide(ToolAuthLive));

const SystemLive = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function* (handlers) {
    const directory = yield* DoctorDirectory;
    return handlers.handle("health", () =>
      directory.health.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotReady({ message: "No search index loaded yet" })),
            onSome: Effect.succeed,
          }),
        ),
      ),
    );
  }),
);

const ApiLive = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([ToolsLive, SystemLive]),
  Layer.provide(DoctorDirectory.layer),
  Layer.provide([SearchIndexStore.layer, OutageSwitch.layer]),
);

// Built on the first request of each Worker instance and reused, so the index stays in memory.
const telemetry = new Telemetry("doctor-lookup");
let handler: ((request: Request) => Promise<Response>) | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    telemetry.connect(env.TELEMETRY);
    handler ??= HttpRouter.toWebHandler(
      ApiLive.pipe(
        Layer.provide(Layer.succeed(DataBucket, env.DATA)),
        Layer.provide(HttpServer.layerServices),
        Layer.provideMerge(workerRuntime(env, telemetry)),
      ),
    ).handler;
    const response = await handler(request);
    ctx.waitUntil(telemetry.drain());
    return response;
  },
};
