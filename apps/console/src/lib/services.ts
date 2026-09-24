import type { ServiceName } from "@doctor-directory/shared/telemetry-events";

/** Color tokens per service (styles.css), for dots, waterfall bars and the service map. */
export const SERVICE_BG: Record<ServiceName, string> = {
  "doctor-lookup": "bg-service-lookup",
  "directory-sync": "bg-service-sync",
  "directory-api": "bg-service-api",
};

export const SERVICE_FILL: Record<ServiceName, string> = {
  "doctor-lookup": "fill-service-lookup",
  "directory-sync": "fill-service-sync",
  "directory-api": "fill-service-api",
};

export const AGENT_ID = "agent_4201m39wmxxvf76snhp94gwajr7c";
