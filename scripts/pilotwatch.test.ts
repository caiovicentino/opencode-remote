/**
 * eval-01 — pilot liveness watchdog + supervisor relay/fallback (daemon side).
 * Pure verdict and alert planner with fake clocks, the prompt_async relay
 * classification, the phone digest (dedupe by (task, kind), cooldown, rate
 * limit) and the watcher end to end against an in-memory fs + fake launchctl —
 * including a replay of the real 24/09 outage (pilot booted out of launchd,
 * dead pid, supervisor session deleted, 16 merges waiting for deploy).
 * Hermetic: no network, no real launchctl, no writes outside memory.
 * Run: npx tsx scripts/pilotwatch.test.ts
 */
import "./testhome"; // throwaway HOME before any pilot module loads (testhome.ts)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import {
  CATCH_UP_MS,
  CONFIRM_TICKS,
  CRASH_LOOP_WINDOW_MS,
  DIGEST_PUSH_TAG,
  DISK_HOLD_ALERT_MS,
  EMPTY_ALERT,
  HEARTBEAT_STALE_MS,
  PILOT_PUSH_TAG,
  REMINDER_DOWN_MS,
  STALL_SILENCE_MS,
  abnormalLaunchdExit,
  createPilotWatch,
  deployLagFrom,
  diskHoldFromEvents,
  fmtDuration,
  livenessVerdict,
  normalizeWatchFile,
  parseLaunchctlPrint,
  parsePilotWatchEnv,
  pilotInstalled,
  planAlert,
  resolveHeadSha,
  restartsInWindow,
  sanitizeDetail,
  supervisorProbeFrom,
  UNCHECKED_LAUNCHD,
  type AlertState,
  type LivenessVerdict,
  type PilotSignals,
  type WatchIo,
  type WatchPaths,
} from "../apps/daemon/src/pilotwatch";
import {
  DIGEST_KEY_COOLDOWN_MS,
  DIGEST_MIN_INTERVAL_MS,
  digestAdd,
  digestMarkSent,
  digestPlan,
  emptyDigest,
  notifyKind,
  relayPilotNotify,
  sanitizeRelayBody,
  type FallbackItem,
} from "../apps/daemon/src/pilotnotify";
import { WATCHDOG_INTERVAL_MS, selfWatchVerdict } from "../apps/pilot/src/selfwatch";
import { startWatchdog } from "../apps/pilot/src/state";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("   ", detail);
  }
}

setTimeout(() => {
  console.error("pilotwatch test timed out (global 30s)");
  process.exit(1);
}, 30_000).unref();

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-09-27T11:15:00-03:00");

// ── fmtDuration ──────────────────────────────────────────────────────────────
check("fmt: sub-minute rounds up to 1 min", fmtDuration(10_000) === "1 min");
check("fmt: minutes", fmtDuration(14 * MIN) === "14 min");
check("fmt: hours + padded minutes", fmtDuration(2 * HOUR + 5 * MIN) === "2h 05min");
check("fmt: whole hours", fmtDuration(4 * HOUR) === "4h");
check("fmt: days", fmtDuration(3 * 24 * HOUR + 4 * HOUR) === "3d 4h");

// ── launchctl print parsing (shapes captured from this host, 2026-09-27) ────
const LOADED = [
  "gui/501/com.ocr.pilot = {",
  "\tactive count = 1",
  "\tpath = /Users/x/Library/LaunchAgents/com.ocr.pilot.plist",
  "\tstate = running",
  "\truns = 54",
  "\tpid = 65883",
  "\tlast exit code = 1",
  "\tendpoints = {",
  "\t\tstate = active",
  "\t}",
  "}",
].join("\n");
const loaded = parseLaunchctlPrint(0, LOADED);
check("launchctl: loaded service parsed", loaded.checked && loaded.loaded === true && loaded.state === "running");
check("launchctl: top-level numbers only (nested state ignored)", loaded.pid === 65883 && loaded.runs === 54 && loaded.lastExitCode === 1);
const never = parseLaunchctlPrint(0, "\tstate = running\n\truns = 1\n\tlast exit code = (never exited)\n");
check("launchctl: '(never exited)' is not an exit code", never.lastExitCode === null && never.runs === 1);
const unloaded = parseLaunchctlPrint(113, 'Bad request.\nCould not find service "com.ocr.pilot" in domain for user gui: 501\n');
check("launchctl: exit 113 = not loaded (checked)", unloaded.checked && unloaded.loaded === false);
check("launchctl: other failures are unknown, never an accusation", parseLaunchctlPrint(5, "boom").checked === false);
// the 24/09 OOM crash-loop died by signal: launchctl prints no `last exit code`
// line for that shape (repro R2) — the signal line and the exit reason line are
// the only witnesses. `last exit reason` also survives on RUNNING jobs whose
// last exit was a benign idle nap (com.apple.homed on this host), so only a
// non-idle reason counts as abnormal.
const SIGNAL_DEATH = parseLaunchctlPrint(0, "\tstate = running\n\truns = 66\n\tpid = 65884\n\tlast terminating signal = Abort trap: 6\n");
check("launchctl: signal death parsed (no exit code line)", SIGNAL_DEATH.lastExitSignal === "Abort trap: 6" && SIGNAL_DEATH.lastExitCode === null);
const REASON_DEATH = parseLaunchctlPrint(0, "\tstate = running\n\truns = 67\n\tpid = 65885\n\tlast exit reason = Exited due to signal: Abort trap: 6\n");
check("launchctl: exit reason parsed", REASON_DEATH.lastExitReason === "Exited due to signal: Abort trap: 6");
const IDLE_NAP = parseLaunchctlPrint(0, "\tstate = running\n\truns = 29\n\tpid = 29911\n\tlast exit reason = JETSAM_REASON_MEMORY_IDLE_EXIT\n");
check("launchctl: idle exit reason parsed", IDLE_NAP.lastExitReason === "JETSAM_REASON_MEMORY_IDLE_EXIT");
check("abnormal exit: exit code decides when present", abnormalLaunchdExit(loaded) === true && abnormalLaunchdExit({ ...loaded, lastExitCode: 0 }) === false);
check("abnormal exit: a signal death is abnormal without an exit code", abnormalLaunchdExit(SIGNAL_DEATH) === true);
check("abnormal exit: a non-idle exit reason is abnormal", abnormalLaunchdExit(REASON_DEATH) === true);
check("abnormal exit: an idle exit reason is NOT abnormal (homed naps on this host)", abnormalLaunchdExit(IDLE_NAP) === false);
check("abnormal exit: nothing known = null (heartbeat fallback)", abnormalLaunchdExit(never) === null);
check("sanitize: control characters and bidi overrides are stripped", sanitizeDetail("disk low: 2.1gb\u0007 free\u202Ereversed\u202C\u200b") === "disk low: 2.1gb freereversed");

// ── restarts / disk hold / deploy lag / HEAD ────────────────────────────────
check("restarts: < 2 samples = unknown", restartsInWindow([{ at: T0, runs: 3 }], T0) === null);
check(
  "restarts: all samples inside the 60-min window count toward the delta",
  restartsInWindow(
    [
      { at: T0 - 20 * MIN, runs: 1 },
      { at: T0 - 10 * MIN, runs: 10 },
      { at: T0, runs: 14 },
    ],
    T0,
  ) === 13,
);
check(
  "restarts: samples older than the window are dropped (the slow 24/09 loop restarted every ~14 min)",
  restartsInWindow(
    [
      { at: T0 - 90 * MIN, runs: 1 },
      { at: T0 - 30 * MIN, runs: 9 },
      { at: T0, runs: 12 },
    ],
    T0,
  ) === 3,
);
check("restarts: a reload (runs reset) is not negative", restartsInWindow([{ at: T0 - MIN, runs: 9 }, { at: T0, runs: 1 }], T0) === 0);
check("restarts: window constant is 60 min (was 15 — the 24/09 loop ran at 14-min pace)", CRASH_LOOP_WINDOW_MS === 60 * MIN);

const ev = (iso: string, phase: string, ok: boolean, detail = "") =>
  JSON.stringify({ ts: iso, type: "deploy", phase, ok, detail });
const holdLines = [
  ev("2026-09-23T17:40:00.000Z", "done", true),
  ev("2026-09-23T18:56:00.000Z", "disk-guard", false, "disk low: 3.8gb free (need 5.0gb)"),
  JSON.stringify({ ts: "2026-09-23T19:00:00.000Z", type: "phase", task: "P2-1", phase: "builder" }),
  "not json",
  ev("2026-09-24T10:40:38.632Z", "disk-guard", false, "disk low: 2.1gb free (need 5.0gb)"),
];
const hold = diskHoldFromEvents(holdLines);
check(
  "disk hold: trailing refusals since the last good deploy",
  hold !== null && hold.refusals === 2 && hold.since === Date.parse("2026-09-23T18:56:00.000Z") && hold.detail.includes("2.1gb"),
);
check("disk hold: a later successful deploy clears it", diskHoldFromEvents([...holdLines, ev("2026-09-24T11:00:00.000Z", "done", true)]) === null);
// eval-02's explicit hold: `alert` events with task "disk" (one per transition + one every 6h)
const diskAlert = (iso: string, phase: "disk-hold" | "disk-resume", detail = "") =>
  JSON.stringify({ ts: iso, type: "alert", task: "disk", phase, ok: phase === "disk-resume", detail });
