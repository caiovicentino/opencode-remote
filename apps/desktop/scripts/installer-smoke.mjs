#!/usr/bin/env node
/**
 * P2-304: real install smoke for the Windows NSIS installer (release gate —
 * NOT the pilot gate, docs/PILOT.md). dist-smoke.mjs only INSPECTS the dist
 * root, Authenticode only reads the signature and packaged-boot.mjs boots the
 * unpacked win-unpacked bundle — the setup exe a Windows user actually runs
 * never executed anywhere before this script. It closes that gap end to end:
 *
 *   1. installs the setup exe silently (/S, target via /D=, the LAST
 *      unquoted argument — NSIS contract) into a throwaway directory under
 *      the system temp, with a hermetic environment (allowlisted vars, HOME/
 *      USERPROFILE/APPDATA/LOCALAPPDATA pointed at a temp home, so the
 *      deleteAppDataOnUninstall wipe can never reach a real profile);
 *   2. checks the installed layout: main executable, resources/daemon/
 *      index.js, resources/web-dist, uninstaller present;
 *   3. opens the INSTALLED executable with the SAME hermetic contract as
 *      packaged-boot.mjs — literally the same hermeticBootEnv() (temp
 *      userData, run-own OCR_DESKTOP_SESSION, nonexistent OCR_DAEMON_ENTRY
 *      so no sidecar spawns, OCR_DAEMON_FORCE_DOWN for deterministic
 *      pairing) and the same bootVerdict bar (load finished, #root mounted,
 *      console canary seen, console clean);
 *   4. runs the uninstaller silently (/S) and requires the install
 *      directory to disappear (the NSIS uninstaller may re-launch itself
 *      from temp, so the dir is polled after the direct child exits).
 *
 * The verdict lives in the pure installer-smoke-verdict.mjs (reasons:
 * install-failed, layout-missing, boot-failed, uninstall-failed,
 * leftover-files). Playwright missing fails closed BEFORE the machine is
 * mutated — the installer never runs unverified. NSIS only executes on
 * Windows: any other host fails closed up front (the release job runs on
 * windows-latest; the deterministic gate never runs this script).
 *
 * Usage: node scripts/installer-smoke.mjs <path to setup exe>
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hermeticBootEnv } from "./packaged-boot.mjs";
import { CANARY } from "./packaged-boot-verdict.mjs";
import { installerVerdict } from "./installer-smoke-verdict.mjs";

const SPAWN_TIMEOUT_MS = 90_000;
const DIR_APPEAR_TIMEOUT_MS = 60_000;
const DIR_GONE_TIMEOUT_MS = 60_000;
const LOAD_TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_500;
const CLOSE_DEADLINE_MS = 12_000;
const POLL_MS = 500;
const TAIL_MAX = 4_000;

const scriptsDir = fileURLToPath(new URL(".", import.meta.url)); // apps/desktop/scripts
const repoRoot = resolve(scriptsDir, "..", "..", "..");

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a zero-arg predicate until true or the deadline passes. */
async function waitFor(predicate, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(POLL_MS);
  }
  return predicate();
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

/**
 * Hermetic child env for the installer/uninstaller pair: allowlisted runner
 * vars (the same list hermeticDaemonEnv uses — a future step-level secret can
 * never flow into a child whose stderr is echoed to the job log) with every
 * profile pointer inside tempHome, so the P2-249 deleteAppDataOnUninstall
 * wipe lands in the throwaway tree and nowhere else.
 */
export function hermeticInstallerEnv(tempHome) {
  const allowlisted = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "SystemRoot", "SYSTEMDRIVE", "windir", "ComSpec", "PATHEXT"]) {
    if (process.env[key] !== undefined) allowlisted[key] = process.env[key];
  }
  return {
    ...allowlisted,
    HOME: tempHome,
    USERPROFILE: tempHome,
    APPDATA: tempHome,
    LOCALAPPDATA: tempHome,
  };
}

/** Wait for a child to exit (bounded); SIGKILL past the deadline. */
async function waitExit(child, timeoutMs) {
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {}
  }, timeoutMs);
  try {
    const how = await new Promise((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    return timedOut ? { code: null, signal: how.signal ?? "SIGKILL" } : how;
  } finally {
    clearTimeout(killer);
  }
}

/** Bounded stderr tail for the job log — never a full dump, never env content. */
function tailOf(child, onChunk) {
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => onChunk((chunk ?? "").toString()));
  child.stdout?.resume(); // discarded unread (same discipline as the daemon smoke)
}

/**
 * Classify the installed layout (disk access confined here): the main
 * executable is any root .exe that is not the uninstaller; the uninstaller
 * matches "Uninstall <name>.exe"; resources/daemon/index.js and
 * resources/web-dist/index.html are the two extraResources the packaged app
 * serves from. Returns null facts when the dir never appeared.
 */
export function installedLayoutFacts(installDir) {
  const facts = { executable: false, daemonEntry: false, webDist: false, uninstaller: false, executablePath: null, uninstallerPath: null };
  if (!existsSync(installDir)) return facts;
  facts.daemonEntry = isFile(join(installDir, "resources", "daemon", "index.js"));
  facts.webDist = isFile(join(installDir, "resources", "web-dist", "index.html"));
  let entries;
  try {
    entries = readdirSync(installDir).sort();
  } catch {
    return facts;
  }
  for (const name of entries) {
    const path = join(installDir, name);
    if (!isFile(path) || !name.toLowerCase().endsWith(".exe")) continue;
    if (/^uninstall/i.test(name)) {
      facts.uninstaller = true;
      facts.uninstallerPath = path;
    } else if (!facts.executable) {
      facts.executable = true;
      facts.executablePath = path;
    }
  }
  return facts;
}

