/**
 * Unit tests for the relay /healthz handler (P2-018): public liveness probe
 * for the hosted stage. Verifies the 200 + payload shape, the 404 fallback
 * for non-probe traffic, and that no room ids or secrets leak.
 * Run: npx tsx scripts/relay-healthz.test.ts
 */
import { createServer, get, type Server } from "node:http";
import { healthzHandler, healthzPayload } from "../apps/relay/src/healthz";
import { metricsAuthOk, metricsBinding } from "../apps/relay/src/metricsbind";
import { MAX_FRAME_CEILING, relayLimits } from "../apps/relay/src/limits";

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

if (failures) process.exit(1);
console.log("relay-healthz: ALL OK");
process.exit(0);
