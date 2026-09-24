import { useEffect, useState } from "react";
import { getLookupHealth, type LookupHealth } from "@/lib/server-fns";

/** What doctor-lookup serves from. Reloads every minute and whenever `refreshKey` changes. */
export function useLookupHealth(refreshKey: unknown): LookupHealth | undefined {
  const [health, setHealth] = useState<LookupHealth>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only triggers a reload.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getLookupHealth().then(
        (value) => {
          if (!cancelled) setHealth(value);
        },
        () => {
          if (!cancelled) setHealth({ ready: false, message: "Health check failed" });
        },
      );
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshKey]);
  return health;
}
