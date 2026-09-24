import { ELEVENLABS_AGENT_ID } from "@doctor-directory/shared/deployment";
import { ConversationProvider, type ConversationStatus, useConversation } from "@elevenlabs/react";
import {
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  SendIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDuration, type TraceView, traceForToolCall } from "@/lib/traces";
import { CallHistory } from "./call-history";

/** What the rest of the console needs to know about the call. */
export interface VoiceActivity {
  readonly status: ConversationStatus;
  readonly mode: "speaking" | "listening";
  readonly pendingTools: number;
}

type Entry =
  | { kind: "message"; id: string; role: "user" | "agent"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      /** Webhook tools reach doctor-lookup; system tools (language_detection) run inside ElevenLabs. */
      webhook: boolean;
      at: number;
      state: "running" | "ok" | "error";
      finishedAt?: number;
    }
  | { kind: "note"; id: string; text: string };

const SAMPLE_REQUESTS = [
  "Dr. Daria Munteanu, ophthalmologist in Ploiești",
  "Hledám onkoložku Biancu Stan z Buzău",
  "Where does Maria Dimitrescu work?",
];

interface VoicePanelProps {
  traces: ReadonlyArray<TraceView>;
  onSelectTrace: (traceId: string) => void;
  onActivity: (activity: VoiceActivity) => void;
}

export function VoicePanel(props: VoicePanelProps) {
  return (
    <ConversationProvider>
      <VoiceConsole {...props} />
    </ConversationProvider>
  );
}

let nextEntry = 0;
const entryId = () => `entry-${nextEntry++}`;

