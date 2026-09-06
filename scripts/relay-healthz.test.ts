/**
 * Unit tests for the relay /healthz handler (P2-018): public liveness probe
 * for the hosted stage. Verifies the 200 + payload shape, the 404 fallback
 * for non-probe traffic, and that no room ids or secrets leak.
 * Run: npx tsx scripts/relay-healthz.test.ts
 */
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { healthzHandler, healthzPayload, WEB_ENCODING_CACHE } from "../apps/relay/src/healthz";
import { metricsAuthOk, metricsBinding } from "../apps/relay/src/metricsbind";
import { DRAIN_GRACE_MS_CEILING, MAX_FRAME_CEILING, relayLimits } from "../apps/relay/src/limits";
import { createShutdown, DRAIN_MS, refuseUpgrade } from "../apps/relay/src/shutdown";
import {
  cacheControlFor,
  contentTypeFor,
  resolveWebPath,
  spaFallbackPath,
  webRootPlan,
} from "../apps/relay/src/webroot";
import { securityHeaders, resolveWebCsp, WEB_CSP_DEFAULT, WEB_CSP_MAX_LENGTH } from "../apps/relay/src/webheaders";
import { makeIpTagger } from "../apps/relay/src/iptag";
import {
  resolveWebBudget,
  WebBudgets,
  webBudgetDecision,
  webBudgetIdentity,
  WEB_BURST_CEILING,
  WEB_BURST_DEFAULT,
  WEB_RATE_PER_MIN_CEILING,
  WEB_RATE_PER_MIN_DEFAULT,
} from "../apps/relay/src/webbudget";
import {
  negotiateEncoding,
  WebEncodingCache,
  webEncodingCacheKey,
  WEB_ENCODING_MAX_BYTES,
  WEB_ENCODING_MIN_BYTES,
} from "../apps/relay/src/webencoding";
import { conditionalVerdict, etagFor } from "../apps/relay/src/webcond";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("relay-healthz test timed out (global 15s)");
  process.exit(1);
}, 15_000).unref();

// --- 1. pure payload: shape and uptime math ---------------------------------
const START = 1_000_000;
const p = healthzPayload(
  { version: "0.2.0", startedAt: START, rooms: () => 3, roomsRejected: () => 5 },
  START + 90_000,
);
check("payload: ok is literal true", p.ok === true);
check("payload: version is the monorepo version", p.version === "0.2.0");
check("payload: uptimeS is whole seconds", p.uptimeS === 90);
check("payload: rooms is the live count", p.rooms === 3);
check("payload: roomsRejected is the live counter", p.roomsRejected === 5);
check(
  "payload: exactly the five specified fields",
  JSON.stringify(Object.keys(p).sort()) ===
    JSON.stringify(["ok", "rooms", "roomsRejected", "uptimeS", "version"]),
);
check(
  "payload: clamps negative uptime",
  healthzPayload({ version: "v", startedAt: 5000, rooms: () => 0, roomsRejected: () => 0 }, 1000)
    .uptimeS === 0,
);

// --- 2. handler over real HTTP: 200 + JSON shape -----------------------------
const state = { version: "0.2.0", startedAt: Date.now(), rooms: () => 7, roomsRejected: () => 2 };
const server: Server = createServer(healthzHandler(state));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

function request(method: string, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve) => {
    const req = get(`http://127.0.0.1:${port}${path}`, { method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }));
    });
    req.end();
  });
}

const ok = await request("GET", "/healthz");
check("handler: GET /healthz answers 200", ok.status === 200);
check("handler: content-type application/json", ok.type === "application/json");
const parsed = JSON.parse(ok.body) as {
  ok: boolean;
  version: string;
  uptimeS: number;
  rooms: number;
  roomsRejected: number;
};
check("handler: body shape {ok,version,uptimeS,rooms,roomsRejected}", parsed.ok === true && typeof parsed.version === "string" && typeof parsed.uptimeS === "number" && Number.isInteger(parsed.uptimeS) && typeof parsed.rooms === "number" && typeof parsed.roomsRejected === "number");
check("handler: rooms reflects live room count", parsed.rooms === 7);
check("handler: roomsRejected reflects live counter", parsed.roomsRejected === 2);

// query strings must not change routing
const withQuery = await request("GET", "/healthz?probe=lb");
check("handler: query string tolerated", withQuery.status === 200);

// only the probe is served over plain HTTP
check("handler: other paths get 404", (await request("GET", "/other")).status === 404);
check("handler: non-GET on probe path gets 404", (await request("POST", "/healthz")).status === 404);

server.close();

// --- 3. metrics binding decision (P2-132, pure functions) --------------------
// The relay boot starts the listener only when `port > 0 && problems.length
// === 0`; these checks exercise that exact expression on the pure result.

check("metrics: absent port turns everything off", (() => {
  const b = metricsBinding({});
  return b.port === 0 && b.host === "127.0.0.1" && b.token === "" && b.problems.length === 0;
})());
check("metrics: port 0 turns everything off", metricsBinding({ RELAY_METRICS_PORT: "0" }).port === 0);
check("metrics: garbage port is off, not a crash", metricsBinding({ RELAY_METRICS_PORT: "abc" }).port === 0);

check("metrics: loopback bind without token keeps current behavior", (() => {
  const b = metricsBinding({ RELAY_METRICS_PORT: "9100" });
  return b.port === 9100 && b.host === "127.0.0.1" && b.token === "" && b.problems.length === 0;
})());
check("metrics: explicit loopback bind without token allowed", (() => {
  const b = metricsBinding({ RELAY_METRICS_PORT: "9100", RELAY_METRICS_BIND: "127.0.0.1" });
  return b.port === 9100 && b.problems.length === 0;
})());

check("metrics: public bind without token is a problem, listener must not start", (() => {
  const b = metricsBinding({ RELAY_METRICS_PORT: "9100", RELAY_METRICS_BIND: "0.0.0.0" });
  return b.problems.length > 0 && !(b.port > 0 && b.problems.length === 0);
})());
check("metrics: unknown hostname counts as non-loopback (fail-closed)", (() => {
  const b = metricsBinding({ RELAY_METRICS_PORT: "9100", RELAY_METRICS_BIND: "metrics.internal" });
  return b.problems.length > 0;
})());

check("metrics: public bind with token accepted", (() => {
  const b = metricsBinding({
    RELAY_METRICS_PORT: "9100",
    RELAY_METRICS_BIND: "0.0.0.0",
    RELAY_METRICS_TOKEN: "s3cret",
  });
  return b.port === 9100 && b.host === "0.0.0.0" && b.token === "s3cret" && b.problems.length === 0;
})());
check("metrics: loopback with token also accepted", (() => {
  const b = metricsBinding({ RELAY_METRICS_PORT: "9100", RELAY_METRICS_TOKEN: "s3cret" });
  return b.port === 9100 && b.problems.length === 0 && b.token === "s3cret";
})());

// --- 4. metrics auth: constant-time bearer check (P2-132, pure function) -----
const TOKEN = "s3cret";
check("metrics auth: missing header rejected", metricsAuthOk(undefined, TOKEN) === false);
check("metrics auth: wrong prefix rejected", metricsAuthOk("Basic s3cret", TOKEN) === false);
check("metrics auth: bare scheme without token rejected", metricsAuthOk("Bearer", TOKEN) === false);
check("metrics auth: wrong token rejected", metricsAuthOk("Bearer nope", TOKEN) === false);
check("metrics auth: token sharing a prefix with the real one rejected", metricsAuthOk("Bearer s3cret-", TOKEN) === false);
check("metrics auth: correct bearer accepted", metricsAuthOk("Bearer s3cret", TOKEN) === true);
check("metrics auth: empty expected token never authenticates", metricsAuthOk("Bearer s3cret", "") === false);

// --- 5. admission limits (P2-141, pure function) ------------------------------
// The relay boot opens its listener only when `problems.length === 0`;
// these checks exercise that exact expression on the pure result. Empty env
// must reproduce the pre-P2-141 hardcoded behavior exactly.

check("limits: empty env keeps current behavior (1000/10/1MB, no problems)", (() => {
  const l = relayLimits({});
  return (
    l.maxSockets === 1000 &&
    l.maxPerRoom === 10 &&
    l.maxFrame === 1_000_000 &&
    l.problems.length === 0
  );
})());
check("limits: blank values keep the defaults too", (() => {
  const l = relayLimits({ RELAY_MAX_SOCKETS: "  ", RELAY_MAX_PER_ROOM: "", RELAY_MAX_FRAME_BYTES: "" });
  return l.maxSockets === 1000 && l.maxPerRoom === 10 && l.maxFrame === 1_000_000 && l.problems.length === 0;
})());

check("limits: RELAY_MAX_SOCKETS override in isolation", (() => {
  const l = relayLimits({ RELAY_MAX_SOCKETS: "2000" });
  return l.maxSockets === 2000 && l.maxPerRoom === 10 && l.maxFrame === 1_000_000 && l.problems.length === 0;
})());
check("limits: RELAY_MAX_PER_ROOM override in isolation", (() => {
  const l = relayLimits({ RELAY_MAX_PER_ROOM: "25" });
  return l.maxSockets === 1000 && l.maxPerRoom === 25 && l.maxFrame === 1_000_000 && l.problems.length === 0;
})());
check("limits: RELAY_MAX_FRAME_BYTES override in isolation", (() => {
  const l = relayLimits({ RELAY_MAX_FRAME_BYTES: "2000000" });
  return l.maxSockets === 1000 && l.maxPerRoom === 10 && l.maxFrame === 2_000_000 && l.problems.length === 0;
})());

check("limits: non-numeric RELAY_MAX_SOCKETS is a problem", relayLimits({ RELAY_MAX_SOCKETS: "abc" }).problems.length > 0);
check("limits: non-numeric RELAY_MAX_PER_ROOM is a problem", relayLimits({ RELAY_MAX_PER_ROOM: "ten" }).problems.length > 0);
check("limits: non-numeric RELAY_MAX_FRAME_BYTES is a problem", relayLimits({ RELAY_MAX_FRAME_BYTES: "abc" }).problems.length > 0);
check("limits: Infinity is non-numeric (fail-closed)", relayLimits({ RELAY_MAX_SOCKETS: "Infinity" }).problems.length > 0);
check("limits: problems name the offending variable", (() => {
  const l = relayLimits({ RELAY_MAX_FRAME_BYTES: "abc" });
  return l.problems.length === 1 && l.problems[0].includes("RELAY_MAX_FRAME_BYTES");
})());

