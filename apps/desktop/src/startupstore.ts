// P2-218: persistence for the login-item owner decision (startup.json inside
// the shell's userData). Thin I/O only — every decision lives in the pure
// loginitem.ts, and this module follows the relaystore.ts precedent: the
// payload lands in a sibling .tmp file created with mode 0600 and a rename
// moves it over the destination, so a crash never leaves a half-written or
// world-readable file behind. Every read failure (missing, unreadable,
// corrupted JSON, wrong field type) degrades to "no decision yet" instead of
// crashing the shell — the worst case on a fresh packaged boot is enabling
// the login item once more, never a boot exception. The file carries ONLY
// the boolean "the owner already decided" flag — never a username, never a
// path, never a credential.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function startupSettingFile(userDataDir: string): string {
  return join(userDataDir, "startup.json");
}

/** Shape of startup.json on disk. */
interface StartupSettingsFile {
  decided?: unknown;
}

/** Read the stored owner decision; false means "not decided yet" (missing
 * file, unreadable, corrupted JSON or a non-boolean field) — never an
 * exception. ENOENT stays silent: a fresh install has no startup.json yet
 * and that is not an error. */
export function readStartupDecided(file: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[desktop] startup decision unreadable, treating as not decided:", err);
    }
    return false;
  }
  return typeof raw === "object" && raw !== null && (raw as StartupSettingsFile).decided === true;
}

/** Atomic private write: <file>.tmp with mode 0600, renamed over the
 * destination, tmp removed again on any failure. Log-only on error — a full
 * disk must never take the shell down. Returns true when the file now
 * reflects the flag. */
export function writeStartupDecided(file: string, decided: boolean): boolean {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ decided }), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    console.error("[desktop] startup decision write failed:", err);
    return false;
  }
}