function VoiceConsole({ traces, onSelectTrace, onActivity }: VoicePanelProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<"live" | "history">("live");
  // Bumped when a call ends, so its record appears in History.
  const [historyKey, setHistoryKey] = useState(0);
  const append = (entry: Entry) => setEntries((current) => [...current, entry]);

  const conversation = useConversation({
    onConversationMetadata: ({ conversation_id }) => {
      setConversationId(conversation_id);
      append({ kind: "note", id: entryId(), text: `Call started · ${conversation_id}` });
    },
    onMessage: ({ message, role }) => {
      if (message.trim() !== "") append({ kind: "message", id: entryId(), role, text: message });
    },
    onAgentToolRequest: ({ tool_name, tool_call_id, tool_type }) =>
      append({
        kind: "tool",
        id: tool_call_id,
        name: tool_name,
        webhook: tool_type === "webhook",
        at: Date.now(),
        state: "running",
      }),
    onAgentToolResponse: ({ tool_call_id, is_error }) =>
      setEntries((current) =>
        current.map((entry) =>
          entry.kind === "tool" && entry.id === tool_call_id
            ? { ...entry, state: is_error ? "error" : "ok", finishedAt: Date.now() }
            : entry,
        ),
      ),
    onError: (message) => setProblem(message),
    onDisconnect: (details) => {
      setHistoryKey((key) => key + 1);
      append({
        kind: "note",
        id: entryId(),
        text:
          details.reason === "user"
            ? "You ended the call"
            : details.reason === "agent"
              ? "The agent ended the call"
              : `Disconnected: ${details.message}`,
      });
    },
  });

  const { status, mode, isMuted } = conversation;
  const pendingTools = entries.filter(
    (entry) => entry.kind === "tool" && entry.state === "running",
  ).length;
  useEffect(() => {
    onActivity({ status, mode, pendingTools });
  }, [status, mode, pendingTools, onActivity]);

  const start = async () => {
    setProblem(undefined);
    try {
      // Ask for the mic up front, so a refusal gets a clear message instead of a failed session.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      setProblem("The microphone is blocked. Allow it in the browser's site settings, then retry.");
      return;
    }
    setEntries([]);
    setView("live");
    setConversationId(undefined);
    conversation.startSession({ agentId: ELEVENLABS_AGENT_ID, connectionType: "webrtc" });
  };

  const send = () => {
    const text = draft.trim();
    if (text === "") return;
    conversation.sendUserMessage(text);
    append({ kind: "message", id: entryId(), role: "user", text });
    setDraft("");
  };

  const live = status === "connected";
  const busy = status === "connecting";

  return (
    <Card className="min-h-0">
      <CardHeader>
        <CardTitle>Voice agent</CardTitle>
        <CardDescription>
          Doctor lookup (RO) · English and Czech. Tool calls link to their backend traces.
        </CardDescription>
        <CardAction>
          <CallStatus status={status} mode={mode} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <Tabs value={view} onValueChange={(value) => setView(value as "live" | "history")}>
          <TabsList>
            <TabsTrigger value="live">Live call</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        </Tabs>
        {view === "history" ? (
          <CallHistory traces={traces} onSelectTrace={onSelectTrace} refreshKey={historyKey} />
        ) : (
          <>
            {problem && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>Call problem</AlertTitle>
                <AlertDescription>{problem}</AlertDescription>
              </Alert>
            )}
            {entries.length === 0 ? (
              <Empty className="flex-1 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <PhoneIcon />
                  </EmptyMedia>
                  <EmptyTitle>{busy ? "Connecting…" : "No call yet"}</EmptyTitle>
                  <EmptyDescription>Start a call and ask, for example:</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <ul className="flex flex-col gap-1 text-left text-sm text-muted-foreground">
                    {SAMPLE_REQUESTS.map((sample) => (
                      <li key={sample}>“{sample}”</li>
                    ))}
                  </ul>
                </EmptyContent>
              </Empty>
            ) : (
              <MessageScrollerProvider autoScroll>
                <MessageScroller className="min-h-0 flex-1">
                  <MessageScrollerViewport>
                    <MessageScrollerContent className="gap-3 py-2">
                      {entries.map((entry) => (
                        <MessageScrollerItem
                          key={entry.id}
                          messageId={entry.id}
                          scrollAnchor={entry.kind === "message" && entry.role === "user"}
                        >
                          <TranscriptEntry
                            entry={entry}
                            trace={
                              entry.kind === "tool" && entry.webhook
                                ? traceForToolCall(traces, conversationId, entry.at)
                                : undefined
                            }
                            onSelectTrace={onSelectTrace}
                          />
                        </MessageScrollerItem>
                      ))}
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <MessageScrollerButton />
                </MessageScroller>
              </MessageScrollerProvider>
            )}
          </>
        )}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2">
        {live && (
          <InputGroup>
            <InputGroupInput
              placeholder="Type instead of speaking…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") send();
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Send" onClick={send}>
                <SendIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        )}
        <div className="flex gap-2">
          {live || busy ? (
            <Button
              variant="destructive"
              className="flex-1"
              disabled={busy}
              onClick={() => conversation.endSession()}
            >
              <PhoneOffIcon data-icon="inline-start" />
              End call
            </Button>
          ) : (
            <Button className="flex-1" onClick={start}>
              <PhoneIcon data-icon="inline-start" />
              Start call
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            disabled={!live}
            aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={isMuted}
            onClick={() => conversation.setMuted(!isMuted)}
          >
            {isMuted ? <MicOffIcon /> : <MicIcon />}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function CallStatus({
  status,
  mode,
}: {
  status: ConversationStatus;
  mode: "speaking" | "listening";
}) {
  switch (status) {
    case "connected":
      return (
        <Badge variant="secondary">
          <span className="size-1.5 rounded-full bg-success" />
          {mode === "speaking" ? "Agent speaking" : "Listening"}
        </Badge>
      );
    case "connecting":
      return (
        <Badge variant="outline">
          <Spinner data-icon="inline-start" />
          Connecting
        </Badge>
      );
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    case "disconnected":
      return <Badge variant="outline">Idle</Badge>;
  }
}

function TranscriptEntry({
  entry,
  trace,
  onSelectTrace,
}: {
  entry: Entry;
  trace: TraceView | undefined;
  onSelectTrace: (traceId: string) => void;
}) {
  switch (entry.kind) {
    case "message":
      return (
        <Message align={entry.role === "user" ? "end" : "start"}>
          <MessageContent>
            <Bubble
              variant={entry.role === "user" ? "default" : "muted"}
              align={entry.role === "user" ? "end" : "start"}
            >
              <BubbleContent>{entry.text}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      );
    case "note":
      return (
        <Marker variant="separator">
          <MarkerContent className="text-xs">{entry.text}</MarkerContent>
        </Marker>
      );
    case "tool": {
      const took =
        entry.finishedAt === undefined ? "" : ` · ${formatDuration(entry.finishedAt - entry.at)}`;
      const label =
        entry.state === "running"
          ? `${entry.name} running…`
          : `${entry.name} ${entry.state === "error" ? "failed" : "answered"}${took}`;
      return trace ? (
        <Marker
          className="rounded-md px-1 hover:text-foreground"
          render={<button type="button" onClick={() => onSelectTrace(trace.traceId)} />}
        >
          <MarkerIcon>{entry.state === "running" ? <Spinner /> : <WrenchIcon />}</MarkerIcon>
          <MarkerContent>
            {label} · <span className="underline underline-offset-3">view trace</span>
          </MarkerContent>
        </Marker>
      ) : (
        <Marker className="px-1">
          <MarkerIcon>{entry.state === "running" ? <Spinner /> : <WrenchIcon />}</MarkerIcon>
          <MarkerContent>{label}</MarkerContent>
        </Marker>
      );
    }
  }
}