const explicitHold = diskHoldFromEvents([
  diskAlert("2026-09-27T10:00:00.000Z", "disk-hold", "free 2.1gb < 5gb"),
  JSON.stringify({ ts: "2026-09-27T12:00:00.000Z", type: "alert", task: "P2-1", phase: "validateSpec", ok: false }),
  diskAlert("2026-09-27T16:00:00.000Z", "disk-hold", "free 1.9gb < 5gb"),
]);
check(
  "disk hold: the pilot's explicit hold (alert/disk events) is read and refreshed",
  explicitHold?.source === "pilot-hold" &&
    explicitHold.since === Date.parse("2026-09-27T10:00:00.000Z") &&
    explicitHold.last === Date.parse("2026-09-27T16:00:00.000Z") &&
    explicitHold.detail.includes("1.9gb"),
);
check(
  "disk hold: disk-resume clears the explicit hold",
  diskHoldFromEvents([diskAlert("2026-09-27T10:00:00.000Z", "disk-hold"), diskAlert("2026-09-27T11:00:00.000Z", "disk-resume")]) === null,
);
check("disk hold: other alert events are not a hold", diskHoldFromEvents([JSON.stringify({ ts: "2026-09-27T10:00:00.000Z", type: "alert", task: "P2-1", phase: "disk-hold" })]) === null);

const vm = (sha: string, iso: string) => JSON.stringify({ sha, task: "T", at: iso });
const PROD = "1ebbbc1bae45e3900674e9fa2acd7aa623b54b33";
const merges = [
  vm("a".repeat(40), "2026-09-23T10:00:00-03:00"),
  vm(PROD, "2026-09-23T14:37:24-03:00"),
  vm("b".repeat(40), "2026-09-23T15:55:52-03:00"),
  vm("c".repeat(40), "2026-09-24T04:11:06-03:00"),
];
const lag = deployLagFrom(PROD, merges);
check("deploy lag: merges recorded after the prod sha", lag.undeployed === 2 && lag.oldestUndeployedAt === Date.parse("2026-09-23T15:55:52-03:00"));
check("deploy lag: prod at the newest merge = 0", deployLagFrom("c".repeat(40), merges).undeployed === 0);
check("deploy lag: prod sha missing from the list = unknown", deployLagFrom("d".repeat(40), merges).undeployed === null);

const git = new Map<string, string>([
  [join("/r", ".git", "HEAD"), "ref: refs/heads/main\n"],
  [join("/r", ".git", "refs", "heads", "main"), `${PROD}\n`],
  [join("/p", ".git", "HEAD"), "ref: refs/heads/main\n"],
  [join("/p", ".git", "packed-refs"), `# pack-refs with: peeled\n${"e".repeat(40)} refs/heads/main\n`],
  [join("/d", ".git", "HEAD"), `${"f".repeat(40)}\n`],
]);
const gitIo = { readText: (p: string) => git.get(p) ?? null };
check("HEAD: loose ref", resolveHeadSha("/r", gitIo) === PROD);
check("HEAD: packed ref", resolveHeadSha("/p", gitIo) === "e".repeat(40));
check("HEAD: detached", resolveHeadSha("/d", gitIo) === "f".repeat(40));
check("HEAD: no repo = null", resolveHeadSha("/none", gitIo) === null);

check("supervisor probe: 200 ok", supervisorProbeFrom(200, "{}") === "ok");
check(
  "supervisor probe: 404 NotFoundError = missing (real opencode body)",
  supervisorProbeFrom(404, '{"name":"NotFoundError","data":{"message":"Session not found: ses_x"}}') === "missing",
);
check("supervisor probe: other 404 / errors = unknown", supervisorProbeFrom(404, "<html>") === "unknown" && supervisorProbeFrom(null, "") === "unknown");

// ── livenessVerdict ──────────────────────────────────────────────────────────
function signals(over: Partial<PilotSignals> = {}): PilotSignals {
  return {
    installed: true,
    paused: false,
    heartbeatAt: T0 - MIN,
    pid: 4242,
    pidAlive: true,
    launchd: { checked: true, loaded: true, state: "running", pid: 4242, runs: 1, lastExitCode: null, lastExitSignal: null, lastExitReason: null },
    restarts: 0,
    diskHold: null,
    deploy: { prodSha: PROD, undeployed: 0, oldestUndeployedAt: null },
    notify: { pending: 0, oldestPendingAt: null, lastDeliveredAt: null },
    supervisor: { session: null, probe: "unset" },
    ...over,
  };
}
const codes = (v: LivenessVerdict) => v.reasons.map((r) => r.code).join(",");
check("verdict: healthy pilot = ok", livenessVerdict(signals(), T0).state === "ok");
check("verdict: not installed = absent (never alerts)", livenessVerdict(signals({ installed: false, heartbeatAt: null }), T0).state === "absent");
check("verdict: pilot.lock = paused", livenessVerdict(signals({ paused: true, pidAlive: false, heartbeatAt: T0 - 9 * HOUR }), T0).state === "paused");
const unl = livenessVerdict(
  signals({ pidAlive: false, heartbeatAt: T0 - 3 * 24 * HOUR, launchd: { ...UNCHECKED_LAUNCHD, checked: true, loaded: false } }),
  T0,
);
check("verdict: booted out of launchd + dead pid = down/unloaded", unl.state === "down" && codes(unl) === "unloaded");
check("verdict: unloaded detail says KeepAlive will not restart it", unl.reasons[0]!.detail.includes("KeepAlive") && unl.reasons[0]!.detail.includes("3d"));
// R4a: PIDs recycle — pilot.pid 35139 was stale and macOS handed it to another
// process, so kill(pid,0) says "alive" for a process that is not the pilot.
// With launchd reporting "not loaded" the pid file is never the witness.
const recycled = livenessVerdict(
  signals({ pidAlive: true, heartbeatAt: T0 - 3 * 24 * HOUR, launchd: { ...UNCHECKED_LAUNCHD, checked: true, loaded: false } }),
  T0,
);
check("verdict: recycled pid (kill says alive) + stale heartbeat = still unloaded", recycled.state === "down" && codes(recycled) === "unloaded");
// the 27/09 12:05 shape: heartbeat rewritten while the pilot was out of
// launchd and the pid dead — a fresh heartbeat with a dead pid is not a
// manual run, it is an untrustworthy heartbeat
const ghost = livenessVerdict(
  signals({ pidAlive: false, heartbeatAt: T0 - MIN, launchd: { ...UNCHECKED_LAUNCHD, checked: true, loaded: false } }),
  T0,
);
check("verdict: fresh heartbeat + dead pid + not loaded = unloaded (the heartbeat is not a witness)", ghost.state === "down" && codes(ghost) === "unloaded");
check(
  "verdict: running outside launchd (manual run, fresh heartbeat, alive pid) is ok",
  livenessVerdict(signals({ launchd: { ...UNCHECKED_LAUNCHD, checked: true, loaded: false } }), T0).state === "ok",
);
// R1: a healthy pilot blocks its own loop for up to the 30-min judge budget
// (judge.ts execFileSync) — 11-18 min of silence with a live pid under a
// running launchd job is a gate at work, not a stall
check(
  "verdict: 11 min of silence with a live pid under a running launchd job is within the judge budget",
  livenessVerdict(signals({ heartbeatAt: T0 - HEARTBEAT_STALE_MS - MIN }), T0).state === "ok",
);
check(
  `verdict: silence past the budget (${STALL_SILENCE_MS / MIN} min) is a stall`,
  livenessVerdict(signals({ heartbeatAt: T0 - STALL_SILENCE_MS - MIN }), T0).state === "down" &&
    codes(livenessVerdict(signals({ heartbeatAt: T0 - STALL_SILENCE_MS - MIN }), T0)) === "stalled",
);
const stalled = livenessVerdict(signals({ heartbeatAt: T0 - STALL_SILENCE_MS - MIN, launchd: { checked: false, loaded: null, state: null, pid: null, runs: null, lastExitCode: null, lastExitSignal: null, lastExitReason: null } }), T0);
check("verdict: with launchd unknown, the old 10-min threshold still stalls", stalled.state === "down" && codes(stalled) === "stalled");
check("verdict: heartbeat just under the stale threshold is still ok", livenessVerdict(signals({ heartbeatAt: T0 - HEARTBEAT_STALE_MS + MIN }), T0).state === "ok");
const dead = livenessVerdict(signals({ pidAlive: false, heartbeatAt: T0 - 20 * MIN }), T0);
check("verdict: dead pid + stale heartbeat (launchd loaded) = dead", dead.state === "down" && codes(dead) === "dead");
check("verdict: never beat = no-heartbeat", codes(livenessVerdict(signals({ pidAlive: null, pid: null, heartbeatAt: null }), T0)) === "no-heartbeat");
const loop = livenessVerdict(
  signals({ restarts: 14, launchd: { checked: true, loaded: true, state: "running", pid: 1, runs: 20, lastExitCode: 1, lastExitSignal: null, lastExitReason: null } }),
  T0,
);
check(`verdict: ≥3 restarts in ${CRASH_LOOP_WINDOW_MS / MIN} min with exit≠0 = crash-loop`, loop.state === "down" && codes(loop) === "crash-loop");
check("verdict: restarts with exit 0 (self-reload after deploy) are not a crash loop", livenessVerdict(signals({ restarts: 3, launchd: { checked: true, loaded: true, state: "running", pid: 1, runs: 5, lastExitCode: 0, lastExitSignal: null, lastExitReason: null } }), T0).state === "ok");
// R2: the 24/09 OOM aborts died by signal — launchctl showed no `last exit
// code` line, only the signal, and the old rule required the exit code
const signalLoop = livenessVerdict(
  signals({
    restarts: 4,
    heartbeatAt: T0 - MIN,
    launchd: { checked: true, loaded: true, state: "running", pid: 65884, runs: 66, lastExitCode: null, lastExitSignal: "Abort trap: 6", lastExitReason: null },
  }),
  T0,
);
check("verdict: signal death (no exit code line) + restarts = crash-loop", signalLoop.state === "down" && codes(signalLoop) === "crash-loop");
check("verdict: the crash-loop detail names the signal", signalLoop.reasons[0]!.detail.includes("Abort trap: 6"));
// R2b: the slow loop of 24/09 (one restart every ~14 min for 3h) — 12 restarts
// with an exit code 1: the 15-min window never saw 3, the 60-min one does
const slowLoop = livenessVerdict(
  signals({ restarts: 5, heartbeatAt: T0 - MIN, launchd: { checked: true, loaded: true, state: "running", pid: 65886, runs: 40, lastExitCode: 1, lastExitSignal: null, lastExitReason: null } }),
  T0,
);
check("verdict: 5 restarts in the hour with exit 1 = crash-loop (the slow loop of 24/09)", slowLoop.state === "down" && codes(slowLoop) === "crash-loop");
check(
  "verdict: restarts with an unknown exit and a fresh heartbeat stay quiet (idle-nap reason shape)",
  livenessVerdict(signals({ restarts: 3, launchd: { checked: true, loaded: true, state: "running", pid: 29911, runs: 29, lastExitCode: null, lastExitSignal: null, lastExitReason: "JETSAM_REASON_MEMORY_IDLE_EXIT" } }), T0).state === "ok",
);
const heldSince = T0 - DISK_HOLD_ALERT_MS - MIN;
const dh = livenessVerdict(signals({ diskHold: { since: heldSince, last: T0 - 5 * MIN, refusals: 12, detail: "disk low: 2.1gb free (need 5.0gb)", source: "deploy-guard" } }), T0);
check("verdict: disk-guard hold ≥1h = degraded/disk-hold", dh.state === "degraded" && codes(dh) === "disk-hold" && dh.reasons[0]!.detail.includes("12 recusas"));
check(
  "verdict: a hold whose newest refusal is >6h old is over",
  livenessVerdict(signals({ diskHold: { since: T0 - 30 * HOUR, last: T0 - 7 * HOUR, refusals: 5, detail: "", source: "deploy-guard" } }), T0).state === "ok",
);
check(
  "verdict: a young hold (<1h) does not page yet",
  livenessVerdict(signals({ diskHold: { since: T0 - 20 * MIN, last: T0 - MIN, refusals: 3, detail: "", source: "deploy-guard" } }), T0).state === "ok",
);
const pilotHold = (lastAgo: number) =>
  livenessVerdict(signals({ diskHold: { since: T0 - 8 * HOUR, last: T0 - lastAgo, refusals: 0, detail: "free 1.9gb < 5gb", source: "pilot-hold" } }), T0);
