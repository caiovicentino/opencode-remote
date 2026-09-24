// RT-466: the download allowlist must consult the filesystem, not just the
// string form of a path. `path.resolve` never touches the disk, so a symlink
// planted inside an allowed root passed the old string-prefix gate and both
// `/__ocr/download/start` (statSync follows links) and `chunk` (openSync)
// read targets anywhere on disk — a violation of constitution invariant #6.
// Pure verdicts over injected inputs: no state, no timers, no network.
import { constants as fsConstants, closeSync, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

// O_NOFOLLOW is missing on some platforms (Windows): absent constant → 0,
// which keeps openSync behavior unchanged there — the realpath re-check
// below still closes the gap on those platforms. O_NONBLOCK makes the open
// of a swapped-in fifo return immediately (never hangs waiting for a
// writer); the fstat isFile check below then refuses it — O_NONBLOCK is a
// no-op for regular files.
const O_RDONLY = fsConstants.O_RDONLY;
const O_NOFOLLOW = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
const O_NONBLOCK = (fsConstants as Record<string, number | undefined>).O_NONBLOCK ?? 0;

/** Realpath each root when it exists (macOS `/var`→`/private/var`, home symlinked), else keep the resolved form; dedupe. */
export function resolveDownloadRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    let real: string;
    try {
      real = realpathSync(r);
    } catch {
      real = resolve(r);
    }
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/** True when `real` is one of `roots` itself or sits under one (separator-anchored — no prefix confusion). */
export function containedIn(real: string, roots: string[]): boolean {
  return roots.some((r) => real === r || real.startsWith(r + sep));
}

/**
 * Resolve `p` through the filesystem and admit it only when the REAL path
 * stays inside one of the download roots and names a regular file.
 * Broken links, missing paths, directories, fifos and devices → null.
 * Returns the real path, or null — never throws.
 */
export function accessibleDownloadPath(p: string, realRoots: string[]): string | null {
  const abs = resolve(p);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  if (!containedIn(real, realRoots)) return null;
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * Open `real` (a previously validated real path) for reading, re-verifying
 * it did not become a symlink or leave the roots between start and now
 * (closes the TOCTOU on the chunk route). O_NOFOLLOW fails the open when the
 * final component is a symlink; the realpath re-check catches escapes via
 * intermediate components. Returns the fd, or null — never throws, never
 * leaks a fd.
 */
export function openContainedFile(real: string, realRoots: string[]): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const now = realpathSync(real);
    if (now !== real || !containedIn(now, realRoots)) throw new Error("path escaped the roots");
    return fd;
  } catch {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    return null;
  }
}
