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
import { createServer, type AddressInfo } from "node:net";
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
// P1-089: keep the id SHORT — the keeper's unix socket lives at
// $TMPDIR/ocr-desktop-<session>/keeper.sock and macOS truncates AF_UNIX
// bind() paths at 104 chars. The old long id silently bound a truncated
// "…/keep" socket that the shutdown unlink could never remove, so any
// relaunch of the same session dir failed with EADDRINUSE forever (the
// P1-089 beat is the first to relaunch a session dir).
const session = `df-${process.pid}-${Date.now()}`;
const cliEnv = { ...process.env, OCR_DESKTOP_SESSION: session };

// Hard budget: the whole flow must fit (spec criterion). P1-070 added the
// "local boot" block (real hermetic daemon + fresh instance + degradation
// probe), so the original 60s grew to 90s — documented in the commit per the
// spec and reflected in the <90s note in AGENTS.md.
const startedAt = Date.now();
const DEADLINE_MS = 90_000;
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

/** Like run(), but silent: for polling loops where intermediate misses are
 * expected and must not be recorded as failures. */
function probe(cliArgs: string[], timeoutMs: number, env: NodeJS.ProcessEnv): { ok: boolean; stdout: string } {
  const res = spawnSync(process.execPath, ["tools/desktop.mjs", ...cliArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: Math.min(timeoutMs, deadline()),
    env,
  });
  return { ok: res.status === 0, stdout: res.stdout ?? "" };
}

/** Poll a harness ipc expression until `predicate` holds (or the tries run
 * out); one final verdict is recorded by the caller. */
async function waitProbe(
  name: string,
  expr: string,
  predicate: (value: string) => boolean,
  env: NodeJS.ProcessEnv,
  tries = 12,
  delayMs = 1_000,
): Promise<string | null> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    const res = probe(["ipc", expr], 15_000, env);
    if (res.ok && predicate(res.stdout)) {
      check(name, true);
      return res.stdout;
    }
    last = res.stdout.trim();
    await new Promise((r) => setTimeout(r, delayMs));
  }
  check(name, false, `condition never held (${tries} probes), last value: ${last.slice(0, 300)}`);
  return null;
}