check(
  "verdict: an explicit pilot hold whose 6h re-emission is 30 min late still pages",
  pilotHold(6.5 * HOUR).state === "degraded" && pilotHold(6.5 * HOUR).reasons[0]!.detail.startsWith("o pilot está em disk hold há 8h"),
);
check("verdict: an explicit hold silent for >7h counts as over (restarted pilot, no resume)", pilotHold(7.5 * HOUR).state === "ok");
check(
  "verdict: the same 6.5h-old refusal from the deploy guard is already stale (6h window)",
  livenessVerdict(signals({ diskHold: { since: T0 - 8 * HOUR, last: T0 - 6.5 * HOUR, refusals: 4, detail: "", source: "deploy-guard" } }), T0).state === "ok",
);
const dl = livenessVerdict(signals({ deploy: { prodSha: PROD, undeployed: 16, oldestUndeployedAt: T0 - 7 * HOUR } }), T0);
check("verdict: verified merges waiting ≥6h = deploy-lag", dl.state === "degraded" && codes(dl) === "deploy-lag" && dl.reasons[0]!.detail.startsWith("16 merges"));
check(
  "verdict: normal deploy latency (1h) is ok",
  livenessVerdict(signals({ deploy: { prodSha: PROD, undeployed: 2, oldestUndeployedAt: T0 - HOUR } }), T0).state === "ok",
);
const sm = livenessVerdict(signals({ supervisor: { session: "ses_gone1234", probe: "missing" } }), T0);
check("verdict: configured supervisor session missing = degraded", sm.state === "degraded" && codes(sm) === "supervisor-missing");
check("verdict: unknown supervisor probe never accuses", livenessVerdict(signals({ supervisor: { session: "ses_x1234", probe: "unknown" } }), T0).state === "ok");
// R7 visibility: with 0 push subscribers the operator hears nothing — the
// verdict says so (degraded), and the plan below must never page for it alone
const zeroSubs = livenessVerdict(signals(), T0, { subscribers: 0, alerts: true });
check("verdict: 0 push subscribers = degraded/no-push-subscribers", zeroSubs.state === "degraded" && codes(zeroSubs) === "no-push-subscribers");
check("verdict: no-push-subscribers only with alerts on", livenessVerdict(signals(), T0, { subscribers: 0, alerts: false }).state === "ok");
check("verdict: 0 subscribers rides along a real reason in fixed order", codes(livenessVerdict(signals({ deploy: { prodSha: PROD, undeployed: 16, oldestUndeployedAt: T0 - 7 * HOUR } }), T0, { subscribers: 0 })) === "deploy-lag,no-push-subscribers");
check("verdict: the no-push-subscribers detail tells the operator to pair a phone", zeroSubs.reasons[0]!.detail.includes("pareie"));
const combo = livenessVerdict(
  signals({
    pidAlive: false,
    heartbeatAt: T0 - 3 * 24 * HOUR,
    launchd: { ...UNCHECKED_LAUNCHD, checked: true, loaded: false },
    deploy: { prodSha: PROD, undeployed: 16, oldestUndeployedAt: T0 - 90 * HOUR },
    supervisor: { session: "ses_gone1234", probe: "missing" },
  }),
  T0,
);
check("verdict: down reason leads, degraded ones follow in fixed order", codes(combo) === "unloaded,deploy-lag,supervisor-missing");

