import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { ConsoleHeader } from "@/components/console-header";
import { LogsPanel } from "@/components/logs-panel";
import { ServiceMap } from "@/components/service-map";
import { TracesPanel } from "@/components/traces-panel";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type VoiceActivity, VoicePanel } from "@/components/voice-panel";
import { useLookupHealth } from "@/hooks/use-lookup-health";
import { useTelemetry } from "@/lib/telemetry-store";
import { buildTraces } from "@/lib/traces";

// Everything here is live browser state (WebSocket, mic, clock), so it renders on the client only.
export const Route = createFileRoute("/")({ ssr: false, component: Console });

function Console() {
  const telemetry = useTelemetry();
  const [tab, setTab] = useState<"traces" | "logs">("traces");
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [escalatedOnly, setEscalatedOnly] = useState(false);
  const [voice, setVoice] = useState<VoiceActivity>({
    status: "disconnected",
    mode: "listening",
    pendingTools: 0,
  });

  // telemetry.spans is mutated in place; version marks each change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version tracks spans' contents.
  const traces = useMemo(() => buildTraces(telemetry.spans), [telemetry.version]);

  // Reload the freshness numbers whenever a sync run finishes.
  const lastPublish = useMemo(() => {
    let latest = 0;
    for (const trace of traces) {
      const run = trace.spans.find(({ span }) => span.name === "DirectorySync.run")?.span;
      if (run?.end !== undefined && run.outcome === "ok") latest = Math.max(latest, run.end);
    }
    return latest;
  }, [traces]);
  const health = useLookupHealth(lastPublish);

  // Counted from traces, so the header number matches the "Escalations only" list.
  const escalations = useMemo(
    () => traces.filter((trace) => trace.escalation !== undefined).length,
    [traces],
  );

  const selectTrace = useCallback((traceId: string) => {
    setSelectedTraceId(traceId);
    setTab("traces");
  }, []);

  // The header's escalation badge: the escalated traces, newest one open.
  const showEscalations = useCallback(() => {
    const newest = traces.find((trace) => trace.escalation !== undefined);
    setEscalatedOnly(true);
    setTab("traces");
    if (newest) setSelectedTraceId(newest.traceId);
  }, [traces]);

  return (
    <div className="flex h-svh flex-col">
      <ConsoleHeader
        stream={telemetry.status}
        escalations={escalations}
        onShowEscalations={showEscalations}
      />
      <main className="grid min-h-0 flex-1 grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)] gap-4 p-4">
        <VoicePanel traces={traces} onSelectTrace={selectTrace} onActivity={setVoice} />
        <div className="flex min-h-0 flex-col gap-4">
          <ServiceMap
            spans={telemetry.spans}
            version={telemetry.version}
            voice={voice}
            health={health}
          />
          <Card className="min-h-0 flex-1 py-0">
            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as "traces" | "logs")}
              className="flex h-full min-h-0 flex-col gap-0"
            >
              <div className="border-b px-3 py-2">
                <TabsList>
                  <TabsTrigger value="traces">Traces</TabsTrigger>
                  <TabsTrigger value="logs">Logs ({telemetry.logs.length})</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="traces" className="min-h-0 flex-1">
                <TracesPanel
                  traces={traces}
                  logs={telemetry.logs}
                  selectedTraceId={selectedTraceId}
                  onSelectTrace={setSelectedTraceId}
                  escalatedOnly={escalatedOnly}
                  onEscalatedOnlyChange={setEscalatedOnly}
                />
              </TabsContent>
              <TabsContent value="logs" className="min-h-0 flex-1">
                <LogsPanel logs={telemetry.logs} onSelectTrace={selectTrace} />
              </TabsContent>
            </Tabs>
          </Card>
        </div>
      </main>
    </div>
  );
}
