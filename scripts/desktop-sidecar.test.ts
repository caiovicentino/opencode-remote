/**
 * Desktop sidecar tests: daemon spawn/reuse/health/stop wiring (P1-D02),
 * plus runtime-crash respawn with backoff and the give-up daemon-down state
 * (P2-017). Runs the real spawn/stop paths against throwaway fixture scripts
 * on a throwaway port — never touches the production daemon on 8792.
 * Run: npx tsx scripts/desktop-sidecar.test.ts
 */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}
/** Resolves with the new pid once the fixture rewrites its pid file (a fresh
 * child started), or null on timeout — how respawn is observed in tests. */
async function pidChangesTo(file: string, not: number, ms: number): Promise<number | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const p = Number(readFileSync(file, "utf8"));
      if (p !== not && pidAlive(p)) return p;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

const tmp = mkdtempSync(join(tmpdir(), "ocr-sidecar-"));
const pidFiles: string[] = [];
function fixture(name: string, body: string): string {
  const file = join(tmp, name);
  writeFileSync(file, `require("node:fs").writeFileSync(${JSON.stringify(file + ".pid")}, String(process.pid));\n${body}`);
  pidFiles.push(file + ".pid");
  return file;
}
process.on("exit", () => {
  for (const f of pidFiles) {
    try {
      process.kill(Number(readFileSync(f, "utf8")), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

// Health server on a free port, bound BEFORE importing the module so the
// sidecar's single source of truth picks it up. The 401 shape mirrors the
// daemon's send401 (status 401 + JSON body) — healthOnce challenges with an
// unauthenticated request and only sends the bearer token to responders that
// reproduce this signature.
const TOKEN = "tok-test";
// P2-321: wedge mode models a daemon wedged ALIVE — it accepts connections
// but never answers (its event loop is pinned), so healthOnce's fetch aborts
// after the probe timeout. The fixture child stays alive the whole time.
let wedgeMode = false;
const server = createServer((req, res) => {
  if (wedgeMode) return;
  const ok = req.headers.authorization === `Bearer ${TOKEN}`;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(
    ok
      ? JSON.stringify({ healthy: true })
      : JSON.stringify({ error: "unauthorized — Authorization: Bearer <apiToken from daemon.json>" }),
  );
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

// Isolated test environment: throwaway port + throwaway state file.
process.env.OCR_DAEMON_METRICS_PORT = String(port);
const fakeState = join(tmp, "daemon.json");
writeFileSync(fakeState, JSON.stringify({ apiToken: TOKEN }));
process.env.OCR_DAEMON_STATE_FILE = fakeState;
delete process.env.OCR_DAEMON_ENTRY;
// P2-017: shrink the respawn backoff (5s/15s/45s in production) so the
// give-up path completes in ~1s instead of ~65s.
process.env.OCR_DAEMON_RESPAWN_DELAYS = "200,200,200";
// P2-321: 100ms wedge probes so the wedged-daemon episode completes in ~15s
// (each unanswered probe still costs PROBE_TIMEOUT_MS=1500ms inside healthOnce).
process.env.OCR_DAEMON_WEDGE_PROBE_MS = "100";

// Capture the sidecar's log lines — the give-up message is part of the spec.
const logLines: string[] = [];
for (const stream of [process.stdout, process.stderr] as const) {
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") logLines.push(...chunk.split("\n"));
    return original(chunk, ...rest);
  }) as typeof stream.write;
}
function sawLog(needle: string): boolean {
  return logLines.some((l) => l.includes(needle));
}

const {
  DAEMON_METRICS_PORT,
  getPairUrl,
  healthOnce,
  isDaemonDown,
  lastStopExit,
  reconnectDelayMs,
  reconnectState,
  restartDaemon,
  resolveEntry,
  respawnState,
  setSidecarRelayUrl,
  sidecarWedgeState,
  startDaemonSidecar,
  stopDaemonSidecar,
  waitForDaemonHealth,
} = await import("../apps/desktop/src/daemon.ts");
import {
  SIDECAR_WEDGE_MAX_RECOVERIES,
  SIDECAR_WEDGE_PROBES_FOR_RESTART,
  planSidecarWedge,
} from "../apps/desktop/src/sidecarwedge.ts";

// --- port wiring: one source of truth ---------------------------------------
check("module honors OCR_DAEMON_METRICS_PORT", DAEMON_METRICS_PORT === port);

// --- healthOnce: only an authenticated 200 counts ---------------------------
check("healthOnce 200+token", (await healthOnce(port, TOKEN)) === true);
check("healthOnce 401 without token is NOT healthy", (await healthOnce(port, null)) === false);
check("healthOnce 401 with wrong token is NOT healthy", (await healthOnce(port, "nope")) === false);
check("healthOnce dead port", (await healthOnce(1, TOKEN)) === false);

// --- waitForDaemonHealth positive path --------------------------------------
check(
  "waitForDaemonHealth returns true once healthy",
  (await waitForDaemonHealth({ timeoutMs: 3000 })) === true,
);

// --- round-3 hardening: a 200-anywhere squatter is never "healthy" -----------
// Simulates the classic local squatter: answers 200 to everything, checks no
// auth. It must never be counted as the daemon — with no token, and even with
// the right token (the challenge requires the daemon's 401 signature first).
const wideOpen = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ healthy: true }));
});
await new Promise<void>((r) => wideOpen.listen(0, "127.0.0.1", r));
const wideOpenPort = (wideOpen.address() as { port: number }).port;
check("healthOnce: 200-anywhere server with no token is NOT healthy", (await healthOnce(wideOpenPort, null)) === false);
check(
  "healthOnce: 200-anywhere server is NOT healthy even with the token (challenge fails, token withheld)",
  (await healthOnce(wideOpenPort, TOKEN)) === false,
);
check(
  "waitForDaemonHealth: 200-anywhere server never becomes healthy",
  (await waitForDaemonHealth({ port: wideOpenPort, timeoutMs: 1500 })) === false,
);
await new Promise<void>((r) => {
  wideOpen.closeAllConnections();
  wideOpen.close(() => r());
});

