import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "./runner";
import { emit } from "./events";
import { log, nowLocalISO } from "./log";
import { captureUiShot } from "./shot";
import { touchHeartbeat, type PilotConfig } from "./state";
import { notifySupervisor } from "./notify";
import { DISK_MIN_FREE_BYTES, diskGuardDetail, freeDiskBytes } from "./disk";
import {
  defaultLastInstallFile,
  defaultQuarantineFile,
  defaultVerifiedMergesFile,
  installModeFor,
  pickDeployableSha,
  quarantineSha,
  readLastInstall,
  readQuarantine,
  readVerifiedMerges,
  shaGuardDetail,
  SHA_RE,
  writeLastInstall,
  type QuarantinedSha,
  type VerifiedMerge,
} from "./deployguard";

export interface DeployResult {
  ok: boolean;
  rolledBack: boolean;
  detail: string;
}

// ── P1-044 autocatalysis lane: reinforced deploy for apps/pilot/** merges �───

/**
 * P1-044 (b): the soak window for a deploy that changes the pilot's own code
 * doubles (min 20min) — the brain that monitors itself gets a longer watch.
 * Pure so the eval battery can pin the lane budgets.
 */
export function soakMinutesFor(monitorMin: number, pilotInfra: boolean): number {
  if (!pilotInfra) return monitorMin;
  return Math.max(monitorMin * 2, 20);
}

/** P1-044 (c): sliding health window compared against the pre-deploy baseline. */
export const SOAK_WINDOW = 5;
/** P1-044 (b): an extra `invariants --live` run every Nth soak check (≈5min). */
export const LIVE_INVARIANT_EVERY = 5;
/** P1-044 (c): health probes sampled before the deploy mutation. */
export const BASELINE_SAMPLES = 3;
/** P1-044 (c): a window failure rate more than this above the baseline rolls back. */
export const SOAK_RATE_TOLERANCE = 0.2;

/**
 * P1-044 (c): failure rate (0..1) of the pre-deploy health probes.
 * Empty sample set → 0 (no evidence of pre-existing failure).
 */
export function baselineFailureRate(samples: boolean[]): number {
  if (!samples.length) return 0;
  return samples.filter((h) => !h).length / samples.length;
}

/**
 * P1-044 (c): pure rollback decision — true when the soak's sliding health
 * window is full AND its failure rate exceeds the pre-deploy baseline by more
 * than SOAK_RATE_TOLERANCE. Catches intermittent degradation that the
 * 3-consecutive-failures rule never sees (e.g. 2 failures per 5 checks against
 * a clean baseline). Only a full window counts, so early noise cannot trip it.
 */
export function soakFailureRateExceeded(window: boolean[], baselineRate: number, tolerance = SOAK_RATE_TOLERANCE): boolean {
  if (window.length < SOAK_WINDOW) return false;
  const rate = window.filter((h) => !h).length / window.length;
  return rate - baselineRate > tolerance;
}

/**
 * P1-034: pure self-reload decision — the brain must never run stale code, so
 * a successful deploy reloads whenever the HEAD it just produced differs from
 * the pre-deploy HEAD, regardless of WHICH files changed (the old apps/pilot
 * diff here compared sha against itself post-reset and was always empty).
 * Empty or malformed ids → false: a failed probe can never loop restarts.
 */
export function shouldSelfReload(prev: string, head: string): boolean {
  return SHA_RE.test(prev) && SHA_RE.test(head) && prev !== head;
}

/**
 * P3-101: stale-process detection — true when `headNow` is a valid sha that
 * differs from the sha the running process booted on (`bootHead`). Covers the
 * gap the deploy-time self-reload cannot: a process spawned BEFORE the
 * deploy-time reload was fixed still carries the dead reload path in memory
 * (the P1-095 trigger merged and deployed but never went live — the Sep-1
 * process never picked it up). Empty/malformed shas → false: a failed probe
 * can never flap restarts.
 */
