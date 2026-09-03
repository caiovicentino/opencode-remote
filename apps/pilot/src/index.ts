import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { emit } from "./events";
import { agentStream, exec, runAgent, runAgentForRole } from "./runner";
import { nowLocalISO } from "./log";
import { notifySupervisor } from "./notify";
import { runResearcher } from "./researcher";
import { runExplorer } from "./explorer";
import { runPipeline, TASK_ID_RE, writeSandboxConfig, writeAuxSandboxConfig, budgetsFor, isOverCap, strategistPrompt, STRATEGIST_MARKER } from "./pipeline";
import { deploy, latestDeployableSha, shouldSelfHealReload } from "./deploy";
import { digest } from "./push";
import { addTask, appendCommitAndPush, auxPushIo, blockTask, nextId, parseAuxTaskLines, parseBacklog, type Task } from "./backlog";
import { landMetaCommit, metaIo } from "./metapush";
import { appendFailureLesson, defaultLessonsFile, failureLessonsBlock, readRecentFailureLessons } from "./failureLessons";
import { defaultPendingRefillFile, readPendingRefill, relandDetail, relandPendingRefill, savePendingRefill } from "./refill";
import { forensicDue, runForensic } from "./forensic";
import { areaKey, nightlyIdleDue, nightlySkipDue, pickBatch, assignSlots, startDelayMs, type SlotAffinity } from "./scheduler";
import {
  auditClearFile,
  auditResumeDue,
  buildDiagnosis,
  clearAuditMode,
  enterAuditMode,
  feverReason,
  formatDiagnosis,
  recordBlockEvent,
  recordCycle,
  recordInfraFailure,
  recordPipelineCrash,
  resultInfraKind,
} from "./audit";
import { apiHealthy } from "./runner";
import { maintainExperienceWorkspace, pickRelevantLessons, readExperienceFile } from "./experience";
import {
  ensureSingleton,
  frozen,
  loadConfig,
  loadState,
  recordTaskFailure,
  saveState,
  startWatchdog,
  touchHeartbeat,
  type PilotConfig,
  type PilotState,
} from "./state";
import { applySessionCosts, foldSlotCache, querySessionTokenRows } from "./costs";
import { recordLessonImpact } from "./metrics";
import { runDoctor } from "./doctor";

let deployBusy = false;
/** P1-104: set while the deploy-time self-reload waits for the running slots
 * to drain — no new pipeline picks until the process exits onto the new code
 * (otherwise the eager-fill would instantly refill the slots and the reload
 * would never fire). */
let drainNewPicks = false;
/** Shared runtime counters — mutated by the dispatcher and by slot workers.
 * The single-threaded event loop keeps mutations atomic; the dispatcher only
 * reloads from disk while no slot is running (so in-flight counters are never
 * clobbered by a reload). */
let state: PilotState;
/** slot number (1-based) -> in-flight pipeline worker. */
const running = new Map<number, { task: Task; done: Promise<void> }>();
/** P1-078: slot -> most recent area key it ran (in-memory, replaced per slot;
 * lost on restart — the TTL is minutes, an acceptable loss). */
const slotAffinity: SlotAffinity[] = [];
const log = (level: string, msg: string, data?: unknown) =>
  console.log(JSON.stringify({ ts: nowLocalISO(), level, msg, data }));

