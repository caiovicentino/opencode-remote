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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  ARTIFACTS_MARKER,
  buildArtifactsPathLine,
  buildArtifactsPrompt,
  injectArtifactsPathPart,
  injectArtifactsSystem,
  workspaceCoversArtifacts,
} from "../apps/daemon/src/sessionctx";
import { CLOSE_HINT_LOG } from "../apps/desktop/src/closehint";

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
  const block = buildArtifactsPrompt();
  check(
    "P1-096: injected block is session-independent (no per-session dir in system)",
    block.includes(ARTIFACTS_MARKER) &&
      !block.includes(join(homedir(), ".opencode-remote", "artifacts", "ses_flow")),
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
    if (shouldInject(bare)) injectArtifactsSystem(bareTurn);
    if (shouldInject(bare)) injectArtifactsPathPart(bareTurn, "ses_flow");
    check(
      "P1-068: session in a workspace WITHOUT AGENTS.md receives the protocol (marker + [file: line)",
      bareTurn.system?.includes(ARTIFACTS_MARKER) === true && bareTurn.system?.includes("[file:") === true,
    );
    check(
      "P1-096: first turn also carries the per-session path line as the last part",
      Array.isArray(bareTurn.parts) &&
        (bareTurn.parts[bareTurn.parts.length - 1] as { text?: string }).text ===
          buildArtifactsPathLine("ses_flow"),
    );
    const coveredTurn: { parts: unknown[]; system?: string } = {
      parts: [{ type: "text", text: "gere um preview HTML do relatório" }],
    };
    if (shouldInject(covered)) injectArtifactsSystem(coveredTurn);
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
// P2-148: hermeticEnv honors a caller-set OCR_USER_DATA_DIR (welcome-flag
// relaunch beat) — an inherited value must never contaminate every boot.
delete cliEnv.OCR_USER_DATA_DIR;

// Hard budget: the whole flow must fit (spec criterion). P1-070 added the
// "local boot" block (real hermetic daemon + fresh instance + degradation
// probe), so the original 60s grew to 90s — documented in the commit per the
// spec and reflected in the <90s note in AGENTS.md. P2-090 added the artifact
// auto-open beat (real watcher + three idle round-trips), growing it to 120s;
// P2-091 added the artifact-navigation beats (card→split, list→split, title
// headers), growing it to 150s; P2-092 added the Browser-pane fill beat
// (colored test page + maximize-toggle measurement), growing it to 165s;
// P1-093 added the AutoMode-failure beat (real Settings toggle + permission
// ask the fake rejects + retry verification), growing it to 180s; P2-097
// added the oversized-artifact beat (5 MB write + 413 round-trip) inside the
// same budget — its probes poll at 500ms to pay for it; P3-084 added the
// sidebar-grouping + ⌘K-preview beat (fake backend serves time.updated
// sessions) inside the same budget as well; P3-085 added the thinking-block
// beat (simulated long response: reasoning streaming, collapse-on-answer,
// caret, jump-end pill, autoscroll yield) inside the same budget; P3-086
// added the composer beat (attach preview chip, mic-disabled state, inline
// agent/model selector, auto-grow clamp + Enter/Shift+Enter semantics);
// P3-087 added the motion-pass beat (reduced-motion on/off screenshots +
// the animation-name flip probe) inside the same budget; P2-069 added the
// single-instance beat (a real second Electron on the same userData quits
// cleanly), growing it to 195s; P2-138 added the upstream-notice beat
// (fake opencode answering 401 + a third hermetic daemon + Settings help
// card), growing it to 225s; P2-140 added the sidecar-exit beat (a real
// OCR_DAEMON_ENTRY fake dying with EADDRINUSE + the calm-card verdict),
// growing it to 240s; P2-117 added the Scan-QR state-machine beats
// (camera-blocked boot + fake-camera boot: unavailable/preview states,
// 390px preview, NO SIGNAL fallback, paste CTA) inside the same budget;
// P2-148 added the welcome beats (the three-step first-run onboarding walk
// plus a second same-userData boot proving the flag persists), 270s;
// P2-150 added the taskbar-overlay badge beat (push 12 → bridge round-trip,
// one-window aliveness probe, 1440x900 shot) inside the same budget; P2-152
// added the close-to-tray hint beat (fresh-userData close from the renderer +
// a second same-userData boot proving the one-shot flag), growing it to 300s.
const startedAt = Date.now();
const DEADLINE_MS = 300_000;
const shotPath = join(tmpdir(), "ocr-desktop-flow", `flow-${process.pid}.png`);
// Evidence shots live in the builder dir (never used as review evidence).
// Declared up front: the P2-112 degraded-journey beats record there too.
const shotsDir = join(homedir(), ".opencode-remote", "pilot", "shots", "builder");
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

/** P2-140: the displayed verdict copy must never carry a file path, machine
 * detail or secret — path separators, home/tmp markers and credential words
 * are all leaks for a stage-3 user. */
function reasonOrHintLeaksPaths(v: { reason?: string; hint?: string }): boolean {
  const texts = [v.reason ?? "", v.hint ?? ""];
  return texts.some((s) => s.includes("/") || s.includes("\\") || /home|users|tmp|token|secret/i.test(s));
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
// P2-148 beat B: the userData the keeper minted (reported by `open`) is
// reused by a second hermetic boot after the keeper closes.
let bootInfo: { userData?: string } | null = null;
try {
  const opened = run("open (hermetic launch)", ["open"], 45_000);
  keeperBooted = opened.ok;
  if (!opened.ok) process.exit(1);

  run("boot rendered the app (#root mounted)", ["see", "OpenCode Remote"], 15_000);
  // --- P2-069: single instance per userData -----------------------------------
  // The incident: a second launch on the same userData raced the first one and
  // could end as a white, unpaired window. Now the second instance quits
  // cleanly (single-instance lock), explains why in the shared desktop.log and
  // the first instance keeps exactly one window. Hermetic repro: spawn the real
  // Electron binary against the SAME userData the keeper minted (`open`
  // reports it since P2-069) — the lock must reject it before any window.
  phase("P2-069: single instance per userData");
  try {
    bootInfo = JSON.parse(opened.stdout.trim()) as { userData?: string };
  } catch {}
  const electronBin = (() => {
    try {
      return createRequire(join(repoRoot, "apps", "desktop", "package.json"))("electron") as string;
    } catch {
      return "";
    }
  })();
  if (bootInfo?.userData && electronBin) {
    const second = spawnSync(
      electronBin,
      [join(repoRoot, "apps", "desktop")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 45_000,
        env: { ...cliEnv, OCR_USER_DATA_DIR: bootInfo.userData },
      },
    );
    check(
      "P2-069: second instance on the same userData quits cleanly (lock held)",
      second.status === 0,
      `${second.stdout ?? ""}\n${second.stderr ?? ""}`,
    );
    const sharedLog = (() => {
      try {
        return readFileSync(join(bootInfo!.userData!, "logs", "desktop.log"), "utf8");
      } catch {
        return "";
      }
    })();
    check("P2-069: lock-fail explained in the shared desktop.log", /already owns this userData/.test(sharedLog));
    const winsAfter = run("P2-069: first instance still answers after the double open", ["wins"], 15_000);
    if (winsAfter.ok) {
      let count = -1;
      try {
        const arr = JSON.parse(winsAfter.stdout) as unknown;
        count = Array.isArray(arr) ? arr.length : -1;
      } catch {}
      check("P2-069: exactly one window after the double open", count === 1, winsAfter.stdout);
    }
  } else {
    check("P2-069: open reported the minted userData dir", false, opened.stdout);
  }
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
  // --- P2-148: first-run welcome — three steps, shown once --------------------
  // Fresh userData boots into the onboarding instead of a bare home: (1) the
  // one-sentence intro, (2) the local agent's state (P2-112 calm copy + the
  // P2-138 upstream notice) and (3) the phone-pairing invitation with an
  // explicit "do this later". Skipping stamps the flag — the second boot on
  // the same userData is beat B at the bottom of this suite.
  phase("P2-148: welcome walk (keeper boot)");
  const welcomeStep = run("P2-148: welcome rendered on first boot", ["ipc", "document.querySelector('.welcome')?.getAttribute('data-welcome-step') ?? 'MISS'"], 15_000);
  if (welcomeStep.ok) check("P2-148: step 1 is the intro", welcomeStep.stdout.replace(/"/g, "").trim() === "1", welcomeStep.stdout);
  const welcomeNoBanner = run("P2-148: banner count probe under the onboarding", ["ipc", "String(document.querySelectorAll('.daemon-reconnecting, .daemon-down, .conn-banner').length)"], 15_000);
  if (welcomeNoBanner.ok) check("P2-148: zero daemon banners while the onboarding shows", welcomeNoBanner.stdout.replace(/"/g, "").trim() === "0", welcomeNoBanner.stdout);
  const welcomeShot = join(shotsDir, "P2-148-welcome-1440.png");
  const w1 = run("P2-148: 1440x900 welcome shot", ["shot", welcomeShot, "1440", "900"], 15_000);
  if (w1.ok) check("P2-148: 1440x900 welcome shot is a real PNG", pngSize(welcomeShot).join("x") === "1440x900");
  run("P2-148: advance to the agent step", ["click", ".welcome-next"], 15_000);
  const agentStep = run("P2-148: agent step rendered", ["ipc", "document.querySelector('.welcome-agent')?.textContent ?? 'MISS'"], 15_000);
  if (agentStep.ok) {
    check(
      "P2-148: agent step copy is the calm degraded wording (en|pt)",
      /Local agent|Agente local|Connecting for the first time|Conectando pela primeira vez/.test(agentStep.stdout),
      agentStep.stdout,
    );
  }
  run("P2-148: advance to the pairing step", ["click", ".welcome-next"], 15_000);
  const pairStep = run("P2-148: pairing invitation rendered", ["ipc", "document.querySelector('.welcome .pair-section-title')?.textContent ?? 'MISS'"], 15_000);
  if (pairStep.ok) check("P2-148: host section title inside the welcome", /Pair a phone|Parear um celular/.test(pairStep.stdout), pairStep.stdout);
  const later = run("P2-148: explicit 'do this later' option", ["ipc", "!!document.querySelector('.welcome-later')"], 15_000);
  if (later.ok) check("P2-148: .welcome-later present", /true/.test(later.stdout));
  const welcomeShot390 = join(shotsDir, "P2-148-welcome-390.png");
  const w2 = run("P2-148: 390 welcome shot", ["shot", welcomeShot390, "390", "844"], 15_000);
  if (w2.ok) check("P2-148: 390 welcome shot is a real PNG", pngSize(welcomeShot390)[0] === 390);
  run("P2-148: skip the onboarding", ["click", ".welcome-skip"], 15_000);
  const welcomeGone = run("P2-148: welcome absent after skip", ["ipc", "!!document.querySelector('.welcome')"], 15_000);
  if (welcomeGone.ok) check("P2-148: .welcome unmounted after skip", /false/.test(welcomeGone.stdout));
  const homeBack = run("P2-148: home rendered after skip", ["ipc", "!!document.querySelector('.degraded')"], 15_000);
  if (homeBack.ok) check("P2-148: .degraded home after the onboarding", /true/.test(homeBack.stdout));
  // --- P2-112: first boot with a dead daemon degrades, never dead-ends --------
  // The old journey stranded a first-time user on the pairing wall with a red
  // "daemon fell" alert for a daemon this machine had never met. Now the
  // unpaired shell shows the degraded journey: calm first-contact status,
  // visible auto-retry, reconnect WITH feedback, minimal local data — and
  // manual pairing one click away.
  const degraded = run("P2-112: degraded journey rendered on first boot", ["ipc", "!!document.querySelector('.degraded')"], 15_000);
  if (degraded.ok) check("P2-112: .degraded present", /true/.test(degraded.stdout));
  const kindEl = run("P2-112: journey kind attribute", ["ipc", "document.querySelector('.degraded')?.getAttribute('data-degraded-kind') ?? ''"], 15_000);
  if (kindEl.ok) check("P2-112: never-seen daemon reads as first contact", kindEl.stdout.includes("first-contact"), kindEl.stdout);
  const noRed = run("P2-112: accusatory red banner absent on first contact", ["ipc", "!!document.querySelector('.daemon-down')"], 15_000);
  if (noRed.ok) check("P2-112: .daemon-down not rendered for a never-seen daemon", /false/.test(noRed.stdout));
  const calmTitle = run("P2-112: first-contact status copy", ["ipc", "document.querySelector('.degraded-status h2')?.textContent ?? ''"], 15_000);
  if (calmTitle.ok) {
    check(
      "P2-112: non-accusatory first-contact title (en|pt)",
      /Conectando pela primeira vez|Connecting for the first time/.test(calmTitle.stdout),
      calmTitle.stdout,
    );
  }
  const retryLine = run("P2-112: auto-retry line copy", ["ipc", "document.querySelector('.degraded-retry')?.textContent ?? ''"], 15_000);
  if (retryLine.ok) {
    check(
      "P2-112: visible auto-retry indicator (en|pt)",
      /Tentando sozinho|Retrying automatically/.test(retryLine.stdout),
      retryLine.stdout,
    );
  }
  run("P2-112: calm status really visible on screen", ["see", "Conectando pela primeira vez"], 15_000);
  const dshot1440 = join(shotsDir, "P2-112-firstboot-degraded.png");
  const dshot390 = join(shotsDir, "P2-112-firstboot-degraded-390.png");
  const d1 = run("P2-112: 1440x900 degraded-journey shot", ["shot", dshot1440, "1440", "900"], 15_000);
  if (d1.ok) check("P2-112: 1440x900 shot is a real PNG", pngSize(dshot1440).join("x") === "1440x900");
  const d2 = run("P2-112: 390 degraded-journey shot", ["shot", dshot390, "390", "844"], 15_000);
  if (d2.ok) check("P2-112: 390 shot is a real PNG", pngSize(dshot390)[0] === 390);
  const reconnBtn = run("P2-112: reconnect button in the degraded view", ["ipc", "!!document.querySelector('.degraded-reconnect-btn')"], 15_000);
  if (reconnBtn.ok) check("P2-112: reconnect button present", /true/.test(reconnBtn.stdout));

  // "Reconnect now" must give real feedback: trying state (spinner, ≥2s) and
  // then a result toast. Hermetically the restart is an honest no-op (no
  // sidecar entry to restart), so the toast reports the failure.
  run("P2-112: click Reconnect now", ["click", ".degraded-reconnect-btn"], 15_000);
  await waitProbe(
    "P2-112: result toast appears after the trying state",
    "!!document.querySelector('.ocr-toast')",
    (v) => /true/.test(v),
    cliEnv,
    12,
    500,
  );
  const toastCopy = run("P2-112: toast copy", ["ipc", "document.querySelector('.ocr-toast')?.textContent ?? ''"], 15_000);
  if (toastCopy.ok) {
    check(
      "P2-112: honest result toast (en|pt)",
      /Não deu pra reiniciar o daemon|Could not restart the daemon/.test(toastCopy.stdout),
      toastCopy.stdout,
    );
  }
  // The toast floats above the bottom of the card — let it auto-dismiss
  // (4s) before clicking the escape hatch underneath.
  await waitProbe(
    "P2-112: toast auto-dismisses",
    "!!document.querySelector('.ocr-toast')",
    (v) => /false/.test(v),
    cliEnv,
    10,
    500,
  );
  run("P2-112: manual pairing escape hatch", ["click", ".degraded-manual"], 15_000);

  // --- P2-106: benchmark pairing journey — 4 evidence states ------------------
  // (1) two titled sections on the ceremony screen, (2) scanner route,
  // (3) styled invalid-code error with the inline format helper, and (4) the
  // QR overlay with the demoted "pair later" link (local-boot beat below).
  const connectTitle = run("P2-106: client section title", ["ipc", "document.querySelector('.pair-section-title')?.textContent ?? ''"], 15_000);
  if (connectTitle.ok) {
    check(
      "P2-106: 'connect to another machine' section title (en|pt)",
      /Connect to another machine|Conectar a outra máquina/.test(connectTitle.stdout),
      connectTitle.stdout,
    );
  }
  const sectionCount = run("P2-106: titled section count", ["ipc", "String(document.querySelectorAll('.pair-section').length)"], 15_000);
  if (sectionCount.ok) check("P2-106: connect + host sections both render", sectionCount.stdout.replace(/"/g, "").trim() === "2", sectionCount.stdout);
  const shotSections1440 = join(shotsDir, "P2-106-pairing-sections.png");
  const shotSections390 = join(shotsDir, "P2-106-pairing-sections-390.png");
  const sec1 = run("P2-106: 1440x900 sections shot", ["shot", shotSections1440, "1440", "900"], 15_000);
  if (sec1.ok) check("P2-106: sections 1440x900 shot is a real PNG", pngSize(shotSections1440).join("x") === "1440x900");
  // Geometry is read at 1440x900 (the shot command just set it): the column is
  // capped at ~420px wide and vertically centered in the window.
  const centerCol = run(
    "P2-106: narrow centered column (~420px)",
    ["ipc", "(() => { const el = document.querySelector('.pair-screen'); if (!el) return ''; const r = el.getBoundingClientRect(); return String(Math.round(r.width)) + 'x' + String(Math.round((r.top + r.bottom) / 2)); })()"],
    15_000,
  );
  if (centerCol.ok) {
    const m = centerCol.stdout.replace(/"/g, "").match(/(\d+)x(\d+)/);
    check(
      "P2-106: pair column reads ~420px wide, vertically centered",
      !!m && Number(m[1]) >= 380 && Number(m[1]) <= 420 && Number(m[2]) >= 375 && Number(m[2]) <= 525,
      centerCol.stdout,
    );
  }
  const sec2 = run("P2-106: 390 sections shot", ["shot", shotSections390, "390", "844"], 15_000);
  if (sec2.ok) check("P2-106: sections 390 shot is a real PNG", pngSize(shotSections390)[0] === 390);

  // (2) scanner route: open it, prove the screen swapped, come back. The
  // hermetic shell has no camera — the scanner's own error fallback is a
  // valid render of this state. P2-117: paste-first on the desktop made the
  // section's primary button the paste form, so target the scan entry
  // explicitly (same class on both orderings).
  run("P2-106: open the QR scanner", ["click", ".pair-scan-entry"], 15_000);
  await waitProbe(
    "P2-106: scanner screen rendered",
    "document.querySelector('.screen header h1')?.textContent ?? ''",
    (v) => /Scan pairing code|Escanear código de pareamento/.test(v),
    cliEnv,
    10,
    500,
  );
  const shotScanner = join(shotsDir, "P2-106-pairing-scanner.png");
  const sc1 = run("P2-106: 1440x900 scanner shot", ["shot", shotScanner, "1440", "900"], 15_000);
  if (sc1.ok) check("P2-106: scanner 1440x900 shot is a real PNG", pngSize(shotScanner).join("x") === "1440x900");
  run("P2-106: back from the scanner", ["click", ".screen header button"], 15_000);
  await waitProbe(
    "P2-106: back on the ceremony screen",
    "!!document.querySelector('.pair-submit')",
    (v) => /true/.test(v),
    cliEnv,
    10,
    500,
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
  // P2-106: the styled error block also carries the inline expected-format
  // helper and a live region so screen readers announce the failure.
  const errHint = run("P2-106: invalid-code format helper", ["ipc", "document.querySelector('.pair-error-hint')?.textContent ?? ''"], 15_000);
  if (errHint.ok) {
    check(
      "P2-106: helper names the expected pairing-URI format (en|pt)",
      /Expected format: opencode-remote:\/\/pair|Formato esperado: opencode-remote:\/\/pair/.test(errHint.stdout),
      errHint.stdout,
    );
  }
  const errLive = run("P2-106: error live-region semantics", ["ipc", "(() => { const el = document.querySelector('.pair-error'); return el ? el.getAttribute('role') + '|' + el.getAttribute('aria-live') : ''; })()"], 15_000);
  if (errLive.ok) check("P2-106: .pair-error is role=alert + aria-live=assertive", /alert\|assertive/.test(errLive.stdout), errLive.stdout);
  const shotError = join(shotsDir, "P2-106-pairing-error.png");
  const er1 = run("P2-106: 1440x900 error shot", ["shot", shotError, "1440", "900"], 15_000);
  if (er1.ok) check("P2-106: error 1440x900 shot is a real PNG", pngSize(shotError).join("x") === "1440x900");
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
  // P1-053/P2-112: the one-click recovery button (app:reconnectDaemon →
  // restartDaemon) now lives in the degraded journey's status card — asserted
  // in the P2-112 block above, while that view is on screen (before the
  // manual-pairing hatch click).

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

  // --- P2-150: taskbar overlay badge beat ---------------------------------------
  // The push now routes through badgePlan (badge.ts): darwin/linux dock count,
  // win32 taskbar overlay. The wiring must survive a real push of a 9+ count —
  // getUnreadBadge round-trips (preload.ts bridge) AND the shell stays alive
  // with exactly one window afterwards (a throwing overlay path must never
  // take the app down). Evidence shot at 1440x900 per the spec.
  run("P2-150: push unread=12 over ocr:unread", ["ipc", "window.ocrDesktop.sendUnread(12)"], 15_000);
  const badge12 = run("P2-150: read app:unreadBadge after push", ["ipc", "window.ocrDesktop.getUnreadBadge()"], 15_000);
  if (badge12.ok) check("P2-150: main received the pushed count (12)", badge12.stdout.trim() === "12");
  const winsBadge = run("P2-150: wins probe after the push", ["wins"], 15_000);
  if (winsBadge.ok) {
    try {
      const arr = JSON.parse(winsBadge.stdout) as unknown[];
      check("P2-150: app alive with exactly one window after the push", Array.isArray(arr) && arr.length === 1, winsBadge.stdout);
    } catch (err) {
      check("P2-150: app alive with exactly one window after the push", false, String(err));
    }
  }
  const badgeShot = join(shotsDir, "P2-150-overlay-badge.png");
  const bs = run("P2-150: 1440x900 badge shot", ["shot", badgeShot, "1440", "900"], 15_000);
  if (bs.ok) check("P2-150: 1440x900 shot is a real PNG", pngSize(badgeShot).join("x") === "1440x900");
  run("P2-150: clear the badge (unread=0)", ["ipc", "window.ocrDesktop.sendUnread(0)"], 15_000);
  const badgeCleared = run("P2-150: read app:unreadBadge after clear", ["ipc", "window.ocrDesktop.getUnreadBadge()"], 15_000);
  if (badgeCleared.ok) check("P2-150: badge clears to 0", badgeCleared.stdout.trim() === "0");

  // --- P1-072: the shell must expose the real <webview> tag --------------------
  await testWebviewPane();

  // --- P1-053: the "reconnecting…" hermetic state (second launch) --------------
  // An ADOPTED daemon going missing is never terminal. P2-112: the status now
  // lives in the degraded journey card (title carries the attempt counter) —
  // still an active, recoverable state, NO QR overlay, no re-pairing.
  // Recorded as evidence shots (1440x900 desktop + 390 mobile) in the builder
  // shots dir per the spec.
  const reconnEnv = {
    ...process.env,
    OCR_DESKTOP_SESSION: `${session}-reconn`,
    OCR_DAEMON_FORCE_RECONNECTING: "1",
  };
  const shot1440 = join(shotsDir, "P1-053-reconnecting.png");
  const shot390 = join(shotsDir, "P1-053-reconnecting-390.png");
  let reconnBooted = false;
  try {
    const reconnOpen = run("reconnect: open (hermetic launch)", ["open"], 45_000, reconnEnv);
    reconnBooted = reconnOpen.ok;
    if (reconnOpen.ok) {
      // P2-148: fresh userData boots into the first-run welcome — skip it so
      // the reconnecting journey card is on screen for the probes below.
      run("reconnect: skip the first-run welcome", ["click", ".welcome-skip"], 15_000, reconnEnv);
      // Locale-proof: the journey card's data attribute (class from App.tsx).
      const dom = run("reconnect: degraded journey carries the reconnecting status", ["ipc", "document.querySelector('.degraded')?.getAttribute('data-degraded-kind') ?? ''"], 15_000, reconnEnv);
      if (dom.ok) check("reconnect: reconnecting kind on the journey card", dom.stdout.includes("reconnecting"), dom.stdout);
      const title = run("reconnect: status title copy", ["ipc", "document.querySelector('.degraded-status h2')?.textContent ?? ''"], 15_000, reconnEnv);
      if (title.ok) {
        check(
          "reconnect: attempt counter in the status title (en|pt)",
          /Reconectando ao daemon|Reconnecting to daemon/.test(title.stdout) && /\(\d+\)/.test(title.stdout),
          title.stdout,
        );
      }
      // Machine locale is pt-BR; `see` is the real visible-text check.
      run("reconnect: status text visible", ["see", "Reconectando ao daemon"], 15_000, reconnEnv);
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
      // P2-148: fresh userData boots into the first-run welcome — skip it.
      run("mismatch: skip the first-run welcome", ["click", ".welcome-skip"], 15_000, mismatchEnv);
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

  // --- P2-117: Scan-QR screen — the four camera states -------------------------
  // The scanner used to open a dead black box (no preview, no spinner, no
  // unavailable state) and could leak a capture device's own "NO SIGNAL" OSD.
  // Two hermetic boots cover the four spec states:
  //   boot 1 (OCR_DESKTOP_CAMERA_BLOCK=1): "sem camera" → unavailable panel
  //     with the paste CTA → "colar codigo" (back on the primary form);
  //   boot 2 (OCR_DESKTOP_MEDIA_FAKE=1): live "preview" (incl. the 390px
  //     layout beat) → feed killed → "NO SIGNAL" unavailable state.
  const scanShot1440 = join(shotsDir, "P2-117-scan-1440.png");
  const scanShot390 = join(shotsDir, "P2-117-scan-390.png");
  const scannerState = "document.querySelector('.qr-scanner')?.dataset.state ?? ''";
  {
    const scanBlockEnv = {
      ...process.env,
      OCR_DESKTOP_SESSION: `${session}-scan`,
      OCR_DESKTOP_CAMERA_BLOCK: "1",
    };
    let scanBooted = false;
    try {
      const open = run("scan: open (camera-blocked launch)", ["open"], 45_000, scanBlockEnv);
      scanBooted = open.ok;
      if (open.ok) {
        // P2-148: fresh userData boots into the first-run welcome — skip it.
        run("scan: skip the first-run welcome", ["click", ".welcome-skip"], 15_000, scanBlockEnv);
        // P2-112 integration: a hermetic fresh boot lands on the DegradedView
        // first-contact card — the pairing form (and with it the scanner
        // option) lives one deliberate click away.
        run("scan: manual pairing escape hatch", ["click", ".degraded-manual"], 15_000, scanBlockEnv);
        // Desktop-first ordering: the paste form leads (P2-117 item 4), the
        // scanner is the option — a locale-independent class hooks the gate.
        run("scan: open the scanner (desktop option)", ["click", ".pair-scan-entry"], 15_000, scanBlockEnv);
        await waitProbe("scan: unavailable state rendered", scannerState, (v) => v.includes("unavailable"), scanBlockEnv);
        const cta = run("scan: paste CTA present", ["ipc", "!!document.querySelector('.qr-paste-cta')"], 15_000, scanBlockEnv);
        if (cta.ok) check("scan: paste CTA visible in the unavailable state", /true/.test(cta.stdout));
        // "colar codigo": the CTA returns to the primary paste form.
        run("scan: click paste CTA", ["click", ".qr-paste-cta"], 15_000, scanBlockEnv);
        const back = run("scan: primary paste form restored", ["ipc", "!!document.querySelector('.pair-submit')"], 15_000, scanBlockEnv);
        if (back.ok) check("scan: CTA returns to the paste form (colar codigo)", /true/.test(back.stdout));
      }
    } finally {
      if (scanBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: scanBlockEnv });
    }

    const scanFakeEnv = {
      ...process.env,
      // P1-089 lesson: the keeper's unix socket lives at
      // $TMPDIR/ocr-desktop-<session>/keeper.sock and macOS truncates AF_UNIX
      // bind() paths at 104 chars — keep the session suffix SHORT.
      OCR_DESKTOP_SESSION: `${session}-scan2`,
      OCR_DESKTOP_MEDIA_FAKE: "1",
    };
    let scanFakeBooted = false;
    try {
      const open = run("scan-live: open (fake-camera launch)", ["open"], 45_000, scanFakeEnv);
      scanFakeBooted = open.ok;
      if (open.ok) {
        // P2-148: fresh userData boots into the first-run welcome — skip it.
        run("scan-live: skip the first-run welcome", ["click", ".welcome-skip"], 15_000, scanFakeEnv);
        // P2-112 integration (same as the camera-blocked boot): the fresh
        // hermetic instance shows the first-contact card first.
        run("scan-live: manual pairing escape hatch", ["click", ".degraded-manual"], 15_000, scanFakeEnv);
        run("scan-live: open the scanner", ["click", ".pair-scan-entry"], 15_000, scanFakeEnv);
        await waitProbe("scan-live: preview state reached", scannerState, (v) => v.includes("preview"), scanFakeEnv);
        const s1 = run("scan-live: 1440x900 evidence shot", ["shot", scanShot1440, "1440", "900"], 15_000, scanFakeEnv);
        if (s1.ok) check("scan-live: 1440x900 shot is a real PNG", pngSize(scanShot1440).join("x") === "1440x900");
        // 390px beat: the preview must keep breathing at phone width — the
        // video element keeps a real box instead of vanishing under the
        // caption. `shot` resizes first, so the probe reads the 390px layout.
        const s2 = run("scan-live: 390 evidence shot", ["shot", scanShot390, "390", "844"], 15_000, scanFakeEnv);
        if (s2.ok) check("scan-live: 390 shot is a real PNG", pngSize(scanShot390)[0] === 390);
        const rect = run(
          "scan-live: video box at 390px",
          ["ipc", "(() => { const r = document.querySelector('.qr-video')?.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null; })()"],
          15_000,
          scanFakeEnv,
        );
        if (rect.ok) {
          let box: { w?: number; h?: number } | null = null;
          try {
            box = JSON.parse(rect.stdout) as typeof box;
          } catch {}
          check(
            "scan-live: preview survives 390px (video keeps a visible box)",
            !!box && box.w >= 200 && box.h >= 100,
            rect.stdout,
          );
        }
        // NO SIGNAL beat: kill the feed the way an unplugged capture device
        // would (track ended) — the scanner must fall back to the unavailable
        // state with the paste CTA, never render a device OSD placeholder.
        run(
          "scan-live: kill the feed (NO SIGNAL repro)",
          ["ipc", "(() => { const v = document.querySelector('.qr-video'); const tr = v?.srcObject?.getVideoTracks?.()[0]; if (!tr) return false; tr.stop(); return true; })()"],
          15_000,
          scanFakeEnv,
        );
        await waitProbe("scan-live: NO SIGNAL falls back to unavailable", scannerState, (v) => v.includes("unavailable"), scanFakeEnv);
        const reason = run(
          "scan-live: unavailable reason is the empty feed",
          ["ipc", "document.querySelector('.qr-scanner')?.dataset.reason ?? ''"],
          15_000,
          scanFakeEnv,
        );
        if (reason.ok) check("scan-live: empty feed reports no-signal", reason.stdout.includes("no-signal"), reason.stdout);
        const cta2 = run("scan-live: paste CTA present after NO SIGNAL", ["ipc", "!!document.querySelector('.qr-paste-cta')"], 15_000, scanFakeEnv);
        if (cta2.ok) check("scan-live: paste CTA offered after the feed dies", /true/.test(cta2.stdout));
      }
    } finally {
      if (scanFakeBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: scanFakeEnv });
    }
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
        // P2-148: fresh userData boots into the first-run welcome — skip it.
        // The local auto-pair completes in the background either way.
        run("local: skip the first-run welcome", ["click", ".welcome-skip"], 15_000, localEnv);
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

        // --- P2-106: QR overlay state (4th evidence state) -----------------------
        // Request remote pairing from Settings: the next poll fetches the
        // hermetic daemon's pairing URI, renders the QR overlay, and the
        // demoted "pair later" quiet link dismisses it back to local quiet.
        const overlayClicked = run("P2-106: request remote pairing (Settings entry)", ["click", ".pair-remote-entry"], 15_000, localEnv);
        if (overlayClicked.ok) {
          await waitProbe(
            "P2-106: QR overlay renders",
            "!!document.querySelector('.pair-overlay')",
            (v) => /true/.test(v),
            localEnv,
            24,
            500,
          );
          const shotOverlay = join(shotsDir, "P2-106-pairing-overlay.png");
          const o1 = run("P2-106: 1440x900 overlay shot", ["shot", shotOverlay, "1440", "900"], 15_000, localEnv);
          if (o1.ok) check("P2-106: overlay 1440x900 shot is a real PNG", pngSize(shotOverlay).join("x") === "1440x900");
          const laterClass = run("P2-106: 'pair later' classes", ["ipc", "document.querySelector('.pair-overlay-later')?.className ?? ''"], 15_000, localEnv);
          if (laterClass.ok) {
            check(
              "P2-106: 'pair later' is the quiet link, not .primary",
              /pair-overlay-later/.test(laterClass.stdout) && !/primary/.test(laterClass.stdout),
              laterClass.stdout,
            );
          }
          run("P2-106: dismiss via the quiet link", ["click", ".pair-overlay-later"], 15_000, localEnv);
          await waitProbe(
            "P2-106: overlay dismissed",
            "!!document.querySelector('.pair-overlay')",
            (v) => /false/.test(v),
            localEnv,
            10,
            500,
          );
        }

        // --- P2-108: empty state ends in an action -------------------------------
        // Superseded by P2-123's living home: the desk-empty CTA grew into the
        // full home screen (greeting + composer + ideas), enforced by the
        // P2-123 beat below.

        const s2 = run("local: 390 evidence shot", ["shot", localShot390, "390", "844"], 15_000, localEnv);
        if (s2.ok) check("local: 390 shot is a real PNG", pngSize(localShot390)[0] === 390);

        // --- P2-108: mobile chrome demoted to an overline -----------------------
        // The 390 shot above left the shell on Settings — go back to Chats so
        // the sessions board (and its demoted header) is the visible surface,
        // then probe the 0.72rem overline (≤ 12px at the default root).
        const chatsTab = run("P2-108: back to the Chats tab", ["click", '.tabbar button[aria-label="Chats"]'], 15_000, localEnv);
        if (chatsTab.ok) {
          const overlineProbe = run(
            "P2-108: mobile overline chrome probe",
            ["ipc", "(() => { const h = document.querySelector('.sess-mobile-head .sess-overline'); return !!h && parseFloat(getComputedStyle(h).fontSize) <= 12; })()"],
            15_000,
            localEnv,
          );
          if (overlineProbe.ok) check("P2-108: mobile machine name renders as a 0.72rem overline", /true/.test(overlineProbe.stdout), overlineProbe.stdout);
          run("P2-108: mobile overline evidence shot", ["shot", join(shotsDir, "P2-108-overline-390.png"), "390", "844"], 15_000, localEnv);
        }

        // --- P2-123: the living home (greeting + composer + ideas) -----------
        // The window is still 390px wide from the previous shot; the home only
        // mounts ≥1024px, so the first wide shot doubles as the resize-back.
        // The settings pane opened for the P2-112 beat is closed via the real
        // Go-menu path first, so .desk-chat shows the home again. Whatever
        // happens inside, the finally re-shrinks the window — P1-080's narrow
        // repro below depends on that width.
        const homeShot1440 = join(shotsDir, "P2-123-home-1440.png");
        const homeShot390 = join(shotsDir, "P2-123-home-390.png");
        run("P2-123: rail Conversas closes the settings pane", ["menu-click", "go-pane-chat"], 15_000, localEnv);
        // resize vehicle only — the settled evidence shot is retaken below
        const resizeShot = join(tmpdir(), `p2-123-resize-${process.pid}.png`);
        run("P2-123: resize back to desktop width", ["shot", resizeShot, "1440", "900"], 15_000, localEnv);
        const homeGreet = await waitProbe(
          "P2-123: serif greeting rendered at desktop width",
          "document.querySelector('.home-greeting')?.textContent ?? ''",
          (v) => /De volta à ação|Back in action/.test(v),
          localEnv,
        );
        try {
          if (homeGreet) {
            // one probe for the whole structure: toggle radios, model selector,
            // mic, placeholder copy and the 3 ideas (the harness prints the
            // evaluate result JSON-encoded — parse the object directly)
            const structure = run(
              "P2-123: composer, toggle, selector, mic and ideas mounted",
              ["ipc", `(() => {
                const q = (s) => !!document.querySelector(s);
                const els = Array.from(document.querySelectorAll('.home-idea'));
                return {
                  chat: q('.home-mode [data-mode=chat]'),
                  cowork: q('.home-mode [data-mode=cowork]'),
                  model: q('.home-composer .composer-model-btn'),
                  mic: q('.home-composer .composer-mic'),
                  placeholder: document.querySelector('.home-composer .composer-text')?.placeholder ?? '',
                  n: els.length,
                  prompts: els.map((e) => e.getAttribute('data-prompt') ?? ''),
                  disabled: els.map((e) => e.disabled),
                };
              })()`],
              15_000,
              localEnv,
            );
            let st: {
              chat?: boolean;
              cowork?: boolean;
              model?: boolean;
              mic?: boolean;
              placeholder?: string;
              n?: number;
              prompts?: string[];
              disabled?: boolean[];
            } | null = null;
            if (structure.ok) {
              try {
                st = JSON.parse(structure.stdout) as typeof st;
              } catch {}
            }
            check(
              "P2-123: model selector + mic present (mode toggle removed — P1-056)",
              st?.model === true && st?.mic === true,
              structure.stdout,
            );
            check(
              "P2-123: central composer placeholder copy (en|pt)",
              /Como posso ajudar você hoje\?|How can I help you today\?/.test(st?.placeholder ?? ""),
              structure.stdout,
            );
            check("P2-123: 3 ideas rendered", st?.n === 3, structure.stdout);
            check(
              "P2-123: every idea carries a non-empty prompt and is enabled",
              (st?.prompts ?? []).every((p) => p.length > 0) && (st?.disabled ?? []).every((d) => d === false),
              structure.stdout,
            );
              // evidence shot with the settled home (1440x900)
              const hs1 = run("P2-123: 1440x900 home evidence shot", ["shot", homeShot1440, "1440", "900"], 15_000, localEnv);
              if (hs1.ok) check("P2-123: 1440x900 home shot is a real PNG", pngSize(homeShot1440).join("x") === "1440x900");
              // criterion: an idea click always gives feedback within 10s —
              // the chat opens OR an inline error explains the failure (the
              // hermetic daemon has no opencode backend, so error is the norm)
              run("P2-123: click idea 1", ["click", '.home-idea[data-idea="1"]'], 15_000, localEnv);
              await waitProbe(
                "P2-123: idea click yields chat or inline error (never frozen)",
                "document.querySelector('.messages') ? 'chat' : (document.querySelector('.home-error') ? 'error' : 'pending')",
                (v) => {
                  const s = v.replace(/"/g, "").trim();
                  return s === "chat" || s === "error";
                },
                localEnv,
                10,
                1_000,
              );
            }
          }
        } finally {
          // home never mounts < 1024px — the 390 evidence shows the mobile
          // board unregressed; also restores the width P1-080 expects
          const hs2 = run("P2-123: 390 evidence shot (mobile board)", ["shot", homeShot390, "390", "844"], 15_000, localEnv);
          if (hs2.ok) check("P2-123: 390 home shot is a real PNG", pngSize(homeShot390)[0] === 390);
        }

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

        // --- P3-086: complete composer — the four elements --------------------
        // attach (+) with file preview, mic (functional placeholder, disabled
        // without perms), inline agent/model selector, auto-grow textarea with
        // Enter-sends / Shift+Enter-newline. The window is 390px wide here
        // (P1-088's last shot); the first shot call restores desktop width.
        const composerShot = join(shotsDir, "P3-086-composer-1440.png");
        const composerReady = run("P3-086: resize to desktop width", ["shot", composerShot, "1440", "900"], 15_000, localEnv);
        if (composerReady.ok) {
          // (1) attach: a real 1x1 PNG flows through the hidden input — the
          // downscale+upload pipeline runs against the hermetic daemon and the
          // file previews as a chip inside the composer, removable with ×.
          const inject = run(
            "P3-086: attach a PNG through the hidden input",
            ["ipc", `(() => {
              const input = document.querySelector('.composer-file');
              if (!input) return 'NO-INPUT';
              const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
              const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
              const dt = new DataTransfer();
              dt.items.add(new File([bytes], "flow-p3-086.png", { type: "image/png" }));
              input.files = dt.files;
              input.dispatchEvent(new Event("change", { bubbles: true }));
              return "OK";
            })()`],
            15_000,
            localEnv,
          );
          if (inject.ok && inject.stdout.includes("OK")) {
            await waitProbe(
              "P3-086: attached file previews as a chip in the composer",
              "!!document.querySelector('.composer-att')",
              (v) => /true/.test(v),
              localEnv,
            );
            run("P3-086: remove the attachment chip", ["click", ".composer-att-x"], 15_000, localEnv);
            await waitProbe(
              "P3-086: chip removed",
              "!!document.querySelector('.composer-att')",
              (v) => /false/.test(v),
              localEnv,
            );
          }
          // (2) mic: always rendered, disabled while the daemon reports no
          // transcribe capability (the hermetic case) — functional placeholder.
          const mic = run(
            "P3-086: mic rendered but disabled without perms",
            ["ipc", "(() => { const m = document.querySelector('.composer-mic'); return m ? { rendered: true, disabled: m.disabled, label: m.getAttribute('aria-label') ?? '' } : { rendered: false }; })()"],
            15_000,
            localEnv,
          );
          if (mic.ok) {
            let mm: { rendered?: boolean; disabled?: boolean; label?: string } | null = null;
            try {
              mm = JSON.parse(mic.stdout) as typeof mm;
            } catch {}
            check(
              "P3-086: mic is a real disabled placeholder (no transcribe cap)",
              mm?.rendered === true && mm.disabled === true && (mm.label ?? "").length > 0,
              mic.stdout,
            );
          }
          // (3) inline agent/model selector: opens upward, picks plan, persists
          run("P3-086: open the agent/model menu", ["click", ".composer-model-btn"], 15_000, localEnv);
          const menu = await waitProbe(
            "P3-086: menu rendered with agent options",
            "!!document.querySelector('.composer-menu .composer-menu-item[data-agent=\"plan\"]')",
            (v) => /true/.test(v),
            localEnv,
          );
          if (menu !== null) {
            run("P3-086: pick plan in the inline menu", ["click", '.composer-menu-item[data-agent="plan"]'], 15_000, localEnv);
            await waitProbe(
              "P3-086: trigger reflects the picked agent",
              "document.querySelector('.composer-model-label')?.textContent ?? 'MISS'",
              (v) => v.includes("plan"),
              localEnv,
            );
          }
          // (4) textarea: auto-grow clamps at ~6 lines and scrolls past it;
          // Shift+Enter keeps the draft, Enter sends (offline ⇒ optimistic clear).
          const growSet = run(
            "P3-086: paste 30 lines into the composer",
            ["ipc", `(() => {
              const ta = document.querySelector('.composer-text');
              if (!ta) return 'NO-TA';
              document.getElementById('p3-086-noanim')?.remove();
              const st = document.createElement('style');
              st.id = 'p3-086-noanim';
              st.textContent = '* { animation: none !important; transition: none !important; }';
              document.head.appendChild(st);
              const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
              setter.call(ta, Array.from({ length: 30 }, (_, i) => 'linha ' + i).join('\\n'));
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              return 'OK';
            })()`],
            15_000,
            localEnv,
          );
          if (growSet.ok && growSet.stdout.includes("OK")) {
            const grown = await waitProbe(
              "P3-086: auto-grow clamps the box past ~6 lines",
              "(() => { const ta = document.querySelector('.composer-text'); if (!ta) return { mounted: false }; const r = ta.getBoundingClientRect(); return { mounted: true, h: Math.round(r.height), scroll: ta.scrollHeight, client: ta.clientHeight }; })()",
              (v) => {
                try {
                  const m = JSON.parse(v) as { mounted: boolean; h: number };
                  return m.mounted && m.h >= 100;
                } catch {
                  return false;
                }
              },
              localEnv,
            );
            if (grown) {
              try {
                const m = JSON.parse(grown) as { h: number; scroll: number; client: number };
                check(
                  "P3-086: box grew from one line but stays clamped (~6 lines)",
                  m.h >= 100 && m.h <= 160,
                  grown,
                );
                check("P3-086: past the cap the textarea scrolls internally", m.scroll > m.client, grown);
              } catch {
                check("P3-086: auto-grow measurement parseable", false, grown);
              }
            }
            // restore a one-line draft for the Enter/Shift+Enter semantics check
            run("P3-086: reset the draft", ["type", ".composer-text", "linha1"], 15_000, localEnv);
            const shiftEnter = run(
              "P3-086: Shift+Enter does not send",
              ["ipc", `(() => {
                const ta = document.querySelector('.composer-text');
                if (!ta) return 'NO-TA';
                ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
                return ta.value;
              })()`],
              15_000,
              localEnv,
            );
            if (shiftEnter.ok) check("P3-086: Shift+Enter kept the draft (no send)", shiftEnter.stdout.includes("linha1"), shiftEnter.stdout);
            run(
              "P3-086: Enter sends",
              ["ipc", `(() => {
                const ta = document.querySelector('.composer-text');
                if (!ta) return 'NO-TA';
                ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                return 'OK';
              })()`],
              15_000,
              localEnv,
            );
            await waitProbe(
              "P3-086: Enter cleared the composer (send fired)",
              "document.querySelector('.composer-text')?.value ?? 'MOUNT-MISS'",
              (v) => v.trim() === '""',
              localEnv,
            );
            await waitProbe(
              "P3-086: offline send lands the optimistic bubble",
              "[...document.querySelectorAll('.msg.user')].some((m) => m.textContent?.includes('linha1'))",
              (v) => /true/.test(v),
              localEnv,
              6,
              500,
            );
            // evidence: the full composer state
            run("P3-086: composer evidence shot", ["shot", composerShot], 15_000, localEnv);
          }
        }

        // --- P3-087: motion pass — the reduced-motion kill switch ------------
        // Spec criterion: the gate records TWO screenshots, reduced off and
        // on, and the computed animation-name of a real animated element must
        // flip from msg-in/screen-in to none. The emulation goes through the
        // harness's `motion` command (Playwright emulateMedia), which drives
        // the exact CSS media query the global reduced-motion rule in
        // index.css listens on — the same kill switch users get from the OS.
        phase("P3-087: motion pass — reduced on/off evidence");
        // P1-080/P3-086 leave `animation: none !important` freeze styles in the
        // DOM for their measurements — remove them before probing real motion.
        const animExpr = "(() => { document.getElementById('p1-080-noanim')?.remove(); document.getElementById('p3-086-noanim')?.remove(); const el = document.querySelector('.messages .msg') ?? document.querySelector('.screen'); return el ? getComputedStyle(el).animationName : 'MISS'; })()";
        const animOn = run("P3-087: reduced off — animated element computed", ["ipc", animExpr], 15_000, localEnv);
        if (animOn.ok) {
          check(
            "P3-087: motion on — entrance animations live (msg-in|screen-in)",
            animOn.stdout.includes("msg-in") || animOn.stdout.includes("screen-in"),
            animOn.stdout,
          );
        }
        run("P3-087: reduced-OFF evidence shot", ["shot", join(shotsDir, "P3-087-motion-on-1440.png")], 15_000, localEnv);
        run("P3-087: emulate prefers-reduced-motion", ["motion", "reduce"], 15_000, localEnv);
        const animOff = run(
          "P3-087: reduced on — matchMedia + computed style",
          ["ipc", `window.matchMedia('(prefers-reduced-motion: reduce)').matches + '|' + (${animExpr})`],
          15_000,
          localEnv,
        );
        if (animOff.ok) {
          let raw = animOff.stdout.trim();
          try {
            raw = JSON.parse(raw) as string; // ipc results are JSON-encoded
          } catch {}
          const [mq, name] = raw.split("|");
          check(
            "P3-087: reduce matches and neutralizes every animation (name none)",
            mq === "true" && name === "none",
            animOff.stdout,
          );
        }
        run("P3-087: reduced-ON evidence shot", ["shot", join(shotsDir, "P3-087-motion-reduced-1440.png")], 15_000, localEnv);
        run("P3-087: restore motion preference", ["motion", "no-preference"], 15_000, localEnv);
        run("P3-087: 390 evidence shot", ["shot", join(shotsDir, "P3-087-motion-390.png"), "390", "844"], 15_000, localEnv);

        // --- P2-092: the Browser pane's guest view fills the pane ------------
        // The operator's repro: the <webview> element box was correct but the
        // Electron guest view painted only a top strip — the shadow root's
        // internal iframe has no height of its own and collapsed to its 150px
        // default while the page CSS forced display:block on the host. The
        // criterion: a colored test page loaded in the REAL pane occupies the
        // pane's bounding box (element AND guest viewport), and keeps
        // occupying it when the pane width changes (maximize toggle / window
        // resize — the P2-092 ResizeObserver path).
        const browserShot = join(shotsDir, "P2-092-browser-pane.png");
        const p2PortProbe = spawnSync(
          process.execPath,
          ["-e", "const s=require('node:http').createServer();s.listen(0,'127.0.0.1',()=>{console.log('PORT='+s.address().port);s.close()})"],
          { encoding: "utf8" },
        );
        const p2Port = Number((p2PortProbe.stdout.match(/PORT=(\d+)/) ?? [])[1]);
        check("P2-092: test page server picked a free port", Number.isInteger(p2Port) && p2Port > 0, p2PortProbe.stdout + p2PortProbe.stderr);
        if (Number.isInteger(p2Port) && p2Port > 0) {
          const p2Server = spawn(
            process.execPath,
            [
              "-e",
              [
                "const http = require('node:http');",
                "http.createServer((req, res) => {",
                "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
                "  res.end('<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>' +",
                "    '<body style=\"margin:0;background:#0e7c66\"><div style=\"position:fixed;inset:0;background:#0e7c66\"></div></body></html>');",
                `}).listen(${p2Port}, '127.0.0.1');`,
              ].join("\n"),
            ],
            { stdio: "ignore", detached: true },
          );
          p2Server.unref();
          try {
            // back to the desk layout (P1-088 left the window 390px wide)
            run("P2-092: resize to desktop width", ["shot", browserShot, "1440", "900"], 15_000, localEnv);
            await waitProbe(
              "P2-092: desk layout mounted",
              "!!document.querySelector('.desk')",
              (v) => /true/.test(v),
              localEnv,
            );
            run("P2-092: open Browser pane", ["menu-click", "go-pane-browser"], 15_000, localEnv);
            const wvMounted = await waitProbe(
              "P2-092: .browser-frame webview mounted",
              "!!document.querySelector('.browser-frame webview')",
              (v) => /true/.test(v),
              localEnv,
            );
            if (wvMounted) {
              const p2Measure = `(async () => {
                const frame = document.querySelector('.browser-frame');
                const wv = document.querySelector('.browser-frame webview');
                if (!frame || !wv) return null;
                const f = frame.getBoundingClientRect();
                const w = wv.getBoundingClientRect();
                const g = await wv.executeJavaScript('({ iw: window.innerWidth, ih: window.innerHeight })');
                return {
                  frame: { w: Math.round(f.width), h: Math.round(f.height) },
                  el: { w: Math.round(w.width), h: Math.round(w.height) },
                  guest: g,
                };
              })()`;
              const navExpr = `(async () => {
                const wv = document.querySelector('.browser-frame webview');
                wv.loadURL('http://127.0.0.1:${p2Port}/');
                await new Promise((resolve, reject) => {
                  const t = setTimeout(() => reject(new Error('load timeout')), 15000);
                  wv.addEventListener('did-stop-loading', () => { clearTimeout(t); resolve(); }, { once: true });
                });
                return 'OK';
              })()`;
              const loaded = run("P2-092: colored test page loads in the pane", ["ipc", navExpr], 25_000, localEnv);
              if (loaded.ok) {
                const base = run("P2-092: measure pane boxes", ["ipc", p2Measure], 15_000, localEnv);
                if (base.ok) {
                  const m = JSON.parse(base.stdout) as {
                    frame: { w: number; h: number };
                    el: { w: number; h: number };
                    guest: { iw: number; ih: number };
                  } | null;
                  console.log("     P2-092 measurements (baseline):", base.stdout.trim());
                  check(
                    "P2-092: webview element occupies the pane bounding box",
                    !!m && m.frame.w > 0 &&
                      Math.abs(m.el.w - m.frame.w) <= 1 && Math.abs(m.el.h - m.frame.h) <= 1,
                    base.stdout,
                  );
                  check(
                    "P2-092: guest viewport fills the pane (no top strip)",
                    !!m && m.frame.w > 0 &&
                      Math.abs(m.guest.iw - m.frame.w) <= 2 && Math.abs(m.guest.ih - m.frame.h) <= 2,
                    base.stdout,
                  );
                }
                // pane width change #1: maximize toggle (36vw → 80vw) — the
                // guest must track the wider box without a remount
                run("P2-092: maximize the pane", ["click", 'button[title="Maximizar painel"]'], 15_000, localEnv);
                const maxed = run("P2-092: measure pane boxes (maximized)", ["ipc", p2Measure], 15_000, localEnv);
                if (maxed.ok) {
                  const m = JSON.parse(maxed.stdout) as {
                    frame: { w: number; h: number };
                    el: { w: number; h: number };
                    guest: { iw: number; ih: number };
                  } | null;
                  console.log("     P2-092 measurements (maximized):", maxed.stdout.trim());
                  check(
                    "P2-092: guest tracks the pane after a width change (resize path)",
                    !!m && m.frame.w > 0 &&
                      Math.abs(m.guest.iw - m.frame.w) <= 2 && Math.abs(m.guest.ih - m.frame.h) <= 2,
                    maxed.stdout,
                  );
                }
                run("P2-092: restore the pane", ["click", 'button[title="Restaurar painel"]'], 15_000, localEnv);
                // evidence: the colored page filling the whole pane
                run("P2-092: pane-filled evidence shot", ["shot", browserShot], 15_000, localEnv);
              }
            }
          } finally {
            p2Server.kill();
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
          // P2-108: exactly ONE degradation banner — the shell strip must not
          // be doubled by the in-chat .conn-banner.
          const bannerCount = run("local: banner count probe", ["ipc", "String(document.querySelectorAll('.daemon-reconnecting, .daemon-down, .conn-banner').length)"], 15_000, localEnv);
          if (bannerCount.ok) check("P2-108: daemon falling renders a single banner", bannerCount.stdout.replace(/"/g, "").trim() === "1", bannerCount.stdout);
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
          "let armPerm = false;",
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
          "  const nowMs = Date.now();",
          "  const yesterdayNoon = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1, 12, 0, 0, 0).getTime();",
          "  const recency = [",
          "    { id: 'ses-recency-today', title: 'Sync de hoje', time: { updated: nowMs - 5 * 60 * 1000 } },",
          "    { id: 'ses-recency-yesterday', title: 'Rascunho de ontem', time: { updated: yesterdayNoon } },",
          "    { id: 'ses-recency-earlier', title: 'Setup antigo', time: { updated: nowMs - 10 * 24 * 3600 * 1000 } },",
          "  ];",
          "  if (u.pathname === '/session') return json([...recency, { id: 'ses-reentry-check', title: 'Reentry check' }, { id: 'ses-draft-a', title: 'Draft A' }, { id: 'ses-artifact-auto', title: 'Artifact auto' }, { id: 'ses-autofail', title: 'Auto fail' }]);",
          "  if (u.pathname === '/session/ses-reentry-check' || u.pathname === '/session/ses-draft-a' || u.pathname === '/session/ses-artifact-auto' || u.pathname === '/session/ses-autofail' || u.pathname === '/session/ses-thinking') return json({ id: u.pathname.split('/')[2], title: 'P1-089' });",
          "  if (u.pathname === '/session/ses-autofail/permissions/perm-fail') { res.writeHead(500); res.end('auto-approve always rejected'); return; }",
          "  if (/^\\/session\\/ses-thinking\\/message$/.test(u.pathname)) { const t = ROWS.slice(); t[5] = { info: t[5].info, parts: [{ type: 'reasoning', text: 'Raciocinio persistido no historico.' }, ...(t[5].parts ?? [])] }; return json(t); }",
          "  if (/^\\/session\\/[^/]+\\/message$/.test(u.pathname)) return req.method === 'POST' ? json({ id: 'msg-fake' }) : json(ROWS);",
          "  if (u.pathname === '/__arm-perm') { armPerm = req.method === 'POST'; return json({ armed: armPerm }); }",
          "  if (u.pathname === '/permission') return json(armPerm ? [{ id: 'perm-fail', sessionID: 'ses-autofail', permission: 'bash' }] : []);",
          "  if (u.pathname === '/question') return json([]);",
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
    // P2-148: this boot mints a fresh userData too — the first-run welcome
    // covers the chat until skipped.
    run("P1-089: skip the first-run welcome", ["click", ".welcome-skip"], 15_000, localEnv2);
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

          // --- P2-090: artifact auto-open on idle --------------------------------
          // The exact operator repro: the agent writes index.html into the
          // session's artifacts dir and the turn goes idle — the split-pane
          // must open by itself, without overriding the user's choices (a
          // closed pane, and the browser pane keep priority). The daemon here
          // is the REAL hermetic daemon watching its own HOME artifacts root,
          // so session.artifact flows through the full watcher→SSE→E2E path.
          phase("P2-090: artifact auto-open on idle");
          const AUTO_SES = "ses-artifact-auto";
          const artDir = join(daemonHome2, ".opencode-remote", "artifacts", AUTO_SES);
          const resized = run(
            "P2-090: resize to desktop width",
            ["shot", join(shotsDir, "P2-090-resize.png"), "1440", "900"],
            15_000,
            localEnv2,
          );
          if (resized.ok) {
            await waitProbe("P2-090: desk chat remounted at 1440px", "!!document.querySelector('.messages')", (v) => /true/.test(v), localEnv2);
            run("P2-090: open the artifact session", ["ipc", `location.hash = '#/session/${AUTO_SES}'`], 15_000, localEnv2);
            await waitProbe("P2-090: session chat rendered without the pane", "!!document.querySelector('.artifact-pane')", (v) => /false/.test(v), localEnv2);
            mkdirSync(artDir, { recursive: true });
            writeFileSync(join(artDir, "index.html"), `<!doctype html><html><body><h1 id="p2-090">P2-090 artifact</h1></body></html>`);
            await new Promise((r) => setTimeout(r, 1_000)); // watcher settle
            await fetch(`${fakeUrl}/__emit`, {
              method: "POST",
              body: JSON.stringify([{ type: "session.idle", properties: { sessionID: AUTO_SES } }]),
            });
            const opened = await waitProbe(
              "P2-090: split-pane opened by itself on idle",
              "!!document.querySelector('.artifact-pane')",
              (v) => /true/.test(v),
              localEnv2,
            );
            if (opened) {
              const render = run("P2-090: pane renders the artifact", ["ipc", "document.querySelector('.artifact-pane')?.textContent ?? ''"], 15_000, localEnv2);
              if (render.ok) check("P2-090: pane shows index.html", /index\.html/.test(render.stdout), render.stdout);
              run("P2-090: auto-open evidence shot", ["shot", join(shotsDir, "P2-090-auto-pane-1440.png"), "1440", "900"], 15_000, localEnv2);
            }
            // manual choice wins: closing the pane keeps it closed on the next
            // idle, even though the artifact changed again
            run("P2-090: user closes the auto pane", ["click", '.artifact-pane button[aria-label="Close"]'], 15_000, localEnv2);
            const closed = await waitProbe("P2-090: pane closed by the user", "!!document.querySelector('.artifact-pane')", (v) => /false/.test(v), localEnv2);
            if (closed) {
              writeFileSync(join(artDir, "index.html"), "<h1>v2</h1>");
              await new Promise((r) => setTimeout(r, 1_000));
              await fetch(`${fakeUrl}/__emit`, {
                method: "POST",
                body: JSON.stringify([{ type: "session.idle", properties: { sessionID: AUTO_SES } }]),
              });
              await new Promise((r) => setTimeout(r, 1_500));
              const stillClosed = run("P2-090: closed pane not overridden by idle", ["ipc", "!!document.querySelector('.artifact-pane')"], 15_000, localEnv2);
              if (stillClosed.ok) check("P2-090: manual close survives the next idle", /false/.test(stillClosed.stdout));
            }
            // browser priority: with the Browser pane up (P1-072 auto-open
            // path), a fresh artifact + idle must not raise the artifact pane
            await fetch(`${fakeUrl}/__emit`, {
              method: "POST",
              body: JSON.stringify([{ type: "ocr.preview", properties: { sessionID: AUTO_SES, url: "http://127.0.0.1:1/p2-090" } }]),
            });
            const browserUp = await waitProbe(
              "P2-090: browser pane opened (preview priority)",
              "document.querySelector('button[data-pane=\"browser\"]')?.classList.contains('active')",
              (v) => /true/.test(v),
              localEnv2,
            );
            if (browserUp) {
              writeFileSync(join(artDir, "second.md"), "# second");
              await new Promise((r) => setTimeout(r, 1_000));
              await fetch(`${fakeUrl}/__emit`, {
                method: "POST",
                body: JSON.stringify([{ type: "session.idle", properties: { sessionID: AUTO_SES } }]),
              });
              await new Promise((r) => setTimeout(r, 1_500));
              const suppressed = run("P2-090: artifact pane suppressed while browser is up", ["ipc", "!!document.querySelector('.artifact-pane')"], 15_000, localEnv2);
              if (suppressed.ok) check("P2-090: browser keeps priority over the artifact pane", /false/.test(suppressed.stdout));
              const browserStill = run("P2-090: browser pane untouched", ["ipc", "document.querySelector('button[data-pane=\"browser\"]')?.classList.contains('active')"], 15_000, localEnv2);
              if (browserStill.ok) check("P2-090: browser pane was not overridden either", /true/.test(browserStill.stdout));
              // evidence shots: 1440x900 (desktop, browser pane up) + 390 mobile
              run("P2-090: 390 evidence shot", ["shot", join(shotsDir, "P2-090-auto-pane-390.png"), "390", "844"], 15_000, localEnv2);
            }
          }

          // --- P2-091: artifact navigation — card/list/pane without context swap --
          // The operator's bug: clicking the artifact card surfaced the full-screen
          // Artifacts tab and a list item opened a full-screen viewer instead of
          // the side-by-side pane. Repro over the real UI: card click → split-pane
          // beside the chat; list opens in the rail pane; a list click jumps back
          // to Conversas with the split-pane; list groups carry the conversation
          // title (daemon resolves id→title against the fake backend).
          phase("P2-091: artifact navigation (card + list → split-pane)");
          const navWide = run(
            "P2-091: resize to desktop width",
            ["shot", join(shotsDir, "P2-091-resize.png"), "1440", "900"],
            15_000,
            localEnv2,
          );
          if (navWide.ok) {
            await waitProbe("P2-091: chat remounted at 1440px", "!!document.querySelector('.messages')", (v) => /true/.test(v), localEnv2);
            run("P2-091: open the artifact session", ["ipc", `location.hash = '#/session/${AUTO_SES}'`], 15_000, localEnv2);
            await waitProbe("P2-091: session chat rendered", "!!document.querySelector('.messages')", (v) => /true/.test(v), localEnv2);
            // an assistant bubble mentioning the artifact renders its card
            await fetch(`${fakeUrl}/__emit`, {
              method: "POST",
              body: JSON.stringify([
                {
                  type: "message.part.updated",
                  properties: { sessionID: AUTO_SES, part: { type: "text", text: "Relatório pronto: index.html", messageID: "msg-p2-091" } },
                },
              ]),
            });
            await fetch(`${fakeUrl}/__emit`, {
              method: "POST",
              body: JSON.stringify([{ type: "session.idle", properties: { sessionID: AUTO_SES } }]),
            });
            const card = await waitProbe(
              "P2-091: artifact card rendered under the bubble",
              "!!document.querySelector('.artifact-card')",
              (v) => /true/.test(v),
              localEnv2,
            );
            if (card) {
              run("P2-091: click the artifact card", ["click", ".artifact-card"], 15_000, localEnv2);
              const split = await waitProbe(
                "P2-091: card opens the split-pane beside the chat",
                "!!document.querySelector('.artifact-pane') && !!document.querySelector('.messages')",
                (v) => /true/.test(v),
                localEnv2,
              );
              if (split) {
                run("P2-091: card→split evidence shot", ["shot", join(shotsDir, "P2-091-card-split-1440.png"), "1440", "900"], 15_000, localEnv2);
                // the list lives in the rail pane — never a full-screen tab
                run("P2-091: open the artifacts list", ["click", 'button[data-pane="artifacts"]'], 15_000, localEnv2);
                await waitProbe(
                  "P2-091: list groups by conversation title (no raw session id)",
                  "document.querySelector('.artifact-group')?.textContent ?? ''",
                  (v) => v.includes("Artifact auto") && !v.includes(AUTO_SES),
                  localEnv2,
                );
                run("P2-091: click the artifact in the list", ["click", '.artifact-row:has-text("index.html")'], 15_000, localEnv2);
                const backToChat = await waitProbe(
                  "P2-091: list item → Conversas with the split-pane (no full-screen detour)",
                  "!!document.querySelector('.artifact-pane') && !!document.querySelector('.messages') && !document.querySelector('button[data-pane=\"artifacts\"]')?.classList.contains('active')",
                  (v) => /true/.test(v),
                  localEnv2,
                );
                if (backToChat) {
                  run("P2-091: list→split evidence shot", ["shot", join(shotsDir, "P2-091-list-split-1440.png"), "1440", "900"], 15_000, localEnv2);
                  // fix 4: the viewer's back arrow returns to the chat context
                  run("P2-091: viewer back arrow closes the pane", ["click", '.artifact-pane button[aria-label="Close"]'], 15_000, localEnv2);
                  await waitProbe(
                    "P2-091: pane closed, chat stays",
                    "!!document.querySelector('.artifact-pane')",
                    (v) => /false/.test(v),
                    localEnv2,
                  );
                }
              }
              // narrow viewport keeps the list on the full-screen overlay path
              run("P2-091: 390 evidence shot", ["shot", join(shotsDir, "P2-091-nav-390.png"), "390", "844"], 15_000, localEnv2);
            }
          }

          // --- P3-084: conversation list at benchmark level ----------------------
          // Temporal grouping (Hoje/Ontem/Anteriores) in the REAL sidebar, the
          // hover action affordances, the sharp active row and the ⌘K switcher
          // showing a last-message preview line. The fake backend now serves
          // sessions with time.updated (today / yesterday / 10 days ago) and a
          // message.part.updated is emitted so the preview map has data.
          phase("P3-084: sidebar grouping + Cmd+K preview");
          const p3Wide = run("P3-084: resize to desktop width", ["shot", join(shotsDir, "P3-084-resize.png"), "1440", "900"], 15_000, localEnv2);
          if (p3Wide.ok) {
            await waitProbe(
              "P3-084: sidebar rows mounted",
              "!!document.querySelector('.sess-rows')",
              (v) => /true/.test(v),
              localEnv2,
            );
            await fetch(`${fakeUrl}/__emit`, {
              method: "POST",
              body: JSON.stringify([
                { type: "message.part.updated", properties: { sessionID: "ses-recency-today", part: { type: "text", text: "P3-084 preview marker — relatório pronto" } } },
                { type: "session.idle", properties: { sessionID: "ses-recency-today" } },
              ]),
            });
            // grouping: exactly the three temporal heads, in order. ipc results
            // are JSON-encoded (strings come back quoted) — parse once.
            const groupProbe = await waitProbe(
              "P3-084: Hoje/Ontem/Anteriores heads rendered in order",
              "[...document.querySelectorAll('.sess-group-head[data-group]')].map((el) => el.getAttribute('data-group')).join(',')",
              (v) => {
                let s = v.trim();
                try {
                  s = JSON.parse(s) as string;
                } catch {}
                return s === "today,yesterday,earlier";
              },
              localEnv2,
            );
            if (groupProbe) {
              // hover action affordances exist on the rows (reveal is CSS)
              const affordance = run("P3-084: row hover actions present", ["ipc", "document.querySelectorAll('.sess-row .row-rename').length > 0 && document.querySelectorAll('.sess-row .row-archive').length > 0"], 15_000, localEnv2);
              if (affordance.ok) {
                check("P3-084: rename + archive buttons rendered on rows", /true/.test(affordance.stdout));
              }
              // sharp active state: deep-link opens the today conversation and
              // marks its row with .active + aria-current
              run("P3-084: open the today conversation", ["ipc", "location.hash = '#/session/ses-recency-today'"], 15_000, localEnv2);
              const activeRow = await waitProbe(
                "P3-084: active row is the open conversation",
                "document.querySelector('.sess-row.active .sess-title')?.textContent ?? 'MISS'",
                (v) => v.includes("Sync de hoje"),
                localEnv2,
              );
              if (activeRow) {
                const aria = run("P3-084: active row carries aria-current", ["ipc", "document.querySelector('.sess-row.active')?.getAttribute('aria-current')"], 15_000, localEnv2);
                if (aria.ok) check("P3-084: aria-current=true on the active row", /true/.test(aria.stdout));
                run("P3-084: grouped sidebar evidence shot", ["shot", join(shotsDir, "P3-084-groups-1440.png")], 15_000, localEnv2);
              }
              // Cmd+K switcher with last-message preview
              run("P3-084: open the palette via the Go menu", ["menu-click", "go-palette"], 15_000, localEnv2);
              const paletteUp = await waitProbe(
                "P3-084: palette rendered",
                "!!document.querySelector('.palette')",
                (v) => /true/.test(v),
                localEnv2,
              );
              if (paletteUp) {
                const previewLine = await waitProbe(
                  "P3-084: preview line shows the last message",
                  "[...document.querySelectorAll('.palette-item')].some((el) => (el.textContent || '').includes('P3-084 preview marker'))",
                  (v) => /true/.test(v),
                  localEnv2,
                );
                if (previewLine) {
                  const sub = run("P3-084: .palette-sub element rendered", ["ipc", "!!document.querySelector('.palette-sub')"], 15_000, localEnv2);
                  if (sub.ok) check("P3-084: preview sits on its own muted line", /true/.test(sub.stdout));
                  run("P3-084: palette evidence shot", ["shot", join(shotsDir, "P3-084-palette-1440.png")], 15_000, localEnv2);
                }
                run("P3-084: close the palette (Escape)", ["ipc", "document.querySelector('.palette-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"], 15_000, localEnv2);
                await waitProbe(
                  "P3-084: palette closed by Escape",
                  "!!document.querySelector('.palette')",
                  (v) => /false/.test(v),
                  localEnv2,
                );
              }
            }
            run("P3-084: 390 evidence shot", ["shot", join(shotsDir, "P3-084-390.png"), "390", "844"], 15_000, localEnv2);
            // restore the session context: the following beats emit events for
            // AUTO_SES and expect its chat on screen after their resize
            run("P3-084: return to the artifact session", ["ipc", `location.hash = '#/session/${AUTO_SES}'`], 15_000, localEnv2);
            await waitProbe("P3-084: artifact session chat rendered again", "!!document.querySelector('.messages')", (v) => /true/.test(v), localEnv2);
          }

          // --- P2-124: Claude-level sidebar shell --------------------------------
          // "+ New" pinned to the top of a 280px column, section nav above the
          // list (SVG icons only — zero emoji/glyphs), temporal groups intact
          // and a fixed account footer that opens the machine picker. Runs at
          // 1440x900 right after the P3-084 beat, then drops to 390 for the
          // narrow evidence shot.
          phase("P2-124: sidebar shell (new + nav + account footer)");
          // the beat opens right after P3-084's narrow shot — resize back up
          const p124Wide = run("P2-124: resize to desktop width", ["shot", join(shotsDir, "P2-124-resize.png"), "1440", "900"], 15_000, localEnv2);
          if (p124Wide.ok) {
            await waitProbe("P2-124: desktop shell mounted", "!!document.querySelector('.desk-side')", (v) => /true/.test(v), localEnv2);
            const sideW = run("P2-124: sidebar column width", ["ipc", "document.querySelector('.desk-side')?.getBoundingClientRect().width ?? 0"], 15_000, localEnv2);
            if (sideW.ok) check("P2-124: sidebar is 280px wide", Math.round(parseFloat(sideW.stdout)) === 280, sideW.stdout);
            const navProbe = run(
              "P2-124: section nav shape",
              ["ipc", "(() => { const btns = [...document.querySelectorAll('.desk-nav button[data-pane]')]; return btns.length === 6 && btns.every((b) => b.querySelector(':scope > svg')); })()"],
              15_000,
              localEnv2,
            );
            if (navProbe.ok) check("P2-124: 6 nav buttons, each with an SVG icon", /true/.test(navProbe.stdout), navProbe.stdout);
            const emojiProbe = run(
              "P2-124: zero emoji/glyphs in the sidebar",
              ["ipc", "!(/\\p{Extended_Pictographic}|[▾⌄✎↩✕]/u.test(document.querySelector('.desk-side').textContent))"],
              15_000,
              localEnv2,
            );
            if (emojiProbe.ok) check("P2-124: sidebar copy is glyph-free", /true/.test(emojiProbe.stdout), emojiProbe.stdout);
            const orderProbe = run(
              "P2-124: new button → nav → list order",
              ["ipc", "(() => { const a = document.querySelector('.desk-new'), b = document.querySelector('.desk-nav'), c = document.querySelector('.sess-rows'); if (!a || !b || !c) return 'missing'; const after = (x, y) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; return after(a, b) && after(b, c); })()"],
              15_000,
              localEnv2,
            );
            if (orderProbe.ok) check("P2-124: .desk-new precedes .desk-nav precedes .sess-rows", /true/.test(orderProbe.stdout), orderProbe.stdout);
            const fillProbe = run(
              "P2-124: + New spans the column",
              ["ipc", "(() => { const top = document.querySelector('.desk-side-top'); const nw = document.querySelector('.desk-new').getBoundingClientRect().width; const cs = getComputedStyle(top); const inner = top.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); return nw >= inner - 2; })()"],
              15_000,
              localEnv2,
            );
            if (fillProbe.ok) check("P2-124: .desk-new fills the column (±2px)", /true/.test(fillProbe.stdout), fillProbe.stdout);
            const accountProbe = run(
              "P2-124: account footer contents",
              ["ipc", "(() => { const f = document.querySelector('.desk-account'); if (!f) return null; const name = f.querySelector('.desk-account-name')?.textContent ?? ''; const plan = f.querySelector('.desk-account-plan')?.textContent ?? ''; return { name, plan }; })()"],
              15_000,
              localEnv2,
            );
            if (accountProbe.ok) {
              let acct: { name?: string; plan?: string } | null = null;
              try {
                acct = JSON.parse(accountProbe.stdout) as { name?: string; plan?: string };
              } catch {}
              check("P2-124: footer name matches the machine name", acct?.name === "local", accountProbe.stdout);
              check("P2-124: footer plan names the connection mode", /Local|Remoto|Remote/.test(acct?.plan ?? ""), accountProbe.stdout);
            }
            run("P2-124: open the machine picker from the footer", ["click", ".desk-account-btn"], 15_000, localEnv2);
            const pickerUp = await waitProbe("P2-124: machine picker rendered", "!!document.querySelector('.machine-picker')", (v) => /true/.test(v), localEnv2);
            if (pickerUp) {
              run("P2-124: close the machine picker", ["click", '.machine-picker button[aria-label="Close machine picker"]'], 15_000, localEnv2);
              await waitProbe("P2-124: machine picker closed", "!!document.querySelector('.machine-picker')", (v) => /false/.test(v), localEnv2);
            }
            const groupsSurvive = run(
              "P2-124: list + temporal groups intact after the picker",
              ["ipc", "[...document.querySelectorAll('.sess-group-head[data-group]')].map((el) => el.getAttribute('data-group')).join(',')"],
              15_000,
              localEnv2,
            );
            if (groupsSurvive.ok) {
              let g = groupsSurvive.stdout.trim();
              try {
                g = JSON.parse(g) as string;
              } catch {}
              check("P2-124: today,yesterday,earlier heads survive", g === "today,yesterday,earlier", groupsSurvive.stdout);
            }
            run("P2-124: sidebar shell evidence shot", ["shot", join(shotsDir, "P2-124-sidebar-1440.png")], 15_000, localEnv2);
            run("P2-124: narrow evidence shot", ["shot", join(shotsDir, "P2-124-sidebar-390.png"), "390", "844"], 15_000, localEnv2);

            // --- P2-108: quiet chrome — filter menu at desktop width ------------
            // The narrow shot above dropped the window to 390 (sidebar unmounted);
            // resize back up so the sidebar search row is mounted again.
            const p108Wide = run("P2-108: sidebar with search row evidence shot", ["shot", join(shotsDir, "P2-108-sidebar-1440.png"), "1440", "900"], 15_000, localEnv2);
            if (p108Wide.ok) {
              const filterOpen = run("P2-108: open the search filter menu", ["click", ".sess-filter-btn"], 15_000, localEnv2);
              if (filterOpen.ok) {
                const menuProbe = run(
                  "P2-108: filter menu shape",
                  ["ipc", "(() => { const items = [...document.querySelectorAll('.sess-filter-menu [data-filter]')]; return items.length === 3 && items.every((b) => b.textContent.trim().length > 0); })()"],
                  15_000,
                  localEnv2,
                );
                if (menuProbe.ok) check("P2-108: filter menu carries 3 options", /true/.test(menuProbe.stdout), menuProbe.stdout);
                run("P2-108: filter menu evidence shot", ["shot", join(shotsDir, "P2-108-filter-1440.png")], 15_000, localEnv2);
                run("P2-108: close the filter menu", ["click", ".sess-menu-scrim"], 15_000, localEnv2);
              }
            }
          }

          // --- P3-085: collapsible thinking block + streaming polish -----------
          // Simulated long response over the fake backend: reasoning parts
          // stream into the "Pensou por Xs" block (expanded while thinking,
          // collapsed once the answer starts), the streaming caret shows in
          // the live bubble, scrolling away raises the floating jump-end pill
          // and the follow-tail autoscroll never fights the reader.
          phase("P3-085: thinking block + streaming polish");
          const THINK_SES = "ses-thinking";
          const thinkWide = run(
            "P3-085: resize to desktop width",
            ["shot", join(shotsDir, "P3-085-resize.png"), "1440", "900"],
            15_000,
            localEnv2,
          );
          if (thinkWide.ok) {
            await waitProbe(
              "P3-085: chat remounted at 1440px",
              "!!document.querySelector('.messages')",
              (v) => /true/.test(v),
              localEnv2,
            );
            run("P3-085: open the thinking session", ["ipc", `location.hash = '#/session/${THINK_SES}'`], 15_000, localEnv2);
            await waitProbe(
              "P3-085: session chat rendered",
              "!!document.querySelector('.messages')",
              (v) => /true/.test(v),
              localEnv2,
            );
            const emit = (events: unknown[]) =>
              fetch(`${fakeUrl}/__emit`, { method: "POST", body: JSON.stringify(events) });
            // beat 1 — reasoning only: the block renders EXPANDED while the
            // model is still thinking and no answer text has arrived
            await emit([
              { type: "message.updated", properties: { sessionID: THINK_SES, info: { id: "msg-think", role: "assistant" } } },
              { type: "message.part.updated", properties: { sessionID: THINK_SES, part: { type: "reasoning", text: "Primeiro vou estruturar a resposta…", messageID: "msg-think" } } },
            ]);
            const openWhileThinking = await waitProbe(
              "P3-085: thinking block expanded while streaming reasoning",
              // the live block is the LAST .thinking in document order (the
              // fake's history row also renders a collapsed block)
              "[...document.querySelectorAll('.thinking-head')].pop()?.getAttribute('aria-expanded') ?? 'MISS'",
              (v) => v.trim() === '"true"',
              localEnv2,
            );
            if (openWhileThinking) {
              const headLabel = await waitProbe(
                "P3-085: live thinking label rendered",
                "[...document.querySelectorAll('.thinking-head')].pop()?.textContent ?? ''",
                (v) => /Pensando|Thinking/.test(v),
                localEnv2,
              );
              if (headLabel) {
                // beat 2 — the answer starts: the block collapses to
                // "Pensou por Xs" and the streaming caret shows on the tail
                const longLine = "detalhe do raciocínio e da resposta — ";
                await emit([
                  { type: "message.part.updated", properties: { sessionID: THINK_SES, part: { type: "reasoning", text: "Pensando: passo 1, passo 2, passo 3.", messageID: "msg-think" } } },
                  { type: "message.part.updated", properties: { sessionID: THINK_SES, part: { type: "text", text: `Resposta longa simulada.\n\n${longLine.repeat(40)}`, messageID: "msg-think" } } },
                ]);
                const collapsed = await waitProbe(
                  "P3-085: block collapses to 'Pensou por Xs' when the answer starts",
                  "(() => { const h = [...document.querySelectorAll('.thinking-head')].pop(); return h?.getAttribute('aria-expanded') + '|' + (h?.textContent ?? ''); })()",
                  (v) => {
                    const s = JSON.parse(v.trim());
                    return s === "false|" || /^false\|Pensou por \d+s$/.test(s) || /^false\|Thought for \d+s$/.test(s);
                  },
                  localEnv2,
                );
                if (collapsed) {
                  const caret = await waitProbe(
                    "P3-085: streaming caret visible in the live bubble",
                    "!!document.querySelector('.messages .msg.assistant .caret')",
                    (v) => /true/.test(v),
                    localEnv2,
                  );
                  if (caret) {
                    // beat 3 — scroll away: floating jump-end appears, the
                    // follow-tail autoscroll must NOT yank the reader back
                    await emit([
                      { type: "message.part.updated", properties: { sessionID: THINK_SES, part: { type: "text", text: `Resposta longa simulada.\n\n${longLine.repeat(120)}`, messageID: "msg-think" } } },
                    ]);
                    await waitProbe(
                      "P3-085: long response overflows the viewport",
                      "document.querySelector('.messages')?.scrollHeight",
                      (v) => Number(v) > 1200,
                      localEnv2,
                    );
                    await run(
                      "P3-085: reader scrolls away from the tail",
                      ["ipc", "(() => { const m = document.querySelector('.messages'); m.scrollTop = 0; m.dispatchEvent(new Event('scroll')); return m.scrollTop; })()"],
                      15_000,
                      localEnv2,
                    );
                    const pill = await waitProbe(
                      "P3-085: floating jump-end pill appears",
                      "!!document.querySelector('.jump-end')",
                      (v) => /true/.test(v),
                      localEnv2,
                    );
                    if (pill) {
                      await emit([
                        { type: "message.part.updated", properties: { sessionID: THINK_SES, part: { type: "text", text: `Resposta longa simulada.\n\n${longLine.repeat(200)}`, messageID: "msg-think" } } },
                      ]);
                      await new Promise((r) => setTimeout(r, 1_200));
                      const stayed = await run(
                        "P3-085: autoscroll does not fight the reader",
                        ["ipc", "(() => { const m = document.querySelector('.messages'); return m.scrollHeight - m.scrollTop - m.clientHeight; })()"],
                        15_000,
                        localEnv2,
                      );
                      if (stayed.ok) {
                        const dist = Number(JSON.parse(stayed.stdout.trim()));
                        check("P3-085: scroll stays put while the tail grows (far from tail)", Number.isFinite(dist) && dist > 200, stayed.stdout);
                      }
                      run("P3-085: click jump-end", ["click", ".jump-end"], 15_000, localEnv2);
                      await waitProbe(
                        "P3-085: jump returns to the tail (pill gone)",
                        "!!document.querySelector('.jump-end')",
                        (v) => /false/.test(v),
                        localEnv2,
                      );
                    }
                  }
                  // beat 4 — idle finalizes: caret gone, block stays collapsed
                  // with the frozen duration; clicking re-opens the reasoning
                  await emit([{ type: "session.idle", properties: { sessionID: THINK_SES } }]);
                  await waitProbe(
                    "P3-085: caret gone after idle",
                    "!!document.querySelector('.messages .caret')",
                    (v) => /false/.test(v),
                    localEnv2,
                  );
                  run("P3-085: click the collapsed thinking head", ["ipc", "[...document.querySelectorAll('.thinking-head')].pop()?.click(); 'clicked'"], 15_000, localEnv2);
                  const reopened = await waitProbe(
                    "P3-085: click expands the reasoning text",
                    "(() => { const b = [...document.querySelectorAll('.thinking')].pop(); return b?.className + '|' + !!b?.querySelector('.thinking-inner'); })()",
                    (v) => {
                      const s = JSON.parse(v.trim());
                      return s.startsWith("thinking open|true");
                    },
                    localEnv2,
                  );
                  if (reopened) {
                    run("P3-085: 1440 evidence shot", ["shot", join(shotsDir, "P3-085-thinking-1440.png"), "1440", "900"], 15_000, localEnv2);
                    run("P3-085: 390 evidence shot", ["shot", join(shotsDir, "P3-085-thinking-390.png"), "390", "844"], 15_000, localEnv2);
                    // the resize remounts the chat and refetches history — the
                    // reasoning part served by the fake must render as a
                    // COLLAPSED thinking block (history path, no timing)
                    await waitProbe("P3-085: chat remounted at 390px", "!!document.querySelector('.messages')", (v) => /true/.test(v), localEnv2);
                    await waitProbe(
                      "P3-085: thinking block from history starts collapsed",
                      "document.querySelector('.thinking-head')?.getAttribute('aria-expanded') ?? 'MISS'",
                      (v) => v.trim() === '"false"',
                      localEnv2,
                    );
                  }
                }
              }
            }
            // restore the session context: the following beats emit events for
            // AUTO_SES and expect its chat on screen after their resize
            run("P3-085: return to the artifact session", ["ipc", `location.hash = '#/session/${AUTO_SES}'`], 15_000, localEnv2);
            await waitProbe("P3-085: artifact session chat rendered again", "!!document.querySelector('.messages')", (v) => /true/.test(v), localEnv2);
          }

          // --- P2-097: oversized artifact shows the friendly 413 error ----------
          // The daemon refuses reads above MAX_ARTIFACT_BYTES (5 MB) with HTTP
          // 413 — the viewer must show an actionable note (and hide the header
          // Save, which would otherwise write an empty file) instead of
          // hanging or OOM-ing the tunnel with a multi-MB base64 blob.
          phase("P2-097: oversized artifact shows a friendly 413 error");
          // P2-091 leaves the window at 390px — back to desktop width so the
          // card opens the split-pane (.artifact-pane), not the overlay
          const bigWide = run("P2-097: resize to desktop width", ["shot", join(shotsDir, "P2-097-resize.png"), "1440", "900"], 15_000, localEnv2);
          if (bigWide.ok) {
            await waitProbe("P2-097: chat remounted at 1440px", "!!document.querySelector('.messages')", (v) => /true/.test(v), localEnv2);
            writeFileSync(join(artDir, "big.txt"), Buffer.alloc(5_000_001, 0x61));
            await fetch(`${fakeUrl}/__emit`, {
              method: "POST",
              body: JSON.stringify([
                {
                  type: "message.part.updated",
                  properties: { sessionID: AUTO_SES, part: { type: "text", text: "Enorme: big.txt", messageID: "msg-p2-097" } },
                },
              ]),
            });
            await fetch(`${fakeUrl}/__emit`, {
              method: "POST",
              body: JSON.stringify([{ type: "session.idle", properties: { sessionID: AUTO_SES } }]),
            });
            const bigCard = await waitProbe(
              "P2-097: artifact card rendered for big.txt",
              "[...document.querySelectorAll('.artifact-card')].some((c) => (c.textContent ?? '').includes('big.txt'))",
              (v) => /true/.test(v),
              localEnv2,
              6,
              500,
            );
            if (bigCard) {
              run("P2-097: click the big.txt card", ["click", '.artifact-card:has-text("big.txt")'], 15_000, localEnv2);
              const errUp = await waitProbe(
                "P2-097: pane shows the friendly too-large error",
                "document.querySelector('.artifact-pane')?.textContent ?? ''",
                (v) => /too large to preview/i.test(v),
                localEnv2,
                8,
                500,
              );
              if (errUp) {
                const noSave = run("P2-097: header Save hidden for refused bytes", ["ipc", "!!document.querySelector('.artifact-pane button.primary')"], 15_000, localEnv2);
                if (noSave.ok) check("P2-097: Save is hidden (no empty-file save)", /false/.test(noSave.stdout));
                run("P2-097: 1440 evidence shot", ["shot", join(shotsDir, "P2-097-413-1440.png"), "1440", "900"], 15_000, localEnv2);
                run("P2-097: 390 evidence shot", ["shot", join(shotsDir, "P2-097-413-390.png"), "390", "844"], 15_000, localEnv2);
              }
            }
          }

          // --- P1-093: AutoMode failure is never silent -------------------------
          // With AutoMode on, the daemon answers permission asks on the user's
          // behalf; when opencode rejects the answer the ask used to stall
          // invisibly. The beat: enable AutoMode through the real Settings UI,
          // ask for a permission the fake backend always rejects, and require
          // (1) the red composer note, (2) an actionable card despite AutoMode,
          // (3) exactly 2 POSTs (one retry, no loop) on the fake backend.
          phase("P1-093: auto-approve failure surfaces an actionable card");
          const FAIL_SES = "ses-autofail";
          await fetch(`${fakeUrl}/__arm-perm`, { method: "POST" });
          run("P1-093: resize to desktop width", ["shot", join(shotsDir, "P1-093-resize.png"), "1440", "900"], 15_000, localEnv2);
          await waitProbe("P1-093: chat remounted at 1440px", "!!document.querySelector('.messages')", (v) => /true/.test(v), localEnv2);
          run("P1-093: open Settings pane", ["menu-click", "go-pane-settings"], 15_000, localEnv2);
          // the pane's mount-time settings GET must settle BEFORE the toggle —
          // otherwise its resolve re-renders over the click (eaten onChange,
          // reverted checkbox) and the PATCH never sticks
          await waitProbe(
            "P1-093: settings loaded (footer shows the daemon version)",
            "document.body.innerText",
            (v) => /daemon \d/.test(v.trim()),
            localEnv2,
          );
          run("P1-093: toggle AutoMode on (real UI)", ["click", "input.automode-toggle"], 15_000, localEnv2);
          // ipc results are JSON-encoded — booleans come back bare
          await waitProbe("P1-093: AutoMode checkbox is checked", "document.querySelector('input.automode-toggle')?.checked", (v) => /true/.test(v), localEnv2);
          // daemon-side proof: the settings PATCH must have been audited
          let auditTail = "";
          let patchAudited = false;
          for (let i = 0; i < 10 && !patchAudited; i++) {
            try {
              auditTail = readFileSync(join(daemonHome2, ".opencode-remote", "audit.log"), "utf8").split("\n").filter(Boolean).slice(-6).join("\n");
              patchAudited = auditTail.includes("settings.updated");
            } catch {}
            if (!patchAudited) await new Promise((r) => setTimeout(r, 500));
          }
          check("P1-093: settings PATCH reached the daemon (audited)", patchAudited, auditTail);
          run("P1-093: open the failing session", ["ipc", `location.hash = '#/session/${FAIL_SES}'`], 15_000, localEnv2);
          await waitProbe("P1-093: session chat rendered", "!!document.querySelector('.messages')", (v) => /true/.test(v), localEnv2);
          // the passive badge renders only when the client's autoMode (read
          // from the daemon) is true — proof the toggle stuck end-to-end
          await waitProbe(
            "P1-093: AutoMode badge visible (daemon echoed the toggle)",
            "document.body.innerText",
            (v) => v.includes("AutoMode —"),
            localEnv2,
          );
          await fetch(`${fakeUrl}/__emit`, {
            method: "POST",
            body: JSON.stringify([
              { type: "permission.updated", properties: { sessionID: FAIL_SES, permissionID: "perm-fail", type: "bash" } },
            ]),
          });
          // the note text is i18n'd (the shell may boot in any language) —
          // assert existence, the red color from --danger and the action label
          const noteProbe = `(() => { const el = document.querySelector('.auto-fail-note'); if (!el) return 'none'; const [r, g, b] = (getComputedStyle(el).color.match(/\\d+/g) ?? []).map(Number); return r + '|' + g + '|' + b + '|' + (el.textContent ?? ''); })()`;
          await waitProbe(
            "P1-093: red auto-fail note visible in the composer",
            noteProbe,
            (v) => {
              let s = v.trim();
              try {
                s = JSON.parse(s) as string; // ipc results are JSON-encoded
              } catch {}
              const [r, g, b, ...rest] = s.split("|");
              return Number(r) > 100 && Number(g) < 160 && Number(b) < 160 && rest.join("|").includes("bash");
            },
            localEnv2,
          );
          const cardUp = await waitProbe(
            "P1-093: actionable card rendered despite AutoMode",
            "!!document.querySelector('.approval')",
            (v) => /true/.test(v),
            localEnv2,
          );
          if (cardUp) {
            const denied = await fetch(`${fakeUrl}/__hits`).then((r) => r.json() as Promise<{ method: string; path: string }[]>).catch(() => [] as { method: string; path: string }[]);
            const posts = denied.filter((h) => h.method === "POST" && h.path === `/session/${FAIL_SES}/permissions/perm-fail`).length;
            check("P1-093: exactly 2 POSTs on the fake (retry 1x, no loop)", posts === 2, `posts=${posts}`);
            run("P1-093: evidence shot", ["shot", join(shotsDir, "P1-093-autofail-1440.png"), "1440", "900"], 15_000, localEnv2);
            run("P1-093: 390 evidence shot", ["shot", join(shotsDir, "P1-093-autofail-390.png"), "390", "844"], 15_000, localEnv2);
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

  // --- P2-138: upstream notice — fake opencode answering 401 -----------------
  // Reuses the P1-089 fake-opencode pattern, configured for HTTP 401 on
  // /global/health: the daemon itself stays healthy (its /api/health attaches
  // the P2-135 classifier verdict) while the agent server refuses the token.
  // The shell propagates the opencode object over ocr:pairing-state (same
  // channel as the P3-054 version fields) and the renderer shows the hint in
  // exactly ONE card — the Settings help section — never a second banner
  // (P2-108 single-surface rule).
  phase("P2-138: upstream notice (fake opencode 401)");
  const fake401Script = [
    "const http = require('node:http');",
    "const srv = http.createServer((req, res) => {",
    "  const u = new URL(req.url, 'http://127.0.0.1');",
    "  if (u.pathname === '/global/health') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }",
    "  res.writeHead(404).end();",
    "});",
    "srv.listen(0, '127.0.0.1', () => console.log('PORT=' + srv.address().port));",
  ].join("\n");
  const fake401Child = spawn(process.execPath, ["-e", fake401Script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const fake401Port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake opencode 401 never printed PORT")), 10_000);
    fake401Child.stdout?.on("data", (d: Buffer) => {
      const m = d.toString().match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    fake401Child.on("exit", () => reject(new Error("fake opencode 401 exited early")));
  }).catch((err) => {
    check("P2-138: fake opencode (401) booted", false, String(err));
    return NaN;
  });
  const killFake401 = () => fake401Child.kill();
  process.on("exit", killFake401);
  const daemonHome3 = mkdtempSync(join(tmpdir(), "ocr-flow-daemon3-"));
  const localStateFile3 = join(daemonHome3, ".opencode-remote", "daemon.json");
  const port3 = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
  const localDaemon3 = spawn("npx", ["tsx", "apps/daemon/src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: daemonHome3,
      OCR_METRICS_PORT: String(port3),
      RELAY_URL: "ws://127.0.0.1:1", // dead: relay must stay irrelevant in local mode
      OPENCODE_URL: `http://127.0.0.1:${fake401Port}`,
      OCR_LOG_LEVEL: "error",
    },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  const killDaemon3 = (signal: NodeJS.Signals = "SIGTERM"): void => {
    if (!localDaemon3.pid) return;
    try {
      process.kill(-localDaemon3.pid, signal);
    } catch {
      /* already gone */
    }
  };
  process.on("exit", () => killDaemon3("SIGKILL"));
  const upstreamEnv = {
    ...process.env,
    OCR_DESKTOP_SESSION: `${session}-upstream`,
    OCR_DESKTOP_LOCAL_STATE: localStateFile3,
    OCR_DAEMON_METRICS_PORT: String(port3),
  };
  let upstreamBooted = false;
  try {
    let token3 = "";
    for (let i = 0; i < 25; i++) {
      try {
        token3 = (JSON.parse(readFileSync(localStateFile3, "utf8")) as { apiToken?: string }).apiToken ?? "";
      } catch {}
      if (token3) break;
      await fetch(`http://127.0.0.1:${port3}/api/health`, { headers: { authorization: "Bearer warmup" } }).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
    }
    check("P2-138: hermetic daemon (401 upstream) published the 0600 state file", !!token3);
    // daemon-side proof first: the classifier verdict rides on /api/health
    const upstreamHealth = token3
      ? await fetch(`http://127.0.0.1:${port3}/api/health`, { headers: { authorization: `Bearer ${token3}` } })
          .then((r) => r.json() as Promise<{ opencode?: { state?: string } }>)
          .catch(() => null)
      : null;
    check(
      "P2-138: /api/health carries opencode.state=unauthorized",
      upstreamHealth?.opencode?.state === "unauthorized",
      JSON.stringify(upstreamHealth?.opencode ?? null),
    );
    if (token3 && upstreamHealth?.opencode?.state === "unauthorized") {
      const open = run("P2-138: open (hermetic launch)", ["open"], 45_000, upstreamEnv);
      upstreamBooted = open.ok;
      if (open.ok) {
        // P2-148: fresh userData boots into the first-run welcome — skip it.
        run("P2-138: skip the first-run welcome", ["click", ".welcome-skip"], 15_000, upstreamEnv);
        await waitProbe(
          "P2-138: app paired with the hermetic daemon",
          "document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? ''",
          (v) => v.includes("paired"),
          upstreamEnv,
        );
        // channel proof: the renderer receives the opencode verdict through
        // ocr:pairing-state (additive field next to the P3-054 versions)
        const st = run("P2-138: IPC app:pairingState", ["ipc", "window.ocrDesktop.getPairingState()"], 15_000, upstreamEnv);
        if (st.ok) {
          let parsed: { opencode?: { state?: string } } | null = null;
          try {
            parsed = JSON.parse(st.stdout) as typeof parsed;
          } catch {
            parsed = null;
          }
          check("P2-138: pairingState carries opencode.state=unauthorized", parsed?.opencode?.state === "unauthorized", st.stdout);
        }
        run("P2-138: open Settings pane", ["menu-click", "go-pane-settings"], 15_000, upstreamEnv);
        const helpUp = await waitProbe(
          "P2-138: Settings help card rendered",
          "!!document.querySelector('.settings-help')",
          (v) => /true/.test(v),
          upstreamEnv,
          12,
          500,
        );
        if (helpUp) {
          // ONE visible card carries the hint; no daemon banner doubles it.
          const one = run("P2-138: single help card probe", ["ipc", "String(document.querySelectorAll('.settings-help').length)"], 15_000, upstreamEnv);
          if (one.ok) check("P2-138: exactly one visible card carries the hint", one.stdout.replace(/"/g, "").trim() === "1", one.stdout);
          const noBanner = run("P2-138: banner count probe", ["ipc", "String(document.querySelectorAll('.daemon-reconnecting, .daemon-down, .conn-banner').length)"], 15_000, upstreamEnv);
          if (noBanner.ok) check("P2-138: upstream notice never becomes a second banner (P2-108)", noBanner.stdout.replace(/"/g, "").trim() === "0", noBanner.stdout);
          // P2-106 lesson: locale-independent class hook + en/pt regex copy.
          const hint = run("P2-138: hint copy probe", ["ipc", "document.querySelector('.settings-help')?.textContent ?? ''"], 15_000, upstreamEnv);
          if (hint.ok) {
            check(
              "P2-138: help card names the refusal and the action",
              /Agent password changed|A senha do agente mudou/.test(hint.stdout) &&
                /credential|credencial/.test(hint.stdout),
              hint.stdout,
            );
          }
          const shot1440 = join(shotsDir, "P2-138-upstream-1440.png");
          const shot390 = join(shotsDir, "P2-138-upstream-390.png");
          const s1 = run("P2-138: 1440x900 evidence shot", ["shot", shot1440, "1440", "900"], 15_000, upstreamEnv);
          if (s1.ok) check("P2-138: 1440x900 shot is a real PNG", pngSize(shot1440).join("x") === "1440x900");
          const s2 = run("P2-138: 390 evidence shot", ["shot", shot390, "390", "844"], 15_000, upstreamEnv);
          if (s2.ok) check("P2-138: 390 shot is a real PNG", pngSize(shot390)[0] === 390);
        }
      }
    }
  } finally {
    if (upstreamBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: upstreamEnv });
    killDaemon3("SIGKILL");
    killFake401();
    rmSync(daemonHome3, { recursive: true, force: true });
  }

  // --- P2-140: daemon-down card explains WHY the daemon died ------------------
  // The harness honors a caller-set OCR_DAEMON_ENTRY: the shell really spawns
  // this fake daemon entry, which prints EADDRINUSE on stderr and exits 1.
  // The exit classifier verdict (port-busy) rides ocr:pairing-state and the
  // ONE calm degraded card shows the actionable hint — never a second banner
  // (P2-108). Respawn delays are shortened so the real gaveUp state (which
  // freezes the last verdict) arrives in ~2s instead of 65s.
  phase("P2-140: sidecar exit verdict (fake entry exits 1 with EADDRINUSE)");
  const exitDir = mkdtempSync(join(tmpdir(), "ocr-flow-exit-"));
  const fakeEntry = join(exitDir, "fake-daemon-entry.cjs");
  writeFileSync(
    fakeEntry,
    [
      "// P2-140 beat: a daemon entry that cannot boot — the port is taken.",
      "process.stderr.write('Error: listen EADDRINUSE: address already in use 127.0.0.1:8792\\n');",
      "process.exit(1);",
    ].join("\n"),
  );
  const exitEnv = {
    ...process.env,
    OCR_DESKTOP_SESSION: `${session}-exitinfo`,
    OCR_DAEMON_ENTRY: fakeEntry,
    OCR_DAEMON_RESPAWN_DELAYS: "300,300,300",
  };
  let exitBooted = false;
  try {
    const open = run("P2-140: open (hermetic launch with a dying fake daemon)", ["open"], 45_000, exitEnv);
    exitBooted = open.ok;
    if (open.ok) {
      // P2-148: fresh userData boots into the first-run welcome — skip it so
      // the calm card (and its exit verdict) is on screen for the probes.
      run("P2-140: skip the first-run welcome", ["click", ".welcome-skip"], 15_000, exitEnv);
      const hintShown = await waitProbe(
        "P2-140: exit hint rendered inside the calm card",
        "!!document.querySelector('.degraded-exit')",
        (v) => /true/.test(v),
        exitEnv,
      );
      if (hintShown) {
        // ONE calm card, ONE exit block, zero extra banners (P2-108).
        const oneCard = run("P2-140: single degraded card probe", ["ipc", "String(document.querySelectorAll('.degraded').length)"], 15_000, exitEnv);
        if (oneCard.ok) check("P2-140: exactly one calm card", oneCard.stdout.replace(/"/g, "").trim() === "1", oneCard.stdout);
        const oneExit = run("P2-140: single exit block probe", ["ipc", "String(document.querySelectorAll('.degraded-exit').length)"], 15_000, exitEnv);
        if (oneExit.ok) check("P2-140: exactly one exit-verdict block", oneExit.stdout.replace(/"/g, "").trim() === "1", oneExit.stdout);
        const noBanner = run("P2-140: banner count probe", ["ipc", "String(document.querySelectorAll('.daemon-down, .daemon-reconnecting, .conn-banner').length)"], 15_000, exitEnv);
        if (noBanner.ok) check("P2-140: verdict never becomes a second banner (P2-108)", noBanner.stdout.replace(/"/g, "").trim() === "0", noBanner.stdout);
        // P2-106 lesson: locale-independent class hook + en/pt regex copy.
        const copy = run("P2-140: exit copy probe", ["ipc", "document.querySelector('.degraded-exit')?.textContent ?? ''"], 15_000, exitEnv);
        if (copy.ok) {
          check(
            "P2-140: port-busy title + actionable hint (en|pt)",
            /took the daemon's port|ocupou a porta do daemon/.test(copy.stdout) &&
              /Close the program|Feche o programa/.test(copy.stdout),
            copy.stdout,
          );
        }
        // Channel proof: the verdict object itself, sanitized for the UI —
        // no file paths, tokens or secrets may leak into the displayed copy.
        const st = run("P2-140: IPC app:pairingState", ["ipc", "window.ocrDesktop.getPairingState()"], 15_000, exitEnv);
        if (st.ok) {
          let parsed: { daemonDown?: boolean; sidecarExit?: { kind?: string; reason?: string; hint?: string } } | null = null;
          try {
            parsed = JSON.parse(st.stdout) as typeof parsed;
          } catch {
            parsed = null;
          }
          const verdict = parsed?.sidecarExit;
          check(
            "P2-140: pairingState carries daemonDown + kind=port-busy over ocr:pairing-state",
            parsed?.daemonDown === true && verdict?.kind === "port-busy",
            st.stdout,
          );
          check(
            "P2-140: verdict copy is path-free and non-empty",
            !!verdict?.reason && !!verdict?.hint && !reasonOrHintLeaksPaths(verdict),
            JSON.stringify(verdict ?? null),
          );
        }
        const shot1440 = join(shotsDir, "P2-140-exit-1440.png");
        const shot390 = join(shotsDir, "P2-140-exit-390.png");
        const s1 = run("P2-140: 1440x900 evidence shot", ["shot", shot1440, "1440", "900"], 15_000, exitEnv);
        if (s1.ok) check("P2-140: 1440x900 shot is a real PNG", pngSize(shot1440).join("x") === "1440x900");
        const s2 = run("P2-140: 390 evidence shot", ["shot", shot390, "390", "844"], 15_000, exitEnv);
        if (s2.ok) check("P2-140: 390 shot is a real PNG", pngSize(shot390)[0] === 390);
      } else {
        check("P2-140: exit hint never rendered", false, "waitProbe exhausted");
      }
    }
  } finally {
    if (exitBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: exitEnv });
    rmSync(exitDir, { recursive: true, force: true });
  }
} finally {
  if (keeperBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: cliEnv });
}

// --- P2-148 beat B: the welcome flag survives the relaunch -------------------
// Same userData as the keeper boot (where beat A skipped the onboarding):
// after the first instance is fully closed (single-instance lock, P2-069), a
// fresh hermetic boot with the SAME OCR_USER_DATA_DIR must land straight on
// the home — the onboarding never comes back.
phase("P2-148: welcome flag survives the relaunch (same userData)");
if (bootInfo?.userData) {
  const welcomeEnv = {
    ...process.env,
    OCR_DESKTOP_SESSION: `${session}-welcome2`,
    OCR_USER_DATA_DIR: bootInfo.userData,
  };
  let welcomeBooted = false;
  try {
    // single-instance lock (P2-069): the outer finally's close returns before
    // the keeper's async shutdown (12s quit grace + SIGKILL) is done — wait
    // for the keeper PROCESS to be gone, same loop as the P1-089 relaunch.
    for (let i = 0; i < 32; i++) {
      const alive = spawnSync("pgrep", ["-f", "tools/desktop\\.mjs"], { encoding: "utf8" });
      if (alive.status !== 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const open2 = run("P2-148: open (second boot, same userData)", ["open"], 45_000, welcomeEnv);
    welcomeBooted = open2.ok;
    if (open2.ok) {
      run("P2-148: boot rendered the app", ["see", "OpenCode Remote"], 15_000, welcomeEnv);
      const noWelcome = run("P2-148: onboarding absent on the second boot", ["ipc", "!!document.querySelector('.welcome')"], 15_000, welcomeEnv);
      if (noWelcome.ok) check("P2-148: .welcome not rendered again", /false/.test(noWelcome.stdout));
      const home2 = run("P2-148: home directly on the second boot", ["ipc", "!!document.querySelector('.degraded')"], 15_000, welcomeEnv);
      if (home2.ok) check("P2-148: degraded home shown instead of the onboarding", /true/.test(home2.stdout));
    }
  } finally {
    if (welcomeBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: welcomeEnv });
  }
} else {
  check("P2-148: keeper reported its userData dir for beat B", false, "no bootInfo.userData");
}

// --- P2-152: the one-time close-to-tray hint ----------------------------------
// Closing the window hides it instead of quitting (P2-021) but nothing said
// so — the app just "vanished" for the leigo user. Now the FIRST non-quitting
// close fires one native notification and stamps userData/close-hint.flag.
// Beat: fresh userData → close the window from the renderer → the window
// survives (wins probe), desktop.log carries exactly one hint line and the
// flag is stamped with the sentinel → the instance is closed (single-instance
// lock, P2-069) → a second boot on the SAME userData closes again and the log
// still carries exactly one line.
phase("P2-152: one-time close-to-tray hint");
{
  const hintDir = mkdtempSync(join(tmpdir(), "ocr-flow-closehint-"));
  const hintEnv = { ...process.env, OCR_DESKTOP_SESSION: `${session}-closehint`, OCR_USER_DATA_DIR: hintDir };
  const hintEnv2 = { ...process.env, OCR_DESKTOP_SESSION: `${session}-closehint2`, OCR_USER_DATA_DIR: hintDir };
  const hintLog = join(hintDir, "logs", "desktop.log");
  const hintFlag = join(hintDir, "close-hint.flag");
  const hintLines = (): number => {
    try {
      return readFileSync(hintLog, "utf8").split(CLOSE_HINT_LOG).length - 1;
    } catch {
      return 0;
    }
  };
  let hintBooted = false;
  let hintBooted2 = false;
  try {
    const open = run("P2-152: open (fresh userData)", ["open"], 45_000, hintEnv);
    hintBooted = open.ok;
    if (open.ok) {
      run("P2-152: boot rendered the app", ["see", "OpenCode Remote"], 15_000, hintEnv);
      // Deviation from the spec (justified in the commit): the renderer's DOM
      // window.close() destroys the window WITHOUT firing the cancellable
      // close event (proven — wins went to 0 and no handler ran), so it is
      // NOT the red button. The harness close-window command calls
      // win.close() in the main process, the same native close path the OS
      // close button uses — exactly what close-to-tray intercepts.
      run("P2-152: close the window (red-button path)", ["close-window"], 15_000, hintEnv);
      // The hint + flag stamp happen right after the hide, but the
      // notification is fire-and-forget — poll briefly for the stamp.
      let stamped = false;
      for (let i = 0; i < 20 && !stamped; i++) {
        stamped = existsSync(hintFlag);
        if (!stamped) await new Promise((r) => setTimeout(r, 250));
      }
      check("P2-152: hint flag stamped in userData", stamped, hintFlag);
      const wins = run("P2-152: wins probe after the close", ["wins"], 15_000, hintEnv);
      if (wins.ok) {
        let count = -1;
        try {
          const arr = JSON.parse(wins.stdout) as unknown;
          count = Array.isArray(arr) ? arr.length : -1;
        } catch {}
        check("P2-152: window survives the close (close-to-tray)", count === 1, wins.stdout);
      }
      check("P2-152: exactly one hint line in desktop.log", hintLines() === 1, `count=${hintLines()}`);
      check("P2-152: flag content is the sentinel", (() => {
        try {
          return readFileSync(hintFlag, "utf8") === "1";
        } catch {
          return false;
        }
      })());
      // The window is hidden but the first instance is still alive holding
      // the single-instance lock — quit it for real (quitting=true, so this
      // close lands no hint line) before booting the second instance.
      run("P2-152: quit the first instance", ["close"], 45_000, hintEnv);
    }
    // Single-instance lock (P2-069): the close above returns before the
    // keeper's async shutdown finishes — wait for the keeper PROCESS to be
    // gone before reopening the same userData, same loop as the P2-148
    // relaunch beat.
    for (let i = 0; i < 32; i++) {
      const alive = spawnSync("pgrep", ["-f", "tools/desktop\\.mjs"], { encoding: "utf8" });
      if (alive.status !== 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const open2 = run("P2-152: open (second boot, same userData)", ["open"], 45_000, hintEnv2);
    hintBooted2 = open2.ok;
    if (open2.ok) {
      run("P2-152: boot rendered the app again", ["see", "OpenCode Remote"], 15_000, hintEnv2);
      run("P2-152: close the window again", ["close-window"], 15_000, hintEnv2);
      await new Promise((r) => setTimeout(r, 1500));
      check("P2-152: second close stays silent (shown once)", hintLines() === 1, `count=${hintLines()}`);
    }
  } finally {
    if (hintBooted2) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: hintEnv2 });
    if (hintBooted) spawnSync(process.execPath, ["tools/desktop.mjs", "close"], { cwd: repoRoot, encoding: "utf8", env: hintEnv });
    rmSync(hintDir, { recursive: true, force: true });
  }
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
