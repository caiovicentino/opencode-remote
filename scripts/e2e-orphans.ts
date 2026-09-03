/**
 * P1-081: hermetic e2e pre-flight — orphan reaping + dynamic-port booting.
 *
 * Two problems this solves:
 *   1. Zombies from a killed previous gate run (electron/daemon/relay under a
 *      temp dir) linger and race the next run. The pre-flight kills ONLY
 *      processes that match BOTH an argv marker (the e2e component) AND an
 *      env marker (the hermetic temp convention `mkdtemp(<tmpdir>/ocr-*)` or
 *      one of the OCR_* test hatches). The symmetry rule is mandatory: every
 *      marker needs the second env factor — argv substring alone could match
 *      the operator's REAL dev app and must never be enough to kill.
 *   2. A child server booted on a reserved-then-closed port can lose the race
 *      to a port thief: the thief answers the readiness probe and the test
 *      trusts it. bootOnEphemeralPort() only trusts a readiness answer while
 *      the child is still alive (settled() covers signal deaths too) and, on
 *      any failure, prints `lsof` output naming whoever holds the port.
 *
 * Run directly as the e2e pre-flight: npx tsx scripts/e2e-orphans.ts
 * Imported as a helper by scripts/integration.ts and scripts/chunk.test.ts.
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** argv markers for the three e2e component kinds. Match = substring of the
 * full `ps` command line. Never kill on these alone (see envHasTempMarker). */
export const E2E_ARGV_MARKERS: { label: string; argvMarker: string }[] = [
  { label: "daemon", argvMarker: "apps/daemon/src/index.ts" },
  { label: "relay", argvMarker: "apps/relay/src/index.ts" },
  { label: "desktop", argvMarker: "apps/desktop" },
];

/** Env keys whose PRESENCE (any value) proves a hermetic e2e launch — the
 * same test-only OCR_* hatch policy used everywhere else. */
export const HERMETIC_ENV_KEYS = ["OCR_E2E_MARKER", "OCR_DESKTOP_SESSION", "OCR_USER_DATA_DIR"] as const;

export interface OrphanCandidate {
  pid: number;
  command: string;
  marker: string;
}

/**
 * The second kill factor, mandatory for ALL markers (P1-081 symmetry rule):
 * true when the environment carries the shared mkdtemp convention of every
 * e2e here (`<tmpdir>/ocr-...`, e.g. HOME=/var/.../T/ocr-int-XYZ) or one of
 * the test-only hatch keys is set. A real operator environment (real HOME,
 * no OCR_* hatches) never matches — the fail-safe direction is to spare.
 */
export function envHasTempMarker(
  env: Record<string, string | undefined>,
  tmp: string = tmpdir(),
): boolean {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((HERMETIC_ENV_KEYS as readonly string[]).includes(key) && value.length > 0) return true;
    if (value.includes(join(tmp, "ocr-"))) return true;
  }
  return false;
}

/** Matches the first argv marker found in a `ps` command line, if any. */
export function matchArgvMarker(command: string): string | null {
  for (const { label, argvMarker } of E2E_ARGV_MARKERS) {
    if (command.includes(argvMarker)) return label;
  }
  return null;
}

/** Parses `ps -axww -o pid=,command=` output into orphan candidates: every
 * line whose command matches an argv marker. The env factor is checked
 * separately (it costs one extra ps per candidate). */
export function collectCandidates(psOutput: string): OrphanCandidate[] {
  const candidates: OrphanCandidate[] = [];
  for (const rawLine of psOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2];
    const marker = matchArgvMarker(command);
    if (marker) candidates.push({ pid, command, marker });
  }
  return candidates;
}

/**
 * Reads a process environment without killing it: darwin via `ps -wwE`
 * (environment appended to the command line), Linux via /proc. Returns null
 * when the env cannot be read (other user, hardened runtime) — callers MUST
 * spare the process in that case (fail-safe, never guess-kill).
 */
