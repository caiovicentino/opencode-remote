/**
 * P1-030 — pilot doctor: deterministic, idempotent repair pass for the
 * autonomous pipeline. Repairs that used to be done by hand after bad boots
 * (stale workspace refs, corrupted state.json, malformed BACKLOG.md, orphan
 * pilot/* branches) become five subcommands, each idempotent and logged:
 *
 *   refs      — fetch + hard-reset a workspace clone to origin/main
 *   attempts  — clear the P1-014 circuit-breaker counters (--clear [id])
 *   backlog   — validate sections + unique task ids via loadBacklog
 *   branches  — delete pilot/* branches with no open PR (gh-verified)
 *   state     — normalize state.json to the current schema + defaults
 *
 * The pilot calls runDoctor() after every boot (apps/pilot/src/index.ts) and
 * operators can run any subcommand manually:
 *   tsx apps/pilot/src/doctor.ts <refs|attempts|backlog|branches|state|all>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nowLocalISO } from "./log";
import { exec } from "./runner";
import { loadBacklog, parseBacklog } from "./backlog";
import { loadConfig, loadState, saveState, defaultStateFile, type PilotConfig, type PilotState } from "./state";

/** Injectable command runner — unit tests pin the exact git command sequence. */
export type RunFn = (cmd: string) => { ok: boolean; output: string };

export interface DoctorResult {
  ok: boolean;
  /** True when the operation actually changed something (idempotency signal). */
  changed: boolean;
  detail: string;
}

/** Task ids are P<n>-<3 digits> or RT-<3 digits> (same shape TASK_ID_RE pins). */
export const DOCTOR_ID_RE = /^(?:P\d|RT)-\d{3}$/;

function realRun(ws: string): RunFn {
  return (cmd) => exec(cmd, { cwd: ws, allowFail: true });
}

// ── refs: fetch + reset the workspace clone to the source HEAD ───────────────

/**
 * Mirror the workspace clone onto origin/main (same command sequence as the
 * scheduler's syncWorkspace, minus the trust assumptions — every step is
 * allowFail and the outcome is reported). `changed` reflects a HEAD move, so
 * running the doctor twice in a row logs "changed: false" the second time.
 */
export function doctorRefs(ws: string, run: RunFn = realRun(ws)): DoctorResult {
  const before = run("git rev-parse HEAD").output.trim();
  const steps = ["git fetch origin", "git checkout -q main", "git reset -q --hard origin/main", "git clean -qfd"];
  const failed: string[] = [];
  for (const cmd of steps) {
    // fetch is best-effort (offline repair still resets to the local origin/main ref)
    if (!run(cmd).ok && !cmd.startsWith("git fetch")) failed.push(cmd);
  }
  const after = run("git rev-parse HEAD").output.trim();
  return {
    ok: failed.length === 0,
    changed: !!before && !!after && before !== after,
    detail: failed.length ? `failed: ${failed.join(" | ")}` : `workspace at ${after.slice(0, 7) || "main"}`,
  };
}

// ── attempts: P1-014 circuit-breaker counters ────────────────────────────────

/**
 * Clear the failure counter for one task (id) or all of them. Mutates `st`
 * and returns how many counters were removed — 0 means already clear, so the
 * caller skips the save (idempotency).
 */
export function clearTaskAttempts(st: PilotState, id?: string): number {
  if (id) {
    if (!st.taskAttempts || !(id in st.taskAttempts)) return 0;
    delete st.taskAttempts[id];
    return 1;
  }
  const n = Object.keys(st.taskAttempts ?? {}).length;
  st.taskAttempts = {};
  return n;
}

// ── backlog: section + unique-id validation ──────────────────────────────────

export interface BacklogDiagnosis {
  ok: boolean;
  problems: string[];
  /** Tasks parseable in ## Ready (the scheduler's queue). */
  taskCount: number;
  /** Ids appearing on more than one task line (any checkbox state). */
  duplicateIds: string[];
}

const TASK_LINE_RE = /^- \[[ x]\] \(([^)]+)\)/gm;

/**
 * Validate the BACKLOG.md structure: `## Ready` and `## Done` must exist
 * (`## Blocked` is optional — created lazily by the stop-loss) and every task
 * id across all sections must be unique. Read-only: a corrupt backlog is
 * reported, never auto-edited, so the operation is trivially idempotent.
 */
