import { expect, test } from "bun:test";
import type { Doctor } from "@doctor-directory/shared/doctor";
import { buildSearchIndex } from "@doctor-directory/shared/search-index";
import type { FindDoctorPayload } from "./contract";
import { findDoctor, openIndex } from "./search";

function doctor(
  first_name: string,
  last_name: string,
  speciality: string,
  location: string,
  county: string,
  address: string,
  extra: Partial<Doctor> = {},
): Doctor {
  const clinic_name = `Clinica ${location} Care`;
  return {
    first_name,
    last_name,
    speciality,
    location,
    county,
    address,
    clinic_name,
    postal_code: "100000",
    phone: "+40-256-000-000",
    years_experience: 10,
    availability: "Mon-Fri 09:00-17:00",
    languages: ["Romanian"],
    rating: 4,
    ...extra,
  };
}

// Built the way directory-sync publishes it and opened the way doctor-lookup reads it.
const index = openIndex(
  buildSearchIndex(
    {
      fetchedAt: "2026-09-24T00:00:00.000Z",
      doctors: [
        doctor("Stefan", "Stan", "Cardiology", "Timisoara", "Timis", "Strada Unirii 1", {
          rating: 4.1,
          availability: "Mon-Fri 08:00-16:00",
          languages: ["English", "Romanian"],
        }),
        doctor("Stefan", "Stancu", "Cardiology", "Timisoara", "Timis", "Strada Unirii 2", {
          rating: 4.8,
          availability: "Tue-Sat 08:30-16:30",
          languages: ["German"],
          phone: "+40-256-123-456",
          years_experience: 22,
        }),
        doctor("Daria", "Munteanu", "Ophthalmology", "Ploiesti", "Prahova", "Strada Crinului 33"),
        doctor(
          "Daria",
          "Munteanu",
          "Obstetrics and Gynecology",
          "Ploiesti",
          "Prahova",
          "Strada Florilor 36",
        ),
        doctor("Daria", "Munteanu", "Ophthalmology", "Lugoj", "Timis", "Strada Garii 5"),
        doctor("Maria", "Dumitrescu", "Neurology", "Bucharest", "Bucharest", "Strada Victoriei 9"),
        doctor("Maria", "Dumitrescu", "Neurology", "Bucharest", "Bucharest", "Strada Traian 4"),
      ],
    },
    "sync-trace",
    "2026-09-24T00:05:00.000Z",
  ),
);

function addresses(query: FindDoctorPayload): string[] | string {
  const result = findDoctor(index, query);
  return result.status === "found" ? result.doctors.map((d) => d.address) : result.status;
}

test("exact names win over similar ones, ignoring diacritics, case, titles and word order", () => {
  expect(addresses({ name: "dr. STANCU Ștefan" })).toEqual(["Strada Unirii 2"]);
  expect(addresses({ name: "Ștefan Stan" })).toEqual(["Strada Unirii 1"]);
  expect(addresses({ name: "MUDr. Ștefan Stancu" })).toEqual(["Strada Unirii 2"]);
});

test("ambiguity asks only for the fields that still split the candidates", () => {
  expect(findDoctor(index, { name: "Daria Munteanu" })).toMatchObject({
    status: "ambiguous",
    count: 3,
    ask_for: ["city", "specialty"],
  });
  expect(findDoctor(index, { name: "Daria Munteanu", city: "Ploiești" })).toMatchObject({
    status: "ambiguous",
    count: 2,
    ask_for: ["specialty"],
  });
  expect(
    addresses({ name: "Daria Munteanu", city: "Ploiesti", specialty: "ophthalmology" }),
  ).toEqual(["Strada Crinului 33"]);
});

test("a county narrows the search to its cities", () => {
  expect(addresses({ name: "Daria Munteanu", city: "Timiș" })).toEqual(["Strada Garii 5"]);
});

test("misheard names get suggestions, never an address", () => {
  expect(findDoctor(index, { name: "Maria Dimitrescu" })).toEqual({
    status: "not_found",
    as_of: "2026-09-24T00:00:00.000Z",
    reason: "name_not_found",
    did_you_mean: ["Maria Dumitrescu"],
  });
});

