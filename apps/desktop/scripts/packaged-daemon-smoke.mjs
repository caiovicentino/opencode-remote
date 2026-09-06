#!/usr/bin/env node
/**
 * P2-251: real execution smoke for the packaged daemon sidecar (release
 * gate — NOT the pilot gate, docs/PILOT.md). The boot smoke (packaged-boot.mjs)
 * deliberately never spawns a sidecar (OCR_DAEMON_ENTRY points nowhere), and
 * dist-smoke.mjs only checks that resources/daemon/index.js EXISTS — so the
 * bundle produced by bundle-daemon.mjs never ran in any release job. This
 * script closes that gap: it launches the packaged daemon exactly the way
 * apps/desktop/src/daemon.ts does in production and requires an
 * authenticated 200 from /api/health:
 *
 *   - the Electron binary resolved inside the package (resolveExecutable,
 *     same resolution the boot smoke uses) doubles as the Node runtime via
 *     ELECTRON_RUN_AS_NODE=1 — daemon.ts's nodeBinary() contract;
 *   - the entry file is <resources>/daemon/index.js, the same path
 *     resolveEntry() serves to the packaged app;
 *   - hermetic by construction: temp HOME (the daemon's homedir()-based state
 *     lands in a throwaway dir), relay off (invalid RELAY_URL → the daemon's
 *     own fail-closed preflight never opens a socket), ephemeral metrics
 *     port picked by the OS — the real machine state is never touched;
 *   - the child's stdout (which carries the pairing URI) is discarded
 *     unread; stderr is kept only as a bounded tail for the verdict;
 *   - never prints environment content, token or pairing credential.
 *
 * Verdict lives in the pure packaged-daemon-verdict.mjs; every failing rule
 * is printed and the script exits 1. Cleanup (kill + temp dir removal) runs
 * even on failure.
 *
 * Usage: node scripts/packaged-daemon-smoke.mjs <path to .app bundle | win-unpacked dir>
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveExecutable } from "./packaged-boot.mjs";
import { daemonVerdict } from "./packaged-daemon-verdict.mjs";

const HEALTH_TIMEOUT_MS = 45_000;
const POLL_MS = 500;
const PROBE_TIMEOUT_MS = 2_000;
const KILL_GRACE_MS = 3_000;
const WATCHDOG_MS = 120_000;
const TAIL_MAX = 4_000;

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The packaged sidecar entry, by the same layout logic resolveEntry() uses
 * for the packaged app: <resources>/daemon/index.js, with resources at
 * Contents/Resources inside a macOS .app bundle and at resources/ in an
 * unpacked dir. Returns the absolute path or null (→ fail closed).
 */
export function resolveDaemonEntry(appPath) {
  const isMacBundle = basename(appPath).endsWith(".app") && existsSync(join(appPath, "Contents"));
  const resources = isMacBundle ? join(appPath, "Contents", "Resources") : join(appPath, "resources");
  const packed = join(resources, "daemon", "index.js");
  return isFile(packed) ? packed : null;
}

/** One OS-assigned free loopback port for OCR_METRICS_PORT. */
function ephemeralPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Hermetic child env — mirrors daemon.ts's spawnChild (ELECTRON_RUN_AS_NODE,
 * OCR_METRICS_PORT, RELAY_URL) with the state surface pointed at tempHome:
 * the daemon reads homedir()/.opencode-remote/daemon.json, so a temp HOME
 * (USERPROFILE on Windows) keeps the runner's real state untouched. An
 * invalid RELAY_URL flips the daemon's own fail-closed preflight: no relay
 * socket is ever opened.
 */
export function hermeticDaemonEnv(tempHome, port) {
  return {
    ...process.env,
    // Same flag daemon.ts sets: the Electron binary then behaves as plain
    // Node instead of booting a second GUI runtime.
    ELECTRON_RUN_AS_NODE: "1",
    OCR_METRICS_PORT: String(port),
    RELAY_URL: "off", // invalid on purpose → relay disabled (fail-closed)
    HOME: tempHome,
    USERPROFILE: tempHome,
  };
}

