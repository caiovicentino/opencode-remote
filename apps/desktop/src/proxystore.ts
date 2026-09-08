// P2-289: persistence for the machine-proxy owner choice (proxy.json inside
// the shell's userData). Thin I/O only — every decision about where traffic
// goes lives in the pure proxyplan.ts, and this module follows the exact
// relaystore.ts / startupstore.ts precedent: the payload lands in a sibling
// .tmp file created with mode 0600 and a rename moves it over the
// destination, so a crash never leaves a half-written or world-readable
// choice behind.
//
// READ TOLERANCE: a missing, unreadable or corrupted file, a non-object
// payload, a mode outside the documented table and a non-textual address all
// degrade to "no stored choice" (null) — they NEVER throw and NEVER take the
// shell down. A fresh install has no proxy.json yet and that is not an error
// (ENOENT stays silent).
//
// WRITE FAIL-CLOSED: an address with embedded credentials, an address whose
// scheme is outside the documented list (http, https, socks4, socks5) and an
// address that does not parse are REFUSED — nothing is written and a short
// static reason comes back instead. The shell never persists where traffic
// goes based on an unvalidated value; a hand-edited invalid file is still
// caught by the planner (proxyplan.ts rule 3) on the next boot.
//
// PRIVACY BOUNDARY: the file carries ONLY the choice — the mode and, for the
// fixed mode, the credential-free address the owner typed. No environment
// variables, no paths, no credentials.

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProxyAddress, PROXY_SCHEMES } from "./proxyplan";

export function proxySettingFile(userDataDir: string): string {
  return join(userDataDir, "proxy.json");
}

/** The documented choice table — "fixed" is the only mode that stores an
 * address. The planner's vocabulary maps 1:1: system→"sistema",
 * direct→"direto", fixed→the address itself. */
export type ProxyStoreMode = "system" | "direct" | "fixed";

export interface ProxyStoredChoice {
  mode: ProxyStoreMode;
  /** Credential-free address for the fixed mode; null otherwise. */
  address: string | null;
}

/** Result of a validated write: ok=false carries a short static reason and
 * NOTHING was persisted. */
export type ProxyWriteResult = { ok: true } | { ok: false; reason: string };

const REFUSAL_MALFORMED = "escolha de proxy ilegível — nada foi gravado";
const REFUSAL_MODE = "modo de proxy fora da tabela — nada foi gravado";
const REFUSAL_ADDRESS = "endereço de proxy ausente ou não textual — nada foi gravado";
const REFUSAL_CREDENTIAL = "endereço com credencial embutida — nada foi gravado";
const REFUSAL_SCHEME = "esquema fora da lista documentada — nada foi gravado";
const REFUSAL_UNPARSEABLE = "endereço de proxy inválido — nada foi gravado";
const REFUSAL_WRITE_FAILED = "não foi possível gravar a escolha — tente de novo";

function isStoreMode(raw: unknown): raw is ProxyStoreMode {
  return raw === "system" || raw === "direct" || raw === "fixed";
}

/**
 * Read the stored choice tolerantly: any unreadable, malformed, out-of-table
 * or non-textual input yields null ("no stored choice"), never an exception.
 */
export function readProxyChoice(file: string): ProxyStoredChoice | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[desktop] proxy choice unreadable, treating as no choice:", err);
    }
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const mode = (raw as { mode?: unknown }).mode;
  if (!isStoreMode(mode)) return null;
  if (mode !== "fixed") return { mode, address: null };
  const address = (raw as { address?: unknown }).address;
  if (typeof address !== "string" || address.trim() === "") return null;
  return { mode, address };
}

/**
 * Persist the owner choice, validated and fail-closed: a malformed payload, a
 * mode outside the documented table, a missing/non-textual address and any
 * address with embedded credentials, an undocumented scheme or an
 * unparseable shape are refused with a short static reason — nothing is
 * written. system/direct ignore any address that rides along: the mode alone
 * decides.
 */
export function writeProxyChoice(file: string, choice: unknown): ProxyWriteResult {
  if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
    return { ok: false, reason: REFUSAL_MALFORMED };
  }
  const mode = (choice as { mode?: unknown }).mode;
  if (!isStoreMode(mode)) {
    return { ok: false, reason: REFUSAL_MODE };
  }
  if (mode !== "fixed") {
    return writeChoiceFile(file, { mode });
  }
  const addressRaw = (choice as { address?: unknown }).address;
  if (typeof addressRaw !== "string" || addressRaw.trim() === "") {
    return { ok: false, reason: REFUSAL_ADDRESS };
  }
  const address = addressRaw.trim();
  if (address.includes("@")) {
    return { ok: false, reason: REFUSAL_CREDENTIAL };
  }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(address);
  if (schemeMatch && !PROXY_SCHEMES.includes((schemeMatch[1] ?? "").toLowerCase())) {
    return { ok: false, reason: REFUSAL_SCHEME };
  }
  if (!parseProxyAddress(address)) {
    return { ok: false, reason: REFUSAL_UNPARSEABLE };
  }
  return writeChoiceFile(file, { mode, address });
}

/** Remove the stored choice (best effort) — the next boot follows the
 * machine environment again. A missing file is already the goal. */
export function clearProxyChoice(file: string): void {
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[desktop] proxy choice clear failed:", err);
    }
  }
}

/** Atomic private write: <file>.tmp with mode 0600, renamed over the
 * destination, tmp removed again on any failure. Log-only on error — a full
 * disk must never take the shell down. */
function writeChoiceFile(file: string, payload: { mode: ProxyStoreMode; address?: string }): ProxyWriteResult {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    console.error("[desktop] proxy choice write failed:", err);
    return { ok: false, reason: REFUSAL_WRITE_FAILED };
  }
}
