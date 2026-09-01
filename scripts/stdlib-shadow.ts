/**
 * Module-shadowing defense (P2-014) — defense in depth for the self-evolving loop.
 *
 * Agent-hijack chains (RCE in Auto Mode, embracethered.com 26/08/2026) work by
 * making the agent extract an untrusted archive and run code inside it: a
 * root-level struct.py/os.py/... then shadows the Python runtime's stdlib for
 * every subsequent interpreter started in the workspace. This module parses a
 * `git diff --name-status` merge diff and returns introduced root-level files
 * whose names collide with runtime stdlib modules. No dependencies.
 */

/** Runtime-stdlib module names (hardcoded, deliberately small). */
export const STDLIB_SHADOW_FILES = [
  "struct.py",
  "os.py",
  "base64.py",
  "json.py",
  "types.py",
  "random.py",
] as const;

/**
 * Given the output of `git diff --name-status <base>...HEAD`, return the
 * introduced (added/renamed/copied) files that sit at the workspace ROOT and
 * shadow a runtime stdlib module, e.g. ["struct.py"].
 *
 * Only statuses A (added), R (renamed) and C (copied) introduce a path; the
 * new path of a rename/copy is the last field. Deleted/modified paths already
 * live in the base ref, so they cannot be an introduction. Subdirectory paths
 * never match (shadowing requires the workspace root on the import path).
 */
export function stdlibShadowHits(nameStatusDiff: string): string[] {
  const hits: string[] = [];
  for (const rawLine of nameStatusDiff.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const status = line.slice(0, tab);
    if (!/^[ARC]/.test(status)) continue;
    const paths = line.slice(tab + 1).split("\t");
    const introduced = status[0] === "A" ? paths[0] : paths[paths.length - 1];
    if (!introduced || introduced.includes("/")) continue;
    if (STDLIB_SHADOW_FILES.some((n) => n === introduced.toLowerCase())) hits.push(introduced);
  }
  return hits;
}
