// Headless smoke for mission-v3.html: DOM/canvas stubs, run the ?mock=1 timeline
// at high speed through real frames, assert no exceptions + that every visual
// state (ship, moons, core, gate lamps, stations, signal loss) was exercised.
//   node apps/pilot/dashboard/mission-v3.smoke.mjs [speed]   (RM=1 → reduced motion)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "mission-v3.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const main = scripts[scripts.length - 1];

const noop = () => {};
function el(id) {
  return { id, style: {}, textContent: "", innerHTML: "", title: "", className: "", value: "", dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, querySelector: () => el(id + ">q"), querySelectorAll: () => [], focus: noop };
}
const ctxCalls = { arc: 0, fillText: 0 };
function ctx2d() {
  return new Proxy({}, {
    get(t, k) {
      if (k === "measureText") return () => ({ width: 50 });
      if (k === "createRadialGradient" || k === "createLinearGradient") return () => ({ addColorStop: noop });
      if (k === "arc") return (x, y, r) => { ctxCalls.arc++; if (![x, y, r].every(Number.isFinite)) throw new Error(`bad arc ${x},${y},${r}`); };
      if (k === "fillText") return (s) => { ctxCalls.fillText++; if (typeof s === "string" && /NaN|undefined/.test(s)) throw new Error("bad label: " + s); };
      if (k in t) return t[k];
      return noop;
    },
    set(t, k, v) { if (typeof v === "string" && /NaN|undefined/.test(v)) throw new Error(`bad style ${String(k)}=${v}`); t[k] = v; return true; },
  });
}
const canvas = { ...el("scene"), width: 0, height: 0, getContext: () => ctx2d() };
const speed = Number(process.argv[2] || 40);
let rafCb = null;
const g = globalThis;
g.window = g; g.self = g;
g.location = { search: `?mock=1&speed=${speed}`, pathname: "/dashboard/v3" };
g.history = { replaceState: noop };
g.localStorage = { getItem: () => null, setItem: noop };
g.matchMedia = () => ({ matches: process.env.RM === "1" });
g.innerWidth = 1440; g.innerHeight = 900; g.devicePixelRatio = 2;
g.document = { getElementById: (id) => (id === "scene" ? canvas : el(id)), createElement: () => ({ getContext: () => ctx2d(), width: 0, height: 0 }),
  body: el("body"), activeElement: el("x") };
g.addEventListener = noop; g.requestAnimationFrame = (cb) => { rafCb = cb; };
g.fetch = () => Promise.reject(new Error("no network in smoke"));
g.setTimeout = () => 0; g.clearTimeout = noop;
g.__OCR_TOKEN__ = "__APITOKEN__";

const src = main + "\n;globalThis.__w = world; globalThis.__SCRIPT = SCRIPT; globalThis.__apply = apply;";
new Function(src)();
const w = g.__w;
const total = g.__SCRIPT[g.__SCRIPT.length - 1].t;
console.log(`script: ${g.__SCRIPT.length} entries, ${total.toFixed(1)}s at ×1, ×${speed} → ${(total / speed).toFixed(1)}s`);

let t = 16, frames = 0, maxShips = 0, offlineSeen = false;
const seenStates = new Set(), seenCore = new Set(), seenLamps = new Set(), seenStations = new Set();
const end = (total / speed + 3) * 1000;
while (t < end) {
  rafCb(t); t += 1000 / 60; frames++;
  maxShips = Math.max(maxShips, w.ships.size);
  for (const s of w.ships.values()) { seenStates.add(s.state); if (s.moons) seenStates.add("moons:" + s.moons.st); }
  seenCore.add(w.core.state);
  for (const l of w.lamps) seenLamps.add(l.st);
  for (const [k, st] of Object.entries(w.stations)) seenStations.add(k + ":" + st.st);
  if (w.offline) offlineSeen = true;
}
console.log(`frames: ${frames}, arcs drawn: ${ctxCalls.arc}, labels: ${ctxCalls.fillText}`);
console.log("max ships:", maxShips, "| ship states:", [...seenStates].sort().join(", "));
console.log("core states:", [...seenCore].join(", "), "| lamp states:", [...seenLamps].join(", "));
console.log("stations:", [...seenStations].sort().join(", "));
console.log("offline seen:", offlineSeen, "| audit at end:", w.audit, "| ships left:", [...w.ships.keys()].join(",") || "(none)");
const expect = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };
expect(["idle", "working", "ok", "fail", "blocked", "landing", "landed", "deploying"].every((s) => seenStates.has(s)), "every ship state animated");
expect(["moons:working", "moons:ok", "moons:fail", "moons:escalate"].every((s) => seenStates.has(s)), "every review-moon state animated");
expect(["deploying", "ok", "fail", "unhealthy"].every((s) => seenCore.has(s)), "every core state animated");
expect(["idle", "scan", "ok", "fail", "flaky"].every((s) => seenLamps.has(s)), "every gate lamp state animated");
expect(["strategist:ok", "research:ok", "explorer:ok", "forensic:ok"].every((s) => seenStations.has(s)), "every station fired");
expect(offlineSeen && !w.offline, "signal loss + recovery");
expect(maxShips >= 2, "two concurrent flights");

// real-mode style ingest of out-of-vocabulary / malformed events must not throw
for (const e of [
  { ts: "bad", type: "phase", task: "X-1", phase: "weird-phase", detail: null }, { type: "deploy", phase: "mystery" },
  { type: "result", task: "X-1", ok: false }, { type: "phase", task: "strategist", phase: "refill", ok: false },
  { type: "audit", detail: "fever — queue paused" }, { type: "phase", phase: "orphan" }, { type: "agent", task: "X-2", detail: "x" },
  { type: "phase", task: "X-3", phase: "gate-fail", ok: false, detail: "unknown-step" }, { type: "phase", task: "nightly", phase: "skipped", ok: false, detail: "busy" },
]) g.__apply(e, true);
for (let i = 0; i < 30; i++) { rafCb(t); t += 16; }
console.log("ok: malformed feed tolerated");