// --- resolveEntry ------------------------------------------------------------
const override = fixture("override.cjs", "process.exit(0);");
process.env.OCR_DAEMON_ENTRY = override;
const entry = resolveEntry(tmp, undefined);
check("resolveEntry honors OCR_DAEMON_ENTRY", entry?.file === override);
process.env.OCR_DAEMON_ENTRY = join(tmp, "missing.cjs");
check("resolveEntry missing override → null", resolveEntry(tmp, undefined) === null);
delete process.env.OCR_DAEMON_ENTRY;
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dev = resolveEntry(join(repoRoot, "apps", "desktop"), undefined);
check(
  "resolveEntry dev checkout runs daemon source via tsx",
  dev?.file === join(repoRoot, "apps", "daemon", "src", "index.ts") && dev.args.length === 1,
);

// --- restartDaemon: no entry yet → logged no-op (P3-017) ----------------------
// Nothing started successfully so far, so there is nothing to restart: the
// call must resolve false without throwing (tray click on a never-started
// sidecar).
check("restart without any successful start is a logged no-op", (await restartDaemon()) === false);

// --- reuse vs spawn ----------------------------------------------------------
// Bogus appPath ⇒ resolveEntry finds nothing, so true is only reachable
// through the "already healthy → reuse" path.
check(
  "startDaemonSidecar reuses a healthy daemon (no spawn)",
  (await startDaemonSidecar(tmp, undefined)) === true,
);
// Null-token state file: an alive responder cannot be proven to be ours, so
// reuse must be blocked and the sidecar must spawn its own daemon instead.
const tokenlessState = join(tmp, "tokenless-daemon.json");
writeFileSync(tokenlessState, JSON.stringify({ room: "tokenless" }));
process.env.OCR_DAEMON_STATE_FILE = tokenlessState;
const nullTokenEntry = fixture("nulltoken.cjs", "setInterval(() => {}, 1000);");
process.env.OCR_DAEMON_ENTRY = nullTokenEntry;
check(
  "startDaemonSidecar with null token does NOT reuse the responder",
  (await startDaemonSidecar(tmp, undefined)) === true,
);
check("null-token reuse blocked: sidecar spawned its own daemon", await until(() => existsSync(nullTokenEntry + ".pid")));
await stopDaemonSidecar();
check(
  "null-token spawned child is stopped",
  await until(() => !pidAlive(Number(readFileSync(nullTokenEntry + ".pid", "utf8")))),
);
process.env.OCR_DAEMON_STATE_FILE = fakeState;
delete process.env.OCR_DAEMON_ENTRY;
await new Promise<void>((r) => {
  server.closeAllConnections();
  server.close(() => r());
});
check(
  "startDaemonSidecar without entry and without daemon → false",
  (await startDaemonSidecar(tmp, undefined)) === false,
);

// --- spawn → SIGTERM → exit --------------------------------------------------
const sleepEntry = fixture("sleep.cjs", "setInterval(() => {}, 1000);");
process.env.OCR_DAEMON_ENTRY = sleepEntry;
check("startDaemonSidecar spawns when port is dead", (await startDaemonSidecar(tmp, undefined)) === true);
const pidFile = sleepEntry + ".pid";
check("spawned child starts", await until(() => existsSync(pidFile)));
const pid1 = Number(readFileSync(pidFile, "utf8"));
check("spawned child is alive", pidAlive(pid1));
await stopDaemonSidecar();
check("stopDaemonSidecar SIGTERM kills the child", !pidAlive(pid1));

