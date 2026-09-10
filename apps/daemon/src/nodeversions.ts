// P3-395: enumerates the node version directories that runtime managers
// (nvm, mise) keep on this machine, so the daemon can find an opencode
// installed under one of them even when the app was launched by Finder with
// the minimal inherited PATH. Pure module — zero imports, the readdir
// callback is injected by the caller (index.ts wires the real fs.readdirSync
// inside its own try/catch, same all-I/O-stays-with-the-caller pattern as
// opencodebin.ts).
//
// Fail-tolerant by contract: a missing directory, a permission error or a
// hostile directory listing never throws and never contributes garbage — the
// offending manager simply contributes nothing, and an enumeration that finds
// nothing legible returns an empty list (which leaves the daemon's candidate
// list exactly as it was without this feature).

/** Maximum number of node version directories returned, across all managers.
 * Each entry costs one accessSync probe per resolution, so the cap keeps the
 * probe bounded no matter how many versions a machine has accumulated. */
export const NODE_VERSION_DIR_CAP = 12;

/** A node version directory name: non-empty, no path separators, not a
 * dotfile. Accepts "v20.11.0", "20.11.0" and "v22.6.0-nightly"; rejects "",
 * ".", "..", ".DS_Store", "has space" and any join/escape attempt. */
const VERSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export interface NodeVersionDirsDeps {
  platform: string;
  home: string;
  env: Record<string, string | undefined>;
  /** Injected directory listing; throws when the directory is missing,
   * unreadable or otherwise unusable. */
  readdir: (dir: string) => string[];
  /** Override for the cap (tests); defaults to NODE_VERSION_DIR_CAP. */
  cap?: number;
}

/** Version-directory roots per manager, in the documented order: nvm first,
 * then mise. nvm-windows honors NVM_HOME; the rest are the default layouts. */
function rootsFor(
  platform: string,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === "win32") {
    const nvmHome = env.NVM_HOME?.trim();
    return [
      nvmHome || `${home}\\AppData\\Roaming\\nvm`,
      `${home}\\AppData\\Local\\mise\\installs\\node`,
    ];
  }
  return [`${home}/.nvm/versions/node`, `${home}/.local/share/mise/installs/node`];
}

/**
 * List the node version directories the two managers expose, deterministic
 * per (platform, home, env, directory contents): nvm versions first (sorted
 * ascending), then mise's, each root contributing at most until the shared
 * cap is reached. Missing or unreadable roots are skipped; the function never
 * throws. The result feeds opencodeCandidates' nodeVersionDirs parameter —
 * version directories, not bin paths (opencodebin.ts knows the layout).
 */
export function enumerateNodeVersionDirs(deps: NodeVersionDirsDeps): string[] {
  const { platform, home, env, readdir } = deps;
  const cap = Math.max(0, deps.cap ?? NODE_VERSION_DIR_CAP);
  const dirs: string[] = [];
  try {
    const sep = platform === "win32" ? "\\" : "/";
    for (const root of rootsFor(platform, home, env)) {
      if (dirs.length >= cap) break;
      let names: string[];
      try {
        names = readdir(root);
      } catch {
        continue; // absent manager, EACCES, whatever — this root adds nothing
      }
      if (!Array.isArray(names)) continue;
      const valid = names.filter((n) => typeof n === "string" && VERSION_NAME.test(n));
      valid.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const name of valid) {
        if (dirs.length >= cap) break;
        dirs.push(`${root}${sep}${name}`);
      }
    }
    return dirs;
  } catch {
    return dirs; // enumeration must never be the reason a boot probe throws
  }
}
