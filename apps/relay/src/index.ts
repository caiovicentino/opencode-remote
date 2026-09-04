import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
// relative imports carry .js specifiers so plain `node` can run the tsc emit
// (deploy/relay/Dockerfile + tsconfig.build.json) — tsx resolves them too
import { healthzHandler } from "./healthz.js";
import { TokenBucket } from "./ratelimit.js";
import { IpCap, clientIp } from "./ipcap.js";
import { isValidRoomId, MAX_ROOMS_PER_SOCKET } from "./roomid.js";
import { createShutdown, refuseUpgrade, stopAccepting } from "./shutdown.js";
import { decideStale } from "./liveness.js";
import { metricsAuthOk, metricsBinding } from "./metricsbind.js";
import { relayLimits } from "./limits.js";
import { tlsPlan } from "./tlsconfig.js";

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
// P2-141: admission ceilings are env-configurable and validated fail-closed
// (P2-114 spirit). Any bad value — non-numeric, zero, negative, per-room cap
// above the socket cap, frame cap above the protocol ceiling — refuses to
// boot: every reason is logged once here, no listener opens, exit 1. An
// empty env keeps the exact pre-P2-141 limits (1000 sockets / 10 per room /
// 1MB frames).
const LIMITS = relayLimits(process.env);
if (LIMITS.problems.length > 0) {
  for (const reason of LIMITS.problems) {
    ev("warn", "invalid relay limit, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
const { maxSockets, maxPerRoom, maxFrame, drainGraceMs } = LIMITS;
// P2-154: the optional TLS pair (RELAY_TLS_CERT + RELAY_TLS_KEY) is resolved
// fail-closed BEFORE any listener exists — metrics included. One variable
// without the other, a set-but-blank value, or an unreadable file each
// refuse the boot (exit 1, no listener) instead of silently serving plain
// HTTP on a public host or crashing with a stack trace that leaks the cert
// path. Both variables absent keeps the documented provider-TLS layout
// (P2-127 container: plain HTTP behind the terminator).
const TLS = tlsPlan(process.env, (path) => {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
});
if (TLS.problems.length > 0) {
  for (const reason of TLS.problems) {
    ev("warn", "invalid relay TLS pair, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
// per-connection rate limit on forwarded message frames (0 disables).
// Defaults are sized to pass the daemon's worst-case chunked transfer
// (MAX_CHUNKS = 512 frames, concurrent sessions interleaved on one socket)
// while still capping runaway or flooding connections. There are no
// exemptions: envelope metadata is client-controlled, so the only identity
// the relay verifies is the connection itself.
const RATE_PER_MIN = envNum("RELAY_RATE_PER_MIN", 600);
const RATE_BURST = envNum("RELAY_RATE_BURST", 1000);
const RATE_LIMIT_CLOSE = 4029; // custom 4xxx: "too many frames"
// live-connection cap per source IP (0 disables): the socket cap bounds the
// pool, but one host could otherwise hold all of its slots and deny every
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
// (phone lost wifi, laptop slept) stops holding a socket-cap slot and its
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

// --- optional metrics endpoint (bind configurable, token-optional) -----------
// P2-132: the bind address is configurable (RELAY_METRICS_BIND) so a scraper
// outside the container can reach it, and an optional bearer token
// (RELAY_METRICS_TOKEN) guards it. Fail-closed: a non-loopback bind without
// a token is logged once here instead of starting an unauthenticated
// network-exposed endpoint.
const METRICS = metricsBinding(process.env);
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
if (METRICS.port && METRICS.problems.length === 0) {
  createHttpServer((req, res) => {
    if (METRICS.token && !metricsAuthOk(req.headers.authorization, METRICS.token)) {
      res.writeHead(401).end();
      return;
    }
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
    .listen(METRICS.port, METRICS.host, () =>
      ev("info", "metrics listening", {
        port: METRICS.port,
        bind: METRICS.host,
        auth: Boolean(METRICS.token),
      }),
    );
} else {
  for (const reason of METRICS.problems) {
    ev("warn", "metrics endpoint disabled (fail-closed)", { reason });
  }
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

// optional TLS (P2-154): the plan resolved above already validated the pair —
// only a fully valid "tls" mode reaches file IO here; plain keeps the exact
// pre-P2-154 server (browsers refuse ws:// from https:// pages — mixed content)
const server =
  TLS.mode === "tls"
    ? createHttpsServer({ cert: readFileSync(TLS.certPath), key: readFileSync(TLS.keyPath) })
    : createHttpServer();
const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrame });
let counter = 0;

// P2-023: SIGTERM/SIGINT graceful shutdown — drain ≤3s, then exit 0.
// `launchctl kickstart -k` (deploy step 2) relies on this: clients get a
// close 1001 frame and a final JSONL line instead of a dead socket.
// P2-145: the controller's isShuttingDown flag is now consumed below —
// /healthz answers 503 while it runs and ws upgrades are refused, so the
// stage-4 load balancer stops routing NEW peers to a closing instance.
const { shutdown, isShuttingDown } = createShutdown({
  activeConnections: () => wss.clients.size,
  uptimeMs: () => Date.now() - m.startedAt,
  stopListeners: () => stopAccepting(server, wss.clients, ev),
  graceMs: drainGraceMs,
  log: ev,
  exit: (code) => process.exit(code),
  setTimeout,
  clearTimeout,
});

// public liveness probe for the hosted stage (no auth, counters only).
// Sits on the plain-HTTP request path; the ws upgrade path is handled below.
// P2-145: while draining it answers 503 {ok:false,draining:true} so the LB
// pulls this instance out of rotation before the sockets close.
server.on(
  "request",
  healthzHandler(
    {
      version: VERSION,
      startedAt: m.startedAt,
      rooms: () => rooms.size,
      roomsRejected: () => m.roomsRejected,
    },
    isShuttingDown,
  ),
);

// P2-145: upgrades are gated explicitly so the drain state can refuse them.
// A room admitted during the drain would receive a close 1001 milliseconds
// later; a plain 503 makes the LB/daemon retry the next instance instead.
server.on("upgrade", (req, socket, head) => {
  if (isShuttingDown()) {
    ev("warn", "upgrade refused: relay is draining", { path: req.url?.split("?")[0] });
    refuseUpgrade(socket);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => {
  ev("info", "relay listening", {
    port: PORT,
    tls: TLS.mode === "tls",
    // P2-154: additive provenance field — "env" when the relay terminates
    // TLS itself, "none" behind a provider terminator. No cert/key material
    // or path is ever logged here.
    tlsSource: TLS.mode === "tls" ? "env" : "none",
    maxFrame,
    maxPerRoom,
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
  if (wss.clients.size > maxSockets) {
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
    if ((rooms.get(frame.room)?.size ?? 0) > maxPerRoom) {
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

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