export function readProcessEnv(pid: number): Record<string, string> | null {
  const procEnv: Record<string, string> = {};
  if (process.platform === "darwin") {
    const res = spawnSync("ps", ["-wwE", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
    const line = res.stdout.split("\n").find((l) => l.trim() && !l.trimStart().startsWith("PID"));
    if (!line) return null;
    // `ps -E` appends ` KEY=VALUE KEY=VALUE ...` after the command; values may
    // contain spaces, so tokens without '=' continue the previous value.
    let started = false;
    let currentKey = "";
    for (const token of line.trim().split(/\s+/)) {
      const m = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
      if (m) {
        started = true;
        currentKey = m[1];
        procEnv[currentKey] = m[2];
      } else if (started && currentKey) {
        procEnv[currentKey] += ` ${token}`;
      }
    }
    if (!started) return null;
  } else if (process.platform === "linux") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const raw = spawnSync("cat", [`/proc/${pid}/environ`], { encoding: "utf8", timeout: 5_000 });
      if (raw.status !== 0) return null;
      for (const pair of raw.stdout.split("\0")) {
        const eq = pair.indexOf("=");
        if (eq > 0) procEnv[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    } catch {
      return null;
    }
  } else {
    return null;
  }
  return procEnv;
}

export interface KillReport {
  killed: { candidate: OrphanCandidate; forced: boolean }[];
  spared: { candidate: OrphanCandidate; reason: string }[];
}

/**
 * The kill decision, symmetric for all three markers (P1-081 re-raise):
 * argv match AND env marker, or nothing. Unreadable env ⇒ spare + warn.
 * SIGTERM first, then SIGKILL for the survivors after the grace window.
 */
export async function killOrphans(opts: {
  candidates: OrphanCandidate[];
  readEnv: (pid: number) => Record<string, string> | null;
  envMarked: (env: Record<string, string | undefined>) => boolean;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  graceMs?: number;
  onLog?: (line: string) => void;
}): Promise<KillReport> {
  const report: KillReport = { killed: [], spared: [] };
  const victims: OrphanCandidate[] = [];
  for (const candidate of opts.candidates) {
    const env = opts.readEnv(candidate.pid);
    if (env === null) {
      opts.onLog?.(`spare pid=${candidate.pid} (${candidate.marker}): env unreadable — fail-safe`);
      report.spared.push({ candidate, reason: "env unreadable" });
      continue;
    }
    if (!opts.envMarked(env)) {
      // The operator's REAL dev app shares the argv shape — never touch it.
      opts.onLog?.(`spare pid=${candidate.pid} (${candidate.marker}): argv matches but env has no hermetic marker`);
      report.spared.push({ candidate, reason: "no env marker" });
      continue;
    }
    victims.push(candidate);
  }
  for (const victim of victims) opts.kill(victim.pid, "SIGTERM");
  if (victims.length > 0) {
    const deadline = Date.now() + (opts.graceMs ?? 1_000);
    while (Date.now() < deadline && victims.some((v) => opts.isAlive(v.pid))) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const victim of victims) {
      if (!opts.isAlive(victim.pid)) {
        opts.onLog?.(`killed pid=${victim.pid} (${victim.marker})`);
        report.killed.push({ candidate: victim, forced: false });
        continue;
      }
      opts.kill(victim.pid, "SIGKILL");
      opts.onLog?.(`killed pid=${victim.pid} (${victim.marker}) with SIGKILL (survived SIGTERM)`);
      report.killed.push({ candidate: victim, forced: true });
    }
  }
  return report;
}

/** True once the child can no longer answer for itself: exited, killed by an
 * external signal (Node records signalCode, exitCode stays null!) or killed
 * by us. Any readiness answer received after this point belongs to whoever
 * stole the port, not to our child. */
export function settled(child: {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
}): boolean {
  return child.exitCode !== null || child.signalCode !== null || child.killed;
}

/** One lsof line dump naming whoever LISTENs on the port (for diagnostics). */
export function portHolders(port: number): string {
  const res = spawnSync("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  return out || `(lsof produced no output for port ${port})`;
}

/** Asks the kernel for a genuinely free port (listen(0) → close → reuse). */
export function reserveKernelPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export interface BootOptions {
  label: string;
  /** Spawns the child that will bind `port`. */
  spawn: (port: number) => ChildProcess;
  /** Resolves true when the server answers (TCP/WS/health — caller decides). */
  probe: (port: number) => Promise<boolean>;
  timeoutMs?: number;
}

/**
 * Boots a child server on an ephemeral port with an anti-thief guard.
 *
 * The port is reserved from the kernel, handed to the child, and probed until
 * it answers. A readiness answer is ONLY trusted while the child is still
 * alive: if the child died mid-boot (crash OR external signal — see settled()),
 * a positive probe belongs to a port thief and the boot fails with the lsof
 * dump of who is holding the port.
 */
export async function bootOnEphemeralPort(
  opts: BootOptions,
): Promise<{ port: number; child: ChildProcess }> {
  const port = await reserveKernelPort();
  const child = opts.spawn(port);
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    if (settled(child)) {
      child.kill("SIGKILL");
      throw new Error(
        `${opts.label} died mid-boot (exitCode=${child.exitCode} signal=${child.signalCode ?? "none"} ` +
          `killed=${child.killed}) before answering on port ${port}. ` +
          `Whoever answers that port now is a port thief:\n${portHolders(port)}`,
      );
    }
    if (await opts.probe(port)) {
      // Anti-thief re-check: the answer must have come from OUR live child.
      if (settled(child)) {
        throw new Error(
          `${opts.label} answered the readiness probe but is dead (exitCode=${child.exitCode} ` +
            `signal=${child.signalCode ?? "none"}) — the answer belongs to a port thief:\n${portHolders(port)}`,
        );
      }
      return { port, child };
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(
        `${opts.label} never came up on port ${port} within ${opts.timeoutMs ?? 30_000}ms. ` +
          `Port holder:\n${portHolders(port)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main(): Promise<void> {
  const ps = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", timeout: 10_000 });
  if (ps.status !== 0 || !ps.stdout) {
    console.error(`e2e-orphans: ps failed (status ${ps.status}) — pre-flight skipped`);
    return;
  }
  const candidates = collectCandidates(ps.stdout);
  if (candidates.length === 0) {
    console.log("e2e-orphans: 0 candidates (no argv matches)");
    return;
  }
  const report = await killOrphans({
    candidates,
    readEnv: readProcessEnv,
    envMarked: envHasTempMarker,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone — fine
      }
    },
    onLog: (line) => console.log(`e2e-orphans: ${line}`),
  });
  console.log(`e2e-orphans: ${report.killed.length} killed, ${report.spared.length} spared`);
}

// main() only when run directly (tsx scripts/e2e-orphans.ts), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
