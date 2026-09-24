import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentUsage, useCloudflareUsage } from "@/hooks/use-provider-data";
import { PRICES, projectCloudflareValue } from "@/lib/usage";
import { formatUsd } from "./node-details";

/**
 * This month's spend at a glance: what the project itself used (ElevenLabs calls plus its own
 * Cloudflare usage at list price) and, separately, the flat Workers plan, which the whole
 * account shares.
 */
export function CostSummary() {
  const agent = useAgentUsage(true);
  const cloudflare = useCloudflareUsage(true);
  // Wait for both providers: a total built while one is still loading would look final.
  const settled = (source: { value?: unknown; error?: string }) =>
    source.value !== undefined || source.error !== undefined;
  if (!settled(agent) || !settled(cloudflare)) {
    return <Skeleton className="h-9 w-40" />;
  }
  const calls = agent.value?.available ? agent.value.month : undefined;
  const cf = cloudflare.value?.available ? projectCloudflareValue(cloudflare.value) : undefined;
  const project = (calls?.usd ?? 0) + (cf ?? 0);
  const partial = calls === undefined || cf === undefined;
  const account = cloudflare.value?.available ? cloudflare.value.account : undefined;
  const withinPlan =
    account !== undefined &&
    account.requests <= PRICES.workersIncludedRequests &&
    account.cpuMs <= PRICES.workersIncludedCpuMs;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<div className="flex cursor-default flex-col items-end text-right" />}
      >
        <span className="font-heading text-base font-medium tabular-nums">
          {formatUsd(project)}
          {partial ? "*" : ""}
          <span className="text-xs font-normal text-muted-foreground"> this month</span>
        </span>
        <span className="text-xs text-muted-foreground">
          + ${PRICES.workersPlanMonthly} Workers plan (whole account)
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
          <dt>ElevenLabs calls</dt>
          <dd className="text-right tabular-nums">
            {calls ? `${formatUsd(calls.usd)} (${calls.calls} calls)` : "not available"}
          </dd>
          <dt>Cloudflare usage, 5 Workers + R2</dt>
          <dd className="text-right tabular-nums">
            {cf === undefined ? "not available" : formatUsd(cf)}
          </dd>
          <dt>Workers Paid plan</dt>
          <dd className="text-right tabular-nums">${PRICES.workersPlanMonthly}/month</dd>
        </dl>
        <p className="mt-2 opacity-80">
          Cloudflare usage is at list price.{" "}
          {withinPlan
            ? "The whole account is within the plan's included amounts, so the bill is the flat plan, which also covers other Workers on the account."
            : account
              ? "The account is past the plan's included amounts; see Cloudflare billing for the overage."
              : ""}
          {partial ? " * One provider did not answer." : ""}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
