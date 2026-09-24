import { constantTimeEqual } from "@doctor-directory/shared/auth";
import { type Bucket, DataBucket } from "@doctor-directory/shared/bucket";
import { Telemetry, type TelemetrySink } from "@doctor-directory/shared/telemetry";
import { type WorkerContext, workerRuntime } from "@doctor-directory/shared/worker";
import { Config, Duration, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

// Stand-in for the client's directory API: the whole dataset in one response, sent only after
// DIRECTORY_DELAY, the way the real API works for ~15 minutes before the first byte. The dump
// holds every field, e-mails included, so only directory-sync may read it: requests need
// `Authorization: Bearer <SOURCE_TOKEN>`, and without the secret nothing is served.

interface Env {
  readonly DEMO: Bucket;
  readonly SOURCE_TOKEN?: string;
  readonly TELEMETRY?: TelemetrySink;
}

function authorized(request: Request, env: Env): boolean {
  const token = env.SOURCE_TOKEN ?? "";
  return (
    token !== "" && constantTimeEqual(request.headers.get("authorization") ?? "", `Bearer ${token}`)
  );
}

const DATASET_KEY = "healthcare_data.json";

const DoctorsRoute = Layer.unwrap(
  Effect.gen(function* () {
    const delay = yield* Config.Duration("DIRECTORY_DELAY").pipe(
      Config.withDefault(Duration.minutes(2)),
    );
    const bucket = yield* DataBucket;
    return HttpRouter.add(
      "GET",
      "/doctors",
      Effect.gen(function* () {
        yield* Effect.sleep(delay).pipe(
          Effect.withSpan("DirectoryApi.prepareDump", {
            attributes: { "dump.delay_ms": Duration.toMillis(delay) },
          }),
        );
        const object = yield* Effect.promise(() => bucket.get(DATASET_KEY));
        if (object === null) {
          return HttpServerResponse.text(`${DATASET_KEY} is missing; run bun run seed`, {
            status: 500,
          });
        }
        const body = yield* Effect.promise(() => object.text());
        return HttpServerResponse.text(body, { contentType: "application/json" });
      }),
    );
  }),
);

const telemetry = new Telemetry("directory-api");
let handler: ((request: Request) => Promise<Response>) | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    // Checked before the delay, so a refused caller does not hold a request open for 15 minutes.
    if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
    telemetry.connect(env.TELEMETRY);
    handler ??= HttpRouter.toWebHandler(
      DoctorsRoute.pipe(
        Layer.provide(Layer.succeed(DataBucket, env.DEMO)),
        Layer.provide(HttpServer.layerServices),
        Layer.provideMerge(workerRuntime(env, telemetry)),
      ),
    ).handler;
    const response = await handler(request);
    ctx.waitUntil(telemetry.drain());
    return response;
  },
};
