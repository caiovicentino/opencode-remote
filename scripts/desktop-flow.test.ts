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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ARTIFACTS_MARKER,
  buildArtifactsPrompt,
  injectArtifactsSystem,
  workspaceCoversArtifacts,
} from "../apps/daemon/src/sessionctx";

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

// --- P1-068: artifacts protocol injection (hermetic, no Electron needed) -----
// The daemon registers every session it creates and injects the artifacts
// protocol into each turn UNLESS the workspace's own AGENTS.md already teaches
// it. Mirrored here against the real helpers: a session created in a bare
// workspace must get the block; a covered workspace must stay untouched.
{
  const block = buildArtifactsPrompt("ses_flow");
  check(
    "P1-068: injected block points at the session's artifacts dir",
    block.includes(ARTIFACTS_MARKER) &&
      block.includes(join(homedir(), ".opencode-remote", "artifacts", "ses_flow")),
  );
  const bare = mkdtempSync(join(tmpdir(), "ocr-flow-bare-"));
  const covered = mkdtempSync(join(tmpdir(), "ocr-flow-covered-"));
  try {
    writeFileSync(join(covered, "AGENTS.md"), "artifacts em .opencode-remote/artifacts/<sessionId>/");
    // the daemon's register→inject decision: inject only when not covered
    const shouldInject = (dir: string) => !workspaceCoversArtifacts(dir);
    const bareTurn: { parts: unknown[]; system?: string } = {
      parts: [{ type: "text", text: "gere um preview HTML do relatório" }],
    };
    if (shouldInject(bare)) injectArtifactsSystem(bareTurn, "ses_flow");
    check(
      "P1-068: session in a workspace WITHOUT AGENTS.md receives the protocol (marker + [file: line)",
      bareTurn.system?.includes(ARTIFACTS_MARKER) === true && bareTurn.system?.includes("[file:") === true,
    );
    const coveredTurn: { parts: unknown[]; system?: string } = {
      parts: [{ type: "text", text: "gere um preview HTML do relatório" }],
    };
    if (shouldInject(covered)) injectArtifactsSystem(coveredTurn, "ses_flow");
    check(
      "P1-068: session in a workspace whose AGENTS.md covers the protocol gets NO injection",
      coveredTurn.system === undefined,
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(covered, { recursive: true, force: true });
  }
}

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

// --- P1-072: interactive webview against a local fake server -------------------
// The Browser pane itself is only reachable when the app is PAIRED (see the
// P1-051 note), but the <webview> element is a property of the Electron shell
// (webviewTag in main.ts). Mounting one dynamically in the real renderer
// proves: the tag is enabled, the sandboxed webpreferences hold, a local page
// loads, and scroll/click inside it reach the page — the pane is interactive,
// not a screenshot. Fake server listens on 127.0.0.1:<random port>.
//
// The server MUST live in a child process: every harness command below is a
// spawnSync, which blocks this test's event loop — a same-process server
// would starve exactly while the webview asks it for the page (15s load
// timeout, then the next evaluate finds the target gone).
async function testWebviewPane(): Promise<void> {
  const probe = spawnSync(
    process.execPath,
    ["-e", "const s=require('node:http').createServer();s.listen(0,'127.0.0.1',()=>{console.log('PORT='+s.address().port);s.close()})"],
    { encoding: "utf8" },
  );
  const port = Number((probe.stdout.match(/PORT=(\d+)/) ?? [])[1]);
  check("P1-072: fake server picked a free port", Number.isInteger(port) && port > 0, probe.stdout + probe.stderr);
  if (!Number.isInteger(port) || port <= 0) return;
  const marker = `ocr-webview-marker-${process.pid}`;
  const childScript = [
    "const http = require('node:http');",
    `const marker = ${JSON.stringify(marker)};`,
    "http.createServer((req, res) => {",
    "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
    "  res.end('<!doctype html><html><body><h1 id=\"flow-marker\">' + marker + '</h1>' +",
    "    '<div style=\"height:4000px\"></div>' +",
    "    '<button id=\"flow-btn\" onclick=\"document.getElementById(\\'flow-out\\').textContent=\\'clicked\\'\">go</button>' +",
    "    '<p id=\"flow-out\"></p></body></html>');",
    `}).listen(${port}, '127.0.0.1');`,
  ].join("\n");
  const server = spawn(process.execPath, ["-e", childScript], { stdio: "ignore", detached: true });
  server.unref();
  const url = `http://127.0.0.1:${port}/`;
  try {
    const mount = `(async () => {
      let wv = document.getElementById("flow-webview");
      if (wv) wv.remove();
      wv = document.createElement("webview");
      wv.id = "flow-webview";
      wv.src = ${JSON.stringify(url)};
      wv.webpreferences = "contextIsolation=yes, sandbox=yes";
      document.body.appendChild(wv);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("webview load timeout")), 15000);
        wv.addEventListener("dom-ready", () => { clearTimeout(t); resolve(); }, { once: true });
      });
      return wv.executeJavaScript("document.body.innerText");
    })()`;
    const loaded = run("P1-072: webview loads the fake server (executeJavaScript)", ["ipc", mount], 25_000);
    if (loaded.ok) {
      check(
        "P1-072: real page text reaches the renderer (interactive pane, not a shot)",
        loaded.stdout.includes(marker),
        loaded.stdout,
      );
    }
    const scroll = run(
      "P1-072: webview scroll",
      ["ipc", `(async () => {
        const wv = document.getElementById("flow-webview");
        return wv.executeJavaScript("window.scrollTo(0, 500); document.documentElement.scrollTop");
      })()`],
      15_000,
    );
    if (scroll.ok) check("P1-072: scrollTo reaches the page (scrollTop=500)", /500/.test(scroll.stdout), scroll.stdout);
    const click = run(
      "P1-072: webview click",
      ["ipc", `(async () => {
        const wv = document.getElementById("flow-webview");
        return wv.executeJavaScript("document.getElementById('flow-btn').click(); document.getElementById('flow-out').textContent");
      })()`],
      15_000,
    );
    if (click.ok) check("P1-072: in-page button click works", /clicked/.test(click.stdout), click.stdout);
  } finally {
    server.kill();
  }
}

let keeperBooted = false;
try {
  const opened = run("open (hermetic launch)", ["open"], 45_000);
  keeperBooted = opened.ok;
  if (!opened.ok) process.exit(1);

  run("boot rendered the app (#root mounted)", ["see", "OpenCode Remote"], 15_000);
  run("type invalid pairing code", ["type", "textarea", "opencode-remote://not-a-valid-code"], 15_000);
  // P2-049: the pairing screen copy moved into the i18n dictionary — on a
  // pt-BR host the button reads "Parear", so the old text="Pair" click broke
  // the gate. The .pair-submit / .pair-error hooks are locale-independent.
  run("click Pair (locale-proof .pair-submit)", ["click", ".pair-submit"], 15_000);
  const errText = run("pairing error rendered (.pair-error)", ["ipc", "document.querySelector('.pair-error')?.textContent ?? ''"], 15_000);
  if (errText.ok) {
    // The ipc output is JSON-stringified (tools/desktop.mjs fail()); assert the
    // real invalid-code copy, not just any non-empty string (round-2 review).
    check(
      "pairing error carries the invalid-code copy",
      /Invalid pairing code|Código de pareamento inválido/.test(errText.stdout),
    );
  }
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

  // --- P3-053: dock unread badge bridge ----------------------------------------
  // The paired chat UI can't render hermetically (see the P1-051 note above),
  // but the badge WIRING is fully observable: the preload exposes sendUnread
  // and main records the last pushed count (app:unreadBadge) — a real
  // renderer→main round-trip on the ocr:unread channel.
  const unreadBridge = run("P3-053: preload exposes sendUnread", ["ipc", "typeof window.ocrDesktop.sendUnread"], 15_000);
  if (unreadBridge.ok) check("P3-053: sendUnread is a function", /function/.test(unreadBridge.stdout));
  run("P3-053: push unread=3 over ocr:unread", ["ipc", "window.ocrDesktop.sendUnread(3)"], 15_000);
  const badge3 = run("P3-053: read app:unreadBadge", ["ipc", "window.ocrDesktop.getUnreadBadge()"], 15_000);
  if (badge3.ok) check("P3-053: main received the pushed count (3)", badge3.stdout.trim() === "3");
  run("P3-053: clear the badge (unread=0)", ["ipc", "window.ocrDesktop.sendUnread(0)"], 15_000);
  const badge0 = run("P3-053: read app:unreadBadge after clear", ["ipc", "window.ocrDesktop.getUnreadBadge()"], 15_000);
  if (badge0.ok) check("P3-053: badge clears to 0", badge0.stdout.trim() === "0");

  // --- P1-072: the shell must expose the real <webview> tag --------------------
  await testWebviewPane();

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

  // --- P3-054: the daemon/app version-mismatch banner (third launch) -----------
  // An adopted daemon older than the shell (stale launchd service, second
  // install) must surface as a non-blocking warn banner, not random breakage.
  // The OCR_DAEMON_FORCE_VERSION_MISMATCH hatch makes the main process emit
  // the mismatch state deterministically over the real ocr:pairing-state IPC
  // channel — so this exercises the full main→preload→renderer path, the
  // banner precedence and the P3-017 reconnect button, hermetically.
  const mismatchEnv = {
    ...process.env,
    OCR_DESKTOP_SESSION: `${session}-mismatch`,
    OCR_DAEMON_FORCE_VERSION_MISMATCH: "1",
  };
  const shot1440m = join(shotsDir, "P3-054-mismatch.png");
  const shot390m = join(shotsDir, "P3-054-mismatch-390.png");
  let mismatchBooted = false;
  try {
    const mOpen = run("mismatch: open (hermetic launch)", ["open"], 45_000, mismatchEnv);
    mismatchBooted = mOpen.ok;
    if (mOpen.ok) {
      // Precedence: the forced mismatch state wins over hermeticEnv's
      // OCR_DAEMON_FORCE_DOWN — warn strip in, red daemon-down strip out.
      const dom = run("mismatch: .daemon-version-mismatch banner rendered", ["ipc", "!!document.querySelector('.daemon-version-mismatch')"], 15_000, mismatchEnv);
      if (dom.ok) check("mismatch: banner element present", /true/.test(dom.stdout));
      const noDown = run("mismatch: red daemon-down banner absent", ["ipc", "!!document.querySelector('.daemon-down')"], 15_000, mismatchEnv);
      if (noDown.ok) check("mismatch: daemon-down strip not rendered", /false/.test(noDown.stdout));
      // P2-049 lesson: assert the real user-visible copy for every locale.
      const copy = run("mismatch: banner copy", ["ipc", "document.querySelector('.daemon-version-mismatch')?.textContent ?? ''"], 15_000, mismatchEnv);
      if (copy.ok) {
        check(
          "mismatch: banner names both versions and the restart action",
          /Daemon v0\.0\.1-force · app v/.test(copy.stdout) &&
            /reinicie o daemon|restart the daemon/.test(copy.stdout),
        );
      }
      const btn = run("mismatch: reconnect button inside the banner", ["ipc", "!!document.querySelector('.daemon-version-mismatch .daemon-reconnect-btn')"], 15_000, mismatchEnv);
      if (btn.ok) check("mismatch: reconnect button present", /true/.test(btn.stdout));
      const state = run("mismatch: IPC app:pairingState", ["ipc", "window.ocrDesktop.getPairingState()"], 15_000, mismatchEnv);
      if (state.ok) {
        let parsed: { versionMismatch?: boolean; appVersion?: string | null; daemonVersion?: string | null; uri?: string | null } | null = null;
        try {
          parsed = JSON.parse(state.stdout) as typeof parsed;
        } catch {
          parsed = null;
        }
        check(
          "mismatch: pairingState carries versions + verdict over ocr:pairing-state",
          parsed?.versionMismatch === true &&
            parsed?.daemonVersion === "0.0.1-force" &&
            typeof parsed?.appVersion === "string" &&
            parsed?.uri === null,
        );
      }
      const m1 = run("mismatch: 1440x900 evidence shot", ["shot", shot1440m, "1440", "900"], 15_000, mismatchEnv);
      if (m1.ok) check("mismatch: 1440x900 shot is a real PNG", pngSize(shot1440m).join("x") === "1440x900");
      const m2 = run("mismatch: 390 evidence shot", ["shot", shot390m, "390", "844"], 15_000, mismatchEnv);
      if (m2.ok) check("mismatch: 390 shot is a real PNG", pngSize(shot390m)[0] === 390);
    }
  } finally {
    if (mismatchBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: mismatchEnv });
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