async function main() {
  await ensureSingleton();
  const cfg = loadConfig();
  // P3-101: the sha this process booted on — the loop's stale-process self-heal
  // exits whenever the production repo's HEAD moves past it (idle + no deploy).
  const bootHead = exec("git rev-parse HEAD", { cwd: cfg.repo, allowFail: true }).output.trim() || undefined;

  // P1-006: one workspace clone per slot (pilot/repo-1, repo-2…), created via
  // `git clone --shared` the first time. All other slots inherit slot 1's
  // behavior; slot-1 is also the aux-agent (strategist/researcher) workspace.
  let slotNumbers = Array.from({ length: cfg.slots }, (_, i) => i + 1);
  const slotCfg = new Map<number, PilotConfig>();
  for (const s of slotNumbers) slotCfg.set(s, ensureSlotWorkspace(cfg, s));
  // Frota Cognitiva: re-read pilot.json on every fill — dashboard edits to
  // slots / models.tierB land without a restart. Grow spawns slot worktrees
  // on the fly (ensureSlotWorkspace is idempotent); shrink only stops NEW
  // picks — running pipelines drain naturally, worktrees stay for regrowth.
  const refreshFleet = (): void => {
    let fresh: PilotConfig;
    try {
      fresh = loadConfig();
    } catch {
      return;
    }
    const modelsChanged = JSON.stringify(fresh.models) !== JSON.stringify(cfg.models);
    if (fresh.slots === cfg.slots && !modelsChanged) return;
    const before = cfg.slots;
    cfg.slots = fresh.slots;
    cfg.models = fresh.models;
    for (let s = 1; s <= cfg.slots; s++) if (!slotCfg.has(s)) slotCfg.set(s, ensureSlotWorkspace(cfg, s));
    for (const [, c] of slotCfg) c.models = cfg.models;
    slotNumbers = Array.from({ length: cfg.slots }, (_, i) => i + 1);
    const coord = cfg.models?.tierB?.planner ?? "default";
    log("info", "fleet updated", { slots: `${before}→${cfg.slots}`, coordinator: coord });
    emit("phase", { task: "fleet", phase: "resize", ok: true, detail: `${cfg.slots} slots · coord ${coord}` });
  };
  startWatchdog();

  // P1-030: deterministic repair pass on every boot — refs/state/backlog/
  // branches, each idempotent and logged; never blocks the loop from starting.
  runDoctor(cfg, slotNumbers.map((s) => slotCfg.get(s)!.workspace));

  const once = process.argv.includes("--once");
  log("info", "pilot started", {
    once,
    repo: cfg.repo,
    slots: cfg.slots,
    workspaces: slotNumbers.map((s) => slotCfg.get(s)!.workspace),
  });

  /**
   * P1-099: eager-fill — start a pipeline on every schedulable free slot right
   * now. Synchronous start-to-finish (`exec` is sync, no await): event-loop
   * atomicity is what prevents double-picking between the main loop and the
   * slot workers' eager-fill hooks. Called from the main loop ("loop") and at
   * the end of every pipeline ("eager-fill", runSlot finally) so a pipeline end
   * immediately backfills BOTH the freed slot and any other idle one.
   * Best-effort: a queue read failure just skips the fill — the main loop
   * retries in its next cycle. Never throws out of runSlot.finally.
   */
  const fillFreeSlots = (reason: "loop" | "eager-fill"): void => {
    refreshFleet();
    // --once (eval battery): exactly one pipeline total — only the loop call picks
    if (once && reason === "eager-fill") return;
    if (frozen() || state.auditMode) return;
    if (drainNewPicks) return; // P1-104: self-reload draining — no new picks
    if (state.tasks + running.size >= cfg.maxTasksPerDay) return;
    try {
      const free = slotNumbers.filter((s) => !running.has(s));
      if (free.length === 0) return;
      // queue read straight from origin/main, fresh at pick time:
      // slot worktrees may be mid-pipeline on a task branch and are never
      // trusted for scheduling decisions
      exec("git fetch -q origin", { cwd: cfg.repo, allowFail: true });
      const md = exec("git show origin/main:BACKLOG.md", { cwd: cfg.repo, allowFail: true });
      const queue = md.ok ? parseBacklog(md.output) : [];
      const busyAreas = new Set([...running.values()].map((r) => areaKey(r.task)));
      // budget-aware batch: freeSlots AND the remaining daily task budget
      const remainingBudget = cfg.maxTasksPerDay - state.tasks - running.size;
      const picked = pickBatch(queue.filter((t) => !overCap(t)), once ? 1 : free.length, busyAreas, remainingBudget);
      // P1-078 cache affinity: pickBatch already guarantees distinct area keys;
      // assignSlots only chooses WHICH free slot each pick lands on (a same-area
      // task prefers the slot that just ran that shape — warm provider prefix).
      const assignments = assignSlots(picked, free, busyAreas, slotAffinity, Date.now());
      let pickIndex = 0;
      for (const task of picked) {
        const slot = assignments.get(task.id);
        if (slot === undefined) continue;
        const wscfg = slotCfg.get(slot)!;
        const delay = startDelayMs(pickIndex++);
        if (delay > 0) {
          // staged ≠ started: a pick discarded during the stagger window must
          // never have been announced as started (round-3 review)
          log("info", "pipeline staged", { task: task.id, slot, startInMs: delay });
          emit("phase", { task: task.id, phase: "staged", ok: true, detail: `slot ${slot} starts in ~${Math.round(delay / 1000)}s (cache-write stagger)` });
        } else {
          log("info", "pipeline start", { task: task.id, title: task.title, slot, reason });
          emit("loop", { task: task.id, phase: "picked", detail: task.title, slot });
        }
        // Reserve the slot synchronously (event-loop atomicity keeps the
        // double-pick impossible); picks after the first spawn only after the
        // stagger window, so the first builder finishes its provider cache-write.
        let release: () => void = () => {};
        const done = new Promise<void>((res) => {
          release = res;
        });
        running.set(slot, { task, done });
        void (async () => {
          try {
            if (delay > 0) {
              await sleep(delay);
              // frozen/audit may have flipped during the stagger window —
              // discard instead of spawning; the next loop cycle re-picks.
              // NO budget re-check: pickBatch already committed this pick within
              // the daily cap and the reservation itself is part of
              // running.size — re-counting it would discard valid picks
              // whenever the batch exactly fills the remaining budget
              // (round-3 review).
              if (frozen() || state.auditMode) {
                log("info", "staggered start discarded", { task: task.id, slot });
                emit("phase", { task: task.id, phase: "staged", ok: false, detail: "discarded during the stagger window (frozen/audit)" });
                if (running.get(slot)?.task === task) running.delete(slot);
                return;
              }
              log("info", "pipeline start", { task: task.id, title: task.title, slot, reason });
              emit("loop", { task: task.id, phase: "picked", detail: task.title, slot });
            }
            await runSlot(slot, wscfg, task, cfg, () => fillFreeSlots("eager-fill"));
          } finally {
            // runSlot's own finally already deleted its own reservation and the
            // eager-fill may have filled this slot again — only clear OUR entry
            if (running.get(slot)?.task === task) running.delete(slot);
            release();
          }
        })();
      }
    } catch (err) {
      log("warn", "eager-fill skipped", { reason, err: String(err).slice(0, 200) });
    }
  };

  for (;;) {
    touchHeartbeat();
    if (frozen()) {
      log("info", "frozen — pilot.lock present, rechecking in 5s");
      await sleep(5_000);
      continue;
    }
    // daily budget rollover — only while no worker holds the shared counters
    if (running.size === 0) state = loadState();

    // global task budget (in-flight pipelines count toward the daily cap)
    if (state.tasks + running.size >= cfg.maxTasksPerDay) {
      log("info", "daily task budget reached", { tasks: state.tasks, running: running.size });
      if (once) return;
      await sleep(30_000);
      continue;
    }

    // P2-032 fever circuit breaker: audit mode entry / hold / resume.
    // External intervention = touching ~/.opencode-remote/pilot/audit-clear
    // (consumed on the next cycle, mirroring the pilot.lock freeze pattern).
    if (existsSync(auditClearFile())) {
      rmSync(auditClearFile());
      if (state.auditMode) {
        clearAuditMode(state);
        saveState(state);
        log("info", "audit mode cleared by external intervention");
        emit("audit", { detail: "cleared by external intervention" });
      }
    }

    if (!state.auditMode) {
      const fever = feverReason(state);
      if (fever && enterAuditMode(state, fever)) {
        saveState(state);
        log("warn", "audit mode entered — queue paused", { reason: fever });
        emit("audit", { detail: `${fever} — queue paused` });
        void notifySupervisor(
          "pilot-audit",
          false,
          `${fever} — new tasks paused. Resume: touch ${auditClearFile()} or wait 2h without failures`,
        ).catch(() => {});
        // doctor pass: deterministic diagnostics in the log — API health plus
        // the top failure steps and top rejected tasks from the failure record
        // (P1-074: shared with the infra-failure wake below)
        await runDoctorPass(state);
      }
    }

    if (state.auditMode) {
      if (auditResumeDue(state.auditMode)) {
        clearAuditMode(state);
        saveState(state);
        log("info", "audit mode: 2h without failure — resuming the queue");
        emit("audit", { detail: "resumed after 2h without failure" });
      } else {
        if (once) return;
        await sleep(30_000);
        continue;
      }
    }

    // P3-101: stale-process self-heal — if the production repo's HEAD moved
    // after this process booted (deploy landed while an older process was
    // still running, e.g. one spawned before the P1-034 reload fix), exit so
    // launchd KeepAlive restarts on the NEW code. Only at a fully idle moment:
    // never kill pipelines or an in-flight deploy (gates pinned by the battery
    // via shouldSelfHealReload). The outer guard is the cheap short-circuit
    // that skips the git probe while slots are busy.
    if (running.size === 0 && !deployBusy) {
      const headNow = exec("git rev-parse HEAD", { cwd: cfg.repo, allowFail: true }).output.trim();
      if (shouldSelfHealReload(running.size, deployBusy, bootHead, headNow)) {
        log("warn", "prod repo HEAD moved since boot — self-reloading onto new code", {
          bootHead,
          headNow,
        });
        emit("deploy", { phase: "self-reload", ok: true, detail: "boot HEAD drift (stale process)" });
        process.exit(0); // pidfile singleton + KeepAlive cover the restart
      }
    }

    // nightly redteam + weekly maintenance — best effort, slots idle. P1-095:
    // the pass fires at the first >= 2h idle gap of the day instead of the old
    // unreachable hour===3 gate; a busy-through-the-window day is recorded.
    // P1-075: a crash inside the pass must never take the loop down — it is
    // logged ("nightly pass crashed") and the cycle continues.
    if (running.size === 0) {
      try {
        await maybeNightly(slotCfg.get(1)!, state);
      } catch (err) {
        log("warn", "nightly pass crashed", { err: String(err).slice(0, 200) });
      }
    } else {
      const today = nowLocalISO().slice(0, 10);
      const reason = nightlySkipDue(state, today, new Date().getHours(), true);
      if (reason) {
        state.nightlySkipped = { date: today, reason };
        saveState(state);
        log("info", "nightly pass skipped", { reason });
        emit("phase", { task: "nightly", phase: "skipped", ok: false, detail: reason });
      }
    }

    // pending deploy: production is behind a gate-verified merge on origin/main
    // (e.g. after a rollback). Serial by construction: only checked while slots
    // are idle and no fire-and-forget deploy is in flight.
    if (running.size === 0 && !deployBusy && state.deploys < cfg.maxDeploysPerDay) {
      const prodSha = exec("git rev-parse HEAD", { cwd: cfg.repo, allowFail: true }).output.trim();
      // P2-058: the target is the newest gate-verified, non-quarantined merge
      // sha on origin/main — a direct push to main (bookkeeping or hostile) is
      // walked past and can never become a deploy target.
      const target = latestDeployableSha(cfg.repo);
      if (prodSha && target && prodSha !== target) {
        log("info", "pending deploy: prod behind a gate-verified merge", { prod: prodSha.slice(0, 7), target: target.slice(0, 7) });
        state.deploys++;
        saveState(state);
        const dep = await deploy(cfg, target);
        log("info", "deploy result", { ok: dep.ok, rolledBack: dep.rolledBack, detail: dep.detail.slice(0, 200) });
        if (!dep.ok) {
          state.failures++;
          saveState(state);
        }
        if (cfg.digest) await digest(dep.ok ? "⬆️ Pilot: deploy" : "⚠️ Pilot rollback", dep.detail.slice(0, 120), "#/");
        if (once) return;
        await sleep(5_000);
        continue;
      }
    }

    // queue read straight from origin/main: slot worktrees may be mid-pipeline
    // on a task branch and are never trusted for scheduling decisions
    exec("git fetch -q origin", { cwd: cfg.repo, allowFail: true });
    const md = exec("git show origin/main:BACKLOG.md", { cwd: cfg.repo, allowFail: true });
    const queue = md.ok ? parseBacklog(md.output) : [];

    // aux agents share slot 1's worktree — only run when every slot is idle,
    // synced to main so their BACKLOG edits land on the right branch
    if (running.size === 0) {
      const aux = slotCfg.get(1)!;
      syncWorkspace(aux.workspace);
      writeSandboxConfig(aux.workspace); // headless runs abort without sandbox perms
      // P1-037: a refill whose push failed is persisted outside the worktree
      // and re-landed here — the sync reset above must never eat drafted tasks.
      const pendingFile = defaultPendingRefillFile();
      const pending = readPendingRefill(pendingFile);
      if (pending) {
        const reland = await relandPendingRefill(aux.workspace, pendingFile, auxPushIo(aux.workspace));
        log("info", "pending refill reland", { result: reland, lines: pending.lines.length });
        emit("phase", { task: "strategist", phase: "refill", ok: reland === "pushed" || reland === "empty", detail: relandDetail(reland, pending.lines.length) });
        if (reland !== "failed") continue; // backlog changed or snapshot is stale — re-read fresh
        // still failing: fall through so a push outage can't starve the
        // scheduler; the reland retries every idle cycle until git recovers.
      }
      if (queue.length < 2 && Date.now() - lastStrategistRun > 10 * 60_000) {
        log("info", "queue low — strategist drafting next tasks", { ready: queue.length });
        await runStrategist(aux, queue);
        continue; // re-read backlog fresh in the next cycle
      }
      const today = nowLocalISO().slice(0, 10);
      if (state.researchLast !== today) {
        await runResearcher(aux, state);
        saveState(state);
      }
    }

    // P1-014 circuit breaker: tasks past the cap are re-blocked (the push may
    // have failed last cycle). Needs an idle worktree for the BACKLOG commit —
    // a busy slot's branch is never touched.
    const free = slotNumbers.filter((s) => !running.has(s));
    if (free.length > 0) {
      const idle = slotCfg.get(free[0]!)!;
      let blockedAny = false;
      for (const t of queue.filter((t) => overCap(t))) {
        // P2-031: findings and tail must not repeat the same string in the
        // failure lesson — the step name summarizes, the tail carries detail
        const gate = lastGateFail(t.id);
        await blockAndPush(idle, state, t, state.taskAttempts[t.id] ?? budgetsFor(t.size).attempts, gate?.step ? `kept failing at step "${gate.step}"` : "max attempts reached", false);
        blockedAny = true;
      }
      if (blockedAny) {
        saveState(state);
        await sleep(5_000);
        continue; // re-read the queue fresh before picking anything
      }
    }

    fillFreeSlots("loop");

    if (once) {
      await Promise.all([...running.values()].map((r) => r.done));
      break;
    }
    await sleep(5_000);
  }
}

