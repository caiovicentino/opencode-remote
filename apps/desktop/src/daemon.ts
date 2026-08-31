// Daemon sidecar: the desktop shell owns a local daemon process so the app
// works without a terminal. If a daemon is already healthy on the metrics
// port (launchd/CLI install), we reuse it and never spawn a second one.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Single source of truth for the daemon API port: the desktop polls the exact
// port the spawned child binds. OCR_DAEMON_METRICS_PORT is the desktop-facing
// override; OCR_METRICS_PORT (the daemon's own variable) is honored as a
// fallback so a shell that already configured it stays consistent.
export const DAEMON_METRICS_PORT =
  Number(process.env.OCR_DAEMON_METRICS_PORT) || Number(process.env.OCR_METRICS_PORT) || 8792;
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 500;

interface SidecarState {
  child: ChildProcess | null;
  spawned: boolean;
  stopping: boolean;
  exited: boolean;
  /** Token captured once at sidecar start; shared by reuse check + health wait. */
  token: string | null;
}

const sidecar: SidecarState = { child: null, spawned: false, stopping: false, exited: false, token: null };

interface DaemonEntry {
  node: string;
  args: string[];
  file: string;
  cwd: string;
}

function stateFile(): string {
  // OCR_DAEMON_STATE_FILE exists for tests/multi-home setups; production
  // always uses the 0600 file under ~/.opencode-remote.
  return process.env.OCR_DAEMON_STATE_FILE ?? join(homedir(), ".opencode-remote", "daemon.json");
}

/** Same token the daemon serves the web UI with; never logged, never sent elsewhere. */
function readApiToken(): string | null {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as { apiToken?: string };
    return raw.apiToken ?? null;
  } catch {
    return null;
  }
}

/**
 * A responder only counts as healthy when it answers 200 *with our bearer
 * token* — a bare 401 can come from any local process that squatted on the
 * port, so it is never accepted as proof of identity.
 */
export async function healthOnce(port: number, token: string | null): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export interface HealthWaitOptions {
  port?: number;
  timeoutMs?: number;
  /** Token captured at sidecar start; omit to read the 0600 state file. */
  token?: string | null;
}

/** Poll GET /api/health until it answers or the deadline expires. */
export async function waitForDaemonHealth(opts: HealthWaitOptions = {}): Promise<boolean> {
  const port = opts.port ?? DAEMON_METRICS_PORT;
  let token = opts.token !== undefined ? opts.token : (sidecar.token ?? readApiToken());
  const deadline = Date.now() + (opts.timeoutMs ?? HEALTH_TIMEOUT_MS);
  while (Date.now() < deadline) {
    // The child we spawned is gone — no point waiting out the full timeout.
    if (sidecar.spawned && sidecar.exited) return false;
    // Fresh install: the daemon generates its first token on the very poll
    // below, so keep re-reading while we have none (memoized once found).
    if (token === null) token = readApiToken();
    if (await healthOnce(port, token)) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

function nodeBinary(): string {
  // The Electron binary doubles as the Node runtime (via ELECTRON_RUN_AS_NODE
  // in the spawn env), so no system node install is required.
  return process.execPath;
}

export function resolveEntry(appPath: string, resourcesPath: string | undefined): DaemonEntry | null {
  const override = process.env.OCR_DAEMON_ENTRY;
  if (override) {
    if (!existsSync(override)) return null;
    return { node: nodeBinary(), args: [], file: override, cwd: dirname(override) };
  }
  // Packaged app: electron-builder extraResources can ship a compiled daemon.
  if (resourcesPath) {
    const packed = join(resourcesPath, "daemon", "index.js");
    if (existsSync(packed)) {
      return { node: nodeBinary(), args: [], file: packed, cwd: join(resourcesPath, "daemon") };
    }
  }
  // Dev checkout: run the TypeScript source through the workspace tsx install.
  const root = join(appPath, "..", ".."); // apps/desktop → repo root
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const daemonSrc = join(root, "apps", "daemon", "src", "index.ts");
  if (existsSync(tsxCli) && existsSync(daemonSrc)) {
    return {
      node: nodeBinary(),
      args: [tsxCli],
      file: daemonSrc,
      cwd: join(root, "apps", "daemon"),
    };
  }
  return null;
}

/**
 * Spawn the daemon as a child process unless one is already healthy.
 * Returns true when a daemon is expected to answer on the metrics port.
 */
export async function startDaemonSidecar(
  appPath: string,
  resourcesPath: string | undefined,
): Promise<boolean> {
  if (sidecar.child && !sidecar.exited) return true;

  // One token read shared by the reuse check and (via sidecar.token) the
  // post-spawn health wait — no TOCTOU on a token rotated between the two.
  sidecar.token = readApiToken();
  if (await healthOnce(DAEMON_METRICS_PORT, sidecar.token)) {
    console.log(`[desktop] daemon already running on :${DAEMON_METRICS_PORT} — reusing it`);
    return true;
  }

  const entry = resolveEntry(appPath, resourcesPath);
  if (!entry) {
    console.error(
      "[desktop] no daemon entry found — set OCR_DAEMON_ENTRY or run npm install at the repo root",
    );
    return false;
  }

  const child = spawn(entry.node, [...entry.args, entry.file], {
    cwd: entry.cwd,
    env: {
      ...process.env,
      // process.execPath is the Electron binary: without this flag it boots a
      // second full Electron runtime instead of a plain Node one.
      ELECTRON_RUN_AS_NODE: "1",
      // Must match the port waitForDaemonHealth() polls (single source above).
      OCR_METRICS_PORT: String(DAEMON_METRICS_PORT),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  sidecar.child = child;
  sidecar.spawned = true;
  sidecar.exited = false;
  child.on("exit", () => {
    sidecar.exited = true;
    if (!sidecar.stopping) {
      console.error(`[desktop] daemon sidecar exited (code=${child.exitCode} signal=${child.signalCode})`);
    }
  });
  // Spawn failures (ENOENT, cwd missing) emit "error" without "exit".
  child.on("error", (err) => {
    sidecar.exited = true;
    if (!sidecar.stopping) console.error(`[desktop] daemon sidecar failed: ${err.message}`);
  });
  console.log(`[desktop] daemon sidecar spawned (pid ${child.pid}, metrics :${DAEMON_METRICS_PORT})`);
  return true;
}

/** Terminate the child we spawned (SIGTERM → 3s grace → SIGKILL). Idempotent. */
export async function stopDaemonSidecar(): Promise<void> {
  const child = sidecar.child;
  if (!child || !sidecar.spawned) return;
  sidecar.spawned = false;
  // Already gone (crashed, exited early) — nothing to signal, skip the grace.
  if (sidecar.exited || child.exitCode !== null || child.signalCode !== null) {
    sidecar.child = null;
    return;
  }
  sidecar.stopping = true;
  await new Promise<void>((resolve) => {
    // Resolve only on "exit" so callers observe a fully dead, reaped child;
    // the timer merely escalates SIGTERM → SIGKILL after the grace period.
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
  sidecar.child = null;
  sidecar.stopping = false;
  console.log("[desktop] daemon sidecar stopped");
}
