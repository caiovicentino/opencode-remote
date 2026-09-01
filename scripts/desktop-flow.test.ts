/**
 * Desktop interaction flow gate (P1-051): boots the REAL Electron shell via
 * tools/desktop.mjs (Playwright _electron) and runs one deterministic UI flow
 * end to end — open app → type an invalid pairing code → click Pair → assert
 * the visible error → screenshot → assert IPC state. Target: <60s.
 *
 * Why not the Conversas→Artifacts nav from the spec: the desktop rail only
 * renders once the app is PAIRED (App.tsx `phase !== "paired"` gate), which
 * needs a live daemon with real E2E keys — impossible hermetically without
 * spawning the production daemon (forbidden by the spec's own criterion 5).
 * The PairingView flow exercises the same open→interact→shot→assert loop the
 * builders rely on. (Deviation justified in the P1-051 commit message.)
 *
 * Run: npx tsx scripts/desktop-flow.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// --- ensure build artifacts exist (the gate's npm run build produces both) ---
const webIndex = join(repoRoot, "apps", "web", "dist", "index.html");
if (!existsSync(webIndex)) {
  spawnSync("npm", ["run", "build", "--workspace", "@ocr/web"], { cwd: repoRoot, stdio: "inherit" });
}
check("web UI built (apps/web/dist/index.html)", existsSync(webIndex));

const preload = join(repoRoot, "apps", "desktop", "dist-electron", "preload.js");
if (!existsSync(preload)) {
  spawnSync("npm", ["run", "build", "--workspace", "@ocr/desktop"], { cwd: repoRoot, stdio: "inherit" });
}
check("desktop shell built (dist-electron/preload.js)", existsSync(preload));

// Reviewer fix (P1-051 round 1): the gate NEVER uses the default "main"
// session — a builder's leftover keeper (idle TTL 5min) would be reused with
// the wrong env and killed by our final close. Per-run unique session.
const session = `desktop-flow-${process.pid}-${Date.now()}`;
const cliEnv = { ...process.env, OCR_DESKTOP_SESSION: session };

// Hard budget: the whole flow must fit in 60s (spec criterion).
const startedAt = Date.now();
const DEADLINE_MS = 60_000;
const shotPath = join(tmpdir(), "ocr-desktop-flow", `flow-${process.pid}.png`);
const logFile = join(tmpdir(), `ocr-desktop-${session}.log`);

function run(step: string, cliArgs: string[], timeoutMs: number): { ok: boolean; stdout: string } {
  const remaining = deadline();
  const res = spawnSync(process.execPath, ["tools/desktop.mjs", ...cliArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: Math.min(timeoutMs, remaining),
    env: cliEnv,
  });
  const ok = res.status === 0;
  if (!ok) {
    const detail = `${res.stdout ?? ""}\n${res.stderr ?? ""}\n${readFileSync(logFile, "utf8").split("\n").slice(-8).join("\n")}`;
    check(step, false, detail);
    return { ok: false, stdout: res.stdout ?? "" };
  }
  check(step, true);
  return { ok: true, stdout: res.stdout ?? "" };
}

function deadline(): number {
  const remaining = DEADLINE_MS - (Date.now() - startedAt);
  if (remaining <= 0) {
    console.error(`FAIL desktop flow exceeded the ${DEADLINE_MS}ms budget`);
    process.exit(1);
  }
  return remaining;
}

let keeperBooted = false;
try {
  const opened = run("open (hermetic launch)", ["open"], 45_000);
  keeperBooted = opened.ok;
  if (!opened.ok) process.exit(1);

  run("boot rendered the app (#root mounted)", ["see", "OpenCode Remote"], 15_000);
  run("type invalid pairing code", ["type", "textarea", "opencode-remote://not-a-valid-code"], 15_000);
  // Quoted/exact selector on purpose: the bare text= engine also matches the
  // textarea by its VALUE ("…//pair?v=2…" contains "pair") and would click
  // the wrong element.
  run("click Pair", ["click", 'text="Pair"'], 15_000);
  run("error text visible (Invalid pairing code)", ["see", "Invalid pairing code"], 15_000);
  const shot = run("screenshot captured", ["shot", shotPath], 15_000);
  if (shot.ok) {
    try {
      const buf = readFileSync(shotPath);
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      check(`shot is a real PNG (${w}x${h})`, buf.length > 10_000 && w > 0 && h > 0);
    } catch (err) {
      check("shot is a real PNG", false, String(err));
    }
  }

  const version = run("IPC app:version", ["ipc", "window.ocrDesktop.version"], 15_000);
  if (version.ok) {
    check("version is a non-empty string", /^\s*"/.test(version.stdout) && version.stdout.trim().length > 4);
  }
  const pairing = run("IPC app:pairingState", ["ipc", "window.ocrDesktop.getPairingState()"], 15_000);
  if (pairing.ok) {
    let daemonDown: unknown = null;
    try {
      daemonDown = (JSON.parse(pairing.stdout) as { daemonDown?: boolean } | null)?.daemonDown;
    } catch {
      daemonDown = null;
    }
    // Deterministic hermetic state (OCR_DAEMON_FORCE_DOWN): the sidecar report
    // is "down" — never the null state a previous gate race-depended on.
    check("pairingState is the deterministic daemon-down object", daemonDown === true);
  }
} finally {
  if (keeperBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: cliEnv });
}

// Spec criterion 5: hermetic means hermetic — the app log must show the
// resolveEntry miss and never a sidecar spawn.
try {
  // userData dir is printed in the keeper log ("app ready, userData: <path>").
  const keeperLogText = readFileSync(logFile, "utf8");
  const m = keeperLogText.match(/userData: (.*)/);
  const appLogText = m ? readFileSync(join(m[1], "logs", "desktop.log"), "utf8") : "";
  check("no daemon sidecar spawned (hermetic)", appLogText.includes("no daemon entry found") && !appLogText.includes("daemon sidecar spawned"));
} catch {
  check("no daemon sidecar spawned (hermetic)", false, "app desktop.log not found");
}

const duration = Date.now() - startedAt;
console.log(`\ndesktop flow duration: ${(duration / 1000).toFixed(1)}s (budget ${DEADLINE_MS / 1000}s)`);
console.log(failures === 0 ? "desktop flow: all green" : `FAILURES: ${failures}`);
process.exit(failures === 0 && duration < DEADLINE_MS ? 0 : 1);
