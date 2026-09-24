# Doctor directory voice agent

A phone-style voice agent that tells callers where a doctor practices, how to reach them and when they work, answered from a directory that is refreshed from a slow upstream API.

## TL;DR

- **What it does:** a caller asks, in English or Czech, for a doctor by name, or for "an oncologist in Bucharest available next Monday at 5 pm". The agent answers with clinic, address (street names in Romanian), phone, hours, languages, experience and rating, read from a verified lookup, never from the model's memory.
- **Two halves:** *serving callers* (ElevenLabs agent → `doctor-lookup` Worker → Search DB) and *keeping data fresh* (a Cloudflare **Workflow** pulls the ~15-minute full dump, validates and deduplicates it, publishes the Search DB).
- **Stack:** TypeScript and **Effect 4** in a **Bun** monorepo on **Cloudflare** (Workers, Workflows, R2, Durable Objects, Cron Triggers); voice by **ElevenLabs Agents** with Claude Haiku 4.5. No servers, no containers.
- **Observable:** every Worker streams Effect spans and logs live to a Durable Object; a console shows a service map, traces, logs, escalations, call history, per-service cost and live provider configuration.
- **Cost today:** ElevenLabs about $0.10–0.20 per 1–2 minute call; Cloudflare usage fits in the $5/month Workers plan with room for millions of lookups.
- **Main risks:** the console is public by choice, the upstream only offers full dumps without stable IDs, voice recordings are kept indefinitely by ElevenLabs, and some agent behavior is enforced by prompt rather than code. See [Risks](#risks).

Live: [console](https://doctor-console.it-c89.workers.dev) · [talk to the agent](https://elevenlabs.io/app/talk-to?agent_id=agent_4201m39wmxxvf76snhp94gwajr7c)

## Architecture

The original sketch ([docs/architecture-sketch.png](docs/architecture-sketch.png)) as it is built now. Names from the sketch are kept in each box.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/architecture-dark.svg">
  <img alt="Architecture: the caller talks to the ElevenLabs agent, which calls doctor-lookup; doctor-lookup reads the Search DB in R2; a Cloudflare Workflow pulls the upstream API, validates and deduplicates into the DB, and publishes the Search DB." src="docs/diagrams/architecture-light.svg">
</picture>

Every Worker also reports to the observability side:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/observability-dark.svg">
  <img alt="Observability: doctor-lookup, directory-sync and directory-api stream spans and logs to the telemetry hub, a Durable Object, which pushes them to the console over WebSocket." src="docs/diagrams/observability-light.svg">
</picture>

The diagrams are generated: edit `docs/diagrams/render.ts`, then `bun run docs:diagrams`.

| Sketch | Built as | Where |
|---|---|---|
| User | Browser via the console (WebRTC); a Twilio number is the next step | `apps/console` |
| Voice service | ElevenLabs Agents: Scribe realtime speech-to-text, Flash v2 text-to-speech, turn-taking | ElevenLabs |
| Agent · Prompt/Skills | System prompt and the `find_doctor` webhook tool, versioned in the repo and pushed via API | `apps/doctor-lookup/agent` |
| Agent · Context | Claude Haiku 4.5, temperature 0; the conversation is the context | ElevenLabs |
| Search DB | `search-index.json` in R2, loaded into each `doctor-lookup` instance | `packages/shared/src/search-index.ts` |
| API | The client's directory API; `directory-api` reproduces it (nothing for 15 minutes, then the full JSON) | `apps/directory-api` |
| Schema validation, Deduplication | Workflow step 2: Effect Schema per record, exact duplicates dropped | `apps/directory-sync/src/ingest.ts` |
| DB | `doctors.json` in R2, the last good pull | `apps/directory-sync` |
| Data processor | Workflow step 3: normalized names, cities, counties, specialties | `packages/shared/src/search-index.ts` |
| *(new)* Observability | Telemetry hub (Durable Object) and the console | `apps/telemetry`, `apps/console` |

## Technology

| Choice | Why |
|---|---|
| **Cloudflare Workers** | No servers to run; `doctor-lookup` answers from the data center nearest the caller; scales per request. |
| **Cloudflare Workflows** for the sync | The upstream needs ~15 minutes to answer. A Cron Trigger invocation may not run longer than 15 minutes; a Workflow step has no wall-clock limit, and each step retries on its own, so a failed publish does not repeat the pull. Verified: a run took 15 min 5 s and completed. |
| **R2 (EU jurisdiction)** | 7,029 records are two JSON objects: no database needed. EU jurisdiction keeps the data in the EU; no egress fees. |
| **Durable Object** for telemetry | One live hub with SQLite: stores the recent 5,000 events and pushes them to the console over WebSocket. |
| **Effect 4** | Typed services and layers (fakes in tests), Schema validation at every boundary, HttpApi with an OpenAPI contract, retries and timeouts, and native tracing that joins Workers into one trace. |
| **ElevenLabs Agents** | Speech quality and sub-second turns without running speech models; built-in language detection (English ⇄ Czech) and tool calling. |
| **Claude Haiku 4.5** | Fast and cheap enough for voice turns; temperature 0. |
| **TanStack Start + shadcn (Base UI)** | The console: server functions for provider APIs, React UI, deployed as a Worker. |
| **Bun workspaces, Biome, tsc** | One lockfile, one lint/format config, strict types across all apps. |

## How it works

**A call.** The caller talks to the ElevenLabs agent. When it has a name, or a city and specialty, it calls `find_doctor` (HTTPS, bearer token, `X-Conversation-Id` header). `doctor-lookup` answers from its in-memory index:

- `found`: clinic, address, phone, hours, languages, experience, rating; the only shape that carries contact details.
- `list`: doctors of a specialty in a city, best rated first, optionally filtered by weekday, hour and language.
- `ambiguous`, `not_found` (with "did you mean"), `invalid_request`, `unavailable`: each tells the agent exactly what to ask or say.

The prompt forbids the agent from answering existence questions or addresses from its own knowledge; addresses come only from a `found` result.

**A sync.** The cron (or the console) starts a Workflow instance: pull the dump into `incoming/dump.json`, validate and deduplicate into `doctors.json` (refused if it has fewer than 90% of the previous doctor count, or is not JSON), then build and publish `search-index.json`. `doctor-lookup` instances check for a new version at most every 10 seconds and swap it in without a redeploy.

**Observability.** Each Worker reports span starts, span ends and logs to the telemetry hub while it runs, so a 15-minute pull is visible as it happens. Trace context propagates over HTTP, so the sync and the upstream appear in one trace; tool calls carry the ElevenLabs conversation id.

## Operating it

The [console](https://doctor-console.it-c89.workers.dev) shows:

- **Service map:** live flow per edge, each box with its stack, status and cost this month; hover for protocol details, click for hosting, live configuration (from the Cloudflare and ElevenLabs APIs) and usage.
- **Traces and logs:** waterfall per request or sync run; logs filtered by service, level and text.
- **Voice panel:** call the agent from the browser; **History** lists every call with ElevenLabs' summary, cost, tokens and transcript, linked to backend traces.
- **Escalations:** when the data cannot be read, the agent tells the caller it cannot answer now, that the problem was escalated, and to call back; `doctor-lookup` logs an error with the conversation id and the query. The header counts them; the traces list and map highlight them.
- **Simulate outage:** a switch that makes every lookup unavailable, to rehearse escalations.
- **Run sync now:** starts the same Workflow as the cron.

## Risks

| Risk | Impact | Mitigation / next step |
|---|---|---|
| **Console is public** (decided for the demo) | Anyone with the URL sees callers' queries and conversation ids, can switch on the outage simulation and start syncs. | Put it behind Cloudflare Access before real callers. |
| **Upstream offers only full dumps, no stable IDs** | Every sync moves the whole dataset (~15 min); deduplication can only drop exact copies; namesakes stay separate (the sample has 616 e-mails shared by 1,285 records). | Ask the client for an incremental "changed since" endpoint and stable IDs. |
| **Voice data retention** | ElevenLabs records calls and keeps conversations indefinitely (retention −1); audio is processed outside the EU even though the directory is in EU R2. | Set a retention period, decide on recording, sign a DPA; the console deliberately does not expose recordings. |
| **Prompt-enforced behavior** | Some rules (no guessing, language switching, not offering transfers) depend on the model following the prompt; it once reasoned about a city on its own. | Rules that matter are also in code: addresses and phones only exist in `found` results; lists are capped at 3 names. Keep regression calls as tests. |
| **Personal data in answers** | Phone numbers, hours and ratings are read out to anyone who calls. | Confirm with the client which fields may be disclosed; the schema drops e-mail. |
| **Single vendors** | ElevenLabs and Cloudflare outages stop calls or lookups. | Lookups degrade to an escalation; a second voice provider would be a larger change. |
| **Index format changes** | A new Search DB format is unreadable by older `doctor-lookup` instances until they are redeployed. | Deploy the sync, run it, deploy the lookup right after. A format version makes older instances refuse the new file and keep serving the one they have. |
| **Agent limits** | 3 concurrent calls, 50 calls a day, 300 s per call. | Raise in ElevenLabs when real traffic starts. |
| **Time zone** | The agent resolves "tomorrow" from UTC; around midnight Romanian time it can pick the wrong weekday. | Set the agent time zone to Europe/Bucharest. |
| **Short-lived API key** | The console's ElevenLabs key expires after 7 days; call history, cost and configuration panels stop until it is replaced. | Replace it with a long-lived, read-only key. |
| **Telemetry retention** | The hub keeps the latest 5,000 events; older traces are gone (Cloudflare Workers Logs keep their own copy). | Export to a long-term store (e.g. OTLP) if audits need it. |

## Scaling

- **More callers.** Lookups are CPU-light (about 33 ms of CPU per request, measured in production) and Workers scale per request across data centers; the Workers plan includes 10 M requests a month. The limit is the ElevenLabs agent's concurrency, a plan setting.
- **Phone lines and languages.** Attach Twilio numbers to the same agent; add language presets. Street names stay Romanian by rule.
- **Bigger directories.** See [How far in-memory search goes](#how-far-in-memory-search-goes) below.
- **Bigger or slower dumps.** Workflow steps have no wall-clock limit; CPU per step can be raised to 5 minutes. With a streaming parser and staged chunks the pull scales past what one step holds in memory; an incremental upstream API removes the full pull altogether.
- **More sources or clinic networks.** One Workflow per source (parallel steps), one Search DB per network, the same lookup code.
- **Observability.** One Durable Object handles this traffic easily; at higher volume shard the hub by service or day, or export spans to an OTLP backend.

### How far in-memory search goes

Each `doctor-lookup` instance holds the whole Search DB in memory. Measured on the sample data: **347 bytes per doctor** serialized and **~380 bytes per doctor** in the heap. A Worker has 128 MB, so one instance tops out around **260,000 doctors**, and a new instance would first parse ~90 MB. Comfortable up to roughly 100–200 thousand: a whole country (Romania has ~60,000 doctors).

For scale: WHO counts about 13 million physicians worldwide, so realistic targets are a country, the EU (~2 M) or the world (~13 M). A billion is useful as a test of the design.

What keeps it scalable at any size: callers never scan the directory. Every question is narrow (a surname, usually a city, maybe a specialty, day or language), so each lookup can read a small slice instead of holding everything.

| Scale | Lookup | Ingest |
|---|---|---|
| **up to ~200 k** (today, one country) | Whole index in memory; no change | Full daily dump, as now |
| **~200 k – ~20 M** (EU, world) | Search DB sharded by city in R2; a lookup loads only the shards it needs (kilobytes to a few MB) and keeps recent ones in memory; a surname-keyed index covers cross-city name lookups | Full dump processed in parallel chunks |
| **~1 B** | Distributed key-value or wide-column store (Cassandra/ScyllaDB, DynamoDB or Workers KV) with precomputed answers: `phonetic(surname)#city → ids`, `city#specialty → ids by rating with working days`, `id → record`. Each lookup is a few point reads of ~10 ms, never a scan. "Did you mean" from precomputed phonetic keys, or a search engine (e.g. OpenSearch) for that path only | A daily full dump is impossible (~450 GB in one response): the upstream must send changes since a timestamp with **stable IDs**, or bulk-export files to object storage for parallel processing |

What else changes at a billion:

- **Deduplication** needs stable IDs or probabilistic record matching; dropping exact copies is no longer enough.
- **Publishing** can no longer swap one file atomically; each shard is versioned and switched on its own.
- **Conversations:** name collisions multiply, so the agent must collect city (and specialty or clinic) before looking up. The lookup already returns `ask_for` with the next field to ask, and lists stay capped at three names.
- **Cost** moves from serving to ingesting: reads stay cheap (Workers KV about $0.50 per million), keeping a billion records current is the expense.

The agent and the `find_doctor` contract stay the same at every tier; only the data layer behind `doctor-lookup` and the sync change.

## Cost

Measured this month in the console (live numbers are in its header):

- **ElevenLabs:** about $0.10–0.20 per call of 1–2 minutes (voice minutes plus LLM tokens, e.g. 46,724 tokens in and 655 out for a 99-second call).
- **Cloudflare:** Workers Paid plan $5/month, shared by all Workers on the account. This project's usage is a fraction of a cent at list price (e.g. `doctor-lookup` 466 requests and 15.5 CPU-seconds); R2 stays in the free tier.

## Repository

```
apps/
  doctor-lookup/    find_doctor API (Effect HttpApi), outage switch; agent/ holds the prompt and tool definition
  directory-sync/   the sync Workflow: pull, validate + deduplicate, publish
  directory-api/    stand-in for the client's slow upstream API
  telemetry/        Durable Object hub for live spans and logs
  console/          operations console (TanStack Start, shadcn)
packages/shared/    doctor schema, search index, telemetry, R2 and auth helpers
dev/gateway/        local-only router for running several Workers together
docs/               the original architecture sketch
```

## Development

Requirements: Bun, a Cloudflare account (Workers Paid for Workflows), an ElevenLabs account. Place the dataset at `healthcare_data.json` in the repo root (not committed).

```sh
bun install
for f in apps/*/.dev.vars.example; do cp "$f" "${f%.example}"; done
bun run seed:local            # upload the dataset to the local R2 of directory-api
bun run dev                   # gateway on :3000 (lookup, /sync, /telemetry/*), directory-api on :4000
bun run sync:now              # start a sync Workflow locally
bun run --filter @doctor-directory/console dev
bun run check                 # Biome and TypeScript
bun test
```

Deploy order: `telemetry` first (the others bind to it), then `directory-api`, `directory-sync`, `doctor-lookup`, `console`. Secrets are set with `wrangler secret put` (`TOOL_TOKEN`, `SYNC_TOKEN`, `SOURCE_URL`, and for the console `SYNC_TOKEN`, `CF_ANALYTICS_TOKEN`, `ELEVENLABS_API_KEY`).
