// Storage-write verdict for the desktop shell's data folder (P2-346). On a
// first boot with an unwritable userData (no write permission on the folder,
// a read-only volume, a full disk) the sidecar cannot persist the identity
// either — every pairing attempt fails silently and the calm first-boot card
// keeps promising a connect that can never happen. This module is the single
// mapping from ONE injected probe result (the executor in main.ts writes and
// deletes a small temp file inside userData before starting the sidecar) to a
// CLOSED verdict: a static pt-BR sentence that names the problem without a
// path, a user name or the raw error message — desktop.log lives on disk
// unencrypted and the phrase also rides the pairing payload's additive
// `storage` field.
//
// Same module hygiene as sidecarwedge.ts / camaccess.ts: NO electron, no
// Node builtins, no timers, no fetch, no I/O of any kind — the unit tests
// evaluate this module in plain Node and assert the purity against the real
// file. The probe result is INJECTED: the module never touches the disk.
//
// CLOSED CONTRACT:
//  1. the verdict state is one of exactly five kinds — "ok" (the folder takes
//     a write), "no-permission" (EACCES/EPERM: the folder refuses writes),
//     "read-only" (EROFS: the volume is mounted read-only), "disk-full"
//     (ENOSPC: no space left on the device) and "unknown" (any other code or
//     a malformed probe result) — each with a short static pt-BR message
//     carrying no path, no user name, no raw errno text and no secret;
//  2. any unreadable input (non-object, non-boolean ok, absent/empty/non-
//     string code) degrades to "unknown" — garbage can never be presented as
//     a diagnosis, and nothing is ever thrown;
//  3. an explicit ok:true wins over any code the caller may still carry —
//     a successful write is the only evidence that matters;
//  4. the same input yields the exact same verdict on every call (pure —
//     no state, no clock, no randomness).

/** The closed set of storage-write verdicts. Mirrored by the web-side
 * sanitizer (apps/web/src/lib/degraded.ts) — the two apps cannot import each
 * other, so a source-reading parity test in scripts/unit.test.ts fails the
 * moment either side drifts (P2-338/P2-344 lesson). */
export type StorageVerdictState = "ok" | "no-permission" | "read-only" | "disk-full" | "unknown";

/** Every state the verdict may take, in one place — the desktop log line and
 * the pairing payload never carry anything outside this set. */
export const STORAGE_VERDICT_STATES: readonly StorageVerdictState[] = [
  "ok",
  "no-permission",
  "read-only",
  "disk-full",
  "unknown",
];

export interface StorageVerdict {
  state: StorageVerdictState;
  /** Short static pt-BR phrase (desktop.log copy and the pairing payload's
   * message) — never a path, a user name or the raw error message. */
  message: string;
}

/** Result of the ONE injected write probe: ok:true when a small temp file
 * was written and deleted inside userData; otherwise the errno code of the
 * failed write (EACCES, EPERM, EROFS, ENOSPC, …) or absent when the error
 * carried none. */
export interface StorageProbeResult {
  ok: boolean;
  /** errno code of the failed write — a plain string like "EACCES". */
  code?: string;
}

const OK: StorageVerdict = {
  state: "ok",
  message: "a pasta de dados do app está gravável",
};
const NO_PERMISSION: StorageVerdict = {
  state: "no-permission",
  message: "o app não tem permissão para gravar na pasta de dados dele",
};
const READ_ONLY: StorageVerdict = {
  state: "read-only",
  message: "a pasta de dados do app está somente leitura",
};
const DISK_FULL: StorageVerdict = {
  state: "disk-full",
  message: "o disco deste computador está cheio",
};
const UNKNOWN: StorageVerdict = {
  state: "unknown",
  message: "o app não conseguiu gravar na pasta de dados dele",
};

/** errno codes that mean the folder refuses writes outright (denied by
 * permissions — EACCES) or by policy (EPERM, e.g. a sandboxed parent). Both
 * are the same story for the owner: fix the folder's permission. */
const NO_PERMISSION_CODES = new Set(["EACCES", "EPERM"]);
/** errno code for a read-only volume — no permission change can help. */
const READ_ONLY_CODES = new Set(["EROFS"]);
/** errno code for a full disk — free space before anything else can work. */
const DISK_FULL_CODES = new Set(["ENOSPC"]);

/**
 * The one pure decision of this module. Deterministic and total: the same
 * input yields the exact same verdict on every call, and nothing is ever
 * thrown — every malformed shape degrades to "unknown".
 */
export function storageProbeVerdict(probe: StorageProbeResult | null | undefined): StorageVerdict {
  if (typeof probe !== "object" || probe === null || Array.isArray(probe)) return UNKNOWN;
  const { ok, code } = probe as StorageProbeResult;
  if (typeof ok !== "boolean") return UNKNOWN;
  if (ok) return OK;
  if (typeof code !== "string" || code === "") return UNKNOWN;
  if (NO_PERMISSION_CODES.has(code)) return NO_PERMISSION;
  if (READ_ONLY_CODES.has(code)) return READ_ONLY;
  if (DISK_FULL_CODES.has(code)) return DISK_FULL;
  return UNKNOWN;
}