// ── planAlert ────────────────────────────────────────────────────────────────
const DOWN = unl;
const OK: LivenessVerdict = { state: "ok", reasons: [], heartbeatAgeMs: MIN };
let st: AlertState = EMPTY_ALERT;
let step = planAlert(st, DOWN, T0, { subscribers: 1 });
check(`planner: first bad tick waits for confirmation (${CONFIRM_TICKS} ticks)`, step.message === null && step.next.pending?.seen === 1);
st = step.next;
step = planAlert(st, DOWN, T0 + MIN, { subscribers: 1 });
check("planner: confirmed → one page", step.message?.kind === "alert" && step.message.title === "🛑 Pilot parado" && step.next.episode?.sent === 1);
check("planner: page body carries the real reason", (step.message?.body ?? "").includes("launchd"));
st = step.next;
const reminders: number[] = [];
let t = T0 + MIN;
for (let i = 0; i < 66 * 60; i++) {
  t += MIN; // 66h of 1-minute ticks
  const s = planAlert(st, DOWN, t, { subscribers: 1 });
  if (s.message) reminders.push(Math.round((t - (T0 + MIN)) / MIN));
  st = s.next;
}
const expected = [60, 60 + 240, 60 + 240 + 720, 60 + 240 + 720 + 1440, 60 + 240 + 720 + 2 * 1440];
check(
  "planner: reminders escalate 1h → 4h → 12h → then daily",
  JSON.stringify(reminders) === JSON.stringify(expected),
  `got ${JSON.stringify(reminders)} want ${JSON.stringify(expected)}`,
);
check("planner: reminder title carries the outage age", planAlert({ ...st, episode: { ...st.episode!, lastSentAt: t - 25 * HOUR } }, DOWN, t, { subscribers: 1 }).message?.title.startsWith("🛑 Pilot ainda parado") === true);
const rec = planAlert(st, OK, t + MIN, { subscribers: 1 });
check("planner: recovery sends exactly one 'de volta' message", rec.message?.kind === "recovery" && rec.message.title.includes("de volta") && rec.next.episode === null);
check("planner: after recovery, ok stays silent", planAlert(rec.next, OK, t + 2 * MIN, { subscribers: 1 }).message === null);
const blip = planAlert(planAlert(EMPTY_ALERT, DOWN, T0, { subscribers: 1 }).next, OK, T0 + MIN, { subscribers: 1 });
check("planner: a one-tick blip never pages (and no recovery either)", blip.message === null && blip.next.episode === null && blip.next.pending === null);
const DEG = dl;
const e2 = planAlert(planAlert(EMPTY_ALERT, DEG, T0, { subscribers: 1 }).next, DEG, T0 + MIN, { subscribers: 1 });
check("planner: degraded pages with the attention title", e2.message?.title === "⚠️ Pilot precisa de atenção");
const esc = planAlert(e2.next, DOWN, T0 + 2 * MIN, { subscribers: 1 });
check("planner: degraded → down escalates immediately", esc.message?.kind === "alert" && esc.message.title === "🛑 Pilot parado" && esc.next.episode?.severity === 2);
const deesc = planAlert(esc.next, DEG, T0 + 3 * MIN, { subscribers: 1 });
check(
  "planner: down → degraded sends one 'voltou a rodar' naming what is still wrong",
  deesc.message?.kind === "recovery" && deesc.message.title.includes("voltou a rodar") && deesc.message.body.includes("merges") && deesc.next.episode?.severity === 1,
);
check("planner: degraded reminders are daily", planAlert(deesc.next, DEG, T0 + 3 * MIN + 23 * HOUR, { subscribers: 1 }).message === null && planAlert(deesc.next, DEG, T0 + 3 * MIN + 24 * HOUR, { subscribers: 1 }).message?.kind === "reminder");
const paused = planAlert(esc.next, { state: "paused", reasons: [], heartbeatAgeMs: null }, T0 + 4 * MIN, { subscribers: 1 });
check("planner: pausing (pilot.lock) closes the episode silently", paused.message === null && paused.next.episode === null);
// catch-up: nobody subscribed at the first page, a phone subscribes later
const cu = planAlert(planAlert(EMPTY_ALERT, DOWN, T0, { subscribers: 0 }).next, DOWN, T0 + MIN, { subscribers: 0 });
check("planner: page attempted with 0 subscribers", cu.message?.kind === "alert" && cu.next.episode?.lastSubscribers === 0);
const early = planAlert(cu.next, DOWN, T0 + MIN + CATCH_UP_MS - MIN, { subscribers: 1 });
check("planner: catch-up waits a few minutes after the last attempt", early.message === null);
const late = planAlert(cu.next, DOWN, T0 + MIN + CATCH_UP_MS, { subscribers: 1 });
check("planner: a phone that subscribes mid-outage gets the page", late.message?.kind === "alert" && late.next.episode?.lastSubscribers === 1);
// R7: the 0-subscriber verdict is visibility only — it never opens an episode
// nor pages, and it must not block a real recovery either
const NPS = livenessVerdict(signals(), T0, { subscribers: 0, alerts: true });
check("planner: no-push-subscribers alone never opens an episode", planAlert(EMPTY_ALERT, NPS, T0, { subscribers: 0 }).message === null && planAlert(EMPTY_ALERT, NPS, T0, { subscribers: 0 }).next.episode === null);
const npsSt = planAlert(planAlert(EMPTY_ALERT, NPS, T0, { subscribers: 0 }).next, NPS, T0 + HOUR, { subscribers: 0 });
check("planner: no-push-subscribers alone never pages, ever", npsSt.message === null);
const healthyWithNps = livenessVerdict(signals(), T0, { subscribers: 0, alerts: true });
const recNps = planAlert(st, healthyWithNps, t + 3 * MIN, { subscribers: 0 });
check("planner: a real recovery still fires when only no-push-subscribers remains", recNps.message?.kind === "recovery" && recNps.message.title.includes("de volta"));

// ── persisted state ──────────────────────────────────────────────────────────
check("state: garbage loads as empty", normalizeWatchFile("x").alert.episode === null && normalizeWatchFile({ alert: { episode: { code: "nope" } } }).alert.episode === null);
const rt = normalizeWatchFile(JSON.parse(JSON.stringify({ v: 1, alert: step.next, digest: emptyDigest() })));
check("state: episode round-trips", rt.alert.episode?.code === "unloaded" && rt.alert.episode.sent === 1);

// ── pilotInstalled / env ─────────────────────────────────────────────────────
const P: WatchPaths = {
  stateDir: join("/h", ".opencode-remote"),
  launchAgentsDir: join("/h", "Library", "LaunchAgents"),
  prodRepo: join("/h", ".opencode-remote", "prod"),
};
const has = (...paths: string[]) => ({ exists: (p: string) => paths.includes(p) });
check("installed: launchd plist", pilotInstalled(P, has(join(P.launchAgentsDir, "com.ocr.pilot.plist"))));
check("installed: pilot.json + heartbeat (ran here once)", pilotInstalled(P, has(join(P.stateDir, "pilot.json"), join(P.stateDir, "pilot", "heartbeat"))));
check("installed: pilot.json alone is not enough (no false alarms)", !pilotInstalled(P, has(join(P.stateDir, "pilot.json"))));
check("installed: forced by OCR_PILOTWATCH=on", pilotInstalled(P, has(), true));
const envDef = parsePilotWatchEnv({});
check("env: defaults (alerts on, 60s tick, 30s initial delay)", envDef.alerts && !envDef.forceInstalled && envDef.intervalMs === 60_000 && envDef.initialDelayMs === 30_000 && envDef.problems.length === 0);
check("env: off disables pages", parsePilotWatchEnv({ OCR_PILOTWATCH: "off" }).alerts === false);
const envBad = parsePilotWatchEnv({ OCR_PILOTWATCH: "maybe", OCR_PILOTWATCH_INTERVAL_MS: "abc" });
check("env: invalid values fall back to defaults with a problem line (never a boot failure)", envBad.alerts && envBad.intervalMs === 60_000 && envBad.problems.length === 2);

// ── relay (pilotnotify.ts) ───────────────────────────────────────────────────
check("kind: numbers collapse so repeated refusals group", notifyKind(false, "disk low: 0.1gb free (need 5.0gb)") === notifyKind(false, "disk low: 2.1gb free (need 5.0gb)"));
check("kind: success and failure never share a kind", notifyKind(true, "x") !== notifyKind(false, "x"));
check("sanitize: empty text = null", sanitizeRelayBody({ text: "   " }) === null);
const sb = sanitizeRelayBody({ text: "t", task: "../../etc", ok: "yes", to: "root" });
check("sanitize: hostile task/ok/to fall back to safe defaults", sb?.task === "pilot" && sb.ok === false && sb.to === "supervisor");

