import { Config, Duration, Schema } from "effect";

export const SyncConfig = Config.all({
  /** The slow upstream dump, e.g. the client's API or the directory-api stand-in. */
  source: Config.URL("SOURCE_URL"),
  /** Sent as a bearer token to SOURCE_URL when set; the directory-api stand-in requires it. */
  sourceToken: Config.option(Config.Redacted("SOURCE_TOKEN")),
  /**
   * Budget for one pull attempt. The upstream takes about 15 minutes; the pull runs in a
   * Workflow step, which has no wall-clock limit, and the step itself times out at 45.
   */
  timeout: Config.Duration("SYNC_TIMEOUT").pipe(Config.withDefault(Duration.minutes(40))),
  /** Refuse a dump with fewer valid records than this share of the last good one. */
  minCountRatio: Config.schema(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1, exclusiveMinimum: true })),
    "MIN_COUNT_RATIO",
  ).pipe(Config.withDefault(0.9)),
});
