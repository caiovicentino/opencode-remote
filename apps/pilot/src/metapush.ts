import { exec } from "./runner";
import { basename } from "node:path";

/**
 * P1-076 — meta commits land via the long-lived `pilot/meta` branch + auto-merge
 * PR, never via direct pushes to main. Every bookkeeping flow (backlog refills,
 * scribe lessons, mark-done, corpus growth, explorer findings, circuit breaker)
 * re-bases `pilot/meta` on origin/main, applies its deterministic edit, pushes
 * with a lease and arms the squash PR — success is only reported after the
 * squash merge is confirmed on GitHub and our commit is verified to still be
 * in the PR head. A hostile deviation can therefore no longer
 * camouflage itself inside a trusted bookkeeping push: branch protection on
 * `main` rejects everything that did not travel through a PR (operator runbook
 * in docs/PILOT.md).
 */

export const META_BRANCH = "pilot/meta";

/**
 * Push guard (P1-057): an aux flow may only ever push a diff whose name-only
 * file list is EXACTLY the one allowed path (BACKLOG.md for task lines,
 * docs/EXPERIENCE.md for lessons). Anything else — leftover artifacts, agent
 * tampering — refuses the push.
 */
export function mayPush(nameOnlyOutput: string, allowed: string): boolean {
  const files = nameOnlyOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return files.length === 1 && files[0] === allowed;
}

/**
 * Prefix guard for flows that legitimately touch several files inside one
 * directory (the golden corpus grows up to three samples per capture). Every
 * changed file must live under `dir`, at least one file must change, and —
 * when provided — the per-landing file count is capped at `maxFiles` and every
 * BASENAME must match `fileName` (the corpus sample shape `<seq>-<label>.txt`,
 * written by appendCorpusSample). Without a cap/pattern this guard is the one
 * path that would carry arbitrary planted workspace files into main.
 */
export function mayPushUnderDir(
  nameOnlyOutput: string,
  dir: string,
  opts: { maxFiles?: number; fileName?: RegExp } = {},
): boolean {
  const files = nameOnlyOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (files.length === 0 || !files.every((f) => f.startsWith(`${dir}/`))) return false;
  if (opts.maxFiles !== undefined && files.length > opts.maxFiles) return false;
  if (opts.fileName && !files.every((f) => opts.fileName!.test(basename(f)))) return false;
  return true;
}

/** Injectable sinks for landMetaCommit (unit battery pins the semantics). */
export interface MetaPushIo {
  exec: (cmd: string) => { ok: boolean; output: string };
  sleep: (ms: number) => Promise<void>;
}