export function headDrifted(bootHead: string | undefined, headNow: string | undefined): boolean {
  return Boolean(
    bootHead && headNow && SHA_RE.test(bootHead) && SHA_RE.test(headNow) && bootHead !== headNow,
  );
}

/**
 * P3-101 (round 2): the self-heal exit decision as a pure seam — the process
 * may only exit for a HEAD drift at a FULLY idle moment (no slot running a
 * pipeline, no deploy in flight). A refactor that drops either idle gate
 * would silently enable mid-pipeline self-kills (killing builders/reviewers
 * and burning the round), so both gates are pinned by the unit battery.
 */
export function shouldSelfHealReload(
  runningSlots: number,
  deployBusy: boolean,
  bootHead: string | undefined,
  headNow: string | undefined,
): boolean {
  return runningSlots === 0 && !deployBusy && headDrifted(bootHead, headNow);
}

/** P1-044: interval between soak health checks (the soak loop's clock). */
export const SOAK_INTERVAL_SEC = 60;
export const SOAK_INTERVAL_MS = SOAK_INTERVAL_SEC * 1000;

/**
 * P1-044 (round 2): pre-deploy health baseline, extracted with an injectable
 * probe/clock so the eval battery can pin the sampling without touching git/npm.
 */
export async function baselineHealthRate(
  probe: () => Promise<boolean>,
  samples = BASELINE_SAMPLES,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<number> {
  const out: boolean[] = [];
  for (let i = 0; i < samples; i++) {
    out.push(await probe());
    if (i < samples - 1) await sleep(1_000);
  }
  return baselineFailureRate(out);
}

export type SoakOutcome = "ok" | "health" | "live" | "rate";

export interface SoakResult {
  outcome: SoakOutcome;
  /** 1-based index of the check where a failure surfaced (checks count when ok). */
  at: number;
  /** Human reason for the rollback — empty when outcome === "ok". */
  why: string;
}

export interface SoakOpts {
  checks: number;
  pilotInfra: boolean;
  baselineRate: number;
  probe: () => Promise<boolean>;
  heartbeat: () => void;
  /** Extra live-invariant runner (autocatalysis lane). Runs synchronously and
   * may take minutes — the caller must keep the heartbeat fresh around it. */
  live?: () => { ok: boolean; output: string };
  /** Injectable clock (tests); default = real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable event sink (tests); default = no-op. */
  onEvent?: (fields: { phase: string; ok: boolean; detail?: string }) => void;
}

/**
 * P1-044: the post-deploy soak watch loop, extracted from deploy() so the eval
 * battery can pin the wiring (window push/shift, live-invariant scheduling,
 * rollback triggers) instead of only the pure helpers. 3 consecutive health
 * failures, a failed extra live-invariant run or a failure-rate regression
 * against the pre-deploy baseline each stop the loop with the matching
 * outcome; the caller owns quarantine + rollback.
 */
export async function soakWatch(o: SoakOpts): Promise<SoakResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let fails = 0;
  const window: boolean[] = [];
  for (let i = 0; i < o.checks; i++) {
    await sleep(SOAK_INTERVAL_MS);
    o.heartbeat();
    const healthy = await o.probe();
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "soak", data: { check: i + 1, of: o.checks, healthy } }));
    o.onEvent?.({ phase: `soak ${i + 1}/${o.checks}`, ok: healthy });
    window.push(healthy);
    if (window.length > SOAK_WINDOW) window.shift();
    if (!healthy) {
      fails++;
      if (fails >= 3) return { outcome: "health", at: i + 1, why: `soak failed after ${i + 1} checks` };
    } else fails = 0;
    if (o.pilotInfra && (i + 1) % LIVE_INVARIANT_EVERY === 0) {
      // Round 2: this exec blocks the event loop for up to 5min (execSync) —
      // touch the heartbeat on BOTH sides or the watchdog (same process) exits
      // before the caller can quarantine + roll back, leaving an unsoaked SHA.
      o.heartbeat();
      const live = o.live?.() ?? { ok: true, output: "" };
      o.onEvent?.({
        phase: `live-invariants ${i + 1}/${o.checks}`,
        ok: live.ok,
        detail: live.ok ? undefined : live.output.slice(-200),
      });
      o.heartbeat();
      if (!live.ok) {
        return { outcome: "live", at: i + 1, why: `live invariants failed during soak (check ${i + 1}): ${live.output.slice(-200)}` };
      }
    }
    if (o.pilotInfra && soakFailureRateExceeded(window, o.baselineRate)) {
      const f = window.filter((h) => !h).length;
      return { outcome: "rate", at: i + 1, why: `soak failure rate ${f}/${window.length} above baseline ${o.baselineRate.toFixed(2)}` };
    }
  }
  return { outcome: "ok", at: o.checks, why: "" };
}

