import { ConfigProvider, Layer } from "effect";
import type { Telemetry } from "./telemetry";

/** The part of a Worker's execution context this project uses. */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Runtime for a Worker invocation: its string vars and secrets become Effect config, and spans
 * and logs go to the telemetry hub as well as to Workers Logs as JSON lines.
 */
export function workerRuntime(env: object, telemetry: Telemetry) {
  const vars = Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string"),
  );
  return Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromUnknown(vars)), telemetry.layer);
}
