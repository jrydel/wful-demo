import type { ServiceName } from "@doctor-directory/shared/telemetry-events";
import { cn } from "cn";
import { useState } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNow } from "@/hooks/use-now";
import { useAgentUsage, useCloudflareUsage } from "@/hooks/use-provider-data";
import type { LookupHealth } from "@/lib/server-fns";
import { SERVICE_FILL } from "@/lib/services";
import type { SpanView } from "@/lib/telemetry-store";
import { type EdgeId, NODES, type NodeId } from "@/lib/topology";
import { formatAgo, formatDuration, isRunning, type Link, linkOf, plural } from "@/lib/traces";
import { bucketListValue, workersListValue } from "@/lib/usage";
import { CostSummary } from "./cost-summary";
import { EdgeHover, NodeHover, NodeSheet } from "./node-details";
import type { VoiceActivity } from "./voice-panel";

/** How long an edge stays lit after its last span ended. */
const AFTERGLOW_MS = 1500;

// Node width plus gap must leave room for the edge labels between columns.
const COLUMN = [100, 365, 630, 895] as const;
const LANE = [48, 140, 250] as const;
const NODE = { width: 180, height: 74 } as const;

type Point = readonly [number, number];

interface EdgeSpec {
  readonly from: Point;
  readonly to: Point;
  readonly label: string;
  readonly labelAt: Point;
  /** Where the data moves: along the arrow, or back against it (reads, downloads). */
  readonly flow: "forward" | "backward";
  readonly service?: ServiceName;
}

const EDGES: Record<Link | "caller-agent", EdgeSpec> = {
  "caller-agent": {
    from: [COLUMN[0] + NODE.width / 2, LANE[0]],
    to: [COLUMN[1] - NODE.width / 2, LANE[0]],
    label: "voice",
    labelAt: [(COLUMN[0] + COLUMN[1]) / 2, LANE[0] - 8],
    flow: "forward",
  },
  "agent-lookup": {
    from: [COLUMN[1] + NODE.width / 2, LANE[0]],
    to: [COLUMN[2] - NODE.width / 2, LANE[0]],
    label: "find_doctor",
    labelAt: [(COLUMN[1] + COLUMN[2]) / 2, LANE[0] - 8],
    flow: "forward",
    service: "doctor-lookup",
  },
  "lookup-store": {
    from: [COLUMN[2] + NODE.width / 2, LANE[0]],
    to: [COLUMN[3] - NODE.width / 2, LANE[0]],
    label: "read",
    labelAt: [(COLUMN[2] + COLUMN[3]) / 2, LANE[0] - 8],
    flow: "backward",
    service: "doctor-lookup",
  },
  "trigger-sync": {
    from: [COLUMN[0] + NODE.width / 2, LANE[1]],
    to: [COLUMN[2] - NODE.width / 2, LANE[1]],
    label: "start run",
    labelAt: [(COLUMN[0] + COLUMN[2]) / 2 - 60, LANE[1] - 8],
    flow: "forward",
    service: "directory-sync",
  },
  "sync-store": {
    from: [COLUMN[2] + NODE.width / 2, LANE[1]],
    to: [COLUMN[3] - NODE.width / 2, LANE[1]],
    label: "publish",
    labelAt: [(COLUMN[2] + COLUMN[3]) / 2, LANE[1] - 8],
    flow: "forward",
    service: "directory-sync",
  },
  "sync-upstream": {
    from: [COLUMN[2], LANE[1] + NODE.height / 2],
    to: [COLUMN[2], LANE[2] - NODE.height / 2],
    label: "GET /doctors (full dump)",
    labelAt: [COLUMN[2] + 12, (LANE[1] + LANE[2]) / 2 + 4],
    flow: "backward",
    service: "directory-api",
  },
};

type Target = { kind: "node"; id: NodeId } | { kind: "edge"; id: EdgeId };

interface Hover {
  readonly target: Target;
  /** Viewport position of the hovered element, for the fixed-position card. */
  readonly rect: DOMRect;
}

interface Interaction {
  readonly onHover: (hover: Hover | undefined) => void;
  readonly onOpen: (id: NodeId) => void;
}

/** Props that make an SVG group behave like a button with a hover card. */
interface Bindings {
  readonly role: "button";
  readonly tabIndex: 0;
  readonly "aria-label": string;
  readonly className: string;
  readonly onMouseEnter: (event: React.MouseEvent<SVGGElement>) => void;
  readonly onMouseLeave: () => void;
  readonly onFocus: (event: React.FocusEvent<SVGGElement>) => void;
  readonly onBlur: () => void;
  readonly onClick: () => void;
  readonly onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => void;
}

