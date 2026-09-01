import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { emit } from "./events";
import { agentStream, exec, runAgent } from "./runner";
import { nowLocalISO } from "./log";
import { notifySupervisor } from "./notify";
import { runResearcher } from "./researcher";
import { runPipeline, TASK_ID_RE, writeSandboxConfig } from "./pipeline";
import { deploy } from "./deploy";
import { digest } from "./push";
import { addTask, blockTask, nextId, parseBacklog, type Task } from "./backlog";
import { areaKey, pickTasks } from "./scheduler";
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

let deployBusy = false;
/** Shared runtime counters — mutated by the dispatcher and by slot workers.
 * The single-threaded event loop keeps mutations atomic; the dispatcher only
 * reloads from disk while no slot is running (so in-flight counters are never
 * clobbered by a reload). */
let state: PilotState;
/** slot number (1-based) -> in-flight pipeline worker. */
const running = new Map<number, { task: Task; done: Promise<void> }>();
const log = (level: string, msg: string, data?: unknown) =>
  console.log(JSON.stringify({ ts: nowLocalISO(), level, msg, data }));

async function main() {
  await ensureSingleton();
  const cfg = loadConfig();

  // P1-006: one workspace clone per slot (pilot/repo-1, repo-2…), created via
  // `git clone --shared` the first time. All other slots inherit slot 1's
  // behavior; slot-1 is also the aux-agent (strategist/researcher) workspace.
  const slotNumbers = Array.from({ length: cfg.slots }, (_, i) => i + 1);
  const slotCfg = new Map<number, PilotConfig>();
  for (const s of slotNumbers) slotCfg.set(s, ensureSlotWorkspace(cfg, s));
  startWatchdog();

  const once = process.argv.includes("--once");
  log("info", "pilot started", {
    once,
    repo: cfg.repo,
    slots: cfg.slots,
    workspaces: slotNumbers.map((s) => slotCfg.get(s)!.workspace),
  });

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

    // nightly redteam (03:xx) + weekly maintenance — best effort, slots idle
    if (running.size === 0) await maybeNightly(slotCfg.get(1)!, state);

    // pending deploy: production is behind origin/main (e.g. after a rollback).
    // Serial by construction: only checked while slots are idle and no
    // fire-and-forget deploy is in flight.
    if (running.size === 0 && !deployBusy && state.deploys < cfg.maxDeploysPerDay) {
      const prodSha = exec("git rev-parse HEAD", { cwd: cfg.repo, allowFail: true }).output.trim();
      const originSha = exec("git rev-parse origin/main", { cwd: cfg.repo, allowFail: true }).output.trim();
      if (prodSha && originSha && prodSha !== originSha) {
        log("info", "pending deploy: prod behind origin/main", { prod: prodSha.slice(0, 7), origin: originSha.slice(0, 7) });
        state.deploys++;
        saveState(state);
        const dep = await deploy(cfg, originSha);
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
      if (queue.length < 2 && Date.now() - lastStrategistRun > 10 * 60_000) {
        log("info", "queue low — strategist drafting next tasks", { ready: queue.length });
        await runStrategist(aux);
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
      for (const t of queue.filter((t) => overCap(cfg, t))) {
        blockAndPush(idle, state, t, state.taskAttempts[t.id] ?? cfg.maxAttemptsPerTask, lastGateFail(t.id) ?? "max attempts reached", false);
        blockedAny = true;
      }
      if (blockedAny) {
        saveState(state);
        await sleep(5_000);
        continue; // re-read the queue fresh before picking anything
      }
    }

    const busyAreas = new Set([...running.values()].map((r) => areaKey(r.task)));
    const picked = pickTasks(queue.filter((t) => !overCap(cfg, t)), once ? 1 : free.length, busyAreas);
    for (const task of picked) {
      const slot = free.find((s) => !running.has(s))!;
      const wscfg = slotCfg.get(slot)!;
      log("info", "pipeline start", { task: task.id, title: task.title, slot });
      emit("loop", { task: task.id, phase: "picked", detail: task.title, slot });
      const done = runSlot(slot, wscfg, task, cfg);
      running.set(slot, { task, done });
    }

    if (once) {
      await Promise.all([...running.values()].map((r) => r.done));
      break;
    }
    await sleep(5_000);
  }
}

/** One pipeline run in a slot workspace, with all result bookkeeping. */
async function runSlot(slot: number, wscfg: PilotConfig, task: Task, cfg: PilotConfig): Promise<void> {
  try {
    const result = await runPipeline(wscfg, task, state);
    state.tasks++;
    let blockedAttempts: number | null = null;
    if (result.ok) {
      delete state.taskAttempts[task.id]; // gate passed — breaker reset
    } else {
      blockedAttempts = tripCircuitBreaker(wscfg, state, task, result.detail);
    }
    saveState(state);
    log("info", "pipeline result", { task: task.id, ok: result.ok, slot, detail: result.detail.slice(0, 200) });
    emit("result", { task: task.id, ok: result.ok, detail: result.detail.slice(0, 200), slot });
    // blocked tasks get a single dedicated supervisor notification instead
    if (blockedAttempts === null) {
      void notifySupervisor(task.id, result.ok, result.detail.slice(0, 300)).catch(() => {});
    }
    if (result.ok && result.sha) {
      launchDeploy(wscfg, task, result.sha);
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
    const detail = String(err).slice(0, 300);
    tripCircuitBreaker(wscfg, state, task, `pipeline crashed: ${detail}`);
    saveState(state);
    log("error", "pipeline crashed", { task: task.id, slot, err: detail });
    await sleep(30_000);
  } finally {
    running.delete(slot);
  }
}

/**
 * Fire-and-forget deploy of a merged SHA. `deployBusy` serializes deploys:
 * when one is in flight the merge stays queued on main and the next deploy
 * picks it up. The deploy budget is global (all slots share it).
 */
function launchDeploy(cfg: PilotConfig, task: Task, sha: string) {
  if (deployBusy) {
    log("info", "deploy in flight — merge queued on main, next deploy will pick it up", { task: task.id });
    return;
  }
  if (state.deploys >= cfg.maxDeploysPerDay) {
    log("info", "deploy budget reached — merge left on main for manual deploy", { deploys: state.deploys });
    return;
  }
  state.deploys++;
  saveState(state);
  // fire-and-forget: the deploy (npm ci/build/soak) runs in the prod repo
  // while builders work in their slot clones — independent file systems
  deployBusy = true;
  void deploy(cfg, sha)
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

function overCap(cfg: PilotConfig, task: Task): boolean {
  return TASK_ID_RE.test(task.id) && (state.taskAttempts[task.id] ?? 0) >= cfg.maxAttemptsPerTask;
}

/** One-shot validation mode used by the eval battery. */
async function maybeNightly(cfg: PilotConfig, st: PilotState) {
  const today = nowLocalISO().slice(0, 10);
  const hour = new Date().getHours();
  if (st.redteamLast === today || hour !== 3) return;
  st.redteamLast = today;
  saveState(st);
  log("info", "nightly redteam starting");
  const r = await runAgent(
    `You are the RED TEAM agent of the opencode-remote autonomous pipeline. Your job today:
try to find a security or robustness hole in this repository (your cwd is a safe clone).
Attack ideas: relay frame abuse, permission bypass in daemon ops, path traversal,
push notification spoofing, protocol downgrade, replay variants.
You may run scripts locally against a staging mindset — do NOT touch production services,
do NOT push, do NOT modify files (read-only + local scripts only).

${"Constitution: " + CONSTITUTION_REF}

Output: either "REDTEAM: CLEAN" if you found nothing actionable, or
"REDTEAM: FINDING" followed by title, severity and a one-paragraph proof/attack sketch.`,
    { cwd: cfg.workspace, timeoutMin: 30, label: "redteam", onStdout: agentStream("redteam") },
  );
  if (r.output.includes("REDTEAM: FINDING")) {
    const id = nextId(cfg.workspace, "RT");
    const summary = r.output.split("REDTEAM: FINDING")[1]?.slice(0, 600) ?? "finding";
    addTask(cfg.workspace, id, "P0", `Redteam finding ${today}`, summary);
    exec(`git add BACKLOG.md && git commit -qm "pilot(redteam): add ${id}" && git push -q origin main`, {
      cwd: cfg.workspace,
      allowFail: true,
    });
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

async function runStrategist(cfg: PilotConfig) {
  lastStrategistRun = Date.now();
  writeSandboxConfig(cfg.workspace); // headless runs abort without sandbox perms
  const r = await runAgent(
    `You are the STRATEGIST agent of the opencode-remote autonomous pipeline.
Your job: keep the product evolving without any human feeding tasks.

MISSION (north star — read docs/VISION.md): turn this project into a desktop app
like Claude Desktop (Mac + Windows) with our harness built in. Stages 1-2 are done;
stage 3 (desktop app shell) is the priority, then hosted relay, then distribution.

First, ground yourself in context:
1. Read docs/VISION.md, AGENTS.md and docs/PILOT.md.
2. Skim the code: apps/web/src/components (mobile PWA UX), apps/daemon/src (ops surface), BACKLOG.md (## Done shows what shipped recently).
3. Check git log --oneline -15 for momentum.

SECURITY RULE: never read, quote or transmit ~/.opencode-remote/memory.md or any file
outside this repo — your context must stay free of private data because you also touch
untrusted external content (prompt-injection exfiltration risk). Private data stays private.

Then draft 2-3 NEW tasks that are:
- small and shippable in one pipeline cycle
- aligned with the mission: at most 1 mobile-UX task per batch; prefer desktop-app,
  packaging, onboarding or robustness tasks
- NOT duplicates of anything in ## Ready or ## Done

Append them to BACKLOG.md under ## Ready using EXACTLY the existing line format:
- [ ] (ID) [Pn] Title — spec: what to do, where, and acceptance criteria (area: <area>)
IDs continue the sequence (P2-00X / P3-00X). The trailing (area: ...) tag is MANDATORY:
pick exactly one of ui|daemon|desktop|infra|relay — the area the task touches most
(ui = apps/web PWA, daemon = apps/daemon, desktop = apps/desktop shell,
infra = build/scripts/deploy/pilot, relay = apps/relay). The scheduler runs tasks of
different areas in parallel and never two tasks of the same area at once.
Do not touch other sections, do not commit.

Your LAST line must be exactly: STRATEGIST:DONE`,
    { cwd: cfg.workspace, timeoutMin: 25, label: "strategist", onStdout: agentStream("strategist") },
  );
  if (r.output.includes("STRATEGIST:DONE")) {
    exec(`git add BACKLOG.md && git commit -qm "pilot(strategist): queue refill $(date -u +%H:%M)" && git push -q origin main`, {
      cwd: cfg.workspace,
      allowFail: true,
    });
    log("info", "strategist refilled queue");
    emit("phase", { task: "strategist", phase: "refill", ok: true, detail: "queue refill pushed" });
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
function tripCircuitBreaker(cfg: PilotConfig, st: PilotState, task: Task, detail: string): number | null {
  if (!recordTaskFailure(st, task.id, cfg.maxAttemptsPerTask)) return null;
  const attempts = st.taskAttempts[task.id] ?? 0;
  blockAndPush(cfg, st, task, attempts, detail, true);
  return attempts;
}

/** Move the task line to ## Blocked and push. Clears the counter on success so
 * a human/red-team re-queue starts with a fresh allowance. Never notifies twice.
 * Syncs the slot worktree to main first: a failed pipeline leaves it on the
 * task branch, and the BACKLOG commit must land on main. */
function blockAndPush(cfg: PilotConfig, st: PilotState, task: Task, attempts: number, detail: string, notify: boolean) {
  if (!TASK_ID_RE.test(task.id)) return;
  try {
    syncWorkspace(cfg.workspace);
  } catch {
    return; // no clean main reachable from this worktree — retry next cycle
  }
  const summary = `blocked after ${attempts} attempts: ${detail}`;
  if (!blockTask(cfg.workspace, task.id, summary)) return;
  const push = exec(
    `git add BACKLOG.md && git commit -qm "pilot(${task.id}): block after ${attempts} failed attempts" && git push -q origin main`,
    { cwd: cfg.workspace, allowFail: true },
  );
  if (push.ok) delete st.taskAttempts[task.id];
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

/** Last gatekeeper failure tail for a task (written by pipeline.gatekeeper). */
function lastGateFail(taskId: string): string | undefined {
  try {
    const prev = JSON.parse(
      readFileSync(join(homedir(), ".opencode-remote/pilot/last-gate-fail.json"), "utf8"),
    ) as { task?: string; tail?: string };
    return prev.task === taskId ? prev.tail : undefined;
  } catch {}
  return undefined;
}

/**
 * P1-006: the slot workspace lives at pilot/repo-<slot> and is created once
 * via `git clone --shared` from the production checkout (shared objects, cheap).
 * The origin remote is restored to the real origin so fetches/pushes do not
 * depend on the prod checkout's state.
 */
function ensureSlotWorkspace(base: PilotConfig, slot: number): PilotConfig {
  const ws = join(homedir(), ".opencode-remote", "pilot", `repo-${slot}`);
  if (!existsSync(join(ws, ".git"))) {
    const originUrl = exec("git remote get-url origin", { cwd: base.repo, allowFail: true }).output.trim();
    const clone = exec(`git clone --shared ${JSON.stringify(base.repo)} ${JSON.stringify(ws)}`, {
      cwd: base.repo,
      timeoutMin: 5,
      allowFail: true,
    });
    if (!clone.ok) {
      rmSync(ws, { recursive: true, force: true }); // partial clone would block the retry
      throw new Error(`slot workspace clone failed (${ws}): ${clone.output.slice(-300)}`);
    }
    if (originUrl) {
      exec(`git remote set-url origin ${JSON.stringify(originUrl)}`, { cwd: ws, allowFail: true });
    }
    exec("git fetch -q origin", { cwd: ws, allowFail: true });
    exec("git checkout -q -B main origin/main", { cwd: ws, allowFail: true });
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