/** Real-filesystem IO for landMetaCommit (fakes are used in the unit battery). */
export function metaIo(cwd: string): MetaPushIo {
  return {
    exec: (cmd) => exec(cmd, { cwd, allowFail: true }),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

export type MetaPushResult = "pushed" | "refused" | "failed";

/**
 * Outcome of the caller's deterministic edit, re-applied on every attempt
 * (the `checkout -B` rewind wipes previous attempts' edits):
 * - `apply`:  proceed to add/commit/guard/push (`message` overrides the
 *   default when the edit itself decides the subject, e.g. corpus counts)
 * - `noop`:   nothing to land — reported as success (already the end state)
 * - `abort`:  nothing to land and that is a failure — reported as `failed`
 */
export type MetaApplyResult =
  | { action: "apply"; message?: string }
  | { action: "noop" }
  | { action: "abort" };

export interface MetaCommitSpec {
  /** Paths handed to `git add` (directories allowed). */
  files: string[];
  /** Default commit subject; the apply callback may override per attempt. */
  message: string;
  /** Exact single-file allowlist (P1-057) — exactly one of guardFile/guard. */
  guardFile?: string;
  /** Custom diff guard (e.g. mayPushUnderDir for the corpus). */
  guard?: (nameOnlyOutput: string) => boolean;
  /** Deterministic edit, run after the branch is re-based on origin/main. */
  apply: (ws: string) => MetaApplyResult;
}

/** POSIX single-quote shell escape (JSON.stringify is NOT shell quoting). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Find an OPEN PR for pilot/meta, else create the long-lived one. */
function openMetaPr(io: MetaPushIo): boolean {
  const view = io.exec(`gh pr view ${META_BRANCH} --json state,url`);
  let state = "";
  try {
    state = JSON.parse(view.output)?.state ?? "";
  } catch {}
  if (view.ok && state === "OPEN") return true;
  return io.exec(
    `gh pr create --head ${META_BRANCH} --base main --title "pilot: meta commits" --body ${shq(
      "Bookkeeping landings (backlog refills, scribe lessons, mark-done, corpus samples). Auto-merged when the light checks pass.",
    )}`,
  ).ok;
}

/** Bounded confirmation budget: ~30s per landing call. */
const MERGE_CONFIRM_POLLS = 6;
const MERGE_CONFIRM_DELAY_MS = 5_000;

/**
 * Arm the squash merge of the meta PR and CONFIRM it landed. NEVER
 * --delete-branch: pilot/meta is long-lived.
 */
async function armMetaPr(io: MetaPushIo): Promise<MetaPushResult> {
  if (!openMetaPr(io)) return "failed";
  // --auto only works once branch protection exists (operator runbook); the
  // immediate squash keeps landings moving while protection is still off.
  const armed =
    io.exec(`gh pr merge ${META_BRANCH} --squash --auto`).ok ||
    io.exec(`gh pr merge ${META_BRANCH} --squash`).ok;
  if (!armed) return "failed";
  // R4 review (arm-vs-merge TOCTOU): --auto only QUEUES the merge — reporting
  // success here would let callers clear their state (e.g. the P1-037 pending
  // refill store) before the content actually landed on main. Poll the PR
  // state until GitHub confirms the squash; an unconfirmed landing is an
  // honest failure whose next-cycle retry is a noop once the queued merge
  // lands (the caller's edit is deterministic and idempotent).
  for (let poll = 0; poll < MERGE_CONFIRM_POLLS; poll++) {
    if (poll > 0) await io.sleep(MERGE_CONFIRM_DELAY_MS);
    const view = io.exec(`gh pr view ${META_BRANCH} --json state`);
    try {
      if (JSON.parse(view.output)?.state === "MERGED") return "pushed";
    } catch {}
  }
  return "failed";
}

/**
 * Deterministic meta landing (P1-076): fetch → re-base `pilot/meta` on
 * origin/main → apply the caller's edit → commit → push guard → push →
 * auto-merge PR, retried up to `attempts` times because concurrent slots move
 * origin/main (and the shared meta branch) underneath us. The push is
 * --force-with-lease (a peer landing pushed after our fetch fails instead of
 * being overwritten) and success is only reported when BOTH verifications
 * hold: our commit is still an ancestor of origin/pilot/meta, and GitHub
 * confirmed the squash merge into main. Anything unverifiable fails closed —
 * it is retried and, at worst, honestly reported as "failed". The guard is
 * re-read from the actual branch diff on every attempt; a refused diff never
 * pushes. There is deliberately NO fallback to `git push origin main`: if gh
 * is unavailable the commit stays on origin/pilot/meta and the next cycle
 * retries.
 */
export async function landMetaCommit(
  ws: string,
  io: MetaPushIo,
  spec: MetaCommitSpec,
  attempts = 3,
): Promise<MetaPushResult> {
  const guard = spec.guard ?? ((names: string) => mayPush(names, spec.guardFile ?? ""));
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      io.exec("git fetch -q origin");
      // discard any dirty state first: checkout -B with a start point refuses
      // on a dirty tree, and the slot worktree may arrive on any branch
      io.exec("git reset -q --hard HEAD");
      io.exec("git clean -qfd");
      if (!io.exec(`git checkout -q -B ${META_BRANCH} origin/main`).ok) {
        await io.sleep(3_000);
        continue;
      }
      let applied: MetaApplyResult;
      try {
        applied = spec.apply(ws);
      } catch {
        // the caller's edit is best-effort (fs hiccups must not crash the loop)
        await io.sleep(3_000);
        continue;
      }
      if (applied.action === "abort") return "failed";
      if (applied.action === "noop") return "pushed";
      const commit = io.exec(
        `git add ${spec.files.map(shq).join(" ")} && git commit -qm ${shq(applied.message ?? spec.message)}`,
      );
      if (!commit.ok) {
        await io.sleep(3_000);
        continue;
      }
      const names = io.exec("git diff --name-only origin/main...HEAD");
      if (!guard(names.output)) return "refused";
      // --force-with-lease: the rewind to main is deliberate (the PR head is
      // always exactly main + this commit), but a peer landing that pushed
      // after our fetch fails this push instead of being silently overwritten
      if (!io.exec(`git push -q --force-with-lease origin HEAD:${META_BRANCH}`).ok) {
        await io.sleep(3_000);
        continue;
      }
      // R4 review: two fail-closed verifications before "pushed" may be
      // reported. (1) our commit must still be in the PR head — a concurrent
      // landing that rewound the shared branch would otherwise be reported as
      // our success while our content was dropped; (2) the squash merge must
      // be CONFIRMED by GitHub before callers clear their state. An empty or
      // malformed sha is undeterminable verification, never a pass: retry.
      const pushedSha = io.exec("git rev-parse HEAD").output.trim();
      if (!/^[0-9a-f]{40}$/.test(pushedSha)) {
        await io.sleep(3_000);
        continue;
      }
      io.exec("git fetch -q origin");
      if (!io.exec(`git merge-base --is-ancestor ${shq(pushedSha)} origin/${META_BRANCH}`).ok) {
        await io.sleep(3_000);
        continue;
      }
      return await armMetaPr(io);
    }
    return "failed";
  } finally {
    // never leave the worktree parked on pilot/meta
    io.exec("git checkout -q main");
  }
}