check("limits: zero RELAY_MAX_SOCKETS is a problem", relayLimits({ RELAY_MAX_SOCKETS: "0" }).problems.length > 0);
check("limits: zero RELAY_MAX_PER_ROOM is a problem", relayLimits({ RELAY_MAX_PER_ROOM: "0" }).problems.length > 0);
check("limits: zero RELAY_MAX_FRAME_BYTES is a problem", relayLimits({ RELAY_MAX_FRAME_BYTES: "0" }).problems.length > 0);
check("limits: negative RELAY_MAX_SOCKETS is a problem", relayLimits({ RELAY_MAX_SOCKETS: "-1" }).problems.length > 0);
check("limits: negative RELAY_MAX_PER_ROOM is a problem", relayLimits({ RELAY_MAX_PER_ROOM: "-3" }).problems.length > 0);
check("limits: negative RELAY_MAX_FRAME_BYTES is a problem", relayLimits({ RELAY_MAX_FRAME_BYTES: "-1" }).problems.length > 0);

check("limits: maxPerRoom above maxSockets is a problem", (() => {
  const l = relayLimits({ RELAY_MAX_SOCKETS: "5", RELAY_MAX_PER_ROOM: "6" });
  return l.problems.length === 1 && l.problems[0].includes("RELAY_MAX_PER_ROOM");
})());
check("limits: maxPerRoom equal to maxSockets is fine", (() => {
  const l = relayLimits({ RELAY_MAX_SOCKETS: "10", RELAY_MAX_PER_ROOM: "10" });
  return l.problems.length === 0 && l.maxSockets === 10 && l.maxPerRoom === 10;
})());

check("limits: frame one byte above the ceiling is a problem", (() => {
  const l = relayLimits({ RELAY_MAX_FRAME_BYTES: String(MAX_FRAME_CEILING + 1) });
  return l.problems.length === 1 && l.problems[0].includes("RELAY_MAX_FRAME_BYTES");
})());
check("limits: frame exactly at the ceiling is fine", (() => {
  const l = relayLimits({ RELAY_MAX_FRAME_BYTES: String(MAX_FRAME_CEILING) });
  return l.problems.length === 0 && l.maxFrame === MAX_FRAME_CEILING;
})());
check("limits: ceiling is the int32 ws maxPayload bound (16 MiB)", MAX_FRAME_CEILING === 16_777_216);

// --- 6. drain-aware probe (P2-145): additive draining field -------------------
// While the relay drains, the load balancer must see 503 {ok:false,draining:
// true} so it stops routing NEW peers to a closing instance; a healthy
// instance keeps the exact pre-P2-145 body.
const DRAIN_START = 1_000_000;
const drainState = { version: "0.2.0", startedAt: DRAIN_START, rooms: () => 3, roomsRejected: () => 5 };

check(
  "drain: healthy payload is byte-for-byte the pre-P2-145 body",
  JSON.stringify(healthzPayload(drainState, DRAIN_START + 90_000)) ===
    '{"ok":true,"version":"0.2.0","uptimeS":90,"rooms":3,"roomsRejected":5}',
);
const drainedPayload = healthzPayload(drainState, DRAIN_START + 90_000, true);
check(
  "drain: draining payload flips ok and adds draining:true",
  drainedPayload.ok === false && drainedPayload.draining === true,
);
check(
  "drain: draining payload keeps every existing field (additive only)",
  drainedPayload.version === "0.2.0" &&
    drainedPayload.uptimeS === 90 &&
    drainedPayload.rooms === 3 &&
    drainedPayload.roomsRejected === 5,
);

const drainFlag = { active: false };
const drainServer: Server = createServer(healthzHandler(drainState, () => drainFlag.active));
await new Promise<void>((r) => drainServer.listen(0, "127.0.0.1", r));
const drainPort = (drainServer.address() as { port: number }).port;

function probe(): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve) => {
    get(`http://127.0.0.1:${drainPort}/healthz`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }));
    }).end();
  });
}

const probeHealthy = await probe();
check("drain: healthy handler answers 200 with ok:true", probeHealthy.status === 200 && JSON.parse(probeHealthy.body).ok === true);
check(
  "drain: healthy body is byte-for-byte the pre-P2-145 format (exact key order, no draining field)",
  !probeHealthy.body.includes("draining") &&
    probeHealthy.body ===
      `{"ok":true,"version":"0.2.0","uptimeS":${(JSON.parse(probeHealthy.body) as { uptimeS: number }).uptimeS},"rooms":3,"roomsRejected":5}`,
);
drainFlag.active = true;
const probeDraining = await probe();
check("drain: draining handler answers 503", probeDraining.status === 503);
check("drain: draining handler keeps content-type application/json", probeDraining.type === "application/json");
const probeParsed = JSON.parse(probeDraining.body) as { ok: boolean; draining: true; rooms: number; roomsRejected: number; uptimeS: number; version: string };
check(
  "drain: draining body is {ok:false,draining:true} plus every existing field",
  probeParsed.ok === false &&
    probeParsed.draining === true &&
    probeParsed.version === "0.2.0" &&
    typeof probeParsed.uptimeS === "number" &&
    probeParsed.rooms === 3 &&
    probeParsed.roomsRejected === 5,
);
drainFlag.active = false;
check("drain: probe returns 200 once draining ends", (await probe()).status === 200);
drainServer.close();

// --- 6b. room-budget counter (P2-243): additive payload field ------------------
const budgetState = {
  version: "0.2.0",
  startedAt: START,
  rooms: () => 1,
  roomsRejected: () => 0,
  roomsBudgetTerminated: () => 3,
};
const withBudget = healthzPayload(budgetState, START + 90_000);
check("budget-counter: payload carries the additive roomsBudgetTerminated field", withBudget.roomsBudgetTerminated === 3);
check(
  "budget-counter: payload keeps every pre-existing field untouched",
  withBudget.ok === true &&
    withBudget.version === "0.2.0" &&
    withBudget.uptimeS === 90 &&
    withBudget.rooms === 1 &&
    withBudget.roomsRejected === 0,
);
check(
  "budget-counter: absent getter keeps the exact pre-P2-243 five-field body",
  (() => {
    const p = healthzPayload({ version: "0.2.0", startedAt: START, rooms: () => 0, roomsRejected: () => 0 }, START);
    return (
      JSON.stringify(Object.keys(p).sort()) ===
        JSON.stringify(["ok", "rooms", "roomsRejected", "uptimeS", "version"])
    );
  })(),
);
const budgetServer: Server = createServer(healthzHandler(budgetState));
await new Promise<void>((r) => budgetServer.listen(0, "127.0.0.1", r));
const budgetPort = (budgetServer.address() as { port: number }).port;
const budgetProbe = await new Promise<string>((resolve) => {
  get(`http://127.0.0.1:${budgetPort}/healthz`, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => resolve(body));
  });
});
check(
  "budget-counter: real /healthz body carries the counter as a number",
  (JSON.parse(budgetProbe) as { roomsBudgetTerminated?: number }).roomsBudgetTerminated === 3,
);
budgetServer.close();

// --- 7. ws upgrade refused while draining (P2-145) -----------------------------
// Real server wired exactly like apps/relay/src/index.ts: noServer WSS with
// an explicit upgrade gate that consults the injected drain reader.
{
  const upFlag = { active: false };
  const upServer = createServer((_req, res) => res.end("ok"));
  const upWss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  upServer.on("upgrade", (req, socket, head) => {
    if (upFlag.active) {
      refuseUpgrade(socket);
      return;
    }
    upWss.handleUpgrade(req, socket, head, (ws) => upWss.emit("connection", ws, req));
  });
  await new Promise<void>((r) => upServer.listen(0, "127.0.0.1", r));
  const upPort = (upServer.address() as { port: number }).port;

  // healthy path still admits the peer
  const client = new WebSocket(`ws://127.0.0.1:${upPort}`);
  await new Promise((r) => client.on("open", r));
  check("drain-upgrade: healthy instance admits the ws peer", upWss.clients.size === 1);
  client.close();
  await new Promise((r) => client.on("close", r));

  upFlag.active = true;
  const raw = net.connect({ host: "127.0.0.1", port: upPort });
  let data = "";
  raw.on("data", (c) => (data += c.toString("utf8")));
  const closed: { byServer: boolean } = { byServer: false };
  raw.on("close", () => (closed.byServer = true));
  raw.on("error", () => {});
  raw.end(
    "GET /ws HTTP/1.1\r\n" +
      "Host: 127.0.0.1\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
      "Sec-WebSocket-Version: 13\r\n\r\n",
  );
  for (let i = 0; i < 100 && !closed.byServer; i++) await new Promise((r) => setTimeout(r, 10));
  check(
    "drain-upgrade: upgrade during drain gets a plain-HTTP 503",
    data.startsWith("HTTP/1.1 503 Service Unavailable\r\n"),
  );
  check("drain-upgrade: refused socket is destroyed by the server", closed.byServer);
  check("drain-upgrade: no room is admitted while draining", upWss.clients.size === 0);
  upFlag.active = false;

  client.terminate();
  upWss.close();
  if (upServer.listening) upServer.close();
}

