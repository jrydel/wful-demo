import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getControlFlags, setSimulateOutage } from "@/lib/server-fns";

/**
 * Rehearses a data outage: while on, doctor-lookup answers every caller "cannot tell you now"
 * and logs an escalation. The count covers the escalated traces the console holds; clicking it
 * opens them.
 */
export function OutageControl({
  escalations,
  onShowEscalations,
}: {
  escalations: number;
  onShowEscalations: () => void;
}) {
  const [active, setActive] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    getControlFlags().then(
      (flags) => setActive(flags.simulateOutage),
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    );
  }, []);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setProblem(undefined);
    try {
      setActive((await setSimulateOutage({ data: next })).simulateOutage);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {escalations > 0 && (
        <Badge
          variant="destructive"
          render={<button type="button" className="cursor-pointer" onClick={onShowEscalations} />}
        >
          {escalations} escalation{escalations === 1 ? "" : "s"} · show
        </Badge>
      )}
      {active && <Badge variant="destructive">Outage simulated: callers get no data</Badge>}
      {problem && <Badge variant="outline">Switch failed: {problem}</Badge>}
      <Tooltip>
        <TooltipTrigger render={<div className="flex items-center gap-2" />}>
          <Switch
            id="simulate-outage"
            checked={active ?? false}
            disabled={active === undefined || saving}
            onCheckedChange={(checked) => void toggle(checked)}
          />
          <Label htmlFor="simulate-outage" className="text-xs">
            Simulate outage
          </Label>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          doctor-lookup answers every lookup as unavailable within about 5 seconds. The agent tells
          callers it cannot say right now and that the problem was escalated; each case is logged as
          an error.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
