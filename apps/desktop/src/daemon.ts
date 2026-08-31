// Daemon sidecar: the desktop shell owns a local daemon process so the app
// works without a terminal. If a daemon is already healthy on the metrics
// port (launchd/CLI install), we reuse it and never spawn a second one.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DAEMON_METRICS_PORT = Number(process.env.OCR_DAEMON_METRICS_PORT) || 8792;
const HEALTH_TIMEOUT_MS = 30_000;

interface SidecarState {
  child: ChildProcess | null;
  spawned: boolean;
  stopping: boolean;
}

const sidecar: SidecarState = { child: null, spawned: false, stopping: false };

interface DaemonEntry {
  node: string;
  args: string[];
  file: string;
  cwd: string;
}

function stateFile(): string {
  return join(homedir(), ".opencode-remote", "daemon.json");
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

async function healthOnce(port: number, token: string | null): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    // 200 = healthy daemon. 401 without a readable token still proves the
    // daemon HTTP API is up — the auth surface is left untouched.
    return res.status === 200 || (res.status === 401 && token === null);
  } catch {
    return false;
  }
}

/** Poll GET /api/health until it answers or the deadline expires. */
export async function waitForDaemonHealth(
  port: number = DAEMON_METRICS_PORT,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  const token = readApiToken();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthOnce(port, token)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function nodeBinary(): string {
  // ELECTRON_RUN_AS_NODE makes the Electron binary behave as a plain Node
  // runtime, so no system node install is required.
  return process.execPath;
}

function resolveEntry(appPath: string, resourcesPath: string | undefined): DaemonEntry | null {
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
  if (sidecar.child) return true;
  if (await healthOnce(DAEMON_METRICS_PORT, readApiToken())) {
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
      OCR_METRICS_PORT: process.env.OCR_METRICS_PORT ?? String(DAEMON_METRICS_PORT),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  sidecar.child = child;
  sidecar.spawned = true;
  child.on("exit", (code, signal) => {
    if (!sidecar.stopping) {
      console.error(`[desktop] daemon sidecar exited (code=${code} signal=${signal})`);
    }
  });
  console.log(
    `[desktop] daemon sidecar spawned (pid ${child.pid}, metrics :${DAEMON_METRICS_PORT})`,
  );
  return true;
}

/** Terminate the child we spawned (SIGTERM → 3s grace → SIGKILL). Idempotent. */
export async function stopDaemonSidecar(): Promise<void> {
  const child = sidecar.child;
  if (!child || !sidecar.spawned) return;
  sidecar.stopping = true;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
  sidecar.child = null;
  console.log("[desktop] daemon sidecar stopped");
}