/**
 * P3-006: injectable disk-guard dependencies — tests mock the free-space probe,
 * the threshold, the event stream and the supervisor notify to pin the
 * abort-before-npm-ci path without touching the production event log.
 * P2-058: the sha guard lists are injectable too — the eval battery pins the
 * refuse-unverified / refuse-quarantined rules without touching pilot state.
 */
export interface DeployOpts {
  minFreeBytes?: number;
  probeFreeBytes?: (path: string) => Promise<number | null>;
  notify?: typeof notifySupervisor;
  emitEvent?: typeof emit;
  /** P2-058: pre-loaded guard lists; absent = read the default pilot state files. */
  verifiedMerges?: VerifiedMerge[];
  quarantine?: QuarantinedSha[];
  /** P1-044: force the autocatalysis lane on/off (tests); absent = detect from
   * the prev..sha diff against apps/pilot. */
  pilotInfra?: boolean;
  /** P1-044: injectable health probe for the pre-deploy baseline (tests). */
  probeHealth?: () => Promise<boolean>;
}

/**
 * Staged deploy of a merged SHA into the production checkout:
 * reset prod repo to SHA → install → build → restart services → health watch.
 * Any failure rolls back to the previous SHA automatically.
 * `meta.ui` (P2-011): after a clean deploy of a UI-touching task, capture a
 * screenshot of the deployed dashboard into the review log (pilot/shots).
 * P3-006: aborts with a clear detail (and a supervisor notify) before touching
 * anything when free disk space is below the 5GB ceiling.
 * P2-058: refuses any SHA the gatekeeper did not record as a verified merge
 * (direct pushes to main never deploy) and quarantines a SHA whose deploy
 * fails, so the pending-deploy self-heal cannot re-run the same broken brain.
 * P1-044: when the sha range changes apps/pilot/** (autocatalysis lane, or
 * `opts.pilotInfra` forced by tests), the soak doubles with extra live
 * invariant runs and a failure-rate regression against the pre-deploy
 * baseline rolls back automatically.
 * P2-041: every rollback ends with a bounded health watch — an unhealthy prod
 * after rollback is logged, emitted (`rollback-health` deploy event → red
 * dashboard chip) and escalated to the supervisor instead of failing silently.
 */