/**
 * P1-074: deterministic doctor diagnostic pass, shared between audit-mode
 * entry and the infra-failure wake — API health probe plus the top failure
 * steps and top rejected tasks from the failure record. Also refreshes the
 * dashboard audit chip (P2-045) and persists the state.
 */
async function runDoctorPass(st: PilotState): Promise<void> {
  const api = await apiHealthy();
  const diag = buildDiagnosis({
    lessonsFile: defaultLessonsFile(),
    gateFailDir: join(homedir(), ".opencode-remote/pilot/gate-fail"),
    attempts: st.taskAttempts,
    api,
  });
  log("warn", "audit diagnosis", { summary: formatDiagnosis(diag), ...diag });
  st.auditDiagnosis = formatDiagnosis(diag);
  saveState(st);
}

/** One pipeline run in a slot workspace, with all result bookkeeping.
 * P1-099: `onSettled` runs in the finally, right after the slot is released —
 * the eager-fill hook that immediately backfills every free slot. */
async function runSlot(slot: number, wscfg: PilotConfig, task: Task, cfg: PilotConfig, onSettled?: () => void): Promise<void> {
  // P1-060: budgets scale with the task's size tag — clone the slot config
  // with the effective rounds/timeout/attempts so runPipeline and the
  // circuit breaker both honor the long-horizon allowance for size L.
  const budgets = budgetsFor(task.size);
  const taskCfg: PilotConfig = {
    ...wscfg,
    maxReviewRounds: budgets.rounds,
    taskTimeoutMin: budgets.timeoutMin,
    maxAttemptsPerTask: budgets.attempts,
  };
  try {
    // P2-028: the pipeline records every opencode session id it spawns; the
    // token totals are reconciled from opencode.db right after the run.
    const taskSessions = new Set<string>();
    const result = await runPipeline(taskCfg, task, state, taskSessions);
    try {
      // P1-077: rows query — folds the per-task cache breakdown (input /
      // cacheRead / cacheWrite) into state.taskCache alongside the total.
      const cacheFold = await applySessionCosts(state, task.id, [...taskSessions], (ids) => querySessionTokenRows(ids));
      if (cacheFold) {
        log("info", "task cache", cacheFold);
        // P1-078: per-slot view of the same reconciliation — replaced by the
        // task's value each time (live window), proves the affinity effect.
        log("info", "slot cache", foldSlotCache(state, slot, cacheFold));
      }
    } catch (err) {
      log("warn", "task cost reconciliation failed", { task: task.id, err: String(err).slice(0, 200) });
    }
    // P1-075: lesson-injection instrumentation — fold this outcome into the
    // with/without cohorts (tokens from the reconciliation above, 0 when it
    // failed) so the operator can measure whether lessons actually help.
    const impact = {
      lessons: result.lessonsInjected ?? 0,
      rounds: result.rounds ?? 0,
      ok: result.ok,
      tokens: state.taskCosts?.[task.id] ?? 0,
    };
    recordLessonImpact(state, impact);
    log("info", "lesson impact", { task: task.id, ...impact });
    state.tasks++;
    let blockedAttempts: number | null = null;
    if (result.ok) {
      recordCycle(state, true, task.id); // P2-032 fever window (P2-063: attributed to the task)
      delete state.taskAttempts[task.id]; // gate passed — breaker reset
    } else {
      // P1-074: infra noise (API down, spawn error, timeout without output)
      // burns no attempt, adds no fever sample and blocks nothing — it counts
      // in the diagnostic infraFails, with a doctor pass every 3rd occurrence
      // (P1-094: classified only from the structured result.infra flag — the
      // detail text embeds findings and may legitimately mention infra words)
      const infra = resultInfraKind(result);
      if (infra) {
        const wake = recordInfraFailure(state);
        log("warn", "pipeline infra-failure", { task: task.id, kind: infra, infraFails: state.infraFails });
        if (wake) await runDoctorPass(state);
      } else {
        recordCycle(state, false, task.id);
        blockedAttempts = await tripCircuitBreaker(taskCfg, state, task, result.detail);
      }
    }
    saveState(state);
    log("info", "pipeline result", { task: task.id, ok: result.ok, slot, detail: result.detail.slice(0, 200) });
    emit("result", { task: task.id, ok: result.ok, detail: result.detail.slice(0, 200), slot });
    // blocked tasks get a single dedicated supervisor notification instead
    if (blockedAttempts === null) {
      void notifySupervisor(task.id, result.ok, result.detail.slice(0, 300)).catch(() => {});
    }
    if (result.ok && result.sha) {
      launchDeploy(wscfg, task, result.sha, result.touchedUi === true);
    } else if (!result.ok) {
      if (blockedAttempts !== null && wscfg.digest) {
        await digest(
          `Pilot: ${task.id} blocked`,
          `moved to ## Blocked after ${blockedAttempts} attempts`,
          "#/",
        );
      } else if (wscfg.digest) {
        await digest(`🧪 Pilot falhou: ${task.id}`, result.detail.slice(0, 120), "#/");
      }
      await sleep(10_000); // short cool-down; full output saved for diagnosis
    }
    saveState(state);
  } catch (err) {
    state.failures++;
    // P1-104: a crash never produced a merit verdict — record fever + infra
    // evidence only. The per-task attempt counter is untouched: a crash loop
    // burns no attempt and can never block the task; the global fever breaker
    // still sees each crash as its own distinct entry (P2-063).
    const wake = recordPipelineCrash(state);
    const detail = String(err).slice(0, 300);
    saveState(state);
    log("error", "pipeline crashed", { task: task.id, slot, err: detail, infraFails: state.infraFails });
    if (wake) await runDoctorPass(state);
    await sleep(30_000);
  } finally {
    running.delete(slot);
    // P1-078: record what shape this slot just ran — the next assignSlots call
    // prefers this slot for same-area tasks while the prefix cache is warm.
    const entry: SlotAffinity = { slot, area: areaKey(task), at: Date.now() };
    const prev = slotAffinity.findIndex((a) => a.slot === slot);
    if (prev >= 0) slotAffinity[prev] = entry;
    else slotAffinity.push(entry);
    // P1-099: pipeline end → eager-fill ALL free slots (the freed one AND any
    // other idle one). Synchronous — no double-pick on the event loop.
    onSettled?.();
  }
}

