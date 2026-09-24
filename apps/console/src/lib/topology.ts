import type { ServiceName } from "@doctor-directory/shared/telemetry-events";
import type { Link } from "./traces";

export type NodeId = "caller" | "agent" | "lookup" | "trigger" | "sync" | "api" | "store";
export type EdgeId = Link | "caller-agent";

export interface Fact {
  readonly label: string;
  readonly value: string;
}

export interface NodeInfo {
  readonly title: string;
  readonly summary: string;
  readonly service?: ServiceName;
  /** One short line printed in the box. */
  readonly stack: string;
  /** The technology and the reason it was chosen. */
  readonly builtWith: ReadonlyArray<Fact>;
}

export interface EdgeInfo {
  readonly title: string;
  /** Protocol facts no API reports; settings come from the live config. */
  readonly transport: ReadonlyArray<Fact>;
}

// What no API can tell: purpose, technology choices and protocol facts. Settings, bindings,
// schedules, models and limits are fetched live (live-config.ts).
export const NODES: Record<NodeId, NodeInfo> = {
  caller: {
    title: "Caller",
    summary: "A person on the line. In this console: your browser's microphone and speaker.",
    stack: "Browser · WebRTC",
    builtWith: [
      { label: "Client", value: "@elevenlabs/react SDK in this console" },
      { label: "Media", value: "WebRTC: low-latency audio, echo cancellation in the browser" },
      { label: "Next", value: "Phone callers through a Twilio number, same agent" },
    ],
  },
  agent: {
    title: "ElevenLabs agent",
    summary:
      "Speech in, speech out: transcribes the caller, decides with an LLM, speaks the answer.",
    stack: "ElevenLabs · Claude Haiku",
    builtWith: [
      {
        label: "Platform",
        value: "ElevenLabs Agents: speech-to-text, turn-taking, LLM, text-to-speech",
      },
      { label: "Why", value: "Voice quality and sub-second turns without running speech models" },
      {
        label: "Grounding",
        value: "Answers addresses only from find_doctor results, never from memory",
      },
      {
        label: "Languages",
        value: "Switches to Czech on its own; Romanian street names are never translated",
      },
    ],
  },
  lookup: {
    title: "doctor-lookup",
    summary:
      "Answers the agent's find_doctor calls from the published Search DB. Never calls upstream.",
    service: "doctor-lookup",
    stack: "Worker · Effect HttpApi",
    builtWith: [
      {
        label: "Runtime",
        value:
          "Cloudflare Workers (V8 isolates, no containers), in the data center nearest the caller",
      },
      { label: "Language", value: "TypeScript, Effect 4" },
      { label: "API", value: "Effect HttpApi: typed contract, OpenAPI at /openapi.json" },
      {
        label: "Validation",
        value: "Effect Schema on requests and answers; addresses only in the found shape",
      },
      {
        label: "Search",
        value:
          "In-memory index: diacritic-free names, fuzzy suggestions, city and specialty snapping",
      },
      {
        label: "Answers",
        value:
          "Clinic, address, phone, hours, languages, experience, rating; lists by city and specialty, best rated first, filtered by day, hour or language",
      },
      {
        label: "Outage switch",
        value:
          "A console switch makes every lookup unavailable; each unanswered caller is logged as an escalation",
      },
      { label: "Tracing", value: "Effect spans streamed live to this console" },
    ],
  },
  trigger: {
    title: "Trigger",
    summary: "What starts a sync run: the daily cron, or someone pressing Run sync now.",
    stack: "Cron Trigger → Workflow",
    builtWith: [
      { label: "Scheduler", value: "Cloudflare Cron Trigger: no server or queue to run" },
      {
        label: "What it does",
        value: "Only starts a Workflow run and returns; the run itself has no time limit",
      },
      { label: "Manual", value: "POST /sync with a bearer token, or Run sync now here" },
    ],
  },
  sync: {
    title: "directory-sync",
    summary: "Keeps the data fresh: pulls the slow full dump, validates, deduplicates, publishes.",
    service: "directory-sync",
    stack: "Workflow · Effect 4",
    builtWith: [
      {
        label: "Runtime",
        value: "Cloudflare Workflow: durable steps on Workers, no always-on server",
      },
      {
        label: "Why a Workflow",
        value:
          "The upstream takes about 15 minutes; a cron invocation may not run longer than that, a Workflow step has no wall-clock limit",
      },
      {
        label: "Steps",
        value:
          "1 pull the dump into R2 · 2 validate and save the DB · 3 publish the Search DB; each retried on its own, so a failed publish does not repeat the pull",
      },
      { label: "Language", value: "TypeScript, Effect 4" },
      {
        label: "Pull",
        value:
          "Effect HttpClient: timeout, two retries with exponential backoff on transient errors; the raw dump is staged in R2, since step results are capped at 1 MiB",
      },
      {
        label: "Validation",
        value:
          "Effect Schema per record; keeps name, clinic, address, phone, hours, languages, experience, rating; drops e-mail; exact duplicates removed (namesakes kept)",
      },
      {
        label: "Bad dump",
        value: "A refused dump (too small, not JSON) fails the run without retrying the pull",
      },
      {
        label: "Safety",
        value: "Publishes only if enough doctors arrived; otherwise the old data stays",
      },
      {
        label: "Services",
        value: "Effect layers (Upstream, Ingest, stores) swapped for fakes in tests",
      },
    ],
  },
  api: {
    title: "directory-api",
    summary: "Stand-in for the client's upstream API: the whole dataset in one slow response.",
    service: "directory-api",
    stack: "Worker · Effect (stand-in)",
    builtWith: [
      { label: "Runtime", value: "Cloudflare Workers; the real API will be the client's" },
      { label: "Language", value: "TypeScript, Effect 4 HttpRouter" },
      {
        label: "Purpose",
        value: "Reproduces the real API: nothing for about 15 minutes, then the full JSON dump",
      },
      { label: "Data", value: "Serves healthcare_data.json from its own R2 bucket" },
    ],
  },
  store: {
    title: "R2 (EU)",
    summary: "Object storage: the validated DB and the Search DB doctor-lookup reads.",
    stack: "Cloudflare R2 · JSON",
    builtWith: [
      { label: "Storage", value: "Cloudflare R2: S3-compatible objects, no egress fees" },
      {
        label: "Why not a database",
        value: "7,029 records: two JSON objects are enough and read in one call",
      },
      {
        label: "Objects",
        value:
          "doctors.json (validated DB), search-index.json (Search DB), incoming/dump.json (the staged pull), control/flags.json (console switches)",
      },
      { label: "Access", value: "Only through Worker bindings" },
      { label: "Pricing", value: "$0.015/GB-month, $4.50/M writes, $0.36/M reads" },
    ],
  },
};