/** Pointer and keyboard handlers for one box or line of the map. */
function interactive(target: Target, label: string, { onHover, onOpen }: Interaction): Bindings {
  const show = (element: Element) => onHover({ target, rect: element.getBoundingClientRect() });
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    className: "cursor-pointer outline-none",
    onMouseEnter: (event: React.MouseEvent<SVGGElement>) => show(event.currentTarget),
    onMouseLeave: () => onHover(undefined),
    onFocus: (event: React.FocusEvent<SVGGElement>) => show(event.currentTarget),
    onBlur: () => onHover(undefined),
    onClick: () => target.kind === "node" && onOpen(target.id),
    onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => {
      if (target.kind === "node" && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        onOpen(target.id);
      }
    },
  };
}

interface Snapshot {
  readonly active: ReadonlySet<Link>;
  readonly lookups: number;
  readonly lookupErrors: number;
  /** Lookups that answered "unavailable": callers who got no answer. */
  readonly lookupEscalations: number;
  readonly lastLookup: SpanView | undefined;
  readonly lastRun: SpanView | undefined;
  readonly lastPull: SpanView | undefined;
}

function snapshot(spans: Iterable<SpanView>, now: number): Snapshot {
  const active = new Set<Link>();
  let lookups = 0;
  let lookupErrors = 0;
  let lookupEscalations = 0;
  let lastLookup: SpanView | undefined;
  let lastRun: SpanView | undefined;
  let lastPull: SpanView | undefined;
  for (const span of spans) {
    const link = linkOf(span);
    if (
      link &&
      (isRunning(span, now) || (span.end !== undefined && now - span.end < AFTERGLOW_MS))
    ) {
      active.add(link);
    }
    if (span.name === "DoctorDirectory.find") {
      lookups++;
      if (span.outcome === "error") lookupErrors++;
      if (span.attributes["doctor.escalated"] === true) lookupEscalations++;
      if (!lastLookup || span.start > lastLookup.start) lastLookup = span;
    }
    if (span.name === "DirectorySync.run") {
      if (!lastRun || span.start > lastRun.start) lastRun = span;
      if (now - span.start < AFTERGLOW_MS * 2) active.add("trigger-sync");
    }
    if (span.service === "directory-api" && span.name === "http.server GET") {
      if (!lastPull || span.start > lastPull.start) lastPull = span;
    }
  }
  return { active, lookups, lookupErrors, lookupEscalations, lastLookup, lastRun, lastPull };
}

