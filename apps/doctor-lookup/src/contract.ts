import { Schema } from "effect";

export const FindDoctorPayload = Schema.Struct({
  /** Omit to list doctors of one specialty in one city. */
  name: Schema.optional(Schema.NullOr(Schema.String)),
  city: Schema.optional(Schema.NullOr(Schema.String)),
  specialty: Schema.optional(Schema.NullOr(Schema.String)),
  // Filters for listing without a name.
  /** A weekday in English, e.g. "Monday". */
  day: Schema.optional(Schema.NullOr(Schema.String)),
  /** "HH:MM", 24-hour, Romanian time; needs a day. */
  time: Schema.optional(Schema.NullOr(Schema.String)),
  /** A language the doctor speaks, in English, e.g. "German". */
  language: Schema.optional(Schema.NullOr(Schema.String)),
});
export type FindDoctorPayload = typeof FindDoctorPayload.Type;

/** Fields the agent can be asked to collect, in the order it should ask for them. */
export const AskField = Schema.Literals(["first_name", "city", "specialty"]);
export type AskField = typeof AskField.Type;

export const DoctorSummary = Schema.Struct({
  name: Schema.String,
  specialty: Schema.String,
  city: Schema.String,
  rating: Schema.Number,
  availability: Schema.String,
});
export type DoctorSummary = typeof DoctorSummary.Type;

/** The only shape that carries an address or phone; the response schema strips anything else. */
export const DoctorAnswer = Schema.Struct({
  ...DoctorSummary.fields,
  clinic: Schema.String,
  address: Schema.String,
  postal_code: Schema.String,
  county: Schema.String,
  phone: Schema.String,
  years_experience: Schema.Number,
  languages: Schema.Array(Schema.String),
});

export const FindDoctorResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("found"),
    as_of: Schema.String,
    doctors: Schema.Array(DoctorAnswer),
  }),
  Schema.Struct({
    status: Schema.Literal("ambiguous"),
    as_of: Schema.String,
    count: Schema.Number,
    ask_for: Schema.Array(AskField),
    options: Schema.Array(DoctorSummary),
  }),
  // Without a name: who practices that specialty in that city. Names only; an address still
  // needs a lookup by name, which returns `found`.
  Schema.Struct({
    status: Schema.Literal("list"),
    as_of: Schema.String,
    count: Schema.Number,
    doctors: Schema.Array(DoctorSummary),
  }),
  Schema.Struct({
    status: Schema.Literal("not_found"),
    as_of: Schema.String,
    reason: Schema.Literal("name_not_found"),
    did_you_mean: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("not_found"),
    as_of: Schema.String,
    reason: Schema.Literal("not_in_requested_city_or_specialty"),
    elsewhere: Schema.Array(DoctorSummary),
  }),
  Schema.Struct({
    status: Schema.Literal("not_found"),
    as_of: Schema.String,
    reason: Schema.Literal("city_not_covered"),
    known_cities: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("not_found"),
    as_of: Schema.String,
    reason: Schema.Literal("specialty_not_covered"),
    known_specialties: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("invalid_request"),
    reason: Schema.Literals(["name_or_city_and_specialty_required", "invalid_day", "invalid_time"]),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["directory_loading", "data_unavailable"]),
    /** Always true: doctor-lookup logged the unanswered caller for someone to follow up. */
    escalated: Schema.Boolean,
  }),
]);
export type FindDoctorResult = typeof FindDoctorResult.Type;

export const Health = Schema.Struct({
  as_of: Schema.String,
  doctors: Schema.Number,
  stale: Schema.Boolean,
  sync_trace_id: Schema.String,
});
export type Health = typeof Health.Type;
