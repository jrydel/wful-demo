import {
  type Doctor,
  isAvailable,
  parseAvailability,
  WEEKDAYS,
  type Weekday,
} from "@doctor-directory/shared/doctor";
import { normalize, type SearchIndex } from "@doctor-directory/shared/search-index";
import type { AskField, DoctorSummary, FindDoctorPayload, FindDoctorResult } from "./contract";

interface NameEntry {
  readonly first: string;
  readonly last: string;
  readonly display: string;
  readonly doctors: ReadonlyArray<Doctor>;
}

export interface DoctorIndex {
  readonly asOf: string;
  readonly syncTraceId: string;
  readonly size: number;
  readonly names: ReadonlyArray<NameEntry>;
  readonly cities: ReadonlyMap<string, string>;
  readonly counties: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly specialties: ReadonlyMap<string, string>;
}

/** Names at or above this similarity are offered as "did you mean", never answered directly. */
const SUGGEST_MIN = 0.7;
/** City and specialty inputs snap to a known value at or above this similarity. */
const SNAP_MIN = 0.8;
const MAX_OPTIONS = 5;
const ASK_ORDER = [
  ["first_name", "first_name"],
  ["city", "location"],
  ["specialty", "speciality"],
] as const satisfies readonly (readonly [AskField, keyof Doctor])[];
const TITLES: Record<string, true> = {
  dr: true,
  doctor: true,
  doctorul: true,
  doctorita: true,
  doamna: true,
  domnul: true,
  dna: true,
  dl: true,
  prof: true,
  profesor: true,
  professor: true,
  mr: true,
  mrs: true,
  ms: true,
  // Czech callers: "MUDr.", "pan doktor", "paní doktorka".
  mudr: true,
  doktor: true,
  doktorka: true,
  doktorku: true,
  pan: true,
  pani: true,
};

/** Turns a published Search DB into lookup maps. */
export function openIndex(index: SearchIndex): DoctorIndex {
  return {
    asOf: index.asOf,
    syncTraceId: index.syncTraceId,
    size: index.names.reduce((total, entry) => total + entry.doctors.length, 0),
    names: index.names,
    cities: new Map(index.cities),
    counties: new Map(index.counties),
    specialties: new Map(index.specialties),
  };
}

/** 1 minus the Levenshtein distance divided by the longer length. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

/**
 * Resolves a spoken doctor reference. Only an exact (normalized) name match can return an
 * address; near misses come back as suggestions for the agent to confirm, because the directory
 * has confusable names (Stan/Stancu/Stanescu, Maria/Daria, Ioana/Oana).
 */
