import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { healthzHandler } from "./healthz";
import { TokenBucket } from "./ratelimit";
import { IpCap } from "./ipcap";

/**
 * Relay: a blind router.
 *
 * It forwards encrypted frames between daemons and clients that share a room
 * id. It cannot decrypt payloads and does not authenticate them on purpose —
 * authentication is cryptographic and happens between the endpoints. If the
 * relay is hosted by an untrusted party, the E2E guarantees still hold.
 *
 * Resource limits keep a public relay from being trivially DoS'd.
 */

const PORT = Number(process.env.RELAY_PORT ?? 8787);
const MAX_FRAME = 1_000_000; // bytes; sealed op payloads are far smaller
const MAX_SOCKETS = 1000;
const MAX_PER_ROOM = 10;
// per-connection rate limit on forwarded message frames (0 disables).
// Defaults are sized to pass the daemon's worst-case chunked transfer
// (MAX_CHUNKS = 512 frames, concurrent sessions interleaved on one socket)
// while still capping runaway or flooding connections. There are no
// exemptions: envelope metadata is client-controlled, so the only identity
// the relay verifies is the connection itself.
const RATE_PER_MIN = envNum("RELAY_RATE_PER_MIN", 600);
const RATE_BURST = envNum("RELAY_RATE_BURST", 1000);
const RATE_LIMIT_CLOSE = 4029; // custom 4xxx: "too many frames"
// live-connection cap per source IP (0 disables): MAX_SOCKETS bounds the
// pool, but one host could otherwise hold all 1000 slots and deny every
// other peer admission
const MAX_PER_IP = envNum("RELAY_MAX_PER_IP", 20);
const ipCap = new IpCap(MAX_PER_IP);

// root package.json (monorepo) — same single source the web PWA generates from
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      version: string;
    }).version;
  } catch {
    return "unknown";
  }
})();

/** Env number with validation: invalid values fall back loudly, never silently disable. */
function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    ev("warn", "invalid numeric env, using default", { env: name, default: dflt });
    return dflt;
  }
  return v;
}

interface Socket extends WebSocket {
  id?: string;
  rooms?: Set<string>;
  bucket?: TokenBucket;
  ip?: string;
  released?: boolean;
}

const rooms = new Map<string, Set<Socket>>();

// --- optional metrics endpoint (localhost-only) -----------------------------
const METRICS_PORT = Number(process.env.RELAY_METRICS_PORT ?? 0);
const m = {
  connectionsTotal: 0,
  framesRouted: 0,
  bytesRouted: 0,
  rejects: 0,
  rateLimited: 0,
  startedAt: Date.now(),
};
if (METRICS_PORT) {
  createHttpServer((req, res) => {
    if (req.url?.startsWith("/metrics")) {
      if (req.url.includes("format=prom")) {
        const lines = [
          "# TYPE relay_connections_total counter",
          `relay_connections_total ${m.connectionsTotal}`,
          "# TYPE relay_connections_active gauge",
          `relay_connections_active ${wss.clients.size}`,
          "# TYPE relay_frames_routed counter",
          `relay_frames_routed ${m.framesRouted}`,
          "# TYPE relay_bytes_routed counter",
          `relay_bytes_routed ${m.bytesRouted}`,
          "# TYPE relay_rejects counter",
          `relay_rejects ${m.rejects}`,
          "# TYPE relay_rate_limited_total counter",
          `relay_rate_limited_total ${m.rateLimited}`,
          "# TYPE relay_rooms_active gauge",
          `relay_rooms_active ${rooms.size}`,
        ];
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(lines.join("\n") + "\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            uptime_s: Math.round((Date.now() - m.startedAt) / 1000),
            connections_total: m.connectionsTotal,
            connections_active: wss.clients.size,
            frames_routed: m.framesRouted,
            bytes_routed: m.bytesRouted,
            rejects: m.rejects,
            rate_limited_total: m.rateLimited,
            rooms_active: rooms.size,
          },
          null,
          2,
        ),
      );
      return;
    }
    res.writeHead(404).end();
  })
    .listen(METRICS_PORT, "127.0.0.1", () =>
      ev("info", "metrics listening", { port: METRICS_PORT, bind: "127.0.0.1" }),
    );
}

function join(socket: Socket, room: string) {
  socket.rooms ??= new Set();
  socket.rooms.add(room);
  let set = rooms.get(room);
  if (!set) {
    set = new Set();
    rooms.set(room, set);
  }
  set.add(socket);
}

