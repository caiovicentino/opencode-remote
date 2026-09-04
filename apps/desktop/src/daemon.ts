// Daemon sidecar: the desktop shell owns a local daemon process so the app
// works without a terminal. If a daemon already on the metrics port proves its
// identity (authenticated 200 with the token from the 0600 state file), we
// reuse it and never spawn a second one; an anonymous responder is never trusted.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { log, logError } from "./desktop-log";
import { teeSidecarChunk } from "./sidecar-log";
import { classifySidecarExit, type SidecarExitVerdict } from "./sidecarexit";
import { candidatePorts, pickDaemonPort, type DaemonPortReason } from "./daemonport";

// Single source of truth for the daemon API port: the desktop polls the exact
// port the spawned child binds. OCR_DAEMON_METRICS_PORT is the desktop-facing
// override; OCR_METRICS_PORT (the daemon's own variable) is honored as a
// fallback so a shell that already configured it stays consistent. This is the
// PREFERRED port — P2-143 lets the actual port drift to a deterministic
// fallback (8793–8796) when something else already owns the preferred one.
export const DAEMON_METRICS_PORT =
  Number(process.env.OCR_DAEMON_METRICS_PORT) || Number(process.env.OCR_METRICS_PORT) || 8792;

// --- P2-143: one-shot daemon port resolution ----------------------------------

/** The resolved daemon port (null until startDaemonSidecar resolved it once). */
let resolvedPort: number | null = null;
/** Why the resolved port was chosen; logged once, surfaced in diagnostics. */
let resolvedReason: DaemonPortReason | null = null;

/** The port the daemon answers on this session (resolved or the preferred
 * default). Callers must read this instead of the DAEMON_METRICS_PORT
 * constant so every surface follows the fallback decision. */
export function activeDaemonPort(): number {
  return resolvedPort ?? DAEMON_METRICS_PORT;
}

/** Why activeDaemonPort() is the right port ("reused" | "preferred" |
 * "fallback" | "none"), or null before the one-shot resolution ran. */
export function daemonPortReason(): DaemonPortReason | null {
  return resolvedReason;
}

/**
 * Bind-probe a loopback port and close it immediately — "can I listen here?"
 * never leaves the machine. Lives here (not in the pure daemonport module)
 * because node:net must not leak into unit-test land.
 */
function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Resolve the daemon port exactly once per process (P2-143): walk the
 * candidate list — preferred port first, then the deterministic fallbacks —
 * adopting a port that already runs OUR daemon ("reused") or the first free
 * one. An env override (OCR_DAEMON_METRICS_PORT / OCR_METRICS_PORT) keeps
 * candidatePorts at a single entry, so the behavior is byte-for-byte the old
 * fixed-port one. The reason is logged once here and never again by the
 * respawn/watchdog paths — they reuse the decision via activeDaemonPort().
 */
async function resolveDaemonPortOnce(): Promise<void> {
  if (resolvedPort !== null) return;
  const pick = await pickDaemonPort(
    candidatePorts(DAEMON_METRICS_PORT),
    isLoopbackPortFree,
    (p) => healthOnce(p, sidecar.token),
  );
  resolvedPort = pick.port;
  resolvedReason = pick.reason;
  log(`[desktop] daemon port ${pick.port} (${pick.reason})`);
}
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

/** Hard cap for the adopted-daemon reconnect backoff (P1-053): an outage of
 * any length keeps probing at most every 30s, forever. */
const RECONNECT_DELAY_CAP_MS = 30_000;
/** Production fallback for reconnectDelayMs — the same 5s/15s/45s schedule. */
const RECONNECT_BASE_SCHEDULE = [5_000, 15_000, 45_000];

/**
 * P1-053: pure reconnect backoff for an adopted daemon. `n` (1-based) indexes
 * the base schedule, then keeps doubling past its end, capped at 30s — so the
 * production curve is 5s → 15s → 30s → 30s → … and a 5-minute outage still
 * gets ≥10 probes. Tests shorten the runtime schedule via
 * OCR_DAEMON_RESPAWN_DELAYS (passed explicitly by the watchdog); the default
 * argument keeps this function honest without env setup.
 */
