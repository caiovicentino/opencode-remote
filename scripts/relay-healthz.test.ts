/**
 * Unit tests for the relay /healthz handler (P2-018): public liveness probe
 * for the hosted stage. Verifies the 200 + payload shape, the 404 fallback
 * for non-probe traffic, and that no room ids or secrets leak.
 * Run: npx tsx scripts/relay-healthz.test.ts
 */
import { createServer, get, type Server } from "node:http";
import net from "node:net";
import { createReadStream, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { healthzHandler, healthzPayload } from "../apps/relay/src/healthz";
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

if (failures) process.exit(1);
console.log("relay-healthz: ALL OK");
process.exit(0);