// --- 8. RELAY_DRAIN_GRACE_MS validation (P2-141 problems format) ----------------
check("limits: RELAY_DRAIN_GRACE_MS absent keeps default 0 with no problems", (() => {
  const l = relayLimits({});
  return l.drainGraceMs === 0 && l.problems.length === 0;
})());
check("limits: blank RELAY_DRAIN_GRACE_MS keeps default 0", (() => {
  const l = relayLimits({ RELAY_DRAIN_GRACE_MS: "  " });
  return l.drainGraceMs === 0 && l.problems.length === 0;
})());
check("limits: zero RELAY_DRAIN_GRACE_MS is valid (unlike the admission limits)", (() => {
  const l = relayLimits({ RELAY_DRAIN_GRACE_MS: "0" });
  return l.drainGraceMs === 0 && l.problems.length === 0;
})());
check("limits: RELAY_DRAIN_GRACE_MS override in isolation", (() => {
  const l = relayLimits({ RELAY_DRAIN_GRACE_MS: "1500" });
  return l.drainGraceMs === 1500 && l.problems.length === 0;
})());
check("limits: RELAY_DRAIN_GRACE_MS at the ceiling is fine", (() => {
  const l = relayLimits({ RELAY_DRAIN_GRACE_MS: String(DRAIN_GRACE_MS_CEILING) });
  return l.drainGraceMs === 2000 && l.problems.length === 0;
})());
check("limits: RELAY_DRAIN_GRACE_MS above the ceiling is a problem", (() => {
  const l = relayLimits({ RELAY_DRAIN_GRACE_MS: String(DRAIN_GRACE_MS_CEILING + 1) });
  return l.drainGraceMs === 0 && l.problems.length === 1 && l.problems[0].includes("RELAY_DRAIN_GRACE_MS");
})());
check("limits: negative RELAY_DRAIN_GRACE_MS is a problem", (() => {
  const l = relayLimits({ RELAY_DRAIN_GRACE_MS: "-5" });
  return l.problems.length === 1 && l.problems[0].includes("RELAY_DRAIN_GRACE_MS");
})());
check("limits: non-numeric RELAY_DRAIN_GRACE_MS is a problem", (() => {
  const l = relayLimits({ RELAY_DRAIN_GRACE_MS: "soon" });
  return l.problems.length === 1 && l.problems[0].includes("RELAY_DRAIN_GRACE_MS");
})());
check(
  "limits: invalid RELAY_DRAIN_GRACE_MS is a problem, listener must not start",
  relayLimits({ RELAY_DRAIN_GRACE_MS: "abc" }).problems.length > 0,
);

// --- 9. shutdown grace sequence (P2-145): default zero preserves today ---------
{
  type Timer = ReturnType<typeof setTimeout>;
  const mkTimers = () => {
    const timers: { id: number; fn: () => void; ms: number }[] = [];
    let nextId = 1;
    return {
      timers,
      setTimeout: (fn: () => void, ms: number): Timer => {
        const t = { id: nextId++, fn, ms };
        timers.push(t);
        return t as unknown as Timer;
      },
      clearTimeout: (timer: Timer) => {
        const i = timers.indexOf(timer as unknown as { id: number });
        if (i >= 0) timers.splice(i, 1);
      },
      flush: (upToMs: number) => {
        const due = timers.filter((t) => t.ms <= upToMs);
        for (const t of due) {
          const i = timers.indexOf(t as unknown as { id: number });
          if (i >= 0) timers.splice(i, 1);
          t.fn();
        }
      },
    };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // 9a. graceMs omitted (env empty → 0): exactly the pre-P2-145 sequence
  {
    const t = mkTimers();
    const stops: number[] = [];
    const exits: number[] = [];
    const { shutdown, isShuttingDown } = createShutdown({
      activeConnections: () => 1,
      uptimeMs: () => 1000,
      stopListeners: async () => {
        stops.push(1);
      },
      log: () => {},
      exit: (code) => exits.push(code),
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
    });
    const p = shutdown("SIGTERM");
    await tick(); // stopListeners runs, settle timer queued
    check(
      "drain-grace: zero default queues exactly the current timers (hard + settle)",
      t.timers.length === 2 && t.timers[0].ms === DRAIN_MS && t.timers[1].ms === 250,
    );
    check("drain-grace: zero default closes sockets immediately", stops.length === 1);
    check("drain-grace: draining flag flips at the first signal (LB window)", isShuttingDown() === true);
    t.flush(DRAIN_MS - 1); // fire settle only; hard timer cleared on completion
    await p;
    check("drain-grace: zero default exits 0 with no extra timers", exits.length === 1 && exits[0] === 0 && t.timers.length === 0);
  }

  // 9b. graceMs 500: draining marked, LB window runs, THEN sockets close
  {
    const t = mkTimers();
    const stops: number[] = [];
    const exits: number[] = [];
    const { shutdown, isShuttingDown } = createShutdown({
      activeConnections: () => 1,
      uptimeMs: () => 1000,
      stopListeners: async () => {
        stops.push(1);
      },
      graceMs: 500,
      log: () => {},
      exit: (code) => exits.push(code),
      setTimeout: t.setTimeout,
      clearTimeout: t.clearTimeout,
    });
    const p = shutdown("SIGTERM");
    await tick();
    check("drain-grace: flag flips before the grace elapses", isShuttingDown() === true);
    check("drain-grace: sockets NOT closed while the grace runs", stops.length === 0);
    check(
      "drain-grace: grace timer queued inside the DRAIN_MS hard window",
      t.timers.some((x) => x.ms === 500) && t.timers.some((x) => x.ms === DRAIN_MS),
    );
    t.flush(500); // fire grace → stopListeners runs → settle queued
    await tick();
    check("drain-grace: sockets close only after the grace", stops.length === 1);
    check("drain-grace: settle still queued after the closed sockets", t.timers.some((x) => x.ms === 250));
    t.flush(DRAIN_MS - 1);
    await p;
    check("drain-grace: graceful exit 0 after grace + settle", exits.length === 1 && exits[0] === 0 && t.timers.length === 0);
  }
}

// --- 10. static web root paths (P2-188, pure resolver) ------------------------
const WEB_ROOT = "/srv/relay-web";
check("webroot: common asset resolves inside the root", resolveWebPath(WEB_ROOT, "/assets/app.js") === join(WEB_ROOT, "assets", "app.js"));
check("webroot: nested path with allowed extension resolves", resolveWebPath(WEB_ROOT, "/assets/chunk/manifest.webmanifest") === join(WEB_ROOT, "assets/chunk/manifest.webmanifest"));
check("webroot: .. traversal rejected", resolveWebPath(WEB_ROOT, "/..") === null && resolveWebPath(WEB_ROOT, "/../etc/passwd.js") === null);
check("webroot: percent-encoded traversal rejected after one decode", resolveWebPath(WEB_ROOT, "/..%2f..%2fetc%2fpasswd.js") === null && resolveWebPath(WEB_ROOT, "/%2e%2e/%2e%2e/etc/x.js") === null);
check("webroot: encoded absolute path rejected (decoded separator)", resolveWebPath(WEB_ROOT, "/%2Fetc%2Fpasswd") === null);
check("webroot: /etc/passwd rejected — extension outside the allowlist", resolveWebPath(WEB_ROOT, "/etc/passwd") === null);
check("webroot: hidden file rejected", resolveWebPath(WEB_ROOT, "/.env") === null);
check("webroot: hidden segment rejected", resolveWebPath(WEB_ROOT, "/config/.secret.json") === null);
check("webroot: extension outside the allowlist rejected", resolveWebPath(WEB_ROOT, "/secret.php") === null && resolveWebPath(WEB_ROOT, "/bundle.exe") === null);
check("webroot: missing extension is not an asset (SPA candidate instead)", resolveWebPath(WEB_ROOT, "/pair") === null);
check("webroot: backslash rejected", resolveWebPath(WEB_ROOT, "/a\\b.js") === null);
check("webroot: NUL byte rejected", resolveWebPath(WEB_ROOT, "/x%00.js") === null);
check("webroot: malformed percent escape rejected", resolveWebPath(WEB_ROOT, "/x%zz.js") === null);
check("webroot: path not starting with / rejected", resolveWebPath(WEB_ROOT, "assets/app.js") === null);
check("webroot: query-string-free contract — trailing slash is not an asset", resolveWebPath(WEB_ROOT, "/assets/") === null);

// containment backstop with the injected canonicalize hook (fs.realpathSync
// in index.ts): a symlink planted inside the root pointing outside is null
{
  const root = mkdtempSync(join(tmpdir(), "relay-webroot-"));
  const outside = join(tmpdir(), `relay-webroot-outside-${Date.now()}.js`);
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(root, "evil.js"));
  check(
    "webroot: symlink escaping the root rejected by resolved-path containment",
    resolveWebPath(root, "/evil.js", (p) => realpathSync(p)) === null,
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { force: true });

  // sibling directory sharing the root's name as a string prefix: the
  // containment boundary must be the separator, not the raw prefix
  const parent = join(tmpdir(), `relay-webroot-sib-${Date.now()}`);
  const rooted = join(parent, "dist");
  const sibling = join(parent, "dist-backup");
  mkdirSync(rooted, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "secret.js"), "secret");
  symlinkSync(join(sibling, "secret.js"), join(rooted, "evil.js"));
  check(
    "webroot: sibling directory sharing the root's prefix rejected (separator boundary)",
    resolveWebPath(rooted, "/evil.js", (p) => realpathSync(p)) === null,
  );
  rmSync(parent, { recursive: true, force: true });
}

// --- 11. SPA fallback (P2-188, pure resolver) ----------------------------------
check("spa: root path falls back to index.html", spaFallbackPath(WEB_ROOT, "/") === join(WEB_ROOT, "index.html"));
check("spa: extension-less route falls back to index.html", spaFallbackPath(WEB_ROOT, "/pair") === join(WEB_ROOT, "index.html"));
check("spa: route with extension never falls back (missing asset ≠ index)", spaFallbackPath(WEB_ROOT, "/assets/missing.js") === null);
check("spa: probe path is never the document", spaFallbackPath(WEB_ROOT, "/healthz") === null);
check("spa: trailing-slash probe spelling is never the document either", spaFallbackPath(WEB_ROOT, "/healthz/") === null && spaFallbackPath(WEB_ROOT, "/healthz//") === null);
check("spa: unsafe path never falls back", spaFallbackPath(WEB_ROOT, "/..%2fetc") === null && spaFallbackPath(WEB_ROOT, "/.env") === null);

// --- 12. content types and cache policy (P2-188, pure maps) --------------------
check("content-type: html served as text/html", contentTypeFor("/x/index.html") === "text/html; charset=utf-8");
check("content-type: js served as text/javascript", contentTypeFor("/x/assets/app.js") === "text/javascript; charset=utf-8");
check("content-type: css served as text/css", contentTypeFor("/x/app.css") === "text/css; charset=utf-8");
check("content-type: woff2 served as font/woff2", contentTypeFor("/x/font.woff2") === "font/woff2");
check("content-type: webmanifest served as manifest", contentTypeFor("/x/manifest.webmanifest") === "application/manifest+json");
check("content-type: svg/png/jpg/webp/ico map to image types", (() => {
  const t = (p: string) => contentTypeFor(p);
  return (
    t("/a.svg").startsWith("image/svg") &&
    t("/a.png") === "image/png" &&
    t("/a.jpg") === "image/jpeg" &&
    t("/a.webp") === "image/webp" &&
    t("/a.ico") === "image/x-icon"
  );
})());
check("content-type: default is application/octet-stream", contentTypeFor("/x/file.mystery") === "application/octet-stream");