export async function deploy(
  cfg: PilotConfig,
  sha: string,
  meta?: { task?: string; ui?: boolean },
  opts?: DeployOpts,
): Promise<DeployResult> {
  const emitEvent = opts?.emitEvent ?? emit;
  // P2-041: post-rollback health watch deps — reuses the deploy's injectable
  // probe/event sink/notify so the eval battery can pin the wiring hermetically.
  const rollbackHealth = (task: string): RollbackHealthHooks => ({
    task,
    probe: opts?.probeHealth,
    onEvent: (fields) => emitEvent("deploy", fields),
    notify: opts?.notify,
  });
  emitEvent("deploy", { phase: "start", detail: `sha ${sha.slice(0, 7)}` });
  // P2-058 sha guard: first gate of all — a SHA the gatekeeper did not verify
  // (or that failed a previous deploy) must not reach production, even before
  // the disk probe. Refusal is expected behavior, not a failure: no notify.
  const verified = opts?.verifiedMerges ?? readVerifiedMerges(defaultVerifiedMergesFile());
  const banned = opts?.quarantine ?? readQuarantine(defaultQuarantineFile());
  const shaGuard = shaGuardDetail(sha, verified, banned);
  if (shaGuard) {
    log("warn", shaGuard);
    emitEvent("deploy", { phase: "sha-guard", ok: false, detail: shaGuard });
    return { ok: false, rolledBack: false, detail: shaGuard };
  }
  // P3-006 disk guard: must run before ANY mutation (git/npm) — a full disk
  // used to surface later as a cryptic git index.lock failure. Unavailable
  // probe = proceed (fail-open).
  const probe = opts?.probeFreeBytes ?? freeDiskBytes;
  const guard = diskGuardDetail(await probe(cfg.repo), opts?.minFreeBytes ?? DISK_MIN_FREE_BYTES);
  if (guard) {
    log("warn", guard);
    emitEvent("deploy", { phase: "disk-guard", ok: false, detail: guard });
    await (opts?.notify ?? notifySupervisor)(meta?.task ?? "deploy", false, guard);
    return { ok: false, rolledBack: false, detail: guard };
  }
  const prev = exec("git rev-parse HEAD", { cwd: cfg.repo }).output.trim();
  // P1-044: the lane applies when this deploy changes the pilot's own code —
  // detected from the real sha range (covers the pending-deploy self-heal too);
  // both shas are validated object ids (prev from rev-parse, sha by shaGuard).
  const pilotInfra =
    opts?.pilotInfra ??
    (exec(`git diff --name-only ${prev} ${sha} -- apps/pilot`, { cwd: cfg.repo, allowFail: true }).output.trim().length > 0);
  // P1-044 (c): pre-deploy health baseline, sampled before any mutation — the
  // window comparison during soak needs the old deployment's own failure rate.
  // ok:false on a fully failing baseline (dashboard must not read green).
  let baselineRate = 0;
  if (pilotInfra) {
    baselineRate = await baselineHealthRate(opts?.probeHealth ?? (() => isHealthy(cfg)));
    emitEvent("deploy", {
      phase: "baseline",
      ok: baselineRate < 1,
      detail: `${Math.round(baselineRate * BASELINE_SAMPLES)}/${BASELINE_SAMPLES} failing (autocatalysis lane)`,
    });
  }
  try {
    exec(`git fetch origin`, { cwd: cfg.repo });
    exec("git checkout -q main", { cwd: cfg.repo, allowFail: true });
    exec(`git reset -q --hard ${sha}`, { cwd: cfg.repo });
    // P1-021: install decision from the persisted last-install state. The hash
    // is computed once, after the reset, from HEAD's lockfile; a full `npm ci`
    // runs unless this exact lock was already installed successfully (missing/
    // corrupt state and empty hashes fail closed to "ci").
    const lockHash = exec("git show HEAD:package-lock.json | shasum -a 256 | cut -d' ' -f1", { cwd: cfg.repo, allowFail: true }).output.trim();
    const mode = installModeFor(lockHash, readLastInstall(defaultLastInstallFile()));
    const installStart = Date.now();
    let installed = false;
    if (mode === "fast") {
      console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "lock unchanged — fast install (no wipe)" }));
      const fast = exec(FAST_INSTALL_CMD, { cwd: cfg.repo, timeoutMin: 5, allowFail: true });
      if (fast.ok) {
        emitEvent("deploy", { phase: "install", ok: true, detail: `fast-install (lock unchanged) in ${Math.max(1, Math.round((Date.now() - installStart) / 1000))}s` });
        installed = true;
      } else {
        // Repair ladder: the fast path repairs ordinary node_modules drift; a
        // failure here means something deeper — fall through to a full ci
        // (which has its own retry) before declaring the deploy failed.
        console.log(JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "fast install failed — falling back to npm ci", data: fast.output.slice(-300) }));
      }
    } else {
      console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "lock changed (or no install state) — full npm ci" }));
    }
    if (!installed) {
      npmInstall(cfg); // throws on final failure → rollback path
      emitEvent("deploy", { phase: "install", ok: true, detail: `npm ci in ${Math.max(1, Math.round((Date.now() - installStart) / 1000))}s` });
      writeLastInstall(defaultLastInstallFile(), lockHash, nowLocalISO());
    }
    exec("npm run build --silent", { cwd: cfg.repo, timeoutMin: 15 });
    kickstart(cfg, "com.ocr.relay");
    kickstart(cfg, "com.ocr.daemon");
    kickstartPwa(cfg);
  } catch (err) {
    await banAndRollback(cfg, sha, prev, `deploy steps failed: ${String(err).slice(0, 200)}`, meta?.task ?? "deploy", opts?.notify ?? notifySupervisor, rollbackHealth(meta?.task ?? "deploy"));
    return { ok: false, rolledBack: true, detail: String(err).slice(0, 200) };
  }

  // health watch: services must come up healthy
  const healthy = await pollHealth(cfg, 90);
  if (!healthy) {
    await banAndRollback(cfg, sha, prev, "health check failed after deploy", meta?.task ?? "deploy", opts?.notify ?? notifySupervisor, rollbackHealth(meta?.task ?? "deploy"));
    return { ok: false, rolledBack: true, detail: "health check failed" };
  }

  // live invariants against production (replay, tunnel, state perms)
  const inv = exec("npx tsx scripts/invariants.ts --live", { cwd: cfg.repo, timeoutMin: 5, allowFail: true });
  if (!inv.ok) {
    await banAndRollback(cfg, sha, prev, `live invariants failed: ${inv.output.slice(-200)}`, meta?.task ?? "deploy", opts?.notify ?? notifySupervisor, rollbackHealth(meta?.task ?? "deploy"));
    return { ok: false, rolledBack: true, detail: "live invariants failed" };
  }

  // soak: keep watching for the monitor window; 3 consecutive failures = rollback
  // P1-044: autocatalysis lane — doubled window, extra live invariant runs and
  // a failure-rate rollback against the pre-deploy baseline. All soak-loop
  // events flow through the injectable emitEvent (P3-006 pattern).
  const soakMin = soakMinutesFor(cfg.monitorMin, pilotInfra);
  const checks = Math.floor((soakMin * 60) / SOAK_INTERVAL_SEC);
  const soak = await soakWatch({
    checks,
    pilotInfra,
    baselineRate,
    probe: () => isHealthy(cfg),
    heartbeat: touchHeartbeat,
    live: () => {
      touchHeartbeat(); // before: the exec below blocks the loop for minutes
      const r = exec("npx tsx scripts/invariants.ts --live", { cwd: cfg.repo, timeoutMin: 5, allowFail: true });
      touchHeartbeat(); // after: the watchdog timer fires as soon as the loop unblocks
      return r;
    },
    onEvent: (e) => emitEvent("deploy", e),
  });
  if (soak.outcome !== "ok") {
    const detail =
      soak.outcome === "health" ? "soak failed" : soak.outcome === "live" ? "live invariants failed during soak" : "soak failure rate regression";
    emitEvent("deploy", {
      phase: "rollback",
      ok: false,
      detail: soak.outcome === "health" ? "soak failed" : soak.outcome === "live" ? "live invariants failed during soak" : "soak failure rate above pre-deploy baseline",
    });
    await banAndRollback(cfg, sha, prev, soak.why, meta?.task ?? "deploy", opts?.notify ?? notifySupervisor, rollbackHealth(meta?.task ?? "deploy"));
    return { ok: false, rolledBack: true, detail };
  }
  emit("deploy", { phase: "done", ok: true, detail: `sha ${sha.slice(0, 7)} live` });
  // P2-011: UI-changing cycles leave visual evidence in the review log — a
  // post-deploy screenshot the reviewer agents cite in their verdicts.
  if (meta?.ui && meta.task) {
    const shotPath = await captureUiShot(meta.task, sha);
    emit("phase", {
      task: meta.task,
      phase: "ui-shot",
      ok: Boolean(shotPath),
      detail: shotPath ?? "post-deploy screenshot unavailable",
    });
  }
  // self-update (P1-034): reload whenever HEAD moved. `prev` was captured
  // before any mutation; the post-reset rev-parse gives the full id (an
  // abbreviated sha would false-positive against SHA_RE-normalized prev).
  // KeepAlive restarts the monitor on the new code; the pidfile singleton
  // covers any overlap.
  const headNow = exec("git rev-parse HEAD", { cwd: cfg.repo, allowFail: true }).output.trim();
  if (shouldSelfReload(prev, headNow)) {
    const moved = `HEAD moved ${prev.slice(0, 7)} → ${headNow.slice(0, 7)}`;
    log("warn", `${moved} — self-reloading`);
    emitEvent("deploy", { phase: "self-reload", ok: true, detail: moved });
    process.exit(0); // log is flushed synchronously; the pidfile singleton covers any overlap
  }
  return { ok: true, rolledBack: false, detail: `deployed ${sha.slice(0, 7)} (prev ${prev.slice(0, 7)})` };
}

