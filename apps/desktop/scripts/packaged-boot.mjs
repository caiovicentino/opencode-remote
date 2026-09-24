#!/usr/bin/env node
/**
 * P2-204: real boot smoke for the packaged bundle (release gate — NOT the
 * pilot gate, docs/PILOT.md). dist-smoke.mjs only INSPECTS the package; this
 * script actually OPENS the packaged app once, hermetically, and reports a
 * verdict:
 *
 *   - temp userData + a run-unique OCR_DESKTOP_SESSION (HERMETIC_E2E keeps the
 *     window off the runner's screen, same hatch as tools/desktop.mjs)
 *   - nonexistent OCR_DAEMON_ENTRY so NO sidecar is ever spawned, and
 *     OCR_DAEMON_FORCE_DOWN for a deterministic pairing state
 *   - OCR_KEEPER_PID leashed to this process: if the smoke dies, the app quits
 *
 * It waits for the renderer to finish loading (Playwright "load" state — the
 * did-finish-load equivalent), injects the render-smoke console canary and
 * requires the collector to have seen it, checks #root mounted content, then
 * closes the app and exits 0/1 by bootVerdict(). Playwright missing fails
 * closed (exit 1) — the step must never pass because the driver could not run.
 *
 * P2-354: the smoke also MEASURES the cold start it just proved — wall-clock
 * from the process spawn (the electron.launch call, the closest observable
 * spawn point) until load-finished with the console canary seen — and prints
 * exactly ONE ratchet line on every run: `packaged-boot boot in Xms budget Yms`
 * (budget from the pure bootbudget.mjs table). The spike FAILS OPEN: absent
 * timing prints `unknown` and never flips the exit code, and the budget
 * verdict is informational — nothing gates on time yet (docs/PILOT.md).
 *
 * macOS .app bundles and Windows unpacked dirs (win-unpacked, NSIS) both work:
 * the per-platform executable candidates come from packaged-boot-layout.mjs
 * (pure) and resolveExecutable() below stays the only disk-touching point.
 *
 * Usage: node scripts/packaged-boot.mjs <path to .app bundle | win-unpacked dir>
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootVerdict, CANARY } from "./packaged-boot-verdict.mjs";
import { candidatePaths, isExecutableEntry } from "./packaged-boot-layout.mjs";
import { exitPlan, postVerdictExitCode, runExitPlan } from "./packaged-boot-exit.mjs";
import { bootBudgetLine, bootBudgetVerdict } from "./bootbudget.mjs";

const BOOT_TIMEOUT_MS = 120_000;
const LOAD_TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_500;
const CLOSE_DEADLINE_MS = 12_000;

const scriptsDir = fileURLToPath(new URL(".", import.meta.url)); // apps/desktop/scripts
const repoRoot = resolve(scriptsDir, "..", "..", "..");

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the runnable binary inside the package, disk access confined to this
 * function (P2-208): the ordered candidates from packaged-boot-layout.mjs
 * first — <bundle>/Contents/MacOS/<bundle name> on macOS, the .exe passthrough
 * or same-name executable on Windows — then the pre-existing fallback of
 * picking any executable file from the package directory (Contents/MacOS on
 * macOS, the unpacked dir itself on Windows). Returns an absolute path or null
 * (→ binary-missing).
 */
export function resolveExecutable(appPath) {
  for (const candidate of candidatePaths(appPath, process.platform)) {
    if (isFile(candidate)) return candidate;
  }
  const scanDir = process.platform === "win32" ? appPath : join(appPath, "Contents", "MacOS");
  if (!isFile(scanDir) && !existsSync(scanDir)) return null;
  let entries;
  try {
    entries = readdirSync(scanDir).sort();
  } catch {
    return null;
  }
  for (const name of entries) {
    const path = join(scanDir, name);
    if (!isFile(path)) continue;
    if (isExecutableEntry(name, statSync(path).mode, process.platform)) return path;
  }
  return null;
}

/** Hermetic launch env — same contract as tools/desktop.mjs hermeticEnv(). */
export function hermeticBootEnv() {
  const userData = mkdtempSync(join(tmpdir(), "ocr-packaged-boot-"));
  const stateFile = join(userData, "daemon-state.json");
  writeFileSync(stateFile, "{}");
  return {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    OCR_USER_DATA_DIR: userData,
    OCR_DAEMON_STATE_FILE: stateFile,
    // Nonexistent on purpose: resolveEntry() finds nothing → no sidecar spawn.
    OCR_DAEMON_ENTRY: join(userData, "no-daemon-entry.js"),
    OCR_DAEMON_FORCE_DOWN: "1",
    // Leash: the packaged app quits when this process disappears (P2-069).
    OCR_KEEPER_PID: String(process.pid),
    // Run-unique session id: HERMETIC_E2E in the shell hides the window, and
    // the boot smoke never touches a real desktop session's state.
    OCR_DESKTOP_SESSION: `packaged-boot-${process.pid}-${Date.now()}`,
  };
}

/** The _electron launcher from playwright-core, or null — missing is a
 * fail-closed condition, never a silent pass. */
