import type { ServiceName } from "@doctor-directory/shared/telemetry-events";
import { ScrollTextIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { StoredLog } from "@/lib/telemetry-store";
import { formatClock } from "@/lib/traces";
import { LevelBadge, ServiceDot } from "./log-parts";

const SERVICES: ReadonlyArray<ServiceName> = ["doctor-lookup", "directory-sync", "directory-api"];
const MAX_ROWS = 400;

type LevelFilter = "all" | "warn" | "error";
const LEVELS: Record<LevelFilter, ReadonlySet<string> | undefined> = {
  all: undefined,
  warn: new Set(["Warn", "Error", "Fatal"]),
  error: new Set(["Error", "Fatal"]),
};

export function LogsPanel({
  logs,
  onSelectTrace,
}: {
  logs: ReadonlyArray<StoredLog>;
  onSelectTrace: (traceId: string) => void;
}) {
  const [services, setServices] = useState<string[]>([...SERVICES]);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const allowedLevels = LEVELS[level];
    const needle = query.trim().toLowerCase();
    const matches: StoredLog[] = [];
    // Newest first; stop once the table is full.
    for (let index = logs.length - 1; index >= 0 && matches.length < MAX_ROWS; index--) {
      const log = logs[index];
      if (!services.includes(log.service)) continue;
      if (allowedLevels && !allowedLevels.has(log.level)) continue;
      if (
        needle !== "" &&
        !`${log.message} ${log.data ?? ""} ${log.service}`.toLowerCase().includes(needle)
      ) {
        continue;
      }
      matches.push(log);
    }
    return matches;
  }, [logs, services, level, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <ToggleGroup
          multiple
          size="sm"
          variant="outline"
          value={services}
          onValueChange={setServices}
        >
          {SERVICES.map((service) => (
            <ToggleGroupItem key={service} value={service}>
              <ServiceDot service={service} />
              {service}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          size="sm"
          variant="outline"
          value={[level]}
          onValueChange={(value) => setLevel((value[0] as LevelFilter | undefined) ?? "all")}
        >
          <ToggleGroupItem value="all">All levels</ToggleGroupItem>
          <ToggleGroupItem value="warn">Warn+</ToggleGroupItem>
          <ToggleGroupItem value="error">Errors</ToggleGroupItem>
        </ToggleGroup>
        <InputGroup className="ml-auto w-64">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search messages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
      </div>
      {rows.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollTextIcon />
            </EmptyMedia>
            <EmptyTitle>No logs</EmptyTitle>
            <EmptyDescription>
              {logs.length === 0
                ? "Nothing logged since the hub last restarted."
                : "Nothing matches the filters."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Time</TableHead>
                <TableHead className="w-36">Service</TableHead>
                <TableHead className="w-20">Level</TableHead>
                <TableHead>Message</TableHead>
                <TableHead className="w-16 text-right">Trace</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="align-top font-mono text-xs text-muted-foreground">
                    {formatClock(log.at)}
                  </TableCell>
                  <TableCell className="align-top">
                    <span className="flex items-center gap-2 text-xs">
                      <ServiceDot service={log.service} />
                      {log.service}
                    </span>
                  </TableCell>
                  <TableCell className="align-top">
                    <LevelBadge level={log.level} />
                  </TableCell>
                  <TableCell className="max-w-0 whitespace-normal">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm">{log.message}</span>
                      {log.data && (
                        <span className="font-mono text-xs break-all text-muted-foreground">
                          {log.data}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    {log.traceId && (
                      <Button
                        variant="link"
                        size="xs"
                        onClick={() => log.traceId && onSelectTrace(log.traceId)}
                      >
                        open
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
    </div>
  );
}