interface Posted { session: string; text: string }
function relayDeps(answer: { status: number; text?: string } | Error, session: string | null = "ses_supervisor01") {
  const posted: Posted[] = [];
  const queued: FallbackItem[] = [];
  return {
    posted,
    queued,
    deps: {
      session,
      post: async (s: string, text: string) => {
        posted.push({ session: s, text });
        if (answer instanceof Error) throw answer;
        return { status: answer.status, text: answer.text ?? "" };
      },
      fallback: async (item: FallbackItem) => {
        queued.push(item);
        return { pushed: true, phones: 2 };
      },
    },
  };
}
const FAIL = { text: "🔍 falhou em **deploy**\n\ndisk low", task: "deploy", ok: false, detail: "disk low: 2.1gb free" };
{
  const r = relayDeps({ status: 204 });
  const out = await relayPilotNotify(FAIL, r.deps);
  check("relay: prompt_async 204 = delivered, no fallback", out.delivered === true && !out.fallback && r.queued.length === 0 && r.posted[0]?.session === "ses_supervisor01");
}
{
  const r = relayDeps({ status: 404, text: '{"name":"NotFoundError","data":{"message":"Session not found: ses_supervisor01"}}' });
  const out = await relayPilotNotify(FAIL, r.deps);
  check(
    "relay: deleted session (the production root cause) = session-not-found → phone",
    out.delivered === false && out.reason === "session-not-found" && out.fallback === "push" && out.phones === 2 && r.queued.length === 1,
  );
  check("relay: the phone line is short and names the task", r.queued[0]?.line === "deploy: disk low: 2.1gb free");
}
{
  const r = relayDeps({ status: 404, text: '{"name":"NotFoundError"}' });
  const out = await relayPilotNotify({ ...FAIL, ok: true }, r.deps);
  check("relay: informational message to a dead session is dropped, not paged", out.fallback === "drop" && r.queued.length === 0);
}
{
  const r = relayDeps({ status: 503 });
  const out = await relayPilotNotify(FAIL, r.deps);
  check("relay: upstream 5xx is transient → no ownership (the pilot replays)", out.reason === "upstream-http-503" && out.fallback === undefined && r.queued.length === 0);
}
{
  const r = relayDeps(new Error("fetch failed"));
  const out = await relayPilotNotify(FAIL, r.deps);
  check("relay: opencode unreachable is transient", out.reason === "upstream-unreachable" && out.fallback === undefined);
}
{
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  const out = await relayPilotNotify(FAIL, relayDeps(err).deps);
  check("relay: timeout is named", out.reason === "upstream-timeout" && out.fallback === undefined);
}
{
  const r = relayDeps({ status: 204 }, null);
  const out = await relayPilotNotify(FAIL, r.deps);
  check("relay: no supervisor configured → phone, never a silent drop", out.reason === "no-supervisor-session" && out.fallback === "push" && r.posted.length === 0);
}
{
  const r = relayDeps({ status: 204 }, "ses/../../x");
  const out = await relayPilotNotify(FAIL, r.deps);
  check("relay: malformed session id never reaches the URL", out.reason === "invalid-supervisor-session" && r.posted.length === 0);
}
{
  const r = relayDeps({ status: 204 });
  const out = await relayPilotNotify({ text: "disk low", task: "deploy", kind: "disk-hold", to: "operator" }, r.deps);
  check("relay: operator alerts skip the supervisor entirely", r.posted.length === 0 && out.fallback === "push" && r.queued[0]?.kind === "disk-hold" && r.queued[0]?.to === "operator");
}
{
  const out = await relayPilotNotify(FAIL, {
    session: "ses_supervisor01",
    post: async () => ({ status: 404, text: "NotFoundError" }),
    fallback: async () => {
      throw new Error("disk full");
    },
  });
  check("relay: a digest that cannot queue gives no ownership (the pilot parks)", out.fallback === undefined && out.reason === "session-not-found");
}
check("relay: empty body", (await relayPilotNotify({}, relayDeps({ status: 204 }).deps)).reason === "empty-text");

// ── digest ───────────────────────────────────────────────────────────────────
const item = (task: string, detail: string, to: "supervisor" | "operator" = "supervisor"): FallbackItem => ({
  task,
  kind: notifyKind(false, detail),
  line: `${task}: ${detail}`,
  to,
  reason: "session-not-found",
});
let dg = digestAdd(emptyDigest(), item("deploy", "disk low: 0.1gb free"), T0);
let plan = digestPlan(dg, T0);
check("digest: first item pushes immediately", plan !== null && plan.keys.length === 1 && plan.title === "📮 Pilot: deploy falhou");
check("digest: header names why the supervisor is out", (plan?.body ?? "").startsWith("Supervisor inacessível: a sessão do supervisor não existe mais"));
dg = digestMarkSent(dg, plan!.keys, T0);
for (let i = 1; i <= 30; i++) dg = digestAdd(dg, item("deploy", `disk low: 0.${i}gb free`), T0 + i * MIN);
check("digest: 30 repeats of the same (task, kind) fold into one entry", dg.entries.length === 1 && dg.entries[0]!.count === 30);
check("digest: that key is cooling for 6h — nothing to push", digestPlan(dg, T0 + 31 * MIN) === null);
dg = digestAdd(dg, item("P2-347", "gate green but the PR merge failed"), T0 + 32 * MIN);
plan = digestPlan(dg, T0 + 32 * MIN);
check("digest: a new key goes out (rate window passed), the cooling one stays", plan !== null && plan.keys.length === 1 && plan.keys[0]!.startsWith("P2-347|"));
dg = digestMarkSent(dg, plan!.keys, T0 + 32 * MIN);
dg = digestAdd(dg, item("P3-459", "blocked after 4 attempts"), T0 + 35 * MIN);
check("digest: at most one push per 10 min", digestPlan(dg, T0 + 35 * MIN) === null && digestPlan(dg, T0 + 32 * MIN + DIGEST_MIN_INTERVAL_MS) !== null);
const later = T0 + DIGEST_KEY_COOLDOWN_MS + MIN;
plan = digestPlan(dg, later);
check(
  "digest: after the cooldown the repeated key returns with its count",
  plan !== null && plan.keys.length === 2 && plan.body.includes("(×30)") && plan.title === "📮 Pilot: 2 avisos",
);
let many = emptyDigest();
for (let i = 0; i < 7; i++) many = digestAdd(many, item(`P2-${100 + i}`, "fail"), T0 + i);
const mp = digestPlan(many, T0 + 10);
check("digest: body shows 4 lines then '+N outros'", mp !== null && mp.body.split("\n").filter((l) => l.startsWith("•")).length === 4 && mp.body.includes("+3 outros avisos"));
const op = digestPlan(digestAdd(emptyDigest(), item("deploy", "disk hold", "operator"), T0), T0);
check("digest: operator alert has its own title and no supervisor header", op?.title === "⚠️ Pilot: deploy" && !op.body.includes("Supervisor"));
check("digest: items older than 24h are dropped", digestPlan(digestAdd(emptyDigest(), item("x", "y"), T0), T0 + 25 * HOUR) === null);

// ── watcher end to end: replay of the 24/09 outage ──────────────────────────
interface Page { title: string; body: string; tag: string }
function world() {
  const files = new Map<string, string>();
  const S = P.stateDir;
  files.set(join(P.launchAgentsDir, "com.ocr.pilot.plist"), "<plist/>");
  files.set(join(S, "pilot.json"), JSON.stringify({ supervisorSession: "ses_fb24ccfecffejTK9pFO82UdGt5", slots: 8 }));
  files.set(join(S, "pilot", "heartbeat"), "1790248033162"); // 24/09 08:07:13 -03
  files.set(join(S, "pilot", "pilot.pid"), "35139");
  files.set(join(S, "prod", ".git", "HEAD"), "ref: refs/heads/main\n");
  files.set(join(S, "prod", ".git", "refs", "heads", "main"), `${PROD}\n`);
  const vms = [vm(PROD, "2026-09-23T14:37:24-03:00")];
  for (let i = 0; i < 16; i++) vms.push(vm(String(i).padStart(2, "0").repeat(20), new Date(Date.parse("2026-09-23T15:55:52-03:00") + i * HOUR).toISOString()));
  files.set(join(S, "pilot", "verified-merges.jsonl"), vms.join("\n") + "\n");
  files.set(join(S, "pilot", "events.jsonl"), holdLines.join("\n") + "\n");
  files.set(join(S, "pilot", "notify-pending.jsonl"), Array.from({ length: 100 }, (_, i) => JSON.stringify({ ts: 1790163998621 + i, task: "deploy", ok: false, text: "x" })).join("\n") + "\n");
  const alive = new Set<number>();
  let launchctl: { code: number | null; output: string } | null = {
    code: 113,
    output: 'Bad request.\nCould not find service "com.ocr.pilot" in domain for user gui: 501\n',
  };
  let failWrites = false;
  const launchctlCalls: string[][] = [];
  const io: WatchIo = {
    readText: (p) => files.get(p) ?? null,
    exists: (p) => files.has(p),
    mtimeMs: () => null,
    pidAlive: (pid) => alive.has(pid),
    launchctl: async (args) => {
      launchctlCalls.push(args);
      return launchctl;
    },
    writeState: (p, data) => {
      if (failWrites) throw new Error("ENOSPC: no space left on device");
      files.set(p, data);
    },
  };
  return {
    files,
    io,
    alive,
    launchctlCalls,
    setLaunchctl: (v: typeof launchctl) => {
      launchctl = v;
    },
    setFailWrites: (v: boolean) => {
      failWrites = v;
    },
  };
}

function watcher(w: ReturnType<typeof world>, clock: { t: number }, subs: { n: number }, opts: { probe?: () => "ok" | "missing" | "unknown"; alerts?: boolean } = {}) {
  const pages: Page[] = [];
  const audits: Array<{ event: string; data: Record<string, unknown> }> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const events: Array<{ ok: boolean; detail: string }> = [];
  let probes = 0;
  const watch = createPilotWatch({
    paths: P,
    io: w.io,
    now: () => clock.t,
    platform: "darwin",
    uid: 501,
    alerts: opts.alerts,
    push: async (title, body, data) => {
      pages.push({ title, body, tag: data.tag });
      return { delivered: subs.n, subscribers: subs.n };
    },
    subscribers: () => subs.n,
    probeSupervisor: async () => {
      probes++;
      return opts.probe ? opts.probe() : "missing";
    },
    diskState: () => "ok",
    log: (level, msg) => logs.push({ level, msg }),
    audit: (event, data) => audits.push({ event, data }),
    emitEvent: (f) => events.push({ ok: f.ok, detail: f.detail }),
  });
  return { watch, pages, audits, logs, events, probes: () => probes };
}