/**
 * P1-021: fast install for an unchanged lockfile — no node_modules wipe, reads
 * from the local npm cache, seconds instead of minutes. Kept as an exported
 * literal so the eval battery can pin the flags exactly (P1-057 lesson:
 * --ignore-scripts is a supply-chain requirement, not optional).
 */
export const FAST_INSTALL_CMD =
  'ELECTRON_CACHE="$HOME/.cache/electron" npm install --prefer-offline --no-audit --no-fund --ignore-scripts --loglevel=error';

/** npm ci with visible errors and one retry (transient cache/lock races happen).
 * P1-057: --ignore-scripts — dependency lifecycle scripts are a supply-chain
 * vector; the deploy only needs tsc/esbuild (no electron binary, no packaging).
 * P1-021: ELECTRON_CACHE keeps electron/ffmpeg binaries in a local cache so a
 * re-install never re-downloads them. */
function npmInstall(cfg: PilotConfig) {
  const r = exec('ELECTRON_CACHE="$HOME/.cache/electron" npm ci --no-audit --no-fund --ignore-scripts --loglevel=error', { cwd: cfg.repo, timeoutMin: 15, allowFail: true });
  if (r.ok) return;
  console.log(JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "npm ci retry", data: r.output.slice(-300) }));
  exec('ELECTRON_CACHE="$HOME/.cache/electron" npm ci --no-audit --no-fund --ignore-scripts --loglevel=error', { cwd: cfg.repo, timeoutMin: 15 });
}

