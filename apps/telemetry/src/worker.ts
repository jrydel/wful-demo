import { DurableObject } from "cloudflare:workers";
import type {
  StoredEvent,
  StreamMessage,
  TelemetryEvent,
} from "@doctor-directory/shared/telemetry-events";

// The telemetry hub: the other Workers post span and log events here over service bindings, and
// the console streams them. Plain TypeScript, not Effect, so the sink never reports on itself.
// It has no public URL (workers_dev: false); only service bindings reach it.

const KEEP_EVENTS = 5000;
const BACKLOG_EVENTS = 1500;

export class EventHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)",
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/ingest" && request.method === "POST") {
      this.ingest((await request.json()) as TelemetryEvent[]);
      return new Response(null, { status: 204 });
    }
    if (pathname === "/stream") {
      if (request.headers.get("upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.send(
        JSON.stringify({
          type: "backlog",
          events: this.recent(BACKLOG_EVENTS),
        } satisfies StreamMessage),
      );
      return new Response(null, { status: 101, webSocket: client });
    }
    if (pathname === "/recent") {
      return Response.json(this.recent(Number(searchParams.get("limit") ?? 200)));
    }
    return new Response("Not found", { status: 404 });
  }

  // The stream is read-only; subscribers have nothing to say.
  override webSocketMessage(): void {}

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  private ingest(events: ReadonlyArray<TelemetryEvent>): void {
    if (events.length === 0) return;
    const sql = this.ctx.storage.sql;
    const stored = events.map((event): StoredEvent => {
      const { id } = sql
        .exec<{ id: number }>(
          "INSERT INTO events (body) VALUES (?) RETURNING id",
          JSON.stringify(event),
        )
        .one();
      return { ...event, id };
    });
    const newest = stored[stored.length - 1].id;
    sql.exec("DELETE FROM events WHERE id <= ?", newest - KEEP_EVENTS);
    const message = JSON.stringify({ type: "events", events: stored } satisfies StreamMessage);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A subscriber that went away is dropped by the runtime; the others still get the batch.
      }
    }
  }

  private recent(limit: number): StoredEvent[] {
    const rows = this.ctx.storage.sql
      .exec<{ id: number; body: string }>(
        "SELECT id, body FROM events ORDER BY id DESC LIMIT ?",
        Math.min(Math.max(limit, 1), KEEP_EVENTS),
      )
      .toArray();
    return rows.reverse().map(({ id, body }) => ({ ...(JSON.parse(body) as TelemetryEvent), id }));
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.HUB.get(env.HUB.idFromName("hub")).fetch(request);
  },
} satisfies ExportedHandler<Env>;