// --- stdout capture: boot pairing URI (P0-003) --------------------------------
// Mirrors the daemon's boot banner (apps/daemon/src/index.ts): QR art first,
// then the "or paste:" line carrying the opencode-remote://pair URI.
const PAIR_URI =
  "opencode-remote://pair?v=2&relay=ws%3A%2F%2Frelay.example.com&room=abc123&k=dGVzdA%3D%3D&vapid=abc&name=Mac%20mini";
const pairingEntry = fixture(
  "pairing.cjs",
  `console.log("  (terminal QR art)");\nconsole.log("  or paste: ${PAIR_URI}\\n");\nsetInterval(() => {}, 1000);`,
);
process.env.OCR_DAEMON_ENTRY = pairingEntry;
check("pairing-uri child spawns", (await startDaemonSidecar(tmp, undefined)) === true);
check("pairing URI captured from stdout", await until(() => getPairUrl() === PAIR_URI));
await stopDaemonSidecar();

// A fresh spawn resets the capture — a silent child must not report the
// previous daemon's URI (each spawn owns exactly one URI).
const silentEntry = fixture("silent.cjs", "setInterval(() => {}, 1000);");
process.env.OCR_DAEMON_ENTRY = silentEntry;
check("silent child spawns", (await startDaemonSidecar(tmp, undefined)) === true);
check("silent child starts", await until(() => existsSync(silentEntry + ".pid")));
check("pairing URI reset on fresh spawn (null until printed)", getPairUrl() === null);
await stopDaemonSidecar();
check(
  "silent child is stopped",
  await until(() => !pidAlive(Number(readFileSync(silentEntry + ".pid", "utf8")))),
);

// --- stubborn child → SIGKILL after the 3s grace -----------------------------
const stubbornEntry = fixture("stubborn.cjs", 'process.on("SIGTERM", () => {});setInterval(() => {}, 1000);');
process.env.OCR_DAEMON_ENTRY = stubbornEntry;
check("stubborn child spawns", (await startDaemonSidecar(tmp, undefined)) === true);
check("stubborn child starts", await until(() => existsSync(stubbornEntry + ".pid")));
const pid2 = Number(readFileSync(stubbornEntry + ".pid", "utf8"));
const t0 = Date.now();
await stopDaemonSidecar();
const stopMs = Date.now() - t0;
check("SIGKILL fallback after 3s grace", !pidAlive(pid2) && stopMs >= 2500);

// --- runtime crash → respawn with backoff (P2-017) ----------------------------
// Criterion: killing the sidecar process must bring /api/health back within
// 60s. Production backoff starts at 5s; here the delays are shrunk to 200ms
// and the always-200 fixture server plays the recovering daemon.
const crashEntry = fixture("crash.cjs", "setInterval(() => {}, 1000);");
process.env.OCR_DAEMON_ENTRY = crashEntry;
check("respawn: sidecar starts", (await startDaemonSidecar(tmp, undefined)) === true);
check("respawn: child starts", await until(() => existsSync(crashEntry + ".pid")));
const pidA = Number(readFileSync(crashEntry + ".pid", "utf8"));
process.kill(pidA, "SIGKILL"); // simulate a runtime crash (crash/OOM/kill), not our stop
const pidB = await pidChangesTo(crashEntry + ".pid", pidA, 10_000);
check("respawn: killed sidecar is replaced by a fresh child", pidB !== null && pidAlive(pidB));
check("respawn: backoff log line present", sawLog("daemon sidecar respawn in"));
// Health comes back (fixture server re-listens) → the failure counter must
// reset once waitForDaemonHealth() sees the authenticated 200.
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
check("respawn: health 200 resets the failure counter", await until(() => respawnState().failures === 0, 5000));
check("respawn: sidecar not reported down while healthy", !isDaemonDown());
await stopDaemonSidecar();
check("respawn: replacement child is stopped", pidB === null || !pidAlive(pidB));

// --- 3 consecutive failures → give up + daemon-down state (P2-017) ------------
// Port dead again so every respawn attempt also fails the health wait: an
    // always-exiting child burns the 3-attempt budget and the shell gives up.
await new Promise<void>((r) => server.close(r));
const exiterEntry = fixture("exiter.cjs", "process.exit(0);");
process.env.OCR_DAEMON_ENTRY = exiterEntry;
check("give-up: child spawns", (await startDaemonSidecar(tmp, undefined)) === true);
check("give-up: daemon reported down after 3 attempts", await until(() => isDaemonDown(), 10_000));
check("give-up: spec log line present", sawLog("[desktop] daemon sidecar gave up after 3 attempts"));
const lastPid = Number(readFileSync(exiterEntry + ".pid", "utf8"));
await new Promise((r) => setTimeout(r, 1500));
check(
  "give-up: no respawn after the budget is spent",
  Number(readFileSync(exiterEntry + ".pid", "utf8")) === lastPid,
);
check("give-up: sidecar stays down", isDaemonDown());
const t1 = Date.now();
check(
  "waitForDaemonHealth aborts early when the child died",
  (await waitForDaemonHealth({ timeoutMs: 10_000 })) === false && Date.now() - t1 < 2000,
);
const t2 = Date.now();
await stopDaemonSidecar();
check("stopDaemonSidecar skips 3s grace for dead child", Date.now() - t2 < 1000);
const t3 = Date.now();
await stopDaemonSidecar();
check("stopDaemonSidecar is idempotent", Date.now() - t3 < 1000);
check("give-up: intentional stop clears the down state", !isDaemonDown());

