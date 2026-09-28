/**
 * eval-19 — Mission Control's fleet strip (desktop forensic view + phone):
 * fleetLines/fleetFacts render the daemon's status digest in both languages,
 * cardDisplayStatus stops a dead pilot's cards from claiming "running", and
 * the phone's tunnel adapter reaches the sealed /__ocr/pilot-status route.
 * Run: npx tsx scripts/mission-fleet.test.ts
 */
import "./testhome"; // FIRST: throwaway HOME before any app module resolves ~/.opencode-remote
import { readFileSync } from "node:fs";
import {
  cardDisplayStatus,
  fleetFacts,
  fleetLines,
  fmtGB,
  fmtSpan,
  fmtTokens,
  isFleetStatusView,
  tunnelApi,
  type FleetStatusView,
} from "../apps/web/src/components/MissionControlView";
import { dict, translate } from "../apps/web/src/lib/i18n";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const pt = (k: string, v?: Record<string, string | number>) => translate("pt", k, v);
const en = (k: string, v?: Record<string, string | number>) => translate("en", k, v);

// the production digest of 2026-09-27 (see scripts/dashboard-status.test.ts):
// 16 VERIFIED merges pending, 67 first-parent commits in total (bookkeeping
// never deploys alone), pilot down since 24/09 08:07
const outage: FleetStatusView = {
  v: 1,
  installed: true,
  pilot: { state: "down", heartbeatAgeMs: 272_980_137, since: "2026-09-24T11:07:13.162Z" },
  deploy: { behind: 16, behindTotal: 67, pendingSince: "2026-09-24T07:11:01.000Z", hold: { reason: "disk-guard", count: 69 } },
  disk: { freeBytes: 81_197_068_288, minFreeBytes: 5_368_709_120 },
  queue: { ready: 2, blocked: 12 },
  cost: { week: { merges: 63, tokens: 1_282_221_897, usd: null, unpricedTokens: 1_282_221_897 } },
  alerts: { undelivered: 100 },
  attention: [
    { kind: "pilot-down", level: "critical" },
    { kind: "deploy-lag", level: "critical" },
    { kind: "deploy-hold", level: "warn" },
    { kind: "alerts-undelivered", level: "warn" },
  ],
};

// ── formatting ──
check("fmtSpan: seconds/minutes/hours/days", fmtSpan(40_000) === "40s" && fmtSpan(12 * 60_000) === "12min" && fmtSpan(5 * 3_600_000) === "5.0h" && fmtSpan(272_980_137) === "3.2d");
check("fmtSpan: unknown → dash", fmtSpan(null) === "—" && fmtSpan(Number.NaN) === "—" && fmtSpan(-1) === "—");
check("fmtGB: one decimal in GB", fmtGB(81_197_068_288) === "75.6 GB" && fmtGB(null) === "—");
check("fmtTokens: k/M/B", fmtTokens(845_000) === "845k" && fmtTokens(12_300_000) === "12.3M" && fmtTokens(1_282_221_897) === "1.3B" && fmtTokens(0) === "0");

