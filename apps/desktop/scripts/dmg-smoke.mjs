#!/usr/bin/env node
/**
 * P2-309: real disk-image smoke for the macOS DMG (release gate — NOT the
 * pilot gate, docs/PILOT.md). Everything before this script verifies OTHER
 * artifacts: packaged-boot.mjs boots the unpacked .app under dist/, the
 * P2-295 gatekeeper step reads the container's signature verdicts — but the
 * bytes that live INSIDE the image the user actually opens were never
 * mounted, so a DMG without the Applications shortcut (the drag-to-install
 * affordance the P2-211 copy tells laypeople to use) or with a broken app
 * inside only surfaced on the downloader's Mac. This script closes the gap:
 *
 *   1. attaches the image non-interactively (hdiutil attach, readonly,
 *      nobrowse, no EULA auto-open) at a throwaway mount point;
 *   2. checks the mounted content: exactly one .app bundle, the executable
 *      inside it, resources/daemon + resources/web-dist, and the
 *      Applications symlink pointing at /Applications;
 *   3. opens the app FROM INSIDE the mounted volume with the SAME hermetic
 *      contract as packaged-boot.mjs — literally the same hermeticBootEnv()
 *      (temp userData, run-own OCR_DESKTOP_SESSION, nonexistent
 *      OCR_DAEMON_ENTRY so no sidecar spawns, OCR_DAEMON_FORCE_DOWN for a
 *      deterministic pairing state) and the same bootVerdict bar (load
 *      finished, #root mounted, console canary seen, console clean);
 *   4. detaches the image ALWAYS — even when any earlier step fails — first
 *      plain, then with -force as the retry.
 *
 * The verdict lives in the pure dmg-smoke-verdict.mjs (reasons: attach-failed,
 * layout-missing, applications-link-missing, boot-failed, detach-failed).
 * Playwright missing fails closed BEFORE anything is mounted — the image is
 * never attached unverified. hdiutil only exists on macOS: any other host
 * fails closed up front (the release job runs on macos-14; the
 * deterministic gate never runs this script).
 *
 * Usage: node scripts/dmg-smoke.mjs <path to .dmg>
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hermeticBootEnv, resolveExecutable } from "./packaged-boot.mjs";
import { CANARY } from "./packaged-boot-verdict.mjs";
import { resolveDaemonEntry } from "./packaged-daemon-smoke.mjs";
import { dmgVerdict } from "./dmg-smoke-verdict.mjs";

const SPAWN_TIMEOUT_MS = 90_000;
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

function runHdiutil(args, onStderr) {
  const child = spawn("hdiutil", args, { stdio: ["ignore", "pipe", "pipe"] });
  tailOf(child, onStderr);
  return waitExit(child, SPAWN_TIMEOUT_MS);
}

/**
 * Classify the mounted volume (disk access confined here): exactly one .app
 * bundle at the volume root, the runnable executable inside it, the packaged
 * daemon + web-dist under Contents/Resources, and the Applications symlink
 * pointing at /Applications — the drag-to-install target the P2-211 copy
 * names. Returns the facts plus the resolved .app path for the boot stage.
 */
export function mountedLayoutFacts(volume) {
  const facts = { singleAppBundle: false, executable: false, daemonEntry: false, webDist: false, appPath: null };
  let entries;
  try {
    entries = readdirSync(volume).sort();
  } catch {
    return facts;
  }
  const apps = entries.filter((name) => {
    try {
      return name.toLowerCase().endsWith(".app") && statSync(join(volume, name)).isDirectory();
    } catch {
      return false;
    }
  });
  if (apps.length !== 1) return facts;
  facts.singleAppBundle = true;
  facts.appPath = join(volume, apps[0]);
  facts.executable = resolveExecutable(facts.appPath) !== null;
  facts.daemonEntry = resolveDaemonEntry(facts.appPath) !== null;
  facts.webDist = isFile(join(facts.appPath, "Contents", "Resources", "web-dist", "index.html"));
  return facts;
}

/** Applications-link facts for the volume root (lstat: a broken symlink must
 * still count as present — readlink, not existsSync, is the probe). */
export function applicationsLinkFacts(volume) {
  const linkPath = join(volume, "Applications");
  let target = null;
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return { present: false, targetOk: false };
    target = readlinkSync(linkPath);
  } catch {
    return { present: false, targetOk: false };
  }
  return { present: true, targetOk: target === "/Applications" };
}

/** The boot beats of packaged-boot.mjs, pointed at the binary INSIDE the
 * mounted volume. */