export const EDGES_INFO: Record<EdgeId, EdgeInfo> = {
  "caller-agent": {
    title: "Caller ⇄ ElevenLabs agent",
    transport: [
      { label: "Protocol", value: "WebRTC (LiveKit, run by ElevenLabs)" },
      {
        label: "Carries",
        value: "Audio both ways, plus transcript and tool events on a data channel",
      },
      { label: "Setup", value: "Browser fetches a conversation token from api.elevenlabs.io" },
      { label: "Encryption", value: "DTLS-SRTP" },
    ],
  },
  "agent-lookup": {
    title: "ElevenLabs → doctor-lookup",
    transport: [
      { label: "Protocol", value: "HTTPS over the public internet, JSON both ways" },
      { label: "From", value: "ElevenLabs servers (US) to the nearest Cloudflare data center" },
      { label: "Auth", value: "Bearer token kept as an ElevenLabs secret" },
    ],
  },
  "lookup-store": {
    title: "doctor-lookup ← R2",
    transport: [
      { label: "Protocol", value: "R2 binding inside Cloudflare's network, no public hop" },
      { label: "Reads", value: "search-index.json, kept in the Worker's memory" },
    ],
  },
  "trigger-sync": {
    title: "Trigger → directory-sync",
    transport: [
      { label: "Cron", value: "Cloudflare scheduled event creates a Workflow instance" },
      {
        label: "Manual",
        value:
          "HTTPS POST /sync creates one, GET /sync/<id> reports it; from this console via a service binding",
      },
    ],
  },
  "sync-store": {
    title: "directory-sync → R2",
    transport: [
      { label: "Protocol", value: "R2 binding inside Cloudflare's network" },
      {
        label: "Writes",
        value:
          "incoming/dump.json, then doctors.json, then search-index.json, each in its own Workflow step",
      },
    ],
  },
  "sync-upstream": {
    title: "directory-sync ⇄ directory-api",
    transport: [
      {
        label: "Protocol",
        value:
          "HTTPS GET over the public internet, one JSON array, about 15 minutes, in one Workflow step",
      },
      { label: "Tracing", value: "Trace context headers join both Workers into one trace" },
    ],
  },
};