/**
 * Fire-and-forget deploy of a gate-verified merge SHA. `deployBusy` serializes
 * deploys: when one is in flight the merge stays queued on main and the next
 * deploy picks it up. The deploy budget is global (all slots share it).
 * P2-058: `sha` (pipeline HEAD) may carry bookkeeping commits on top of the
 * merge — the actual target is resolved by walking origin/main back to the
 * newest gate-verified, non-quarantined sha; without one, nothing deploys.
 */
function launchDeploy(cfg: PilotConfig, task: Task, sha: string, touchedUi: boolean) {
  if (deployBusy) {
    log("info", "deploy in flight — merge queued on main, next deploy will pick it up", { task: task.id });
    return;
  }
  if (state.deploys >= cfg.maxDeploysPerDay) {
    log("info", "deploy budget reached — merge left on main for manual deploy", { deploys: state.deploys });
    return;
  }
  const target = latestDeployableSha(cfg.repo);
  if (!target) {
    log("warn", "no gate-verified merge sha on origin/main — deploy skipped", { task: task.id, sha: sha.slice(0, 7) });
    return;
  }
  state.deploys++;
  saveState(state);
  // fire-and-forget: the deploy (npm ci/build/soak) runs in the prod repo
  // while builders work in their slot clones — independent file systems
  deployBusy = true;
  void deploy(cfg, target, { task: task.id, ui: touchedUi }, {
    // P1-104: the end-of-deploy self-reload waits for the running slots to
    // drain (and holds new picks meanwhile) instead of exiting mid-pipeline
    slotsRunning: () => running.size,
    holdNewPicks: (hold) => {
      drainNewPicks = hold;
    },
  })
    .then((dep) => {
      log("info", "deploy result", { task: task.id, ...dep });
      if (!dep.ok) state.failures++;
      if (cfg.digest) {
        return digest(
          dep.ok ? `🛠 Pilot: ${task.title}` : `⚠️ Pilot rollback: ${task.title}`,
          dep.detail,
          "#/",
        );
      }
    })
    .catch(() => {})
    .finally(() => {
      deployBusy = false;
      saveState(state);
    });
}