check("cache: hashed asset is immutable", cacheControlFor("/x/assets/app-DbC9xY7W.js") === "public, max-age=31536000, immutable");
check("cache: entry document is no-store", cacheControlFor("/x/index.html") === "no-store");
check("cache: unhashed name is no-store", cacheControlFor("/x/sw.js") === "no-store");

// --- 13. webRootPlan preflight (P2-188, problems format) ------------------------
check("plan: absent RELAY_WEB_DIR keeps the static route off with zero problems", (() => {
  const p = webRootPlan({}, () => "ok", () => true);
  return p.enabled === false && p.root === "" && p.problems.length === 0;
})());
check("plan: blank RELAY_WEB_DIR keeps the static route off with zero problems", (() => {
  const p = webRootPlan({ RELAY_WEB_DIR: "   " }, () => "ok", () => true);
  return p.enabled === false && p.problems.length === 0;
})());
check("plan: valid directory with readable index enables the route", (() => {
  const p = webRootPlan({ RELAY_WEB_DIR: "/srv/web" }, () => "ok", () => true);
  return p.enabled === true && p.root === "/srv/web" && p.problems.length === 0;
})());
check("plan: missing directory is one problem", (() => {
  const p = webRootPlan({ RELAY_WEB_DIR: "/srv/web" }, () => "missing", () => false);
  return p.enabled === false && p.problems.length === 1 && p.problems[0].includes("RELAY_WEB_DIR");
})());
check("plan: not-a-directory is one problem", (() => {
  const p = webRootPlan({ RELAY_WEB_DIR: "/srv/web" }, () => "not-directory", () => false);
  return p.problems.length === 1 && p.problems[0].includes("RELAY_WEB_DIR");
})());
check("plan: unreadable directory is one problem", (() => {
  const p = webRootPlan({ RELAY_WEB_DIR: "/srv/web" }, () => "unreadable", () => false);
  return p.problems.length === 1 && p.problems[0].includes("RELAY_WEB_DIR");
})());
check("plan: missing index.html is one problem", (() => {
  const p = webRootPlan({ RELAY_WEB_DIR: "/srv/web" }, () => "ok", () => false);
  return p.enabled === false && p.problems.length === 1 && p.problems[0].includes("index.html");
})());
check("plan: problem text never cites the configured path", (() => {
  const p = webRootPlan({ RELAY_WEB_DIR: "/srv/web" }, () => "missing", () => false);
  return p.problems.every((r) => !r.includes("/srv/web"));
})());

// --- 14. handler with a real web root over real HTTP (P2-188) -------------------
{
  const root = mkdtempSync(join(tmpdir(), "relay-webhandler-"));
  writeFileSync(join(root, "index.html"), "<html>app</html>");
  writeFileSync(join(root, "app.js"), "console.log(1)");
  const outside = join(tmpdir(), `relay-webhandler-outside-${Date.now()}.js`);
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(root, "evil.js"));
  // sibling directory sharing the root's name as a string prefix — the exact
  // repro that slipped past a startsWith containment without the separator
  const sibling = join(`${root}-backup`);
  mkdirSync(sibling);
  writeFileSync(join(sibling, "secret.js"), "secret");
  symlinkSync(join(sibling, "secret.js"), join(root, "sibling.js"));

  const isFile = (abs: string) => {
    try {
      return statSync(abs).isFile() && realpathSync(abs).startsWith(realpathSync(root) + sep);
    } catch {
      return false;
    }
  };
  const webServer: Server = createServer(
    healthzHandler(state, () => false, {
      root,
      isFile,
      send: (abs, req, res) => {
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        createReadStream(abs).pipe(res);
      },
      csp: WEB_CSP_DEFAULT,
      isTls: () => false,
    }),
  );
  await new Promise<void>((r) => webServer.listen(0, "127.0.0.1", r));
  const webPort = (webServer.address() as { port: number }).port;
  const webRequest = (method: string, path: string) =>
    new Promise<{ status: number; type: string; cache: string; allow: string; sniff: string; body: string }>((resolve) => {
      const req = get(`http://127.0.0.1:${webPort}${path}`, { method }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers["content-type"]),
            cache: String(res.headers["cache-control"]),
            allow: String(res.headers.allow ?? ""),
            sniff: String(res.headers["x-content-type-options"] ?? ""),
            body,
          }),
        );
      });
      req.end();
    });

  const doc = await webRequest("GET", "/");
  check("web-handler: GET / serves the entry document", doc.status === 200 && doc.body === "<html>app</html>");
  check("web-handler: entry document is text/html + no-store", doc.type.startsWith("text/html") && doc.cache === "no-store");
  check("web-handler: served documents carry x-content-type-options: nosniff", doc.sniff === "nosniff");
  const spa = await webRequest("GET", "/pair");
  check("web-handler: extension-less route falls back to the entry document", spa.status === 200 && spa.body === "<html>app</html>");
  const asset = await webRequest("GET", "/app.js");
  check("web-handler: unhashed asset serves with no-store", asset.status === 200 && asset.type.startsWith("text/javascript") && asset.cache === "no-store");
  const missingAsset = await webRequest("GET", "/missing.js");
  check("web-handler: missing asset is 404, never 200 + HTML", missingAsset.status === 404);
  check("web-handler: hidden file is 404", (await webRequest("GET", "/.env")).status === 404);
  check("web-handler: traversal is 404", (await webRequest("GET", "/..%2f..%2fetc%2fpasswd.js")).status === 404);
  check("web-handler: symlink escaping the root is 404", (await webRequest("GET", "/evil.js")).status === 404);
  check("web-handler: symlink into a sibling prefix directory is 404 (separator boundary)", (await webRequest("GET", "/sibling.js")).status === 404);
  check("web-handler: /healthz keeps answering the probe", (await webRequest("GET", "/healthz")).status === 200);
  check("web-handler: /healthz is never the SPA document", (await webRequest("HEAD", "/healthz")).status === 404);
  const head = await webRequest("HEAD", "/");
  check("web-handler: HEAD serves headers without body", head.status === 200 && head.body === "" && head.type.startsWith("text/html"));
  const post = await webRequest("POST", "/");
  check("web-handler: POST gets 405 with allow: GET, HEAD", post.status === 405 && post.allow === "GET, HEAD");
  check("web-handler: query strings are stripped before resolving", (await webRequest("GET", "/?v=1")).status === 200);
  webServer.close();

  // drain: the static route answers 503 before any method decision
  const drainFlag2 = { active: false };
  const drainWebServer: Server = createServer(
    healthzHandler(state, () => drainFlag2.active, {
      root,
      isFile,
      send: (abs, req, res) => createReadStream(abs).pipe(res),
      csp: WEB_CSP_DEFAULT,
      isTls: () => false,
    }),
  );
  await new Promise<void>((r) => drainWebServer.listen(0, "127.0.0.1", r));
  const drainWebPort = (drainWebServer.address() as { port: number }).port;
  const drainRequest = (method: string, path: string) =>
    new Promise<number>((resolve) => {
      const req = get(`http://127.0.0.1:${drainWebPort}${path}`, { method }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.end();
    });
  drainFlag2.active = true;
  check("web-handler: static route answers 503 while draining", (await drainRequest("GET", "/")) === 503);
  check("web-handler: 503 comes before the 405 while draining", (await drainRequest("POST", "/")) === 503);
  drainFlag2.active = false;
  drainWebServer.close();

  rmSync(root, { recursive: true, force: true });
  rmSync(sibling, { recursive: true, force: true });
  rmSync(outside, { force: true });
}

// --- 15. web security headers (P2-192, pure decisions) -------------------------
const ALWAYS_ON_SECURITY_HEADERS = [
  "content-security-policy",
  "referrer-policy",
  "permissions-policy",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
];

check("webheaders: map carries every always-on header, keyed lowercase", (() => {
  const h = securityHeaders(false, WEB_CSP_DEFAULT);
  return ALWAYS_ON_SECURITY_HEADERS.every((k) => typeof h[k] === "string" && h[k]!.length > 0);
})());
check("webheaders: HSTS absent without TLS", securityHeaders(false, WEB_CSP_DEFAULT)["strict-transport-security"] === undefined);
check("webheaders: HSTS present under TLS", (() => {
  const h = securityHeaders(true, WEB_CSP_DEFAULT);
  return typeof h["strict-transport-security"] === "string" && h["strict-transport-security"]!.includes("max-age=");
})());
check("webheaders: the resolved policy flows into content-security-policy", securityHeaders(false, "default-src 'example.com'")["content-security-policy"] === "default-src 'example.com'");
check("webheaders: default policy pins framing, forms and plugins to none", (() => {
  const csp = securityHeaders(false, WEB_CSP_DEFAULT)["content-security-policy"] ?? "";
  return (
    csp.includes("frame-ancestors 'none'") &&
    csp.includes("form-action 'none'") &&
    csp.includes("object-src 'none'") &&
    csp.includes("default-src 'self'") &&
    csp.includes("script-src 'self'") &&
    csp.includes("base-uri 'self'") &&
    csp.includes("style-src 'self' 'unsafe-inline'") &&
    csp.includes("img-src 'self' data: blob:") &&
    csp.includes("connect-src 'self' wss: https:")
  );
})());
check("webheaders: referrer is never sent, permissions are denied", (() => {
  const h = securityHeaders(false, WEB_CSP_DEFAULT);
  return (
    h["referrer-policy"] === "no-referrer" &&
    h["permissions-policy"]!.includes("geolocation=()") &&
    h["permissions-policy"]!.includes("payment=()") &&
    h["permissions-policy"]!.includes("usb=()") &&
    h["permissions-policy"]!.includes("serial=()") &&
    h["permissions-policy"]!.includes("hid=()") &&
    h["permissions-policy"]!.includes("midi=()") &&
    h["x-frame-options"] === "DENY" &&
    h["cross-origin-opener-policy"] === "same-origin" &&
    h["cross-origin-resource-policy"] === "same-origin"
  );
})());

