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
 * macOS .app bundles and Windows unpacked dirs (win-unpacked, NSIS) both work:
 * the per-platform executable candidates come from packaged-boot-layout.mjs
 * (pure) and resolveExecutable() below stays the only disk-touching point.
 *
 * Usage: node scripts/packaged-boot.mjs <path to .app bundle | win-unpacked dir>
 */
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootVerdict, CANARY } from "./packaged-boot-verdict.mjs";
import { candidatePaths } from "./packaged-boot-layout.mjs";

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
    if (isFile(path) && statSync(path).mode & 0o111) return path;
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

function finish(verdict, appPath, consoleErrors) {
  if (watchdog) clearTimeout(watchdog);
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
  try {
    await electronApp.close();
  } catch {}
  clearTimeout(killer);
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("packaged-boot: usage — node scripts/packaged-boot.mjs <path to .app bundle | win-unpacked dir>");
    process.exitCode = 1;
    return;
  }
  const appPath = resolve(raw);
  if (!existsSync(appPath)) {
    console.error(`packaged-boot: FAIL — bundle dir does not exist: ${appPath}`);
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
    process.exitCode = 1;
    return;
  }

  watchdog = setTimeout(() => {
    console.error(`packaged-boot: FAIL — boot smoke exceeded ${BOOT_TIMEOUT_MS}ms, killing the app`);
    try {
      activeApp?.process().kill("SIGKILL");
    } catch {}
    process.exit(1);
  }, BOOT_TIMEOUT_MS);

  let electronApp = null;
  // Launch the PACKAGED binary itself (not the electron npm package): the
  // bundle carries its own runtime, asar and extraResources.
  const facts = { executableFound: true, loadFinished: false, rootEmpty: true, canarySeen: false, consoleErrors: [] };
  try {
    electronApp = await electron.launch({
      executablePath: executable,
      args: [],
      cwd: dirname(executable),
      env: hermeticBootEnv(),
    });
    activeApp = electronApp;
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
          return;
        }
        facts.consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => facts.consoleErrors.push(String(err?.message ?? err)));
    };
    electronApp.on("window", collect);
    const page = await electronApp.firstWindow({ timeout: LOAD_TIMEOUT_MS });
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

    finish(bootVerdict(facts), appPath, facts.consoleErrors);
  } catch (err) {
    // Launch died (binary found but the process never produced a window —
    // e.g. main throwing at boot or an entitlement killing it): load-failed.
    console.error(`packaged-boot: launch/load error: ${String(err?.message ?? err).split("\n")[0]}`);
    finish(bootVerdict(facts), appPath, facts.consoleErrors);
  } finally {
    await closeApp(electronApp);
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
