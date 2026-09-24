import { DataBucket } from "@doctor-directory/shared/bucket";
import { Doctor } from "@doctor-directory/shared/doctor";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SyncConfig } from "./config";
import { Upstream, type UpstreamError } from "./upstream";

export const Snapshot = Schema.Struct({
  /** When the pull started: the data is at least this fresh. */
  fetchedAt: Schema.String,
  doctors: Schema.Array(Doctor),
});
export type Snapshot = typeof Snapshot.Type;

export class DumpRejected extends Schema.TaggedError<DumpRejected>()("DumpRejected", {
  reason: Schema.String,
}) {}

export class DoctorDbError extends Schema.TaggedError<DoctorDbError>()("DoctorDbError", {
  key: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface ParsedDump {
  readonly doctors: Doctor[];
  readonly rejected: number;
  readonly duplicates: number;
}

const decodeDoctor = Schema.decodeUnknownOption(Doctor);
const DOCTOR_FIELDS = Object.keys(Doctor.fields) as (keyof Doctor)[];

/**
 * Schema validation and deduplication. Keeps records that decode as a Doctor and removes exact
 * duplicates only: namesakes at the same clinic are different doctors (the sample dump has 616
 * e-mails shared by 1,285 distinct records), and the source has no ID to deduplicate on.
 */
export function parseDump(records: ReadonlyArray<unknown>): ParsedDump {
  const doctors: Doctor[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  let duplicates = 0;
  for (const record of records) {
    const decoded = decodeDoctor(record);
    if (Option.isNone(decoded)) {
      rejected++;
      continue;
    }
    const key = DOCTOR_FIELDS.map((field) => decoded.value[field]).join("\u0000");
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    doctors.push(decoded.value);
  }
  return { doctors, rejected, duplicates };
}

const DB_KEY = "doctors.json";
/** The raw dump between the pull step and the validate step, one object per sync run. */
const stagedKey = (runId: string) => `incoming/${runId}.json`;

/** The DB (the last good pull, validated and deduplicated) and the staged raw dumps, in R2. */
export class DoctorDb extends Context.Service<
  DoctorDb,
  {
    /**
     * How many doctors the last good DB held, for the shrink check. Reads only the count, so a DB
     * written by an older version with other fields still counts.
     */
    readonly count: Effect.Effect<Option.Option<number>, DoctorDbError>;
    readonly load: Effect.Effect<Option.Option<Snapshot>, DoctorDbError>;
    save(snapshot: Snapshot): Effect.Effect<void, DoctorDbError>;
    stage(runId: string, raw: string): Effect.Effect<void, DoctorDbError>;
    readStaged(runId: string): Effect.Effect<Option.Option<string>, DoctorDbError>;
    discardStaged(runId: string): Effect.Effect<void, DoctorDbError>;
  }
>()("directory-sync/DoctorDb") {
  static readonly layer = Layer.effect(
    DoctorDb,
    Effect.gen(function* () {
      const bucket = yield* DataBucket;
      const decodeCount = Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ doctors: Schema.Array(Schema.Unknown) })),
      );
      const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot));
      const failed = (key: string) => (cause: unknown) => new DoctorDbError({ key, cause });
      const text = (key: string) =>
        Effect.tryPromise(() => bucket.get(key)).pipe(
          Effect.flatMap((object) =>
            object === null
              ? Effect.succeed(Option.none<string>())
              : Effect.tryPromise(() => object.text()).pipe(Effect.map(Option.some)),
          ),
        );
      const write = (key: string, body: string) =>
        Effect.tryPromise(() =>
          bucket.put(key, body, { httpMetadata: { contentType: "application/json" } }),
        ).pipe(Effect.asVoid, Effect.mapError(failed(key)));

      const count = text(DB_KEY).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<number>()),
            onSome: (raw) =>
              decodeCount(raw).pipe(Effect.map((db) => Option.some(db.doctors.length))),
          }),
        ),
        Effect.mapError(failed(DB_KEY)),
        Effect.withSpan("DoctorDb.count"),
      );
      const load = text(DB_KEY).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<Snapshot>()),
            onSome: (raw) => decodeSnapshot(raw).pipe(Effect.map(Option.some)),
          }),
        ),
        Effect.mapError(failed(DB_KEY)),
        Effect.withSpan("DoctorDb.load"),
      );
      const save = Effect.fn("DoctorDb.save")((snapshot: Snapshot) =>
        write(DB_KEY, JSON.stringify(snapshot)),
      );
      const stage = Effect.fn("DoctorDb.stage")((runId: string, raw: string) =>
        write(stagedKey(runId), raw),
      );
      const readStaged = Effect.fn("DoctorDb.readStaged")((runId: string) =>
        text(stagedKey(runId)).pipe(Effect.mapError(failed(stagedKey(runId)))),
      );
      const discardStaged = Effect.fn("DoctorDb.discardStaged")((runId: string) =>
        Effect.tryPromise(() => bucket.delete(stagedKey(runId))).pipe(
          Effect.mapError(failed(stagedKey(runId))),
        ),
      );

      return DoctorDb.of({ count, load, save, stage, readStaged, discardStaged });
    }),
  );
}

