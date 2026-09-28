import { statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";

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

/**
 * eval-02: ENOSPC-class failure — the write failed because the volume (or the
 * user's quota) is full, not because of anything the caller did. Node fs errors
 * carry `code`; child-process failures (git's "Unable to create
 * '.../index.lock': No space left on device", npm) only carry the text, so the
 * canonical phrases are matched too.
 */
export function isDiskFullError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  const text = err instanceof Error ? err.message : String(err);
  return /\bENOSPC\b|No space left on device|\bEDQUOT\b|Disk quota exceeded/i.test(text);
}

/** A volume the fleet writes to, named for logs/alerts. */
export interface VolumeProbe {
  label: string;
  path: string;
}

export interface VolumeReading extends VolumeProbe {
  /** Free bytes available to unprivileged users; null when unreadable. */
  freeBytes: number | null;
  /** Device id of the probed path (dedupes volumes shared by several paths). */
  dev: number | null;
}

/**
 * statfs of the nearest EXISTING ancestor of `path` — a fresh install may not
 * have created the state dir yet, and the parent lives on the same volume in
 * every layout that matters here. Unreadable all the way up → null (the
 * caller treats a missing reading as "no evidence", never as "full").
 */
export async function readVolume(v: VolumeProbe): Promise<VolumeReading> {
  let p = v.path;
  for (let depth = 0; depth < 64; depth++) {
    try {
      const s = await statfs(p);
      let dev: number | null = null;
      try {
        dev = statSync(p).dev;
      } catch {}
      return { ...v, freeBytes: s.bavail * s.bsize, dev };
    } catch {
      const up = dirname(p);
      if (up === p) break;
      p = up;
    }
  }
  return { ...v, freeBytes: null, dev: null };
}