export function reconnectDelayMs(n: number, schedule: number[] = RECONNECT_BASE_SCHEDULE): number {
  const list = schedule.length > 0 ? schedule : RECONNECT_BASE_SCHEDULE;
  const base = list[Math.min(Math.max(n, 1) - 1, list.length - 1)] ?? 45_000;
  return Math.min(RECONNECT_DELAY_CAP_MS, base * 2 ** Math.max(0, n - list.length));
}

/** Test-only escape hatch (tools/desktop.mjs, P1-051): reports the sidecar as
 * permanently down without spawning anything, so a hermetic launch gets the
 * deterministic daemon-down pairing state instead of null. Never set in
 * production — same policy as the other OCR_DAEMON_* test variables. */
const FORCE_DAEMON_DOWN = process.env.OCR_DAEMON_FORCE_DOWN === "1";

/** Test-only escape hatch (scripts/desktop-flow.test.ts, P1-053): forces the
 * "reconnecting" degradation state so a hermetic launch gets the yellow banner
 * deterministically. Never set in production — same policy as FORCE_DOWN. */
const FORCE_RECONNECTING = process.env.OCR_DAEMON_FORCE_RECONNECTING === "1";

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
  /** P2-140: rolling stderr tail (same bound) — searched for exit-cause
   * markers (EADDRINUSE, ENOENT) when the child dies. */
  stderrTail: string;
  /** P2-140: classification of the last unintentional exit (null before the
   * first one, cleared on intentional stop / recovery). */
  exit: SidecarExitVerdict | null;
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
  stderrTail: "",
  exit: null,
  entry: null,
  failures: 0,
  gaveUp: false,
};

/** Pending respawn backoff timer, if any. */
let respawnTimer: NodeJS.Timeout | null = null;

// --- adopted-daemon reconnect watchdog (P1-053) -------------------------------
// When the shell reuses an external daemon (launchd/CLI on :8792) there is no
// child to respawn and no budget to exhaust: losing it is not terminal, so the
// shell keeps probing forever with honest UI degradation instead of giving up.

/** True while a watchdog loop is armed (an adopted daemon is being tracked). */
let watchdogArmed = false;
/** Pending watchdog probe timer, if any. */
let reconnectTimer: NodeJS.Timeout | null = null;
/** Consecutive failed probes since the loss was detected. */
let reconnectAttempts = 0;
/** True from the first failed probe until the next successful one. */
let reconnectActive = false;

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

/** P1-070: the 0600 state file path — test-only override honored, the same
 * file every other shell read/write resolves through stateFile(). */
export function stateFilePath(): string {
  return stateFile();
}

/** P1-070: parsed view of the 0600 state file for the local-mode IPCs —
 * app:localLink now needs room + ecdhPub besides the token so the renderer can
 * derive the local pairing without any pairing-uri round-trip. Same file and
 * same test-only OCR_DAEMON_STATE_FILE override as readApiToken (in production
 * the shell and the daemon agree on the path by construction). */
export function readDaemonState(): { apiToken?: string; room?: string; ecdhPub?: string } | null {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as {
      apiToken?: string;
      room?: string;
      ecdhPub?: string;
    };
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

/** P2-138: upstream (agent server / opencode) detail from /api/health — the
 * P2-135 classifier verdict as-is. Static pt-BR strings from the daemon; the
 * renderer only ever renders them as text. */
export interface DaemonUpstreamDetail {
  state: string;
  reason: string;
  hint: string;
  checkedAt: string | null;
}

export interface DaemonHealthInfo {
  version: string | null;
  /** null when absent/malformed (legacy daemon) — additive, never an error. */
  opencode: DaemonUpstreamDetail | null;
}

/** Tolerant read of the P2-135 opencode object: only a well-shaped object
 * passes; anything else degrades to null instead of leaking junk into the UI. */
function toUpstreamDetail(raw: unknown): DaemonUpstreamDetail | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as { state?: unknown; reason?: unknown; hint?: unknown; checkedAt?: unknown };
  if (typeof o.state !== "string" || o.state === "") return null;
  return {
    state: o.state,
    reason: typeof o.reason === "string" ? o.reason : "",
    hint: typeof o.hint === "string" ? o.hint : "",
    checkedAt: typeof o.checkedAt === "string" ? o.checkedAt : null,
  };
}