{
  const w = world();
  const clock = { t: T0 };
  const subs = { n: 1 };
  const a = watcher(w, clock, subs);
  await a.watch.tick();
  check("watch: first tick confirms, does not page yet", a.pages.length === 0);
  check("watch: launchctl probed read-only with 'print gui/<uid>/com.ocr.pilot'", JSON.stringify(w.launchctlCalls[0]) === JSON.stringify(["print", "gui/501/com.ocr.pilot"]));
  clock.t += MIN;
  await a.watch.tick();
  check("watch: second tick pages the phone", a.pages.length === 1 && a.pages[0]!.title === "🛑 Pilot parado");
  check("watch: page uses the dedicated push tag", a.pages[0]?.tag === PILOT_PUSH_TAG);
  check("watch: page names launchd + extras (deploy lag, supervisor)", /launchd/.test(a.pages[0]?.body ?? "") && /deploy atrasado/.test(a.pages[0]?.body ?? "") && /supervisor inacessível/.test(a.pages[0]?.body ?? ""));
  check("watch: page audited as pilot-liveness", a.audits.some((x) => x.event === "pilot-liveness" && x.data.kind === "alert" && x.data.code === "unloaded" && x.data.delivered === 1));
  check("watch: page lands on the dashboard feed", a.events.length === 1 && a.events[0]!.ok === false);
  check("watch: supervisor probed once (10-min cadence)", a.probes() === 1);
  const snap = await a.watch.current();
  check("snapshot: v1 contract fields", snap.v === 1 && snap.state === "down" && snap.reasons[0]?.code === "unloaded" && snap.reasons[0]?.severity === "down");
  check("snapshot: heartbeat + process + launchd facts", snap.heartbeat.at === 1790248033162 && snap.process.pid === 35139 && snap.process.alive === false && snap.launchd.loaded === false);
  check("snapshot: deploy lag measured from verified merges", snap.deploy.prodSha === PROD && snap.deploy.undeployed === 16);
  check("snapshot: notify backlog + supervisor state", snap.notify.pending === 100 && snap.notify.supervisor === "missing");
  check("snapshot: stale disk hold (3 days old) is reported but not a reason", snap.disk.hold?.refusals === 2 && !snap.reasons.some((r) => r.code === "disk-hold"));
  check("snapshot: alert episode with next reminder time", snap.alert.episode?.sent === 1 && snap.alert.episode.nextAt === clock.t + REMINDER_DOWN_MS[0]!);
  check("snapshot: push subscribers + reachability", snap.push.subscribers === 1 && snap.push.reachable === true);

  // daemon restart: a NEW watcher over the same persisted file must not re-page
  clock.t += 30 * MIN;
  const b = watcher(w, clock, subs);
  await b.watch.tick();
  await b.watch.tick();
  check("watch: a restarted daemon does not repeat the page (persisted episode)", b.pages.length === 0);
  clock.t += 31 * MIN;
  await b.watch.tick();
  check("watch: the 1h reminder still comes on schedule after the restart", b.pages.length === 1 && b.pages[0]!.title.startsWith("🛑 Pilot ainda parado"));

  // the pilot comes back: loaded, alive, fresh heartbeat
  w.setLaunchctl({ code: 0, output: "\tstate = running\n\truns = 1\n\tpid = 777\n\tlast exit code = (never exited)\n" });
  w.alive.add(777);
  w.files.set(join(P.stateDir, "pilot", "pilot.pid"), "777");
  w.files.set(join(P.stateDir, "pilot", "heartbeat"), String(clock.t));
  // the owner also fixed the supervisor and the deploy caught up
  w.files.set(join(P.stateDir, "pilot.json"), JSON.stringify({ slots: 8 }));
  w.files.set(join(P.stateDir, "prod", ".git", "refs", "heads", "main"), `${"15".repeat(20)}\n`);
  clock.t += MIN;
  await b.watch.tick();
  check("watch: recovery sends one 'de volta' page", b.pages.length === 2 && b.pages[1]!.title === "✅ Pilot de volta ao normal");
  check("watch: recovery audited + fed to the dashboard as ok", b.audits.some((x) => x.data.kind === "recovery") && b.events.at(-1)?.ok === true);
  clock.t += MIN;
  w.files.set(join(P.stateDir, "pilot", "heartbeat"), String(clock.t));
  await b.watch.tick();
  check("watch: healthy afterwards stays silent", b.pages.length === 2 && (await b.watch.current()).state === "ok");
}

{
  // nobody subscribed: the page is attempted, logged loudly, and re-sent
  // shortly after a phone subscribes
  const w = world();
  const clock = { t: T0 };
  const subs = { n: 0 };
  const a = watcher(w, clock, subs);
  await a.watch.tick();
  clock.t += MIN;
  await a.watch.tick();
  check("watch: 0 subscribers → attempt made, warning logged", a.pages.length === 1 && a.logs.some((l) => l.level === "warn" && /reached no phone/.test(l.msg)));
  subs.n = 1;
  clock.t += CATCH_UP_MS;
  await a.watch.tick();
  check("watch: the phone that subscribes mid-outage receives the page", a.pages.length === 2 && a.pages[1]!.title === "🛑 Pilot parado");
}

{
  // disk full: the state file cannot be written — pages still go out once
  const w = world();
  w.setFailWrites(true);
  const clock = { t: T0 };
  const a = watcher(w, clock, { n: 1 });
  for (let i = 0; i < 5; i++) {
    await a.watch.tick();
    clock.t += MIN;
  }
  check("watch: ENOSPC on the state file never silences or duplicates pages", a.pages.length === 1);
  check("watch: the persistence failure is logged once", a.logs.filter((l) => /not persisted/.test(l.msg)).length === 1);
}

{
  // paused (pilot.lock) and absent hosts never page
  const w = world();
  w.files.set(join(P.stateDir, "pilot.lock"), "");
  const clock = { t: T0 };
  const a = watcher(w, clock, { n: 1 });
  for (let i = 0; i < 3; i++) {
    await a.watch.tick();
    clock.t += MIN;
  }
  check("watch: pilot.lock (intentional pause) never pages", a.pages.length === 0 && (await a.watch.current()).state === "paused");
  const lay = world();
  for (const k of [...lay.files.keys()]) if (!k.includes("pilot.json")) lay.files.delete(k);
  const b = watcher(lay, clock, { n: 1 });
  for (let i = 0; i < 3; i++) {
    await b.watch.tick();
    clock.t += MIN;
  }
  check("watch: a machine without a pilot is 'absent' and never probes launchd", b.pages.length === 0 && (await b.watch.current()).state === "absent" && lay.launchctlCalls.length === 0);
}

{
  // relay fallback through the watcher's persisted digest
  const w = world();
  const clock = { t: T0 };
  const a = watcher(w, clock, { n: 2 });
  const r1 = await a.watch.enqueue(item("deploy", "disk low: 2.1gb free"));
  check("fallback: first item pushes at once and reports the phones", r1.pushed && r1.phones === 2 && a.pages.length === 1);
  check("fallback: the digest push carries its own tag (a digest never replaces a 🛑 page)", a.pages[0]!.tag === DIGEST_PUSH_TAG && a.pages[0]!.tag !== PILOT_PUSH_TAG);
  clock.t += MIN;
  const r2 = await a.watch.enqueue(item("P2-347", "merge failed"));
  check("fallback: second item inside the 10-min window is held", !r2.pushed && a.pages.length === 1);
  check("fallback: held items survive in the persisted state", (w.files.get(join(P.stateDir, "pilotwatch.json")) ?? "").includes("P2-347"));
  w.files.set(join(P.stateDir, "pilot.lock"), ""); // keep liveness quiet for this beat
  clock.t += DIGEST_MIN_INTERVAL_MS;
  await a.watch.tick();
  check("fallback: the tick flushes the held item once the window passes", a.pages.length === 2 && a.pages[1]!.body.includes("P2-347"));
  check("fallback: pushes audited", a.audits.filter((x) => x.event === "pilot-notify-fallback").length === 2);
}

