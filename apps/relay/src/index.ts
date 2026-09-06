import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { accessSync, constants as fsConstants, createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { join as joinPath, sep } from "node:path";
import { randomBytes, X509Certificate } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
// relative imports carry .js specifiers so plain `node` can run the tsc emit
// (deploy/relay/Dockerfile + tsconfig.build.json) — tsx resolves them too
import { healthzHandler, type WebBudgetGate, type WebStatic } from "./healthz.js";
import { TokenBucket } from "./ratelimit.js";
import { IpCap, clientIp } from "./ipcap.js";
import { isValidRoomId, MAX_ROOMS_PER_SOCKET } from "./roomid.js";
import { createShutdown, refuseUpgrade, stopAccepting } from "./shutdown.js";
import { decideStale } from "./liveness.js";
import { metricsAuthOk, metricsBinding } from "./metricsbind.js";
import { relayLimits } from "./limits.js";
import { relayKnobs } from "./knobs.js";
import { resolveLogLevel, shouldLog, type LogLevel } from "./loglevel.js";
import { tlsPlan } from "./tlsconfig.js";
import {
  certExpiryVerdict,
  CERT_CLOCK_TOLERANCE_MS,
  CERT_WARN_WINDOW_MS,
  type CertExpiryVerdict,
} from "./certexpiry.js";
import { makeIpTagger } from "./iptag.js";
import {
  assetIntegrityPlan,
  indexAssetPlan,
  webRootPlan,
  WEB_INDEX_FILE,
  WEB_INDEX_MAX_BYTES,
  type AssetProbe,
  type DirProbe,
} from "./webroot.js";
import { resolveWebCsp } from "./webheaders.js";
import {
  resolveWebBudget,
  WebBudgets,
  webBudgetIdentity,
  WEB_BUDGET_IDLE_MS,
} from "./webbudget.js";
import {
  parseBufferCap,
  sendVerdict,
  SLOW_CONSUMER_CLOSE_CODE,
  SLOW_CONSUMER_CLOSE_REASON,
} from "./backpressure.js";
import { acceptVerdict, parseMaxSockets } from "./capacity.js";
import {
  budgetVerdict,
  parseRoomBudget,
  ROOM_BUDGET_CLOSE_CODE,
  ROOM_BUDGET_CLOSE_REASON,
  ROOM_BUDGET_WARN_REASON,
  type RoomBudgetLimits,
  type RoomBudgetState,
} from "./roombudget.js";
import {
  idleUnjoined,
  parseJoinDeadline,
  JOIN_UNJOINED_CLOSE_CODE,
  JOIN_UNJOINED_CLOSE_REASON,
} from "./joindeadline.js";

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
// P2-177: the log level resolves fail-closed BEFORE anything else logs or
// listens (same boot shape as the P2-141 limits, the P2-154 TLS pair and the
// P2-171 knobs). An unknown or non-string RELAY_LOG_LEVEL never falls back
// silently to the default: every reason is logged once here and the process
// exits 1 with no listener. An absent or blank variable keeps the default
// `info`, so an empty env reproduces the pre-P2-177 behavior exactly — and
// since a problem only ever resolves to that default, the refusal lines
// below always pass the ev() gate.
const LOG = resolveLogLevel(process.env);
if (LOG.problems.length > 0) {
  for (const reason of LOG.problems) {
    ev("warn", "invalid relay log level, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
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
// P2-259: an expired (or not-yet-valid) certificate used to be discovered
// only when every phone failed its handshake — the P2-154 preflight probed
// file readability alone. While the pair is in tls mode, the certificate's
// two validity instants are extracted here with the standard Node
// X509Certificate API (no new dependency; the key file is never read) and
// the verdict is consulted BEFORE any listener opens — metrics included,
// same refusal shape as the tlsPlan problems above: reason logged once,
// exit 1. A warn logs a single line and boot continues. Plain mode has no
// pair and therefore no validity to check — untouched. The relay stays
// blind: only the two instants are extracted, no certificate or key
// material ever reaches a log line (the phrases come from certexpiry.ts),
// and an unparseable certificate becomes NaN instants so the verdict
// refuses fail-closed instead of crashing with a stack trace.
const CERT_EXPIRY = (() => {
  if (TLS.mode !== "tls") return undefined;
  let notBefore = Number.NaN;
  let notAfter = Number.NaN;
  try {
    const cert = new X509Certificate(readFileSync(TLS.certPath));
    notBefore = Date.parse(cert.validFrom);
    notAfter = Date.parse(cert.validTo);
  } catch {
    // NaN instants: the verdict below refuses fail-closed
  }
  return {
    notBefore,
    notAfter,
    ...certExpiryVerdict(notBefore, notAfter, Date.now(), CERT_CLOCK_TOLERANCE_MS, CERT_WARN_WINDOW_MS),
  };
})();
if (CERT_EXPIRY && (CERT_EXPIRY.verdict === "refuse-expired" || CERT_EXPIRY.verdict === "refuse-not-yet-valid")) {
  ev("warn", "invalid relay TLS certificate, refusing to start (fail-closed)", { reason: CERT_EXPIRY.reason });
  process.exit(1);
}
if (CERT_EXPIRY && CERT_EXPIRY.verdict === "warn") {
  ev("warn", "relay TLS certificate nearing expiry", { reason: CERT_EXPIRY.reason });
}
// P2-259: the boot verdict is the baseline for the runtime deduplication —
// only transitions away from the last seen verdict ever log a line.
let lastCertExpiryVerdict: CertExpiryVerdict | undefined = CERT_EXPIRY?.verdict;
// P2-171: the remaining tuning knobs — per-connection rate limit, per-IP cap,
// trusted proxy hops and liveness sweep — resolve fail-closed like the P2-141
// limits above: a typo, a negative, fractional or zero value (zero is
// legitimate only for the proxy hops) or a value above the knob's documented
// ceiling refuses the boot instead of silently serving with the default. An
// empty env keeps the exact pre-P2-171 values (600/1000/20/0/30).
const KNOBS = relayKnobs(process.env);
if (KNOBS.problems.length > 0) {
  for (const reason of KNOBS.problems) {
    ev("warn", "invalid relay knob, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
const { ratePerMin: RATE_PER_MIN, rateBurst: RATE_BURST, maxPerIp: MAX_PER_IP, trustProxyHops: TRUST_PROXY_HOPS, pingIntervalS: PING_INTERVAL_S } = KNOBS;
// P2-188: the optional static web root (RELAY_WEB_DIR) resolves fail-closed
// like every knob above — a configured root that is missing, not a
// directory, unreadable or without a readable index.html refuses the boot
// (one log line per reason, exit 1, no listener). Absent or blank keeps the
// pre-P2-188 behavior byte for byte: no static route, /healthz-only HTTP.
const WEB = webRootPlan(
  process.env,
  (dir): DirProbe => {
    try {
      return statSync(dir).isDirectory() ? "ok" : "not-directory";
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    }
  },
  (dir) => {
    try {
      accessSync(joinPath(dir, WEB_INDEX_FILE), fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
);
// P2-225: a web root that passes the checks above can still be a partial or
// stale copy — exactly what a volume-mounted deploy that copies the bundle
// in two steps (or gets interrupted) looks like. The relay used to boot
// green, answer 200 on / and 404 on the entry document's JavaScript, and the
// phone showed a permanent white screen with no diagnostic anywhere. While
// the web root is enabled, the entry document is read (with an explicit
// 512 KiB ceiling — an overflow is a problem, never an unbounded read) and
// every local asset it references is probed with the same rigidity the
// static route enforces. The problems join the web-root ones in the SAME
// fail-closed block below, so an incomplete bundle logs one line per cause
// and exits 1 before any listener opens.
if (WEB.enabled) {
  const indexProblems: string[] = [];
  let html: string | undefined;
  try {
    const indexPath = joinPath(WEB.root, WEB_INDEX_FILE);
    const stat = statSync(indexPath);
    if (!stat.isFile()) {
      indexProblems.push(
        "RELAY_WEB_DIR contains an index.html that is not a regular file: " +
          "refusing to boot with an unusable web root (fail-closed)",
      );
    } else if (stat.size > WEB_INDEX_MAX_BYTES) {
      indexProblems.push(
        "RELAY_WEB_DIR index.html is above the boot ceiling of " +
          `${WEB_INDEX_MAX_BYTES} bytes: refusing to boot instead of reading an oversized entry document (fail-closed)`,
      );
    } else {
      const text = readFileSync(indexPath, "utf8");
      if (Buffer.byteLength(text) > WEB_INDEX_MAX_BYTES) {
        indexProblems.push(
          "RELAY_WEB_DIR index.html is above the boot ceiling of " +
            `${WEB_INDEX_MAX_BYTES} bytes: refusing to boot instead of reading an oversized entry document (fail-closed)`,
        );
      } else {
        html = text;
      }
    }
  } catch {
    indexProblems.push(
      "RELAY_WEB_DIR index.html could not be read at boot: " +
        "refusing to boot with an unverifiable entry document (fail-closed)",
    );
  }
  if (html !== undefined) {
    indexProblems.push(
      ...assetIntegrityPlan(indexAssetPlan(html), WEB.root, (abs): AssetProbe => {
        try {
          accessSync(abs, fsConstants.R_OK);
          return "ok";
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
        }
      }),
    );
  }
  WEB.problems.push(...indexProblems);
}
if (WEB.problems.length > 0) {
  for (const reason of WEB.problems) {
    ev("warn", "invalid relay web root, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
// P2-192: the override content policy (RELAY_WEB_CSP) resolves fail-closed
// alongside the web root above — a non-string, control-byte-carrying,
// oversized or default-src-less value refuses the boot (one log line per
// reason, exit 1, no listener) instead of serving the page where the user's
// E2E keys live with an unvalidated policy. Absent or blank keeps the
// documented default policy with zero problems.
const WEB_CSP = resolveWebCsp(process.env);
if (WEB_CSP.problems.length > 0) {
  for (const reason of WEB_CSP.problems) {
    ev("warn", "invalid relay web content policy, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
// P2-195: the static route's request budget (RELAY_WEB_RATE_PER_MIN +
// RELAY_WEB_BURST) resolves fail-closed alongside every knob above — a
// non-numeric, negative, zero, fractional or above-ceiling value refuses the
// boot (one log line per reason, exit 1, no listener) instead of serving the
// static route with an unvalidated budget. Absent or blank keeps the
// documented defaults; the budget only gates the static route — the probe
// and the WebSocket upgrade path are never counted.
const WEB_BUDGET = resolveWebBudget(process.env);
if (WEB_BUDGET.problems.length > 0) {
  for (const reason of WEB_BUDGET.problems) {
    ev("warn", "invalid relay web budget, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
// P2-217: the per-socket backpressure cap (RELAY_BUFFER_CAP_BYTES) resolves
// fail-closed like every knob above — a non-numeric, zero, negative,
// fractional or above-ceiling value refuses the boot (one log line per
// reason, exit 1, no listener) instead of serving with an unvalidated cap.
// Absent or blank keeps the documented 4 MiB default; the cap gates only the
// forwarding loop below — admission, rate limits and the frame-size cap are
// untouched.
const BUFFER_CAP = parseBufferCap(process.env);
if (BUFFER_CAP.problems.length > 0) {
  for (const reason of BUFFER_CAP.problems) {
    ev("warn", "invalid relay buffer cap, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
const bufferCapBytes = BUFFER_CAP.cap;
// P2-227: the process-wide socket capacity (RELAY_MAX_SOCKETS_GLOBAL) resolves
// fail-closed like every knob above — a non-numeric, zero, negative,
// fractional or above-ceiling value refuses the boot (one log line per
// reason, exit 1, no listener) instead of serving with an unvalidated cap.
// Absent or blank keeps the documented default; the cap gates only the
// admission check below — the per-IP cap, the frame-size cap and the
// backpressure verdict are untouched.
const CAPACITY = parseMaxSockets(process.env);
if (CAPACITY.problems.length > 0) {
  for (const reason of CAPACITY.problems) {
    ev("warn", "invalid relay socket capacity, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
const maxSocketsGlobal = CAPACITY.maxSockets;
// P2-230: the join deadline (RELAY_JOIN_DEADLINE_MS) resolves fail-closed
// like every knob above — a non-numeric, zero, negative, fractional or
// above-ceiling value refuses the boot (one log line per reason, exit 1, no
// listener) instead of serving with an unvalidated deadline. Absent or blank
// keeps the documented default; the documented disable value (-1) turns the
// reaper off entirely.
const JOIN_DEADLINE = parseJoinDeadline(process.env);
if (JOIN_DEADLINE.problems.length > 0) {
  for (const reason of JOIN_DEADLINE.problems) {
    ev("warn", "invalid relay join deadline, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
const joinDeadlineMs = JOIN_DEADLINE.deadlineMs;
// P2-243: the per-room accumulated-volume budget (RELAY_ROOM_BUDGET_WINDOW_MS
// + RELAY_ROOM_BUDGET_BYTES) resolves fail-closed like every knob above — a
// non-numeric, zero, negative (other than the documented -1 disable value),
// fractional or above-ceiling value refuses the boot (one log line per
// reason, exit 1, no listener) instead of serving with an unvalidated
// budget. Absent or blank keeps the documented defaults (1 GiB per room per
// 1 h window); the budget gates only the forwarding loop below — admission,
// the frame-size cap, the rate bucket and the backpressure verdict are
// untouched.
const ROOM_BUDGET = parseRoomBudget(process.env);
if (ROOM_BUDGET.problems.length > 0) {
  for (const reason of ROOM_BUDGET.problems) {
    ev("warn", "invalid relay room budget, refusing to start (fail-closed)", { reason });
  }
  process.exit(1);
}
const roomBudgetLimits: RoomBudgetLimits = { windowMs: ROOM_BUDGET.windowMs, capBytes: ROOM_BUDGET.capBytes };
// The only fs touches of the static route: existence/file checks per request
// and a streamed body (empty for HEAD). isFile canonicalizes the target with
// realpath before the containment comparison — with a separator boundary, so
// a sibling directory sharing the root's name as a string prefix
// (<root>-backup) or a symlink planted inside the root pointing outside it
// is rejected (404). Paths are never logged.
const WEB_STATIC: WebStatic | undefined = WEB.enabled
  ? {
      root: WEB.root,
      isFile: (abs) => {
        try {
          return statSync(abs).isFile() && realpathSync(abs).startsWith(realpathSync(WEB.root) + sep);
        } catch {
          return false;
        }
      },
      send: (abs, req, res) => {
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        createReadStream(abs)
          .on("error", () => {
            if (res.headersSent) res.destroy();
            else res.writeHead(404).end();
          })
          .pipe(res);
      },
      // P2-192: the resolved policy plus the per-request TLS signal —
      // TLSSocket.encrypted — so HSTS is announced only when the request
      // actually arrived under TLS.
      csp: WEB_CSP.csp,
      isTls: (req) => (req.socket as { encrypted?: boolean }).encrypted === true,
    }
  : undefined;
const RATE_LIMIT_CLOSE = 4029; // custom 4xxx: "too many frames"
const ipCap = new IpCap(MAX_PER_IP);
// P2-174: the only personal datum the relay ever logged was the raw client
// address on the per-IP-cap rejection line — hosted, that lands in provider
// log retention. From now on the log carries ipTag: the first 12 hex digits
// of sha256(salt || address) with a fresh random salt per boot. Stable within
// this process (same tag ⇒ same origin), different across restarts,
// irreversible. The raw address below stays the IpCap key exactly as before;
// only what reaches a log line changed.
const tagIp = makeIpTagger(randomBytes(32));

// P2-195: the static route's live bucket map, keyed by the derived identity
// tag (see the gate below). Pruned by inactivity from the liveness sweep;
// the entry cap inside WebBudgets is the hard memory bound.
const WEB_BUDGETS = new WebBudgets(WEB_BUDGET.ratePerMin, WEB_BUDGET.burst);
// The gate derives the same identity the upgrade path derives — clientIp()
// honoring RELAY_TRUST_PROXY_HOPS, tagged by the P2-174 ipTag — so the map
// never holds a raw address and a trusted proxy chain collapses to the same
// bucket the per-IP cap already uses. Only the static route is gated: the
// /healthz probe answers before the budget is consulted and upgrades never
// reach the request path.
const WEB_BUDGET_GATE: WebBudgetGate | undefined = WEB.enabled
  ? {
      take: (req, nowMs) => WEB_BUDGETS.take(webBudgetIdentity(req, TRUST_PROXY_HOPS, tagIp), nowMs),
    }
  : undefined;

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

interface Socket extends WebSocket {
  id?: string;
  rooms?: Set<string>;
  bucket?: TokenBucket;
  ip?: string;
  released?: boolean;
  lastSeen?: number;
  // P2-230: when the connection was accepted and whether it ever entered a
  // room — the join-deadline reaper's only two inputs (joindeadline.ts).
  openedAt?: number;
  joinedRoom?: boolean;
}

const rooms = new Map<string, Set<Socket>>();

// P2-243: accumulated per-room volume within the tumbling window, keyed by
// room id. Written only on the forwarding path (no timer, no sweep) and
// discarded in leaveAll the moment the room itself dies, so the map can
// never outgrow `rooms`.
const roomBudgets = new Map<string, RoomBudgetState>();

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
  slowConsumers: 0,
  capacityRefused: 0,
  // P2-230: sockets closed for never having joined any room.
  idleUnjoinedClosed: 0,
  // P2-243: rooms closed for moving more bytes than the window budget allows.
  roomBudgetTerminated: 0,
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
          "# TYPE relay_slow_consumers_total counter",
          `relay_slow_consumers_total ${m.slowConsumers}`,
          "# TYPE relay_capacity_refused_total counter",
          `relay_capacity_refused_total ${m.capacityRefused}`,
          "# TYPE relay_idle_unjoined_closed counter",
          `relay_idle_unjoined_closed ${m.idleUnjoinedClosed}`,
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
            slow_consumers_total: m.slowConsumers,
            capacity_refused_total: m.capacityRefused,
            idle_unjoined_closed: m.idleUnjoinedClosed,
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
  // P2-230: marks the peer as established for the join-deadline reaper —
  // once a socket entered any room it is never closed for idleness.
  socket.joinedRoom = true;
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
    if (rooms.get(room)?.size === 0) {
      rooms.delete(room);
      // P2-243: the budget state dies with the room — the map never holds
      // an entry for a room that no longer exists.
      roomBudgets.delete(room);
    }
  }
}

// P2-177: entries below the configured level are dropped before the line is
// written — the only gate between a relay event and stdout. The default
// `info` keeps every warn/info line (rejections, rate limits, lifecycle)
// while the per-frame `frame in` line only exists at `debug`.
function ev(level: LogLevel, msg: string, data?: unknown) {
  if (!shouldLog(LOG.level, level)) return;
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
      // P2-243: additive — rooms closed by the per-room volume budget.
      roomsBudgetTerminated: () => m.roomBudgetTerminated,
    },
    isShuttingDown,
    // P2-188: optional static PWA route (RELAY_WEB_DIR); undefined keeps the
    // pre-P2-188 404-for-everything-else behavior byte for byte.
    WEB_STATIC,
    // P2-195: optional per-identity request budget for the static route
    // (429 + retry-after on burst exhaustion; the probe is never counted).
    WEB_BUDGET_GATE,
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
    // P2-217: additive provenance field — the resolved per-socket backpressure
    // cap in bytes. No pre-existing field changed name or meaning.
    bufferCapBytes,
    // P2-227: additive provenance field — the resolved process-wide live
    // socket capacity. No pre-existing field changed name or meaning.
    maxSocketsGlobal,
    // P2-230: additive provenance field — the resolved join deadline in ms
    // (JOIN_DEADLINE_MS_DISABLED when the reaper is disabled). No
    // pre-existing field changed name or meaning.
    joinDeadlineMs,
    // P2-243: additive provenance fields — the resolved per-room volume
    // budget (capBytes is ROOM_BUDGET_BYTES_DISABLED when the budget is
    // disabled). No pre-existing field changed name or meaning.
    roomBudgetWindowMs: ROOM_BUDGET.windowMs,
    roomBudgetCapBytes: ROOM_BUDGET.capBytes,
    // P2-177: additive provenance field — the resolved log level this
    // process writes at. No pre-existing field changed name or meaning.
    logLevel: LOG.level,
    // P2-188: additive provenance field — whether the static PWA route is
    // serving (RELAY_WEB_DIR configured and validated). Never the path.
    webRoot: WEB.enabled,
    // P2-195: additive provenance field — the resolved static-route budget
    // when the web root is enabled (absent from the JSON line otherwise).
    webBudget: WEB.enabled
      ? { ratePerMin: WEB_BUDGET.ratePerMin, burst: WEB_BUDGET.burst }
      : undefined,
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
    // ipTag, never ip (P2-174): the derived identifier keeps triage possible
    // without writing the user's address into retained provider logs.
    ev("warn", "connection rejected: per-IP cap exceeded", { ipTag: tagIp(ip) });
    socket.close(1013, "too many connections");
    return;
  }
  // P2-227: process-wide capacity gate — the last admission check, after the
  // per-IP cap and before the connection is accepted into the relay (the ws
  // client is already inside wss.clients here, so the count is the live
  // total). A refusal closes ONLY this one socket: no room is touched, no
  // established connection is affected. The per-IP slot this attempt took is
  // given back, so a flood of refusals cannot leak per-IP budgets.
  const capacity = acceptVerdict(wss.clients.size, maxSocketsGlobal);
  if (capacity.action === "refuse") {
    ipCap.release(ip);
    m.capacityRefused++;
    ev("warn", "connection refused: process at socket capacity", { count: m.capacityRefused, reason: capacity.reason });
    socket.close(1013, "server busy");
    return;
  }
  socket.ip = ip;
  socket.id = `s${Date.now().toString(36)}${(counter++).toString(36)}`;
  socket.rooms = new Set();
  socket.lastSeen = Date.now();
  // P2-230: the join-deadline baseline — stamped only after every admission
  // check passed, so a socket without this stamp is never reaped.
  socket.openedAt = Date.now();
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

    // P2-177: debug-only. Hosted, a line per routed message reconstructs
    // who talked to whom and when out of provider-retained stdout — the
    // same metadata leak class P2-174 closed for client addresses — and
    // costs volume proportional to traffic. The default `info` level
    // routes in silence; the routing itself is unchanged.
    ev("debug", "frame in", {
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
    const out = JSON.stringify({
      room: frame.room,
      from: frame.from ?? socket.id,
      seq: frame.seq,
      payload: frame.payload,
    });
    // P2-243: per-room accumulated-volume verdict, consulted at the SAME
    // forwarding point as the token bucket above and the per-socket
    // backpressure verdict in the loop below — no new timer, no sweep, boot
    // unchanged. Only this frame's serialized byte count is counted: never
    // its content, never an envelope field, never any identity. The state
    // dies with the room (leaveAll), so the map cannot grow forever.
    const budget = budgetVerdict(roomBudgets.get(frame.room), Date.now(), out.length, roomBudgetLimits);
    roomBudgets.set(frame.room, budget.state);
    if (budget.plan.action === "terminate") {
      m.roomBudgetTerminated++;
      ev("warn", "room closed: volume above the window budget", {
        room: frame.room.slice(0, 8),
        count: m.roomBudgetTerminated,
        reason: ROOM_BUDGET_CLOSE_REASON,
      });
      // the same close path every policy close uses (room full, slow
      // consumer): each socket of the room closes alone and runs the normal
      // close path — per-IP slot release included
      for (const t of [...targets]) t.close(ROOM_BUDGET_CLOSE_CODE, ROOM_BUDGET_CLOSE_REASON);
      return;
    }
    if (budget.plan.action === "warn") {
      // at most ONE line per room per window (budgetVerdict's warned flag)
      ev("warn", "room nearing the window volume budget", {
        room: frame.room.slice(0, 8),
        reason: ROOM_BUDGET_WARN_REASON,
      });
    }
    m.framesRouted++;
    m.bytesRouted += frame.payload.length;
    for (const t of targets) {
      if (t === socket || t.readyState !== t.OPEN) continue;
      // P2-217: backpressure gate — consult the target's own accumulated
      // outgoing bytes BEFORE every send. Only two outcomes exist: queue the
      // frame, or close the slow socket (never a silent drop — the relay is
      // blind and could not re-send it). The close touches only this target;
      // the sender and every other peer of the room keep routing.
      const verdict = sendVerdict(t.bufferedAmount, out.length, bufferCapBytes);
      if (verdict.action === "close-slow") {
        m.slowConsumers++;
        ev("warn", "slow consumer closed", { count: m.slowConsumers, reason: verdict.reason });
        t.close(SLOW_CONSUMER_CLOSE_CODE, SLOW_CONSUMER_CLOSE_REASON);
        continue;
      }
      t.send(out);
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
    // P2-259 runtime re-evaluation: the boot decision is re-checked on the
    // SAME sweep tick the ping interval already schedules — no new timer,
    // and only while a TLS pair exists. Strictly log-only: it never closes
    // a socket, never exits the process, never refuses a connection and
    // never alters the healthz body (byte-for-byte the same in the healthy
    // and the P2-145 drain case) — dropping live conversations over a date
    // would be worse than the problem. One deduplicated line per verdict
    // transition.
    if (CERT_EXPIRY) {
      const nextCert = certExpiryVerdict(
        CERT_EXPIRY.notBefore,
        CERT_EXPIRY.notAfter,
        now,
        CERT_CLOCK_TOLERANCE_MS,
        CERT_WARN_WINDOW_MS,
      );
      if (nextCert.verdict !== lastCertExpiryVerdict) {
        lastCertExpiryVerdict = nextCert.verdict;
        ev("warn", "relay TLS certificate validity changed state", { reason: nextCert.reason });
      }
    }
    for (const dead of decideStale(now, wss.clients as Set<Socket>, PING_INTERVAL_S, PING_INTERVAL_S)) {
      m.staleTerminated++;
      ev("info", "stale socket terminated", { id: dead.id, silentS: PING_INTERVAL_S * 2 });
      dead.terminate();
    }
    // P2-230: reap sockets that connected but never entered any room — the
    // browser's automatic pong keeps them "alive" for the liveness verdict
    // while they hold a global-cap and per-IP slot forever. Consulted inside
    // the SAME periodic sweep as the liveness verdict: no new timer. The
    // only effect is closing that one socket with the policy code below;
    // established rooms, the frame grammar, the admission caps and the
    // slow-consumer verdict are untouched, and the normal close path (per-IP
    // slot release) runs exactly as on any other hangup. The warn line
    // carries the counter and the fixed reason only — never a room id, a
    // client address or a payload excerpt (P2-174/P2-177).
    for (const idle of idleUnjoined(now, wss.clients as Set<Socket>, joinDeadlineMs)) {
      m.idleUnjoinedClosed++;
      ev("warn", "connection closed: never joined a room", {
        count: m.idleUnjoinedClosed,
        reason: JOIN_UNJOINED_CLOSE_REASON,
      });
      idle.close(JOIN_UNJOINED_CLOSE_CODE, JOIN_UNJOINED_CLOSE_REASON);
    }
    for (const c of wss.clients) {
      if (c.readyState === c.OPEN) c.ping();
    }
    // P2-195: idle web-budget buckets ride the same sweep — the entry cap
    // inside WebBudgets is the hard bound, this returns the memory of
    // long-gone clients between sweeps.
    if (WEB.enabled) {
      const pruned = WEB_BUDGETS.prune(now, WEB_BUDGET_IDLE_MS);
      if (pruned > 0) ev("debug", "web budget buckets pruned", { pruned });
    }
  }, PING_INTERVAL_S * 1000);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