export function validateBacklog(md: string): BacklogDiagnosis {
  const problems: string[] = [];
  for (const section of ["Ready", "Done"]) {
    if (!new RegExp(`^## ${section}$`, "m").test(md)) problems.push(`missing section: ## ${section}`);
  }
  const seen = new Map<string, number>();
  for (const m of md.matchAll(TASK_LINE_RE)) {
    const id = m[1]?.trim() ?? "";
    if (!id) continue;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const duplicateIds = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (duplicateIds.length) problems.push(`duplicate task ids: ${duplicateIds.join(", ")}`);
  return { ok: problems.length === 0, problems, taskCount: parseBacklog(md).length, duplicateIds };
}

/**
 * Validate the backlog the production parser would read: loadBacklog first
 * (missing file / unreadable path become findings) then the pure validator.
 */
export function doctorBacklog(repoDir: string): BacklogDiagnosis {
  let taskCount = 0;
  try {
    taskCount = loadBacklog(repoDir).length;
  } catch (err) {
    return { ok: false, problems: [`loadBacklog failed: ${String(err).slice(0, 120)}`], taskCount: 0, duplicateIds: [] };
  }
  const diag = validateBacklog(readFileSync(join(repoDir, "BACKLOG.md"), "utf8"));
  return { ...diag, taskCount };
}

// ── branches: delete pilot/* with no open PR ─────────────────────────────────

/**
 * Delete local pilot/* branches that have no open PR. Fail-safe by design: a
 * branch is only deleted when `gh` confirms the PR state — an gh failure or an
 * open PR skips the branch. Branches whose task still has live attempts
 * (preserved for a retry, P1-060) and the checked-out branch are never touched.
 */
export function doctorBranches(
  ws: string,
  opts: { run?: RunFn; gh?: RunFn; protectedIds?: Set<string> } = {},
): DoctorResult {
  const run = opts.run ?? realRun(ws);
  const gh = opts.gh ?? realRun(ws);
  const listing = run("git for-each-ref --format=%(refname:short) refs/heads/pilot/*");
  if (!listing.ok) return { ok: false, changed: false, detail: `cannot list branches: ${listing.output.slice(-120)}` };
  const branches = listing.output.split("\n").map((l) => l.trim()).filter(Boolean);
  const current = run("git rev-parse --abbrev-ref HEAD").output.trim();
  const deleted: string[] = [];
  const skipped: string[] = [];
  for (const branch of branches) {
    if (branch === current) {
      skipped.push(`${branch} (checked out)`);
      continue;
    }
    const id = branch.slice("pilot/".length);
    if (opts.protectedIds?.has(id)) {
      skipped.push(`${branch} (preserved for retry)`);
      continue;
    }
    // fail-safe: only a clean gh answer with no open PR allows deletion
    const probe = gh(`gh pr list --head ${branch} --state open --json number --limit 1`);
    if (!probe.ok) {
      skipped.push(`${branch} (gh unavailable)`);
      continue;
    }
    if (probe.output.trim() !== "[]") {
      skipped.push(`${branch} (open PR)`);
      continue;
    }
    if (run(`git branch -D ${branch}`).ok) deleted.push(branch);
    else skipped.push(`${branch} (delete failed)`);
  }
  const parts: string[] = [];
  if (deleted.length) parts.push(`deleted: ${deleted.join(", ")}`);
  if (skipped.length) parts.push(`skipped: ${skipped.join(", ")}`);
  return {
    ok: true,
    changed: deleted.length > 0,
    detail: parts.length ? parts.join(" | ") : "no pilot/* branches",
  };
}

// ── state: schema + defaults ─────────────────────────────────────────────────

/**
 * Fill every field the rest of the pipeline assumes exists. loadState already
 * tolerates the daily rollover; this completes the repair for state files that
 * predate newer fields (merges, cycles, costs…) or carry garbage types.
 */
export function normalizePilotState(s: PilotState): PilotState {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    ...s,
    date: typeof s.date === "string" && s.date ? s.date : nowLocalISO().slice(0, 10),
    tasks: num(s.tasks),
    deploys: num(s.deploys),
    failures: num(s.failures),
    merges: num(s.merges),
    taskAttempts: s.taskAttempts && typeof s.taskAttempts === "object" ? s.taskAttempts : {},
    cycles: Array.isArray(s.cycles) ? s.cycles : [],
    blockEvents: Array.isArray(s.blockEvents) ? s.blockEvents : [],
    auditMode: s.auditMode ?? null,
    taskCosts: s.taskCosts && typeof s.taskCosts === "object" ? s.taskCosts : {},
    taskCostSessions: s.taskCostSessions && typeof s.taskCostSessions === "object" ? s.taskCostSessions : {},
  };
}

/**
 * Load state.json, normalize it and write it back only when the shape changed
 * (writeJsonAtomic keeps the swap crash-safe). The comparison is against the
 * RAW file text, not the parsed state — loadState already hides corruption
 * behind fresh defaults, and a corrupt file must be rewritten with them.
 */
