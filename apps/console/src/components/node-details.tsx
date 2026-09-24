import type { ServiceName } from "@doctor-directory/shared/telemetry-events";
import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import {
  useAgentConfig,
  useAgentUsage,
  useCloudflareConfig,
  useCloudflareUsage,
} from "@/hooks/use-provider-data";
import type { AgentConfig, CloudflareConfig, WorkerConfig } from "@/lib/live-config";
import type { SpanView } from "@/lib/telemetry-store";
import { EDGES_INFO, type EdgeId, type Fact, NODES, type NodeId } from "@/lib/topology";
import { formatDuration } from "@/lib/traces";
import {
  bucketListValue,
  type CallCost,
  type CallTotals,
  PRICES,
  type Script,
  workersListValue,
} from "@/lib/usage";

const DATA_BUCKET = "eu_doctor-directory-data";

const SCRIPT_OF: Partial<Record<NodeId, Script>> = {
  lookup: "doctor-lookup",
  sync: "directory-sync",
  api: "directory-api",
};

export function formatUsd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toPrecision(2)}`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

interface LiveStats {
  readonly requests: number;
  readonly errors: number;
  readonly p50?: number;
  readonly p95?: number;
}

/** Entry spans of a service (no parent in the same service) among the spans the console holds. */
export function liveStats(spans: ReadonlyMap<string, SpanView>, service: ServiceName): LiveStats {
  const durations: number[] = [];
  let requests = 0;
  let errors = 0;
  for (const span of spans.values()) {
    if (span.service !== service) continue;
    const parent = span.parentSpanId ? spans.get(span.parentSpanId) : undefined;
    if (parent && parent.service === service) continue;
    requests++;
    if (span.outcome === "error") errors++;
    if (span.end !== undefined) durations.push(span.end - span.start);
  }
  durations.sort((a, b) => a - b);
  const at = (q: number) =>
    durations.length === 0
      ? undefined
      : durations[Math.min(durations.length - 1, Math.floor(q * durations.length))];
  return { requests, errors, p50: at(0.5), p95: at(0.95) };
}

function FactTable({ facts }: { facts: ReadonlyArray<Fact> }) {
  return (
    <Table>
      <TableBody>
        {facts.map((fact) => (
          <TableRow key={fact.label}>
            <TableCell className="w-32 align-top text-xs text-muted-foreground">
              {fact.label}
            </TableCell>
            <TableCell className="text-xs whitespace-normal">{fact.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

function Unavailable({ reason, title = "No usage data" }: { reason: string; title?: string }) {
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{reason}</AlertDescription>
    </Alert>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

function callFacts(call: CallCost): Fact[] {
  return [
    { label: "When", value: new Date(call.startedAt).toLocaleString(undefined, { hour12: false }) },
    { label: "Length", value: formatDuration(call.seconds * 1000) },
    { label: "Cost", value: `${formatUsd(call.usd)} (${formatCount(call.credits)} credits)` },
    { label: "LLM", value: `${formatUsd(call.llmUsd)} · ${call.models.join(", ") || "none"}` },
    {
      label: "Tokens",
      value: `${formatCount(call.inputTokens)} in · ${formatCount(call.outputTokens)} out`,
    },
    {
      label: "Speech",
      value: `${call.ttsSeconds.toFixed(0)} s spoken (${formatCount(call.ttsCharacters)} chars) · ${call.asrSeconds.toFixed(0)} s transcribed`,
    },
    { label: "Language", value: call.language || "unknown" },
  ];
}

function totalsFacts(totals: CallTotals): Fact[] {
  return [
    { label: "Calls", value: `${totals.calls} · ${formatDuration(totals.seconds * 1000)}` },
    { label: "Cost", value: `${formatUsd(totals.usd)} (${formatCount(totals.credits)} credits)` },
    { label: "LLM", value: formatUsd(totals.llmUsd) },
    {
      label: "Tokens",
      value: `${formatCount(totals.inputTokens)} in · ${formatCount(totals.outputTokens)} out`,
    },
  ];
}

function AgentCost({ active }: { active: boolean }) {
  const usage = useAgentUsage(active);
  if (usage.error) return <Unavailable reason={usage.error} />;
  if (!usage.value) return <Loading />;
  if (!usage.value.available) return <Unavailable reason={usage.value.reason} />;
  const { last, today, month, pending } = usage.value;
  return (
    <>
      <Section title="Last finished call">
        {last ? (
          <FactTable facts={callFacts(last)} />
        ) : (
          <p className="text-xs">No call this month.</p>
        )}
      </Section>
      <Section title="Last 24 hours">
        <FactTable facts={totalsFacts(today)} />
      </Section>
      <Section title="This month (UTC)">
        <FactTable facts={totalsFacts(month)} />
      </Section>
      {pending > 0 && (
        <p className="text-xs text-muted-foreground">
          {pending} call{pending === 1 ? " is" : "s are"} running or still being processed by
          ElevenLabs; costs appear about a minute after a call ends.
        </p>
      )}
    </>
  );
}

function WorkerCost({ script, active }: { script: Script; active: boolean }) {
  const usage = useCloudflareUsage(active);
  if (usage.error) return <Unavailable reason={usage.error} />;
  if (!usage.value) return <Loading />;
  if (!usage.value.available) return <Unavailable reason={usage.value.reason} />;
  const worker = usage.value.workers[script];
  const account = usage.value.account;
  const listValue = workersListValue(worker);
  const overage =
    (Math.max(0, account.requests - PRICES.workersIncludedRequests) / 1e6) *
      PRICES.workersPerMillionRequests +
    (Math.max(0, account.cpuMs - PRICES.workersIncludedCpuMs) / 1e6) *
      PRICES.workersPerMillionCpuMs;
  return (
    <>
      <Section title={`${script}, this month (UTC)`}>
        <FactTable
          facts={[
            {
              label: "Requests",
              value: `${formatCount(worker.requests)} (${formatCount(worker.errors)} errors)`,
            },
            { label: "CPU time", value: `${formatCount(worker.cpuMs)} ms` },
            { label: "Subrequests", value: formatCount(worker.subrequests) },
            { label: "At list price", value: formatUsd(listValue) },
          ]}
        />
      </Section>
      <Section title="Whole account, this month">
        <FactTable
          facts={[
            {
              label: "Requests",
              value: `${formatCount(account.requests)} of ${formatCount(PRICES.workersIncludedRequests)} included`,
            },
            {
              label: "CPU time",
              value: `${formatCount(account.cpuMs)} of ${formatCount(PRICES.workersIncludedCpuMs)} ms included`,
            },
            {
              label: "Billed",
              value: `$${PRICES.workersPlanMonthly} plan${overage > 0 ? ` + ${formatUsd(overage)} overage` : ", no overage"}`,
            },
          ]}
        />
      </Section>
    </>
  );
}

function StoreCost({ active }: { active: boolean }) {
  const usage = useCloudflareUsage(active);
  if (usage.error) return <Unavailable reason={usage.error} />;
  if (!usage.value) return <Loading />;
  if (!usage.value.available) return <Unavailable reason={usage.value.reason} />;
  const bucket = usage.value.buckets[DATA_BUCKET] ?? { classA: 0, classB: 0, objects: 0, bytes: 0 };
  const listValue = bucketListValue(bucket);
  const all = Object.values(usage.value.buckets).reduce(
    (sum, b) => ({
      classA: sum.classA + b.classA,
      classB: sum.classB + b.classB,
      bytes: sum.bytes + b.bytes,
    }),
    { classA: 0, classB: 0, bytes: 0 },
  );
  const withinFree =
    all.bytes / 1e9 <= PRICES.r2IncludedGb &&
    all.classA <= PRICES.r2IncludedClassA &&
    all.classB <= PRICES.r2IncludedClassB;
  return (
    <Section title="doctor-directory-data, this month (UTC)">
      <FactTable
        facts={[
          {
            label: "Stored",
            value: `${formatBytes(bucket.bytes)} in ${formatCount(bucket.objects)} objects`,
          },
          { label: "Writes (A)", value: formatCount(bucket.classA) },
          { label: "Reads (B)", value: formatCount(bucket.classB) },
          { label: "At list price", value: formatUsd(listValue) },
          {
            label: "Billed",
            value: withinFree
              ? "$0: every bucket together is within R2's free tier"
              : "Account is past R2's free tier; see Cloudflare billing",
          },
        ]}
      />
    </Section>
  );
}

function workerFacts(worker: WorkerConfig): Fact[] {
  return [
    ...(worker.url ? [{ label: "URL", value: worker.url }] : []),
    ...(worker.deployed
      ? [
          {
            label: "Deployed",
            value: new Date(worker.deployed.at).toLocaleString(undefined, { hour12: false }),
          },
          { label: "Version", value: worker.deployed.version },
        ]
      : []),
    ...worker.bindings.map((b) => ({ label: b.label, value: b.value })),
    ...worker.vars.map((v) => ({ label: v.label, value: v.value })),
    ...(worker.secrets.length > 0 ? [{ label: "Secrets", value: worker.secrets.join(", ") }] : []),
    ...(worker.crons.length > 0
      ? [{ label: "Cron", value: `${worker.crons.join(", ")} (UTC)` }]
      : []),
    ...(worker.compatibility
      ? [{ label: "Runtime", value: `compatibility ${worker.compatibility}` }]
      : []),
  ];
}

function agentFacts(agent: AgentConfig): Fact[] {
  return [
    { label: "Agent", value: agent.name },
    { label: "LLM", value: `${agent.llm}, temperature ${agent.temperature}` },
    { label: "Speech to text", value: agent.asr },
    { label: "Text to speech", value: `${agent.ttsModel}, voice ${agent.voice}` },
    { label: "Languages", value: agent.languages.join(", ") },
    { label: "Tools", value: agent.tools.join(", ") },
    {
      label: "Limits",
      value: `${agent.concurrency} concurrent, ${agent.dailyLimit} a day, ${agent.maxCallSeconds} s a call`,
    },
    { label: "Webhook", value: `${agent.tool.method} ${agent.tool.url}` },
  ];
}

/** The node's live settings, or why they are missing. */
function LiveConfig({ id, active }: { id: NodeId; active: boolean }) {
  const cloudflare = useCloudflareConfig(active && id !== "agent" && id !== "caller");
  const agent = useAgentConfig(active && id === "agent");
  if (id === "caller") return null;
  if (id === "agent") {
    if (agent.error) return <Unavailable title="No live configuration" reason={agent.error} />;
    if (!agent.value) return <Loading />;
    if (!agent.value.available)
      return <Unavailable title="No live configuration" reason={agent.value.reason} />;
    return <FactTable facts={agentFacts(agent.value)} />;
  }
  if (cloudflare.error)
    return <Unavailable title="No live configuration" reason={cloudflare.error} />;
  if (!cloudflare.value) return <Loading />;
  if (!cloudflare.value.available)
    return <Unavailable title="No live configuration" reason={cloudflare.value.reason} />;
  const config = cloudflare.value;
  const script = id === "trigger" ? "directory-sync" : SCRIPT_OF[id];
  // Only refusals that affect this box; the bucket's own refusal is handled below.
  const relevant = config.denied.filter(
    (path) =>
      path.startsWith("/workers/subdomain") ||
      (script !== undefined && path.startsWith(`/workers/scripts/${script}/`)),
  );
  const denied =
    relevant.length > 0 ? (
      <Unavailable
        title="Partly unavailable"
        reason={`Cloudflare refused ${relevant.join("; ")}. The token needs Workers Scripts: Read.`}
      />
    ) : null;
  let facts: Fact[] = [];
  if (id === "store") {
    const b = config.bucket;
    const binding = config.workers["directory-sync"].bindings.find((f) => f.label === "DATA");
    facts = b
      ? [
          { label: "Bucket", value: b.name },
          { label: "Location", value: b.location },
          { label: "Jurisdiction", value: b.jurisdiction },
          { label: "Storage class", value: b.storageClass },
          {
            label: "Created",
            value: new Date(b.created).toLocaleString(undefined, { hour12: false }),
          },
        ]
      : [
          ...(binding ? [{ label: "Bucket", value: binding.value }] : []),
          {
            label: "Location, class",
            value: "Not readable with this token (R2 bucket API refused)",
          },
        ];
  } else if (id === "trigger") {
    const crons = config.workers["directory-sync"].crons;
    if (crons.length > 0) facts = [{ label: "Cron", value: `${crons.join(", ")} (UTC)` }];
  } else if (script) {
    facts = workerFacts(config.workers[script]);
  }
  return (
    <>
      {denied}
      {facts.length > 0 && <FactTable facts={facts} />}
    </>
  );
}

/** Settings on a line, read from the live config of both ends. */
function edgeLiveFacts(
  id: EdgeId,
  cloudflare: CloudflareConfig | undefined,
  agent: AgentConfig | undefined,
): Fact[] {
  const workers = cloudflare?.available ? cloudflare.workers : undefined;
  const variable = (script: Script, name: string) =>
    workers?.[script].vars.find((v) => v.label === name)?.value;
  switch (id) {
    case "agent-lookup":
      return agent
        ? [
            { label: "Request", value: `${agent.tool.method} ${agent.tool.url}` },
            { label: "Headers", value: agent.tool.headers.join(", ") },
            {
              label: "Timeout",
              value: `${agent.tool.timeoutSeconds} s${agent.fillerAfterSeconds ? `; filler after ${agent.fillerAfterSeconds} s` : ""}`,
            },
          ]
        : [];
    case "lookup-store": {
      const reload = variable("doctor-lookup", "RELOAD_INTERVAL");
      return reload
        ? [{ label: "Re-check", value: `every ${reload} at most, per Worker instance` }]
        : [];
    }
    case "trigger-sync": {
      const crons = workers?.["directory-sync"].crons ?? [];
      return crons.length > 0 ? [{ label: "Schedule", value: `${crons.join(", ")} (UTC)` }] : [];
    }
    case "sync-store": {
      const data = workers?.["directory-sync"].bindings.find((b) => b.label === "DATA");
      return data ? [{ label: "Binding", value: `DATA → ${data.value}` }] : [];
    }
    case "sync-upstream": {
      const facts: Fact[] = [];
      const timeout = variable("directory-sync", "SYNC_TIMEOUT");
      const delay = variable("directory-api", "DIRECTORY_DELAY");
      if (workers?.["directory-sync"].secrets.includes("SOURCE_URL")) {
        facts.push({ label: "URL", value: "secret SOURCE_URL" });
      }
      if (timeout) facts.push({ label: "Gives up after", value: timeout });
      if (delay) facts.push({ label: "Demo delay", value: delay });
      return facts;
    }
    case "caller-agent":
      return [];
  }
}

export function NodeSheet({
  id,
  spans,
  onOpenChange,
}: {
  id: NodeId | undefined;
  spans: ReadonlyMap<string, SpanView>;
  onOpenChange: (open: boolean) => void;
}) {
  const node = id ? NODES[id] : undefined;
  const open = id !== undefined;
  const live = node?.service ? liveStats(spans, node.service) : undefined;
  const script = id ? SCRIPT_OF[id] : undefined;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[28rem] sm:max-w-[28rem]">
        {node && id && (
          <>
            <SheetHeader>
              <SheetTitle>{node.title}</SheetTitle>
              <SheetDescription>{node.summary}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-5 overflow-y-auto px-4 pb-6">
              <Section title="Built with">
                <FactTable facts={node.builtWith} />
              </Section>
              {id !== "caller" && (
                <Section title="Live configuration">
                  <LiveConfig id={id} active={open} />
                </Section>
              )}
              {live && (
                <Section title="Live, from the spans this console holds">
                  <FactTable
                    facts={[
                      { label: "Requests", value: `${live.requests} (${live.errors} errors)` },
                      {
                        label: "Latency",
                        value:
                          live.p50 === undefined
                            ? "none finished yet"
                            : `p50 ${formatDuration(live.p50)} · p95 ${formatDuration(live.p95 ?? live.p50)}`,
                      },
                    ]}
                  />
                </Section>
              )}
              <Separator />
              <div className="flex items-center gap-2">
                <h3 className="font-heading text-sm font-medium">Usage and cost</h3>
                <Badge variant="outline">live from the provider</Badge>
              </div>
              {id === "agent" && <AgentCost active={open} />}
              {script && <WorkerCost script={script} active={open} />}
              {id === "store" && <StoreCost active={open} />}
              {(id === "caller" || id === "trigger") && (
                <p className="text-xs text-muted-foreground">
                  {id === "caller"
                    ? "Nothing on our side; the call's cost is billed to the agent."
                    : "Cron triggers cost nothing; the run is billed as directory-sync requests and CPU time."}
                </p>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Shown while the pointer is on a box. */
export function NodeHover({ id, spans }: { id: NodeId; spans: ReadonlyMap<string, SpanView> }) {
  const node = NODES[id];
  const live = node.service ? liveStats(spans, node.service) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{node.title}</span>
        <span className="text-xs text-muted-foreground">{node.summary}</span>
      </div>
      <span className="text-xs">{node.stack}</span>
      {live && (
        <span className="text-xs">
          {live.requests} requests seen · {live.errors} errors
          {live.p50 !== undefined ? ` · p50 ${formatDuration(live.p50)}` : ""}
        </span>
      )}
      {id === "agent" && <AgentHoverUsage />}
      <span className="text-xs text-muted-foreground">Click for hosting, usage and cost.</span>
    </div>
  );
}

function AgentHoverUsage() {
  const usage = useAgentUsage(true);
  if (usage.error) return <span className="text-xs text-destructive">{usage.error}</span>;
  if (!usage.value) return <Skeleton className="h-10 w-full" />;
  if (!usage.value.available) return <span className="text-xs">{usage.value.reason}</span>;
  const { last, month } = usage.value;
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted px-2 py-1.5 text-xs">
      {last ? (
        <>
          <span className="font-medium">Last call · {formatDuration(last.seconds * 1000)}</span>
          <span>
            {formatCount(last.inputTokens)} tokens in · {formatCount(last.outputTokens)} out ·{" "}
            {last.models.join(", ")}
          </span>
          <span>
            {formatUsd(last.usd)} total · {formatUsd(last.llmUsd)} LLM · {formatCount(last.credits)}{" "}
            credits
          </span>
        </>
      ) : (
        <span>No finished call this month.</span>
      )}
      <span className="text-muted-foreground">
        This month: {month.calls} calls · {formatCount(month.inputTokens + month.outputTokens)}{" "}
        tokens · {formatUsd(month.usd)}
      </span>
    </div>
  );
}

/** Shown while the pointer is on a line. */
export function EdgeHover({ id }: { id: EdgeId }) {
  const edge = EDGES_INFO[id];
  const cloudflare = useCloudflareConfig(true);
  const agent = useAgentConfig(id === "agent-lookup");
  const facts = [
    ...edge.transport,
    ...edgeLiveFacts(id, cloudflare.value, agent.value?.available ? agent.value : undefined),
  ];
  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium">{edge.title}</span>
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
        {facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
