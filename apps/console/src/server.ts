import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";

// Public by decision: anyone with the URL sees the live traces and logs (callers' queries and
// conversation ids) and can use Simulate outage and Run sync now.
export default {
  fetch(request: Request): Promise<Response> | Response {
    if (new URL(request.url).pathname === "/api/stream") {
      return env.TELEMETRY.fetch(new Request("https://telemetry/stream", request));
    }
    return handler.fetch(request);
  },
};