// --- P3-017: tray "Restart daemon" ---------------------------------------------
// gaveUp is simulated the same way as the give-up section above (a fixture
// that exits rapidly), except this one stays alive on its 5th run — so the
// manual restart has something healthy to spawn. Criterion: gaveUp + restart
// → the sidecar respawns and waitForDaemonHealth returns 200 within the
// timeout; a restart with no prior child must not throw.
const restartEntry = fixture(
  "restart.cjs",
  `let n = 0;` +
    `try { n = Number(require("node:fs").readFileSync(__filename + ".count", "utf8")); } catch {}` +
    `require("node:fs").writeFileSync(__filename + ".count", String(n + 1));` +
    `if (n < 4) process.exit(0);` +
    `setInterval(() => {}, 1000);`,
);
process.env.OCR_DAEMON_ENTRY = restartEntry;
check("restart: sidecar starts the burn fixture", (await startDaemonSidecar(tmp, undefined)) === true);
check("restart: give-up reached again", await until(() => isDaemonDown(), 10_000));
check("restart: recovers from give-up with no prior child (no throw)", (await restartDaemon()) === true);
check(
  "restart: replacement child is running (fixture stayed alive)",
  await until(
    () => existsSync(restartEntry + ".count") && Number(readFileSync(restartEntry + ".count", "utf8")) >= 5,
    10_000,
  ),
);
check("restart: give-up state cleared", !isDaemonDown());
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
check(
  "restart: waitForDaemonHealth returns 200 within the timeout",
  (await waitForDaemonHealth({ timeoutMs: 10_000 })) === true,
);
await stopDaemonSidecar();
check(
  "restart: replacement child is stopped",
  await until(() => !pidAlive(Number(readFileSync(restartEntry + ".pid", "utf8")))),
);

// --- P1-053: reconnectDelayMs — infinite backoff, cap 30s ---------------------
// Pure production schedule (no env): 5s → 15s → 30s → 30s… A 5-minute outage
// must still fit ≥10 probes (sum of the first 10 delays ≤ 300s).
check("reconnectDelayMs(1) = 5000", reconnectDelayMs(1) === 5000);
check("reconnectDelayMs(2) = 15000", reconnectDelayMs(2) === 15000);
check("reconnectDelayMs(3) = 30000 (capped)", reconnectDelayMs(3) === 30000);
check("reconnectDelayMs(4) = 30000 (capped)", reconnectDelayMs(4) === 30000);
const tenSum = Array.from({ length: 10 }, (_, i) => reconnectDelayMs(i + 1)).reduce((a, b) => a + b, 0);
check("reconnectDelayMs: first 10 delays sum ≤ 300s", tenSum <= 300_000);
check(
  "reconnectDelayMs honors a shortened test schedule (200,200,200)",
  reconnectDelayMs(1, [200, 200, 200]) === 200 && reconnectDelayMs(4, [200, 200, 200]) === 400,
);

