/**
 * P2-058 — deploy guard: only gate-verified merge SHAs may reach production.
 *
 * The gatekeeper records the merge sha of every successful merge (PR squash or
 * local --no-ff fallback) in ~/.opencode-remote/pilot/verified-merges.jsonl;
 * deploy() refuses any sha that is not on that list, so a direct push to main
 * (scribe/backlog bookkeeping or an unverified hand-made commit) can never
 * trigger a deploy (security fable #2/#3). A failed deploy quarantines its sha
 * in quarantine.jsonl so the pending-deploy self-heal cannot re-deploy the
 * same broken brain: the target walk skips it and production stays on the last
 * good verified sha until a newer merge supersedes it.
 *
 * The state list (instead of a gh api lookup) keeps the guard deterministic,
 * offline and eval-testable; it is written by deterministic code (the
 * gatekeeper), never by an agent.
 *
 * Pure module (fs only, no exec) so the eval battery can pin every rule.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Object-id charset — shas loaded from files outside the repo never reach a
 * shell or a guard decision unchecked (P1-060 lesson). */
export const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Cap on how far the target walk scans: bookkeeping commits (mark-done,
 * scribe, backlog refills) pile up between merges, but 50 first-parent steps
 * is already an outlier. Anything beyond → null (fail-closed). */
export const MAX_WALK_COMMITS = 50;
export const MAX_VERIFIED_ENTRIES = 200;
export const MAX_QUARANTINE_ENTRIES = 100;

export interface VerifiedMerge {
  sha: string;
  task: string;
  at: string;
}

export interface QuarantinedSha {
  sha: string;
  task: string;
  at: string;
  why: string;
}

export function defaultVerifiedMergesFile(): string {
  return join(homedir(), ".opencode-remote", "pilot", "verified-merges.jsonl");
}

export function defaultQuarantineFile(): string {
  return join(homedir(), ".opencode-remote", "pilot", "quarantine.jsonl");
}

/** Tolerant parse: corrupt/partial lines and invalid shas are skipped — a bad
 * write must never make the whole file unreadable (same contract as lessons.jsonl). */
export function parseVerifiedMerges(jsonl: string): VerifiedMerge[] {
  const out: VerifiedMerge[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const raw = JSON.parse(t) as Partial<VerifiedMerge>;
      if (typeof raw?.sha !== "string" || !SHA_RE.test(raw.sha)) continue;
      out.push({
        sha: raw.sha,
        task: typeof raw.task === "string" ? raw.task : "",
        at: typeof raw.at === "string" ? raw.at : "",
      });
    } catch {}
  }
  return out;
}

export function parseQuarantine(jsonl: string): QuarantinedSha[] {
  const out: QuarantinedSha[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const raw = JSON.parse(t) as Partial<QuarantinedSha>;
      if (typeof raw?.sha !== "string" || !SHA_RE.test(raw.sha)) continue;
      out.push({
        sha: raw.sha,
        task: typeof raw.task === "string" ? raw.task : "",
        at: typeof raw.at === "string" ? raw.at : "",
        why: typeof raw.why === "string" ? raw.why : "",
      });
    } catch {}
  }
  return out;
}

