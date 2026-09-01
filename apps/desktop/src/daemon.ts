// Daemon sidecar: the desktop shell owns a local daemon process so the app
// works without a terminal. If a daemon already on the metrics port proves its
// identity (authenticated 200 with the token from the 0600 state file), we
// reuse it and never spawn a second one; an anonymous responder is never trusted.
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
/** Per-request fetch timeout for the challenge + authenticated health probes. */
const PROBE_TIMEOUT_MS = 1500;
/** The daemon prints its pairing URI at boot (apps/daemon/src/index.ts); the
 * URI itself never contains whitespace, so \S* captures it whole. */
const PAIR_URL_RE = /opencode-remote:\/\/pair\?v=2\S*/;
/** Bound on the stdout tail kept around while scanning for the pairing URI. */
const STDOUT_TAIL_MAX = 8192;

/** Respawn backoff (P2-017): 5s → 15s → 45s, then give up. Tests shorten the
 * schedule via OCR_DAEMON_RESPAWN_DELAYS (comma-separated ms) — production
 * never sets it, exactly like the other OCR_DAEMON_* test escape hatches. */
const RESPAWN_DELAYS_MS = (process.env.OCR_DAEMON_RESPAWN_DELAYS ?? "5000,15000,45000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0);
const RESPAWN_MAX_ATTEMPTS = 3;

interface SidecarState {
  child: ChildProcess | null;
  spawned: boolean;
  stopping: boolean;
  exited: boolean;
  /** Token captured once at sidecar start; shared by reuse check + health wait. */
  token: string | null;
  /** First `opencode-remote://pair?v=2&…` URI the child printed on stdout. */
  pairUrl: string | null;
  /** True when an existing daemon was adopted instead of spawned. */
  reused: boolean;
  /** Rolling stdout tail (bounded) scanned for the pairing URI. */
  stdoutTail: string;
  /** Entry resolved at the first successful start; respawns reuse it. */
  entry: DaemonEntry | null;
  /** Consecutive respawn attempts since the last confirmed-healthy daemon. */
  failures: number;
  /** True once RESPAWN_MAX_ATTEMPTS consecutive attempts failed (terminal). */
  gaveUp: boolean;
}

const sidecar: SidecarState = {
  child: null,
  spawned: false,
  stopping: false,
  exited: false,
  token: null,
  pairUrl: null,
  reused: false,
  stdoutTail: "",
  entry: null,
  failures: 0,
  gaveUp: false,
};

/** Pending respawn backoff timer, if any. */
let respawnTimer: NodeJS.Timeout | null = null;

interface DaemonEntry {
  node: string;
  args: string[];
  file: string;
  cwd: string;
}

function stateFile(): string {
  // Test-only escape hatch (scripts/desktop-sidecar.test.ts points it at a
  // throwaway file). The daemon itself IGNORES this variable and always reads
  // the 0600 file under ~/.opencode-remote (apps/daemon/src/index.ts), so in
  // production the two processes agree by construction — never set it outside
  // tests, or the desktop would read a token the spawned daemon doesn't serve.
  return process.env.OCR_DAEMON_STATE_FILE ?? join(homedir(), ".opencode-remote", "daemon.json");
}

/** Same token the daemon serves the web UI with; never logged, never sent elsewhere. */
export function readApiToken(): string | null {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as { apiToken?: string };
    return raw.apiToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Local-squatter token exposure (threat model, documented per round-3 review):
 *
 * Before the bearer token ever leaves this process, the responder must first
 * reproduce the daemon's exact unauthenticated behavior on /api/health — a 401
 * with a JSON body (see `send401` in apps/daemon). A generic "200 for
 * anything" server squatting on the port therefore never receives the token.
 *
 * This is a filter, not a proof: a deliberately malicious local process could
 * mimic the 401 signature and still harvest the token, and any process running
 * as the same user could simply read the 0600 state file instead. The
 * challenge closes the accidental-squatter hole only; that residual risk is
 * accepted because the token grants access to an API that is loopback-bound
 * anyway.
 */
export async function healthOnce(port: number, token: string | null): Promise<boolean> {
  // No token, no identity check: a bare 200 proves nothing about who answers.
  // Callers keep polling until the 0600 state file yields one.
  if (token === null) return false;
  const url = `http://127.0.0.1:${port}/api/health`;
  try {
    // Unauthenticated challenge — deliberately sent WITHOUT the token.
    const probe = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (probe.status !== 401 || !probe.headers.get("content-type")?.startsWith("application/json")) {
      return false;
    }
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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

/**
 * The `opencode-remote://pair?v=2&…` URI the spawned daemon printed at boot
 * (captured from its stdout), or null when the daemon was reused instead of
 * spawned (no stdout to read) or nothing was printed yet. Lets the desktop
 * UI pair itself with zero friction on the host machine (docs/VISION.md
 * stage 3.1) through the same code path as paste-pairing.
 */
export function getPairUrl(): string | null {
  if (sidecar.pairUrl) return sidecar.pairUrl;
  if (!sidecar.reused) return null; // fresh spawn: URI arrives on stdout only
  // Reuse path: a daemon we didn't spawn has no stdout to scan — but it logs
  // the pairing URI at boot. Recover it from the daemon log (same machine).
  try {
    const log = readFileSync(join(homedir(), ".opencode-remote", "logs", "daemon.log"), "utf8");
    const m = log.match(PAIR_URL_RE);
    return m ? m[0] : null;
  } catch {
    return null;
  }
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
  // Reuse only on proven identity: with a null token we cannot authenticate
  // the responder at all, so short-circuiting would "adopt" whatever process
  // squats on the port and never spawn the real daemon.
  if (sidecar.token !== null && (await healthOnce(DAEMON_METRICS_PORT, sidecar.token))) {
    console.log(`[desktop] daemon already running on :${DAEMON_METRICS_PORT} — reusing it`);
    sidecar.reused = true; // enables the daemon.log pair-URI fallback
    return true;
  }

  const entry = resolveEntry(appPath, resourcesPath);
  if (!entry) {
    console.error(
      "[desktop] no daemon entry found — set OCR_DAEMON_ENTRY or run npm install at the repo root",
    );
    return false;
  }
  sidecar.entry = entry;
  spawnChild(entry);
  return true;
}

/** Spawn + wire one daemon child (used by the initial start and by respawns). */
function spawnChild(entry: DaemonEntry): void {
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
    // stdout is piped (not inherited) so we can capture the boot pairing URI;
    // each chunk is forwarded to our own stdout, preserving the old behavior.
    stdio: ["ignore", "pipe", "inherit"],
  });
  sidecar.child = child;
  sidecar.spawned = true;
  sidecar.exited = false;
  // Fresh spawn → fresh capture: the previous URI belongs to a dead daemon.
  sidecar.pairUrl = null;
  sidecar.reused = false;
  sidecar.stdoutTail = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    try {
      process.stdout.write(chunk);
    } catch {
      /* packaged headless runs may have no stdout attached */
    }
    if (sidecar.pairUrl) return;
    sidecar.stdoutTail = (sidecar.stdoutTail + chunk).slice(-STDOUT_TAIL_MAX);
    sidecar.pairUrl = PAIR_URL_RE.exec(sidecar.stdoutTail)?.[0] ?? null;
  });
  child.on("exit", () => {
    sidecar.exited = true;
    if (!sidecar.stopping) {
      console.error(`[desktop] daemon sidecar exited (code=${child.exitCode} signal=${child.signalCode})`);
      scheduleRespawn();
    }
  });
  // Spawn failures (ENOENT, cwd missing) emit "error" without "exit".
  child.on("error", (err) => {
    sidecar.exited = true;
    if (!sidecar.stopping) {
      console.error(`[desktop] daemon sidecar failed: ${err.message}`);
      scheduleRespawn();
    }
  });
  console.log(`[desktop] daemon sidecar spawned (pid ${child.pid}, metrics :${DAEMON_METRICS_PORT})`);
}

