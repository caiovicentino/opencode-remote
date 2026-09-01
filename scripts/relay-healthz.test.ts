/**
 * Unit tests for the relay /healthz handler (P2-018): public liveness probe
 * for the hosted stage. Verifies the 200 + payload shape, the 404 fallback
 * for non-probe traffic, and that no room ids or secrets leak.
 * Run: npx tsx scripts/relay-healthz.test.ts
 */
import { createServer, get, type Server } from "node:http";
import { healthzHandler, healthzPayload } from "../apps/relay/src/healthz";

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
if (failures) process.exit(1);
console.log("relay-healthz: ALL OK");
process.exit(0);