/** P2-041: window the rolled-back build gets to come up healthy (30s ≈ 6 probes). */
export const ROLLBACK_HEALTH_WINDOW_SEC = 30;
/** P2-041: interval between post-rollback health probes (same cadence as pollHealth). */
export const ROLLBACK_HEALTH_PROBE_SEC = 5;

/**
 * P2-041: injectable deps of the post-rollback health watch, following the
 * P1-044/P3-052 pattern — probe/clock/event/notify fakes keep the unit tests
 * hermetic (no real fetch, no real timers). Absent fields fall back to the
 * production behavior (real health endpoint, events.jsonl, supervisor notify).
 */
export interface RollbackHealthHooks {
  /** Task id carried into the supervisor notify. */
  task: string;
  /** Health probe override (tests); default = the daemon /api/health endpoint. */
  probe?: () => Promise<boolean>;
  /** Event sink override (tests); default = emit on the "deploy" channel. */
  onEvent?: (fields: { phase: string; ok: boolean; detail?: string }) => void;
  /** Supervisor notify override (tests); default = notifySupervisor. */
  notify?: typeof notifySupervisor;
  /** Injectable clock (tests); default = real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Window override (tests); default = ROLLBACK_HEALTH_WINDOW_SEC. */
  windowSec?: number;
}

