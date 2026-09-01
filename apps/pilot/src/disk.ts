import { statfs } from "node:fs/promises";

/**
 * P3-006: a full disk once killed the pilot with a cryptic `git index.lock`
 * error. Deploys must abort with a clear message when free space is below
 * this ceiling (5GB — enough for npm ci + build + git objects).
 */
export const DISK_MIN_FREE_BYTES = 5 * 1024 ** 3;

export function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/**
 * Free bytes on the filesystem holding `path`, available to unprivileged users
 * (statfs bavail × bsize). Null when statfs is unavailable — fail-open, so an
 * exotic filesystem never blocks a healthy deploy.
 */
export async function freeDiskBytes(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * Pure guard decision: null = proceed; string = the abort detail, which starts
 * with "disk low: Xgb free" — the exact phrase the supervisor notification
 * carries (P3-006).
 */
export function diskGuardDetail(freeBytes: number | null, thresholdBytes: number): string | null {
  if (freeBytes === null || freeBytes >= thresholdBytes) return null;
  return `disk low: ${formatGb(freeBytes)}gb free (need ${formatGb(thresholdBytes)}gb) — deploy aborted before npm ci/build`;
}
