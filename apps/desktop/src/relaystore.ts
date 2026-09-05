// P2-187: persistence for the phone relay address (relay.json inside the
// shell's userData). Thin I/O only — every decision lives in the pure
// relaysetting.ts, and this module follows the window-state.ts precedent for
// shell file I/O plus the daemon's writeStateAtomic contract
// (apps/daemon/src/statefile.ts): the payload lands in a sibling .tmp file
// created with mode 0600 and a rename moves it over the destination, so a
// crash never leaves a half-written or world-readable setting behind. Every
// read failure (missing, unreadable, corrupted JSON, wrong field type)
// degrades to "not configured" instead of crashing the shell.
//
// P2-189: the file carries a second, independent field — `webAppUrl`, the
// address the phone opens (step one of the pairing journey). Writes are
// read-modify-write on the whole object so saving one setting never clobbers
// the other; both writers share the same atomic tmp+0600+rename path.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function relaySettingFile(userDataDir: string): string {
  return join(userDataDir, "relay.json");
}

/** Shape of relay.json on disk. Both fields optional; unknown keys preserved. */
interface RelaySettingsFile {
  url?: unknown;
  webAppUrl?: unknown;
}

/** Read the whole file tolerantly: missing, unreadable or corrupted JSON is
 * just "no settings yet" — never a crash, and ENOENT stays silent (a fresh
 * install has no relay.json yet and that is not an error). */
function readRelaySettings(file: string): RelaySettingsFile {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as RelaySettingsFile) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[desktop] relay setting unreadable (${file}), treating as not configured:`, err);
    }
    return {};
  }
}

/** Atomic private write: <file>.tmp with mode 0600, renamed over the
 * destination, tmp removed again on any failure. Log-only on error — a full
 * disk must never take the shell down. Returns true when the file now
 * reflects the payload. */
function writeRelaySettings(file: string, settings: RelaySettingsFile): boolean {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(settings), { mode: 0o600 });
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

/** Read the stored relay address; null means "not configured" (missing file,
 * unreadable, corrupted JSON or a non-string field). */
export function readStoredRelayUrl(file: string): string | null {
  const raw = readRelaySettings(file).url;
  return typeof raw === "string" ? raw : null;
}

/** Read the stored app address (P2-189); null means "not configured" — same
 * tolerance contract as readStoredRelayUrl. */
export function readStoredWebAppUrl(file: string): string | null {
  const raw = readRelaySettings(file).webAppUrl;
  return typeof raw === "string" ? raw : null;
}

/**
 * Persist the relay address (or clear it with null), preserving the
 * independent webAppUrl field either way. Returns true when the file now
 * reflects the value.
 */
export function writeStoredRelayUrl(file: string, url: string | null): boolean {
  const settings = readRelaySettings(file);
  if (url === null) delete settings.url;
  else settings.url = url;
  return writeRelaySettings(file, settings);
}

/**
 * Persist the app address the phone opens (or clear it with null),
 * preserving the independent relay url field either way. Same atomic path as
 * writeStoredRelayUrl. Returns true when the file now reflects the value.
 */
export function writeStoredWebAppUrl(file: string, url: string | null): boolean {
  const settings = readRelaySettings(file);
  if (url === null) delete settings.webAppUrl;
  else settings.webAppUrl = url;
  return writeRelaySettings(file, settings);
}
