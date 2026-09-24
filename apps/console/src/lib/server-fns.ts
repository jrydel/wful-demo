import { env } from "cloudflare:workers";
import {
  CONTROL_KEY,
  type ControlFlags,
  DEFAULT_FLAGS,
} from "@doctor-directory/shared/control-flags";
import { createServerFn } from "@tanstack/react-start";

/** "running": a run was already going (only one at a time); `id` is that run. */
export type SyncStart =
  | { status: "started"; id: string }
  | { status: "running"; id: string }
  | { status: "unauthorized" };

export interface SyncProgress {
  readonly id: string;
  /** The Workflow instance state: queued, running, waiting, complete, errored, terminated... */
  readonly status: string;
  readonly error?: string;
  readonly output?: { asOf: string; doctors: number; syncTraceId: string };
}

export type LookupHealth =
  | { ready: true; as_of: string; doctors: number; stale: boolean; sync_trace_id: string }
  | { ready: false; message: string };

/** Starts a sync run (a Workflow instance) and returns at once; the pull takes ~15 minutes. */
export const runSyncNow = createServerFn({ method: "POST" }).handler(
  async (): Promise<SyncStart> => {
    const response = await env.SYNC.fetch(
      new Request("https://directory-sync/sync", {
        method: "POST",
        headers: { authorization: `Bearer ${env.SYNC_TOKEN ?? ""}` },
      }),
    );
    return (await response.json()) as SyncStart;
  },
);

export const getSyncProgress = createServerFn()
  .inputValidator((id: unknown) => {
    if (typeof id !== "string" || !/^[\w-]+$/.test(id)) throw new Error("Expected an instance id");
    return id;
  })
  .handler(async ({ data: id }): Promise<SyncProgress> => {
    const response = await env.SYNC.fetch(
      new Request(`https://directory-sync/sync/${id}`, {
        headers: { authorization: `Bearer ${env.SYNC_TOKEN ?? ""}` },
      }),
    );
    if (!response.ok) throw new Error(`directory-sync answered HTTP ${response.status}`);
    return (await response.json()) as SyncProgress;
  });

export const getLookupHealth = createServerFn().handler(async (): Promise<LookupHealth> => {
  const response = await env.LOOKUP.fetch(new Request("https://doctor-lookup/health"));
  const body = (await response.json()) as Record<string, unknown>;
  return response.ok
    ? {
        ready: true,
        as_of: String(body.as_of),
        doctors: Number(body.doctors),
        stale: Boolean(body.stale),
        sync_trace_id: String(body.sync_trace_id),
      }
    : { ready: false, message: String(body.message ?? `HTTP ${response.status}`) };
});

async function readFlags(): Promise<ControlFlags> {
  const object = await env.DATA.get(CONTROL_KEY);
  if (!object) return DEFAULT_FLAGS;
  return { ...DEFAULT_FLAGS, ...(JSON.parse(await object.text()) as Partial<ControlFlags>) };
}

export const getControlFlags = createServerFn().handler(readFlags);

/** doctor-lookup picks the change up within about 5 seconds. */
export const setSimulateOutage = createServerFn({ method: "POST" })
  .inputValidator((active: unknown) => {
    if (typeof active !== "boolean") throw new Error("Expected true or false");
    return active;
  })
  .handler(async ({ data: active }): Promise<ControlFlags> => {
    const flags: ControlFlags = {
      ...(await readFlags()),
      simulateOutage: active,
      changedAt: new Date().toISOString(),
    };
    await env.DATA.put(CONTROL_KEY, JSON.stringify(flags), {
      httpMetadata: { contentType: "application/json" },
    });
    return flags;
  });