/**
 * P3-054: authenticated GET /api/health returning the daemon's own version
 * string (null when unreachable, unauthorized or malformed). The pairing
 * watcher calls this on every poll so the version-mismatch banner always
 * reflects the daemon that is actually answering right now — including one the
 * user replaced externally while the app stayed open.
 * P2-138: the same response also carries the upstream `opencode` detail
 * object; one loopback call per poll serves both consumers.
 */
export async function fetchDaemonHealth(token: string | null): Promise<DaemonHealthInfo> {
  if (token === null) return { version: null, opencode: null };
  try {
    const res = await fetch(`http://127.0.0.1:${activeDaemonPort()}/api/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return { version: null, opencode: null };
    const body = (await res.json().catch(() => ({}))) as { version?: unknown; opencode?: unknown };
    return {
      version: typeof body.version === "string" ? body.version : null,
      opencode: toUpstreamDetail(body.opencode),
    };
  } catch {
    return { version: null, opencode: null };
  }
}

/** Poll GET /api/health until it answers or the deadline expires. */
export async function waitForDaemonHealth(opts: HealthWaitOptions = {}): Promise<boolean> {
  const port = opts.port ?? activeDaemonPort();
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
  // P2-143: pick the port once, before any adoption/spawn decision. With a
  // null token the healthOnce injection always answers false (no identity
  // proof, no adoption), so the walk degrades to preferred/fallback/none.
  const firstResolution = resolvedPort === null;
  await resolveDaemonPortOnce();
  const port = activeDaemonPort();
  // Reuse only on proven identity: on the first call the port pick already ran
  // the authenticated probe (a "reused" verdict IS the proof); an anonymous
  // squatter can never adopt. Later calls re-probe on the resolved port —
  // the state file/responder may have changed under us — same as pre-P2-143.
  const reuse =
    (firstResolution && resolvedReason === "reused") ||
    (!firstResolution && sidecar.token !== null && (await healthOnce(port, sidecar.token)));
  if (reuse) {
    log(`[desktop] daemon already running on :${port} — reusing it`);
    sidecar.reused = true; // enables the daemon.log pair-URI fallback
    // P1-053: an adopted daemon is not our child — track its health forever
    // instead of relying on the (hosted-only) respawn budget.
    startReconnectWatchdog();
    // P3-017: also remember how a replacement could be spawned so the manual
    // restart (restartDaemon) can act when an adopted daemon turns unstable.
    const adopted = resolveEntry(appPath, resourcesPath);
    if (adopted) sidecar.entry = adopted;
    return true;
  }

  const entry = resolveEntry(appPath, resourcesPath);
  if (!entry) {
    logError(
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
  // We're taking over with our own child again: the adopted-daemon watchdog
  // belongs to the reuse mode and must never probe (or state) alongside it.
  stopReconnectWatchdog();
  const child = spawn(entry.node, [...entry.args, entry.file], {
    cwd: entry.cwd,
    env: {
      ...process.env,
      // process.execPath is the Electron binary: without this flag it boots a
      // second full Electron runtime instead of a plain Node one.
      ELECTRON_RUN_AS_NODE: "1",
      // Must match the port waitForDaemonHealth() polls (single source above).
      OCR_METRICS_PORT: String(activeDaemonPort()),
    },
    // stdout is piped (not inherited) so we can capture the boot pairing URI;
    // each chunk is forwarded to our own stdout, preserving the old behavior.
    // stderr switched from "inherit" to "pipe" (P3-018) so both streams can be
    // teed into userData/logs/daemon-sidecar.log — inherit is invisible in the
    // packaged app, where the stage-5 user has no terminal at all.
    stdio: ["ignore", "pipe", "pipe"],
  });
  sidecar.child = child;
  sidecar.spawned = true;
  sidecar.exited = false;
  // Fresh spawn → fresh capture: the previous URI belongs to a dead daemon.
  sidecar.pairUrl = null;
  sidecar.reused = false;
  sidecar.stdoutTail = "";
  sidecar.stderrTail = "";
  sidecar.exit = null;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    try {
      process.stdout.write(chunk);
    } catch {
      /* packaged headless runs may have no stdout attached */
    }
    // P3-018: raw chunk also lands in userData/logs/daemon-sidecar.log (no-op
    // until main.ts installs the tee). Never throws.
    teeSidecarChunk(chunk);
    if (sidecar.pairUrl) return;
    sidecar.stdoutTail = (sidecar.stdoutTail + chunk).slice(-STDOUT_TAIL_MAX);
    sidecar.pairUrl = PAIR_URL_RE.exec(sidecar.stdoutTail)?.[0] ?? null;
  });
  // P3-018: stderr was inherited before — same packaged-app invisibility as
  // stdout had. Forward to our own stderr (dev keeps the terminal view) and
  // tee into the same sidecar log file the stdout chunks go to. P2-140: the
  // chunk also feeds the bounded tail the exit classifier reads.
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    try {
      process.stderr.write(chunk);
    } catch {
      /* packaged headless runs may have no stderr attached */
    }
    teeSidecarChunk(chunk);
    sidecar.stderrTail = (sidecar.stderrTail + chunk).slice(-STDOUT_TAIL_MAX);
  });
  child.on("exit", (code, signal) => {
    sidecar.exited = true;
    // P2-140: remember WHY it died (port busy, missing entry, signal…); an
    // intentional stop never overwrites the verdict — it clears it below.
    if (!sidecar.stopping) {
      sidecar.exit = classifySidecarExit({
        code,
        signal,
        stderrTail: sidecar.stderrTail,
      });
    }
    if (!sidecar.stopping) {
      logError(
        `[desktop] daemon sidecar exited (code=${code} signal=${signal})` +
          (sidecar.exit ? ` — ${sidecar.exit.kind}: ${sidecar.exit.reason}` : ""),
      );
      scheduleRespawn();
    }
  });
  // Spawn failures (ENOENT, cwd missing) emit "error" without "exit".
  child.on("error", (err) => {
    sidecar.exited = true;
    if (!sidecar.stopping) {
      // P2-140: a spawn-level failure carries its cause in err.message
      // ("spawn … ENOENT") — run it through the same classifier so the UI
      // says the install looks broken instead of a bare "daemon down".
      sidecar.exit = classifySidecarExit({ code: null, signal: null, stderrTail: err.message });
      logError(`[desktop] daemon sidecar failed: ${err.message}`);
      scheduleRespawn();
    }
  });
  log(`[desktop] daemon sidecar spawned (pid ${child.pid}, metrics :${activeDaemonPort()})`);
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
    logError("[desktop] daemon sidecar gave up after 3 attempts");
    return;
  }
  const delay = RESPAWN_DELAYS_MS[Math.min(sidecar.failures - 1, RESPAWN_DELAYS_MS.length - 1)] ?? 45_000;
  log(
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
  if (sidecar.token !== null && (await healthOnce(activeDaemonPort(), sidecar.token))) {
    log(`[desktop] daemon already healthy again on :${activeDaemonPort()} — no respawn needed`);
    sidecar.child = null;
    sidecar.spawned = false;
    sidecar.reused = true;
    sidecar.failures = 0;
    sidecar.exit = null; // recovered — the last crash verdict is history
    // Adopted again → the infinite reconnect watchdog takes over (P1-053).
    startReconnectWatchdog();
    return;
  }
  spawnChild(entry);
  // 200 → the sidecar is doing its job again; a fresh crash budget starts.
  void waitForDaemonHealth().then((healthy) => {
    if (healthy) {
      sidecar.failures = 0;
      sidecar.gaveUp = false;
      sidecar.exit = null;
    }
  });
}

/** True once the respawn budget is exhausted and the shell stopped retrying. */
export function isDaemonDown(): boolean {
  return FORCE_DAEMON_DOWN || sidecar.gaveUp;
}

/** Diagnostic view into the respawn bookkeeping (eval battery asserts on it). */
export function respawnState(): { failures: number; gaveUp: boolean } {
  return { failures: sidecar.failures, gaveUp: sidecar.gaveUp };
}

/** P2-140: why the sidecar died last (classifier verdict), or null while no
 * unintentional exit has happened. Copied, so callers can never mutate the
 * live classification — additive surface next to respawnState(). */
export function sidecarExitInfo(): SidecarExitVerdict | null {
  return sidecar.exit ? { ...sidecar.exit } : null;
}

/**
 * P1-053: honest degradation for an adopted daemon that vanished. While the
 * watchdog keeps probing, `reconnecting` is true and `attempts` counts the
 * failed probes — the UI shows an active yellow "reconnecting…" banner (never
 * the terminal daemon-down state, which stays hosted-mode-only).
 */
export function reconnectState(): { reconnecting: boolean; attempts: number } {
  if (FORCE_RECONNECTING) return { reconnecting: true, attempts: Math.max(1, reconnectAttempts) };
  return { reconnecting: reconnectActive, attempts: reconnectAttempts };
}

/** Arm the watchdog after an adoption (sidecar.reused = true). Idempotent. */
function startReconnectWatchdog(): void {
  if (watchdogArmed) return;
  watchdogArmed = true;
  log(`[desktop] adopted daemon watchdog armed on :${activeDaemonPort()} (infinite reconnect)`);
  scheduleReconnectProbe(0);
}

/**
 * Disarm the watchdog: no probe may fire after (or during) an intentional
 * stop, a fresh spawn of our own child, or a restart — and the transient
 * reconnect state never outlives the condition that caused it.
 */
function stopReconnectWatchdog(): void {
  watchdogArmed = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectActive = false;
  reconnectAttempts = 0;
}

/** One self-scheduling probe; runs forever while the watchdog stays armed. */
function scheduleReconnectProbe(afterMs: number): void {
  if (!watchdogArmed) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void reconnectProbe();
  }, afterMs);
}

async function reconnectProbe(): Promise<void> {
  if (!watchdogArmed) return;
  const healthy = await healthOnce(activeDaemonPort(), sidecar.token ?? readApiToken());
  // An intentional stop/fresh spawn may have happened during the probe.
  if (!watchdogArmed) return;
  if (healthy) {
    if (reconnectActive) {
      log(`[desktop] adopted daemon healthy again on :${activeDaemonPort()} — reconnected after ${reconnectAttempts} attempt(s)`);
    }
    reconnectActive = false;
    reconnectAttempts = 0;
  } else {
    if (!reconnectActive) {
      log(`[desktop] adopted daemon lost on :${activeDaemonPort()} — reconnecting with infinite backoff (no spawn, no give-up)`);
    }
    reconnectActive = true;
    reconnectAttempts += 1;
  }
  scheduleReconnectProbe(reconnectDelayMs(reconnectActive ? reconnectAttempts : 1, RESPAWN_DELAYS_MS));
}

/** Terminate the child we spawned (SIGTERM → 3s grace → SIGKILL). Idempotent. */
export async function stopDaemonSidecar(): Promise<void> {
  // A pending respawn must never fire after (or during) an intentional stop,
  // and neither may an adopted-daemon reconnect probe (P1-053).
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  stopReconnectWatchdog();
  sidecar.failures = 0;
  sidecar.gaveUp = false;
  sidecar.exit = null; // an intentional stop is not a crash to explain
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
  log("[desktop] daemon sidecar stopped");
}

/**
 * P3-017: manual recovery behind the tray's "Restart daemon" action. Covers
 * the states the automatic respawn cannot fix — the respawn budget exhausted
 * (gaveUp) or an adopted daemon gone unstable — without making the user quit
 * and relaunch the app.
 *
 * Best-effort by contract: the whole body is try/caught and log-only, so a
 * tray click can never take the shell down. With no entry resolved yet (no
 * successful start, e.g. a dev checkout without tsx) it is a logged no-op.
 */
export async function restartDaemon(): Promise<boolean> {
  const entry = sidecar.entry;
  if (!entry) {
    log("[desktop] restart daemon: no daemon entry (no successful start yet) — nothing to restart");
    return false;
  }
  try {
    // A pending respawn must never fire into (or after) the manual restart.
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
    // Fresh crash budget: the user explicitly asked for another recovery round.
    sidecar.failures = 0;
    sidecar.gaveUp = false;
    await stopDaemonSidecar();
    sidecar.token = readApiToken();
    // Our own child is gone; an adopted/launchd daemon may still own the port.
    // Reuse it instead of crash-looping a fresh spawn against the busy port.
    if (sidecar.token !== null && (await healthOnce(activeDaemonPort(), sidecar.token))) {
      log(`[desktop] restart daemon: daemon healthy on :${activeDaemonPort()} — reusing it`);
      sidecar.reused = true;
      // Adopted again → re-arm the infinite reconnect watchdog (P1-053).
      startReconnectWatchdog();
      return true;
    }
    spawnChild(entry);
    return true;
  } catch (err) {
    logError("[desktop] restart daemon failed:", err);
    return false;
  }
}