/**
 * P2-041: post-rollback health verification. A rollback used to end in a blind
 * sleep(15s) — prod could stay unhealthy silently. This probes the health
 * endpoint (immediately, then every ROLLBACK_HEALTH_PROBE_SEC until the window
 * is exhausted), logs the observed state and emits a `rollback-health` deploy
 * event: ok=true clears any prior alert, ok=false lights the dashboard's red
 * "prod unhealthy" chip and notifies the supervisor. Returns the final verdict.
 */
export async function verifyRollbackHealth(cfg: PilotConfig, hooks?: RollbackHealthHooks): Promise<boolean> {
  const probe = hooks?.probe ?? (() => isHealthy(cfg));
  const onEvent = hooks?.onEvent ?? ((fields: { phase: string; ok: boolean; detail?: string }) => emit("deploy", fields));
  const notify = hooks?.notify ?? notifySupervisor;
  const sleep = hooks?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const windowSec = hooks?.windowSec ?? ROLLBACK_HEALTH_WINDOW_SEC;
  const retries = Math.max(0, Math.round(windowSec / ROLLBACK_HEALTH_PROBE_SEC));
  let healthy = await probe();
  for (let i = 0; !healthy && i < retries; i++) {
    await sleep(ROLLBACK_HEALTH_PROBE_SEC * 1000);
    healthy = await probe();
  }
  console.log(JSON.stringify({ ts: nowLocalISO(), level: healthy ? "info" : "warn", msg: "rollback-health", data: { healthy, windowSec } }));
  const detail = healthy ? "prod healthy after rollback" : "prod UNHEALTHY after rollback — manual check needed";
  onEvent({ phase: "rollback-health", ok: healthy, detail });
  if (!healthy) {
    try {
      await notify(hooks?.task ?? "deploy", false, detail);
    } catch {}
  }
  return healthy;
}

async function rollback(cfg: PilotConfig, prevSha: string, why: string, hooks?: RollbackHealthHooks) {
  exec("git checkout -q main", { cwd: cfg.repo, allowFail: true });
  exec(`git reset -q --hard ${prevSha}`, { cwd: cfg.repo, allowFail: true });
  const ci = exec('ELECTRON_CACHE="$HOME/.cache/electron" npm ci --silent --ignore-scripts', { cwd: cfg.repo, timeoutMin: 15, allowFail: true });
  // P1-021: keep the "persisted hash == lock of the node_modules on disk"
  // invariant honest after a rollback — re-record only when the rollback ci
  // actually succeeded; a failed ci leaves the state stale on purpose (the
  // next deploy's fast install repairs it or the ladder falls back to ci).
  if (ci.ok) {
    const h = exec("git show HEAD:package-lock.json | shasum -a 256 | cut -d' ' -f1", { cwd: cfg.repo, allowFail: true }).output.trim();
    writeLastInstall(defaultLastInstallFile(), h, nowLocalISO());
  }
  exec("npm run build --silent", { cwd: cfg.repo, timeoutMin: 15, allowFail: true });
  kickstart(cfg, "com.ocr.relay");
  kickstart(cfg, "com.ocr.daemon");
  kickstartPwa(cfg);
  console.log(JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "rollback", data: { prevSha, why } }));
  // P2-041: the old blind sleep(15s) never verified that the rolled-back build
  // came up — prod could stay unhealthy silently. Watch the health endpoint and
  // surface the verdict (red dashboard chip + supervisor notify when bad).
  await verifyRollbackHealth(cfg, hooks);
}