function readJsonl(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function readVerifiedMerges(file: string): VerifiedMerge[] {
  return parseVerifiedMerges(readJsonl(file));
}

export function readQuarantine(file: string): QuarantinedSha[] {
  return parseQuarantine(readJsonl(file));
}

function writeAll(file: string, content: string): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record one gate-verified merge sha. Idempotent per sha; the rewrite keeps
 * only the newest MAX_VERIFIED_ENTRIES so the file never grows unbounded.
 * Called by the gatekeeper (one call per task merge; P1-099 lets two slots'
 * gatekeepers overlap, but each task records its own distinct sha).
 */
export function recordVerifiedMerge(file: string, sha: string, task: string, at: string): boolean {
  if (!SHA_RE.test(sha)) return false;
  const existing = readVerifiedMerges(file);
  if (existing.some((v) => v.sha === sha)) return true;
  const next = [...existing, { sha, task, at }].slice(-MAX_VERIFIED_ENTRIES);
  return writeAll(file, `${next.map((v) => JSON.stringify(v)).join("\n")}\n`);
}

/**
 * Quarantine a sha whose deploy failed and rolled back. Idempotent per sha;
 * bounded like the verified list. An old quarantine is harmless once a newer
 * verified merge supersedes the bad sha (the walk finds the newer one first).
 */
export function quarantineSha(file: string, sha: string, why: string, task: string, at: string): boolean {
  if (!SHA_RE.test(sha)) return false;
  const existing = readQuarantine(file);
  if (existing.some((q) => q.sha === sha)) return true;
  const next = [...existing, { sha, task, at, why }].slice(-MAX_QUARANTINE_ENTRIES);
  return writeAll(file, `${next.map((q) => JSON.stringify(q)).join("\n")}\n`);
}

/**
 * Pure selection rule: from the newest-first first-parent history of
 * origin/main, the deployable sha is the newest entry the gatekeeper verified
 * AND that is not quarantined. Unverified bookkeeping commits on top of main
 * (mark-done, scribe, strategist refill — all direct pushes) are walked past,
 * which is exactly why a direct push to main cannot trigger a deploy; a
 * quarantined sha is skipped so a broken merge cannot re-enter the deploy
 * loop, falling back to the last good verified sha.
 */
export function pickDeployableSha(
  history: string[],
  verified: VerifiedMerge[],
  quarantine: QuarantinedSha[],
): string | null {
  const ok = new Set(verified.map((v) => v.sha));
  const banned = new Set(quarantine.map((q) => q.sha));
  for (const sha of history.slice(0, MAX_WALK_COMMITS)) {
    if (!SHA_RE.test(sha) || !ok.has(sha) || banned.has(sha)) continue;
    return sha;
  }
  return null;
}

/**
 * P3-358: the launchDeploy pre-guards as a pure decision, so the battery
 * proves the foreign-mission refusal BEHAVIORALLY (a foreign mission repo
 * serves no production service here — a reset + build + kickstart of our
 * services would only cause an outage) instead of grepping the dispatcher
 * source. Null = no guard held, proceed to target resolution.
 */
export type DeploySkipReason = "foreign-mission" | "deploy-in-flight" | "budget-reached";

export function deploySkipReason(
  foreignMission: boolean,
  deployBusy: boolean,
  deploys: number,
  maxDeploysPerDay: number,
): DeploySkipReason | null {
  if (foreignMission) return "foreign-mission";
  if (deployBusy) return "deploy-in-flight";
  if (deploys >= maxDeploysPerDay) return "budget-reached";
  return null;
}

/**
 * The deploy-side verdict for a concrete sha — defense in depth: callers
 * already resolve their target with pickDeployableSha, but deploy() re-checks
 * the sha it was handed against the same lists. Null = allowed.
 */
export function shaGuardDetail(sha: string, verified: VerifiedMerge[], quarantine: QuarantinedSha[]): string | null {
  if (!SHA_RE.test(sha)) return "unverifiable sha — deploy refused";
  if (!verified.some((v) => v.sha === sha)) return "sha not gate-verified — deploy refused";
  if (quarantine.some((q) => q.sha === sha)) return "sha quarantined after a failed deploy — deploy refused";
  return null;
}

// ── P2-114: dirty guard — the production checkout is also a human worktree ──

/**
 * Pure verdict for a `git status --porcelain --untracked-files=no` probe of
 * the production checkout. The prod repo doubles as the operator's working
 * tree, so a blind `git reset --hard` would silently destroy tracked local
 * edits — the deploy must abort BEFORE any mutation instead.
 *
 * - `null` (probe failed / repo unreadable) → abort text: fail-closed, an
 *   unknown tree state is not a safe state to reset away (deliberately unlike
 *   the disk guard, which fails open).
 * - Untracked (`??`) lines are ignored: `opencode.json` or scratch files must
 *   never block a deploy; gitignored paths never reach porcelain anyway.
 * - Clean tree (0 tracked lines) → null (proceed).
 * - Otherwise → a detail naming up to 3 modified paths (`+k more` after that).
 */
export function dirtyGuardDetail(porcelain: string | null): string | null {
  if (porcelain === null) {
    return "prod checkout state unknown (git status failed) — deploy aborted before reset";
  }
  const tracked = porcelain
    .split("\n")
    .filter((l) => l.trim())
    .filter((l) => !l.trim().startsWith("??"))
    .map((l) => l.slice(3));
  if (tracked.length === 0) return null;
  const shown = tracked.slice(0, 3);
  const rest = tracked.length - shown.length;
  const paths = rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
  return `prod checkout dirty: ${tracked.length} tracked file(s) modified (${paths}) — deploy aborted before reset`;
}

// ── Direction guard: a deploy only ever moves production FORWARD ─────────────

/**
 * Pure verdict for the ancestry probe (`git merge-base --is-ancestor <prod>
 * <target>`): the target must be a DESCENDANT of the sha production runs.
 * Production ahead of the target (an unverified direct push landed there, or
 * the verified list lags) must never be reset backward by the deploy path —
 * rolling back is only the explicit quarantine/rollback flow's business.
 * `null` (probe failed) fails closed: unknown ancestry is not safe to reset.
 */
export function directionGuardDetail(prodSha: string, target: string, isAncestor: boolean | null): string | null {
  if (isAncestor === true) return null;
  const pair = `prod ${prodSha.slice(0, 7)} -> target ${target.slice(0, 7)}`;
  if (isAncestor === null) return `ancestry unknown (git merge-base failed) for ${pair} — deploy skipped, prod untouched`;
  return `target is not a descendant of prod HEAD (${pair}) — prod is ahead or diverged; deploy skipped, prod untouched (rollback only via the explicit quarantine/rollback flow)`;
}

// ── P1-021: last-install state — skip npm ci when the lockfile is unchanged ─

/** sha256 hex digest — the package-lock.json hash persisted in last-install.json. */
export const LOCK_HASH_RE = /^[0-9a-f]{64}$/;

export interface LastInstall {
  sha256: string;
  at: string;
}

export function defaultLastInstallFile(): string {
  return join(homedir(), ".opencode-remote", "pilot", "last-install.json");
}

/**
 * Tolerant read: a missing, corrupt or partially-written file (and any record
 * whose hash is not a full sha256 hex digest) yields null — the caller falls
 * back to a full `npm ci`, which is today's behavior. A bad state file must
 * never break the deploy.
 */
export function readLastInstall(file: string): LastInstall | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LastInstall>;
    if (typeof parsed?.sha256 !== "string" || !LOCK_HASH_RE.test(parsed.sha256)) return null;
    return { sha256: parsed.sha256, at: typeof parsed.at === "string" ? parsed.at : "" };
  } catch {
    return null;
  }
}