function overCap(task: Task): boolean {
  return TASK_ID_RE.test(task.id) && isOverCap(state.taskAttempts[task.id], task.size);
}

/** One-shot validation mode used by the eval battery. */
async function maybeNightly(cfg: PilotConfig, st: PilotState) {
  const today = nowLocalISO().slice(0, 10);
  // P1-095: idle-window gate — the old exact-hour condition (3am) combined
  // with the slots-idle call-site guard was effectively unreachable (pipelines
  // routinely span the whole 03:00–03:59 window). Now: first >= 2h idle gap of
  // the day.
  if (!nightlyIdleDue(st.lastCycleAt)) return;
  // P1-059: forensic carries its own 7-day guard — a due forensic must not be
  // skipped just because redteam/explorer already ran today (both self-guard).
  const nightlyDone = st.redteamLast === today && st.explorerLast === today;
  if (nightlyDone && !forensicDue(st.forensicLast)) return;
  // --once (eval battery): a one-shot run must never kick off a 30-min redteam
  // agent — the battery covers the trigger through the pure scheduler seams.
  if (process.argv.includes("--once")) return;
  // The pass is actually starting — today's skip record (if any) is obsolete.
  if (st.nightlySkipped) {
    st.nightlySkipped = null;
    saveState(st);
  }
  // sync so the nightly agents read a fresh main; a failing sync only skips
  // the pass (best-effort by design — never blocks the loop)
  let wsReady = true;
  try {
    syncWorkspace(cfg.workspace);
  } catch {
    wsReady = false;
    log("warn", "nightly workspace sync failed — nightly passes skipped");
  }
  writeSandboxConfig(cfg.workspace); // headless runs abort without sandbox perms
  // P1-075 experience-memory maintenance — runs BEFORE the redteam agent and
  // under its OWN guard (st.expMaintLast, stamped inside the flow): the
  // deterministic dedupe+prune+archive can no longer be lost when the agent
  // fails or the process exits mid-run. Best-effort: never throws.
  if (wsReady) {
    try {
      // awaited so the catch below keeps covering the flow's fs/git failures
      // and saveState persists the expMaintLast stamp written at the end
      await maintainExperienceWorkspace(
        cfg.workspace,
        st,
        today,
        {
          exec: (cmd) => exec(cmd, { cwd: cfg.workspace, allowFail: true }),
          appendLesson: appendFailureLesson,
          lessonsFile: defaultLessonsFile(),
        },
        log,
      );
      saveState(st);
    } catch (err) {
      log("warn", "experience maintenance failed", { err: String(err).slice(0, 200) });
    }
  }
  // P1-059: weekly failure-forensic taxonomy (tier B when configured) —
  // best-effort, never blocks the loop
  if (wsReady) await runForensic(cfg, st);
  // P3-052: nightly computer-use explorer — strictly non-blocking, once per
  // day (own guard in state.explorerLast), budget-capped for predictable cost
  if (wsReady) await runExplorer(cfg, st);
  if (st.redteamLast === today) return;
  log("info", "nightly redteam starting");
  // P1-057: the red team reasons about attack surfaces but gets NO shell and
  // NO write access — findings come back as text and the runner lands them.
  writeAuxSandboxConfig(cfg.workspace);
  const r = await runAgent(
    `You are the RED TEAM agent of the opencode-remote autonomous pipeline. Your job today:
try to find a security or robustness hole in this repository (your cwd is a safe clone).
Attack ideas: relay frame abuse, permission bypass in daemon ops, path traversal,
push notification spoofing, protocol downgrade, replay variants.
You have NO shell and NO write access this run — reason purely from reading the code.
Do NOT touch production services, do NOT push, do NOT modify files (read-only).

${"Constitution: " + CONSTITUTION_REF}

Output: either "REDTEAM: CLEAN" if you found nothing actionable, or
"REDTEAM: FINDING" followed by title, severity and a one-paragraph proof/attack sketch.`,
    { cwd: cfg.workspace, timeoutMin: 30, label: "redteam", onStdout: agentStream("redteam") },
  );
  writeSandboxConfig(cfg.workspace);
  // P1-075: stamp only AFTER the agent completes — the old pre-agent stamp
  // turned any process exit/reload during the 30-min window into a lost day
  // (no "experience maintained"/finding lines ever after it).
  st.redteamLast = today;
  saveState(st);
  log("info", r.ok ? "nightly redteam finished" : "nightly redteam failed", { ok: r.ok, timedOut: r.timedOut });
  if (r.output.includes("REDTEAM: FINDING")) {
    const summary = r.output.split("REDTEAM: FINDING")[1]?.slice(0, 600) ?? "finding";
    // P1-076: the finding lands via the pilot/meta PR, guarded to BACKLOG.md.
    // The id derives INSIDE the apply callback — from the freshly re-based
    // BACKLOG.md — so a concurrent meta landing that added task lines since
    // our last sync can't produce a duplicate-id insert (same fix as the
    // explorer flow), and every retry re-derives instead of reusing a stale id.
    let landedId = "";
    const landed = await landMetaCommit(cfg.workspace, metaIo(cfg.workspace), {
      files: ["BACKLOG.md"],
      message: "pilot(redteam): add finding",
      guardFile: "BACKLOG.md",
      apply: () => {
        landedId = nextId(cfg.workspace, "RT");
        addTask(cfg.workspace, landedId, "P0", `Redteam finding ${today}`, summary);
        return { action: "apply", message: `pilot(redteam): add ${landedId}` };
      },
    });
    if (landed === "refused") {
      log("warn", "aux push refused — redteam diff not limited to BACKLOG.md", { id: landedId });
    }
    log("info", "redteam finding committed", { id: landedId, landed: landed === "pushed" });
    await digest("🚨 Pilot redteam: achado", summary.slice(0, 120), "#/");
  }
}

