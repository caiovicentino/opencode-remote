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
 */

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