/** The boot beats of packaged-boot.mjs, pointed at the INSTALLED binary. */
async function bootInstalled(electron, executable) {
  const facts = { driverAvailable: true, loadFinished: false, rootEmpty: true, canarySeen: false, consoleErrors: [] };
  let electronApp = null;
  try {
    electronApp = await electron.launch({
      executablePath: executable,
      args: [],
      cwd: dirname(executable),
      env: hermeticBootEnv(),
    });
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
  } catch (err) {
    console.error(`installer-smoke: boot error: ${String(err?.message ?? err).split("\n")[0]}`);
  } finally {
    if (electronApp) {
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
  }
  return facts;
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("installer-smoke: usage — node scripts/installer-smoke.mjs <path to setup exe>");
    process.exitCode = 1;
    return;
  }
  if (process.platform !== "win32") {
    console.error("installer-smoke: FAIL — NSIS installers only execute on Windows; run this smoke on a Windows host");
    process.exitCode = 1;
    return;
  }
  let setupPath = resolve(raw);
  if (!isFile(setupPath)) {
    console.error(`installer-smoke: FAIL — setup exe does not exist: ${setupPath}`);
    process.exitCode = 1;
    return;
  }

  // Fail closed BEFORE mutating the machine: without the driver the boot
  // stage could never run, so the smoke must not even install.
  const electron = loadElectronLauncher();
  if (!electron) {
    console.error("installer-smoke: FAIL — playwright-core is not available (npm ci at the repo root installs it)");
    console.error("installer-smoke: refusing to pass vacuously — the installed app was NOT boot-tested");
    process.exitCode = 1;
    return;
  }

  const tempHome = mkdtempSync(join(tmpdir(), "ocr-installer-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "ocr-installer-smoke-"));
  const installDir = join(workspace, "app");
  let stderrTail = "";

  try {
    // NSIS /D takes the rest of the command line unquoted; keep the exe path
    // space-free too (P2-186 artifact names already are — insurance for
    // local runs) so windowsVerbatimArguments can pass /D through untouched.
    if (setupPath.includes(" ")) {
      const flat = join(workspace, "setup.exe");
      copyFileSync(setupPath, flat);
      setupPath = flat;
    }

    // 1. silent install — /S and /D=<dir> last, unquoted (NSIS contract)
    console.log(`installer-smoke: installing ${basename(setupPath)} into a temp dir`);
    const installer = spawn(setupPath, ["/S", `/D=${installDir}`], {
      env: hermeticInstallerEnv(tempHome),
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: true,
    });
    tailOf(installer, (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-TAIL_MAX);
    });
    const installExit = await waitExit(installer, SPAWN_TIMEOUT_MS);
    const dirAppeared = installExit.code === 0 && installExit.signal === null && (await waitFor(() => existsSync(installDir), DIR_APPEAR_TIMEOUT_MS));

    // 2. installed layout
    const layout = dirAppeared ? installedLayoutFacts(installDir) : installedLayoutFacts("");

    // 3. boot the INSTALLED executable, hermetically (same contract as
    // packaged-boot.mjs) — only when the layout resolved a binary
    let boot = { driverAvailable: true, loadFinished: false, rootEmpty: true, canarySeen: false, consoleErrors: [] };
    if (layout.executable) boot = await bootInstalled(electron, layout.executablePath);

    // 4. silent uninstall — the NSIS uninstaller may re-launch from temp, so
    // the direct child exiting is not enough: poll for the dir to vanish.
    let uninstall = { attempted: false, exitCode: null, signal: null };
    if (layout.uninstaller) {
      console.log("installer-smoke: uninstalling");
      const uninstaller = spawn(layout.uninstallerPath, ["/S"], {
        env: hermeticInstallerEnv(tempHome),
        stdio: ["ignore", "pipe", "pipe"],
      });
      tailOf(uninstaller, (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-TAIL_MAX);
      });
      const uninstallExit = await waitExit(uninstaller, SPAWN_TIMEOUT_MS);
      uninstall = { attempted: true, exitCode: uninstallExit.code, signal: uninstallExit.signal };
    }
    const dirGone =
      uninstall.attempted && uninstall.exitCode === 0 && uninstall.signal === null && (await waitFor(() => !existsSync(installDir), DIR_GONE_TIMEOUT_MS));

    const verdict = installerVerdict({
      install: { exitCode: installExit.code, signal: installExit.signal, dirAppeared },
      layout: {
        executable: layout.executable,
        daemonEntry: layout.daemonEntry,
        webDist: layout.webDist,
        uninstaller: layout.uninstaller,
      },
      boot,
      uninstall,
      dirGone,
    });

    if (verdict.ok) {
      console.log(`installer-smoke: OK ${basename(setupPath)}`);
      console.log(`  ${verdict.message}`);
      process.exitCode = 0;
    } else {
      console.error(`installer-smoke: FAIL ${basename(setupPath)} — ${verdict.reason}`);
      console.error(`  ${verdict.message}`);
      if (stderrTail.trim() !== "") {
        console.error(`  tail: ${stderrTail.replace(/\s+/g, " ").trim().slice(-240)}`);
      }
      process.exitCode = 1;
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  main().catch((err) => {
    console.error(`installer-smoke: uncaught: ${String(err?.stack ?? err).split("\n")[0]}`);
    process.exit(1);
  });
}
