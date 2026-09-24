import { cn } from "cn";
import { ActivityIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Toggle } from "@/components/ui/toggle";
import { useNow } from "@/hooks/use-now";
import { SERVICE_BG } from "@/lib/services";
import type { SpanView, StoredLog } from "@/lib/telemetry-store";
import {
  describeEscalation,
  describeTrace,
  formatClock,
  formatDuration,
  isHealthCheck,
  isRunning,
  plural,
  type TraceStatus,
  type TraceView,
  traceStatus,
} from "@/lib/traces";
import { LevelBadge, ServiceDot } from "./log-parts";

const MAX_LISTED = 200;

export function TracesPanel({
  traces,
  logs,
  selectedTraceId,
  onSelectTrace,
  escalatedOnly,
  onEscalatedOnlyChange,
}: {
  traces: ReadonlyArray<TraceView>;
  logs: ReadonlyArray<StoredLog>;
  selectedTraceId: string | undefined;
  onSelectTrace: (traceId: string) => void;
  escalatedOnly: boolean;
  onEscalatedOnlyChange: (escalatedOnly: boolean) => void;
}) {
  const now = useNow(1000);
  const [showHealth, setShowHealth] = useState(false);
  const listed = useMemo(
    () =>
      traces
        .filter((trace) => !escalatedOnly || trace.escalation !== undefined)
        .filter((trace) => showHealth || !isHealthCheck(trace))
        .slice(0, MAX_LISTED),
    [traces, showHealth, escalatedOnly],
  );
  const selected =
    traces.find((trace) => trace.traceId === selectedTraceId) ??
    (selectedTraceId === undefined ? listed[0] : undefined);

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,5fr)_minmax(0,7fr)] grid-rows-1">
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {plural(listed.length, "trace")}
            {traces.length > MAX_LISTED ? ` (newest ${MAX_LISTED})` : ""}
          </span>
          <div className="flex gap-2">
            <Toggle
              size="sm"
              variant="outline"
              pressed={escalatedOnly}
              onPressedChange={onEscalatedOnlyChange}
            >
              Escalations only
            </Toggle>
            <Toggle
              size="sm"
              variant="outline"
              pressed={showHealth}
              onPressedChange={setShowHealth}
            >
              Health checks
            </Toggle>
          </div>
        </div>
        {listed.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle>{escalatedOnly ? "No escalations" : "No traces yet"}</EmptyTitle>
              <EmptyDescription>
                {escalatedOnly
                  ? "Every caller in view got an answer."
                  : "Start a call or run a sync; spans appear as they start."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Started</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead className="w-24 text-right">Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listed.map((trace) => {
                  const status = traceStatus(trace, now);
                  return (
                    <TableRow
                      key={trace.traceId}
                      data-state={trace === selected ? "selected" : undefined}
                      className="relative"
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {formatClock(trace.start)}
                      </TableCell>
                      <TableCell className="max-w-0">
                        <button
                          type="button"
                          className="flex w-full min-w-0 items-center gap-2 text-left outline-none after:absolute after:inset-0 focus-visible:underline"
                          onClick={() => onSelectTrace(trace.traceId)}
                        >
                          <StatusMark status={status} />
                          <span className="truncate">{describeTrace(trace)}</span>
                          {trace.escalation && <Badge variant="destructive">escalated</Badge>}
                          <span className="ml-auto flex shrink-0 gap-1">
                            {trace.services.map((service) => (
                              <ServiceDot key={service} service={service} />
                            ))}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatDuration((trace.end ?? now) - trace.start)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        )}
      </div>
      {selected ? (
        <TraceDetail trace={selected} logs={logs} now={now} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{selectedTraceId ? "Trace not in view" : "No trace selected"}</EmptyTitle>
            <EmptyDescription>
              {selectedTraceId
                ? "It is older than what the console keeps, or its spans have not arrived yet."
                : "Pick a trace on the left to see its timeline."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function StatusMark({ status }: { status: TraceStatus }) {
  switch (status) {
    case "running":
      return <Spinner className="size-3.5 shrink-0" />;
    case "ok":
      return (
        <span role="img" aria-label="ok" className="size-2 shrink-0 rounded-full bg-success" />
      );
    case "error":
    case "escalated":
      return (
        <span
          role="img"
          aria-label={status}
          className="size-2 shrink-0 rounded-full bg-destructive"
        />
      );
    case "unfinished":
      return (
        <span
          role="img"
          aria-label="unfinished"
          className="size-2 shrink-0 rounded-full border border-muted-foreground"
        />
      );
  }
}

function TraceDetail({
  trace,
  logs,
  now,
}: {
  trace: TraceView;
  logs: ReadonlyArray<StoredLog>;
  now: number;
}) {
  const [selectedSpanId, setSelectedSpanId] = useState<string>();
  const span = trace.spans.find(({ span }) => span.spanId === selectedSpanId)?.span ?? trace.root;
  const end = trace.end ?? now;
  const total = Math.max(end - trace.start, 1);
  const traceLogs = logs.filter((log) => log.traceId === trace.traceId);
  const status = traceStatus(trace, now);

  return (
    <ScrollArea className="min-h-0">
      <div className="flex flex-col gap-4 p-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3 className="font-heading font-medium">{describeTrace(trace)}</h3>
            <Badge
              variant={
                status === "error" || status === "escalated"
                  ? "destructive"
                  : status === "ok"
                    ? "secondary"
                    : "outline"
              }
            >
              {status}
            </Badge>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            trace {trace.traceId} · {formatDuration(end - trace.start)} · {trace.spans.length} spans
            {trace.conversationId ? ` · ${trace.conversationId}` : ""}
          </p>
        </div>

        {trace.escalation && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Escalated: the caller got no answer</AlertTitle>
            <AlertDescription>
              {describeEscalation(trace.escalation.reason)} The agent told the caller it cannot say
              right now and to call again later. Logged as an error for follow-up
              {trace.conversationId ? ` (conversation ${trace.conversationId})` : ""}.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col">
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem] gap-2 pb-1 text-xs text-muted-foreground">
            <span>Span</span>
            <span className="flex justify-between">
              <span>0</span>
              <span>{formatDuration(total)}</span>
            </span>
            <span className="text-right">Took</span>
          </div>
          {trace.spans.map(({ span: row, depth }) => (
            <WaterfallRow
              key={row.spanId}
              span={row}
              depth={depth}
              traceStart={trace.start}
              total={total}
              now={now}
              selected={row.spanId === span.spanId}
              onSelect={() => setSelectedSpanId(row.spanId)}
            />
          ))}
        </div>

        <SpanDetail span={span} />

        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">Logs in this trace</h4>
          {traceLogs.length === 0 ? (
            <p className="text-xs text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {traceLogs.map((log) => (
                <li
                  key={log.id}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-md px-2 py-1 text-xs",
                    log.spanId === span.spanId && "bg-muted",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-muted-foreground">{formatClock(log.at)}</span>
                    <ServiceDot service={log.service} />
                    <LevelBadge level={log.level} />
                    <span className="min-w-0 truncate">{log.message}</span>
                  </span>
                  {log.data && (
                    <span className="font-mono break-all text-muted-foreground">{log.data}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

function WaterfallRow({
  span,
  depth,
  traceStart,
  total,
  now,
  selected,
  onSelect,
}: {
  span: SpanView;
  depth: number;
  traceStart: number;
  total: number;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const running = isRunning(span, now);
  const end = span.end ?? (running ? now : span.start);
  const left = ((span.start - traceStart) / total) * 100;
  const width = Math.max(((end - span.start) / total) * 100, 0.5);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem] items-center gap-2 rounded-md py-1 text-left text-xs outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50",
        selected && "bg-muted",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 12 }}>
        <ServiceDot service={span.service} />
        <span className="truncate">{span.name}</span>
      </span>
      <span className="relative h-3">
        <span
          className={cn(
            "absolute inset-y-0 rounded-sm",
            span.outcome === "error" ? "bg-destructive" : SERVICE_BG[span.service],
            running && "animate-pulse",
          )}
          style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
        />
      </span>
      <span className="text-right font-mono text-muted-foreground">
        {running
          ? "running"
          : span.end === undefined
            ? "no end"
            : formatDuration(span.end - span.start)}
      </span>
    </button>
  );
}

function SpanDetail({ span }: { span: SpanView }) {
  const attributes = Object.entries(span.attributes);
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-muted-foreground">
        {span.service} · {span.name}
      </h4>
      {span.error && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{span.outcome === "interrupted" ? "Interrupted" : "Failed"}</AlertTitle>
          <AlertDescription className="font-mono text-xs break-all">{span.error}</AlertDescription>
        </Alert>
      )}
      {attributes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {span.end === undefined ? "Attributes arrive when the span ends." : "No attributes."}
        </p>
      ) : (
        <Table>
          <TableBody>
            {attributes.map(([key, value]) => (
              <TableRow key={key}>
                <TableCell className="w-2/5 font-mono text-xs text-muted-foreground">
                  {key}
                </TableCell>
                <TableCell className="font-mono text-xs break-all whitespace-normal">
                  {String(value)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
