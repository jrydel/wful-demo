// Local development only, never deployed. `wrangler dev` exposes only the first Worker of a
// multi-Worker session over HTTP; this gateway is that Worker and forwards to the others, which
// share one local R2 with it. /sync and /sync/<id> go to directory-sync, /telemetry/* to the telemetry
// hub (e.g. /telemetry/recent), everything else to doctor-lookup.

interface Service {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  readonly LOOKUP: Service;
  readonly SYNC: Service;
  readonly TELEMETRY: Service;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/sync" || url.pathname.startsWith("/sync/")) {
      return env.SYNC.fetch(request);
    }
    if (url.pathname.startsWith("/telemetry/")) {
      url.pathname = url.pathname.slice("/telemetry".length);
      return env.TELEMETRY.fetch(new Request(url.href, request));
    }
    return env.LOOKUP.fetch(request);
  },
};