export function doctorState(file: string = defaultStateFile()): DoctorResult {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {}
  const norm = normalizePilotState(loadState(file));
  if (raw === JSON.stringify(norm, null, 2)) return { ok: true, changed: false, detail: "state.json already normalized" };
  try {
    saveState(norm, file);
  } catch (err) {
    return { ok: false, changed: false, detail: `saveState failed: ${String(err).slice(0, 120)}` };
  }
  return { ok: true, changed: true, detail: "state.json normalized to current schema" };
}

// ── orchestration ────────────────────────────────────────────────────────────

export function doctorLog(level: string, msg: string, data?: unknown): void {
  console.log(JSON.stringify({ ts: nowLocalISO(), level, msg, data }));
}

/** Live circuit-breaker counters: branches of tasks under retry are preserved. */
function protectedBranchIds(st: PilotState): Set<string> {
  return new Set(Object.entries(st.taskAttempts ?? {}).filter(([, n]) => n > 0).map(([id]) => id));
}

/**
 * Boot pass (P1-030): run every subcommand against the production repo and
 * each slot workspace. Every operation is wrapped — a doctor failure logs a
 * warning and never keeps the pipeline from starting.
 */
export function runDoctor(cfg: Pick<PilotConfig, "repo">, workspaces: string[], log: typeof doctorLog = doctorLog): void {
  const st = loadState();

  for (const ws of workspaces) {
    const r = safe(() => doctorRefs(ws), "refs");
    log(r.ok ? "info" : "warn", "doctor: refs", { ws, ...r });
  }

  const stateResult = safe(() => doctorState(), "state");
  log(stateResult.ok ? "info" : "warn", "doctor: state", stateResult);

  let backlog: BacklogDiagnosis;
  try {
    backlog = doctorBacklog(cfg.repo);
  } catch (err) {
    backlog = { ok: false, problems: [String(err).slice(0, 120)], taskCount: 0, duplicateIds: [] };
  }
  log(backlog.ok ? "info" : "warn", "doctor: backlog", { repo: cfg.repo, ...backlog });

  for (const ws of workspaces) {
    const r = safe(() => doctorBranches(ws, { protectedIds: protectedBranchIds(st) }), "branches");
    log(r.ok ? "info" : "warn", "doctor: branches", { ws, ...r });
  }

  log("info", "doctor pass complete", { ok: backlog.ok && stateResult.ok });
}

function safe(fn: () => DoctorResult, what: string): DoctorResult {
  try {
    return fn();
  } catch (err) {
    return { ok: false, changed: false, detail: `${what} crashed: ${String(err).slice(0, 200)}` };
  }
}

// ── CLI: tsx apps/pilot/src/doctor.ts <refs|attempts|backlog|branches|state|all> ─

function main() {
  const cfg = loadConfig();
  const cmd = process.argv[2] ?? "all";
  const log = doctorLog;
  let ok = true;
  switch (cmd) {
    case "refs": {
      const r = doctorRefs(cfg.workspace);
      log(r.ok ? "info" : "warn", "doctor: refs", { ws: cfg.workspace, ...r });
      ok = r.ok;
      break;
    }
    case "attempts": {
      const st = loadState();
      const clearAt = process.argv.indexOf("--clear");
      const id = clearAt >= 0 ? process.argv[clearAt + 1] : undefined;
      if (clearAt >= 0 && id && !DOCTOR_ID_RE.test(id)) {
        log("warn", "doctor: attempts", { ok: false, detail: `invalid task id: ${id}` });
        ok = false;
        break;
      }
      const cleared = clearTaskAttempts(st, id);
      if (cleared > 0) saveState(st);
      log("info", "doctor: attempts", { changed: cleared > 0, cleared, attempts: st.taskAttempts });
      break;
    }
    case "backlog": {
      const diag = doctorBacklog(cfg.repo);
      log(diag.ok ? "info" : "warn", "doctor: backlog", { repo: cfg.repo, ...diag });
      ok = diag.ok;
      break;
    }
    case "branches": {
      const st = loadState();
      const r = doctorBranches(cfg.workspace, { protectedIds: protectedBranchIds(st) });
      log(r.ok ? "info" : "warn", "doctor: branches", { ws: cfg.workspace, ...r });
      ok = r.ok;
      break;
    }
    case "state": {
      const r = doctorState();
      log(r.ok ? "info" : "warn", "doctor: state", r);
      ok = r.ok;
      break;
    }
    case "all":
      runDoctor(cfg, [cfg.workspace]);
      break;
    default:
      console.error(`usage: tsx apps/pilot/src/doctor.ts <refs|attempts --clear [id]|backlog|branches|state|all>`);
      process.exitCode = 1;
      return;
  }
  if (!ok) process.exitCode = 1;
}

// CLI entry only — imported by index.ts, this module never runs the pass
// implicitly (argv[1] points at the doctor file only under tsx).
if (process.argv[1]?.endsWith("doctor.ts")) main();