/**
 * STRATEGIST role — the product brain that keeps evolution constant.
 * Reads the repo (code, docs, metrics, project memory) and drafts the next
 * shippable tasks into BACKLOG.md. This is what makes the loop 24/7 without
 * a human feeding work.
 */
let lastStrategistRun = 0;

const STRATEGIST_MISSION =
  "turn this project into a desktop app like Claude Desktop (Mac + Windows) with our harness built in. " +
  "Stages 1-2 are done; stage 3 (desktop app shell) is the priority, then hosted relay, then distribution.";

async function runStrategist(cfg: PilotConfig, ready: Task[] = []) {
  lastStrategistRun = Date.now();
  // P1-057: the strategist drafts new tasks from repo content — run it with
  // the aux sandbox (bash/edit denied) and land its proposals deterministically.
  writeAuxSandboxConfig(cfg.workspace);
  // P1-007: top-5 lessons keyword-matched against the mission + the queue it
  // is about to refill, so drafted tasks don't repeat past mistakes
  const context = [STRATEGIST_MISSION, ...ready.map((t) => `${t.title} ${t.spec}`)].join("\n");
  const lessons = pickRelevantLessons(readExperienceFile(cfg.workspace), "draft next backlog tasks", context);
  // P2-031: the 10 most recent failure lessons — drafted/refined tasks must not
  // repeat patterns that already burned their attempt budget
  const failureBlock = failureLessonsBlock(readRecentFailureLessons(defaultLessonsFile()));
  // P1-078: stable role/rules/contract first, variable lessons last — the
  // prompt prefix stays byte-identical between runs for the provider cache.
  const r = await runAgentForRole(
    "strategist",
    strategistPrompt(STRATEGIST_MISSION, lessons, failureBlock),
    { cwd: cfg.workspace, timeoutMin: 25, label: "strategist", onStdout: agentStream("strategist"), models: cfg.models, marker: STRATEGIST_MARKER },
  );
  writeSandboxConfig(cfg.workspace);
  if (r.output.includes(STRATEGIST_MARKER)) {
    const lines = parseAuxTaskLines(r.output);
    if (!lines.length) {
      log("warn", "strategist: no valid task lines — nothing committed", { tail: r.output.slice(-200) });
      emit("phase", { task: "strategist", phase: "refill", ok: false, detail: "no valid task lines" });
      return;
    }
    const message = `pilot(strategist): queue refill ${nowLocalISO().slice(11, 16)}`;
    const result = await appendCommitAndPush(cfg.workspace, lines, message, auxPushIo(cfg.workspace));
    if (result === "pushed") {
      log("info", "strategist refilled queue", { lines: lines.length });
      emit("phase", { task: "strategist", phase: "refill", ok: true, detail: `queue refill pushed (${lines.length} lines)` });
    } else if (result === "failed") {
      // P1-037: persist the refill outside the worktree — the next
      // syncWorkspace reset --hard would otherwise destroy it silently.
      const saved = savePendingRefill(defaultPendingRefillFile(), lines, message);
      log("warn", saved ? "refill saved as pending — relanding next idle cycle" : "pending refill save failed", { lines: lines.length });
      emit("phase", { task: "strategist", phase: "refill", ok: false, detail: saved ? `pending refill saved (${lines.length} lines)` : "pending refill save failed" });
    } else {
      log("warn", "aux push refused", { lines: lines.length });
      emit("phase", { task: "strategist", phase: "refill", ok: false, detail: result });
    }
  } else {
    log("warn", "strategist did not finish", { tail: r.output.slice(-200) });
  }
}

