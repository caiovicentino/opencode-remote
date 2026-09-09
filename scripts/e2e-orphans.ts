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
 *      Gate-infra side-fix (landed via the P3-372 pipeline, not the task's
 *      scope) adds the THIRD factor, repo scoping (sameRepoScope): the
 *      pipeline runs gate slots concurrently on one box, and a sibling slot's
 *      live instances carry the same argv+env markers — without the scope the
 *      pre-flight SIGKILLed another gate's electron mid-run. Only processes
 *      of THIS checkout (absolute repo path in argv or PWD=repo root) die.
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
import { join, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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
 * Gate-infra side-fix (landed via the P3-372 pipeline, not the task's scope):
 * the THIRD kill factor — repo scoping. The pipeline runs gate slots
 * concurrently on one box (one workspace clone per slot), and every slot's
 * pre-flight must never reap ANOTHER slot's live gate instances: those carry
 * the same argv markers and OCR_* env hatches, so the box-wide match used to
 * SIGKILL a sibling gate mid-run (the silent "Target page … has been closed"
 * cascade). A hermetic process belongs to this checkout when its command line
 * carries the absolute repo path (electron + helpers are launched with
 * absolute paths) or its inherited PWD equals the repo root (the keeper and
 * the tsx children are spawned with relative argv from the repo cwd). The
 * argv match must end at a PATH BOUNDARY (`repoRoot + sep`): a bare
 * `includes(repoRoot)` also matches a sibling checkout whose name merely
 * extends the root string (`/x/tmp/repo-3-sibling` contains `/x/tmp/repo-3`),
 * scoping another slot's live instance IN — the exact incident this factor
 * exists to prevent. An unreadable PWD fails safe: the candidate is spared,
 * never killed.
 */
export function sameRepoScope(
  command: string,
  env: Record<string, string | undefined>,
  repoRoot: string,
): boolean {
  const rootPrefix = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep;
  if (command.includes(rootPrefix)) return true;
  return env.PWD === repoRoot;
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
 * Reads a process environment without killing it. On darwin the env is NOT
 * split out of the whole `ps -E` line naively: any argv token shaped
 * KEY=VALUE would be absorbed as an environment entry, so a process whose
 * ARGUMENTS contain a `<tmpdir>/ocr-` path would be marked for kill from
 * argv text alone (fail direction = kill, P1-081 round-2 finding). Instead
 * the plain command is read first (`ps -ww -o command=`) and the env is
 * exactly the suffix that follows it on the `-E` read. When the two reads
 * disagree (exec race, zombie), return null — callers MUST spare.
 * Linux reads /proc/<pid>/environ, which never contains argv. Returns null
 * when the env cannot be read (other user, hardened runtime) — fail-safe.
 */
export function readProcessEnv(pid: number): Record<string, string> | null {
  const procEnv: Record<string, string> = {};
  if (process.platform === "darwin") {
    const cmdRes = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const envRes = spawnSync("ps", ["-wwE", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const command = cmdRes.stdout.trimEnd();
    const line = envRes.stdout.trimEnd();
    if (!command || !line || !line.startsWith(command)) return null;
    const envBlob = line.slice(command.length).trim();
    if (!envBlob) return null;
    // Values may contain spaces: tokens without '=' continue the previous
    // value. Only the genuine env suffix is parsed — never the argv.
    let currentKey = "";
    for (const token of envBlob.split(/\s+/)) {
      const m = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
      if (m) {
        currentKey = m[1];
        procEnv[m[1]] = m[2];
      } else if (currentKey) {
        procEnv[currentKey] += ` ${token}`;
      }
    }
    if (Object.keys(procEnv).length === 0) return null;
  } else if (process.platform === "linux") {
    try {
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
  /** P3-372: third kill factor (same repo checkout) — injected by main();
   * absent (unit tests, importers) the historical argv+env behavior holds. */
  repoScope?: (candidate: OrphanCandidate, env: Record<string, string>) => boolean;
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
    if (opts.repoScope && !opts.repoScope(candidate, env)) {
      // Another slot's live gate shares the markers — reaping it would kill
      // a running pipeline's instance (P3-372 incident).
      opts.onLog?.(`spare pid=${candidate.pid} (${candidate.marker}): hermetic but belongs to another repo checkout`);
      report.spared.push({ candidate, reason: "another repo checkout" });
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
  // P3-372: this script's own checkout (not process.cwd()) — the repo root the
  // gate protects. Concurrent slots share the box; the scope below keeps the
  // reaper from touching a sibling slot's live instances. The trailing slash
  // from the URL resolution is stripped so the PWD equality holds.
  const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
  const candidates = collectCandidates(ps.stdout);
  if (candidates.length === 0) {
    console.log("e2e-orphans: 0 candidates (no argv matches)");
    return;
  }
  const report = await killOrphans({
    candidates,
    readEnv: readProcessEnv,
    envMarked: envHasTempMarker,
    repoScope: (candidate, env) => sameRepoScope(candidate.command, env, repoRoot),
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