function loadElectronLauncher() {
  try {
    const req = createRequire(join(repoRoot, "package.json"));
    const pw = req("playwright-core");
    if (pw?._electron && typeof pw._electron.launch === "function") return pw._electron;
    return null;
  } catch {
    return null;
  }
}

let watchdog = null;
let activeApp = null;
let verdictPrinted = false;
// P2-354 ratchet state: wall-clock start at the spawn point and the single
// boot-time measurement (spawn → load-finished with canary seen). null means
// "not timed yet" — the ratchet fails open, so null is a normal outcome, never
// a failure.
let bootStartedAt = null;
let bootMeasuredMs = null;
let bootTimingPrinted = false;

/**
 * Print the ONE ratchet line of this run (at most once per process): the
 * measured boot time next to the platform ceiling, from the pure module.
 * Strictly informational — no exit-code path may ever depend on it.
 */
function printBootTiming() {
  if (bootTimingPrinted) return;
  bootTimingPrinted = true;
  const budget = bootBudgetVerdict(process.platform, bootMeasuredMs);
  console.log(bootBudgetLine(process.platform, bootMeasuredMs));
  if (budget.state === "over-budget") console.log(`  ${budget.message}`);
}

function finish(verdict, appPath, consoleErrors) {
  verdictPrinted = true;
  if (verdict.ok) {
    console.log(`packaged-boot: OK ${appPath}`);
    console.log(`  ${verdict.message}`);
  } else {
    console.error(`packaged-boot: FAIL ${appPath} — ${verdict.reason}`);
    console.error(`  ${verdict.message}`);
    for (const error of (consoleErrors ?? []).slice(0, 10)) {
      console.error(`  renderer: ${String(error).split("\n")[0]}`);
    }
  }
  printBootTiming();
  process.exitCode = verdict.ok ? 0 : 1;
}

async function closeApp(electronApp) {
  if (!electronApp) return;
  // close() can hang when the app already died or refuses to quit — SIGKILL
  // after the deadline so the runner never waits on a stuck Electron.
  const killer = setTimeout(() => {
    try {
      electronApp.process().kill("SIGKILL");
    } catch {}
  }, CLOSE_DEADLINE_MS);
  // P3-437 (runs 35776744184 and peers): on a wedged renderer/CDP pipe the
  // SIGKILL kills the app but close()'s promise never settles — the await
  // hung past the 120s watchdog and the runner reported FAIL for a boot that
  // had already passed its verdict. Race against a hard ceiling so the
  // finally always reaches the deterministic exit plan below.
  await Promise.race([
    electronApp.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, CLOSE_DEADLINE_MS + 1_000)),
  ]);
  clearTimeout(killer);
}

/**
 * P3-343: save the booted window as visual proof when OCR_PACKAGED_BOOT_SHOT
 * points at a file (the packaging CI sets it and uploads the PNG as a run
 * artifact). Strictly fail-open and best-effort: a missing or failed shot is
 * logged, never flips the verdict — the boot verdict above is the gate.
 */
