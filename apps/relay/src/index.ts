import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
// relative imports carry .js specifiers so plain `node` can run the tsc emit
// (deploy/relay/Dockerfile + tsconfig.build.json) — tsx resolves them too
import { healthzHandler } from "./healthz.js";
import { TokenBucket } from "./ratelimit.js";
import { IpCap, clientIp } from "./ipcap.js";
import { isValidRoomId, MAX_ROOMS_PER_SOCKET } from "./roomid.js";
import { createShutdown, stopAccepting } from "./shutdown.js";
import { decideStale } from "./liveness.js";

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
// x-forwarded-for is client-forgeable, so it is only honored when the
// operator declares how many trusted proxy layers sit in front of the relay
// (0 = direct exposure, header ignored). Behind provider TLS without this,
// every connection would share the LB's IP and RELAY_MAX_PER_IP would
// collapse into a global admission cap (P2-128).
const TRUST_PROXY_HOPS = envNum("RELAY_TRUST_PROXY_HOPS", 0);
// ws-level liveness sweep (P2-067): every interval the relay pings all
// sockets and terminates the ones silent for more than interval+grace
// (grace == interval), so a peer that vanished without a close frame
// (phone lost wifi, laptop slept) stops holding a MAX_SOCKETS slot and its
// per-IP budget until restart. 0 disables the sweep entirely.
const PING_INTERVAL_S = envNum("RELAY_PING_INTERVAL_S", 30);

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
  lastSeen?: number;
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
  roomsRejected: 0,
  staleTerminated: 0,
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
          "# TYPE relay_rooms_rejected counter",
          `relay_rooms_rejected ${m.roomsRejected}`,
          "# TYPE relay_stale_terminated counter",
          `relay_stale_terminated ${m.staleTerminated}`,
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
            rooms_rejected: m.roomsRejected,
            stale_terminated: m.staleTerminated,
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
  healthzHandler({
    version: VERSION,
    startedAt: m.startedAt,
    rooms: () => rooms.size,
    roomsRejected: () => m.roomsRejected,
  }),
);

server.listen(PORT, () => {
  ev("info", "relay listening", {
    port: PORT,
    tls: Boolean(tlsCert),
    maxFrame: MAX_FRAME,
    maxPerRoom: MAX_PER_ROOM,
    maxPerIp: MAX_PER_IP,
    trustProxyHops: TRUST_PROXY_HOPS,
    ratePerMin: RATE_PER_MIN,
    rateBurst: RATE_BURST,
    pingIntervalS: PING_INTERVAL_S,
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
  // admission control: the per-IP cap applies before any room join.
  // The key is proxy-aware (P2-128): remoteAddress normalized once (P2-026),
  // or the trusted x-forwarded-for hop when RELAY_TRUST_PROXY_HOPS says the
  // chain in front is known — and the same key is stashed on the socket so
  // admit() and release() always act on the same bucket.
  const fwd = req.headers["x-forwarded-for"];
  const ip = clientIp(
    req.socket.remoteAddress ?? "unknown",
    typeof fwd === "string" ? fwd : undefined,
    TRUST_PROXY_HOPS,
  );
  if (!ipCap.admit(ip)) {
    m.rejects++;
    ev("warn", "connection rejected: per-IP cap exceeded", { ip });
    socket.close(1013, "too many connections");
    return;
  }
  socket.ip = ip;
  socket.id = `s${Date.now().toString(36)}${(counter++).toString(36)}`;
  socket.rooms = new Set();
  socket.lastSeen = Date.now();
  ev("info", "connection open", { id: socket.id, total: wss.clients.size });

  // every pong proves the peer is alive at the transport level (ws clients
  // answer pings automatically unless they are truly half-dead)
  socket.on("pong", () => {
    socket.lastSeen = Date.now();
  });

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

    // room grammar + per-socket room cap (P2-019): room ids are the only
    // envelope field that allocates relay state, so unvalidated ids let one
    // socket grow the rooms map without bound. Both checks run after the
    // rate limiter so abuse is budget-bounded; a bad frame is dropped —
    // never close — with only a prefix logged, as everywhere else.
    if (!isValidRoomId(frame.room)) {
      m.roomsRejected++;
      ev("warn", "frame dropped: invalid room id", {
        id: socket.id,
        room: String(frame.room).slice(0, 8),
      });
      return;
    }
    if (!socket.rooms?.has(frame.room) && (socket.rooms?.size ?? 0) >= MAX_ROOMS_PER_SOCKET) {
      m.roomsRejected++;
      ev("warn", "frame dropped: socket room cap exceeded", {
        id: socket.id,
        room: frame.room.slice(0, 8),
        cap: MAX_ROOMS_PER_SOCKET,
      });
      return;
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

// P2-067: reap sockets that vanished without a close frame. Terminated via
// socket.terminate(), so the normal close path runs — rooms and the per-IP
// slot are released by the existing handlers above.
if (PING_INTERVAL_S > 0) {
  setInterval(() => {
    const now = Date.now();
    for (const dead of decideStale(now, wss.clients as Set<Socket>, PING_INTERVAL_S, PING_INTERVAL_S)) {
      m.staleTerminated++;
      ev("info", "stale socket terminated", { id: dead.id, silentS: PING_INTERVAL_S * 2 });
      dead.terminate();
    }
    for (const c of wss.clients) {
      if (c.readyState === c.OPEN) c.ping();
    }
  }, PING_INTERVAL_S * 1000);
}

// P2-023: SIGTERM/SIGINT graceful shutdown — drain ≤3s, then exit 0.
// `launchctl kickstart -k` (deploy step 2) relies on this: clients get a
// close 1001 frame and a final JSONL line instead of a dead socket.
const { shutdown } = createShutdown({
  activeConnections: () => wss.clients.size,
  uptimeMs: () => Date.now() - m.startedAt,
  stopListeners: () => stopAccepting(server, wss.clients, ev),
  log: ev,
  exit: (code) => process.exit(code),
  setTimeout,
  clearTimeout,
});
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