// --- 16. RELAY_WEB_CSP preflight (P2-192, problems format) ----------------------
check("webcsp: absent RELAY_WEB_CSP keeps the default with zero problems", (() => {
  const p = resolveWebCsp({});
  return p.csp === WEB_CSP_DEFAULT && p.problems.length === 0;
})());
check("webcsp: blank RELAY_WEB_CSP keeps the default with zero problems", (() => {
  const p = resolveWebCsp({ RELAY_WEB_CSP: "   " });
  return p.csp === WEB_CSP_DEFAULT && p.problems.length === 0;
})());
check("webcsp: non-string value is a problem", (() => {
  const p = resolveWebCsp({ RELAY_WEB_CSP: 42 as unknown as string });
  return p.problems.length === 1 && p.problems[0].includes("RELAY_WEB_CSP");
})());
check("webcsp: newline is a problem (header-injection vector)", (() => {
  const p = resolveWebCsp({ RELAY_WEB_CSP: "default-src 'self'\nX-Evil: 1" });
  return p.problems.length === 1 && p.csp === WEB_CSP_DEFAULT;
})());
check("webcsp: any other control byte is a problem", (() => {
  const p = resolveWebCsp({ RELAY_WEB_CSP: "default-src 'self'\u0007" });
  return p.problems.length === 1 && p.csp === WEB_CSP_DEFAULT;
})());
check("webcsp: value above the documented ceiling is a problem", (() => {
  const long = `default-src 'self'; script-src ${"a".repeat(WEB_CSP_MAX_LENGTH)}`;
  const p = resolveWebCsp({ RELAY_WEB_CSP: long });
  return p.problems.length === 1 && p.csp === WEB_CSP_DEFAULT;
})());
check("webcsp: policy without default-src is a problem", (() => {
  const p = resolveWebCsp({ RELAY_WEB_CSP: "script-src 'self'" });
  return p.problems.length === 1 && p.problems[0].includes("default-src");
})());
check("webcsp: valid override is served verbatim (trimmed) with no problems", (() => {
  const p = resolveWebCsp({ RELAY_WEB_CSP: "  default-src 'self'; script-src 'self'  " });
  return p.problems.length === 0 && p.csp === "default-src 'self'; script-src 'self'";
})());
check("webcsp: case-insensitive default-src detection", (() => {
  const p = resolveWebCsp({ RELAY_WEB_CSP: "DEFAULT-SRC 'self'" });
  return p.problems.length === 0 && p.csp === "DEFAULT-SRC 'self'";
})());

// --- 17. security headers over real HTTP (P2-192, real temp web root) ----------
{
  const root = mkdtempSync(join(tmpdir(), "relay-websec-"));
  writeFileSync(join(root, "index.html"), "<html>app</html>");
  writeFileSync(join(root, "app.js"), "console.log(1)");
  writeFileSync(join(root, "app-DbC9xY7W.js"), "console.log(1)");

  const tlsFlag = { on: false };
  const OVERRIDE = "default-src 'self'; script-src 'self'; report-uri /csp";
  const plan = resolveWebCsp({ RELAY_WEB_CSP: OVERRIDE });
  const secServer: Server = createServer(
    healthzHandler(state, () => false, {
      root,
      isFile: (abs) => {
        try {
          return statSync(abs).isFile();
        } catch {
          return false;
        }
      },
      send: (abs, req, res) => {
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        createReadStream(abs).pipe(res);
      },
      csp: plan.csp,
      isTls: () => tlsFlag.on,
    }),
  );
  await new Promise<void>((r) => secServer.listen(0, "127.0.0.1", r));
  const secPort = (secServer.address() as { port: number }).port;
  const secRequest = (method: string, path: string) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve) => {
      const req = get(`http://127.0.0.1:${secPort}${path}`, { method }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.end();
    });

  const asset = await secRequest("GET", "/app.js");
  check("sec-headers: common asset carries every always-on security header", ALWAYS_ON_SECURITY_HEADERS.every((k) => asset.headers[k] !== undefined));
  check("sec-headers: asset carries the override policy, not the default", asset.headers["content-security-policy"] === OVERRIDE);
  check("sec-headers: asset keeps content-type and cache-control untouched", String(asset.headers["content-type"]).startsWith("text/javascript") && asset.headers["cache-control"] === "no-store");
  check("sec-headers: HSTS absent without TLS", asset.headers["strict-transport-security"] === undefined);

  const spa = await secRequest("GET", "/pair");
  check("sec-headers: SPA fallback carries exactly the same security headers", (() => {
    const fromAsset = ALWAYS_ON_SECURITY_HEADERS.map((k) => [k, asset.headers[k]] as const);
    const fromSpa = ALWAYS_ON_SECURITY_HEADERS.map((k) => [k, spa.headers[k]] as const);
    return (
      spa.status === 200 &&
      JSON.stringify(fromAsset) === JSON.stringify(fromSpa) &&
      spa.headers["strict-transport-security"] === undefined
    );
  })());

  tlsFlag.on = true;
  const tlsDoc = await secRequest("GET", "/");
  check("sec-headers: HSTS present once the request arrives under TLS", typeof tlsDoc.headers["strict-transport-security"] === "string");
  tlsFlag.on = false;

  const notFound = await secRequest("GET", "/missing.js");
  check("sec-headers: 404 carries none of the security headers", ALWAYS_ON_SECURITY_HEADERS.every((k) => notFound.headers[k] === undefined) && notFound.headers["strict-transport-security"] === undefined);
  const notAllowed = await secRequest("POST", "/");
  check("sec-headers: 405 carries none of the security headers", ALWAYS_ON_SECURITY_HEADERS.every((k) => notAllowed.headers[k] === undefined) && notAllowed.headers["strict-transport-security"] === undefined);

  const probe = await secRequest("GET", "/healthz");
  check("sec-headers: /healthz body is byte-for-byte unchanged", probe.status === 200 && probe.body === `{"ok":true,"version":"0.2.0","uptimeS":${(JSON.parse(probe.body) as { uptimeS: number }).uptimeS},"rooms":7,"roomsRejected":2}`);
  check("sec-headers: /healthz carries no new header (LB contract intact)", ALWAYS_ON_SECURITY_HEADERS.every((k) => probe.headers[k] === undefined) && probe.headers["strict-transport-security"] === undefined && probe.headers["content-type"] === "application/json");

  secServer.close();
  rmSync(root, { recursive: true, force: true });
}

// --- 18. built bundle sanity: the default CSP must not break the app ------------
// Reads apps/web/dist/index.html — produced by the battery's own build step.
// The default policy allows only same-origin scripts and no inline handlers,
// so the document must not rely on either.
{
  const distIndex = fileURLToPath(new URL("../apps/web/dist/index.html", import.meta.url));
  if (!existsSync(distIndex)) {
    console.log("SKIP dist-csp: apps/web/dist/index.html not built yet (npm run build produces it)");
  } else {
    const html = readFileSync(distIndex, "utf8");
    const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>/i.test(html);
    const inlineHandler = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(html);
    check("dist-csp: entry document loads no inline script", !inlineScript);
    check("dist-csp: entry document declares no inline event handler", !inlineHandler);
    const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1] ?? "");
    check("dist-csp: every script src is same-origin (relative), covered by script-src 'self'", srcs.length > 0 && srcs.every((s) => s.startsWith("./") || s.startsWith("/")));
  }
}

// --- 19. static-route budget resolver (P2-195, problems format) -----------------
check("webbudget: absent variables keep the documented defaults with zero problems", (() => {
  const p = resolveWebBudget({});
  return p.ratePerMin === WEB_RATE_PER_MIN_DEFAULT && p.burst === WEB_BURST_DEFAULT && p.problems.length === 0;
})());
check("webbudget: blank variables keep the defaults with zero problems too", (() => {
  const p = resolveWebBudget({ RELAY_WEB_RATE_PER_MIN: "  ", RELAY_WEB_BURST: "" });
  return p.ratePerMin === WEB_RATE_PER_MIN_DEFAULT && p.burst === WEB_BURST_DEFAULT && p.problems.length === 0;
})());
check("webbudget: valid overrides are honored with no problems", (() => {
  const p = resolveWebBudget({ RELAY_WEB_RATE_PER_MIN: "240", RELAY_WEB_BURST: "30" });
  return p.ratePerMin === 240 && p.burst === 30 && p.problems.length === 0;
})());
check("webbudget: values at the documented ceilings are fine", (() => {
  const p = resolveWebBudget({
    RELAY_WEB_RATE_PER_MIN: String(WEB_RATE_PER_MIN_CEILING),
    RELAY_WEB_BURST: String(WEB_BURST_CEILING),
  });
  return p.ratePerMin === WEB_RATE_PER_MIN_CEILING && p.burst === WEB_BURST_CEILING && p.problems.length === 0;
})());
for (const [name, raw] of [
    ["non-numeric", "abc"],
    ["negative", "-1"],
    ["zero", "0"],
    ["fractional", "1.5"],
    ["above-ceiling", "999999"],
  ] as const) {
  check(`webbudget: ${name} RELAY_WEB_RATE_PER_MIN is a problem`, (() => {
    const p = resolveWebBudget({ RELAY_WEB_RATE_PER_MIN: raw });
    return p.problems.length === 1 && p.problems[0].includes("RELAY_WEB_RATE_PER_MIN");
  })());
  check(`webbudget: ${name} RELAY_WEB_BURST is a problem`, (() => {
    const p = resolveWebBudget({ RELAY_WEB_BURST: raw });
    return p.problems.length === 1 && p.problems[0].includes("RELAY_WEB_BURST");
  })());
}
check("webbudget: two bad variables yield two problems, each naming its variable", (() => {
  const p = resolveWebBudget({ RELAY_WEB_RATE_PER_MIN: "soon", RELAY_WEB_BURST: "-2" });
  return p.problems.length === 2 && p.problems.some((x) => x.includes("RELAY_WEB_RATE_PER_MIN")) && p.problems.some((x) => x.includes("RELAY_WEB_BURST"));
})());