function leaveAll(socket: Socket) {
  for (const room of socket.rooms ?? []) {
    rooms.get(room)?.delete(socket);
    if (rooms.get(room)?.size === 0) rooms.delete(room);
  }
}

function ev(level: "info" | "warn", msg: string, data?: unknown) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(data ? { data } : {}) }));
}

// optional TLS: set RELAY_TLS_CERT + RELAY_TLS_KEY to serve wss:// directly
// (browsers refuse ws:// from https:// pages — mixed content)
const tlsCert = process.env.RELAY_TLS_CERT;
const tlsKey = process.env.RELAY_TLS_KEY;
const server = tlsCert && tlsKey
  ? createHttpsServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) })
  : createHttpServer();
const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME });
let counter = 0;

// public liveness probe for the hosted stage (no auth, counters only).
// Sits on the plain-HTTP request path; the ws upgrade path is untouched.
server.on(
  "request",
  healthzHandler({ version: VERSION, startedAt: m.startedAt, rooms: () => rooms.size }),
);

server.listen(PORT, () => {
  ev("info", "relay listening", {
    port: PORT,
    tls: Boolean(tlsCert),
    maxFrame: MAX_FRAME,
    maxPerRoom: MAX_PER_ROOM,
    maxPerIp: MAX_PER_IP,
    ratePerMin: RATE_PER_MIN,
    rateBurst: RATE_BURST,
  });
});

// release the per-IP slot exactly once per admitted socket (close and
// error can both fire for the same connection)
function releaseIp(socket: Socket) {
  if (socket.ip === undefined || socket.released) return;
  socket.released = true;
  ipCap.release(socket.ip);
}

wss.on("connection", (socket: Socket, req) => {
  m.connectionsTotal++;
  if (wss.clients.size > MAX_SOCKETS) {
    m.rejects++;
    socket.close(1013, "server busy");
    return;
  }
  // admission control: the per-IP cap applies before any room join
  const ip = req.socket.remoteAddress ?? "unknown";
  if (!ipCap.admit(ip)) {
    m.rejects++;
    ev("warn", "connection rejected: per-IP cap exceeded", { ip });
    socket.close(1013, "too many connections");
    return;
  }
  socket.ip = ip;
  socket.id = `s${Date.now().toString(36)}${(counter++).toString(36)}`;
  socket.rooms = new Set();
  ev("info", "connection open", { id: socket.id, total: wss.clients.size });

  socket.on("message", (data) => {
    let frame: { room?: unknown; from?: unknown; seq?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof frame.room !== "string" || typeof frame.payload !== "string") return;

    // token bucket per connection (one device session). Applied to every
    // frame, including joins (payload "") and self-declared room owners —
    // envelope metadata is attacker-controllable and grants nothing.
    if (RATE_PER_MIN > 0) {
      socket.bucket ??= new TokenBucket(RATE_BURST, RATE_PER_MIN);
      if (!socket.bucket.take()) {
        m.rateLimited++;
        // identity prefix for triage only — never any payload content
        ev("warn", "rate limited, dropping device", {
          id: socket.id,
          from: String(frame.from).slice(0, 10),
          close: RATE_LIMIT_CLOSE,
        });
        socket.close(RATE_LIMIT_CLOSE, "rate limited");
        return;
      }
    }

    ev("info", "frame in", {
      room: frame.room.slice(0, 8),
      from: String(frame.from).slice(0, 10),
      targets: rooms.get(frame.room)?.size ?? -1,
    });

    // every frame's room is joined by its sender: both ends of a
    // conversation converge on the same room naturally
    join(socket, frame.room);
    if ((rooms.get(frame.room)?.size ?? 0) > MAX_PER_ROOM) {
      ev("warn", "room capacity exceeded", { room: frame.room.slice(0, 8) });
      m.rejects++;
      socket.close(1013, "room full");
      return;
    }

    const targets = rooms.get(frame.room);
    if (!targets) return;
    m.framesRouted++;
    m.bytesRouted += frame.payload.length;
    const out = JSON.stringify({
      room: frame.room,
      from: frame.from ?? socket.id,
      seq: frame.seq,
      payload: frame.payload,
    });
    for (const t of targets) {
      if (t !== socket && t.readyState === t.OPEN) t.send(out);
    }
  });

  socket.on("close", () => {
    leaveAll(socket);
    releaseIp(socket);
    ev("info", "connection closed", { id: socket.id, total: wss.clients.size });
  });
  socket.on("error", () => {
    releaseIp(socket);
    leaveAll(socket);
  });
});
