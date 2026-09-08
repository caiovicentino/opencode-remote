// P2-221: persistence for the quit-confirmation owner decision (quit-ask.json
// inside the shell's userData). Thin I/O only — every decision lives in the
// pure quithint.ts, and this module follows the startupstore.ts precedent:
// the payload lands in a sibling .tmp file created with mode 0600 and a
// rename moves it over the destination, so a crash never leaves a half-written
// or world-readable file behind. Every read failure (missing, unreadable,
// corrupted JSON, wrong field type) degrades to "no request recorded" instead
// of crashing the shell. The file carries ONLY the boolean "the owner asked
// not to be asked again" flag — never a username, never a path, never a
// credential.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function quitAskFile(userDataDir: string): string {
  return join(userDataDir, "quit-ask.json");
}

/** Shape of quit-ask.json on disk. */
interface QuitAskFile {
  dontAsk?: unknown;
}

/** Read the stored owner request; false means "not recorded" (missing file,
 * unreadable, corrupted JSON or a non-boolean field) — never an exception.
 * ENOENT stays silent: an app that never saw the dialog has no quit-ask.json
 * yet and that is not an error. */
export function readQuitDontAsk(file: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[desktop] quit-ask decision unreadable, treating as not recorded:", err);
    }
    return false;
  }
  return typeof raw === "object" && raw !== null && (raw as QuitAskFile).dontAsk === true;
}

/** Atomic private write: <file>.tmp with mode 0600, renamed over the
 * destination, tmp removed again on any failure. Log-only on error — a full
 * disk must never take the shell down. Returns true when the file now
 * reflects the flag. */
export function writeQuitDontAsk(file: string, dontAsk: boolean): boolean {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ dontAsk }), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    console.error("[desktop] quit-ask decision write failed:", err);
    return false;
  }
}
