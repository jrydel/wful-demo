import { Context, Effect, Layer, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { SyncConfig } from "./config";

export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
  cause: Schema.Defect(),
}) {}

/** The slow upstream API: one full dump per call, returned unparsed. Only directory-sync talks to it. */
export class Upstream extends Context.Service<
  Upstream,
  { readonly fetchDump: Effect.Effect<string, UpstreamError> }
>()("directory-sync/Upstream") {
  static readonly layer = Layer.effect(
    Upstream,
    Effect.gen(function* () {
      const { source, timeout } = yield* SyncConfig;
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ schedule: Schedule.exponential("30 seconds"), times: 2 }),
      );
      const fetchDump = client.get(source).pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeout(timeout),
        Effect.mapError((cause) => new UpstreamError({ cause })),
        Effect.withSpan("Upstream.fetchDump", { attributes: { "upstream.host": source.host } }),
      );
      return Upstream.of({ fetchDump });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
