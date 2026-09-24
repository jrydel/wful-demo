import { SearchIndexStore } from "@doctor-directory/shared/search-index";
import { Clock, Config, Context, Duration, Effect, Layer, Option, Ref } from "effect";
import type { FindDoctorPayload, FindDoctorResult, Health } from "./contract";
import { OutageSwitch } from "./outage";
import { type DoctorIndex, findDoctor, openIndex } from "./search";

const LookupConfig = Config.all({
  /** How often, at most, a Worker instance checks for a newly published Search DB. */
  reloadInterval: Config.Duration("RELOAD_INTERVAL").pipe(Config.withDefault(Duration.seconds(10))),
  /** Health reports stale when the served data was pulled longer ago than this. */
  staleAfter: Config.Duration("STALE_AFTER").pipe(Config.withDefault(Duration.hours(48))),
});

export class DoctorDirectory extends Context.Service<
  DoctorDirectory,
  {
    /** `conversationId` names the call in the escalation log when there is no answer. */
    find(query: FindDoctorPayload, conversationId?: string): Effect.Effect<FindDoctorResult>;
    readonly health: Effect.Effect<Option.Option<Health>>;
  }
>()("doctor-lookup/DoctorDirectory") {
  /**
   * Serves from the Search DB that directory-sync publishes and swaps in each new version without
   * a redeploy. Never calls the upstream API; a broken object keeps the current index.
   */
  static readonly layer = Layer.effect(
    DoctorDirectory,
    Effect.gen(function* () {
      const { reloadInterval, staleAfter } = yield* LookupConfig;
      const store = yield* SearchIndexStore;
      const outage = yield* OutageSwitch;
      const current = yield* Ref.make(Option.none<DoctorIndex>());
      const seenVersion = yield* Ref.make("");
      const checkedAt = yield* Ref.make(Number.NEGATIVE_INFINITY);

      const load = Effect.gen(function* () {
        const published = yield* store.load;
        if (Option.isNone(published)) return;
        const { asOf, syncTraceId } = published.value;
        yield* Ref.set(current, Option.some(openIndex(published.value)));
        yield* Effect.annotateCurrentSpan({
          "index.as_of": asOf,
          "index.sync_trace_id": syncTraceId,
        });
        yield* Effect.logInfo("search index loaded", { asOf, syncTraceId });
      }).pipe(Effect.withSpan("DoctorDirectory.load"));

      // Runs inside the caller's request: a Worker may not use R2 from a background timer.
      const refreshIfDue = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - (yield* Ref.get(checkedAt)) < Duration.toMillis(reloadInterval)) return;
        yield* Ref.set(checkedAt, now);
        const version = yield* store.version;
        if (Option.isNone(version) || version.value === (yield* Ref.get(seenVersion))) return;
        // Remember the version before loading, so a broken object is reported once, not per check.
        yield* Ref.set(seenVersion, version.value);
        yield* load;
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("search index not loaded; serving the previous one", error),
        ),
      );

      const find = Effect.fn("DoctorDirectory.find")(function* (
        query: FindDoctorPayload,
        conversationId?: string,
      ) {
        yield* refreshIfDue;
        const index = yield* Ref.get(current);
        const result: FindDoctorResult = (yield* outage.active)
          ? { status: "unavailable", reason: "data_unavailable", escalated: true }
          : Option.isSome(index)
            ? findDoctor(index.value, query)
            : { status: "unavailable", reason: "directory_loading", escalated: true };
        if (result.status === "unavailable") {
          // The caller hangs up without an answer: this is the record someone follows up on.
          yield* Effect.logError("escalated: caller could not be answered", {
            reason: result.reason,
            conversation_id: conversationId ?? "unknown",
            query,
          });
          yield* Effect.annotateCurrentSpan("doctor.escalated", true);
        }
        yield* Effect.annotateCurrentSpan({
          "doctor.query.name": query.name ?? "",
          "doctor.query.city": query.city ?? "",
          "doctor.query.specialty": query.specialty ?? "",
          "doctor.query.day": query.day ?? "",
          "doctor.query.time": query.time ?? "",
          "doctor.query.language": query.language ?? "",
          "doctor.result.status": result.status,
          "doctor.result.reason": "reason" in result ? result.reason : "",
          "index.sync_trace_id": Option.match(index, {
            onNone: () => "",
            onSome: ({ syncTraceId }) => syncTraceId,
          }),
        });
        return result;
      });

      const health = Effect.gen(function* () {
        yield* refreshIfDue;
        const index = yield* Ref.get(current);
        const now = yield* Clock.currentTimeMillis;
        return Option.map(index, ({ asOf, size, syncTraceId }) => ({
          as_of: asOf,
          doctors: size,
          stale: now - Date.parse(asOf) > Duration.toMillis(staleAfter),
          sync_trace_id: syncTraceId,
        }));
      });

      return DoctorDirectory.of({ find, health });
    }),
  );
}
