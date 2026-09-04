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
 *   tierb     — probe the tier-B claude binary (`claude --version`) (P2-114)
 *
 * The pilot calls runDoctor() after every boot (apps/pilot/src/index.ts) and
 * operators can run any subcommand manually:
 *   tsx apps/pilot/src/doctor.ts <refs|attempts|backlog|branches|state|tierb|all>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nowLocalISO } from "./log";
import { exec } from "./runner";
import { emit } from "./events";
import { notifySupervisor } from "./notify";
import { loadBacklog, parseBacklog } from "./backlog";
import {
  loadConfig,
  loadState,
  saveState,
  defaultStateFile,
  type ModelsConfig,
  type PilotConfig,
  type PilotState,
} from "./state";

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

export type AttemptsRequest =
  | { mode: "report" }
  | { mode: "clear"; id: string }
  | { mode: "error"; detail: string };

/**
 * Argv dispatch for the `attempts` subcommand (table-pinned by the unit
 * battery): no flag → report only; `--clear <id>` → clear one counter;
 * `--clear` WITHOUT an id is an error, never a destructive clear-all — a
 * report-only invocation must not defeat the P1-014 stop-loss.
 */
export function parseAttemptsArgs(argv: string[]): AttemptsRequest {
  const at = argv.indexOf("--clear");
  if (at < 0) return { mode: "report" };
  const id = argv[at + 1];
  if (!id || !DOCTOR_ID_RE.test(id)) return { mode: "error", detail: id ? `invalid task id: ${id}` : "--clear requires a task id: attempts --clear <id>" };
  return { mode: "clear", id };
}

/**
 * One `attempts` invocation against a concrete state file (injectable for
 * hermetic tests). Returns false when the invocation was rejected.
 */
export function runAttemptsCommand(argv: string[], file: string, log: typeof doctorLog = doctorLog): boolean {
  const req = parseAttemptsArgs(argv);
  if (req.mode === "error") {
    log("warn", "doctor: attempts", { ok: false, detail: req.detail });
    return false;
  }
  const st = loadState(file);
  if (req.mode === "clear") {
    const cleared = clearTaskAttempts(st, req.id);
    if (cleared > 0) saveState(st, file);
    log("info", "doctor: attempts", { changed: cleared > 0, cleared: req.id });
  } else {
    log("info", "doctor: attempts", { changed: false, attempts: st.taskAttempts ?? {} });
  }
  return true;
}

// ── backlog: section + unique-id validation ──────────────────────────────────