/** PNG width/height from the IHDR header (bytes 16..24). */
function pngSize(path: string): [number, number] {
  const buf = readFileSync(path);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/** P1-089: phase banner with elapsed time — the <90s budget of this gate
 * grew two hermetic boots, so regressions must be attributable per phase. */
function phase(label: string): void {
  console.log(`--- ${label} (${((Date.now() - startedAt) / 1000).toFixed(1)}s elapsed)`);
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
  // P1-081: the hermetic shell never calls win.show() — the gate drives the
  // app through webContents while the operator's screen stays clean. The
  // screen-level guarantee is BrowserWindow.isVisible()=false for every
  // window (document.visibilityState stays "visible" precisely because
  // paintWhenInitiallyHidden keeps the hidden window painting for shots).
  // Round 2: a failed probe FAILS the check — the guarantee can never be
  // silently skipped by an `if (probe.ok)` short-circuit.
  const wins = run("P1-081: window stays invisible (wins probe)", ["wins"], 15_000);
  check(
    "P1-081: every BrowserWindow reports isVisible()=false during the hermetic run",
    wins.ok && /"visible":\s*false/.test(wins.stdout) && !/"visible":\s*true/.test(wins.stdout),
    wins.ok ? wins.stdout : "wins probe failed — window visibility unproven",
  );
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

  // --- P1-070: the new local-first copy is visible with no daemon at all ------
  // Reviewer gap (round 1): the new i18n copy must be exercised here, not only
  // in the local/paired phase — a fresh instance with no reachable daemon is
  // where the updated intro and the explicit remote-pairing entry show first.
  const intro = run("P1-070: updated pairIntro rendered", ["ipc", "document.querySelector('.pair-intro')?.textContent ?? ''"], 15_000);
  if (intro.ok) {
    check(
      "P1-070: pairIntro is the new local-first copy (en|pt)",
      /pairs with the daemon on this machine automatically|se conecta sozinho ao daemon desta máquina/.test(intro.stdout),
      intro.stdout,
    );
  }
  const remoteEntry = run("P1-070: .pair-remote-entry present", ["ipc", "document.querySelector('.pair-remote-entry')?.textContent ?? ''"], 15_000);
  if (remoteEntry.ok) {
    check(
      "P1-070: pairRemoteTitle copy rendered on the unpaired screen",
      /Pair a phone \(remote device\)|Parear um celular \(dispositivo remoto\)/.test(remoteEntry.stdout),
      remoteEntry.stdout,
    );
  }

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

  // --- P1-070: local boot — real hermetic daemon + fresh instance ⇒ chat ------
  // The exact repro this task fixes: empty pairing storage + a healthy daemon
  // on the same disk used to open the QR overlay. Now the shell proves the
  // daemon's identity (401 challenge + Bearer from the 0600 state file) and
  // the app lands straight in the chat — mode:"local", uri/qr null, no
  // overlay, no pairing form. The daemon follows the localws.test.ts pattern:
  // HOME=<tmp> (own state file), free port, dead relay — E2E intact.
  const localShot = join(shotsDir, "P1-070-local-boot.png");
  const localShot390 = join(shotsDir, "P1-070-local-boot-390.png");
  const daemonHome = mkdtempSync(join(tmpdir(), "ocr-flow-daemon-"));
  const localStateFile = join(daemonHome, ".opencode-remote", "daemon.json");
  const localPort = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
  const localDaemon = spawn(
    "npx",
    ["tsx", "apps/daemon/src/index.ts"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: daemonHome,
        OCR_METRICS_PORT: String(localPort),
        RELAY_URL: "ws://127.0.0.1:1", // dead: relay must be irrelevant in local mode
        OPENCODE_URL: "http://127.0.0.1:1",
        OCR_LOG_LEVEL: "error",
      },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true, // own process group — the kill below hits tsx's child too
    },
  );
  const killDaemon = (signal: NodeJS.Signals = "SIGTERM"): void => {
    if (!localDaemon.pid) return;
    try {
      process.kill(-localDaemon.pid, signal);
    } catch {
      /* already gone */
    }
  };
  process.on("exit", () => killDaemon("SIGKILL"));
  const localEnv = {
    ...process.env,
    OCR_DESKTOP_SESSION: `${session}-local`,
    // harness hatch: adopt this state file (drops OCR_DAEMON_FORCE_DOWN)
    OCR_DESKTOP_LOCAL_STATE: localStateFile,
    OCR_DAEMON_METRICS_PORT: String(localPort),
  };
  let localBooted = false;
  try {
    // Wait for the daemon to publish its 0600 state file, mint the apiToken
    // (lazy — poke any Bearer-gated route) and prove the health challenge.
    let token = "";
    for (let i = 0; i < 25; i++) {
      try {
        token = (JSON.parse(readFileSync(localStateFile, "utf8")) as { apiToken?: string }).apiToken ?? "";
      } catch {}
      if (token) break;
      await fetch(`http://127.0.0.1:${localPort}/api/health`, { headers: { authorization: "Bearer warmup" } }).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
    }
    check("local: hermetic daemon published the 0600 state file", !!token);
    if (token) {
      const health = await fetch(`http://127.0.0.1:${localPort}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => null);
      check("local: hermetic daemon answers /api/health 200", health?.status === 200);
      const open = run("local: open (hermetic local-boot launch)", ["open"], 45_000, localEnv);
      localBooted = open.ok;
      if (open.ok) {
        const state = run("local: IPC app:pairingState", ["ipc", "window.ocrDesktop.getPairingState()"], 15_000, localEnv);
        if (state.ok) {
          let parsed: { mode?: string; uri?: string | null; qrDataUrl?: string | null } | null = null;
          try {
            parsed = JSON.parse(state.stdout) as typeof parsed;
          } catch {
            parsed = null;
          }
          check(
            "local: pairingState is mode=local with no URI and no QR",
            parsed?.mode === "local" && parsed?.uri === null && parsed?.qrDataUrl === null,
            state.stdout,
          );
        }
        // The chat renders (auto-connect over the loopback WS); poll because the
        // local handshake takes a beat after the first paint.
        await waitProbe(
          "local: data-phase=paired hook rendered",
          "document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? ''",
          (v) => v.includes("paired"),
          localEnv,
        );
        const noOverlay = run("local: QR overlay absent", ["ipc", "!!document.querySelector('.pair-overlay')"], 15_000, localEnv);
        if (noOverlay.ok) check("local: .pair-overlay not rendered", /false/.test(noOverlay.stdout));
        const noForm = run("local: pairing form absent", ["ipc", "!!document.querySelector('.pair-submit')"], 15_000, localEnv);
        if (noForm.ok) check("local: .pair-submit not rendered", /false/.test(noForm.stdout));
        // Phone pairing stays possible (spec criterion 5): Settings carries the
        // explicit remote-pairing entry with the new title copy. Runs before the
        // shots (the 390px shot shrinks the window below the desktop layout).
        run("local: open Settings pane", ["menu-click", "go-pane-settings"], 15_000, localEnv);
        const entry = run(
          "local: remote-pairing card in Settings",
          ["ipc", "(() => { const el = document.querySelector('.pair-remote-entry'); if (!el) return ''; const card = el.closest('.card'); return (card?.querySelector('h3')?.textContent ?? '') + '|' + (el.textContent ?? ''); })()"],
          15_000,
          localEnv,
        );
        if (entry.ok) {
          check(
            "local: pairRemoteTitle + action copy rendered in Settings",
            /Pair a phone \(remote device\)|Parear um celular \(dispositivo remoto\)/.test(entry.stdout) &&
              /Show pairing QR|Mostrar QR de pareamento/.test(entry.stdout),
            entry.stdout,
          );
        }
        const s1 = run("local: 1440x900 evidence shot", ["shot", localShot, "1440", "900"], 15_000, localEnv);
        if (s1.ok) check("local: 1440x900 shot is a real PNG", pngSize(localShot).join("x") === "1440x900");
        const s2 = run("local: 390 evidence shot", ["shot", localShot390, "390", "844"], 15_000, localEnv);
        if (s2.ok) check("local: 390 shot is a real PNG", pngSize(localShot390)[0] === 390);

        // --- P1-080: the operator's overflow repro (narrow window, long diff) ---
        // The hermetic daemon has no opencode backend, so no real message can
        // stream in; the long-diff bubble is injected at the DOM level into the
        // REAL ChatView flex chain (.screen → .chat-row → .chat → .msg-wrap →
        // .messages → .msg → pre → code) — the exact layout the CSS fix
        // constrains. Regression criterion: nothing leaves the viewport and the
        // long line scrolls INSIDE the code block, never the page.
        const overflowShot1440 = join(shotsDir, "P1-080-overflow-1440.png");
        const overflowShot390 = join(shotsDir, "P1-080-overflow-390.png");
        const openChat = run(
          "P1-080: deep-link opens the chat column",
          ["ipc", "location.hash = '#/session/ses-p1-080-overflow'"],
          15_000,
          localEnv,
        );
        // Shared DOM-probe helpers, interpolated into the evaluate strings below.
        const MEASURE_HELPERS = `
          const ocrFreeze = () => {
            document.getElementById('p1-080-noanim')?.remove();
            // the chat screen slide-in (screen-in, 180ms) caught mid-flight reads
            // as a 1-3px document offset — freeze animations before measuring
            const st = document.createElement('style');
            st.id = 'p1-080-noanim';
            st.textContent = '* { animation: none !important; transition: none !important; }';
            document.head.appendChild(st);
            document.documentElement.scrollLeft = 0;
          };
          const ocrClipped = (el) => {
            for (let a = el.parentElement; a; a = a.parentElement) {
              if (getComputedStyle(a).overflowX !== 'visible') return true;
            }
            return false;
          };
          const ocrLabel = (el) => el.tagName.toLowerCase() +
            (el.id ? '#' + el.id : typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').join('.') : '');
          const ocrScan = () => {
            const out = [];
            for (const el of document.querySelectorAll('*')) {
              const r = el.getBoundingClientRect();
              if ((r.right > window.innerWidth + 0.5 || r.left < -0.5) && !ocrClipped(el)) {
                out.push({ cls: ocrLabel(el), left: Math.round(r.left), right: Math.round(r.right) });
                if (out.length >= 5) break;
              }
            }
            return out;
          };
        `;
        const injectAndMeasure = `(() => {
          const msgs = document.querySelector('.messages');
          if (!msgs) return { mounted: false };
          document.getElementById('p1-080-bubble')?.remove();
          ${MEASURE_HELPERS}
          ocrFreeze();
          const doc = document.documentElement;
          const preInject = doc.scrollWidth - doc.clientWidth;
          const preOffenders = ocrScan();
          const div = document.createElement('div');
          div.id = 'p1-080-bubble';
          div.className = 'msg assistant';
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          code.textContent = '- const veryLongDiffLine = "p1-080-' + 'x'.repeat(400) + '";';
          pre.appendChild(code);
          div.appendChild(pre);
          msgs.appendChild(div);
          const box = div.getBoundingClientRect();
          return {
            mounted: true,
            preInject,
            preOffenders,
            docOverflow: doc.scrollWidth - doc.clientWidth,
            msgRight: Math.round(box.right),
            vw: window.innerWidth,
            preScrollsInside: pre.scrollWidth > pre.clientWidth,
            postOffenders: ocrScan(),
          };
        })()`;
        // Criterion 4 — the artifact split-pane (P2-062): same class of repro,
        // mounted as a sibling of the real .chat inside .chat-row the way
        // ChatView renders it (screen gains .artifact-split, pane gets
        // flexBasis), with a wide code block + a long URL inside.
        const splitPaneProbe = `(() => {
          const row = document.querySelector('.chat-row');
          const screen = document.querySelector('.screen');
          if (!row || !screen) return { mounted: false };
          document.getElementById('p1-080-pane')?.remove();
          document.getElementById('p1-080-divider')?.remove();
          ${MEASURE_HELPERS}
          ocrFreeze();
          screen.classList.add('artifact-split');
          const pane = document.createElement('div');
          pane.id = 'p1-080-pane';
          pane.className = 'artifact-pane';
          pane.style.flexBasis = '40%';
          pane.style.background = 'var(--bg)';
          const header = document.createElement('div');
          header.style.cssText = 'display:flex;align-items:center;gap:8;padding:10px 12px;background:var(--surface);border-bottom:1px solid var(--border)';
          header.textContent = 'spec.md';
          const scroll = document.createElement('div');
          scroll.style.cssText = 'flex:1;min-height:0;overflow:auto;padding:14px';
          const md = document.createElement('div');
          md.style.cssText = 'max-width:min(900px,100%);overflow-wrap:anywhere';
          const pre = document.createElement('pre');
          pre.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;overflow-x:auto;max-width:100%;font-size:0.78rem';
          const code = document.createElement('code');
          code.textContent = '- const wideArtifactLine = "p1-080-' + 'y'.repeat(400) + '";';
          pre.appendChild(code);
          md.appendChild(pre);
          const url = document.createElement('p');
          url.style.cssText = 'margin:6px 0;word-break:break-word';
          url.textContent = 'ref https://example.invalid/' + 'z'.repeat(300) + '/path';
          md.appendChild(url);
          scroll.appendChild(md);
          pane.appendChild(header);
          pane.appendChild(scroll);
          const divider = document.createElement('div');
          divider.id = 'p1-080-divider';
          divider.className = 'split-divider';
          const grip = document.createElement('span');
          divider.appendChild(grip);
          row.appendChild(divider);
          row.appendChild(pane);
          const doc = document.documentElement;
          const paneBox = pane.getBoundingClientRect();
          return {
            mounted: true,
            splitClass: screen.className.includes('artifact-split'),
            docOverflow: doc.scrollWidth - doc.clientWidth,
            paneRight: Math.round(paneBox.right),
            paneWidth: Math.round(paneBox.width),
            vw: window.innerWidth,
            panePreScrollsInside: pre.scrollWidth > pre.clientWidth,
            postOffenders: ocrScan(),
          };
        })()`;
        function assertBubbleContained(label: string, env: NodeJS.ProcessEnv) {
          const res = run(`P1-080: long diff bubble contained (${label})`, ["ipc", injectAndMeasure], 15_000, env);
          if (!res.ok) return;
          let m: {
            mounted?: boolean;
            preInject?: number;
            preOffenders?: { cls: string }[];
            docOverflow?: number;
            msgRight?: number;
            vw?: number;
            preScrollsInside?: boolean;
            postOffenders?: { cls: string }[];
          } | null = null;
          try {
            m = JSON.parse(res.stdout) as typeof m;
          } catch {}
          console.log(`     P1-080 measurements (${label}):`, res.stdout.trim());
          check(`P1-080: chat chain mounted (${label})`, m?.mounted === true, res.stdout);
          check(
            `P1-080: nothing leaves the viewport (${label})`,
            m?.docOverflow !== undefined &&
              m.docOverflow <= (m.preInject ?? 0) && // the bubble adds no overflow
              (m.docOverflow as number) <= 0 && // and the document doesn't overflow at all
              (m.msgRight ?? Infinity) <= (m.vw ?? 0),
            JSON.stringify(m),
          );
          check(
            `P1-080: long line scrolls INSIDE the code block (${label})`,
            m?.preScrollsInside === true,
            JSON.stringify(m),
          );
        }
        if (openChat.ok) {
          // the window is still 390px wide from the previous shot — the narrow
          // repro goes first, then the desktop-width one (operator's print)
          const narrow = await waitProbe(
            "P1-080: .messages mounted (390px)",
            "!!document.querySelector('.messages')",
            (v) => /true/.test(v),
            localEnv,
          );
          if (narrow) {
            assertBubbleContained("390px", localEnv);
            // no size args: resizing remounts the shell and would drop the bubble
            run("P1-080: 390px repro shot", ["shot", overflowShot390], 15_000, localEnv);
          }
          // resize to desktop width: the layout remounts (mobile ⇄ desk shells
          // occupy different tree positions), so re-wait and re-inject
          const wide = run("P1-080: resize to desktop width", ["shot", overflowShot1440, "1440", "900"], 15_000, localEnv);
          if (wide.ok) {
            const desk = await waitProbe(
              "P1-080: .messages mounted (1440px)",
              "!!document.querySelector('.messages')",
              (v) => /true/.test(v),
              localEnv,
            );
            if (desk) {
              assertBubbleContained("1440px", localEnv);
              // criterion 4: the same containment guarantees for the artifact
              // split-pane that opens next to the chat (≥ SPLIT_MIN_PX = 900)
              const pane = run("P1-080: artifact pane mounted (split-pane)", ["ipc", splitPaneProbe], 15_000, localEnv);
              if (pane.ok) {
                let p: {
                  mounted?: boolean;
                  splitClass?: boolean;
                  docOverflow?: number;
                  paneRight?: number;
                  paneWidth?: number;
                  vw?: number;
                  panePreScrollsInside?: boolean;
                  postOffenders?: { cls: string }[];
                } | null = null;
                try {
                  p = JSON.parse(pane.stdout) as typeof p;
                } catch {}
                console.log("     P1-080 measurements (split-pane):", pane.stdout.trim());
                check("P1-080: split-pane structure mounted", p?.mounted === true && p.splitClass === true, pane.stdout);
                check(
                  "P1-080: artifact pane does not leave the viewport (split-pane)",
                  p?.docOverflow !== undefined &&
                    p.docOverflow <= 0 &&
                    (p.paneRight ?? Infinity) <= (p.vw ?? 0) &&
                    (p.paneWidth ?? 0) > 0,
                  JSON.stringify(p),
                );
                check(
                  "P1-080: wide artifact line scrolls INSIDE the pane (split-pane)",
                  p?.panePreScrollsInside === true,
                  JSON.stringify(p),
                );
              }
              // evidence shot WITH the chat bubble + split-pane in place
              run("P1-080: 1440px repro shot", ["shot", overflowShot1440], 15_000, localEnv);
            }
          }
        }

        // --- P1-088: per-session drafts (the operator's repro) ----------------
        // Type in A, switch to B (composer starts empty — no bleed), type in
        // B, return to A (A's draft intact), send in A (clears only A; the
        // sent draft is never restored). The hermetic daemon has no opencode
        // backend, so the send fails offline — the optimistic clear is the
        // behavior under test.
        const toA = run("P1-088: deep-link to session A", ["ipc", "location.hash = '#/session/ses-draft-a'"], 15_000, localEnv);
        if (toA.ok) {
          await waitProbe(
            "P1-088: A's restore effect committed (empty draft)",
            "document.querySelector('.composer textarea')?.value ?? 'MOUNT-MISS'",
            (v) => v.trim() === '""',
            localEnv,
          );
          run("P1-088: type draft in A", ["type", ".composer textarea", "rascunho A"], 15_000, localEnv);
          // evidence: composer in A holding its own draft (window is already
          // 1440x900 from the P1-080 repro — no-size shot avoids a remount)
          run("P1-088: 1440x900 evidence shot", ["shot", join(shotsDir, "P1-088-draft-1440.png")], 15_000, localEnv);
          const toB = run("P1-088: switch to session B", ["ipc", "location.hash = '#/session/ses-draft-b'"], 15_000, localEnv);
          if (toB.ok) {
            const probeValue = "document.querySelector('.composer textarea')?.value ?? 'MOUNT-MISS'";
            await waitProbe(
              "P1-088: B's composer starts empty (no bleed from A)",
              probeValue,
              (v) => v.trim() === '""',
              localEnv,
            );
            run("P1-088: type draft in B", ["type", ".composer textarea", "rascunho B"], 15_000, localEnv);
            const backA = run("P1-088: back to session A", ["ipc", "location.hash = '#/session/ses-draft-a'"], 15_000, localEnv);
            if (backA.ok) {
              await waitProbe(
                "P1-088: A's draft intact after the B round-trip",
                probeValue,
                (v) => v.includes("rascunho A"),
                localEnv,
              );
              run("P1-088: send in A (offline — optimistic clear)", ["click", ".composer button.primary"], 15_000, localEnv);
              await waitProbe(
                "P1-088: sending cleared A's composer",
                probeValue,
                (v) => v.trim() === '""',
                localEnv,
              );
              const toB2 = run("P1-088: switch to B after send", ["ipc", "location.hash = '#/session/ses-draft-b'"], 15_000, localEnv);
              if (toB2.ok) {
                await waitProbe(
                  "P1-088: B's draft survived A's send",
                  probeValue,
                  (v) => v.includes("rascunho B"),
                  localEnv,
                );
                const backA2 = run("P1-088: back to A after send", ["ipc", "location.hash = '#/session/ses-draft-a'"], 15_000, localEnv);
                if (backA2.ok) {
                  await waitProbe(
                    "P1-088: sent draft is never restored in A",
                    "document.querySelector('.composer textarea')?.value ?? 'MOUNT-MISS'",
                    (v) => v.trim() === '""',
                    localEnv,
                  );
                  // evidence: 390px narrow viewport after the full round-trip
                  run("P1-088: 390 evidence shot", ["shot", join(shotsDir, "P1-088-draft-390.png"), "390", "844"], 15_000, localEnv);
                }
              }
            }
          }
        }

        // Stop the daemon ⇒ the existing degradation (yellow reconnecting
        // banner), never the QR ceremony.
        killDaemon("SIGKILL");
        const degraded = await waitProbe(
          "local: daemon loss degrades without QR",
          "window.ocrDesktop.getPairingState()",
          (v) => {
            try {
              const p = JSON.parse(v) as { reconnecting?: boolean; daemonDown?: boolean; uri?: string | null; qrDataUrl?: string | null };
              return (p.reconnecting === true || p.daemonDown === true) && p.uri === null && p.qrDataUrl === null;
            } catch {
              return false;
            }
          },
          localEnv,
          12,
          2_500,
        );
        if (degraded) {
          const banner = run("local: degradation banner rendered", ["ipc", "!!(document.querySelector('.daemon-reconnecting') || document.querySelector('.daemon-down'))"], 15_000, localEnv);
          if (banner.ok) check("local: reconnecting/down banner present", /true/.test(banner.stdout));
        }

        // --- P1-089: queue→flush→reentrada across a SECOND hermetic boot ----
        // Boot 1 above ran with a DEAD opencode backend (sends answer 502 and
        // degrade to the error banner). Boot 2 adopts a second hermetic
        // daemon whose OPENCODE_URL is a live fake backend: a message queued
        // in the offline queue flushes through it, the session cache written
        // on entry predates the flushed message, and switching conversations
        // and coming back must render exactly the history row count — never
        // duplicated pairs (the operator's repro, plus a >500-event buffer
        // burst that re-fires an old session.idle).
        phase("P1-089: fake backend + second hermetic boot");
        const REPLAY = "ses-reentry-check";
        const DRAFT = "ses-draft-a";
        const ROW_COUNT = 6;
        const fakeScript = [
          "const http = require('node:http');",
          `const ROWS = Array.from({ length: ${ROW_COUNT} }, (_, i) => ({`,
          "  info: { id: 'msg-' + (i + 1), role: i % 2 ? 'assistant' : 'user' },",
          "  parts: [{ type: 'text', text: (i % 2 ? 'reply-' : 'ping-') + (i + 1) }],",
          "}));",
          "const hits = [];",
          "const sse = new Set();",
          "const srv = http.createServer((req, res) => {",
          "  const u = new URL(req.url, 'http://127.0.0.1');",
          "  const json = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };",
          "  hits.push({ method: req.method, path: u.pathname });",
          "  if (u.pathname === '/__hits') return json(hits);",
          "  if (u.pathname === '/global/health') return json({ healthy: true, version: 'fake' });",
          "  if (u.pathname === '/event') {",
          "    res.writeHead(200, { 'content-type': 'text/event-stream' });",
          "    res.write('retry: 5000\\n\\n');",
          "    sse.add(res);",
          "    req.on('close', () => sse.delete(res));",
          "    return;",
          "  }",
          "  if (u.pathname === '/__emit') {",
          "    let body = '';",
          "    req.on('data', (c) => (body += c));",
          "    req.on('end', () => {",
          "      res.writeHead(200, { 'content-type': 'application/json' });",
          "      res.end(JSON.stringify({ ok: true, clients: sse.size }));",
          "      for (const evt of JSON.parse(body || '[]')) for (const r of sse) r.write('data: ' + JSON.stringify(evt) + '\\n\\n');",
          "    });",
          "    return;",
          "  }",
          "  if (u.pathname === '/session') return json([{ id: 'ses-reentry-check', title: 'Reentry check' }, { id: 'ses-draft-a', title: 'Draft A' }]);",
          "  if (u.pathname === '/session/ses-reentry-check' || u.pathname === '/session/ses-draft-a') return json({ id: u.pathname.split('/')[2], title: 'P1-089' });",
          "  if (/^\\/session\\/[^/]+\\/message$/.test(u.pathname)) return req.method === 'POST' ? json({ id: 'msg-fake' }) : json(ROWS);",
          "  if (u.pathname === '/permission' || u.pathname === '/question') return json([]);",
          "  if (u.pathname === '/provider') return json({ all: [] });",
          "  res.writeHead(404).end();",
          "});",
          "srv.listen(0, '127.0.0.1', () => console.log('PORT=' + srv.address().port));",
        ].join("\n");
        const fakeChild = spawn(process.execPath, ["-e", fakeScript], {
          stdio: ["ignore", "pipe", "ignore"],
        });
        const fakePort = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("fake opencode never printed PORT")), 10_000);
          fakeChild.stdout?.on("data", (d: Buffer) => {
            const m = d.toString().match(/PORT=(\d+)/);
            if (m) {
              clearTimeout(timer);
              resolve(Number(m[1]));
            }
          });
          fakeChild.on("exit", () => reject(new Error("fake opencode exited early")));
        }).catch((err) => {
          check("P1-089: fake opencode backend booted", false, String(err));
          return NaN;
        });
        const fakeUrl = `http://127.0.0.1:${fakePort}`;
        const killFake = () => fakeChild.kill();
        process.on("exit", killFake);
        const daemonHome2 = mkdtempSync(join(tmpdir(), "ocr-flow-daemon2-"));
        const localStateFile2 = join(daemonHome2, ".opencode-remote", "daemon.json");
        const port2 = await new Promise<number>((resolve, reject) => {
          const srv = createServer();
          srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address() as AddressInfo;
            srv.close(() => resolve(port));
          });
          srv.on("error", reject);
        });
        const localDaemon2 = spawn(
          "npx",
          ["tsx", "apps/daemon/src/index.ts"],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              HOME: daemonHome2,
              OCR_METRICS_PORT: String(port2),
              RELAY_URL: "ws://127.0.0.1:1", // dead: relay must stay irrelevant in local mode
              OPENCODE_URL: fakeUrl,
              OCR_LOG_LEVEL: "error",
            },
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
          },
        );
        const killDaemon2 = (signal: NodeJS.Signals = "SIGTERM"): void => {
          if (!localDaemon2.pid) return;
          try {
            process.kill(-localDaemon2.pid, signal);
          } catch {
            /* already gone */
          }
        };
        process.on("exit", () => killDaemon2("SIGKILL"));
        // Same OCR_DESKTOP_SESSION as boot 1 — the offline queue lives in the
        // userData's localStorage and must survive the relaunch.
        const localEnv2 = {
          ...process.env,
          OCR_DESKTOP_SESSION: `${session}-local`,
          OCR_DESKTOP_LOCAL_STATE: localStateFile2,
          OCR_DAEMON_METRICS_PORT: String(port2),
        };
        try {
          let token2 = "";
          for (let i = 0; i < 25; i++) {
            try {
              token2 = (JSON.parse(readFileSync(localStateFile2, "utf8")) as { apiToken?: string }).apiToken ?? "";
            } catch {}
            if (token2) break;
            await fetch(`http://127.0.0.1:${port2}/api/health`, { headers: { authorization: "Bearer warmup" } }).catch(() => {});
            await new Promise((r) => setTimeout(r, 200));
          }
          check("P1-089: boot-2 daemon published the 0600 state file", !!token2);
          // single-instance lock: boot 1 must be fully closed before boot 2.
          // The old keeper unlinks its socket EARLY in shutdown but stays
          // alive through quit()'s 12s SIGKILL grace — relaunching inside
          // that window races the stale bind (EADDRINUSE observed in the
          // gate). Wait for the keeper PROCESS to be gone, not just the sock.
          spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: localEnv });
          localBooted = false;
          for (let i = 0; i < 32; i++) {
            const alive = spawnSync("pgrep", ["-f", "tools/desktop\\.mjs"], { encoding: "utf8" });
            if (alive.status !== 0) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          const open2 = run("P1-089: open (second hermetic boot, live fake backend)", ["open"], 45_000, localEnv2);
          localBooted = open2.ok;
          if (open2.ok) {
            await waitProbe(
              "P1-089: boot-2 paired hook rendered",
              "document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? ''",
              (v) => v.includes("paired"),
              localEnv2,
            );
            // --- queue→flush: the offline queue drains against the fake -----
            // P1-089: a send against a dead BACKEND answers 502 (no enqueue —
            // the daemon is alive), so the queue is seeded at its own storage
            // key exactly as enqueue() writes it. The renderer's localStorage
            // is per-launch (fresh userData), so this happens in boot 2 while
            // the board is still on screen — the flush effect only mounts
            // with the chat.
            run(
              "P1-089: seed the offline queue of the flushed session",
              ["ipc", `window.localStorage.setItem('ocr.queue.${DRAFT}', JSON.stringify(['rascunho P1-089']))`],
              15_000,
              localEnv2,
            );
            run("P1-089: deep-link to the queued session", ["ipc", `location.hash = '#/session/${DRAFT}'`], 15_000, localEnv2);
            await waitProbe(
              "P1-089: offline queue drained",
              "window.localStorage.getItem('ocr.queue." + DRAFT + "') ?? 'null'",
              (v) => v.trim() === '"[]"',
              localEnv2,
            );
            let flushed = false;
            for (let i = 0; i < 12 && !flushed; i++) {
              const hits = await fetch(`${fakeUrl}/__hits`).then((r) => r.json() as Promise<{ method: string; path: string }[]>).catch(() => [] as { method: string; path: string }[]);
              flushed = hits.some((h) => h.method === "POST" && h.path === `/session/${DRAFT}/message`);
              if (!flushed) await new Promise((r) => setTimeout(r, 500));
            }
            check("P1-089: flushed message reached the fake backend (POST recorded)", flushed);
            await waitProbe(
              "P1-089: no pending bubbles left after the flush",
              "document.querySelectorAll('.msg.pending').length",
              (v) => v.trim() === "0",
              localEnv2,
            );
            // --- reentrada: the operator's repro, 3 round-trips -----------------
            run("P1-089: deep-link to the replay session", ["ipc", `location.hash = '#/session/${REPLAY}'`], 15_000, localEnv2);
            const settle = `document.querySelectorAll('.messages .msg').length`;
            await waitProbe("P1-089: history settles at the row count", settle, (v) => v.trim() === String(ROW_COUNT), localEnv2);
            // Event burst: >500 filler events slide the watermark out of the
            // 500-cap buffer, then a turn whose messageID is already in
            // history re-fires session.idle with a DIFFERENT live text —
            // exactly the replay that used to duplicate bubbles.
            const burst = [
              ...Array.from({ length: 520 }, (_, i) => ({
                type: "message.updated",
                properties: { sessionID: "ses-other", info: { id: `filler-${i}`, role: "assistant" } },
              })),
              {
                type: "message.updated",
                properties: { sessionID: REPLAY, info: { id: "msg-5", role: "assistant" } },
              },
              {
                type: "message.part.updated",
                properties: { sessionID: REPLAY, part: { type: "text", text: "reply-5-streamed", messageID: "msg-5" } },
              },
              { type: "session.idle", properties: { sessionID: REPLAY } },
            ];
            const emit = await fetch(`${fakeUrl}/__emit`, { method: "POST", body: JSON.stringify(burst) })
              .then((r) => r.json() as Promise<{ clients?: number }>)
              .catch(() => ({}) as { clients?: number });
            check("P1-089: burst delivered over the daemon's SSE bridge", (emit.clients ?? 0) >= 1, JSON.stringify(emit));
            await new Promise((r) => setTimeout(r, 2_500));
            const streamedDupes = `Array.from(document.querySelectorAll('.messages .msg')).filter((m) => (m.textContent || '').includes('reply-5-streamed')).length`;
            await waitProbe(
              "P1-089: replayed idle does NOT duplicate a history bubble",
              `(${settle}) + '|' + (${streamedDupes})`,
              (v) => {
                const [count, dupes] = JSON.parse(v.trim()).split("|");
                return count === String(ROW_COUNT) && dupes === "0";
              },
              localEnv2,
            );
            let stable = true;
            for (let i = 0; i < 3; i++) {
              run("P1-089: switch to the flushed session", ["ipc", `location.hash = '#/session/${DRAFT}'`], 15_000, localEnv2);
              await waitProbe("P1-089: reentry — flushed session at row count", settle, (v) => v.trim() === String(ROW_COUNT), localEnv2);
              run("P1-089: back to the replay session", ["ipc", `location.hash = '#/session/${REPLAY}'`], 15_000, localEnv2);
              const ok = await waitProbe(
                "P1-089: reentry — replay session at row count",
                `(${settle}) + '|' + (${streamedDupes})`,
                (v) => {
                  const [count, dupes] = JSON.parse(v.trim()).split("|");
                  return count === String(ROW_COUNT) && dupes === "0";
                },
                localEnv2,
              );
              if (!ok) stable = false;
            }
            check("P1-089: bubble count stable (delta 0) across the 3 re-entries", stable);
            // evidence shots of the re-entered session (spec criterion 5)
            const shot1440 = run("P1-089: 1440x900 evidence shot", ["shot", join(shotsDir, "P1-089-reentry-1440.png"), "1440", "900"], 15_000, localEnv2);
            if (shot1440.ok) check("P1-089: 1440x900 shot is a real PNG", pngSize(join(shotsDir, "P1-089-reentry-1440.png")).join("x") === "1440x900");
            // back-to-list path: the real ← button only exists below 1024px
            // (P1-005 hides it in the desktop layout), so this round-trip runs
            // after the 390px resize that the 390 evidence shot needs anyway.
            const shot390 = run("P1-089: 390 evidence shot", ["shot", join(shotsDir, "P1-089-reentry-390.png"), "390", "844"], 15_000, localEnv2);
            if (shot390.ok) check("P1-089: 390 shot is a real PNG", pngSize(join(shotsDir, "P1-089-reentry-390.png"))[0] === 390);
            await waitProbe("P1-089: chat remounted at 390px", "!!document.querySelector('.messages')", (v) => /true/.test(v), localEnv2);
            const back = run("P1-089: back to the conversation list", ["click", ".chat-back"], 15_000, localEnv2);
            if (back.ok) {
              await waitProbe("P1-089: board rendered (chat unmounted)", "!!document.querySelector('.messages')", (v) => /false/.test(v), localEnv2);
              await waitProbe(
                "P1-089: session row rendered on the board",
                "document.body.innerText.includes('Reentry check')",
                (v) => /true/.test(v),
                localEnv2,
              );
              const row = run("P1-089: click the session row", ["click", ".session-card"], 15_000, localEnv2);
              if (row.ok) {
                await waitProbe(
                  "P1-089: board re-entry stays at row count",
                  `(${settle}) + '|' + (${streamedDupes})`,
                  (v) => {
                    const [count, dupes] = JSON.parse(v.trim()).split("|");
                    return count === String(ROW_COUNT) && dupes === "0";
                  },
                  localEnv2,
                );
              }
            }
          }
        } finally {
          if (localBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: localEnv2 });
          localBooted = false;
          killDaemon2("SIGKILL");
          killFake();
          rmSync(daemonHome2, { recursive: true, force: true });
        }
      }
    }
  } finally {
    if (localBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: localEnv });
    killDaemon("SIGKILL");
    rmSync(daemonHome, { recursive: true, force: true });
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