// ── fleetLines (pt) ──
{
  const lines = fleetLines(outage, pt);
  check("pt: one line per attention flag, in the digest's order", lines.map((l) => l.key).join(",") === "pilot-down,deploy-lag,deploy-hold,alerts-undelivered", JSON.stringify(lines));
  check("pt: pilot line says stopped + span + last signal", lines[0]!.level === "critical" && lines[0]!.text.startsWith("Piloto parado há 3.2d — último sinal 24/09"), lines[0]!.text);
  check("pt: lag line counts VERIFIED merges (not raw commits) and reads fine for n=1", lines[1]!.text === "Produção 16 merge(s) verificado(s) atrás do main (pendente desde 24/09, 04:11)", lines[1]!.text);
  check("pt: a disk-guard hold whose space is back says what it waits for", lines[2]!.level === "warn" && lines[2]!.text === "Deploy retido: disk-guard — o espaço já voltou (75.6 GB), falta uma nova tentativa", lines[2]!.text);
  check("pt: alerts line counts the undelivered notifications", lines[3]!.text === "100 aviso(s) ao supervisor nunca entregue(s)", lines[3]!.text);
  check("pt: facts line = queue, disk, unpriced week cost (never US$ 0)", fleetFacts(outage, pt) === "Fila 2 prontas · 12 bloqueadas · Disco 75.6 GB livres · Custo 7d 1.3B tokens (sem preço)", fleetFacts(outage, pt));
}
// ── fleetLines (en) + other states ──
{
  const lines = fleetLines(outage, en);
  check("en: same lines in English", lines[0]!.text.startsWith("Pilot stopped 3.2d ago") && lines[3]!.text === "100 supervisor alert(s) never delivered", JSON.stringify(lines.map((l) => l.text)));
  const lowDisk: FleetStatusView = { ...outage, disk: { freeBytes: 2.1 * 1024 ** 3, minFreeBytes: 5 * 1024 ** 3 }, attention: [{ kind: "deploy-hold", level: "critical" }, { kind: "disk-low", level: "critical" }] };
  const low = fleetLines(lowDisk, pt);
  check("pt: hold with the disk still low names only the guard", low[0]!.text === "Deploy retido: disk-guard" && low[1]!.text === "Disco baixo: 2.1 GB livres (o deploy exige 5.0 GB)", JSON.stringify(low));
  const healthy: FleetStatusView = { ...outage, pilot: { state: "alive", heartbeatAgeMs: 9_000, since: null }, deploy: { behind: 0, pendingSince: null, hold: null }, alerts: { undelivered: 0 }, attention: [] };
  check("pt: healthy fleet → one all-clear line", JSON.stringify(fleetLines(healthy, pt)) === JSON.stringify([{ key: "ok", level: "ok", text: "Piloto ativo · produção em dia" }]));
  const priced: FleetStatusView = { ...healthy, cost: { week: { merges: 3, tokens: 1000, usd: 12.3456, unpricedTokens: 0 } } };
  check("facts: priced week shows dollars", fleetFacts(priced, pt).endsWith("Custo 7d US$ 12.35"), fleetFacts(priced, pt));
  check("not installed → no lines at all (product users never see fleet alarms)", fleetLines({ ...outage, installed: false }, pt).length === 0);
  const stale = fleetLines({ ...healthy, pilot: { state: "stale", heartbeatAgeMs: 12 * 60_000, since: null }, attention: [{ kind: "pilot-stale", level: "warn" }] }, pt);
  const pidDead = fleetLines({ ...outage, pilot: { state: "down", heartbeatAgeMs: 10_000, since: "2026-09-24T11:07:09.623Z", silentForMs: 272_984_000 } }, pt);
  check("pt: a pid-dead outage counts silence from the last activity, not the (foreign) heartbeat", pidDead[0]!.text.startsWith("Piloto parado há 3.2d — último sinal 24/09"), pidDead[0]!.text);
  check("pt: stale pilot → warning line with the silence span", stale.length === 1 && stale[0]!.level === "warn" && stale[0]!.text === "Piloto sem sinal há 12min");
}

// ── loadFleet's acceptance contract (the fix for the pane-wide crash) ──────
// The old load accepted any JSON with installed + attention[] and the render
// then read pilot/deploy/disk/queue/cost.week/alerts unguarded: a digest from
// an older/newer daemon (cost.week without `usd`, or no pilot at all) threw
// `Cannot read properties of undefined` and the WHOLE pane died — the 6s poll
// never recovered. The guard mirrors the dashboard's acceptStatus: only a
// digest with every section this pane reads is accepted; anything else keeps
// the previous view.
{
  check("guard: the full production digest is accepted", isFleetStatusView(outage) === true);
  check("guard: the old loose contract (installed + attention only) is rejected", isFleetStatusView({ installed: true, attention: [] }) === false);
  check("guard: a digest without pilot is rejected", isFleetStatusView({ ...outage, pilot: undefined }) === false);
  const noUsd = JSON.parse(JSON.stringify(outage)) as Record<string, unknown>;
  delete (noUsd as { cost: { week: Record<string, unknown> } }).cost.week.usd;
  check("guard: the sections the strip reads are all present, so the usd-less digest is accepted — and the render degrades (typeof)", isFleetStatusView(noUsd) === true);
  check("guard: a digest without the cost section at all is rejected", isFleetStatusView({ ...outage, cost: undefined }) === false);
  check("guard: a digest without v (or a future v) is rejected", isFleetStatusView({ ...outage, v: 2 }) === false && isFleetStatusView({ ...outage, v: undefined }) === false);
  check("guard: a non-object or null digest is rejected", isFleetStatusView(null) === false && isFleetStatusView("x") === false && isFleetStatusView([]) === false);
  // belt and braces: even a digest that slips through must not crash the
  // render helpers — `usd` is only read when it is a number
  let broke = "";
  try {
    const unpriced = fleetFacts({ ...outage, cost: { week: { merges: 1, tokens: 500, usd: undefined as unknown as null, unpricedTokens: 500 } } }, pt);
    check("facts: an undefined week usd degrades to the token count, never throws", unpriced.includes("Custo 7d 1k tokens (sem preço)"), unpriced);
  } catch (err) {
    broke = String(err);
  }
  check("facts: fleetFacts survived the undefined usd", broke === "", broke);
}

