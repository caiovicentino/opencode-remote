/**
 * eval-19 — the orbital dashboard (apps/pilot/dashboard/mission-v3.html) renders
 * the /api/pilot-status digest: the REAL page script runs in real mode against
 * stubbed DOM/canvas/fetch, fed the digest the daemon computed from production
 * on 2026-09-27 (pilot down since 24/09 08:07, prod 58 commits behind, a
 * disk-guard hold whose cause is gone, 100 undelivered alerts). Before this,
 * the same page showed a gold "stale" heartbeat age and nothing else.
 * Run: npx tsx scripts/dashboard-status.test.ts
 */
import { json, loadDashboard } from "./dashboard-harness";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// the digest readPilotStatus produced from production, 2026-09-27 11:56 GMT-3
const outage = {
  v: 1,
  at: "2026-09-27T14:56:53.299Z",
  installed: true,
  pilot: { state: "down", heartbeatAgeMs: 272_980_137, since: "2026-09-24T11:07:13.162Z", reason: "silent", pid: 35139, pidAlive: false, lastEventAt: "2026-09-24T11:07:09.623Z" },
  deploy: {
    prodSha: "1ebbbc1bae45e3900674e9fa2acd7aa623b54b33",
    mainSha: "d046075aa1f969d75454fc0476b572de44322f70",
    behind: 58,
    pendingSince: "2026-09-23T17:37:36.000Z",
    fetchedAt: "2026-09-24T11:07:13.926Z",
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
const auth: string[] = [];
const dash = await loadDashboard({
  fetch: async (url, init) => {
    auth.push(init?.headers?.authorization ?? "");
    if (url === "/api/pilot-status") return json(statusCode, statusBody);
    if (url === "/api/pilot-events") return json(200, { state: { tasks: 8, merges: 6 }, heartbeatMs: 272_980_137, events: [], cfg: { maxTasksPerDay: 200 } });
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
check("deploy lag (critical) → red PROD −58 chip", on("c-lag") && !amber("c-lag") && /^PROD −58 · \d+(\.\d)?[dhm]$/.test(el("c-lag").textContent), el("c-lag").textContent);
check("disk-guard hold whose cause is gone → amber DEPLOY RETIDO chip", on("c-hold") && amber("c-hold") && el("c-hold").textContent === "DEPLOY RETIDO · DISK-GUARD");
check("…its tooltip carries the guard's own detail and the refusal count", el("c-hold").title.includes("disk low: 2.1gb") && el("c-hold").title.includes("69×"));
check("100 undelivered notifications → amber alerts chip", on("c-alerts") && amber("c-alerts") && el("c-alerts").textContent === "100 AVISOS NÃO ENTREGUES");
check("disk is back above the floor → no DISCO BAIXO chip", !on("c-disk"));
check("HUD PROD row: −58 in red", el("h-lag").textContent === "−58" && el("h-lag").className === "bad", `${el("h-lag").textContent} ${el("h-lag").className}`);
check("HUD PROD row tooltip names both shas", el("h-lag").title.includes("1ebbbc1") && el("h-lag").title.includes("d046075"));
check("HUD DISCO row: 75.6G ok", el("h-disk").textContent === "75.6G" && el("h-disk").className === "ok", el("h-disk").textContent);
check("HUD CUSTO 7D row: tokens when nothing is priced, never US$ 0", el("h-cost").textContent === "1.3B tok" && el("h-cost").title.includes("sem preço"), el("h-cost").textContent);
check("heartbeat dot is red (off), not the old gold 'stale'", el("live").className === "off");
check("HB row reads the outage span in red", el("h-hb").textContent === "3.2d" && el("h-hb").className === "bad", el("h-hb").textContent);
check("NOTIFY row turns red with undelivered alerts", el("h-notify").className === "bad");

openStatus();
check("drill-down opens with the fleet facts", el("modal").classList.contains("open") && el("m-facts").innerHTML.includes("PARADO") && el("m-facts").innerHTML.includes("1ebbbc1 → d046075 · −58"));
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
  deploy: { ...outage.deploy, behind: 0, hold: null, pendingSince: null },
  alerts: { undelivered: 0, lastDeliveredAgeMs: 60_000 },
  attention: [],
};
await loadStatus();
renderHud();
check("healthy digest → no status chip", !on("c-pilot") && !on("c-lag") && !on("c-hold") && !on("c-disk") && !on("c-alerts"));
check("healthy digest → PROD row reads EM DIA", el("h-lag").textContent === "EM DIA" && el("h-lag").className === "ok");

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
