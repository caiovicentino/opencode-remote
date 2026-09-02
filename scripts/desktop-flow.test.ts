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
import { homedir } from "node:os";
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
// P1-051 round 2: session state (socket, token, log) lives in a 0700 dir.
const logFile = join(tmpdir(), `ocr-desktop-${session}`, "keeper.log");

function run(step: string, cliArgs: string[], timeoutMs: number, env: NodeJS.ProcessEnv = cliEnv): { ok: boolean; stdout: string } {
  const remaining = deadline();
  const res = spawnSync(process.execPath, ["tools/desktop.mjs", ...cliArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: Math.min(timeoutMs, remaining),
    env,
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

/** PNG width/height from the IHDR header (bytes 16..24). */
function pngSize(path: string): [number, number] {
  const buf = readFileSync(path);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
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
  // P1-053: the daemon-down banner carries the one-click recovery button
  // (wired to app:reconnectDaemon → restartDaemon) instead of "reopen the app".
  // Copy follows the machine locale (pt-BR on the gate host); the DOM query
  // via ipc is the locale-proof version of the same assertion.
  const btn = run("reconnect button present in the daemon-down banner", ["ipc", "!!document.querySelector('.daemon-reconnect-btn')"], 15_000);
  if (btn.ok) check("reconnect button renders the pt-BR copy", /true/.test(btn.stdout));
  run("daemon-down banner shows the reconnect button", ["see", "Reconectar agora"], 15_000);

  // --- P1-046: Go menu + shortcut bridge --------------------------------------
  // The paired two-column layout can't render hermetically (needs real E2E
  // keys, see the P1-051 note above), but the shortcut WIRING is fully
  // observable: the preload bridge must expose onMenuAction and the app menu
  // must carry the Go items whose click handlers broadcast ocr:menu-action.
  const bridge = run("P1-046: preload exposes onMenuAction", ["ipc", "typeof window.ocrDesktop.onMenuAction"], 15_000);
  if (bridge.ok) check("P1-046: onMenuAction is a function", /function/.test(bridge.stdout));
  const menuIds: [string, string][] = [
    ["go-new-chat", "New conversation"],
    ["go-palette", "Command palette"],
    ["go-pane-chat", "Chat"],
    ["go-pane-artifacts", "Artifacts"],
    ["go-pane-browser", "Browser"],
    ["go-pane-files", "Files"],
    ["go-pane-settings", "Settings"],
  ];
  for (const [id, label] of menuIds) {
    const res = run(`P1-046: Go menu item ${id}`, ["menu", id], 15_000);
    if (res.ok) check(`P1-046: ${id} is labeled "${label}"`, res.stdout.includes(label));
  }
  // Real click on the menu item: runs the main-process handler that
  // broadcasts ocr:menu-action to every window (renderer ignores it while
  // unpaired — the call must not throw).
  run("P1-046: go-pane-artifacts click dispatches", ["menu-click", "go-pane-artifacts"], 15_000);

  // --- P1-053: the "reconnecting…" hermetic state (second launch) --------------
  // An ADOPTED daemon going missing is never terminal: the yellow banner shows
  // an active reconnecting state with the attempt counter and NO QR overlay.
  // Recorded as evidence shots (1440x900 desktop + 390 mobile) in the builder
  // shots dir per the spec.
  const reconnEnv = {
    ...process.env,
    OCR_DESKTOP_SESSION: `${session}-reconn`,
    OCR_DAEMON_FORCE_RECONNECTING: "1",
  };
  const shotsDir = join(homedir(), ".opencode-remote", "pilot", "shots", "builder");
  const shot1440 = join(shotsDir, "P1-053-reconnecting.png");
  const shot390 = join(shotsDir, "P1-053-reconnecting-390.png");
  let reconnBooted = false;
  try {
    const reconnOpen = run("reconnect: open (hermetic launch)", ["open"], 45_000, reconnEnv);
    reconnBooted = reconnOpen.ok;
    if (reconnOpen.ok) {
      // Locale-proof: the yellow banner element itself (class from index.css).
      const dom = run("reconnect: .daemon-reconnecting banner rendered", ["ipc", "!!document.querySelector('.daemon-reconnecting')"], 15_000, reconnEnv);
      if (dom.ok) check("reconnect: banner element present", /true/.test(dom.stdout));
      // Machine locale is pt-BR; `see` is the real visible-text check.
      run("reconnect: yellow banner text visible", ["see", "Reconectando ao daemon"], 15_000, reconnEnv);
      const reconnState = run("reconnect: IPC app:pairingState", ["ipc", "window.ocrDesktop.getPairingState()"], 15_000, reconnEnv);
      if (reconnState.ok) {
        let parsed: { reconnecting?: boolean; reconnectAttempts?: number; uri?: string | null; qrDataUrl?: string | null } | null = null;
        try {
          parsed = JSON.parse(reconnState.stdout) as typeof parsed;
        } catch {
          parsed = null;
        }
        check(
          "reconnect: pairingState is the reconnecting object without QR (no overlay, no re-pairing)",
          parsed?.reconnecting === true &&
            typeof parsed?.reconnectAttempts === "number" &&
            parsed.reconnectAttempts >= 1 &&
            parsed?.uri === null &&
            parsed?.qrDataUrl === null,
        );
      }
      const s1 = run("reconnect: 1440x900 evidence shot", ["shot", shot1440, "1440", "900"], 15_000, reconnEnv);
      if (s1.ok) check("reconnect: 1440x900 shot is a real PNG", pngSize(shot1440).join("x") === "1440x900");
      const s2 = run("reconnect: 390 evidence shot", ["shot", shot390, "390", "844"], 15_000, reconnEnv);
      if (s2.ok) check("reconnect: 390 shot is a real PNG", pngSize(shot390)[0] === 390);
    }
  } finally {
    if (reconnBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: reconnEnv });
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
