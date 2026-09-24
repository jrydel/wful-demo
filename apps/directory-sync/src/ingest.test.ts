import { expect, test } from "bun:test";
import { type Bucket, DataBucket, memoryBucket } from "@doctor-directory/shared/bucket";
import { ConfigProvider, Effect, Layer } from "effect";
import { Ingest, IngestLive, parseDump } from "./ingest";
import { Upstream } from "./upstream";

function record(first_name: string, speciality: string, address: string) {
  return {
    first_name,
    last_name: "Munteanu",
    speciality,
    clinic_name: "Clinica Ploiesti Care",
    location: "Ploiesti",
    county: "Prahova",
    address,
    postal_code: "100000",
    phone: "+40-200-000-000",
    email: "daria.munteanu@clinica-ploiesti-care.ro",
    years_experience: 12,
    education: "Carol Davila University of Medicine and Pharmacy",
    languages: ["Romanian", "English"],
    availability: "Mon-Fri 08:00-16:00",
    rating: 4.5,
  };
}

test("parsing keeps namesakes, drops exact copies, keeps the phone and drops the e-mail", () => {
  const ophthalmologist = record("Daria", "Ophthalmology", "Strada Crinului 33");
  const gynecologist = record("Daria", "Obstetrics and Gynecology", "Strada Florilor 36");
  const { doctors, duplicates, rejected } = parseDump([
    ophthalmologist,
    gynecologist,
    { ...ophthalmologist },
    { ...gynecologist, address: "" },
  ]);
  expect(doctors.map((d) => d.speciality)).toEqual(["Ophthalmology", "Obstetrics and Gynecology"]);
  expect({ duplicates, rejected }).toEqual({ duplicates: 1, rejected: 1 });
  expect(doctors[0]).toMatchObject({ phone: "+40-200-000-000", rating: 4.5 });
  expect(doctors[0]).not.toHaveProperty("email");
  expect(doctors[0]).not.toHaveProperty("education");
});

function ingestLayer(bucket: Bucket, dump: () => unknown[] | string) {
  const raw = () => {
    const value = dump();
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  return IngestLive.pipe(
    Layer.provide(Layer.succeed(Upstream, { fetchDump: Effect.sync(raw) })),
    Layer.provide(Layer.succeed(DataBucket, bucket)),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ SOURCE_URL: "https://upstream.test" })),
    ),
  );
}

/** Both steps of a sync run, as the Workflow runs them: pull and stage, then validate and save. */
function ingestRun(bucket: Bucket, dump: () => unknown[] | string) {
  return Ingest.use((ingest) =>
    ingest
      .pull("run")
      .pipe(
        Effect.flatMap((pulled) =>
          ingest
            .apply("run", pulled.fetchedAt)
            .pipe(Effect.map((applied) => ({ ...pulled, ...applied }))),
        ),
      ),
  ).pipe(Effect.provide(ingestLayer(bucket, dump)));
}

const full = Array.from({ length: 10 }, (_, i) => record(`Name${i}`, "Cardiology", `Strada ${i}`));

test("a shrunken dump is refused and the last good DB stays", async () => {
  const bucket = memoryBucket();
  let dump: unknown[] = full;
  const run = ingestRun(bucket, () => dump);

  const first = await Effect.runPromise(run);
  dump = full.slice(0, 5);
  const error = await Effect.runPromise(Effect.flip(run));

  expect(error).toMatchObject({ _tag: "DumpRejected" });
  const kept = JSON.parse((await (await bucket.get("doctors.json"))?.text()) ?? "null");
  expect(kept).toMatchObject({ fetchedAt: first.fetchedAt });
  expect(kept.doctors).toHaveLength(10);
});

test("a DB written in an older layout still counts for the shrink check", async () => {
  const bucket = memoryBucket();
  const older = full.map(
    ({ phone, email, years_experience, education, languages, availability, rating, ...kept }) =>
      kept,
  );
  await bucket.put(
    "doctors.json",
    JSON.stringify({ fetchedAt: "2026-09-01T00:00:00.000Z", doctors: older }),
  );

  const error = await Effect.runPromise(Effect.flip(ingestRun(bucket, () => full.slice(0, 5))));
  expect(error).toMatchObject({ _tag: "DumpRejected" });
  await Effect.runPromise(ingestRun(bucket, () => full));
});

test("an upstream answer that is not JSON is refused and the DB stays", async () => {
  const bucket = memoryBucket();
  await Effect.runPromise(ingestRun(bucket, () => full));

  const error = await Effect.runPromise(
    Effect.flip(ingestRun(bucket, () => "<html>Service Unavailable</html>")),
  );
  expect(error).toMatchObject({ _tag: "DumpRejected", reason: "dump is not valid JSON" });
  const kept = JSON.parse((await (await bucket.get("doctors.json"))?.text()) ?? "null");
  expect(kept.doctors).toHaveLength(10);
});

test("overlapping runs each validate the dump they pulled", async () => {
  const bucket = memoryBucket();
  const dumps = [full, full.slice(0, 9)];
  await Ingest.use((ingest) =>
    Effect.gen(function* () {
      const first = yield* ingest.pull("first");
      yield* ingest.pull("second");
      yield* ingest.apply("first", first.fetchedAt);
    }),
  ).pipe(Effect.provide(ingestLayer(bucket, () => dumps.shift() ?? [])), Effect.runPromise);

  const db = JSON.parse((await (await bucket.get("doctors.json"))?.text()) ?? "null");
  expect(db.doctors).toHaveLength(10);
  // The applied run's raw dump is gone; the other run's is still waiting for its own step.
  expect(await bucket.get("incoming/first.json")).toBeNull();
  expect(await bucket.get("incoming/second.json")).not.toBeNull();
});