export function ServiceMap({
  spans,
  version,
  voice,
  health,
}: {
  spans: ReadonlyMap<string, SpanView>;
  /** Telemetry snapshot version; spans is mutated in place. */
  version: number;
  voice: VoiceActivity;
  health: LookupHealth | undefined;
}) {
  const now = useNow(250);
  const state = snapshot(spans.values(), now);
  const prices = usePrices();
  const [hover, setHover] = useState<Hover>();
  const [opened, setOpened] = useState<NodeId>();
  const interaction: Interaction = {
    onHover: setHover,
    onOpen: (id) => {
      setHover(undefined);
      setOpened(id);
    },
  };
  const bind = (target: Target, label: string) => interactive(target, label, interaction);
  const inCall = voice.status === "connected";

  const syncDetail = (() => {
    const run = state.lastRun;
    if (!run) return "no run seen yet";
    if (isRunning(run, now)) return `running · ${formatDuration(now - run.start)}`;
    if (run.end === undefined) return "last run lost its end";
    return `last run ${run.outcome ?? "ok"} · ${formatAgo(now - run.end)}`;
  })();
  const pullDetail = (() => {
    const pull = state.lastPull;
    if (!pull) return "slow full dump";
    if (isRunning(pull, now)) return `dump in progress · ${formatDuration(now - pull.start)}`;
    return pull.end === undefined
      ? "slow full dump"
      : `last dump took ${formatDuration(pull.end - pull.start)}`;
  })();

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Services</CardTitle>
        <CardDescription>
          Top: serving callers. Bottom: keeping the data fresh. Hover or click anything.
        </CardDescription>
        <CardAction>
          <CostSummary />
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)_16rem] gap-4">
        {/* biome-ignore lint/a11y/useSemanticElements: an SVG of interactive shapes cannot be a fieldset. */}
        <svg
          viewBox="0 0 1000 292"
          className="h-auto w-full self-center"
          role="group"
          aria-label="Service map"
          data-version={version}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
            </marker>
          </defs>
          <Edge
            spec={EDGES["caller-agent"]}
            active={inCall}
            bind={bind({ kind: "edge", id: "caller-agent" }, "Caller to agent")}
          />
          {(Object.keys(EDGES) as (Link | "caller-agent")[])
            .filter((link): link is Link => link !== "caller-agent")
            .map((link) => (
              <Edge
                key={link}
                spec={EDGES[link]}
                bind={bind({ kind: "edge", id: link }, EDGES[link].label)}
                active={
                  state.active.has(link) || (link === "agent-lookup" && voice.pendingTools > 0)
                }
              />
            ))}
          <Node
            at={[COLUMN[0], LANE[0]]}
            title="Caller"
            price={prices.caller}
            stack={NODES.caller.stack}
            bind={bind({ kind: "node", id: "caller" }, "Caller")}
            detail={inCall ? `in call · ${voice.mode}` : "this browser's mic"}
            active={inCall}
          />
          <Node
            at={[COLUMN[1], LANE[0]]}
            title="ElevenLabs agent"
            price={prices.agent}
            stack={NODES.agent.stack}
            bind={bind({ kind: "node", id: "agent" }, "ElevenLabs agent")}
            detail={
              voice.pendingTools > 0 ? "waiting for find_doctor" : inCall ? "in call" : "idle"
            }
            active={inCall}
          />
          <Node
            at={[COLUMN[2], LANE[0]]}
            title="doctor-lookup"
            stack={NODES.lookup.stack}
            bind={bind({ kind: "node", id: "lookup" }, "doctor-lookup")}
            service="doctor-lookup"
            price={prices.lookup}
            detail={[
              plural(state.lookups, "lookup"),
              state.lookupEscalations > 0
                ? `${state.lookupEscalations} escalated`
                : state.lastLookup?.end !== undefined
                  ? `last ${formatDuration(state.lastLookup.end - state.lastLookup.start)}`
                  : "",
            ]
              .filter(Boolean)
              .join(" · ")}
            active={state.active.has("agent-lookup")}
            failed={state.lookupErrors > 0 || state.lookupEscalations > 0}
          />
          <Node
            at={[COLUMN[0], LANE[1]]}
            title="Trigger"
            price={prices.trigger}
            stack={NODES.trigger.stack}
            bind={bind({ kind: "node", id: "trigger" }, "Trigger")}
            detail={
              typeof state.lastRun?.attributes["sync.trigger"] === "string"
                ? `last: ${state.lastRun.attributes["sync.trigger"]} · ${formatAgo(now - state.lastRun.start)}`
                : "cron 03:00 UTC · manual"
            }
            active={state.active.has("trigger-sync")}
          />
          <Node
            at={[COLUMN[2], LANE[1]]}
            title="directory-sync"
            price={prices.sync}
            stack={NODES.sync.stack}
            bind={bind({ kind: "node", id: "sync" }, "directory-sync")}
            service="directory-sync"
            detail={syncDetail}
            active={state.lastRun !== undefined && isRunning(state.lastRun, now)}
            failed={state.lastRun?.outcome === "error"}
          />
          <Node
            at={[COLUMN[2], LANE[2]]}
            title="directory-api"
            price={prices.api}
            stack={NODES.api.stack}
            bind={bind({ kind: "node", id: "api" }, "directory-api")}
            service="directory-api"
            detail={pullDetail}
            active={state.active.has("sync-upstream")}
          />
          <Store
            at={[COLUMN[3], (LANE[0] + LANE[1]) / 2]}
            health={health}
            price={prices.store}
            bind={bind({ kind: "node", id: "store" }, "R2 storage")}
            active={state.active.has("lookup-store") || state.active.has("sync-store")}
          />
        </svg>
        <Legend />
        {hover && <HoverCard hover={hover} spans={spans} />}
        <NodeSheet
          id={opened}
          spans={spans}
          onOpenChange={(open) => !open && setOpened(undefined)}
        />
      </CardContent>
    </Card>
  );
}

