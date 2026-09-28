/**
 * eval-19 — the orbital dashboard (apps/pilot/dashboard/mission-v3.html) renders
 * the /api/pilot-status digest: the REAL page script runs in real mode against
 * stubbed DOM/canvas/fetch, fed the digest the daemon computed from production
 * on 2026-09-27 (pilot down since 24/09 08:07, prod 58 commits behind, a
 * disk-guard hold whose cause is gone, 100 undelivered alerts). Before this,
 * the same page showed a gold "stale" heartbeat age and nothing else.
 * Run: npx tsx scripts/dashboard-status.test.ts
 */
import "./testhome"; // FIRST: throwaway HOME before any app module resolves ~/.opencode-remote
import { json, loadDashboard } from "./dashboard-harness";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// the digest readPilotStatus produces from production (re-read 2026-09-27 after
// the lag fix): pilot down since 24/09 08:07, 16 VERIFIED merges pending (68
// first-parent commits on origin/main after prod, most of them bookkeeping), a
// disk-guard hold whose cause is gone, 100 undelivered alerts
const outage = {
  v: 1,
  at: "2026-09-27T20:29:25.706Z",
  installed: true,
  pilot: { state: "down", heartbeatAgeMs: 272_980_137, since: "2026-09-24T11:07:13.162Z", reason: "silent", pid: 35139, pidAlive: false, lastEventAt: "2026-09-24T11:07:09.623Z" },
  deploy: {
    prodSha: "1ebbbc1bae45e3900674e9fa2acd7aa623b54b33",
    mainSha: "b585ea253a1f49a24f6a7bc38a3f8cdd481cc098",
    behind: 16,
    behindTotal: 67,
    pendingSince: "2026-09-24T07:11:01.000Z",
    fetchedAt: "2026-09-27T20:29:25.706Z",
    hold: { reason: "disk-guard", detail: "disk low: 2.1gb free (need 5.0gb) — deploy aborted before npm ci/build", at: "2026-09-24T10:40:38.632Z", until: "2026-09-24T11:10:39.215Z", count: 69 },
  },
  disk: { freeBytes: 81_197_068_288, totalBytes: 245_107_195_904, minFreeBytes: 5_368_709_120 },
  queue: { ready: 2, blocked: 12, misplaced: 2, source: "origin/main" },
  cost: {
    day: { windowMs: 86_400_000, merges: 0, tokens: 0, usd: null, unpricedTokens: 0 },
    week: { windowMs: 604_800_000, merges: 63, tokens: 1_282_221_897, usd: null, unpricedTokens: 1_282_221_897 },
  },
  alerts: { undelivered: 100, lastDeliveredAgeMs: 1_338_916_548 },
  attention: [
    { kind: "pilot-down", level: "critical" },
    { kind: "deploy-lag", level: "critical" },
    { kind: "deploy-hold", level: "warn" },
    { kind: "alerts-undelivered", level: "warn" },
  ],
};

let statusBody: unknown = outage;
let statusCode = 200;
let eventsBody: Record<string, unknown> = { state: { tasks: 8, merges: 6 }, heartbeatMs: 272_980_137, events: [], cfg: { maxTasksPerDay: 200 } };
const auth: string[] = [];
const dash = await loadDashboard({
  fetch: async (url, init) => {
    auth.push(init?.headers?.authorization ?? "");
    if (url === "/api/pilot-status") return json(statusCode, statusBody);
    if (url === "/api/pilot-events") return json(200, eventsBody);
    if (url === "/api/pilot-ready") return json(200, { ready: [{ id: "P2-356" }, { id: "P2-357" }], blocked: [] });
    if (url === "/api/pilot-history") return json(200, { exists: false });
    if (url === "/api/pilot-mission") return json(200, { mission: "x" });
    return json(404, {});
  },
});
const el = dash.el;
const w = dash.world as { status: unknown };
const renderHud = dash.fn.renderHud as () => void;
const loadStatus = dash.fn.loadStatus as () => Promise<void>;
const openStatus = dash.fn.openStatus as () => void;