export function findDoctor(index: DoctorIndex, query: FindDoctorPayload): FindDoctorResult {
  const as_of = index.asOf;
  const tokens = normalize(query.name ?? "")
    .split(" ")
    .filter((token) => token !== "" && !Object.hasOwn(TITLES, token));
  if (tokens.length === 0 && !(query.city?.trim() && query.specialty?.trim())) {
    return { status: "invalid_request", reason: "name_or_city_and_specialty_required" };
  }
  let day: Weekday | undefined;
  if (query.day?.trim()) {
    const text = normalize(query.day);
    day = WEEKDAYS.find((weekday) => normalize(weekday).startsWith(text.slice(0, 3)));
    if (!day) return { status: "invalid_request", reason: "invalid_day" };
  }
  const time = query.time?.trim() || undefined;
  if (time !== undefined && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !day)) {
    return { status: "invalid_request", reason: "invalid_time" };
  }
  const language = query.language?.trim() ? normalize(query.language) : undefined;

  let cities: ReadonlyArray<string> | undefined;
  if (query.city?.trim()) {
    cities = resolveCities(index, query.city);
    if (!cities) {
      const known_cities = [...new Set(index.cities.values())].sort();
      return { status: "not_found", as_of, reason: "city_not_covered", known_cities };
    }
  }
  let specialty: string | undefined;
  if (query.specialty?.trim()) {
    const text = normalize(query.specialty);
    specialty = index.specialties.get(text) ?? closest(text, index.specialties);
    if (!specialty) {
      const known_specialties = [...index.specialties.values()].sort();
      return { status: "not_found", as_of, reason: "specialty_not_covered", known_specialties };
    }
  }

  if (tokens.length === 0 && cities && specialty) {
    const listed = index.names
      .flatMap((entry) => entry.doctors)
      .filter(
        (doctor) =>
          cities.includes(doctor.location) &&
          doctor.speciality === specialty &&
          (!language || doctor.languages.some((spoken) => normalize(spoken) === language)) &&
          (!day || worksAt(doctor, day, time)),
      )
      // Best rated first, so "the top oncologist" means something.
      .sort(
        (a, b) =>
          b.rating - a.rating ||
          a.last_name.localeCompare(b.last_name) ||
          a.first_name.localeCompare(b.first_name),
      );
    // The agent reads these aloud; three names is as many as a caller can hold. Namesakes stay
    // separate: they can work different hours.
    return {
      status: "list",
      as_of,
      count: listed.length,
      doctors: listed.slice(0, 3).map(summary),
    };
  }

  const scored = index.names.map((entry) => ({ entry, score: nameScore(tokens, entry) }));
  let named = scored.filter(({ score }) => score === 1).flatMap(({ entry }) => entry.doctors);
  if (named.length === 0) {
    const did_you_mean = scored
      .filter(({ score }) => score >= SUGGEST_MIN)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ entry }) => entry.display);
    // Filler the agent passed along ("caut pe doctorul Munteanu") must not hide an exact surname.
    if (did_you_mean.length === 0) {
      named = index.names.filter(({ last }) => tokens.includes(last)).flatMap((e) => e.doctors);
    }
    if (named.length === 0) {
      return { status: "not_found", as_of, reason: "name_not_found", did_you_mean };
    }
  }

  const pool = named.filter(
    (doctor) =>
      (!cities || cities.includes(doctor.location)) &&
      (!specialty || doctor.speciality === specialty),
  );
  if (pool.length === 0) {
    return {
      status: "not_found",
      as_of,
      reason: "not_in_requested_city_or_specialty",
      elsewhere: summaries(named),
    };
  }
  const ask_for = ASK_ORDER.filter(([, field]) => new Set(pool.map((d) => d[field])).size > 1).map(
    ([ask]) => ask,
  );
  if (ask_for.length > 0) {
    return { status: "ambiguous", as_of, count: pool.length, ask_for, options: summaries(pool) };
  }
  // Same name, city and specialty: nothing left to ask, so every match is returned.
  const doctors = pool.map((doctor) => ({
    ...summary(doctor),
    clinic: doctor.clinic_name,
    address: doctor.address,
    postal_code: doctor.postal_code,
    county: doctor.county,
    phone: doctor.phone,
    years_experience: doctor.years_experience,
    languages: doctor.languages,
  }));
  return { status: "found", as_of, doctors };
}

function resolveCities(index: DoctorIndex, input: string): ReadonlyArray<string> | undefined {
  const text = normalize(input);
  const city = index.cities.get(text);
  if (city) return [city];
  const county = index.counties.get(text);
  if (county) return county;
  const nearCity = closest(text, index.cities);
  return nearCity ? [nearCity] : closest(text, index.counties);
}

function closest<T>(text: string, values: ReadonlyMap<string, T>): T | undefined {
  let best: T | undefined;
  let bestScore = 0;
  for (const [key, value] of values) {
    const score = similarity(text, key);
    if (score >= SNAP_MIN && score > bestScore) {
      best = value;
      bestScore = score;
    }
  }
  return best;
}

/** One token is a surname; with more, the best first-name/surname pairing in any word order. */
function nameScore(tokens: string[], entry: NameEntry): number {
  if (tokens.length === 1) return similarity(tokens[0], entry.last);
  let best = 0;
  for (const [i, first] of tokens.entries()) {
    for (const [j, last] of tokens.entries()) {
      if (i === j) continue;
      best = Math.max(best, Math.min(similarity(first, entry.first), similarity(last, entry.last)));
    }
  }
  return best;
}

function summary(doctor: Doctor): DoctorSummary {
  return {
    name: `${doctor.first_name} ${doctor.last_name}`,
    specialty: doctor.speciality,
    city: doctor.location,
    rating: doctor.rating,
    availability: doctor.availability,
  };
}

/** Namesakes with the same specialty and city collapse into one option to ask about. */
function summaries(doctors: ReadonlyArray<Doctor>): DoctorSummary[] {
  const unique = new Map<string, DoctorSummary>();
  for (const doctor of doctors) {
    const option = summary(doctor);
    const key = `${option.name}|${option.specialty}|${option.city}`;
    if (!unique.has(key)) unique.set(key, option);
    if (unique.size === MAX_OPTIONS) break;
  }
  return [...unique.values()];
}

/** A schedule the parser cannot read never matches a day filter. */
function worksAt(doctor: Doctor, day: Weekday, time: string | undefined): boolean {
  const schedule = parseAvailability(doctor.availability);
  return schedule !== undefined && isAvailable(schedule, day, time);
}
