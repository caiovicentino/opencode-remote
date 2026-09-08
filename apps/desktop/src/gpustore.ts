// P2-244: persistence for the GPU-crash state (gpu-state.json inside the
// shell's userData). Thin I/O only — every decision lives in the pure
// gpuplan.ts, and this module follows the quitstore.ts precedent: the payload
// lands in a sibling .tmp file created with mode 0600 and a rename moves it
// over the destination, so a crash never leaves a half-written or
// world-readable file behind. Every read failure (missing, unreadable,
// corrupted JSON, wrong field types) degrades to the zeroed state instead of
// crashing the shell — and the zeroed state means "acceleration on", never
// "off". The file carries ONLY the crash count and the window start instant —
// never a username, never a path, never a credential. It is a sibling of
// window-state.json and never touches it (P3-008/P2-172/P2-238).

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GPU_STATE_ZEROED, sanitizeGpuState, type GpuCrashState } from "./gpuplan";

export function gpuStateFile(userDataDir: string): string {
  return join(userDataDir, "gpu-state.json");
}

/** Read the stored crash state; the zeroed state means "not recorded"
 * (missing file, unreadable, corrupted JSON or bad fields) — never an
 * exception. ENOENT stays silent: an app whose GPU process never crashed has
 * no gpu-state.json yet and that is not an error. */
export function readGpuState(file: string, nowMs: number): GpuCrashState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[desktop] gpu-state unreadable, treating as empty:", err);
    }
    return { ...GPU_STATE_ZEROED };
  }
  return sanitizeGpuState(raw, nowMs);
}

/** Atomic private write: <file>.tmp with mode 0600, renamed over the
 * destination, tmp removed again on any failure. Log-only on error — a full
 * disk must never take the shell down, at boot or at exit. Returns true when
 * the file now reflects the state. */
export function writeGpuState(file: string, state: GpuCrashState): boolean {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ count: state.count, windowStart: state.windowStart }), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    console.error("[desktop] gpu-state write failed:", err);
    return false;
  }
}
