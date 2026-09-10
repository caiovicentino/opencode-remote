/**
 * Foreign mission repo helpers — pure, io-injected (the battery pins them
 * without a network).
 *
 * The pilot pins a local `main` in the mission clone from the remote's
 * DEFAULT branch. The old `git checkout -B main origin/main` failed silently
 * on master-default repos (allowFail) and every later step then failed with
 * unrelated-looking errors. The default branch is read offline from the
 * clone's own `refs/remotes/origin/HEAD` (set by git clone), then from
 * `git remote show origin` (network), then assumed `main`.
 *
 * P3-358: the boot path itself (clone + default-branch pin + `mission loaded`
 * log + cfg wiring) lives HERE, not in the dispatcher — index.ts runs main()
 * on import, so the battery can only execute the real boot through these
 * exported functions.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { exec } from "./runner";
import { emit } from "./events";
import { nowLocalISO } from "./log";
import { missionDetail, type MissionSpec } from "./mission";
import type { PilotConfig } from "./state";

export interface RepoIo {
  exec: (cmd: string) => { ok: boolean; output: string };
}

export const DEFAULT_BRANCH_FALLBACK = "main";

/** Branch-name charset accepted from a probe (it is interpolated into a git command). */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function validBranch(name: string): string | null {
  const b = name.trim();
  return BRANCH_RE.test(b) && !b.endsWith("/") && !b.includes("..") ? b : null;
}

/** `git symbolic-ref -q --short refs/remotes/origin/HEAD` → `origin/master` → `master`. */
export function parseSymbolicHead(output: string): string | null {
  const line = output.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return null;
  const short = line.replace(/^refs\/remotes\//, "").replace(/^origin\//, "");
  return short === line ? null : validBranch(short);
}

/** `git remote show origin` → the `HEAD branch: <name>` line. */
export function parseRemoteShowHead(output: string): string | null {
  const m = /^\s*HEAD branch:\s*(\S+)\s*$/m.exec(output);
  if (!m?.[1] || m[1] === "(unknown)") return null;
  return validBranch(m[1]);
}

export interface DefaultBranch {
  branch: string;
  source: "symbolic-ref" | "remote-show" | "fallback";
}

/** The remote's default branch, offline first, network second, `main` last. */
export function detectDefaultBranch(io: RepoIo): DefaultBranch {
  const sym = io.exec("git symbolic-ref -q --short refs/remotes/origin/HEAD");
  const fromSym = sym.ok ? parseSymbolicHead(sym.output) : null;
  if (fromSym) return { branch: fromSym, source: "symbolic-ref" };
  const show = io.exec("git remote show origin");
  const fromShow = show.ok ? parseRemoteShowHead(show.output) : null;
  if (fromShow) return { branch: fromShow, source: "remote-show" };
  return { branch: DEFAULT_BRANCH_FALLBACK, source: "fallback" };
}

/**
 * P3-358: the base branch every pipeline read/write targets (`origin/<base>`):
 * the detected default branch when it passes the branch charset, `main`
 * otherwise. The single validator for base-branch values reaching shell
 * commands — callers never interpolate a raw probe output.
 */
export function pipelineBaseBranch(branch: string | undefined | null): string {
  return branch && validBranch(branch) ? branch : DEFAULT_BRANCH_FALLBACK;
}

// ── P3-358: the mission-boot path, executable by the battery ─────────────────

/** JSON log line — the exact shape the dispatcher logs with. */
function logLine(level: string, msg: string, data?: unknown): void {
  console.log(JSON.stringify({ ts: nowLocalISO(), level, msg, data }));
}

/** POSIX single-quote shell escape (same contract as metapush/runner). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface MissionRepoResult {
  dir: string;
  defaultBranch: string;
}

/** Base dir of the mission clones (per-mission state lives beside them). */
export function missionRoot(): string {
  return join(homedir(), ".opencode-remote", "pilot", "mission");
}

/**
 * Self-serve mission on a foreign repo (moved verbatim from the dispatcher):
 * clone it once under <root>/<key>/repo and refresh it on every boot. Slot
 * worktrees are then derived from this clone exactly like they are from the
 * production checkout, so the whole pipeline — builders, reviewers, judge —
 * runs against the target repo. Returns the clone dir AND the remote's
 * default branch — since P3-358 it is the pipeline base branch
 * (`origin/<base>` everywhere), not just a pin source. `root` is injectable
 * so the battery exercises this real function against fixture origins.
 */
export function ensureMissionRepo(repoUrl: string, key: string, root = missionRoot()): MissionRepoResult {
  const dir = join(root, key, "repo");
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    const clone = exec(`git clone ${shq(repoUrl)} ${shq(dir)}`, { cwd: dirname(dir), timeoutMin: 10, allowFail: true });
    if (!clone.ok) {
      rmSync(dir, { recursive: true, force: true }); // partial clone would block the retry
      logLine("error", "mission repo clone failed", { repoUrl, tail: clone.output.slice(-300) });
      throw new Error(`mission repo clone failed (${repoUrl}): ${clone.output.slice(-300)}`);
    }
    logLine("info", "mission repo cloned", { repoUrl, dir });
  } else {
    exec("git fetch -q origin", { cwd: dir, allowFail: true });
  }
  // Pin a local `main` from the remote's ACTUAL default branch (main on most
  // repos, master on older ones — read from origin/HEAD, never assumed). The
  // old `checkout -B main origin/main` failed silently on master-default
  // repos and every later step then failed with unrelated-looking errors.
  const def = detectDefaultBranch({ exec: (cmd) => exec(cmd, { cwd: dir, allowFail: true }) });
  const pin = exec(`git checkout -q -B main ${shq(`origin/${def.branch}`)}`, { cwd: dir, allowFail: true });
  if (!pin.ok) {
    logLine("error", "mission repo: cannot pin main to the default branch", { repoUrl, defaultBranch: def.branch, source: def.source, tail: pin.output.slice(-200) });
    emit("phase", { task: "mission", phase: "default-branch", ok: false, detail: `cannot pin main to origin/${def.branch}` });
  } else if (def.branch !== "main") {
    // P3-358: no longer a limitation — the detected branch IS the pipeline
    // base branch (cfg.baseBranch threads it through queue reads, task
    // branches, meta landings and merges). Logged loudly so the shape stays
    // visible in the boot record.
    logLine("info", "mission repo default branch pinned — pipeline base branch parameterized", { repoUrl, defaultBranch: def.branch, source: def.source });
    emit("phase", { task: "mission", phase: "default-branch", ok: true, detail: `pipeline base branch: ${def.branch} (origin/HEAD)` });
  } else {
    logLine("info", "mission repo default branch", { repoUrl, defaultBranch: def.branch, source: def.source });
  }
  // A target repo without a pilot-format BACKLOG.md is normal on first
  // contact: the researcher/strategist seed the skeleton locally (never pushed
  // by themselves) and land it inside their first guarded PR. (Same predicate
  // as backlog.ts's needsBacklogSkeleton — not imported here because backlog
  // → metapush → missionrepo would close an import cycle; the battery pins
  // the two in agreement.)
  const md = exec(`git show ${shq(`origin/${def.branch}`)}:BACKLOG.md`, { cwd: dir, allowFail: true });
  if (backlogSkeletonNeeded(md.ok ? md.output : null)) {
    logLine("info", "mission repo has no BACKLOG.md in the pilot format — the first aux landing seeds it (via PR)");
    emit("phase", { task: "mission", phase: "backlog", ok: true, detail: "no pilot-format BACKLOG.md yet — first aux PR seeds it" });
  }
  return { dir, defaultBranch: def.branch };
}