async function bootFromVolume(electron, executable) {
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
    console.error(`dmg-smoke: boot error: ${String(err?.message ?? err).split("\n")[0]}`);
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
    console.error("dmg-smoke: usage — node scripts/dmg-smoke.mjs <path to .dmg>");
    process.exitCode = 1;
    return;
  }
  if (process.platform !== "darwin") {
    console.error("dmg-smoke: FAIL — hdiutil only exists on macOS; run this smoke on a macOS host");
    process.exitCode = 1;
    return;
  }
  const dmgPath = resolve(raw);
  if (!isFile(dmgPath)) {
    console.error(`dmg-smoke: FAIL — disk image does not exist: ${dmgPath}`);
    process.exitCode = 1;
    return;
  }

  // Fail closed BEFORE mutating the machine: without the driver the boot
  // stage could never run, so the smoke must not even attach the image.
  const electron = loadElectronLauncher();
  if (!electron) {
    console.error("dmg-smoke: FAIL — playwright-core is not available (npm ci at the repo root installs it)");
    console.error("dmg-smoke: refusing to pass vacuously — the image was NOT mount-tested");
    process.exitCode = 1;
    return;
  }

  const workspace = mkdtempSync(join(tmpdir(), "ocr-dmg-smoke-"));
  const mount = join(workspace, "volume");
  // hdiutil attach -mountpoint requires the directory to exist beforehand.
  mkdirSync(mount, { recursive: true });
  let stderrTail = "";
  const tail = (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4_000);
  };

  try {
    // 1. non-interactive attach: read-only, no Finder browse, no EULA dialog
    console.log(`dmg-smoke: attaching ${basename(dmgPath)}`);
    const attachExit = await runHdiutil(["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, dmgPath], tail);
    const mounted = attachExit.code === 0 && attachExit.signal === null && existsSync(mount);

    // 2. mounted content + Applications shortcut
    const layout = mounted ? mountedLayoutFacts(mount) : { singleAppBundle: false, executable: false, daemonEntry: false, webDist: false, appPath: null };
    const applicationsLink = mounted ? applicationsLinkFacts(mount) : { present: false, targetOk: false };

    // 3. boot the app FROM INSIDE the volume, hermetically (same contract as
    // packaged-boot.mjs) — only when the layout resolved a binary
    let boot = { driverAvailable: true, loadFinished: false, rootEmpty: true, canarySeen: false, consoleErrors: [] };
    if (layout.executable) {
      boot = await bootFromVolume(electron, resolveExecutable(layout.appPath));
    }

    // 4. detach ALWAYS — even when any step above failed or the detach attempt
    // itself dies: the runner must never keep the image mounted. Plain detach
    // first, -force as the retry.
    let detach = { attempted: false, exitCode: null, signal: null };
    try {
      if (mounted) {
        console.log("dmg-smoke: detaching");
        let detachExit = await runHdiutil(["detach", mount], tail);
        if (detachExit.code !== 0 || detachExit.signal !== null) {
          detachExit = await runHdiutil(["detach", "-force", mount], tail);
        }
        detach = { attempted: true, exitCode: detachExit.code, signal: detachExit.signal };
      }
    } finally {
      if (mounted && !detach.attempted) {
        try {
          await runHdiutil(["detach", "-force", mount], () => {});
        } catch {}
      }
    }

    // 5. verdict (after detach: a failed unmount with everything else green
    // is itself a reason)
    const verdict = dmgVerdict({
      attach: { exitCode: attachExit.code, signal: attachExit.signal, mounted },
      layout: {
        singleAppBundle: layout.singleAppBundle,
        executable: layout.executable,
        daemonEntry: layout.daemonEntry,
        webDist: layout.webDist,
      },
      applicationsLink,
      boot,
      detach,
    });

    if (verdict.ok) {
      console.log(`dmg-smoke: OK ${basename(dmgPath)}`);
      console.log(`  ${verdict.message}`);
      process.exitCode = 0;
    } else {
      console.error(`dmg-smoke: FAIL ${basename(dmgPath)} — ${verdict.reason}`);
      console.error(`  ${verdict.message}`);
      if (stderrTail.trim() !== "") {
        console.error(`  tail: ${stderrTail.replace(/\s+/g, " ").trim().slice(-240)}`);
      }
      process.exitCode = 1;
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  main().catch((err) => {
    console.error(`dmg-smoke: uncaught: ${String(err?.stack ?? err).split("\n")[0]}`);
    process.exit(1);
  });
}