/** The daemon's apiToken from its temp state file — never printed. */
function readToken(tempHome) {
  try {
    const raw = JSON.parse(readFileSync(join(tempHome, ".opencode-remote", "daemon.json"), "utf8"));
    return typeof raw?.apiToken === "string" && raw.apiToken.length > 0 ? raw.apiToken : null;
  } catch {
    return null;
  }
}

/** One /api/health probe; resolves the status code or throws. */
async function probeStatus(port, token) {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return res.status;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Terminate the child for good: SIGTERM, then SIGKILL after the grace. */
async function stopChild(child) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  const killer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, KILL_GRACE_MS);
  await new Promise((r) => {
    child.once("exit", r);
    setTimeout(r, KILL_GRACE_MS + 1_000);
  });
  clearTimeout(killer);
}

function printVerdict(verdict, appPath) {
  if (verdict.ok) {
    console.log(`packaged-daemon-smoke: OK ${appPath}`);
    console.log(`  ${verdict.message}`);
  } else {
    console.error(`packaged-daemon-smoke: FAIL ${appPath} — ${verdict.reason}`);
    for (const problem of verdict.problems) console.error(`  - ${problem.message}`);
  }
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("packaged-daemon-smoke: usage — node scripts/packaged-daemon-smoke.mjs <path to .app bundle | win-unpacked dir>");
    process.exitCode = 1;
    return;
  }
  const appPath = resolve(raw);
  if (!existsSync(appPath)) {
    console.error(`packaged-daemon-smoke: FAIL — bundle dir does not exist: ${appPath}`);
    process.exitCode = 1;
    return;
  }

  const executable = resolveExecutable(appPath);
  if (!executable) {
    console.error("packaged-daemon-smoke: FAIL — no app executable inside the package");
    process.exitCode = 1;
    return;
  }
  const daemonEntry = resolveDaemonEntry(appPath);
  if (!daemonEntry) {
    console.error("packaged-daemon-smoke: FAIL — resources/daemon/index.js not found in the package");
    process.exitCode = 1;
    return;
  }

  const port = await ephemeralPort();
  const tempHome = mkdtempSync(join(tmpdir(), "ocr-packaged-daemon-"));
  let child = null;
  let exitCode = null;
  let exitSignal = null;
  let stderrTail = "";
  let healthAnswered = false;
  let healthStatus = null;

  // Hard ceiling so a hung child can never hold the runner: kill + fail.
  const watchdog = setTimeout(() => {
    console.error(`packaged-daemon-smoke: FAIL — exceeded ${WATCHDOG_MS}ms, killing the daemon`);
    try {
      child?.kill("SIGKILL");
    } catch {}
    process.exit(1);
  }, WATCHDOG_MS);

  try {
    child = spawn(executable, [daemonEntry], {
      cwd: dirname(daemonEntry),
      env: hermeticDaemonEnv(tempHome, port),
      // stdout carries the pairing URI — piped but discarded unread so the
      // credential never reaches the log; stderr is kept as a bounded tail.
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.resume();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-TAIL_MAX);
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });

    // Poll /api/health until it answers (or the child died / deadline hit).
    // An unauthenticated first hit makes a fresh daemon generate and persist
    // its apiToken; the authenticated status is the actual proof.
    const startedAt = Date.now();
    const deadline = startedAt + HEALTH_TIMEOUT_MS;
    let elapsedMs = 0;
    while (Date.now() < deadline) {
      if (exitCode !== null || exitSignal !== null) break;
      try {
        await probeStatus(port, null).catch(() => null);
        const token = readToken(tempHome);
        if (token) {
          healthStatus = await probeStatus(port, token);
          healthAnswered = true;
          break;
        }
      } catch {}
      await sleep(POLL_MS);
    }
    elapsedMs = Date.now() - startedAt;

    const verdict = daemonVerdict({ exitCode, signal: exitSignal, elapsedMs, healthAnswered, healthStatus, stderrTail });
    printVerdict(verdict, appPath);
    process.exitCode = verdict.ok ? 0 : 1;
  } finally {
    clearTimeout(watchdog);
    await stopChild(child);
    rmSync(tempHome, { recursive: true, force: true });
  }
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  main().catch((err) => {
    console.error(`packaged-daemon-smoke: uncaught: ${String(err?.stack ?? err).split("\n")[0]}`);
    process.exit(1);
  });
}
