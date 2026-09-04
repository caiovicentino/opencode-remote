/**
 * Unit tests for the relay /healthz handler (P2-018): public liveness probe
 * for the hosted stage. Verifies the 200 + payload shape, the 404 fallback
 * for non-probe traffic, and that no room ids or secrets leak.
 * Run: npx tsx scripts/relay-healthz.test.ts
 */
import { createServer, get, type Server } from "node:http";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { healthzHandler, healthzPayload } from "../apps/relay/src/healthz";
import { metricsAuthOk, metricsBinding } from "../apps/relay/src/metricsbind";
import { DRAIN_GRACE_MS_CEILING, MAX_FRAME_CEILING, relayLimits } from "../apps/relay/src/limits";
import { createShutdown, DRAIN_MS, refuseUpgrade } from "../apps/relay/src/shutdown";

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

if (failures) process.exit(1);
console.log("relay-healthz: ALL OK");
process.exit(0);
