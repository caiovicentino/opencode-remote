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
 * offline and eval-testable; it is written by deterministic code under the
 * cross-slot gate lock, never by an agent.
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
 * The caller (gatekeeper) runs under the cross-slot gate lock, so appends
 * never interleave.
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