function Edge({ spec, active, bind }: { spec: EdgeSpec; active: boolean; bind: Bindings }) {
  const [x1, y1] = spec.from;
  const [x2, y2] = spec.to;
  const path = `M ${x1} ${y1} L ${x2} ${y2}`;
  const particlePath = spec.flow === "forward" ? path : `M ${x2} ${y2} L ${x1} ${y1}`;
  return (
    <g {...bind}>
      {/* Wide invisible stroke: covers the line and the gap up to its label. */}
      <path d={path} stroke="transparent" strokeWidth={24} fill="none" />
      <path
        d={path}
        className={cn("fill-none", active ? "stroke-foreground/70" : "stroke-border")}
        strokeWidth={active ? 2 : 1.5}
        markerEnd="url(#arrow)"
      />
      <text
        x={spec.labelAt[0]}
        y={spec.labelAt[1]}
        textAnchor={spec.labelAt[0] > x1 && x1 === x2 ? "start" : "middle"}
        className={cn("text-[11px]", active ? "fill-foreground" : "fill-muted-foreground")}
      >
        {spec.label}
      </text>
      {active &&
        [0, 1, 2].map((index) => (
          <circle
            key={index}
            r={4}
            className={spec.service ? SERVICE_FILL[spec.service] : "fill-foreground"}
          >
            <animateMotion
              dur="1.2s"
              begin={`${index * 0.4}s`}
              repeatCount="indefinite"
              path={particlePath}
            />
          </circle>
        ))}
    </g>
  );
}

function Node({
  at,
  title,
  detail,
  price,
  stack,
  service,
  active,
  failed = false,
  bind,
}: {
  bind: Bindings;
  at: Point;
  title: string;
  detail: string;
  /** This month's cost, shown top right. */
  price?: string;
  stack: string;
  service?: ServiceName;
  active: boolean;
  failed?: boolean;
}) {
  return (
    <g {...bind} transform={`translate(${at[0] - NODE.width / 2} ${at[1] - NODE.height / 2})`}>
      <rect
        width={NODE.width}
        height={NODE.height}
        rx={10}
        className={cn(
          "fill-card",
          failed ? "stroke-destructive" : active ? "stroke-foreground/60" : "stroke-border",
        )}
        strokeWidth={1.5}
      />
      {service && (
        <rect
          x={8}
          y={12}
          width={3}
          height={NODE.height - 24}
          rx={1.5}
          className={SERVICE_FILL[service]}
        />
      )}
      <text x={20} y={23} className="fill-foreground text-[13px] font-medium">
        {title}
      </text>
      <text x={20} y={41} className="fill-foreground/75 font-mono text-[10px]">
        {stack}
      </text>
      <text x={20} y={59} className="fill-muted-foreground text-[11px]">
        {detail}
      </text>
      {price && (
        <text
          x={NODE.width - 10}
          y={20}
          textAnchor="end"
          className="fill-foreground/80 text-[11px] tabular-nums"
        >
          {price}
        </text>
      )}
      {active && (
        <circle cx={NODE.width - 14} cy={NODE.height - 14} r={4} className="fill-success">
          <animate attributeName="opacity" values="1;0.25;1" dur="1.2s" repeatCount="indefinite" />
        </circle>
      )}
    </g>
  );
}

function Store({
  at,
  health,
  active,
  bind,
  price,
}: {
  bind: Bindings;
  price?: string;
  at: Point;
  health: LookupHealth | undefined;
  active: boolean;
}) {
  const height = LANE[1] - LANE[0] + NODE.height;
  const lines = !health
    ? ["checking…"]
    : health.ready
      ? [
          `${health.doctors.toLocaleString("en")} doctors`,
          `as of ${new Date(health.as_of).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short", hour12: false })}`,
          health.stale ? "stale: last sync is old" : "fresh",
        ]
      : ["not ready", health.message];
  return (
    <g {...bind} transform={`translate(${at[0] - NODE.width / 2} ${at[1] - height / 2})`}>
      <rect
        width={NODE.width}
        height={height}
        rx={10}
        className={cn(
          "fill-card",
          health && (!health.ready || health.stale)
            ? "stroke-destructive"
            : active
              ? "stroke-foreground/60"
              : "stroke-border",
        )}
        strokeWidth={1.5}
      />
      <text x={20} y={26} className="fill-foreground text-[13px] font-medium">
        R2 (EU)
      </text>
      {price && (
        <text
          x={NODE.width - 10}
          y={20}
          textAnchor="end"
          className="fill-foreground/80 text-[11px] tabular-nums"
        >
          {price}
        </text>
      )}
      <text x={20} y={43} className="fill-foreground/75 font-mono text-[10px]">
        {NODES.store.stack}
      </text>
      <text x={20} y={61} className="fill-muted-foreground text-[11px]">
        DB + Search DB
      </text>
      {lines.map((line, index) => (
        <text
          key={line}
          x={20}
          y={92 + index * 17}
          className={cn(
            "text-[11px]",
            health && (!health.ready || health.stale) && index > 0
              ? "fill-destructive"
              : "fill-foreground",
          )}
        >
          {line}
        </text>
      ))}
      {active && (
        <circle cx={NODE.width - 14} cy={height - 14} r={4} className="fill-success">
          <animate attributeName="opacity" values="1;0.25;1" dur="1.2s" repeatCount="indefinite" />
        </circle>
      )}
    </g>
  );
}

