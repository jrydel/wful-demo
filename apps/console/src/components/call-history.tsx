import { ArrowLeftIcon, HistoryIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type CallDetail,
  type CallList,
  type CallSummary,
  getCall,
  listCalls,
  type ToolUse,
} from "@/lib/calls";
import { formatDuration, type TraceView, traceForToolCall } from "@/lib/traces";
import { formatUsd } from "./node-details";

/** While ElevenLabs still processes a call, its title and cost are not final. */
const REFRESH_MS = 15_000;

export function CallHistory({
  traces,
  onSelectTrace,
  refreshKey,
}: {
  traces: ReadonlyArray<TraceView>;
  onSelectTrace: (traceId: string) => void;
  /** Changes when a live call ends, so the new call shows up. */
  refreshKey: number;
}) {
  const [list, setList] = useState<CallList>();
  const [openId, setOpenId] = useState<string>();
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and tick only trigger a reload.
  useEffect(() => {
    let cancelled = false;
    listCalls().then(
      (value) => !cancelled && setList(value),
      (error: unknown) =>
        !cancelled &&
        setList({
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey, tick]);

  const pending = list?.available && list.calls.some((call) => call.status !== "done");
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  if (openId) {
    return (
      <CallView
        id={openId}
        traces={traces}
        onSelectTrace={onSelectTrace}
        onBack={() => setOpenId(undefined)}
      />
    );
  }
  if (!list) return <ListSkeleton />;
  if (!list.available) {
    return (
      <Alert>
        <TriangleAlertIcon />
        <AlertTitle>No call history</AlertTitle>
        <AlertDescription>{list.reason}</AlertDescription>
      </Alert>
    );
  }
  if (list.calls.length === 0) {
    return (
      <Empty className="flex-1 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyTitle>No calls yet</EmptyTitle>
          <EmptyDescription>Finished calls appear here, with transcript and cost.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="flex flex-col gap-1 pr-2">
        {list.calls.map((call) => (
          <li key={call.id}>
            <button
              type="button"
              onClick={() => setOpenId(call.id)}
              className="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{call.title}</span>
                <span className="ml-auto shrink-0">
                  <Outcome call={call} />
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                {when(call.startedAt)} · {formatDuration(call.seconds * 1000)}
                {call.language ? ` · ${call.language}` : ""}
                {call.tools.length > 0 ? ` · ${call.tools.join(", ")}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

function when(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
    hour12: false,
  });
}

function Outcome({ call }: { call: CallSummary }) {
  if (call.status !== "done") return <Badge variant="outline">{call.status}</Badge>;
  if (call.successful === "failure") return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="secondary">{call.successful === "success" ? "success" : "done"}</Badge>;
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

function CallView({
  id,
  traces,
  onSelectTrace,
  onBack,
}: {
  id: string;
  traces: ReadonlyArray<TraceView>;
  onSelectTrace: (traceId: string) => void;
  onBack: () => void;
}) {
  const [call, setCall] = useState<CallDetail>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    getCall({ data: id }).then(setCall, (error: unknown) =>
      setProblem(error instanceof Error ? error.message : String(error)),
    );
  }, [id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeftIcon data-icon="inline-start" />
        All calls
      </Button>
      {problem && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Call not loaded</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      {!call && !problem && <ListSkeleton />}
      {call && (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h3 className="min-w-0 truncate font-heading text-sm font-medium">{call.title}</h3>
              <Outcome call={call} />
            </div>
            <p className="text-xs text-muted-foreground">
              {when(call.startedAt)} · {formatDuration(call.seconds * 1000)} · {formatUsd(call.usd)}{" "}
              ({call.credits.toLocaleString("en")} credits) ·{" "}
              {call.inputTokens.toLocaleString("en")} tokens in,{" "}
              {call.outputTokens.toLocaleString("en")} out
            </p>
            {call.summary && <p className="text-xs">{call.summary}</p>}
            {call.endedBy && <p className="text-xs text-muted-foreground">Ended: {call.endedBy}</p>}
          </div>
          <MessageScrollerProvider>
            <MessageScroller className="min-h-0 flex-1">
              <MessageScrollerViewport>
                <MessageScrollerContent className="gap-3 py-2">
                  {call.turns.map((turn) => (
                    <MessageScrollerItem key={turn.id} messageId={turn.id}>
                      <div className="flex flex-col gap-2">
                        {turn.text && (
                          <Message align={turn.role === "user" ? "end" : "start"}>
                            <MessageContent>
                              <Bubble
                                variant={turn.role === "user" ? "default" : "muted"}
                                align={turn.role === "user" ? "end" : "start"}
                              >
                                <BubbleContent>{turn.text}</BubbleContent>
                              </Bubble>
                            </MessageContent>
                          </Message>
                        )}
                        {turn.tools.map((tool) => (
                          <ToolLine
                            key={tool.id}
                            tool={tool}
                            trace={
                              tool.name === "find_doctor"
                                ? traceForToolCall(traces, call.id, call.startedAt + turn.at * 1000)
                                : undefined
                            }
                            onSelectTrace={onSelectTrace}
                          />
                        ))}
                      </div>
                    </MessageScrollerItem>
                  ))}
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          </MessageScrollerProvider>
        </>
      )}
    </div>
  );
}

/** "city: Bucharest, specialty: Oncology" from the tool's JSON parameters. */
function describeParams(json: string): string {
  try {
    const params = JSON.parse(json) as Record<string, unknown>;
    return Object.entries(params)
      .filter(([key, value]) => !key.startsWith("system__") && value !== null && value !== "")
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(", ");
  } catch {
    return json;
  }
}

function resultStatus(result: string | undefined): string {
  if (result === undefined) return "no result";
  try {
    const parsed = JSON.parse(result) as { status?: unknown; count?: unknown };
    if (typeof parsed.status !== "string") return "answered";
    return typeof parsed.count === "number" ? `${parsed.status} (${parsed.count})` : parsed.status;
  } catch {
    return "answered";
  }
}

function ToolLine({
  tool,
  trace,
  onSelectTrace,
}: {
  tool: ToolUse;
  trace: TraceView | undefined;
  onSelectTrace: (traceId: string) => void;
}) {
  const params = describeParams(tool.params);
  const label = `${tool.name}${params ? `(${params})` : ""} → ${tool.isError ? "error" : resultStatus(tool.result)}${
    tool.latencyMs === undefined ? "" : ` · ${formatDuration(tool.latencyMs)}`
  }`;
  return trace ? (
    <Marker
      className="rounded-md px-1 hover:text-foreground"
      render={<button type="button" onClick={() => onSelectTrace(trace.traceId)} />}
    >
      <MarkerIcon>
        <WrenchIcon />
      </MarkerIcon>
      <MarkerContent>
        {label} · <span className="underline underline-offset-3">view trace</span>
      </MarkerContent>
    </Marker>
  ) : (
    <Marker className="px-1">
      <MarkerIcon>
        <WrenchIcon />
      </MarkerIcon>
      <MarkerContent className={tool.isError ? "text-destructive" : undefined}>
        {label}
      </MarkerContent>
    </Marker>
  );
}