check("the first poll fetches the digest with the Bearer token", auth.includes("Bearer test-token") && !!w.status, JSON.stringify(auth));
renderHud();
const on = (id: string) => el(id).classList.contains("on");
const amber = (id: string) => el(id).classList.contains("amber");
check("pilot down → red PILOTO PARADO chip with the outage span", on("c-pilot") && !amber("c-pilot") && el("c-pilot").textContent === "PILOTO PARADO · 3.2d", el("c-pilot").textContent);
check("…its tooltip says since when and that the pid is dead", el("c-pilot").title.includes("24/09") && el("c-pilot").title.includes("pid 35139 morto"), el("c-pilot").title);
check("deploy lag (critical) → red PROD −16 chip (verified merges, not raw commits)", on("c-lag") && !amber("c-lag") && /^PROD −16 · \d+(\.\d)?[dhm]$/.test(el("c-lag").textContent), el("c-lag").textContent);
check("disk-guard hold whose cause is gone → amber DEPLOY RETIDO chip", on("c-hold") && amber("c-hold") && el("c-hold").textContent === "DEPLOY RETIDO · DISK-GUARD");
check("…its tooltip carries the guard's own detail and the refusal count", el("c-hold").title.includes("disk low: 2.1gb") && el("c-hold").title.includes("69×"));
check("…the lag chip's tooltip names the verified-merge semantics and the commit total", el("c-lag").title.includes("16 merge(s) verificado(s) atrás do main (1ebbbc1 → b585ea2 · 67 commit(s) no total)"), el("c-lag").title);
check("100 undelivered notifications → amber alerts chip", on("c-alerts") && amber("c-alerts") && el("c-alerts").textContent === "100 AVISOS NÃO ENTREGUES");
check("disk is back above the floor → no DISCO BAIXO chip", !on("c-disk"));
check("HUD PROD row: −16 in red", el("h-lag").textContent === "−16" && el("h-lag").className === "bad", `${el("h-lag").textContent} ${el("h-lag").className}`);
check("HUD PROD row tooltip names both shas and the commit total", el("h-lag").title.includes("1ebbbc1") && el("h-lag").title.includes("b585ea2") && el("h-lag").title.includes("67 commit(s)"));
check("HUD DISCO row: 75.6G ok", el("h-disk").textContent === "75.6G" && el("h-disk").className === "ok", el("h-disk").textContent);
check("HUD CUSTO 7D row: tokens when nothing is priced, never US$ 0", el("h-cost").textContent === "1.3B tok" && el("h-cost").title.includes("sem preço"), el("h-cost").textContent);
check("heartbeat dot is red (off), not the old gold 'stale'", el("live").className === "off");
check("HB row reads the outage span in red", el("h-hb").textContent === "3.2d" && el("h-hb").className === "bad", el("h-hb").textContent);
check("NOTIFY row turns red with undelivered alerts", el("h-notify").className === "bad");

openStatus();
check("drill-down opens with the fleet facts", el("modal").classList.contains("open") && el("m-facts").innerHTML.includes("PARADO") && el("m-facts").innerHTML.includes("1ebbbc1 → b585ea2 · −16 · 67 commits"));
check("drill-down lists every flag, most severe first", (el("m-tl").innerHTML.match(/<div>/g) ?? []).length === 4 && el("m-tl").innerHTML.indexOf("pilot-down") < el("m-tl").innerHTML.indexOf("alerts-undelivered"));
check("drill-down queue fact reads origin/main counts", el("m-facts").innerHTML.includes("2 prontas · 12 bloqueadas"));

// the painter keeps running with the digest in place
let threw = "";
try {
  dash.frames(30);
} catch (err) {
  threw = String(err);
}
check("painter frames run with the digest loaded", threw === "", threw);