/**
 * Persist the hash of the lock the last successful install reproduced.
 * Single write (deploys are serial, P1-006), same tolerant pattern as saveState;
 * an invalid hash is rejected so a broken caller can never poison the state.
 */
export function writeLastInstall(file: string, sha256: string, at: string): boolean {
  if (!LOCK_HASH_RE.test(sha256)) return false;
  return writeAll(file, `${JSON.stringify({ sha256, at })}\n`);
}

export type InstallMode = "ci" | "fast";

/**
 * Pure install decision — fail-closed: only an exact match between the
 * current lock hash and the last successfully installed hash runs the fast
 * path; a missing/corrupt state file, a changed lock or an unusable current
 * hash (empty — no lockfile at HEAD) all fall back to a full `npm ci`.
 */
export function installModeFor(currentHash: string, saved: LastInstall | null): InstallMode {
  if (!LOCK_HASH_RE.test(currentHash)) return "ci";
  return saved?.sha256 === currentHash ? "fast" : "ci";
}

// ── Catch-up plan: bounded steps + an explicit list of what ships ────────────

/**
 * A deploy that ships at least this many gate-verified merges is a CATCH-UP:
 * it gets the reinforced soak (deploy.ts) and announces its plan. The 22/09
 * and 24/09 outages both ended with prod 17+ merges behind origin/main — one
 * deploy would have shipped all of them behind a 2-minute soak.
 */
export const CATCHUP_MIN_TASKS = 2;
/**
 * Most verified merges a single step ships while the range is CLEAN (no
 * quarantined sha inside it): a failure then quarantines one step and names
 * at most this many suspects, and every earlier step stays live.
 */
export const CATCHUP_STEP_TASKS = 4;
/** Soak floor (minutes) for a catch-up deploy — 10 checks, so the reinforced
 * lane's live-invariant reruns (every 5th check) and rate window both engage. */
export const CATCHUP_SOAK_MIN = 10;
/** Cap on the first-parent walk from origin/<base> down to prod. */
export const MAX_PLAN_COMMITS = 500;

export interface DeployPlan {
  /** Sha production runs (pre-deploy HEAD). */
  prod: string;
  /** Newest deployable sha (the legacy single-jump target); null = nothing deployable. */
  newest: string | null;
  /** This deploy's target: `newest`, or the last merge of a bounded step. */
  target: string | null;
  /** Verified, non-quarantined merges between prod (excl.) and `newest`
   * (incl.), oldest first — everything still to ship. */
  pending: VerifiedMerge[];
  /** Slice of `pending` this deploy ships (oldest first, ends at `target`). */
  step: VerifiedMerge[];
  /** Quarantined shas inside the range: never a target, but their code rides
   * along in every descendant (a later merge supersedes, P2-058). */
  skipped: QuarantinedSha[];
  /** True when `step` stops short of `newest` (bounded catch-up step). */
  stepped: boolean;
  /** False when prod is not on the walked first-parent history (operator
   * reset, diverged prod): the plan falls back to the legacy newest target
   * and the direction guard has the last word. */
  anchored: boolean;
}

