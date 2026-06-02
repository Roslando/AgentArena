import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MatchRunner } from "@agentarena/engine";
import { type LogEntry, MatchConfigSchema } from "@agentarena/types";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PORT ?? 7070);
const LOGS_DIR = process.env.LOGS_DIR ?? "logs";

/** matchId -> set of subscribed sockets */
const rooms = new Map<string, Set<ServerWebSocket<WsData>>>();
/** matchId -> every entry broadcast so far, so late joiners can catch up */
const history = new Map<string, LogEntry[]>();

interface WsData {
  matchId: string;
}

function subscribe(matchId: string, ws: ServerWebSocket<WsData>): void {
  let room = rooms.get(matchId);
  if (!room) {
    room = new Set();
    rooms.set(matchId, room);
  }
  room.add(ws);
}

function unsubscribe(matchId: string, ws: ServerWebSocket<WsData>): void {
  const room = rooms.get(matchId);
  room?.delete(ws);
  if (room && room.size === 0) rooms.delete(matchId);
}

/** Push one log entry to every socket watching this match, and buffer it for late joiners. */
function broadcast(matchId: string, entry: LogEntry): void {
  let buffer = history.get(matchId);
  if (!buffer) {
    buffer = [];
    history.set(matchId, buffer);
  }
  // A fresh match.start resets the buffer (new game on the same id)
  if (entry.type === "match.start") buffer.length = 0;
  buffer.push(entry);

  const room = rooms.get(matchId);
  if (!room) return;
  const payload = JSON.stringify(entry);
  for (const ws of room) ws.send(payload);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

/** Stream a previously saved log over WebSocket with delays — verifies the live path without API keys. */
async function streamSavedAsLive(matchId: string, fromId: string, stepMs: number): Promise<void> {
  const path = join(LOGS_DIR, `${fromId}.jsonl`);
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LogEntry;
      broadcast(matchId, { ...entry, matchId });
    } catch {
      /* skip */
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const server = Bun.serve<WsData>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // WebSocket upgrade: /ws?matchId=...
    if (url.pathname === "/ws") {
      const matchId = url.searchParams.get("matchId") ?? "";
      if (srv.upgrade(req, { data: { matchId } })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // List saved logs
    if (url.pathname === "/api/logs" && req.method === "GET") {
      if (!existsSync(LOGS_DIR)) return json([]);
      const items = readdirSync(LOGS_DIR)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const s = statSync(join(LOGS_DIR, f));
          return { id: f.replace(/\.jsonl$/, ""), bytes: s.size, mtime: s.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return json(items);
    }

    // Fetch one saved log (raw jsonl) for replay
    const logMatch = url.pathname.match(/^\/api\/logs\/(.+)$/);
    if (logMatch && req.method === "GET") {
      const id = decodeURIComponent(logMatch[1] as string);
      const path = join(LOGS_DIR, `${id}.jsonl`);
      if (!existsSync(path)) return json({ error: "not found" }, 404);
      return new Response(readFileSync(path, "utf-8"), {
        headers: { "Content-Type": "application/x-ndjson", ...CORS },
      });
    }

    // Start a real match — body is a MatchConfig (with API keys). Broadcasts live.
    if (url.pathname === "/api/matches" && req.method === "POST") {
      const parsed = MatchConfigSchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return json({ error: "invalid config", issues: parsed.error.issues }, 400);
      const config = parsed.data;
      const runner = new MatchRunner(config, (entry) => broadcast(config.matchId, entry));
      // Fire-and-forget: the client watches progress over WebSocket
      runner.run().catch((err) => {
        broadcast(config.matchId, {
          type: "mcp.error",
          t: new Date().toISOString(),
          matchId: config.matchId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
      return json({ matchId: config.matchId, watch: `/ws?matchId=${config.matchId}` });
    }

    // Replay a saved log AS live (key-free demo of the WebSocket path)
    if (url.pathname === "/api/replay-as-live" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { id?: string; stepMs?: number };
      const fromId = body.id ?? "sample-foolsmate";
      const matchId = `live-${fromId}`;
      const stepMs = body.stepMs ?? 600;
      void streamSavedAsLive(matchId, fromId, stepMs);
      return json({ matchId, watch: `/ws?matchId=${matchId}` });
    }

    return new Response("AgentArena server", { headers: CORS });
  },

  websocket: {
    open(ws) {
      subscribe(ws.data.matchId, ws);
      // Catch the new viewer up with everything broadcast so far
      const buffer = history.get(ws.data.matchId);
      if (buffer) for (const entry of buffer) ws.send(JSON.stringify(entry));
    },
    close(ws) {
      unsubscribe(ws.data.matchId, ws);
    },
    message() {
      // clients are listeners only
    },
  },
});

console.log(`AgentArena server on http://localhost:${server.port}  (logs: ${LOGS_DIR})`);