/**
 * missionrepo's copy of backlog.ts's needsBacklogSkeleton (true when there is
 * no file content or no `## Ready` section). NOT imported from backlog.ts
 * because backlog → metapush → missionrepo would close an import cycle — the
 * unit battery pins the two predicates in agreement so they cannot drift.
 */
export function backlogSkeletonNeeded(md: string | null | undefined): boolean {
  return typeof md !== "string" || !/^## Ready$/m.test(md);
}

/**
 * The boot's "mission loaded" record — the exact log line + phase event the
 * dispatcher emits when mission.json parsed. Extracted so the battery asserts
 * the REAL line instead of grepping the source for it.
 */export function logMissionLoaded(mission: MissionSpec): void {
  logLine("info", "mission loaded", { repoUrl: mission.repoUrl, prompt: mission.prompt?.slice(0, 160), models: mission.models, setAt: mission.setAt });
  emit("phase", { task: "mission", phase: "loaded", ok: true, detail: missionDetail(mission) });
}

/**
 * The foreign-repo boot wiring (index.ts main()): swap the working repo to
 * the mission clone and derive the pipeline base branch from the origin/HEAD
 * detection. `key` is the caller-computed missionWorkspaceKey(mission) — the
 * dispatcher already needs it for the per-mission state root. `root` is
 * injectable for the battery (fixture origins, no $HOME writes).
 */
export function bootMissionRepo(repoUrl: string, key: string, cfg: PilotConfig, root = missionRoot()): MissionRepoResult {
  const mr = ensureMissionRepo(repoUrl, key, root);
  cfg.repo = mr.dir;
  cfg.baseBranch = pipelineBaseBranch(mr.defaultBranch);
  return mr;
}