// ── R1: a healthy pilot inside a long judge gate must not page ──────────────
{
  // judgeGate runs the signed judge with a 30-min execFileSync budget; the
  // 08–11/09 history had 25 gates hold the loop past 10 min (one for 17.9).
  // The old 10-min threshold paged "Pilot parado" mid-gate and retracted it.
  const w = world();
  w.files.delete(join(P.stateDir, "pilot", "notify-pending.jsonl"));
  w.files.delete(join(P.stateDir, "pilot", "events.jsonl"));
  w.files.set(join(P.stateDir, "pilot.json"), JSON.stringify({ slots: 8 }));
  w.files.set(join(P.stateDir, "pilot", "verified-merges.jsonl"), vm(PROD, "2026-09-23T14:37:24-03:00") + "\n");
  w.files.set(join(P.stateDir, "prod", ".git", "refs", "heads", "main"), `${PROD}\n`);
  const gateOutput = "\tstate = running\n\truns = 54\n\tpid = 65883\n\tlast exit code = (never exited)\n";
  w.setLaunchctl({ code: 0, output: gateOutput });
  w.alive.add(65883);
  const clock = { t: T0 };
  const a = watcher(w, clock, { n: 1 });
  w.files.set(join(P.stateDir, "pilot", "heartbeat"), String(clock.t));
  // the gate holds the loop: no heartbeat for 18 min
  for (let i = 1; i <= 18; i++) {
    clock.t += MIN;
    await a.watch.tick();
  }
  check("watch R1: an 18-min gate with a live pid under launchd never pages", a.pages.length === 0, `pages=${JSON.stringify(a.pages)}`);
  check("watch R1: the verdict stays ok through the gate", (await a.watch.current()).state === "ok");
  // the gate ends, the loop beats again
  clock.t += MIN;
  w.files.set(join(P.stateDir, "pilot", "heartbeat"), String(clock.t));
  await a.watch.tick();
  check("watch R1: after the gate the pilot is healthy, no page ever went out", a.pages.length === 0);
  // a REAL stall: heartbeat silent past the budget pages (after confirmation)
  for (let i = 0; i <= STALL_SILENCE_MS / MIN; i++) {
    clock.t += MIN;
    await a.watch.tick();
  }
  clock.t += MIN;
  await a.watch.tick();
  check("watch R1: a real stall (silence past the judge budget) pages once", a.pages.length === 1 && a.pages[0]!.title === "🛑 Pilot parado" && /loop travou/.test(a.pages[0]!.body));
}

// ── R2: the 24/09 OOM crash-loop died by signal — no `last exit code` line ──
{
  const w = world();
  w.files.delete(join(P.stateDir, "pilot", "events.jsonl"));
  w.files.set(join(P.stateDir, "pilot.json"), JSON.stringify({ slots: 8 }));
  w.files.set(join(P.stateDir, "pilot", "verified-merges.jsonl"), vm(PROD, "2026-09-23T14:37:24-03:00") + "\n");
  w.files.set(join(P.stateDir, "prod", ".git", "refs", "heads", "main"), `${PROD}\n`);
  const clock = { t: T0 };
  const a = watcher(w, clock, { n: 1 });
  let runs = 60;
  const signalOutput = (r: number) => `\tstate = running\n\truns = ${r}\n\tpid = 65884\n\tlast terminating signal = Abort trap: 6\n`;
  for (let i = 0; i < 6; i++) {
    w.setLaunchctl({ code: 0, output: signalOutput(runs) });
    w.alive.add(65884);
    w.files.set(join(P.stateDir, "pilot", "heartbeat"), String(clock.t)); // each boot beats before dying again
    clock.t += MIN;
    runs += 1;
    await a.watch.tick();
  }
  check("watch R2: a signal-death crash-loop (4 restarts, no exit-code line) pages", a.pages.some((p) => /einiciando em loop/.test(p.body) && /Abort trap: 6/.test(p.body)), JSON.stringify(a.pages));
  check("watch R2: it is a 🛑 page (down)", a.pages[0]?.title === "🛑 Pilot parado");
}

// ── R2b: the slow loop of 24/09 (one restart every ~14 min for 3h) ──────────
{
  const w = world();
  w.files.delete(join(P.stateDir, "pilot", "events.jsonl"));
  w.files.set(join(P.stateDir, "pilot.json"), JSON.stringify({ slots: 8 }));
  w.files.set(join(P.stateDir, "pilot", "verified-merges.jsonl"), vm(PROD, "2026-09-23T14:37:24-03:00") + "\n");
  w.files.set(join(P.stateDir, "prod", ".git", "refs", "heads", "main"), `${PROD}\n`);
  const clock = { t: T0 };
  const a = watcher(w, clock, { n: 1 });
  let runs = 40;
  for (let i = 0; i < 55; i++) {
    const r = 40 + Math.floor((i * MIN) / (14 * MIN));
    if (r !== runs) {
      runs = r;
      w.alive.delete(65886);
      w.alive.add(65886);
    }
    w.setLaunchctl({ code: 0, output: `\tstate = running\n\truns = ${r}\n\tpid = 65886\n\tlast exit code = 1\n` });
    w.files.set(join(P.stateDir, "pilot", "heartbeat"), String(clock.t));
    clock.t += MIN;
    await a.watch.tick();
  }
  check("watch R2b: the slow crash-loop (5 restarts in the hour) pages — the 15-min window never saw it", a.pages.some((p) => /einiciando em loop/.test(p.body)), JSON.stringify(a.pages.map((p) => p.title)));
}

// ── R3: the supervisor probe flap must not fabricate a recovery ─────────────
{
  const w = world();
  w.files.delete(join(P.stateDir, "pilot", "notify-pending.jsonl"));
  w.files.delete(join(P.stateDir, "pilot", "events.jsonl"));
  w.files.set(join(P.stateDir, "pilot", "verified-merges.jsonl"), vm(PROD, "2026-09-23T14:37:24-03:00") + "\n");
  w.files.set(join(P.stateDir, "prod", ".git", "refs", "heads", "main"), `${PROD}\n`);
  w.setLaunchctl({ code: 0, output: "\tstate = running\n\truns = 54\n\tpid = 65883\n\tlast exit code = (never exited)\n" });
  w.alive.add(65883);
  const clock = { t: T0 };
  const seq = ["missing", "unknown", "ok", "ok"] as const;
  let pi = 0;
  const a = watcher(w, clock, { n: 1 }, { probe: () => seq[Math.min(pi++, seq.length - 1)]! });
  const beat = async () => {
    w.files.set(join(P.stateDir, "pilot", "heartbeat"), String(clock.t));
    await a.watch.tick();
  };
  await beat(); // probe 1 = missing
  clock.t += MIN;
  await beat(); // probe cached → confirmed → ⚠️
  check("watch R3: the missing supervisor pages once (⚠️)", a.pages.length === 1 && a.pages[0]!.title === "⚠️ Pilot precisa de atenção", JSON.stringify(a.pages));
  clock.t += 9 * MIN;
  await beat(); // probe 2 = unknown → the last definitive verdict must hold
  check("watch R3: an unknown probe does not close the episode (no fake recovery)", a.pages.length === 1 && (await a.watch.current()).state === "degraded");
  clock.t += 10 * MIN;
  await beat(); // probe 3 = ok #1 → still closing, no recovery yet
  check("watch R3: one healthy probe after missing is not enough", a.pages.length === 1 && (await a.watch.current()).state === "degraded");
  clock.t += 10 * MIN;
  await beat(); // probe 4 = ok #2 → recovery
  check("watch R3: two consecutive healthy probes close it with one ✅", a.pages.length === 2 && a.pages[1]!.title === "✅ Pilot de volta ao normal", JSON.stringify(a.pages.map((p) => p.title)));
  clock.t += MIN;
  await beat();
  check("watch R3: healthy afterwards stays silent", a.pages.length === 2 && (await a.watch.current()).state === "ok");
}

// ── R4: the pid file is not the witness (PIDs recycle) ──────────────────────
{
  // R4a: exit 113 (not loaded) + pilot.pid recycled to a foreign process +
  // stale heartbeat → unloaded, never a stall pointing at a stranger's pid
  const w = world();
  w.alive.add(35139); // a foreign process owns the recycled pid now
  w.files.set(join(P.stateDir, "pilot.json"), JSON.stringify({ slots: 8 })); // no supervisor noise
  const clock = { t: T0 };
  const a = watcher(w, clock, { n: 1 });
  await a.watch.tick();
  clock.t += MIN;
  await a.watch.tick();
  const snap = await a.watch.current();
  check("watch R4a: recycled pid + not loaded + stale heartbeat = down/unloaded", snap.state === "down" && snap.reasons[0]?.code === "unloaded");
  check("watch R4a: the page never claims a foreign pid is the pilot's loop", !a.pages.some((p) => /pid 35139/.test(p.body)), JSON.stringify(a.pages));
  // R4b: same, but the heartbeat is fresh — reads as a deliberate manual run
  const w2 = world();
  w2.alive.add(35139);
  w2.files.set(join(P.stateDir, "pilot.json"), JSON.stringify({ slots: 8 }));
  w2.files.set(join(P.stateDir, "pilot", "verified-merges.jsonl"), vm(PROD, "2026-09-23T14:37:24-03:00") + "\n");
  w2.files.set(join(P.stateDir, "prod", ".git", "refs", "heads", "main"), `${PROD}\n`);
  const clock2 = { t: T0 };
  w2.files.set(join(P.stateDir, "pilot", "heartbeat"), String(clock2.t));
  const b = watcher(w2, clock2, { n: 1 });
  await b.watch.tick();
  check("watch R4b: fresh heartbeat while launchd says not loaded = manual run, no page", (await b.watch.current()).state === "ok" && b.pages.length === 0);
  // R4c: launchd loaded → the launchd pid is the pilot's, not the pid file's
  const w3 = world();
  w3.setLaunchctl({ code: 0, output: "\tstate = running\n\truns = 54\n\tpid = 65883\n\tlast exit code = (never exited)\n" });
  w3.alive.add(65883);
  w3.files.set(join(P.stateDir, "pilot", "heartbeat"), String(T0));
  const clock3 = { t: T0 };
  const c = watcher(w3, clock3, { n: 1 });
  await c.watch.tick();
  const snap3 = await c.watch.current();
  check("watch R4c: a loaded job reports the launchd pid, not the stale pid file", snap3.process.pid === 65883 && snap3.process.alive === true, JSON.stringify(snap3.process));
}