// --- 20. budget bucket decision (P2-195, pure) -----------------------------------
check("budget: a fresh identity starts with the full burst and spends one token", (() => {
  const v = webBudgetDecision(undefined, 1000, 120, 3);
  return v.allow === true && v.retryAfterS === 0 && v.state.tokens === 2 && v.state.lastMs === 1000;
})());
check("budget: an empty bucket rejects with a suggested retry-after of at least 1s", (() => {
  const v = webBudgetDecision({ tokens: 0, lastMs: 1000, lastSeenMs: 1000 }, 1000, 60, 2);
  return v.allow === false && v.retryAfterS >= 1 && Number.isFinite(v.retryAfterS);
})());
check("budget: the bucket refills continuously with elapsed time", (() => {
  // 60/min = 1 token per second: 30s elapsed re-grants the whole burst of 2
  const v = webBudgetDecision({ tokens: 0, lastMs: 1000, lastSeenMs: 1000 }, 31_000, 60, 2);
  return v.allow === true && v.state.tokens === 1;
})());
check("budget: a previous instant in the future counts as no refill (clock skew)", (() => {
  const v = webBudgetDecision({ tokens: 0, lastMs: 50_000, lastSeenMs: 50_000 }, 1000, 60, 2);
  return v.allow === false && v.state.tokens === 0;
})());
check("budget: a near-miss rejection suggests a 1s wait, not 0", (() => {
  const v = webBudgetDecision({ tokens: 0.99, lastMs: 1000, lastSeenMs: 1000 }, 1000, 60, 2);
  return v.allow === false && v.retryAfterS === 1;
})());

// --- 21. WebBudgets map: independence, entry cap, inactivity prune (P2-195) ------
check("budget map: distinct identities never share a bucket", (() => {
  const b = new WebBudgets(0, 1, 100);
  return b.take("a", 1000).allow === true && b.take("b", 1000).allow === true;
})());
check("budget map: the same exhausted identity is rejected", (() => {
  const b = new WebBudgets(0, 1, 100);
  b.take("a", 1000);
  return b.take("a", 2000).allow === false;
})());
check("budget map: the entry cap is respected discarding the least-recently-seen entry", (() => {
  const b = new WebBudgets(0, 1, 2);
  const first = b.take("a", 1000); // a: spent (burst of 1)
  b.take("b", 2000); // b: spent
  const capped = b.take("c", 3000); // over the cap → oldest entry (a) discarded
  const cappedOk = capped.allow === true && b.size === 2;
  const survivorKeepsSpentBucket = b.take("c", 4000).allow === false; // c survived with its spent state
  const evictedReminted = b.take("a", 5000).allow === true; // a was discarded: fresh bucket, not the spent one
  return first.allow === true && cappedOk && survivorKeepsSpentBucket && evictedReminted;
})());
check("budget map: prune drops entries idle beyond the window and keeps fresh ones", (() => {
  const b = new WebBudgets(0, 2, 100);
  b.take("old", 1000);
  b.take("fresh", 9000);
  const removed = b.prune(10_000, 5_000);
  return removed === 1 && b.size === 1 && b.take("fresh", 10_001).allow === true;
})());
check("budget map: identity derivation follows TRUST_PROXY_HOPS exactly like the upgrade path", (() => {
  const tag = makeIpTagger(new Uint8Array(32).fill(7));
  const direct = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
  const forged = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "9.9.9.9" } };
  const sameDirect = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
  const keyedByPeer = webBudgetIdentity(direct, 0, tag) === webBudgetIdentity(sameDirect, 0, tag);
  const ignoresForgedHeader = webBudgetIdentity(direct, 0, tag) === webBudgetIdentity(forged, 0, tag);
  const trustsChain = webBudgetIdentity(forged, 1, tag) !== webBudgetIdentity(direct, 1, tag);
  const stable = webBudgetIdentity(forged, 1, tag) === webBudgetIdentity(forged, 1, tag);
  return keyedByPeer && ignoresForgedHeader && trustsChain && stable;
})());

// --- 22. budgeted static route over real HTTP (P2-195) ----------------------------
{
  const root = mkdtempSync(join(tmpdir(), "relay-webbudget-"));
  writeFileSync(join(root, "index.html"), "<html>budget</html>");
  // wired exactly like apps/relay/src/index.ts: identity = clientIp() honoring
  // the trusted hops, tagged by the P2-174 ipTagger, buckets in WebBudgets
  const tag = makeIpTagger(new Uint8Array(32).fill(9));
  const budgets = new WebBudgets(60, 2); // 1 token/s refill, burst of 2
  const gate = {
    take: (req: IncomingMessage, nowMs: number) =>
      budgets.take(webBudgetIdentity(req, 1, tag), nowMs),
  };
  const budgetServer: Server = createServer(
    healthzHandler(state, () => false, {
      root,
      isFile: (abs) => {
        try {
          return statSync(abs).isFile();
        } catch {
          return false;
        }
      },
      send: (abs, req, res) => createReadStream(abs).pipe(res),
      csp: WEB_CSP_DEFAULT,
      isTls: () => false,
    }, gate),
  );
  await new Promise<void>((r) => budgetServer.listen(0, "127.0.0.1", r));
  const bPort = (budgetServer.address() as { port: number }).port;
  const budgetRequest = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve) => {
      const req = get(`http://127.0.0.1:${bPort}${path}`, { headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.end();
    });

  check("budget http: burst inside the burst is answered 200", (await budgetRequest("/")).status === 200);
  check("budget http: the last burst token is answered 200", (await budgetRequest("/")).status === 200);
  const rejected = await budgetRequest("/");
  check("budget http: the next request is 429", rejected.status === 429);
  check("budget http: the 429 carries retry-after", Number(rejected.headers["retry-after"]) >= 1);
  check("budget http: the 429 body is short and plain", rejected.body.length < 32 && String(rejected.headers["content-type"]).startsWith("text/plain"));
  check(
    "budget http: the 429 carries the P2-192 security headers",
    ALWAYS_ON_SECURITY_HEADERS.every((k) => rejected.headers[k] !== undefined) &&
      rejected.headers["strict-transport-security"] === undefined,
  );
  check("budget http: the probe answers 200 even with that identity's bucket empty", (await budgetRequest("/healthz")).status === 200);
  await new Promise((r) => setTimeout(r, 1100));
  check("budget http: the bucket refills with time and answers 200 again", (await budgetRequest("/")).status === 200);
  check("budget http: a distinct x-forwarded-for identity has its own bucket (1/2)", (await budgetRequest("/", { "x-forwarded-for": "9.9.9.1" })).status === 200);
  check("budget http: a distinct x-forwarded-for identity has its own bucket (2/2)", (await budgetRequest("/", { "x-forwarded-for": "9.9.9.1" })).status === 200);
  check("budget http: the second identity exhausts its own budget, not the first's", (await budgetRequest("/", { "x-forwarded-for": "9.9.9.1" })).status === 429);
  check("budget http: a third identity is independent of both", (await budgetRequest("/", { "x-forwarded-for": "9.9.9.2" })).status === 200);
  check("budget http: the probe of the exhausted identity still answers 200", (await budgetRequest("/healthz", { "x-forwarded-for": "9.9.9.1" })).status === 200);
  check("budget http: the probe consumes no budget (bucket stays empty)", (await budgetRequest("/", { "x-forwarded-for": "9.9.9.1" })).status === 429);

  budgetServer.close();
  rmSync(root, { recursive: true, force: true });
}

// --- 23. content negotiation (P2-198, pure decision table) --------------------
const IN_RANGE = 10_000;
check("encoding: js asset with a plain gzip header is compressed and varies", (() => {
  const d = negotiateEncoding("gzip", ".js", IN_RANGE);
  return d.encoding === "gzip" && d.vary === true;
})());
check("encoding: absent header stays identity but still varies", (() => {
  const d = negotiateEncoding(undefined, ".js", IN_RANGE);
  return d.encoding === "identity" && d.vary === true;
})());
check("encoding: gzip with quality zero means identity (refused, not preferred)", (() => {
  const d = negotiateEncoding("gzip;q=0", ".js", IN_RANGE);
  return d.encoding === "identity" && d.vary === true;
})());
check("encoding: the wildcard accepts gzip", negotiateEncoding("*", ".js", IN_RANGE).encoding === "gzip");
check("encoding: a zero-quality wildcard refuses gzip too", negotiateEncoding("*;q=0", ".js", IN_RANGE).encoding === "identity");
check("encoding: case and whitespace around token and q are ignored", (() => {
  const d = negotiateEncoding("  GZIP ; Q = 0.5 ", ".js", IN_RANGE);
  return d.encoding === "gzip" && d.vary === true;
})());
check("encoding: a header without gzip stays identity", negotiateEncoding("br", ".js", IN_RANGE).encoding === "identity");
check("encoding: gzip among other encodings is honored", negotiateEncoding("deflate, gzip, br", ".js", IN_RANGE).encoding === "gzip");
check("encoding: an explicit gzip element wins over the wildcard quality", negotiateEncoding("gzip;q=0, *", ".js", IN_RANGE).encoding === "identity");
check("encoding: a fractional quality above zero compresses", negotiateEncoding("gzip;q=0.5", ".js", IN_RANGE).encoding === "gzip");
check("encoding: a non-numeric quality is a malformed header (identity)", negotiateEncoding("gzip;q=abc", ".js", IN_RANGE).encoding === "identity");
check("encoding: a quality above one is malformed (identity)", negotiateEncoding("gzip;q=2", ".js", IN_RANGE).encoding === "identity");
check("encoding: an empty quality is malformed (identity)", negotiateEncoding("gzip;q=", ".js", IN_RANGE).encoding === "identity");
check("encoding: a quality with four decimals is malformed (identity)", negotiateEncoding("gzip;q=0.0001", ".js", IN_RANGE).encoding === "identity");
check("encoding: an element without a token is malformed (identity)", negotiateEncoding(";q=1", ".js", IN_RANGE).encoding === "identity");
check("encoding: an empty header is identity", negotiateEncoding("", ".js", IN_RANGE).encoding === "identity");
check("encoding: png is never compressed, whatever the header says", (() => {
  const anyHeader = negotiateEncoding("*", ".png", IN_RANGE);
  const none = negotiateEncoding(undefined, ".png", IN_RANGE);
  return anyHeader.encoding === "identity" && anyHeader.vary === false && none.encoding === "identity" && none.vary === false;
})());
check("encoding: jpg/webp/ico/woff2 are never compressible either", (() => {
  return [".jpg", ".webp", ".ico", ".woff2"].every(
    (ext) => negotiateEncoding("gzip", ext, IN_RANGE).encoding === "identity" && negotiateEncoding("gzip", ext, IN_RANGE).vary === false,
  );
})());
check("encoding: the extension is case-insensitive and dot-tolerant", negotiateEncoding("gzip", ".JS", IN_RANGE).encoding === "gzip" && negotiateEncoding("gzip", "js", IN_RANGE).encoding === "gzip");
check("encoding: a file below the floor is never compressed and does not vary", (() => {
  const d = negotiateEncoding("gzip", ".js", WEB_ENCODING_MIN_BYTES - 1);
  return d.encoding === "identity" && d.vary === false;
})());
check("encoding: a file at the floor is compressed", negotiateEncoding("gzip", ".js", WEB_ENCODING_MIN_BYTES).encoding === "gzip");
check("encoding: a file at the ceiling is compressed", negotiateEncoding("gzip", ".js", WEB_ENCODING_MAX_BYTES).encoding === "gzip");
check("encoding: a file above the ceiling is refused compression", (() => {
  const d = negotiateEncoding("gzip", ".js", WEB_ENCODING_MAX_BYTES + 1);
  return d.encoding === "identity" && d.vary === false;
})());
check("encoding: thresholds are the documented constants", WEB_ENCODING_MIN_BYTES === 1024 && WEB_ENCODING_MAX_BYTES === 8_388_608);

