import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec, runAgent } from "./runner";
import { runPipeline } from "./pipeline";
import { deploy } from "./deploy";
import { digest } from "./push";
import { addTask, loadBacklog, nextId } from "./backlog";
import { frozen, loadConfig, loadState, saveState, type PilotConfig } from "./state";

const log = (level: string, msg: string, data?: unknown) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, data }));

async function main() {
  const cfg = loadConfig();
  ensureWorkspace(cfg);

  const once = process.argv.includes("--once");
  log("info", "pilot started", { once, repo: cfg.repo, workspace: cfg.workspace });

  for (;;) {
    if (frozen()) {
      log("info", "frozen — pilot.lock present, sleeping 10 min");
      await sleep(10 * 60_000);
      continue;
    }
    const state = loadState();

    // daily budget guard
    if (state.tasks >= cfg.maxTasksPerDay) {
      log("info", "daily task budget reached", { tasks: state.tasks });
      await sleep(30 * 60_000);
      continue;
    }

    // nightly redteam (03:xx) + weekly maintenance (Sunday) — best effort
    await maybeNightly(cfg, state);

    const tasks = loadBacklog(cfg.workspace);
    const task = tasks[0];
    if (!task) {
      await sleep(15 * 60_000);
      continue;
    }

    log("info", "pipeline start", { task: task.id, title: task.title });
    try {
      const result = await runPipeline(cfg, task, state);
      state.tasks++;
      saveState(state);
      log("info", "pipeline result", { task: task.id, ok: result.ok, detail: result.detail.slice(0, 200) });
      if (result.ok && result.sha) {
        if (state.deploys >= cfg.maxDeploysPerDay) {
          log("info", "deploy budget reached — merge left on main for manual deploy", { deploys: state.deploys });
        } else {
          state.deploys++;
          saveState(state);
          const dep = await deploy(cfg, result.sha);
          log("info", "deploy result", { task: task.id, ...dep });
          if (!dep.ok) state.failures++;
          if (cfg.digest) {
            await digest(
              dep.ok ? `🛠 Pilot: ${task.title}` : `⚠️ Pilot rollback: ${task.title}`,
              dep.ok ? dep.detail : dep.detail,
              dep.ok ? "#/" : "#/",
            );
          }
        }
      } else if (!result.ok) {
        if (cfg.digest) await digest(`🧪 Pilot falhou: ${task.id}`, result.detail.slice(0, 120), "#/");
        await sleep(5 * 60_000); // cool down after failure
      }
      saveState(state);
    } catch (err) {
      state.failures++;
      saveState(state);
      log("error", "pipeline crashed", { task: task.id, err: String(err).slice(0, 300) });
      await sleep(10 * 60_000);
    }

    if (once) break;
    await sleep(2 * 60_000);
  }
}

/** One-shot validation mode used by the eval battery. */
async function maybeNightly(cfg: PilotConfig, state: ReturnType<typeof loadState>) {
  const today = new Date().toISOString().slice(0, 10);
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
    { cwd: cfg.workspace, timeoutMin: 30, label: "redteam" },
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

function ensureWorkspace(cfg: PilotConfig) {
  if (existsSync(join(cfg.workspace, ".git"))) return;
  exec(`git clone ${exec("git remote get-url origin", { cwd: cfg.repo }).output.trim()} ${JSON.stringify(cfg.workspace)}`, {
    cwd: cfg.repo,
    timeoutMin: 5,
  });
}

const CONSTITUTION_REF = "see docs/CONSTITUTION.md — E2E stays E2E, allowlist/replay/0600 untouchable, no secrets, documented changes only.";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  log("error", "pilot fatal", { err: String(err).slice(0, 500) });
  process.exit(1);
});