export interface Pulled {
  /** When the pull started: the data is at least this fresh. */
  readonly fetchedAt: string;
  readonly bytes: number;
}

export interface Applied {
  readonly doctors: number;
  readonly rejected: number;
  readonly duplicates: number;
}

/**
 * A sync run in two parts, so a Workflow can run them as separate, separately retried steps:
 * the slow pull (about 15 minutes) and the quick validation that replaces the DB.
 */
export class Ingest extends Context.Service<
  Ingest,
  {
    /**
     * Pulls the full dump and stages it unparsed under the run's id, however long the upstream
     * takes; overlapping runs never read each other's dump.
     */
    pull(runId: string): Effect.Effect<Pulled, UpstreamError | DoctorDbError>;
    /**
     * Validates the run's staged dump and replaces the DB. The dump is a full state, so doctors
     * removed upstream disappear. An empty dump, or one that shrank below MIN_COUNT_RATIO, is
     * refused, the last good DB stays and the staged dump is kept for inspection.
     */
    apply(runId: string, fetchedAt: string): Effect.Effect<Applied, DumpRejected | DoctorDbError>;
  }
>()("directory-sync/Ingest") {
  static readonly layer = Layer.effect(
    Ingest,
    Effect.gen(function* () {
      const { minCountRatio } = yield* SyncConfig;
      const upstream = yield* Upstream;
      const db = yield* DoctorDb;

      const pull = Effect.fn("Ingest.pull")(function* (runId: string) {
        const fetchedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        const raw = yield* upstream.fetchDump;
        yield* db.stage(runId, raw);
        yield* Effect.annotateCurrentSpan("dump.bytes", raw.length);
        return { fetchedAt, bytes: raw.length };
      });

      const apply = Effect.fn("Ingest.apply")(function* (runId: string, fetchedAt: string) {
        const staged = yield* db.readStaged(runId);
        if (Option.isNone(staged)) {
          return yield* new DumpRejected({ reason: "no staged dump to validate" });
        }
        let records: unknown;
        try {
          records = JSON.parse(staged.value);
        } catch {
          return yield* new DumpRejected({ reason: "dump is not valid JSON" });
        }
        if (!Array.isArray(records)) {
          return yield* new DumpRejected({ reason: "dump is not a JSON array" });
        }
        const { doctors, rejected, duplicates } = parseDump(records);
        const previous = yield* db.count;
        const required = Option.match(previous, {
          onNone: () => 1,
          onSome: (count) => Math.ceil(count * minCountRatio),
        });
        yield* Effect.annotateCurrentSpan({
          "dump.valid": doctors.length,
          "dump.rejected": rejected,
          "dump.duplicates": duplicates,
          "dump.required": required,
        });
        if (doctors.length < required) {
          return yield* new DumpRejected({
            reason: `${doctors.length} valid records (${rejected} rejected); need at least ${required}`,
          });
        }
        yield* db.save({ fetchedAt, doctors });
        yield* Effect.logInfo("DB replaced", { doctors: doctors.length, rejected, duplicates });
        // The raw dump still holds fields the DB drops (e-mails); a leftover is only untidy.
        yield* db
          .discardStaged(runId)
          .pipe(Effect.catch((error) => Effect.logWarning("staged dump not deleted", error)));
        return { doctors: doctors.length, rejected, duplicates };
      });

      return Ingest.of({ pull, apply });
    }),
  );
}

/** Ingest plus the DB it writes; the caller provides the Upstream and the bucket. */
export const IngestLive = Ingest.layer.pipe(Layer.provideMerge(DoctorDb.layer));