// --- 24. compressed-body cache (P2-198, pure units) ------------------------------
check("encoding cache: the same key compresses exactly once", (() => {
  const c = new WebEncodingCache(8, 1_000_000);
  let computes = 0;
  const first = c.getOrCompute("k", () => {
    computes++;
    return Buffer.from("one");
  });
  const second = c.getOrCompute("k", () => {
    computes++;
    return Buffer.from("two");
  });
  return computes === 1 && first === second && c.hits === 1 && c.misses === 1;
})());
check("encoding cache: the entry cap discards the oldest entry", (() => {
  const c = new WebEncodingCache(2, 1_000_000);
  c.getOrCompute("a", () => Buffer.from("1"));
  c.getOrCompute("b", () => Buffer.from("2"));
  c.getOrCompute("c", () => Buffer.from("3")); // over the cap → a discarded
  return c.size === 2 && c.getOrCompute("a", () => Buffer.from("fresh-a")).toString() === "fresh-a";
})());
check("encoding cache: the byte cap discards the oldest entry", (() => {
  const c = new WebEncodingCache(8, 10);
  c.getOrCompute("a", () => Buffer.alloc(6, 1));
  c.getOrCompute("b", () => Buffer.alloc(6, 2)); // 12 total > 10 → a evicted
  return c.bytes === 6 && c.getOrCompute("a", () => Buffer.from("fresh")).toString() === "fresh";
})());
check("encoding cache: an entry above the byte cap is never stored", (() => {
  const c = new WebEncodingCache(8, 10);
  c.getOrCompute("big", () => Buffer.alloc(11, 1));
  return c.size === 0 && c.getOrCompute("big", () => Buffer.from("again")).toString() === "again";
})());
check("encoding cache: the key binds path, size and mtime together", (() => {
  const base = webEncodingCacheKey("/a.js", 10, 1);
  return (
    base === webEncodingCacheKey("/a.js", 10, 1) &&
    base !== webEncodingCacheKey("/a.js", 11, 1) &&
    base !== webEncodingCacheKey("/a.js", 10, 2) &&
    base !== webEncodingCacheKey("/b.js", 10, 1)
  );
})());

// --- 25. negotiated static route over real HTTP (P2-198) --------------------------
{
  const root = mkdtempSync(join(tmpdir(), "relay-webgzip-"));
  const bigJs = 'console.log("bundle");\n'.repeat(120); // 2760 bytes, in range
  const indexHtml = `<html>${"x".repeat(1200)}</html>`; // 1213 bytes, in range
  writeFileSync(join(root, "app.js"), bigJs);
  writeFileSync(join(root, "app-DbC9xY7W.js"), bigJs); // hashed asset → immutable
  writeFileSync(join(root, "index.html"), indexHtml);
  writeFileSync(join(root, "tiny.js"), "console.log(1)\n"); // below the floor
  writeFileSync(join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]));
  writeFileSync(join(root, "huge.js"), Buffer.alloc(WEB_ENCODING_MAX_BYTES + 1, 0x61)); // above the ceiling

  const gzipServer: Server = createServer(
    healthzHandler(state, () => false, {
      root,
      isFile: (abs) => {
        try {
          return statSync(abs).isFile();
        } catch {
          return false;
        }
      },
      send: (abs, _req, res) => createReadStream(abs).pipe(res),
      csp: WEB_CSP_DEFAULT,
      isTls: () => false,
    }),
  );
  await new Promise<void>((r) => gzipServer.listen(0, "127.0.0.1", r));
  const gPort = (gzipServer.address() as { port: number }).port;
  const gzipRequest = (path: string, reqHeaders: Record<string, string> = {}, method = "GET") =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve) => {
      const req = get(`http://127.0.0.1:${gPort}${path}`, { method, headers: reqHeaders }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.end();
    });

  const gz = await gzipRequest("/app.js", { "accept-encoding": "gzip" });
  check("gzip http: a js asset with accept-encoding gzip answers content-encoding gzip", gz.status === 200 && gz.headers["content-encoding"] === "gzip");
  check("gzip http: the compressed body gunzips byte for byte into the original file", gunzipSync(gz.body).toString() === bigJs);
  check("gzip http: the content-length is the already-compressed length", gz.headers["content-length"] === String(gz.body.length));
  check("gzip http: content-type and cache-control are untouched", String(gz.headers["content-type"]).startsWith("text/javascript") && gz.headers["cache-control"] === "no-store");
  check("gzip http: the compressed response carries vary: accept-encoding", gz.headers["vary"] === "Accept-Encoding");
  check("gzip http: every P2-192 security header rides on the compressed response", ALWAYS_ON_SECURITY_HEADERS.every((k) => gz.headers[k] !== undefined) && gz.headers["x-content-type-options"] === "nosniff");

  const hitsBefore = WEB_ENCODING_CACHE.hits;
  const gzAgain = await gzipRequest("/app.js", { "accept-encoding": "gzip" });
  check(
    "gzip http: the second request of the same asset is byte-identical and served from the cache",
    gzAgain.body.equals(gz.body) && WEB_ENCODING_CACHE.hits === hitsBefore + 1,
  );

  const identity = await gzipRequest("/app.js");
  check("gzip http: the same asset without the header answers without content-encoding", identity.headers["content-encoding"] === undefined && identity.body.toString() === bigJs);
  check("gzip http: the identity variant carries vary too (shared cache never mixes variants)", identity.headers["vary"] === "Accept-Encoding");

  const qZero = await gzipRequest("/app.js", { "accept-encoding": "gzip;q=0" });
  check("gzip http: gzip with quality zero falls back to identity", qZero.headers["content-encoding"] === undefined && qZero.body.toString() === bigJs);
  const wildcard = await gzipRequest("/app.js", { "accept-encoding": "*" });
  check("gzip http: the wildcard answers gzip", wildcard.headers["content-encoding"] === "gzip");

  const png = await gzipRequest("/pic.png", { "accept-encoding": "gzip" });
  check("gzip http: png is never compressed and carries no vary", png.headers["content-encoding"] === undefined && png.headers["vary"] === undefined && png.body.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1])));
  const tiny = await gzipRequest("/tiny.js", { "accept-encoding": "gzip" });
  check("gzip http: a file below the floor is never compressed and carries no vary", tiny.headers["content-encoding"] === undefined && tiny.headers["vary"] === undefined && tiny.body.toString() === "console.log(1)\n");
  const huge = await gzipRequest("/huge.js", { "accept-encoding": "gzip" });
  check("gzip http: a file above the ceiling is never compressed and carries no vary", huge.headers["content-encoding"] === undefined && huge.headers["vary"] === undefined && huge.body.length === WEB_ENCODING_MAX_BYTES + 1);

  const spa = await gzipRequest("/pair", { "accept-encoding": "gzip" });
  check("gzip http: the SPA fallback is compressed the same way", spa.status === 200 && spa.headers["content-encoding"] === "gzip" && gunzipSync(spa.body).toString() === indexHtml);
  check("gzip http: the SPA fallback carries vary as well", spa.headers["vary"] === "Accept-Encoding");

  const hashed = await gzipRequest("/app-DbC9xY7W.js", { "accept-encoding": "gzip" });
  check("gzip http: a hashed immutable asset compresses and keeps its cache policy", hashed.headers["content-encoding"] === "gzip" && hashed.headers["cache-control"] === "public, max-age=31536000, immutable");

  const head = await gzipRequest("/app.js", { "accept-encoding": "gzip" }, "HEAD");
  check("gzip http: HEAD answers the negotiated headers with no body", head.status === 200 && head.headers["content-encoding"] === "gzip" && Number(head.headers["content-length"]) > 0 && head.body.length === 0);

  const missing = await gzipRequest("/missing.js", { "accept-encoding": "gzip" });
  check("gzip http: 404 is unchanged — no compression, no vary, empty body", missing.status === 404 && missing.headers["content-encoding"] === undefined && missing.headers["vary"] === undefined && missing.body.length === 0);
  const notAllowed = await gzipRequest("/", { "accept-encoding": "gzip" }, "POST");
  check("gzip http: 405 is unchanged — allow header, no compression, no vary", notAllowed.status === 405 && notAllowed.headers["allow"] === "GET, HEAD" && notAllowed.headers["content-encoding"] === undefined && notAllowed.headers["vary"] === undefined);

  const probe = await gzipRequest("/healthz", { "accept-encoding": "gzip" });
  check(
    "gzip http: /healthz body and headers are byte-for-byte unchanged (no gzip, no vary)",
    probe.status === 200 &&
      probe.headers["content-type"] === "application/json" &&
      probe.headers["content-encoding"] === undefined &&
      probe.headers["vary"] === undefined &&
      probe.body.toString() ===
        `{"ok":true,"version":"0.2.0","uptimeS":${(JSON.parse(probe.body.toString()) as { uptimeS: number }).uptimeS},"rooms":7,"roomsRejected":2}`,
  );

  gzipServer.close();
  rmSync(root, { recursive: true, force: true });
}