// --- P2-321: planSidecarWedge decision table -----------------------------------
// Every combination of failed probes × child alive/dead × stop in flight ×
// budget spent, plus missing, negative and non-numeric inputs. Closed verdict
// set: observe | degraded | restart | give-up.
const W = (failedProbes: unknown, childAlive: unknown, transitionInFlight: unknown, recoveriesUsed: unknown) => ({
  failedProbes,
  childAlive,
  transitionInFlight,
  recoveriesUsed,
});
const wedgeCases: Array<[string, unknown, string]> = [
  ["0 failed probes (healthy) → observe", W(0, true, false, 0), "observe"],
  ["1 failed probe → degraded", W(1, true, false, 0), "degraded"],
  ["2 failed probes → degraded", W(2, true, false, 0), "degraded"],
  [
    `threshold (${SIDECAR_WEDGE_PROBES_FOR_RESTART}) probes with budget left → restart`,
    W(SIDECAR_WEDGE_PROBES_FOR_RESTART, true, false, 0),
    "restart",
  ],
  [
    "way past the threshold with budget left → restart",
    W(50, true, false, 0),
    "restart",
  ],
  [
    `threshold probes with budget spent (${SIDECAR_WEDGE_MAX_RECOVERIES}) → give-up`,
    W(SIDECAR_WEDGE_PROBES_FOR_RESTART, true, false, SIDECAR_WEDGE_MAX_RECOVERIES),
    "give-up",
  ],
  ["stop/respawn in flight → observe (never interrupts)", W(99, true, true, 0), "observe"],
  ["stop in flight beats a spent budget → observe", W(99, true, true, 9), "observe"],
  ["dead child → observe (the exit path owns it)", W(99, false, false, 0), "observe"],
  ["dead child with stop in flight → observe", W(99, false, true, 0), "observe"],
  ["missing input (undefined) → observe", undefined, "observe"],
  ["null input → observe", null, "observe"],
  ["array input → observe", [], "observe"],
  ["missing failedProbes → observe", { childAlive: true, transitionInFlight: false, recoveriesUsed: 0 }, "observe"],
  ["negative failedProbes → observe", W(-1, true, false, 0), "observe"],
  ["non-numeric failedProbes → observe", W("3", true, false, 0), "observe"],
  ["NaN failedProbes → observe", W(Number.NaN, true, false, 0), "observe"],
  ["fractional failedProbes → observe", W(1.5, true, false, 0), "observe"],
  ["non-boolean childAlive → observe", W(3, "yes", false, 0), "observe"],
  ["missing childAlive → observe", { failedProbes: 3, transitionInFlight: false, recoveriesUsed: 0 }, "observe"],
  ["non-boolean transitionInFlight → observe", W(3, true, 0, 0), "observe"],
  ["missing transitionInFlight → observe", { failedProbes: 3, childAlive: true, recoveriesUsed: 0 }, "observe"],
  ["negative recoveriesUsed → observe", W(3, true, false, -1), "observe"],
  ["non-numeric recoveriesUsed → observe", W(3, true, false, "none"), "observe"],
  ["missing recoveriesUsed → observe", { failedProbes: 3, childAlive: true, transitionInFlight: false }, "observe"],
];
for (const [name, input, kind] of wedgeCases) {
  check(`wedge table: ${name}`, planSidecarWedge(input).kind === kind);
}
check(
  "wedge ceiling constant is the documented 1",
  SIDECAR_WEDGE_MAX_RECOVERIES === 1 && SIDECAR_WEDGE_PROBES_FOR_RESTART === 3,
);
// Determinism: the same input yields the exact same verdict on every call.
const wedgeDet = W(SIDECAR_WEDGE_PROBES_FOR_RESTART, true, false, 0);
check(
  "wedge verdict is deterministic (same input, two calls, identical result)",
  JSON.stringify(planSidecarWedge(wedgeDet)) === JSON.stringify(planSidecarWedge(wedgeDet)) &&
    planSidecarWedge(wedgeDet).kind === "restart",
);
// Every verdict carries a short static pt-BR phrase with no path, port,
// identifier or secret: no separators, no digits, no loopback reference.
const wedgeMsgs = wedgeCases.map(([, input]) => planSidecarWedge(input).message);
check(
  "wedge verdict messages are static, path/port/identifier-free pt-BR",
  wedgeMsgs.every((m) => typeof m === "string" && m.length > 0 && !m.includes("/") && !/\d/.test(m) && !m.includes("127")),
);
// Purity: the REAL sidecarwedge.ts source imports no electron, no node
// builtins, no timers and no I/O of any kind (unit tests run it in plain Node).
const wedgeSource = readFileSync(join(repoRoot, "apps", "desktop", "src", "sidecarwedge.ts"), "utf8");
check("sidecarwedge.ts is pure (no electron import)", !wedgeSource.includes('from "electron"'));
check("sidecarwedge.ts is pure (no node:fs import)", !wedgeSource.includes("node:fs"));
check(
  "sidecarwedge.ts is pure (no node builtins, timers, fetch or require)",
  !wedgeSource.includes("node:") && !wedgeSource.includes("setTimeout") && !wedgeSource.includes("setInterval") && !wedgeSource.includes("fetch(") && !wedgeSource.includes("require("),
);

