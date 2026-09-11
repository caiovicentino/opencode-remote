// P3-409: persistence for the tray's keep-awake owner choice (keep-awake.json
// inside the shell's userData). Thin I/O only — every decision lives in the
// pure awakeplan.ts, and this module follows the quitstore.ts precedent: the
// payload lands in a sibling .tmp file created with mode 0600 and a rename
// moves it over the destination, so a crash never leaves a half-written or
// world-readable file behind. Every read failure (missing, unreadable,
// corrupted JSON, wrong field type) degrades to the documented default — the
// checkbox is ON by default, so anything but an explicit false reads as true
// — never an exception. The file carries ONLY the boolean owner choice —
// never a username, never a path, never a credential.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function keepAwakeFile(userDataDir: string): string {
  return join(userDataDir, "keep-awake.json");
}

/** Shape of keep-awake.json on disk. */
interface KeepAwakeFile {
  keepAwake?: unknown;
}

/** Read the stored owner choice; true (the documented default — the checkbox
 * is enabled by default) is returned when the file is missing, unreadable,
 * corrupted JSON or holds a non-boolean field, unless the stored value is an
 * explicit false. ENOENT stays silent: an app that never touched the
 * checkbox has no keep-awake.json yet and that is not an error. */
export function readKeepAwake(file: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[desktop] keep-awake choice unreadable, using default:", err);
    }
    return true;
  }
  return !(typeof raw === "object" && raw !== null && (raw as KeepAwakeFile).keepAwake === false);
}

/** Atomic private write: <file>.tmp with mode 0600, renamed over the
 * destination, tmp removed again on any failure. Log-only on error — a full
 * disk must never take the shell down. Returns true when the file now
 * reflects the choice. */
export function writeKeepAwake(file: string, keepAwake: boolean): boolean {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ keepAwake }), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    console.error("[desktop] keep-awake choice write failed:", err);
    return false;
  }
}
