/**
 * P2-208: pure layout math for the packaged-boot smoke (release gate — NOT the
 * pilot gate, docs/PILOT.md). Deliberately NO I/O here — no filesystem, OS or
 * network imports at all, no disk access of any kind (same rule as
 * packaged-boot-verdict.mjs and the P2-194 helper modules): scripts/unit.test.ts imports this file directly and must
 * never touch the filesystem, and the module must reason about Windows paths
 * on any host OS.
 *
 * candidatePaths(packagePath, platform) answers "where should the runnable
 * binary be?" WITHOUT looking at the disk. resolveExecutable() in
 * packaged-boot.mjs consumes the list, keeps its executable-file fallback and
 * stays the ONLY disk-touching point of the boot smoke.
 */

const EXEC_SUFFIX = ".exe";
const SEPARATORS = /[/\\]/;

/** Last path segment (after the final / or \), ignoring trailing separators. */
function splitPath(path) {
  const root = path.replace(/[/\\]+$/, "");
  const at = Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\"));
  return { root, base: root.slice(at + 1) };
}

/** A stem we append to the received root — never climb out of it. */
function safeStem(name) {
  return name !== "" && name !== "." && name !== ".." ? name : null;
}

/**
 * Ordered candidate paths for the runnable executable of a packaged app:
 *
 *   darwin  <pkg>/Contents/MacOS/<pkg name without the .app suffix>
 *   win32   the path itself when it already ends in .exe; otherwise, for a
 *           packaging output directory, the same-name executable inside it
 *           (<dir>/<dir basename>.exe)
 *
 * Unknown platforms (and nullish/empty inputs) yield an empty list. No
 * candidate ever climbs out of the received root: stems that would traverse
 * (".", "..", empty) are refused, so the worst case is "no candidate", never
 * an escape.
 */
export function candidatePaths(packagePath, platform) {
  if (typeof packagePath !== "string" || typeof platform !== "string") return [];
  if (packagePath.trim() === "") return [];

  if (platform === "darwin") {
    const { root, base } = splitPath(packagePath.trim());
    const stem = safeStem(base.replace(/\.app$/i, ""));
    return stem ? [`${root}/Contents/MacOS/${stem}`] : [];
  }

  if (platform === "win32") {
    const { root, base } = splitPath(packagePath.trim());
    if (base.toLowerCase().endsWith(EXEC_SUFFIX)) return [packagePath.trim()];
    const stem = safeStem(base);
    if (!stem) return [];
    // Mirror the caller's separator style so the candidate reads as part of
    // the received path (backslash input → backslash candidate).
    const sep = root.includes("\\") ? "\\" : "/";
    return [`${root}${sep}${stem}${EXEC_SUFFIX}`];
  }

  return [];
}

/**
 * P3-343: whether one scanned directory entry counts as the packaged app's
 * runnable binary. Platform comes in explicitly so the rule stays testable
 * from any host. On win32 the exec mode bits are worthless — libuv never sets
 * them in st_mode (fs__stat_assign_statbuf only applies _S_IREAD/_S_IWRITE,
 * see the "Todo: st_mode should probably always be 0666" note in
 * libuv/src/win/fs.c), which is exactly why the desktop-package-win smoke
 * reported binary-missing while the .exe sat right there — so the only
 * reliable signal is the .exe suffix, case-insensitive (the same rule
 * dist-smoke.mjs already applies). Everywhere else the Unix exec bits decide
 * and a .exe suffix alone is never enough.
 */
export function isExecutableEntry(name, mode, platform) {
  if (typeof name !== "string" || name === "") return false;
  if (platform === "win32") return name.toLowerCase().endsWith(EXEC_SUFFIX);
  return typeof mode === "number" && (mode & 0o111) !== 0;
}