async function captureBootShot(page, verdict) {
  const shotPath = process.env.OCR_PACKAGED_BOOT_SHOT;
  if (!page || !shotPath) return;
  try {
    await page.screenshot({ path: shotPath, timeout: CLOSE_DEADLINE_MS });
    console.log(`packaged-boot: boot shot (${verdict.ok ? "ok" : verdict.reason}) — ${shotPath}`);
  } catch (err) {
    console.log(`packaged-boot: boot shot unavailable: ${String(err?.message ?? err).split("\n")[0]}`);
  }
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("packaged-boot: usage — node scripts/packaged-boot.mjs <path to .app bundle | win-unpacked dir>");
    printBootTiming();
    process.exitCode = 1;
    return;
  }
  const appPath = resolve(raw);
  if (!existsSync(appPath)) {
    console.error(`packaged-boot: FAIL — bundle dir does not exist: ${appPath}`);
    printBootTiming();
    process.exitCode = 1;
    return;
  }

  const executable = resolveExecutable(appPath);
  if (!executable) {
    finish(
      bootVerdict({ executableFound: false, loadFinished: false, rootEmpty: true, canarySeen: false, consoleErrors: [] }),
      appPath,
    );
    return;
  }

  const electron = loadElectronLauncher();
  if (!electron) {
    console.error("packaged-boot: FAIL — playwright-core is not available (npm ci at the repo root installs it)");
    console.error("packaged-boot: refusing to pass vacuously — the packaged app was NOT boot-tested");
    printBootTiming();
    process.exitCode = 1;
    return;
  }

  // P3-348: the watchdog is never disarmed by finish() anymore — it is the
  // backstop for the POST-verdict path too (a finally that hangs on a stuck
  // Electron/Playwright pipe). unref()'d so it is never itself the handle
  // keeping the loop alive.
  watchdog = setTimeout(() => {
    console.error(
      verdictPrinted
        ? `packaged-boot: teardown travou após o veredito — saindo com o veredito (${process.exitCode ?? 1})`
        : `packaged-boot: FAIL — boot smoke exceeded ${BOOT_TIMEOUT_MS}ms, killing the app`,
    );
    try {
      activeApp?.process().kill("SIGKILL");
    } catch {}
    // P3-437: the verdict is the gate — a post-verdict teardown wedge keeps
    // finish()'s code instead of flipping a proven-OK boot to FAIL.
    process.exit(postVerdictExitCode(verdictPrinted, process.exitCode));
  }, BOOT_TIMEOUT_MS);
  watchdog.unref?.();

  let electronApp = null;
  let bootedPage = null;
  let launchedPid = null;
  // Launch the PACKAGED binary itself (not the electron npm package): the
  // bundle carries its own runtime, asar and extraResources.
  const facts = { executableFound: true, loadFinished: false, rootEmpty: true, canarySeen: false, consoleErrors: [] };
  try {
    // P2-354: the wall-clock starts here — electron.launch spawns the packaged
    // process internally, the closest spawn point Playwright exposes.
    bootStartedAt = Date.now();
    electronApp = await electron.launch({
      executablePath: executable,
      args: [],
      cwd: dirname(executable),
      env: hermeticBootEnv(),
    });
    activeApp = electronApp;
    // P3-348: remember the pid right after the launch — after close() the
    // handle may not expose the child anymore, and the exit plan needs it
    // for the win32 kill-tree.
    try {
      launchedPid = electronApp.process()?.pid ?? null;
    } catch {}
    // Collect from the earliest moment Playwright offers: the "window" event
    // fires at page creation, before firstWindow() resolves, so the first
    // document's early boot errors land in the collector too. The injected
    // canary below keeps proving the collector actually saw anything.
    const collected = new Set();
    const collect = (page) => {
      if (collected.has(page)) return;
      collected.add(page);
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        if (msg.text().includes(CANARY)) {
          facts.canarySeen = true;
          // P2-354: THE single boot-time endpoint. The canary is only injected
          // after load-finished, so this flip is the first instant the smoke
          // holds both conditions (spawn → load-finished + canary seen).
          // Guarded so exactly one measurement is ever taken, even with
          // multiple windows collecting.
          if (bootMeasuredMs === null && bootStartedAt !== null) {
            bootMeasuredMs = Date.now() - bootStartedAt;
          }
          return;
        }
        facts.consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => facts.consoleErrors.push(String(err?.message ?? err)));
    };
    electronApp.on("window", collect);
    const page = await electronApp.firstWindow({ timeout: LOAD_TIMEOUT_MS });
    bootedPage = page;
    collect(page); // no-op when the window event already collected it

    try {
      await page.waitForLoadState("load", { timeout: LOAD_TIMEOUT_MS });
      facts.loadFinished = true;
    } catch {
      facts.loadFinished = false;
    }

    if (facts.loadFinished) {
      // Same beats as the render smoke: inject the canary right after load,
      // settle so async failures (asset 404s, SW, rejections) surface, then
      // inspect the DOM the user would see.
      await page.evaluate(`console.error('${CANARY}')`).catch((err) => facts.consoleErrors.push(`canary injection failed: ${err}`));
      await page.waitForTimeout(SETTLE_MS);
      try {
        const info = await page.evaluate(
          `(() => { const r = document.getElementById("root") || document.body;
             return { children: r ? r.children.length : -1,
                      text: (document.body.innerText || "").trim().length }; })()`,
        );
        facts.rootEmpty = !((info?.children ?? 0) > 0 && (info?.text ?? 0) > 0);
      } catch {
        facts.rootEmpty = true;
      }
    }

    const verdict = bootVerdict(facts);
    await captureBootShot(bootedPage, verdict);
    finish(verdict, appPath, facts.consoleErrors);
  } catch (err) {
    // Launch died (binary found but the process never produced a window —
    // e.g. main throwing at boot or an entitlement killing it): load-failed.
    console.error(`packaged-boot: launch/load error: ${String(err?.message ?? err).split("\n")[0]}`);
    const verdict = bootVerdict(facts);
    await captureBootShot(bootedPage, verdict);
    finish(verdict, appPath, facts.consoleErrors);
  } finally {
    await closeApp(electronApp);
    // P3-348: deterministic exit — finish() only set process.exitCode, and
    // on win32 the Electron tree / Playwright pipe can keep the loop alive
    // past closeApp(). Kill the whole tree best-effort (taskkill /T /F) when
    // the child is still alive, then exit with the verdict code for real.
    let childAlive = false;
    try {
      childAlive = typeof electronApp?.process === "function" && electronApp.process()?.exitCode === null;
    } catch {}
    runExitPlan(
      exitPlan({ platform: process.platform, exitCode: process.exitCode, pid: launchedPid, childAlive }),
      {
        kill: (pid) => {
          console.log(`packaged-boot: kill-tree pid=${pid}`);
          spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", timeout: 5_000 });
        },
        exit: (code) => process.exit(code),
      },
    );
  }
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  main().catch((err) => {
    console.error(`packaged-boot: uncaught: ${String(err?.stack ?? err).split("\n")[0]}`);
    process.exit(1);
  });
}