/**
 * P1-014 stop-loss: count one more pipeline failure for the task; when the
 * counter hits `maxAttemptsPerTask`, move the task to ## Blocked in BACKLOG.md
 * (commit+push so the workspace sync can't resurrect it) and notify the
 * supervisor once. Returns the attempt count when the breaker tripped, else null.
 */
async function tripCircuitBreaker(cfg: PilotConfig, st: PilotState, task: Task, detail: string): Promise<number | null> {
  if (!recordTaskFailure(st, task.id, cfg.maxAttemptsPerTask)) return null;
  const attempts = st.taskAttempts[task.id] ?? 0;
  await blockAndPush(cfg, st, task, attempts, detail, true);
  return attempts;
}

/** Move the task line to ## Blocked and land it via the pilot/meta PR (P1-076).
 * Clears the counter on success so a human/red-team re-queue starts with a
 * fresh allowance. Never notifies twice. Syncs the slot worktree to main first:
 * a failed pipeline leaves it on the task branch. */
async function blockAndPush(cfg: PilotConfig, st: PilotState, task: Task, attempts: number, detail: string, notify: boolean) {
  if (!TASK_ID_RE.test(task.id)) return;
  try {
    syncWorkspace(cfg.workspace);
  } catch {
    return; // no clean main reachable from this worktree — retry next cycle
  }
  const summary = `blocked after ${attempts} attempts: ${detail}`;
  const push = await landMetaCommit(cfg.workspace, metaIo(cfg.workspace), {
    files: ["BACKLOG.md"],
    message: `pilot(${task.id}): block after ${attempts} failed attempts`,
    guardFile: "BACKLOG.md",
    // R6: "already blocked" is the desired state present (a queued auto-merge
    // from a previous cycle landed between the retries) — the landing must
    // converge as success so the attempts counter is cleared and the P2-031
    // lesson is recorded exactly once, never reported as an abort-forever.
    apply: () => {
      const r = blockTask(cfg.workspace, task.id, summary);
      return r === "applied" ? { action: "apply" } : r === "noop" ? { action: "noop" } : { action: "abort" };
    },
  });
  if (push === "pushed") {
    delete st.taskAttempts[task.id];
    recordBlockEvent(st); // P2-032: block-burst trigger watches landings on main
    // P2-031 failure scribe: one structured lesson per landed block (recording
    // only after the push lands keeps retry cycles from duplicating entries).
    const gate = lastGateFail(task.id);
    const recorded = appendFailureLesson(defaultLessonsFile(), {
      kind: "failure",
      ts: nowLocalISO(),
      task: task.id,
      attempts,
      step: gate?.step ?? "pipeline",
      findings: detail,
      tail: gate?.tail ?? "",
    });
    if (!recorded) log("warn", "failure lesson not recorded", { task: task.id });
  } else if (push === "refused") {
    log("warn", "aux push refused — block diff not limited to BACKLOG.md", { task: task.id });
  }
  log("warn", "task blocked (circuit breaker)", { task: task.id, attempts });
  emit("phase", { task: task.id, phase: "blocked", ok: false, detail: `moved to ## Blocked after ${attempts} attempts` });
  if (notify) {
    void notifySupervisor(
      task.id,
      false,
      `${summary} - moved to ## Blocked (infinite cooldown; moving it back to ## Ready re-schedules it with a fresh counter)`,
    ).catch(() => {});
  }
}