// ── R7: with 0 phones the digest must not throw the message away ────────────
{
  const w = world();
  w.files.set(join(P.stateDir, "pilot.lock"), ""); // keep liveness quiet for this beat
  const clock = { t: T0 };
  const subs = { n: 0 };
  const a = watcher(w, clock, subs);
  const r = await a.watch.enqueue(item("deploy", "disk low: 2.1gb free"));
  check("fallback R7: 0 phones → no ownership claim on delivery, item queued", r.pushed === false && r.phones === 0);
  check("fallback R7: with 0 phones the digest does not push (the message waits)", !a.pages.some((p) => p.tag === DIGEST_PUSH_TAG));
  check("fallback R7: the digest keeps the item (dropping it would lose the message)", (w.files.get(join(P.stateDir, "pilotwatch.json")) ?? "").includes('"entries":[{"key":"deploy|'));
  clock.t += DIGEST_MIN_INTERVAL_MS + MIN;
  subs.n = 1;
  await a.watch.tick();
  check("fallback R7: a phone subscribing later still gets the digest", a.pages.some((p) => p.tag === DIGEST_PUSH_TAG && /disk low/.test(p.body)), JSON.stringify(a.pages));
}
{
  // R7 visibility on a healthy pilot: 0 phones = degraded with the reason,
  // never a page of its own
  const w = world();
  w.files.delete(join(P.stateDir, "pilot", "notify-pending.jsonl"));
  w.files.delete(join(P.stateDir, "pilot", "events.jsonl"));
  w.files.set(join(P.stateDir, "pilot.json"), JSON.stringify({ slots: 8 }));
  w.files.set(join(P.stateDir, "pilot", "verified-merges.jsonl"), vm(PROD, "2026-09-23T14:37:24-03:00") + "\n");
  w.files.set(join(P.stateDir, "prod", ".git", "refs", "heads", "main"), `${PROD}\n`);
  w.setLaunchctl({ code: 0, output: "\tstate = running\n\truns = 54\n\tpid = 65883\n\tlast exit code = (never exited)\n" });
  w.alive.add(65883);
  w.files.set(join(P.stateDir, "pilot", "heartbeat"), String(T0));
  const clock = { t: T0 };
  const a = watcher(w, clock, { n: 0 });
  await a.watch.tick();
  const snap = await a.watch.current();
  check("fallback R7: a healthy pilot with 0 phones is degraded with the reason", snap.state === "degraded" && snap.reasons[0]?.code === "no-push-subscribers" && snap.push.reachable === false, JSON.stringify(snap.reasons));
  check("fallback R7: no episode opened for it", snap.alert.episode === null && a.pages.length === 0);
}

// ── R8: OCR_PILOTWATCH=off disables every push, the digest flush included ───
{
  const w = world();
  w.files.set(join(P.stateDir, "pilot.lock"), ""); // keep liveness quiet for this beat
  const clock = { t: T0 };
  const a = watcher(w, clock, { n: 1 }, { alerts: false });
  const r = await a.watch.enqueue(item("deploy", "disk low: 2.1gb free"));
  check("watch R8: with alerts off nothing is pushed (the doc contract)", r.pushed === false && a.pages.length === 0);
  clock.t += DIGEST_MIN_INTERVAL_MS + MIN;
  await a.watch.tick();
  check("watch R8: the tick does not flush the digest either", a.pages.length === 0);
  check("watch R8: the item stays queued for when alerts come back", (w.files.get(join(P.stateDir, "pilotwatch.json")) ?? "").includes('"entries":[{"key":"deploy|'));
  const snap = await a.watch.current();
  check("watch R8: with alerts off there is no no-push-subscribers noise", !snap.reasons.some((x) => x.code === "no-push-subscribers") && snap.alerts === false);
}

// ── the phone side: the real service worker push handler (vm sandbox) ──────
{
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Array<{ title: string; opts: { tag?: string; renotify?: boolean; data?: { url?: string } } }> = [];
  const ctx = createContext({
    URL,
    console,
    importScripts: () => {},
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      registration: {
        scope: "https://phone.example/",
        showNotification: async (title: string, opts: (typeof shown)[number]["opts"]) => {
          shown.push({ title, opts });
        },
      },
    },
  });
  runInContext(readFileSync(join(import.meta.dirname, "..", "apps", "web", "public", "sw.js"), "utf8"), ctx);
  const push = (payload: unknown) =>
    listeners.get("push")?.({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => p });
  push({ title: "🛑 Pilot parado", body: "x", data: { url: "#/", tag: PILOT_PUSH_TAG } });
  push({ title: "Agent finished", body: "y", data: { url: "#/s/1" } });
  await new Promise((r) => setTimeout(r, 10));
  check("sw: a pilot page keeps its own tag (routine notifications cannot replace it)", shown[0]?.opts.tag === PILOT_PUSH_TAG);
  check("sw: a pilot page re-alerts even when it replaces an older one (renotify)", shown[0]?.opts.renotify === true);
  check("sw: routine pushes keep the shared tag without renotify", shown[1]?.opts.tag === "opencode-remote" && shown[1]?.opts.renotify === false);
  check("sw: deep link still resolved against the scope", shown[1]?.opts.data?.url === "https://phone.example/#/s/1");
}

// ── the pilot's own self-watchdog: a blocked loop is not a hung loop ────────
check("selfwatch verdict: fresh heartbeat, on-time tick = ok", selfWatchVerdict({ silentMs: 10_000, tickGapMs: MIN, maxSilenceMs: 3 * MIN, intervalMs: WATCHDOG_INTERVAL_MS }) === "ok");
check("selfwatch verdict: stale heartbeat, on-time tick = exit", selfWatchVerdict({ silentMs: 4 * MIN, tickGapMs: MIN, maxSilenceMs: 3 * MIN, intervalMs: WATCHDOG_INTERVAL_MS }) === "exit");
check("selfwatch verdict: overdue tick (loop blocked / machine slept) = blocked", selfWatchVerdict({ silentMs: 6 * MIN, tickGapMs: 6 * MIN, maxSilenceMs: 3 * MIN, intervalMs: WATCHDOG_INTERVAL_MS }) === "blocked");
check("selfwatch verdict: a tick slightly late (<2 intervals) is still judged normally", selfWatchVerdict({ silentMs: 4 * MIN, tickGapMs: 119_000, maxSilenceMs: 3 * MIN, intervalMs: WATCHDOG_INTERVAL_MS }) === "exit");
check("selfwatch verdict: unreadable heartbeat (NaN) never exits", selfWatchVerdict({ silentMs: NaN, tickGapMs: MIN, maxSilenceMs: 3 * MIN, intervalMs: WATCHDOG_INTERVAL_MS }) === "ok");
{
  let clock = T0;
  let hb = T0;
  let tick: () => void = () => {};
  const exits: number[] = [];
  const out: string[] = [];
  startWatchdog(3, {
    now: () => clock,
    heartbeatAgeMs: (at) => at - hb,
    touch: () => {
      hb = clock;
    },
    exit: (code) => exits.push(code),
    schedule: (fn) => {
      tick = fn;
      return 0;
    },
    out: (line) => out.push(line),
  });
  clock += MIN;
  hb = clock - 10_000; // the main loop is feeding the heartbeat
  tick();
  check("selfwatch: a healthy tick stays quiet", exits.length === 0);
  clock += 6 * MIN; // judgeGate's execFileSync held the loop for 6 min (24/09 04:19 shape)
  tick();
  check("selfwatch: the overdue tick after a 6-min sync call re-arms instead of exit(1)", exits.length === 0 && hb === clock);
  check("selfwatch: the re-arm is logged", out.some((l) => l.includes("event loop was blocked") && l.includes('"blockedS":360')));
  for (let i = 0; i < 4; i++) {
    clock += MIN; // on-time ticks, but nothing feeds the heartbeat: a real stall
    tick();
  }
  check("selfwatch: a stale heartbeat with on-time ticks still exits once", exits.length === 1 && exits[0] === 1 && out.some((l) => l.includes("heartbeat stale")));
}

if (failures) {
  console.error(`pilotwatch: ${failures} failure(s)`);
  process.exit(1);
}
console.log("pilotwatch: all checks passed");
process.exit(0);
