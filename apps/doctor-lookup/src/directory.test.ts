import { expect, test } from "bun:test";
import { type Bucket, DataBucket, memoryBucket } from "@doctor-directory/shared/bucket";
import { buildSearchIndex, SearchIndexStore } from "@doctor-directory/shared/search-index";
import { ConfigProvider, Effect, Layer } from "effect";
import { DoctorDirectory } from "./directory";
import { OutageSwitch } from "./outage";

const daria = {
  first_name: "Daria",
  last_name: "Munteanu",
  speciality: "Ophthalmology",
  clinic_name: "Clinica Ploiesti Care",
  location: "Ploiesti",
  county: "Prahova",
  address: "Strada Crinului 33",
  postal_code: "100000",
  phone: "+40-244-000-000",
  years_experience: 12,
  availability: "Mon-Fri 08:00-16:00",
  languages: ["Romanian", "English"],
  rating: 4.5,
};

function directoryLayer(bucket: Bucket) {
  return DoctorDirectory.layer.pipe(
    Layer.provide([SearchIndexStore.layer, OutageSwitch.layer]),
    Layer.provide(Layer.succeed(DataBucket, bucket)),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ RELOAD_INTERVAL: "20 millis" })),
    ),
  );
}

test("a new Search DB is served without a redeploy; a broken one keeps the current index", async () => {
  const bucket = memoryBucket();
  const publish = (asOf: string) =>
    bucket.put(
      "search-index.json",
      JSON.stringify(buildSearchIndex({ fetchedAt: asOf, doctors: [daria] }, "trace", asOf)),
    );
  const servedAsOf = DoctorDirectory.use((directory) =>
    directory
      .find({ name: "Daria Munteanu" })
      .pipe(Effect.map((result) => ("as_of" in result ? result.as_of : result.status))),
  );
  const afterReloadInterval = Effect.sleep("30 millis");

  const served = await Effect.gen(function* () {
    const beforeFirstPublish = yield* servedAsOf;
    yield* Effect.promise(() => publish("2026-09-01T00:00:00.000Z"));
    yield* afterReloadInterval;
    const afterFirstPublish = yield* servedAsOf;
    yield* Effect.promise(() => bucket.put("search-index.json", "{ truncated"));
    yield* afterReloadInterval;
    const afterBrokenPublish = yield* servedAsOf;
    yield* Effect.promise(() => publish("2026-09-02T00:00:00.000Z"));
    yield* afterReloadInterval;
    const afterNextPublish = yield* servedAsOf;
    return [beforeFirstPublish, afterFirstPublish, afterBrokenPublish, afterNextPublish];
  }).pipe(Effect.provide(directoryLayer(bucket)), Effect.runPromise);

  expect(served).toEqual([
    "unavailable",
    "2026-09-01T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z",
  ]);
});

async function lookupWithFlags(flags: string | undefined) {
  const bucket = memoryBucket();
  const asOf = "2026-09-01T00:00:00.000Z";
  await bucket.put(
    "search-index.json",
    JSON.stringify(buildSearchIndex({ fetchedAt: asOf, doctors: [daria] }, "trace", asOf)),
  );
  if (flags !== undefined) await bucket.put("control/flags.json", flags);
  return Effect.runPromise(
    DoctorDirectory.use((directory) => directory.find({ name: "Daria Munteanu" }, "conv_1")).pipe(
      Effect.provide(directoryLayer(bucket)),
    ),
  );
}

test("the outage switch answers every lookup as unavailable and escalated", async () => {
  expect(await lookupWithFlags(JSON.stringify({ simulateOutage: true }))).toEqual({
    status: "unavailable",
    reason: "data_unavailable",
    escalated: true,
  });
  expect((await lookupWithFlags(JSON.stringify({ simulateOutage: false }))).status).toBe("found");
});

test("an unreadable switch never takes lookups down", async () => {
  expect((await lookupWithFlags("{ not json")).status).toBe("found");
  expect((await lookupWithFlags(undefined)).status).toBe("found");
});
