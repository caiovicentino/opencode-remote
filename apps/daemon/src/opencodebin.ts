// P2-149: pure opencode-binary resolution for the daemon. Deliberately free of
// fs/child_process/path/os imports and of any network call — index.ts runs
// main() on import, so unit tests must never boot a daemon (same pattern as
// relayurl.ts / upstream.ts). Paths are joined by string concatenation instead
// of the platform path helper so the candidate list is deterministic on any
// host; all I/O stays with the caller (P2-065 lesson).

/** Where a picked binary came from: a PATH entry ("path") or a known install
 * location ("known"). */
export type OpencodeBinarySource = "path" | "known";

export interface OpencodeCandidate {
  path: string;
  source: OpencodeBinarySource;
}

export interface OpencodeBinaryPick {
  /** Absolute path of the chosen binary; null when nothing is executable. */
  path: string | null;
  /** Origin of the pick; null when nothing is executable. */
  source: OpencodeBinarySource | null;
}

const POSIX_NAME = "opencode";
const WIN_NAME = "opencode.exe";

function isAbsolutePath(p: string, platform: string): boolean {
  if (platform === "win32") return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
  return p.startsWith("/");
}

/** Join a directory with the platform binary name, normalizing trailing
 * separators away ("/usr/local/bin/" and "C:\\bin\\" both collapse) so no
 * candidate ever carries a doubled separator. */
function joinBin(dir: string, platform: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const sep = platform === "win32" ? "\\" : "/";
  return `${trimmed}${sep}${platform === "win32" ? WIN_NAME : POSIX_NAME}`;
}

function push(
  list: OpencodeCandidate[],
  seen: Set<string>,
  dir: string,
  source: OpencodeBinarySource,
  platform: string,
): void {
  const p = joinBin(dir, platform);
  if (!p || !isAbsolutePath(p, platform) || seen.has(p)) return;
  seen.add(p);
  list.push({ path: p, source });
}

/**
 * Deterministic, deduplicated candidate list for the opencode binary: every
 * absolute PATH entry first (source "path", `:`-separated on posix and
 * `;`-separated on win32), then the known install locations (source "known") —
 * posix: ~/.opencode/bin, /opt/homebrew/bin, /usr/local/bin; win32:
 * opencode.exe under LOCALAPPDATA and under Program Files (the latter
 * defaulting to "C:\Program Files"). Empty, relative or missing entries are
 * dropped; a directory present in both PATH and the known list appears once,
 * with the PATH occurrence winning. The list is never undefined.
 */
export function opencodeCandidates(
  env: Record<string, string | undefined>,
  platform: string,
  home: string,
): OpencodeCandidate[] {
  const list: OpencodeCandidate[] = [];
  const seen = new Set<string>();
  const win = platform === "win32";

  const pathVar = env.PATH ?? env.Path;
  if (pathVar) {
    for (const dir of pathVar.split(win ? ";" : ":")) {
      push(list, seen, dir, "path", platform);
    }
  }

  if (win) {
    if (env.LOCALAPPDATA) push(list, seen, `${env.LOCALAPPDATA}\\opencode\\bin`, "known", platform);
    push(list, seen, `${env.ProgramFiles ?? "C:\\Program Files"}\\opencode`, "known", platform);
  } else {
    push(list, seen, `${home}/.opencode/bin`, "known", platform);
    push(list, seen, "/opt/homebrew/bin", "known", platform);
    push(list, seen, "/usr/local/bin", "known", platform);
  }

  return list;
}

/**
 * First candidate whose injected isExecutable says yes wins; a throwing check
 * counts as "not this one" (try/catch per candidate — the probe must never
 * break because of binary resolution). Returns {null, null} when no candidate
 * is executable.
 */
export function pickOpencodeBinary(
  candidates: OpencodeCandidate[],
  isExecutable: (p: string) => boolean,
): OpencodeBinaryPick {
  for (const c of candidates) {
    try {
      if (isExecutable(c.path)) return { path: c.path, source: c.source };
    } catch {
      // treat EACCES/EPERM-style surprises as "not this one" and move on
    }
  }
  return { path: null, source: null };
}