/**
 * P2-017: keep the UI connected when the sidecar dies at runtime (crash, OOM,
 * stray kill). Each unintentional exit schedules one respawn with growing
 * backoff; the failure counter resets as soon as waitForDaemonHealth() gets a
 * 200 again. After RESPAWN_MAX_ATTEMPTS consecutive failures the shell gives
 * up (logged loudly) and the UI is told via the pairing-state channel.
 */
function scheduleRespawn(): void {
  if (sidecar.stopping || sidecar.gaveUp) return;
  sidecar.failures += 1;
  if (sidecar.failures > RESPAWN_MAX_ATTEMPTS) {
    sidecar.gaveUp = true;
    console.error("[desktop] daemon sidecar gave up after 3 attempts");
    return;
  }
  const delay = RESPAWN_DELAYS_MS[Math.min(sidecar.failures - 1, RESPAWN_DELAYS_MS.length - 1)] ?? 45_000;
  console.log(
    `[desktop] daemon sidecar respawn in ${Math.round(delay / 1000)}s (attempt ${sidecar.failures}/${RESPAWN_MAX_ATTEMPTS})`,
  );
  if (respawnTimer) clearTimeout(respawnTimer);
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    void respawn();
  }, delay);
}

/** One backoff-driven respawn attempt. */
async function respawn(): Promise<void> {
  const entry = sidecar.entry;
  if (!entry || sidecar.stopping || sidecar.gaveUp) return;
  if (sidecar.child && !sidecar.exited) return; // recovered meanwhile
  sidecar.token = readApiToken();
  // An authenticated daemon on the port (e.g. a launchd install the user
  // started after the crash) counts as recovered — spawning on top of it
  // would just crash-loop on the busy port.
  if (sidecar.token !== null && (await healthOnce(DAEMON_METRICS_PORT, sidecar.token))) {
    console.log(`[desktop] daemon already healthy again on :${DAEMON_METRICS_PORT} — no respawn needed`);
    sidecar.child = null;
    sidecar.spawned = false;
    sidecar.reused = true;
    sidecar.failures = 0;
    return;
  }
  spawnChild(entry);
  // 200 → the sidecar is doing its job again; a fresh crash budget starts.
  void waitForDaemonHealth().then((healthy) => {
    if (healthy) {
      sidecar.failures = 0;
      sidecar.gaveUp = false;
    }
  });
}

/** True once the respawn budget is exhausted and the shell stopped retrying. */
export function isDaemonDown(): boolean {
  return sidecar.gaveUp;
}

/** Diagnostic view into the respawn bookkeeping (eval battery asserts on it). */
export function respawnState(): { failures: number; gaveUp: boolean } {
  return { failures: sidecar.failures, gaveUp: sidecar.gaveUp };
}

/** Terminate the child we spawned (SIGTERM → 3s grace → SIGKILL). Idempotent. */
export async function stopDaemonSidecar(): Promise<void> {
  // A pending respawn must never fire after (or during) an intentional stop.
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  sidecar.failures = 0;
  sidecar.gaveUp = false;
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
