import { existsSync, readFileSync } from "node:fs";
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
import { addTask, blockTask, loadBacklog, nextId, type Task } from "./backlog";
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
const log = (level: string, msg: string, data?: unknown) =>
  console.log(JSON.stringify({ ts: nowLocalISO(), level, msg, data }));

async function main() {
  await ensureSingleton();
  const cfg = loadConfig();
  ensureWorkspace(cfg);
  startWatchdog();

  const once = process.argv.includes("--once");
  log("info", "pilot started", { once, repo: cfg.repo, workspace: cfg.workspace });

  for (;;) {
    touchHeartbeat();
    if (frozen()) {
      log("info", "frozen — pilot.lock present, rechecking in 5s");
      await sleep(5_000);
      continue;
    }
    const state = loadState();
    syncWorkspace(cfg);

    // daily budget guard
    if (state.tasks >= cfg.maxTasksPerDay) {
      log("info", "daily task budget reached", { tasks: state.tasks });
      await sleep(30_000);
      continue;
    }

    // nightly redteam (03:xx) + weekly maintenance (Sunday) — best effort
    await maybeNightly(cfg, state);

    // pending deploy: production is behind origin/main (e.g. after a rollback)
    if (state.deploys < cfg.maxDeploysPerDay) {
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

    const tasks = loadBacklog(cfg.workspace);
    // self-sustaining evolution: never let the queue run dry
    if (tasks.length < 2 && Date.now() - lastStrategistRun > 10 * 60_000) {
      log("info", "queue low — strategist drafting next tasks", { ready: tasks.length });
      await runStrategist(cfg);
      continue; // re-read backlog fresh in the next cycle
    }
    // RESEARCHER: daily frontier scan (web signal → [spike] tasks)
    const today = nowLocalISO().slice(0, 10);
    if (state.researchLast !== today) {
      await runResearcher(cfg, state);
      saveState(state);
    }

    const task = tasks[0];
    if (!task) {
      await sleep(20_000); // queue empty — strategist runs above when low
      continue;
    }

    // P1-014 circuit breaker: cap already reached (e.g. the ## Blocked push
    // failed last cycle) — re-persist the block, never re-schedule it
    const breakerAttempts = state.taskAttempts[task.id] ?? 0;
    if (TASK_ID_RE.test(task.id) && breakerAttempts >= cfg.maxAttemptsPerTask) {
      blockAndPush(cfg, state, task, breakerAttempts, lastGateFail(task.id) ?? "max attempts reached", false);
      saveState(state);
      await sleep(20_000);
      continue;
    }

    log("info", "pipeline start", { task: task.id, title: task.title });
    emit("loop", { task: task.id, phase: "picked", detail: task.title });
    try {
      const result = await runPipeline(cfg, task, state);
      state.tasks++;
      let blockedAttempts: number | null = null;
      if (result.ok) {
        delete state.taskAttempts[task.id]; // gate passed — breaker reset
      } else {
        blockedAttempts = tripCircuitBreaker(cfg, state, task, result.detail);
      }
      saveState(state);
      log("info", "pipeline result", { task: task.id, ok: result.ok, detail: result.detail.slice(0, 200) });
      emit("result", { task: task.id, ok: result.ok, detail: result.detail.slice(0, 200) });
      // blocked tasks get a single dedicated supervisor notification instead
      if (blockedAttempts === null) {
        void notifySupervisor(task.id, result.ok, result.detail.slice(0, 300)).catch(() => {});
      }
      if (result.ok && result.sha) {
        if (deployBusy) {
          log("info", "deploy in flight — merge queued on main, next deploy will pick it up", { task: task.id });
        } else if (state.deploys >= cfg.maxDeploysPerDay) {
          log("info", "deploy budget reached — merge left on main for manual deploy", { deploys: state.deploys });
        } else {
          state.deploys++;
          saveState(state);
          // fire-and-forget: the deploy (npm ci/build/soak) runs in the prod
          // repo while the builder works in the workspace clone — independent
          // file systems, so the next task starts immediately
          deployBusy = true;
          const sha = result.sha;
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
      } else if (!result.ok) {
        if (blockedAttempts !== null && cfg.digest) {
          await digest(
            `Pilot: ${task.id} blocked`,
            `moved to ## Blocked after ${blockedAttempts} attempts`,
            "#/",
          );
        } else if (cfg.digest) {
          await digest(`🧪 Pilot falhou: ${task.id}`, result.detail.slice(0, 120), "#/");
        }
        await sleep(10_000); // short cool-down; full output saved for diagnosis
      }
      saveState(state);
    } catch (err) {
      state.failures++;
      const detail = String(err).slice(0, 300);
      tripCircuitBreaker(cfg, state, task, `pipeline crashed: ${detail}`);
      saveState(state);
      log("error", "pipeline crashed", { task: task.id, err: detail });
      await sleep(30_000);
    }

    if (once) break;
    await sleep(5_000);
  }
}

/** One-shot validation mode used by the eval battery. */
async function maybeNightly(cfg: PilotConfig, state: ReturnType<typeof loadState>) {
  const today = nowLocalISO().slice(0, 10);
  const hour = new Date().getHours();
  if (state.redteamLast === today || hour !== 3) return;
  state.redteamLast = today;
  saveState(state);
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
- [ ] (ID) [Pn] Title — spec: what to do, where, and acceptance criteria
IDs continue the sequence (P2-00X / P3-00X). Do not touch other sections, do not commit.

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
function tripCircuitBreaker(cfg: PilotConfig, state: PilotState, task: Task, detail: string): number | null {
  if (!recordTaskFailure(state, task.id, cfg.maxAttemptsPerTask)) return null;
  const attempts = state.taskAttempts[task.id] ?? 0;
  blockAndPush(cfg, state, task, attempts, detail, true);
  return attempts;
}

/** Move the task line to ## Blocked and push. Clears the counter on success so
 * a human/red-team re-queue starts with a fresh allowance. Never notifies twice. */
function blockAndPush(cfg: PilotConfig, state: PilotState, task: Task, attempts: number, detail: string, notify: boolean) {
  if (!TASK_ID_RE.test(task.id)) return;
  const summary = `blocked after ${attempts} attempts: ${detail}`;
  if (!blockTask(cfg.workspace, task.id, summary)) return;
  const push = exec(
    `git add BACKLOG.md && git commit -qm "pilot(${task.id}): block after ${attempts} failed attempts" && git push -q origin main`,
    { cwd: cfg.workspace, allowFail: true },
  );
  if (push.ok) delete state.taskAttempts[task.id];
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

function ensureWorkspace(cfg: PilotConfig) {
  if (existsSync(join(cfg.workspace, ".git"))) return;
  exec(`git clone ${exec("git remote get-url origin", { cwd: cfg.repo }).output.trim()} ${JSON.stringify(cfg.workspace)}`, {
    cwd: cfg.repo,
    timeoutMin: 5,
  });
}

/** Workspace must mirror origin/main before we read the backlog or spawn agents. */
function syncWorkspace(cfg: PilotConfig) {
  exec("git fetch origin", { cwd: cfg.workspace, allowFail: true });
  exec("git checkout -q main", { cwd: cfg.workspace, allowFail: true });
  exec("git reset -q --hard origin/main", { cwd: cfg.workspace });
  exec("git clean -qfd", { cwd: cfg.workspace });
}

const CONSTITUTION_REF = "see docs/CONSTITUTION.md — E2E stays E2E, allowlist/replay/0600 untouchable, no secrets, documented changes only.";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  log("error", "pilot fatal", { err: String(err).slice(0, 500) });
  process.exit(1);
});
