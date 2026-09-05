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