// healthy fleet: every status chip goes away
statusBody = {
  ...outage,
  pilot: { ...outage.pilot, state: "alive", heartbeatAgeMs: 12_000, pidAlive: true },
  deploy: { ...outage.deploy, behind: 0, behindTotal: 0, hold: null, pendingSince: null },
  alerts: { undelivered: 0, lastDeliveredAgeMs: 60_000 },
  attention: [],
};
await loadStatus();
renderHud();
check("healthy digest → no status chip", !on("c-pilot") && !on("c-lag") && !on("c-hold") && !on("c-disk") && !on("c-alerts"));
check("healthy digest → PROD row reads EM DIA", el("h-lag").textContent === "EM DIA" && el("h-lag").className === "ok");

// eval-19 fix: the core is PROD but its pulse is the PILOT's heartbeat — a
// third party kept the heartbeat file fresh for a pilot dead since 24/09, so
// the raw hb age must not pulse the core beside the PILOTO PARADO chip, and
// the core's label shows the pilot's own last sign of life
{
  statusBody = {
    ...outage,
    pilot: { ...outage.pilot, state: "down", reason: "pid-dead", since: "2026-09-24T11:07:09.623Z", silentForMs: 272_984_000, heartbeatAgeMs: 3_000 },
  };
  eventsBody = { ...eventsBody, heartbeatMs: 3_000 }; // the foreign fresh touch
  await loadStatus();
  await (dash.fn.poll as () => Promise<void>)();
  check("…and the core labels the pilot's own last sign of life (3.2d), not the raw '3s'", (dash.fn.coreHbLabel as () => string)() === "3.2d", (dash.fn.coreHbLabel as () => string)());
  check("…and the digest verdict drives the core-down gate", (dash.fn.corePilotDownFn as () => boolean)() === true);
  // the gate itself, staged at poll time: the heartbeat freshened (3.0s →
  // 2.0s) but the digest still says down → no ring; alive → the ring returns
  const w2 = dash.world as { status: unknown; hbMs: number | null; lastHb: number | null };
  statusBody = { ...outage, pilot: { ...outage.pilot, state: "down", reason: "pid-dead", since: "2026-09-24T11:07:09.623Z", silentForMs: 272_984_000, heartbeatAgeMs: 3_000 } };
  await loadStatus();
  w2.hbMs = 2_000;
  w2.lastHb = 3_000;
  check("…staged: a freshening heartbeat with the digest still down → no ring", (dash.fn.pulseWanted as () => boolean)() === false);
  statusBody = { ...outage, pilot: { ...outage.pilot, state: "alive", heartbeatAgeMs: 3_000, pidAlive: true }, deploy: { ...outage.deploy, behind: 0, behindTotal: 0, hold: null, pendingSince: null }, alerts: { undelivered: 0, lastDeliveredAgeMs: 60_000 }, attention: [] };
  await loadStatus();
  check("…staged: the same freshening heartbeat with the digest alive → the ring returns", (dash.fn.pulseWanted as () => boolean)() === true);
  w2.hbMs = 272_980_137;
  w2.lastHb = null;
  eventsBody = { ...eventsBody, heartbeatMs: 272_980_137 };
  statusBody = outage;
}

// a machine without the pilot, and an old daemon without the route
statusBody = { ...outage, installed: false };
await loadStatus();
renderHud();
check("pilot not installed → no chips, dashes in the HUD", !on("c-pilot") && !on("c-alerts") && el("h-lag").textContent === "—");
statusBody = null;
statusCode = 404;
(w as { status: unknown }).status = null;
await loadStatus();
let broke = "";
try {
  renderHud();
} catch (err) {
  broke = String(err);
}
check("daemon without /api/pilot-status (404) → page keeps working, no chips", broke === "" && !on("c-pilot") && w.status === null, broke);

dash.restore();
if (failures) process.exit(1);
console.log("dashboard-status: all checks passed");