export interface BacklogDiagnosis {
  ok: boolean;
  problems: string[];
  /** P2-142: non-fatal findings that self-normalize on the next stop-loss write. */
  warnings: string[];
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
  // P2-142: legacy stop-loss writes could stack several ## Blocked sections;
  // blockTaskEdit now reuses the first one and collapses the rest on its next
  // real write, so this is a warning — never an invalid-backlog problem.
  const blockedSections = (md.match(/^## Blocked$/gm) ?? []).length;
  const warnings: string[] = [];
  if (blockedSections > 1)
    warnings.push(`${blockedSections} duplicate ## Blocked sections — the next stop-loss write collapses them into one`);
  return { ok: problems.length === 0, problems, warnings, taskCount: parseBacklog(md).length, duplicateIds };
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
    return { ok: false, problems: [`loadBacklog failed: ${String(err).slice(0, 120)}`], warnings: [], taskCount: 0, duplicateIds: [] };
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
 * Refnames are validated against the strict `pilot/<TASK_ID>` shape BEFORE any
 * shell use — agent-created branches may carry metacharacters, and both the gh
 * probe and `git branch -D` run through a shell (P1-030 review, round 2).
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
  let failed = false;
  for (const branch of branches) {
    const id = branch.slice("pilot/".length);
    if (!branch.startsWith("pilot/") || !DOCTOR_ID_RE.test(id)) {
      skipped.push(`${branch} (invalid refname)`);
      continue;
    }
    if (branch === current) {
      skipped.push(`${branch} (checked out)`);
      continue;
    }
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
    else {
      skipped.push(`${branch} (delete failed)`);
      failed = true; // the repair did not happen — never report success
    }
  }
  const parts: string[] = [];
  if (deleted.length) parts.push(`deleted: ${deleted.join(", ")}`);
  if (skipped.length) parts.push(`skipped: ${skipped.join(", ")}`);
  return {
    ok: !failed,
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
    taskCache: s.taskCache && typeof s.taskCache === "object" ? s.taskCache : {},
    // P2-113: BYOK dollar view — legacy files backfill to {}
    taskUSD: s.taskUSD && typeof s.taskUSD === "object" ? s.taskUSD : {},
    // P1-078: per-slot cache breakdown — legacy files backfill to {}
    slotCache: s.slotCache && typeof s.slotCache === "object" ? s.slotCache : {},
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

// ── tierb: P2-114 — probe the tier-B claude binary ───────────────────────────

/**
 * P2-114: boot-time diagnosis of the tier-B dispatch path. A missing/broken
 * `claude` binary only produces a warn-level `tierB-fallback` log line per
 * call, so the pilot once ran ~18h without tier-B unnoticed (the pipeline kept
 * working through tier A). With a tier-B model configured this runs
 * `claude --version`; failure → ok:false + the output tail. Diagnostic only —
 * `changed` is always false (no repair attempted). Without any configured
 * tier-B model the probe is skipped (a tier-A-only machine stays green).
 */
export function doctorTierB(models: ModelsConfig | undefined, run: RunFn): DoctorResult {
  const tierB = models?.tierB;
  if (!tierB || Object.keys(tierB).length === 0) {
    return { ok: true, changed: false, detail: "no tier-B model configured — probe skipped" };
  }
  const r = run("claude --version");
  if (r.ok) {
    const first = r.output.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
    return { ok: true, changed: false, detail: `claude ${first}` };
  }
  return { ok: false, changed: false, detail: `tier-B binary unusable: claude --version failed — ${r.output.slice(-120)}` };
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
 * P2-114: also probes the tier-B binary (`doctorTierB`); a red probe logs
 * warn, emits a `tierB-binary` phase event and notifies the supervisor, but
 * still never blocks the boot.
 */
export function runDoctor(
  cfg: Pick<PilotConfig, "repo" | "models">,
  workspaces: string[],
  log: typeof doctorLog = doctorLog,
  hooks?: { runTierB?: RunFn; notify?: typeof notifySupervisor; emitEvent?: typeof emit },
): void {
  const st = loadState();

  const refsResults = workspaces.map((ws) => {
    const r = safe(() => doctorRefs(ws), "refs");
    log(r.ok ? "info" : "warn", "doctor: refs", { ws, ...r });
    return r.ok;
  });

  const stateResult = safe(() => doctorState(), "state");
  log(stateResult.ok ? "info" : "warn", "doctor: state", stateResult);

  let backlog: BacklogDiagnosis;
  try {
    backlog = doctorBacklog(cfg.repo);
  } catch (err) {
    backlog = { ok: false, problems: [String(err).slice(0, 120)], warnings: [], taskCount: 0, duplicateIds: [] };
  }
  log(backlog.ok ? "info" : "warn", "doctor: backlog", { repo: cfg.repo, ...backlog });

  // P2-114: bounded 1min timeout — a hung `claude --version` must not hold the
  // boot; a slow/failing probe is reported, never fatal.
  const tierB = safe(
    () =>
      doctorTierB(
        cfg.models,
        hooks?.runTierB ?? ((cmd) => exec(cmd, { cwd: cfg.repo, allowFail: true, timeoutMin: 1 })),
      ),
    "tierb",
  );
  log(tierB.ok ? "info" : "warn", "doctor: tierB", { repo: cfg.repo, ...tierB });
  if (!tierB.ok) {
    try {
      (hooks?.emitEvent ?? emit)("phase", { task: "doctor", phase: "tierB-binary", ok: false, detail: tierB.detail });
    } catch {}
    void (hooks?.notify ?? notifySupervisor)("doctor", false, tierB.detail).catch(() => {});
  }

  const branchResults = workspaces.map((ws) => {
    const r = safe(() => doctorBranches(ws, { protectedIds: protectedBranchIds(st) }), "branches");
    log(r.ok ? "info" : "warn", "doctor: branches", { ws, ...r });
    return r.ok;
  });

  log("info", "doctor pass complete", {
    ok: refsResults.every(Boolean) && stateResult.ok && backlog.ok && tierB.ok && branchResults.every(Boolean),
  });
}

function safe(fn: () => DoctorResult, what: string): DoctorResult {
  try {
    return fn();
  } catch (err) {
    return { ok: false, changed: false, detail: `${what} crashed: ${String(err).slice(0, 200)}` };
  }
}

// ── CLI: tsx apps/pilot/src/doctor.ts <refs|attempts|backlog|branches|state|tierb|all> ─

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
      ok = runAttemptsCommand(process.argv, defaultStateFile());
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
    case "tierb": {
      const r = safe(
        () =>
          doctorTierB(cfg.models, (cmd2) => exec(cmd2, { cwd: cfg.repo, allowFail: true, timeoutMin: 1 })),
        "tierb",
      );
      log(r.ok ? "info" : "warn", "doctor: tierB", { repo: cfg.repo, ...r });
      ok = r.ok;
      break;
    }
    case "all":
      runDoctor(cfg, [cfg.workspace]);
      break;
    default:
      console.error(`usage: tsx apps/pilot/src/doctor.ts <refs|attempts --clear [id]|backlog|branches|state|tierb|all>`);
      process.exitCode = 1;
      return;
  }
  if (!ok) process.exitCode = 1;
}

// CLI entry only — imported by index.ts, this module never runs the pass
// implicitly (argv[1] points at the doctor file only under tsx).
if (process.argv[1]?.endsWith("doctor.ts")) main();