/**
 * Pure plan for the next deploy. `history` is origin/<base>'s first-parent
 * history, newest first (object ids; anything else is skipped, P1-060).
 * `newest` keeps pickDeployableSha's exact semantics. When prod sits on that
 * history, everything between them is enumerated and, while the range carries
 * no quarantined sha, a large range ships in bounded oldest-first steps of
 * `stepTasks` merges. A range that already holds a failure (quarantined sha)
 * targets `newest` directly — the fix-forward rule: every later step would
 * carry the failed change anyway, and only the newest merge can carry its fix.
 */
export function planDeploy(
  history: string[],
  prod: string,
  verified: VerifiedMerge[],
  quarantine: QuarantinedSha[],
  stepTasks = CATCHUP_STEP_TASKS,
): DeployPlan {
  const newest = pickDeployableSha(history, verified, quarantine);
  const base: DeployPlan = { prod, newest, target: newest, pending: [], step: [], skipped: [], stepped: false, anchored: false };
  if (!newest || !SHA_RE.test(prod)) return base;
  const walked = history.slice(0, MAX_PLAN_COMMITS);
  const prodAt = walked.findIndex((sha) => sha === prod || (sha.startsWith(prod) && prod.length >= 7));
  const newestAt = walked.indexOf(newest);
  if (prodAt < 0) return base;
  if (newestAt < 0 || newestAt >= prodAt) {
    // prod already at/after the newest deployable sha — nothing to ship
    return { ...base, target: null, anchored: true };
  }
  const byVerified = new Map(verified.map((v) => [v.sha, v]));
  const byQuarantine = new Map(quarantine.map((q) => [q.sha, q]));
  const pending: VerifiedMerge[] = [];
  const skipped: QuarantinedSha[] = [];
  // oldest first: from just above prod up to (and including) newest
  for (let i = prodAt - 1; i >= newestAt; i--) {
    const sha = walked[i]!;
    if (!SHA_RE.test(sha)) continue;
    const q = byQuarantine.get(sha);
    if (q) {
      skipped.push(q);
      continue;
    }
    const v = byVerified.get(sha);
    if (v) pending.push(v);
  }
  const size = Math.max(1, Math.floor(stepTasks));
  const stepped = skipped.length === 0 && pending.length > size;
  const step = stepped ? pending.slice(0, size) : pending;
  return {
    prod,
    newest,
    target: step.at(-1)?.sha ?? newest,
    pending,
    step,
    skipped,
    stepped,
    anchored: true,
  };
}

/** Ids of a merge list, bounded for single-line log/event text. */
export function planTaskIds(merges: VerifiedMerge[], max = 12): string {
  const ids = merges.map((m) => m.task || m.sha.slice(0, 7));
  return ids.length > max ? `${ids.slice(0, max).join(", ")} +${ids.length - max} more` : ids.join(", ");
}

/**
 * One-line, human summary of what a deploy ships — the explicit "what is
 * going live" record the catch-up announces (log, event, supervisor notify).
 */
export function planSummary(plan: DeployPlan): string {
  const target = plan.target?.slice(0, 7) ?? "none";
  const from = plan.prod.slice(0, 7);
  if (!plan.anchored) return `deploy ${from} → ${target}: prod not on origin first-parent history — single jump, contents not enumerated`;
  if (!plan.target) return `prod ${from} is current — nothing verified to ship`;
  const remaining = plan.pending.length - plan.step.length;
  const head = plan.stepped
    ? `catch-up step: ${plan.step.length} of ${plan.pending.length} verified merges (${from} → ${target}), ${remaining} remain after this step`
    : `deploy ${from} → ${target}: ${plan.step.length} verified merge(s)`;
  const ships = plan.step.length ? ` — ships ${planTaskIds(plan.step)}` : "";
  const riders = plan.skipped.length ? ` — carries ${plan.skipped.length} quarantined merge(s): ${plan.skipped.map((q) => q.task || q.sha.slice(0, 7)).join(", ")}` : "";
  return `${head}${ships}${riders}`;
}