// --- P1-053: adopted-daemon outage → infinite reconnect, no give-up -----------
// Reuse mode: the desktop adopts the healthy fixture server (reuse path).
// Killing it must NEVER set gaveUp and NEVER spawn a child — only the active
// reconnecting state with a growing attempt counter. A canary fixture acts as
// a spawn detector: its pid file only exists if something wrongly spawned it.
const canaryEntry = fixture("canary.cjs", "setInterval(() => {}, 1000);");
process.env.OCR_DAEMON_ENTRY = canaryEntry;
const stateBefore = readFileSync(fakeState, "utf8");
check("reconnect: adopted daemon starts the watchdog", (await startDaemonSidecar(tmp, undefined)) === true);
check(
  "reconnect: starts healthy (not reconnecting)",
  reconnectState().reconnecting === false && reconnectState().attempts === 0,
);
await new Promise<void>((r) => {
  server.closeAllConnections();
  server.close(() => r());
});
check("reconnect: outage marks reconnecting", await until(() => reconnectState().reconnecting, 5_000));
check("reconnect: reuse mode is never reported down", !isDaemonDown());
check("reconnect: attempts grow past the hosted budget", await until(() => reconnectState().attempts > 3, 15_000));
check("reconnect: still not down after >3 attempts", !isDaemonDown());
// Recovery: the external daemon comes back → state resets, health is 200
// within 2s, and nothing was spawned and nothing re-paired in the meantime.
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
check(
  "reconnect: recovery clears the state within 2s",
  await until(() => !reconnectState().reconnecting && reconnectState().attempts === 0, 2_000),
);
check("reconnect: health 200 right after recovery", (await healthOnce(port, TOKEN)) === true);
check("reconnect: watchdog never spawned a child (canary pid absent)", !existsSync(canaryEntry + ".pid"));
check("reconnect: 0600 state file untouched (no re-pairing)", readFileSync(fakeState, "utf8") === stateBefore);
await stopDaemonSidecar();
check(
  "reconnect: stop clears the reconnecting state",
  reconnectState().reconnecting === false && reconnectState().attempts === 0,
);
delete process.env.OCR_DAEMON_ENTRY;

// --- P2-315: the REAL daemon stops gracefully through the shell (code 0) ------
// The dev entry (OCR_DAEMON_ENTRY deleted) resolves to the daemon's TypeScript
// source via tsx, so startDaemonSidecar spawns the real daemon. Its stop must
// ride the IPC message channel (no signal) into the SIGTERM drain and exit
// with code 0 — the exact behavior Windows gets, exercised on this machine.
// A throwaway HOME keeps the real 0600 state file out of the operator's
// machine; OCR_DAEMON_STATE_FILE points the shell's reader at the same file.
{
  const realHome = mkdtempSync(join(tmpdir(), "ocr-reald-"));
  const realState = join(realHome, ".opencode-remote", "daemon.json");
  const prevHome = process.env.HOME;
  const prevStateFile = process.env.OCR_DAEMON_STATE_FILE;
  process.env.HOME = realHome;
  process.env.OCR_DAEMON_STATE_FILE = realState;
  // Dead loopback relay: the daemon's dial fails fast, offline, forever.
  setSidecarRelayUrl("ws://127.0.0.1:1");
  // Free the test port so the real daemon can bind it (fixture server is off).
  await new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
  let realPid = 0;
  process.on("exit", () => {
    try {
      if (realPid) process.kill(realPid, "SIGKILL");
    } catch {
      /* already gone */
    }
  });
  check(
    "real daemon: starts via the dev entry (tsx)",
    (await startDaemonSidecar(join(repoRoot, "apps", "desktop"), undefined)) === true,
  );
  realPid = Number(/pid (\d+)/.exec(logLines.find((l) => l.includes("daemon sidecar spawned")) ?? "")?.[1] ?? 0);
  // The daemon mints its apiToken on the first probe, so poke the 401
  // challenge first (same dance as the bundle smoke below) — healthOnce
  // refuses to fetch while the shell has no token.
  let challenged = false;
  const challengeDeadline = Date.now() + 20_000;
  while (Date.now() < challengeDeadline && !challenged) {
    try {
      challenged = (await fetch(`http://127.0.0.1:${port}/api/health`)).status === 401;
    } catch {
      /* not up yet */
    }
    if (!challenged) await new Promise((r) => setTimeout(r, 100));
  }
  check("real daemon: boot challenge answered (401)", challenged);
  check("real daemon: becomes healthy on the test port", await waitForDaemonHealth({ timeoutMs: 15_000 }));
  await stopDaemonSidecar();
  check(
    "real daemon: stopped via the graceful IPC path with code 0 (no signal)",
    lastStopExit()?.code === 0 && lastStopExit()?.signal === null,
  );
  check("real daemon: pid is gone", realPid === 0 || !pidAlive(realPid));
  const tSecond = Date.now();
  await stopDaemonSidecar();
  check("real daemon: second stop is harmless (idempotent, no grace)", Date.now() - tSecond < 1000);
  process.env.HOME = prevHome;
  process.env.OCR_DAEMON_STATE_FILE = prevStateFile ?? fakeState;
}

