// P2-187: persistence for the phone relay address (relay.json inside the
// shell's userData). Thin I/O only — every decision lives in the pure
// relaysetting.ts, and this module follows the window-state.ts precedent for
// shell file I/O plus the daemon's writeStateAtomic contract
// (apps/daemon/src/statefile.ts): the payload lands in a sibling .tmp file
// created with mode 0600 and a rename moves it over the destination, so a
// crash never leaves a half-written or world-readable setting behind. Every
// read failure (missing, unreadable, corrupted JSON, wrong field type)
// degrades to "not configured" instead of crashing the shell.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function relaySettingFile(userDataDir: string): string {
  return join(userDataDir, "relay.json");
}

/** Read the stored relay address; null means "not configured" (missing file,
 * unreadable, corrupted JSON or a non-string field). ENOENT is silent — a
 * fresh install has no relay.json yet and that is not an error. */
export function readStoredRelayUrl(file: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown };
    return typeof raw.url === "string" ? raw.url : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[desktop] relay setting unreadable (${file}), treating as not configured:`, err);
    }
    return null;
  }
}

/**
 * Persist the relay address (or clear it with null, which writes {}). Atomic
 * and private: <file>.tmp with mode 0600, renamed over the destination, tmp
 * removed again on any failure. Log-only on error — a full disk must never
 * take the shell down. Returns true when the file now reflects the value.
 */
export function writeStoredRelayUrl(file: string, url: string | null): boolean {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(url === null ? {} : { url }), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    console.error(`[desktop] relay setting write failed (${file}):`, err);
    return false;
  }
}
