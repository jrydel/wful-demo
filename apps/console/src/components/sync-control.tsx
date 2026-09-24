import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getSyncProgress, runSyncNow, type SyncProgress } from "@/lib/server-fns";

const POLL_MS = 10_000;
const FINISHED = new Set(["complete", "errored", "terminated"]);

type State =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; id: string; status: string }
  | { phase: "done"; progress: SyncProgress }
  | { phase: "failed"; message: string };

/**
 * Starts a sync run. The run is a Workflow on Cloudflare, so it keeps going when this tab closes;
 * the badge follows its status until it publishes or fails.
 */
export function SyncControl() {
  const [state, setState] = useState<State>({ phase: "idle" });

  useEffect(() => {
    if (state.phase !== "running") return;
    const timer = setTimeout(async () => {
      try {
        const progress = await getSyncProgress({ data: state.id });
        setState(
          FINISHED.has(progress.status)
            ? { phase: "done", progress }
            : { phase: "running", id: state.id, status: progress.status },
        );
      } catch (error) {
        setState({
          phase: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const start = async () => {
    setState({ phase: "starting" });
    try {
      const started = await runSyncNow();
      setState(
        started.status === "unauthorized"
          ? { phase: "failed", message: "Sync token rejected" }
          : // Only one run at a time: if one is going, follow it instead.
            {
              phase: "running",
              id: started.id,
              status: started.status === "started" ? "queued" : "running",
            },
      );
    } catch (error) {
      setState({
        phase: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const busy = state.phase === "starting" || state.phase === "running";
  return (
    <div className="flex items-center gap-2">
      <Outcome state={state} />
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="outline" size="sm" disabled={busy} onClick={start} />}
        >
          {busy ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          {busy ? "Syncing…" : "Run sync now"}
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          Starts the same Workflow the 03:00 UTC cron starts: pull the full dump (about 15 minutes),
          validate, publish. Only one run at a time; if one is going, this follows it. It runs on
          Cloudflare, so closing this tab does not stop it.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function Outcome({ state }: { state: State }) {
  switch (state.phase) {
    case "running":
      return <Badge variant="outline">Workflow {state.status}</Badge>;
    case "done":
      return state.progress.status === "complete" && state.progress.output ? (
        <Badge variant="secondary">
          Published {state.progress.output.doctors.toLocaleString("en")} doctors
        </Badge>
      ) : (
        <Badge variant="destructive">
          Sync {state.progress.status}
          {state.progress.error ? `: ${state.progress.error}` : ""}
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">{state.message}</Badge>;
    default:
      return null;
  }
}