const HOVER_WIDTH = 320;

/** Fixed to the viewport so the card's overflow never clips it; flips above near the bottom. */
function HoverCard({ hover, spans }: { hover: Hover; spans: ReadonlyMap<string, SpanView> }) {
  const { rect, target } = hover;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - HOVER_WIDTH / 2, 8),
    window.innerWidth - HOVER_WIDTH - 8,
  );
  const below = window.innerHeight - rect.bottom > 300;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 flex w-80 flex-col rounded-lg bg-popover p-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10"
      style={
        below ? { left, top: rect.bottom + 8 } : { left, bottom: window.innerHeight - rect.top + 8 }
      }
    >
      {target.kind === "node" ? (
        <NodeHover id={target.id} spans={spans} />
      ) : (
        <EdgeHover id={target.id} />
      )}
    </div>
  );
}

// The map sets the row height; the legend scrolls inside it instead of stretching the card.
function Legend() {
  return (
    <div className="relative min-h-40">
      <div className="absolute inset-0">
        <ScrollArea className="h-full rounded-lg border">
          <aside className="flex flex-col gap-3 p-3 text-xs">
            <section className="flex flex-col gap-1">
              <h4 className="font-medium">Stack</h4>
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                <li>TypeScript and Effect 4 in a Bun monorepo.</li>
                <li>No servers or containers: Cloudflare Workers, Workflows, R2, Cron Triggers.</li>
                <li>Voice: ElevenLabs Agents with Claude Haiku.</li>
                <li>
                  Telemetry: Effect spans to a Durable Object (SQLite), streamed over WebSocket to
                  this console (TanStack Start, React, shadcn on Workers).
                </li>
              </ul>
            </section>
            <section className="flex flex-col gap-1">
              <h4 className="font-medium">Map</h4>
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                <li>Hover a box: live numbers; the agent shows tokens and cost.</li>
                <li>Hover a line: how data travels.</li>
                <li>Click a box: hosting, usage, cost.</li>
                <li>
                  Moving dots: data in flight. Green dot: busy. Red border: errors or escalations.
                </li>
                <li>Top right: cost this month; Cloudflare at list price, covered by the plan.</li>
              </ul>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                {(Object.keys(SERVICE_FILL) as ServiceName[]).map((service) => (
                  <span key={service} className="flex items-center gap-1.5">
                    <svg viewBox="0 0 8 8" className="size-2" aria-hidden="true">
                      <circle cx={4} cy={4} r={4} className={SERVICE_FILL[service]} />
                    </svg>
                    {service}
                  </span>
                ))}
              </div>
            </section>
            <section className="flex flex-col gap-1">
              <h4 className="font-medium">Traces and logs below</h4>
              <p className="text-muted-foreground">
                A trace is one request or sync run: click it for its timeline, then a span for
                details and logs. In Logs, filter and press “open” to jump to the trace.
              </p>
            </section>
            <section className="flex flex-col gap-1">
              <h4 className="font-medium">Talk to the agent</h4>
              <p className="text-muted-foreground">
                Start call (left), allow the mic, speak English or Czech, or type. Try “Where does
                Dr. Daria Munteanu work in Ploiești?” Each lookup gets a “view trace” link.
              </p>
            </section>
          </aside>
        </ScrollArea>
      </div>
    </div>
  );
}

/** Short enough for a box corner; the exact figure is in the box's panel. */
function boxPrice(amount: number): string {
  if (amount === 0) return "$0";
  return amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`;
}

/** This month's cost per box. Undefined while a provider has not answered. */
function usePrices(): Partial<Record<NodeId, string>> {
  const agent = useAgentUsage(true);
  const cloudflare = useCloudflareUsage(true);
  const cf = cloudflare.value?.available ? cloudflare.value : undefined;
  const bucket = cf?.buckets["eu_doctor-directory-data"];
  return {
    // No cost of their own: the call is billed to the agent, the cron to directory-sync.
    caller: "$0",
    trigger: "$0",
    agent: agent.value?.available ? boxPrice(agent.value.month.usd) : undefined,
    lookup: cf && boxPrice(workersListValue(cf.workers["doctor-lookup"])),
    sync: cf && boxPrice(workersListValue(cf.workers["directory-sync"])),
    api: cf && boxPrice(workersListValue(cf.workers["directory-api"])),
    store: cf && boxPrice(bucket ? bucketListValue(bucket) : 0),
  };
}