test("filler words around an exact surname fall back to the surname", () => {
  expect(findDoctor(index, { name: "caut pe doctorul Munteanu" })).toMatchObject({
    status: "ambiguous",
    count: 3,
  });
});

test("namesakes with the same city and specialty are all returned", () => {
  expect(addresses({ name: "Maria Dumitrescu", city: "Bucuresti" })).toEqual([
    "Strada Victoriei 9",
    "Strada Traian 4",
  ]);
});

test("a doctor practicing elsewhere is reported instead of matched", () => {
  expect(findDoctor(index, { name: "Stefan Stan", city: "Ploiesti" })).toMatchObject({
    status: "not_found",
    reason: "not_in_requested_city_or_specialty",
    elsewhere: [{ name: "Stefan Stan", specialty: "Cardiology", city: "Timisoara" }],
  });
});

test("without a name, city and specialty list who practices there, best rated first, no addresses", () => {
  const result = findDoctor(index, { city: "Timis", specialty: "cardiology" });
  expect(result).toEqual({
    status: "list",
    as_of: "2026-09-24T00:00:00.000Z",
    count: 2,
    doctors: [
      {
        name: "Stefan Stancu",
        specialty: "Cardiology",
        city: "Timisoara",
        rating: 4.8,
        availability: "Tue-Sat 08:30-16:30",
      },
      {
        name: "Stefan Stan",
        specialty: "Cardiology",
        city: "Timisoara",
        rating: 4.1,
        availability: "Mon-Fri 08:00-16:00",
      },
    ],
  });
  expect(findDoctor(index, { name: "", city: "Ploiesti", specialty: "Cardiology" })).toMatchObject({
    status: "list",
    count: 0,
    doctors: [],
  });
});

test("without a name, both city and specialty are required, and unknown cities still say so", () => {
  expect(findDoctor(index, { city: "Bucharest" }).status).toBe("invalid_request");
  expect(findDoctor(index, { name: "dr.", specialty: "Neurology" }).status).toBe("invalid_request");
  expect(findDoctor(index, { city: "Brno", specialty: "Oncology" })).toMatchObject({
    status: "not_found",
    reason: "city_not_covered",
  });
});

function listed(query: Omit<FindDoctorPayload, "city" | "specialty">): string[] | string {
  const result = findDoctor(index, { city: "Timisoara", specialty: "Cardiology", ...query });
  return result.status === "list" ? result.doctors.map((d) => d.name) : result.status;
}

test("listing filters by the day and hour a doctor works, and by language", () => {
  expect(listed({ day: "Monday" })).toEqual(["Stefan Stan"]);
  expect(listed({ day: "saturday" })).toEqual(["Stefan Stancu"]);
  expect(listed({ day: "Tuesday", time: "08:15" })).toEqual(["Stefan Stan"]);
  // Hours include the start and exclude the end.
  expect(listed({ day: "Tuesday", time: "08:30" })).toEqual(["Stefan Stancu", "Stefan Stan"]);
  expect(listed({ day: "Monday", time: "16:00" })).toEqual([]);
  expect(listed({ day: "Sunday" })).toEqual([]);
  expect(listed({ language: "german" })).toEqual(["Stefan Stancu"]);
  expect(listed({ language: "English", day: "Saturday" })).toEqual([]);
});

test("unusable filters are refused instead of ignored", () => {
  expect(findDoctor(index, { city: "Timisoara", specialty: "Cardiology", day: "Funday" })).toEqual({
    status: "invalid_request",
    reason: "invalid_day",
  });
  expect(listed({ day: "Monday", time: "25:00" })).toBe("invalid_request");
  expect(listed({ time: "10:00" })).toBe("invalid_request");
});

test("a found doctor comes with phone, hours, languages, experience and rating", () => {
  expect(findDoctor(index, { name: "Stefan Stancu" })).toMatchObject({
    status: "found",
    doctors: [
      {
        name: "Stefan Stancu",
        clinic: "Clinica Timisoara Care",
        address: "Strada Unirii 2",
        phone: "+40-256-123-456",
        availability: "Tue-Sat 08:30-16:30",
        languages: ["German"],
        years_experience: 22,
        rating: 4.8,
      },
    ],
  });
});
