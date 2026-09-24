import { useEffect, useState } from "react";
import {
  type AgentConfigResult,
  type CloudflareConfig,
  getAgentConfig,
  getCloudflareConfig,
} from "@/lib/live-config";
import {
  type AgentUsage,
  type CloudflareUsage,
  getAgentUsage,
  getCloudflareUsage,
} from "@/lib/usage";

const FRESH_MS = 60_000;

interface Entry<T> {
  value?: T;
  error?: string;
  at: number;
  loading?: Promise<void>;
}

interface Cached<T> {
  readonly entry: Entry<T>;
  readonly listeners: Set<() => void>;
  refresh(): void;
}

function cached<T>(load: () => Promise<T>): Cached<T> {
  const entry: Entry<T> = { at: 0 };
  const listeners = new Set<() => void>();
  const refresh = () => {
    if (entry.loading || Date.now() - entry.at < FRESH_MS) return;
    entry.loading = load().then(
      (value) => {
        entry.value = value;
        entry.error = undefined;
      },
      (error: unknown) => {
        entry.error = error instanceof Error ? error.message : String(error);
      },
    );
    void entry.loading.finally(() => {
      entry.at = Date.now();
      entry.loading = undefined;
      for (const listener of listeners) listener();
    });
  };
  return { entry, listeners, refresh };
}

const cloudflare = cached(getCloudflareUsage);
const agent = cached(getAgentUsage);
const cloudflareConfig = cached(getCloudflareConfig);
const agentConfig = cached(getAgentConfig);

function useCached<T>(source: Cached<T>, active: boolean) {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    source.listeners.add(listener);
    return () => {
      source.listeners.delete(listener);
    };
  }, [source]);
  useEffect(() => {
    if (active) source.refresh();
  }, [active, source]);
  return {
    value: source.entry.value,
    error: source.entry.error,
    loading: source.entry.loading !== undefined,
  };
}

/** Month-to-date Cloudflare usage, loaded on first use and reused for a minute. */
export function useCloudflareUsage(active: boolean) {
  return useCached<CloudflareUsage>(cloudflare, active);
}

/** ElevenLabs call costs and tokens, loaded on first use and reused for a minute. */
export function useAgentUsage(active: boolean) {
  return useCached<AgentUsage>(agent, active);
}

/** Live Worker and R2 settings from the Cloudflare API. */
export function useCloudflareConfig(active: boolean) {
  return useCached<CloudflareConfig>(cloudflareConfig, active);
}

/** Live agent and tool settings from the ElevenLabs API. */
export function useAgentConfig(active: boolean) {
  return useCached<AgentConfigResult>(agentConfig, active);
}
