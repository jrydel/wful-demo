import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { StreamStatus } from "@/lib/telemetry-store";
import { OutageControl } from "./outage-control";
import { SyncControl } from "./sync-control";

export function ConsoleHeader({
  stream,
  escalations,
  onShowEscalations,
}: {
  stream: StreamStatus;
  escalations: number;
  onShowEscalations: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b px-4 py-3">
      <div className="flex flex-col">
        <h1 className="font-heading text-base font-medium">Doctor directory console</h1>
        <p className="text-xs text-muted-foreground">
          Live spans and logs from doctor-lookup, directory-sync and directory-api
        </p>
      </div>
      <StreamBadge status={stream} />
      <div className="ml-auto flex items-center gap-4">
        <OutageControl escalations={escalations} onShowEscalations={onShowEscalations} />
        <SyncControl />
      </div>
    </header>
  );
}

function StreamBadge({ status }: { status: StreamStatus }) {
  return status === "live" ? (
    <Badge variant="secondary">
      <span className="size-1.5 rounded-full bg-success" />
      Live
    </Badge>
  ) : (
    <Badge variant="outline">
      <Spinner data-icon="inline-start" />
      {status === "connecting" ? "Connecting" : "Reconnecting"}
    </Badge>
  );
}