// --- P2-321: wedged (alive, unresponsive) child → exactly one recovery --------
// A daemon whose event loop is pinned never exits: the exit handler never
// fires and the old supervision never notices. Here the fixture child stays
// alive forever while the fixture server (the daemon's health endpoint) is
// switched into wedge mode — connections accepted, never answered. The shell
// must detect the wedge through its own probes, recover EXACTLY once through
// the existing respawn path (stop → backoff → fresh child), never act while a
// stop/respawn is in flight, and give up after the documented ceiling instead
// of restart-looping.
{
  const wedgeLogStart = logLines.length;
  const sawWedgeLog = (needle: string): boolean =>
    logLines.slice(wedgeLogStart).some((l) => l.includes(needle));
  const wedgedEntry = fixture("wedge.cjs", "setInterval(() => {}, 1000);");
  process.env.OCR_DAEMON_ENTRY = wedgedEntry;
  // Server is closed at this point (the real-daemon block released the port):
  // healthOnce answers false fast, so the shell spawns its own child…
  check("wedge: sidecar spawns its own child", (await startDaemonSidecar(tmp, undefined)) === true);
  check("wedge: child starts", await until(() => existsSync(wedgedEntry + ".pid")));
  const wedgePid1 = Number(readFileSync(wedgedEntry + ".pid", "utf8"));
  // …and the first healthy boot arms the wedge prober (spawned child + 200).
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  check("wedge: first boot is healthy (prober armed)", await waitForDaemonHealth({ timeoutMs: 10_000 }));
  check("wedge: no verdict while healthy", sidecarWedgeState() === null);
  // The daemon wedges: alive, port bound, never answers again.
  wedgeMode = true;
  // 3 unanswered probes (≈1.6s each: PROBE_TIMEOUT inside healthOnce) →
  // restart verdict → stop (3s grace: the wedged child ignores the IPC
  // request, SIGKILL ends it) → 200ms backoff → fresh child.
  const wedgePid2 = await pidChangesTo(wedgedEntry + ".pid", wedgePid1, 30_000);
  check("wedge: wedged child was recovered exactly once", wedgePid2 !== null && pidAlive(wedgePid2));
  check("wedge: recovery rode the existing respawn path", sawWedgeLog("daemon sidecar respawn in"));
  check("wedge: restart verdict reached the log", sawWedgeLog("daemon sidecar wedge:"));
  // No recovery while a stop or respawn is in flight: the whole episode
  // scheduled exactly ONE respawn — probes during the 3s stop grace and the
  // backoff window were answered "observe" by the pure verdict.
  const wedgeRespawns = logLines
    .slice(wedgeLogStart)
    .filter((l) => l.includes("daemon sidecar respawn in")).length;
  check("wedge: exactly one respawn scheduled (no recovery mid-stop)", wedgeRespawns === 1);
  // The replacement child is wedged too (the server never un-wedges): the
  // second detection hits the spent budget → give-up, prober stops, no second
  // recovery, and the verdict travels to the pairing payload accessor.
  check(
    "wedge: give-up verdict after the ceiling",
    await until(() => sawWedgeLog("reinício automático suspenso"), 30_000),
  );
  check("wedge: give-up verdict travels in the pairing payload", sidecarWedgeState()?.state === "give-up");
  await new Promise((r) => setTimeout(r, 4_000));
  check(
    "wedge: no second recovery after the ceiling",
    Number(readFileSync(wedgedEntry + ".pid", "utf8")) === wedgePid2 && pidAlive(wedgePid2),
  );
  wedgeMode = false;
  await stopDaemonSidecar();
  check("wedge: replacement child is stopped", wedgePid2 === null || !pidAlive(wedgePid2));
  check("wedge: verdict cleared after the stop", sidecarWedgeState() === null);
  await new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
  delete process.env.OCR_DAEMON_ENTRY;
}

