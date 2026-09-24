import type { ServiceName } from "@doctor-directory/shared/telemetry-events";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SERVICE_BG } from "@/lib/services";

export function ServiceDot({ service }: { service: ServiceName }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("size-2 shrink-0 rounded-full", SERVICE_BG[service])} />}
      />
      <TooltipContent>{service}</TooltipContent>
    </Tooltip>
  );
}

/** Effect log levels: Fatal, Error, Warn, Info, Debug, Trace. */
export function LevelBadge({ level }: { level: string }) {
  const variant =
    level === "Error" || level === "Fatal"
      ? "destructive"
      : level === "Warn"
        ? "outline"
        : level === "Info"
          ? "secondary"
          : "ghost";
  return <Badge variant={variant}>{level}</Badge>;
}
