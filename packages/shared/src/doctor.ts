import { Schema } from "effect";

/**
 * What the system keeps per doctor: where to find them, how to reach them, when they work and
 * what a caller may ask about. Decoding drops the e-mail (shared between doctors in the source)
 * and every other upstream field.
 */
export const Doctor = Schema.Struct({
  first_name: Schema.NonEmptyString,
  last_name: Schema.NonEmptyString,
  speciality: Schema.NonEmptyString,
  clinic_name: Schema.NonEmptyString,
  location: Schema.NonEmptyString,
  county: Schema.NonEmptyString,
  address: Schema.NonEmptyString,
  postal_code: Schema.NonEmptyString,
  phone: Schema.NonEmptyString,
  years_experience: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** As the source writes it, e.g. "Mon-Fri 08:00-16:00"; see parseAvailability. */
  availability: Schema.NonEmptyString,
  languages: Schema.Array(Schema.NonEmptyString),
  rating: Schema.Finite,
});
export type Doctor = typeof Doctor.Type;

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Schedule {
  readonly days: ReadonlyArray<Weekday>;
  /** "HH:MM", 24-hour. */
  readonly from: string;
  readonly to: string;
}

const SHORT_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * "Mon-Fri 08:00-16:00" or "Tue-Sat 08:30-16:30" as days and hours. Undefined when the text does
 * not follow that pattern; the doctor then only matches searches without a day.
 */
export function parseAvailability(text: string): Schedule | undefined {
  const match = text
    .trim()
    .toLowerCase()
    .match(/^([a-z]{3})\s*-\s*([a-z]{3})\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
  if (!match) return undefined;
  const first = SHORT_DAYS.indexOf(match[1]);
  const last = SHORT_DAYS.indexOf(match[2]);
  if (first < 0 || last < first) return undefined;
  return { days: WEEKDAYS.slice(first, last + 1), from: match[3], to: match[4] };
}

/** Whether the schedule covers that day and, if given, that time ("HH:MM"). */
export function isAvailable(schedule: Schedule, day: Weekday, time?: string): boolean {
  if (!schedule.days.includes(day)) return false;
  return time === undefined || (time >= schedule.from && time < schedule.to);
}
