/**
 * Unit tests for the PWA origin watchdog + static server (P2-075).
 * Pins the transition/alert semantics of apps/daemon/src/pwawatch.ts and the
 * real deploy/pwa-server.mjs behavior (healthz, static serving, traversal
 * guard, SPA-less 404s).
 * Run: npx tsx scripts/pwa-watch.test.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PWA_HEALTHZ_URL,
  pwaOriginAlert,
  pwaWatchEnabled,
  startPwaWatch,
} from "../apps/daemon/src/pwawatch";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("pwa-watch test timed out (global 20s)");
  process.exit(1);
}, 20_000).unref();

// --- 1. pwaOriginAlert: newest pwa-origin event wins --------------------------
check("alert: empty feed → null (chip stays dark)", pwaOriginAlert([]) === null);
check(
  "alert: ignores unrelated events",
  pwaOriginAlert([
    { task: "P2-001", phase: "build", ok: true },
    { task: "pwa", phase: "other", ok: false },
  ]) === null,
);
check(
  "alert: down verdict",
  pwaOriginAlert([{ task: "pwa", phase: "origin", ok: false, detail: "d" }])?.down === true,
);
check(
  "alert: newest verdict wins (recovery clears)",
  pwaOriginAlert([
    { task: "pwa", phase: "origin", ok: false, detail: "down" },
    { task: "pwa", phase: "origin", ok: true, detail: "back" },
  ])?.down === false,
);
check(
  "alert: newest verdict wins (later down alerts)",
  pwaOriginAlert([
    { task: "pwa", phase: "origin", ok: true },
    { task: "P2-002", phase: "merge", ok: true },
    { task: "pwa", phase: "origin", ok: false, detail: "dead" },
  ])?.detail === "dead",
);

// --- 2. pwaWatchEnabled: env opt-in or plist presence -------------------------
const missing = join(tmpdir(), `ocr-no-plist-${Date.now()}`, "com.ocr.pwa.plist");
check("enabled: no env, no plist → off", pwaWatchEnabled(undefined, missing) === false);
check("enabled: env url → on", pwaWatchEnabled(DEFAULT_PWA_HEALTHZ_URL, missing) === true);
const plistDir = mkdtempSync(join(tmpdir(), "ocr-pwa-"));
const plist = join(plistDir, "com.ocr.pwa.plist");
writeFileSync(plist, "<plist/>");
check("enabled: plist present → on", pwaWatchEnabled(undefined, plist) === true);

// --- 3. startPwaWatch: fires exactly on transitions ---------------------------
const transitions: boolean[] = [];
const probeQueue = [true, true, false, false, true, true, false];
let cursor = 0;
const probe = async () => probeQueue[Math.min(cursor++, probeQueue.length - 1)]!;
const stop = startPwaWatch({
  probe,
  intervalMs: 10,
  initialDelayMs: 0,
  onTransition: (down) => transitions.push(down),
});
await new Promise((r) => setTimeout(r, 150));
stop();
check("watch: first healthy probe is silent (assumed up)", transitions[0] === true);
// sequence: up up down down up up down → transitions exactly [down, up, down]
check(
  "watch: one transition per flip, nothing else",
  JSON.stringify(transitions) === JSON.stringify([true, false, true]),
);

// --- 4. real server: spawn deploy/pwa-server.mjs against a temp dist ----------
const dist = join(plistDir, "dist");
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "index.html"), "<html>ocr-pwa</html>");
writeFileSync(join(dist, "sw.js"), "// sw");
writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
writeFileSync(join(dist, "secret.txt"), "top");
const port = 30_000 + Math.floor(Math.random() * 20_000);
const child = spawn(process.execPath, [fileURLToPath(new URL("../deploy/pwa-server.mjs", import.meta.url))], {
  env: { ...process.env, PWA_PORT: String(port), PWA_DIST_DIR: dist },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  up = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
  if (!up) await new Promise((r) => setTimeout(r, 100));
}
check("server: /healthz answers 200 with ok:true", up);
check(
  "server: healthz payload shape",
  up && (await (await fetch(`${base}/healthz`)).json()).ok === true,
);
check("server: / serves index.html", up && (await (await fetch(base)).text()) === "<html>ocr-pwa</html>");
const asset = await fetch(`${base}/assets/app.js`);
check("server: asset served with js mime", asset.status === 200 && asset.headers.get("content-type")?.includes("text/javascript"));
check("server: hashed assets are immutable", (asset.headers.get("cache-control") ?? "").includes("immutable"));
check("server: sw.js is no-cache", (await (await fetch(`${base}/sw.js`)).headers.get("cache-control")) === "no-cache");
check("server: unknown path → 404", (await fetch(`${base}/nope`)).status === 404);
check(
  "server: traversal rejected",
  (await fetch(`${base}/..%2f..%2f..%2fpackage.json`)).status === 404 &&
    (await fetch(`${base}/../package.json`)).status === 404,
);
check("server: POST → 405", (await fetch(base, { method: "POST" })).status === 405);
child.kill("SIGTERM");
await new Promise((r) => {
  child.on("exit", () => r(null));
  setTimeout(() => r(null), 3_000).unref();
});
rmSync(plistDir, { recursive: true, force: true });

console.log(failures === 0 ? "ALL OK" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