/** Last gatekeeper failure for a task (per-task file written by pipeline.gatekeeper). */
function lastGateFail(taskId: string): { step?: string; tail?: string } | undefined {
  if (!TASK_ID_RE.test(taskId)) return undefined;
  try {
    const prev = JSON.parse(
      readFileSync(join(homedir(), ".opencode-remote/pilot/gate-fail", `${taskId}.json`), "utf8"),
    ) as { step?: string; tail?: string };
    return { step: prev.step, tail: prev.tail };
  } catch {}
  return undefined;
}

/**
 * POSIX single-quote shell escape. JSON.stringify is NOT shell quoting —
 * `$`, backticks and `"` survive it and enable command substitution.
 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * P1-006: the slot workspace lives at pilot/repo-<slot> and is created once
 * via `git clone --shared` from the production checkout (shared objects, cheap).
 * The origin remote is restored to the real origin so fetches/pushes do not
 * depend on the prod checkout's state, and dependencies are bootstrapped
 * (npm ci) before the slot is usable — a half-ready slot must never exist.
 */
function ensureSlotWorkspace(base: PilotConfig, slot: number): PilotConfig {
  const ws = join(homedir(), ".opencode-remote", "pilot", `repo-${slot}`);
  if (!existsSync(join(ws, ".git"))) {
    const originUrl = exec("git remote get-url origin", { cwd: base.repo, allowFail: true }).output.trim();
    // without the real origin, pushes would target the prod checkout (non-bare) — refuse
    if (!originUrl) throw new Error(`slot workspace: prod checkout ${base.repo} has no origin remote`);
    const clone = exec(`git clone --shared ${shq(base.repo)} ${shq(ws)}`, {
      cwd: base.repo,
      timeoutMin: 5,
      allowFail: true,
    });
    if (!clone.ok) {
      rmSync(ws, { recursive: true, force: true }); // partial clone would block the retry
      throw new Error(`slot workspace clone failed (${ws}): ${clone.output.slice(-300)}`);
    }
    const setUrl = exec(`git remote set-url origin ${shq(originUrl)}`, { cwd: ws, allowFail: true });
    if (!setUrl.ok) {
      rmSync(ws, { recursive: true, force: true });
      throw new Error(`slot workspace set-url failed (${ws}): ${setUrl.output.slice(-300)}`);
    }
    exec("git fetch -q origin", { cwd: ws, allowFail: true });
    exec("git checkout -q -B main origin/main", { cwd: ws, allowFail: true });
    // fresh clone has no node_modules — the gate cannot run without deps
    const ci = exec("npm ci --no-audit --no-fund --loglevel=error", { cwd: ws, timeoutMin: 15, allowFail: true });
    if (!ci.ok) {
      rmSync(ws, { recursive: true, force: true });
      throw new Error(`slot workspace npm ci failed (${ws}): ${ci.output.slice(-300)}`);
    }
    log("info", "slot workspace created", { slot, ws });
  }
  return { ...base, workspace: ws };
}

/** Worktree must mirror origin/main before any local BACKLOG edit or agent run. */
function syncWorkspace(ws: string) {
  exec("git fetch origin", { cwd: ws, allowFail: true });
  exec("git checkout -q main", { cwd: ws, allowFail: true });
  exec("git reset -q --hard origin/main", { cwd: ws });
  exec("git clean -qfd", { cwd: ws });
}

const CONSTITUTION_REF = "see docs/CONSTITUTION.md — E2E stays E2E, allowlist/replay/0600 untouchable, no secrets, documented changes only.";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  log("error", "pilot fatal", { err: String(err).slice(0, 500) });
  process.exit(1);
});
