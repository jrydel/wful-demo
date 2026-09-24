import { Context, Effect, Layer, Option, Schema } from "effect";
import { DataBucket } from "./bucket";
import { Doctor } from "./doctor";

/** Bump when the layout changes; doctor-lookup refuses files it cannot decode. */
export const SEARCH_INDEX_FORMAT = 2;

/**
 * The Search DB: the contract between the two services. directory-sync builds and publishes it;
 * doctor-lookup only reads it. Names and places arrive already normalized.
 */
export const SearchIndex = Schema.Struct({
  format: Schema.Literal(SEARCH_INDEX_FORMAT),
  /** When the data was pulled from the upstream API. */
  asOf: Schema.String,
  builtAt: Schema.String,
  /** Trace of the directory-sync run that built this index. */
  syncTraceId: Schema.String,
  names: Schema.Array(
    Schema.Struct({
      first: Schema.String,
      last: Schema.String,
      display: Schema.String,
      doctors: Schema.Array(Doctor),
    }),
  ),
  cities: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  counties: Schema.Array(Schema.Tuple([Schema.String, Schema.Array(Schema.String)])),
  specialties: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});
export type SearchIndex = typeof SearchIndex.Type;

/** Lowercase ASCII without diacritics or punctuation: "Ștefan" and "stefan" compare equal. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Spoken names that differ from the directory's spelling. */
const CITY_ALIASES: Record<string, string> = {
  bucuresti: "Bucharest",
  sighet: "Sighetu Marmatiei",
  "turnu severin": "Drobeta-Turnu Severin",
};

/**
 * The data processor: turns the DB into the Search DB. It runs in directory-sync and lives here
 * because it defines the format doctor-lookup reads. Names and places are normalized once, so
 * doctor-lookup only normalizes what the caller said.
 */
export function buildSearchIndex(
  snapshot: { readonly fetchedAt: string; readonly doctors: ReadonlyArray<Doctor> },
  syncTraceId: string,
  builtAt: string,
): SearchIndex {
  const names = new Map<
    string,
    { first: string; last: string; display: string; doctors: Doctor[] }
  >();
  const cities = new Map<string, string>();
  const counties = new Map<string, string[]>();
  const specialties = new Map<string, string>();
  for (const doctor of snapshot.doctors) {
    const first = normalize(doctor.first_name);
    const last = normalize(doctor.last_name);
    const key = `${first}|${last}`;
    const entry = names.get(key) ?? {
      first,
      last,
      display: `${doctor.first_name} ${doctor.last_name}`,
      doctors: [],
    };
    entry.doctors.push(doctor);
    names.set(key, entry);
    cities.set(normalize(doctor.location), doctor.location);
    const countyKey = normalize(doctor.county);
    const countyCities = counties.get(countyKey) ?? [];
    if (!countyCities.includes(doctor.location)) countyCities.push(doctor.location);
    counties.set(countyKey, countyCities);
    specialties.set(normalize(doctor.speciality), doctor.speciality);
  }
  const knownCities = new Set(cities.values());
  for (const [alias, city] of Object.entries(CITY_ALIASES)) {
    if (knownCities.has(city) && !cities.has(alias)) cities.set(alias, city);
  }
  return {
    format: SEARCH_INDEX_FORMAT,
    asOf: snapshot.fetchedAt,
    builtAt,
    syncTraceId,
    names: [...names.values()],
    cities: [...cities],
    counties: [...counties],
    specialties: [...specialties],
  };
}

export class SearchIndexError extends Schema.TaggedError<SearchIndexError>()("SearchIndexError", {
  key: Schema.String,
  cause: Schema.Defect(),
}) {}

/** The published object was read but does not decode: a broken publish or another format. */
export class SearchIndexInvalid extends Schema.TaggedError<SearchIndexInvalid>()(
  "SearchIndexInvalid",
  { key: Schema.String, cause: Schema.Defect() },
) {}

const SEARCH_INDEX_KEY = "search-index.json";

/** The Search DB as one R2 object; R2 replaces objects atomically, so readers never see half. */
export class SearchIndexStore extends Context.Service<
  SearchIndexStore,
  {
    /** The object's ETag: changes with every publish; None until the first one. */
    readonly version: Effect.Effect<Option.Option<string>, SearchIndexError>;
    /**
     * None until the first publish. Fails with SearchIndexInvalid if the object does not decode,
     * SearchIndexError if it could not be read.
     */
    readonly load: Effect.Effect<Option.Option<SearchIndex>, SearchIndexError | SearchIndexInvalid>;
    publish(index: SearchIndex): Effect.Effect<void, SearchIndexError>;
  }
>()("doctor-directory/SearchIndexStore") {
  static readonly layer = Layer.effect(
    SearchIndexStore,
    Effect.gen(function* () {
      const bucket = yield* DataBucket;
      const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchIndex));
      const failed = (cause: unknown) => new SearchIndexError({ key: SEARCH_INDEX_KEY, cause });

      const version = Effect.tryPromise(() => bucket.head(SEARCH_INDEX_KEY)).pipe(
        Effect.map((object) => Option.map(Option.fromNullOr(object), ({ etag }) => etag)),
        Effect.mapError(failed),
      );

      const load = Effect.gen(function* () {
        const object = yield* Effect.tryPromise(() => bucket.get(SEARCH_INDEX_KEY)).pipe(
          Effect.mapError(failed),
        );
        if (object === null) return Option.none<SearchIndex>();
        const text = yield* Effect.tryPromise(() => object.text()).pipe(Effect.mapError(failed));
        const index = yield* decode(text).pipe(
          Effect.mapError((cause) => new SearchIndexInvalid({ key: SEARCH_INDEX_KEY, cause })),
        );
        return Option.some(index);
      }).pipe(Effect.withSpan("SearchIndexStore.load"));

      const publish = Effect.fn("SearchIndexStore.publish")((index: SearchIndex) =>
        Effect.tryPromise(() =>
          bucket.put(SEARCH_INDEX_KEY, JSON.stringify(index), {
            httpMetadata: { contentType: "application/json" },
          }),
        ).pipe(Effect.asVoid, Effect.mapError(failed)),
      );

      return SearchIndexStore.of({ version, load, publish });
    }),
  );
}