// --- 26. conditional validators (P2-200, pure decisions) -------------------------
const CURRENT = etagFor(2760, 1_700_000_000_000, "gzip");
check("etag: the validator is a quoted strong entity tag", CURRENT.startsWith('"') && CURRENT.endsWith('"') && !CURRENT.startsWith("W/"));
check("etag: the opaque value is 16 lowercase hex digits", /^"[0-9a-f]{16}"$/.test(CURRENT));
check("etag: stable across repeated calls for the same input", etagFor(2760, 1_700_000_000_000, "gzip") === CURRENT);
check("etag: differs between gzip and identity for the same file", etagFor(2760, 1_700_000_000_000, "gzip") !== etagFor(2760, 1_700_000_000_000, "identity"));
check("etag: differs when the size changes", etagFor(2760, 1_700_000_000_000, "gzip") !== etagFor(2761, 1_700_000_000_000, "gzip"));
check("etag: differs when the mtime changes", etagFor(2760, 1_700_000_000_000, "gzip") !== etagFor(2760, 1_700_000_000_001, "gzip"));

check("cond: a missing header sends", conditionalVerdict(undefined, CURRENT) === "send");
check("cond: a non-string header sends", conditionalVerdict(42, CURRENT) === "send");
check("cond: an empty header sends", conditionalVerdict("", CURRENT) === "send");
check("cond: a whitespace-only header sends", conditionalVerdict("   ", CURRENT) === "send");
check("cond: the current validator revalidates", conditionalVerdict(CURRENT, CURRENT) === "not-modified");
check("cond: surrounding whitespace is ignored", conditionalVerdict(`  ${CURRENT}  `, CURRENT) === "not-modified");
check("cond: the weak form revalidates (weak comparison)", conditionalVerdict(`W/${CURRENT}`, CURRENT) === "not-modified");
check("cond: the wildcard revalidates", conditionalVerdict("*", CURRENT) === "not-modified");
check("cond: a padded wildcard revalidates", conditionalVerdict(" * ", CURRENT) === "not-modified");
check("cond: an unknown validator sends", conditionalVerdict('"nope-0000"', CURRENT) === "send");
check("cond: a list revalidates when one element matches (last)", conditionalVerdict(`"nope-0000", ${CURRENT}`, CURRENT) === "not-modified");
check("cond: a list revalidates when one element matches (first)", conditionalVerdict(`${CURRENT} , "nope-0000"`, CURRENT) === "not-modified");
check("cond: a list without a match sends", conditionalVerdict('"nope-0000", "other-1111"', CURRENT) === "send");
check("cond: a malformed element never matches", conditionalVerdict("W/", CURRENT) === "send");
check("cond: a comma-only header sends", conditionalVerdict(",,", CURRENT) === "send");
check("cond: an unterminated quote is just a non-match (send)", conditionalVerdict('"unterminated', CURRENT) === "send");

// --- 27. conditional static route over real HTTP (P2-200) -------------------------
{
  const root = mkdtempSync(join(tmpdir(), "relay-webcond-"));
  const bigJs = 'console.log("bundle");\n'.repeat(120); // 2760 bytes, in range
  const indexHtml = `<html>${"x".repeat(1200)}</html>`; // 1213 bytes, in range
  writeFileSync(join(root, "app.js"), bigJs);
  writeFileSync(join(root, "index.html"), indexHtml);
  writeFileSync(join(root, "tiny.js"), "console.log(1)\n"); // below the gzip floor, identity only

  const condServer: Server = createServer(
    healthzHandler(state, () => false, {
      root,
      isFile: (abs) => {
        try {
          return statSync(abs).isFile();
        } catch {
          return false;
        }
      },
      send: (abs, req, res) => {
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        createReadStream(abs).pipe(res);
      },
      csp: WEB_CSP_DEFAULT,
      isTls: () => false,
    }),
  );
  await new Promise<void>((r) => condServer.listen(0, "127.0.0.1", r));
  const cPort = (condServer.address() as { port: number }).port;
  const condRequest = (path: string, reqHeaders: Record<string, string> = {}, method = "GET") =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve) => {
      const req = get(`http://127.0.0.1:${cPort}${path}`, { method, headers: reqHeaders }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.end();
    });

  const first = await condRequest("/app.js", { "accept-encoding": "gzip" });
  const gzEtag = first.headers.etag;
  check("cond http: the first GET answers 200 with an etag present", first.status === 200 && typeof gzEtag === "string" && gzEtag.length > 0);
  check("cond http: the 200 gzip variant is otherwise the P2-198 response", first.headers["content-encoding"] === "gzip" && first.headers["vary"] === "Accept-Encoding");

  const revalidate = await condRequest("/app.js", { "accept-encoding": "gzip", "if-none-match": gzEtag! });
  check("cond http: a matching if-none-match answers 304", revalidate.status === 304);
  check("cond http: the 304 has no body at all", revalidate.body.length === 0);
  check("cond http: the 304 carries the validator", revalidate.headers.etag === gzEtag);
  check("cond http: the 304 carries cache-control", revalidate.headers["cache-control"] === "no-store");
  check("cond http: the 304 carries vary", revalidate.headers["vary"] === "Accept-Encoding");
  check(
    "cond http: the 304 carries every P2-192 security header",
    ALWAYS_ON_SECURITY_HEADERS.every((k) => revalidate.headers[k] !== undefined) &&
      revalidate.headers["x-content-type-options"] === undefined,
  );
  check(
    "cond http: the 304 never carries content-encoding, content-length nor content-type",
    revalidate.headers["content-encoding"] === undefined &&
      revalidate.headers["content-length"] === undefined &&
      revalidate.headers["content-type"] === undefined,
  );

  const identity = await condRequest("/app.js");
  const idEtag = identity.headers.etag;
  check("cond http: the identity variant answers 200 with its own etag", identity.status === 200 && identity.headers["content-encoding"] === undefined && typeof idEtag === "string");
  check("cond http: the gzip etag differs from the identity etag", gzEtag !== idEtag);
  check("cond http: the identity 200 keeps the P2-198 vary", identity.headers["vary"] === "Accept-Encoding");

  const crossVariant = await condRequest("/app.js", { "accept-encoding": "gzip", "if-none-match": idEtag! });
  check(
    "cond http: an identity etag on a gzip-negotiated request is a mismatch — 200 with a body",
    crossVariant.status === 200 &&
      crossVariant.headers["content-encoding"] === "gzip" &&
      crossVariant.body.length > 0 &&
      crossVariant.headers.etag === gzEtag,
  );

  const wildcard = await condRequest("/app.js", { "if-none-match": "*" });
  check("cond http: the wildcard answers 304", wildcard.status === 304 && wildcard.body.length === 0);

  const unknown = await condRequest("/app.js", { "accept-encoding": "gzip", "if-none-match": '"totally-unknown"' });
  check("cond http: an unknown validator answers 200 with a body", unknown.status === 200 && gunzipSync(unknown.body).toString() === bigJs && unknown.headers.etag === gzEtag);

  const weak = await condRequest("/app.js", { "accept-encoding": "gzip", "if-none-match": `W/${gzEtag}` });
  check("cond http: a weak validator matches the strong one (304)", weak.status === 304 && weak.body.length === 0);

  const list = await condRequest("/app.js", { "accept-encoding": "gzip", "if-none-match": ` "nope-1" ,\t${gzEtag} , "nope-2" ` });
  check("cond http: a list matches when one element matches, whitespace ignored", list.status === 304 && list.body.length === 0);

  const malformed = await condRequest("/app.js", { "if-none-match": "W/" });
  check("cond http: a malformed header answers 200 with a body", malformed.status === 200 && malformed.body.length > 0);
  const malformed2 = await condRequest("/app.js", { "if-none-match": ",,," });
  check("cond http: a comma-only header answers 200 with a body", malformed2.status === 200 && malformed2.body.length > 0);

  const tiny = await condRequest("/tiny.js");
  check("cond http: a never-compressed asset carries an identity etag too", tiny.status === 200 && typeof tiny.headers.etag === "string" && tiny.headers.vary === undefined);
  const tinyRevalidate = await condRequest("/tiny.js", { "if-none-match": tiny.headers.etag! });
  check(
    "cond http: the tiny asset revalidates without vary (no variants, like its 200)",
    tinyRevalidate.status === 304 &&
      tinyRevalidate.headers.vary === undefined &&
      tinyRevalidate.headers["content-type"] === undefined,
  );

  // the entry document participates the same way (SPA fallback)
  const spa = await condRequest("/pair", { "accept-encoding": "gzip" });
  check("cond http: the SPA fallback answers 200 with an etag", spa.status === 200 && typeof spa.headers.etag === "string");
  const spaRevalidate = await condRequest("/pair", { "accept-encoding": "gzip", "if-none-match": spa.headers.etag! });
  check(
    "cond http: the SPA fallback revalidates with 304 + vary + security headers, no body",
    spaRevalidate.status === 304 &&
      spaRevalidate.body.length === 0 &&
      spaRevalidate.headers.vary === "Accept-Encoding" &&
      ALWAYS_ON_SECURITY_HEADERS.every((k) => spaRevalidate.headers[k] !== undefined),
  );

  // a rewritten file (new stat) invalidates the stored validator
  writeFileSync(join(root, "app.js"), bigJs + "// rebuilt\n");
  utimesSync(join(root, "app.js"), new Date(1_500_000_000_000), new Date(1_500_000_000_000));
  const rebuilt = await condRequest("/app.js", { "accept-encoding": "gzip", "if-none-match": gzEtag! });
  check(
    "cond http: a rewritten file sends instead of 304 and carries a different etag",
    rebuilt.status === 200 && rebuilt.body.length > 0 && typeof rebuilt.headers.etag === "string" && rebuilt.headers.etag !== gzEtag,
  );

  // 404, 405 and the probe are untouched by conditionals
  const missing = await condRequest("/missing.js", { "if-none-match": "*" });
  check("cond http: 404 is unchanged — no etag, no conditional handling", missing.status === 404 && missing.headers.etag === undefined && missing.body.length === 0);
  const notAllowed = await condRequest("/", { "if-none-match": "*" }, "POST");
  check("cond http: 405 is unchanged", notAllowed.status === 405 && notAllowed.headers.etag === undefined);
  const probe = await condRequest("/healthz", { "if-none-match": "*" });
  check(
    "cond http: /healthz stays byte-for-byte — no etag, same JSON body",
    probe.status === 200 &&
      probe.headers.etag === undefined &&
      probe.body.toString() ===
        `{"ok":true,"version":"0.2.0","uptimeS":${(JSON.parse(probe.body.toString()) as { uptimeS: number }).uptimeS},"rooms":7,"roomsRejected":2}`,
  );

  condServer.close();
  rmSync(root, { recursive: true, force: true });
}

if (failures) process.exit(1);
console.log("relay-healthz: ALL OK");
process.exit(0);