/**
 * P2-058: quarantine before rolling back — the failed SHA is banned so the
 * pending-deploy self-heal walks past it (last good verified state) instead of
 * re-deploying and re-executing the same defective brain in a loop.
 * Round 2: a failed quarantine WRITE must not stay silent — it silently
 * disables the anti-loop guarantee, so the supervisor is notified (best-effort)
 * to make the degraded state visible to a human.
 */
async function banAndRollback(
  cfg: PilotConfig,
  badSha: string,
  prevSha: string,
  why: string,
  task: string,
  notify: typeof notifySupervisor,
  healthHooks?: RollbackHealthHooks,
) {
  await quarantineWithEscalation(defaultQuarantineFile(), badSha, why, task, notify);
  await rollback(cfg, prevSha, why, { ...healthHooks, notify, task });
}

/**
 * P2-058 (round 2): record a quarantine entry and escalate when the write
 * fails. Exported so the eval battery can pin the escalation contract with a
 * mocked notify.
 */
export async function quarantineWithEscalation(
  file: string,
  sha: string,
  why: string,
  task: string,
  notify: typeof notifySupervisor,
): Promise<boolean> {
  const recorded = quarantineSha(file, sha, why, task, nowLocalISO());
  if (!recorded) {
    log("warn", "quarantine write failed — sha remains deployable", { sha: sha.slice(0, 7) });
    try {
      await notify(task, false, `quarantine write failed for ${sha.slice(0, 7)} — redeploy-loop guard degraded, manual check needed`);
    } catch {}
  }
  return recorded;
}

/**
 * P2-058: the deploy target — the newest gate-verified, non-quarantined merge
 * sha reachable from origin/main's first-parent history. Unverified bookkeeping
 * commits on top of main are walked past, so a direct push to main can never
 * become a deploy target. Null = nothing deployable (fail-closed).
 */
export function latestDeployableSha(repo: string): string | null {
  exec("git fetch -q origin", { cwd: repo, allowFail: true });
  const hist = exec("git log --first-parent --format=%H origin/main", { cwd: repo, allowFail: true });
  if (!hist.ok) return null;
  return pickDeployableSha(
    hist.output.split("\n").map((l) => l.trim()).filter(Boolean),
    readVerifiedMerges(defaultVerifiedMergesFile()),
    readQuarantine(defaultQuarantineFile()),
  );
}

function kickstart(cfg: PilotConfig, service: string) {
  exec(`launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${service}`, { cwd: cfg.repo });
}

/**
 * P2-075: refresh the static PWA origin (com.ocr.pwa) after the web build.
 * Tolerant by design — the service only exists after `deploy/install.sh` ran
 * once on this host, and a missing restart must never fail a deploy (KeepAlive
 * keeps any previous instance serving the new dist from disk; the daemon's
 * pwa-origin watchdog reports a dead origin on the dashboard either way).
 */
export function kickstartPwa(cfg: PilotConfig): boolean {
  const r = exec(`launchctl kickstart -k gui/${process.getuid?.() ?? 501}/com.ocr.pwa`, { cwd: cfg.repo, allowFail: true });
  emit("deploy", {
    phase: "pwa-kickstart",
    ok: r.ok,
    detail: r.ok ? undefined : "com.ocr.pwa not loaded — run deploy/install.sh once",
  });
  return r.ok;
}

async function isHealthy(_cfg: PilotConfig): Promise<boolean> {
  try {
    const token = JSON.parse(
      readFileSync(join(homedir(), ".opencode-remote", "daemon.json"), "utf8"),
    ).apiToken;
    const res = await fetch("http://127.0.0.1:8792/api/health", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { healthy?: boolean; relayConnected?: boolean; opencodeHealthy?: boolean };
    return j.healthy === true && j.relayConnected === true && j.opencodeHealthy === true;
  } catch {
    return false;
  }
}

async function pollHealth(cfg: PilotConfig, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await isHealthy(cfg)) return true;
    await sleep(5000);
  }
  return false;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