// --- bundled artifact smoke (P2-006) -----------------------------------------
// The packaged app runs dist-daemon/index.js (shipped as resources/daemon/
// index.js), so the eval battery must execute the actual bundle — regex checks
// on source can't catch bundling breakage (e.g. esbuild emptying import.meta
// in CJS output). Builds the bundle if missing (the gate's `npm run build`
// already produces it) and probes it exactly like the packaged app would:
// 401 challenge → authenticated 200 on /api/health → dashboard served.
const bundle = join(repoRoot, "apps", "desktop", "dist-daemon", "index.js");
if (!existsSync(bundle)) {
  const built = spawnSync(process.execPath, ["scripts/bundle-daemon.mjs"], {
    cwd: join(repoRoot, "apps", "desktop"),
    stdio: "inherit",
  });
  check("bundle smoke: dist-daemon bundle built", built.status === 0);
}
if (existsSync(bundle)) {
  const smokeHome = mkdtempSync(join(tmpdir(), "ocr-bundle-"));
  const smokeServer = createServer(() => {});
  await new Promise<void>((r) => smokeServer.listen(0, "127.0.0.1", r));
  const smokePort = (smokeServer.address() as { port: number }).port;
  await new Promise<void>((r) => smokeServer.close(r));
  const child = spawn(process.execPath, [bundle], {
    env: { ...process.env, HOME: smokeHome, RELAY_URL: "ws://127.0.0.1:1", OCR_METRICS_PORT: String(smokePort) },
    stdio: "ignore",
  });
  process.on("exit", () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });

  // wait for the metrics/API server: the unauthenticated request must get the
  // daemon's 401 challenge (same signature healthOnce demands)
  let challenged = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !challenged) {
    try {
      const res = await fetch(`http://127.0.0.1:${smokePort}/api/health`);
      challenged = res.status === 401;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check("bundle smoke: unauthenticated /api/health gets the 401 challenge", challenged);

  const stateFile = join(smokeHome, ".opencode-remote", "daemon.json");
  let token = "";
  for (let i = 0; i < 50 && !token; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      token = (JSON.parse(readFileSync(stateFile, "utf8")) as { apiToken?: string }).apiToken ?? "";
    } catch {
      /* identity not persisted yet */
    }
  }
  const authRes = await fetch(`http://127.0.0.1:${smokePort}/api/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const authBody = (await authRes.json()) as { healthy?: boolean; version?: string };
  check(
    "bundle smoke: authenticated /api/health is 200 healthy",
    authRes.status === 200 && authBody.healthy === true && typeof authBody.version === "string",
  );
  const dashRes = await fetch(`http://127.0.0.1:${smokePort}/dashboard`);
  check(
    "bundle smoke: GET /dashboard is 200 (import.meta survives CJS bundling)",
    dashRes.status === 200,
  );
  // P1-057: the apiToken must never ride in the served HTML anymore
  const dashBody = await dashRes.text();
  check(
    "bundle smoke: GET /dashboard body does NOT contain the apiToken",
    dashBody.length > 0 && !dashBody.includes(token),
  );

  // P2-007: the pairing URI is exposed read-only over loopback, Bearer-gated.
  // Virgin daemon (throwaway HOME) → the boot URI must come back intact and
  // the fresh allowlist must be empty.
  const noTokenRes = await fetch(`http://127.0.0.1:${smokePort}/__ocr/pairing-uri`);
  check("bundle smoke: GET /__ocr/pairing-uri without token is 401", noTokenRes.status === 401);
  const wrongTokenRes = await fetch(`http://127.0.0.1:${smokePort}/__ocr/pairing-uri`, {
    headers: { authorization: "Bearer nope" },
  });
  check("bundle smoke: GET /__ocr/pairing-uri with wrong token is 401", wrongTokenRes.status === 401);
  const pairRes = await fetch(`http://127.0.0.1:${smokePort}/__ocr/pairing-uri`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const pairBody = (await pairRes.json()) as { uri?: string };
  check(
    "bundle smoke: authenticated /__ocr/pairing-uri returns the boot URI",
    pairRes.status === 200 && typeof pairBody.uri === "string" && pairBody.uri.startsWith("opencode-remote://pair?v=2&"),
  );
  const devRes = await fetch(`http://127.0.0.1:${smokePort}/__ocr/devices`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const devBody = (await devRes.json()) as { devices?: unknown[] };
  check(
    "bundle smoke: authenticated /__ocr/devices returns the fresh allowlist",
    devRes.status === 200 && Array.isArray(devBody.devices) && devBody.devices.length === 0,
  );
  const devNoAuthRes = await fetch(`http://127.0.0.1:${smokePort}/__ocr/devices`);
  check("bundle smoke: GET /__ocr/devices without token is 401", devNoAuthRes.status === 401);

  // P1-057: Bearer → short-lived HttpOnly session cookie. The cookie alone must
  // open /api/* and must never mint fresh sessions (Bearer-only).
  const sessionRes = await fetch(`http://127.0.0.1:${smokePort}/api/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const setCookie = sessionRes.headers.get("set-cookie") ?? "";
  check(
    "bundle smoke: POST /api/session with Bearer is 200 + HttpOnly ocr_session cookie",
    sessionRes.status === 200 && /ocr_session=[0-9a-f]{32}/i.test(setCookie) && /httponly/i.test(setCookie),
  );
  const cookie = /ocr_session=[0-9a-f]+/i.exec(setCookie)?.[0] ?? "";
  const cookieHealth = await fetch(`http://127.0.0.1:${smokePort}/api/health`, { headers: { cookie } });
  check("bundle smoke: GET /api/health with only the session cookie is 200", cookieHealth.status === 200);
  check(
    "bundle smoke: GET /api/health without any auth is 401",
    (await fetch(`http://127.0.0.1:${smokePort}/api/health`)).status === 401,
  );
  const cookieSessionRes = await fetch(`http://127.0.0.1:${smokePort}/api/session`, {
    method: "POST",
    headers: { cookie },
  });
  check("bundle smoke: POST /api/session with only the cookie is 401 (Bearer-only)", cookieSessionRes.status === 401);

  child.kill("SIGTERM");
  check("bundle smoke: child exits on SIGTERM", await until(() => !pidAlive(child.pid ?? -1)));
} else {
  check("bundle smoke: dist-daemon bundle exists", false);
}

console.log(failures === 0 ? "\ndesktop sidecar tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