// ── zombie cards ──
check("card: running + pilot down → stalled", cardDisplayStatus("running", "down") === "stalled");
check("card: running + pilot alive/stale/unknown stays running", cardDisplayStatus("running", "alive") === "running" && cardDisplayStatus("running", "stale") === "running" && cardDisplayStatus("running", undefined) === "running");
check("card: merged/failed never relabeled", cardDisplayStatus("merged", "down") === "merged" && cardDisplayStatus("failed", "down") === "failed");
check("i18n: the stalled badge exists in both languages", pt("missionSt_stalled") === "interrompida" && en("missionSt_stalled") === "stalled");

// ── i18n parity for the new keys ──
{
  const keys = ["fleetTitle", "fleetPilotDown", "fleetPilotStale", "fleetPilotAlive", "fleetProdBehind", "fleetProdCurrent", "fleetDeployHold", "fleetDeployHoldResolved", "fleetDiskLow", "fleetAlerts", "fleetFacts", "fleetCostUnpriced", "missionSt_stalled", "missionLegacySource"];
  const d = dict as unknown as Record<"en" | "pt", Record<string, string>>;
  const missing = keys.filter((k) => !d.en[k] || !d.pt[k]);
  check("i18n: every fleet key exists in en and pt", missing.length === 0, missing.join(","));
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  const drift = keys.filter((k) => d.en[k] && d.pt[k] && vars(d.en[k]!) !== vars(d.pt[k]!));
  check("i18n: en and pt carry the same placeholders", drift.length === 0, drift.join(","));
  check("i18n: no emoji in the fleet copy", keys.every((k) => !/\p{Extended_Pictographic}/u.test(`${d.en[k]}${d.pt[k]}`)));
}

// ── phone: the tunnel adapter maps the digest onto the sealed route ──
{
  const calls: string[] = [];
  const api = tunnelApi(async (method, path) => {
    calls.push(`${method} ${path}`);
    return { status: 200, body: { installed: true, attention: [] } };
  });
  const r = await api({ path: "/api/pilot-status" });
  const body = JSON.parse(Buffer.from(r!.body, "base64").toString("utf8")) as { installed?: boolean };
  check("phone: /api/pilot-status rides GET /__ocr/pilot-status", calls[0] === "GET /__ocr/pilot-status" && r!.status === 200 && body.installed === true, calls.join(" | "));
  const post = await api({ path: "/api/pilot-status", method: "POST" });
  check("phone: only GET is mapped (anything else stays host-only 501)", post!.status === 501 && calls.length === 1);
}

// ── wiring (source) ──
{
  const src = readFileSync(new URL("../apps/web/src/components/MissionControlView.tsx", import.meta.url), "utf8");
  check("view: loads the digest through the same daemonApi as the cards", src.includes('daemonApi({ path: "/api/pilot-status" })') && src.includes("void loadFleet();"));
  check("view: loadFleet accepts only a fully-shaped digest (isFleetStatusView)", src.includes("if (isFleetStatusView(json)) setFleet(json);"), src.slice(src.indexOf("const loadFleet"), src.indexOf("const loadFleet") + 400));
  check("view: the card badge and its ETA follow cardDisplayStatus", src.includes("st-${cardDisplayStatus(c.status, fleet?.pilot.state)}") && src.includes('cardDisplayStatus(c.status, fleet?.pilot.state) === "running" && c.etaMs !== null'));
  check("view: the strip hides before pairing and for machines without the pilot", src.includes('fleet?.installed && !prePairing && (phone || view === "forensic")'));
  // production 2026-09-27: mission.json held only `models` (no valid spec)
  // while the fleet ran pilot.json's mission — the card said "no mission"
  check("view: without a valid mission.json spec the card shows pilot.json's mission (no clear button)", src.includes("setLegacyMission(!(spec && typeof spec === \"object\") && typeof json?.mission === \"string\"") && src.includes("data-mission-legacy") && src.includes('t("missionLegacySource")'));
  const css = readFileSync(new URL("../apps/web/src/index.css", import.meta.url), "utf8");
  check("css: stalled badge + strip severities styled", css.includes(".mission-st.st-stalled {") && css.includes('.fleet-strip[data-fleet="critical"]') && css.includes(".fleet-critical .fleet-dot"));
}

if (failures) process.exit(1);
console.log("mission-fleet: all checks passed");
