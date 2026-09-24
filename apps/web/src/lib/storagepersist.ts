// P3-463: the PWA keeps the pairing in browser storage (localStorage rows +
// the IndexedDB identity) but never asked the browser to persist it, so iOS
// Safari and Chrome under disk pressure may evict the site's data at will —
// the phone wakes up back on the pairing screen with no explanation.
//
// This module owns the ONE storage-persistence ask of the app: it runs once,
// best-effort, only at the moment a fresh pairing is saved (App.tsx's
// `persist` branch — never at boot), and classifies the outcome into the
// closed set `granted` / `denied` / `unknown`. Every failure mode — API
// absent (old browsers, private mode), the promise rejecting, a non-boolean
// answer — degrades to `unknown`; the ask can never break a pairing.
//
// PURE on purpose (same hygiene as welcome.ts / installhint.ts): no React,
// no navigator, no localStorage, no timers — the caller injects the
// storage-like object, so scripts/unit.test.ts drives every branch in plain
// Node. The `navigator.storage` object itself is read exactly once, in
// App.tsx, inside the post-pairing branch (pinned by source assertions).

/** The closed set the verdict may take — every error or missing API is
 * `unknown` (fail-closed), never a guess. */
export type StoragePersistState = "granted" | "denied" | "unknown";

export const STORAGE_PERSIST_STATES: readonly string[] = ["granted", "denied", "unknown"];

/** localStorage flag carrying the one-time verdict. One word, never key
 * material (same discipline as the install-hint dismissal flag) — the
 * browser wiping it just means the ask happens again after the next
 * pairing. Lives in the dotted `ocr.` namespace, so the deliberate
 * "pair again" wipe clears it too. */
export const STORAGE_PERSIST_KEY = "ocr.storagepersist";

/** The storage-like surface the classifier needs — `navigator.storage` is
 * structurally compatible; tests pass hand-rolled fakes. */
export interface PersistStorageLike {
  persist?: () => Promise<boolean>;
}

/**
 * The ONE persistence ask. Missing API, a rejecting promise or a malformed
 * answer all resolve `unknown` without ever throwing — the pairing flow
 * must not notice this module exists. `true` → granted, `false` → denied.
 */
export async function requestStoragePersistence(
  storage: PersistStorageLike | null | undefined,
): Promise<StoragePersistState> {
  if (!storage || typeof storage.persist !== "function") return "unknown";
  try {
    const granted = await storage.persist();
    if (granted === true) return "granted";
    if (granted === false) return "denied";
  } catch {
    // a rejected ask is not a denial — classify unknown, never rethrow
  }
  return "unknown";
}

/** Tolerant read of the persisted verdict: absent, wrong type or an
 * out-of-set value mean "never asked", never an exception. */
export function readStoredStoragePersist(raw: string | null | undefined): StoragePersistState | null {
  if (typeof raw !== "string") return null;
  return (STORAGE_PERSIST_STATES as readonly string[]).includes(raw)
    ? (raw as StoragePersistState)
    : null;
}

/** Write side of the flag — deliberately constant: the entry never carries
 * a room, a key, a token or any other credential, just the verdict word. */
export function serializeStoragePersistState(state: StoragePersistState): string {
  return state;
}

/** Documented test-only hatch (P2-220 pattern): `?storagepersist=denied`
 * forces the denied verdict so the Settings line renders deterministically
 * for screenshots. Fail-closed like every capability hatch: only the
 * DEGRADED state is honored — never granted, never anything else. */
export function readForcedStoragePersist(raw: string | null | undefined): StoragePersistState | null {
  return raw === "denied" ? "denied" : null;
}

/** Documented test-only hatch (same pattern): `?pairwiped=1` forces the
 * pairing screen's eviction line for screenshots and support reproduction.
 * Fail-closed the same way: the forced value can only ADD the calm line —
 * without the parameter the real marker logic stays authoritative, and no
 * value ever suppresses it. */
export function readForcedPairingWiped(raw: string | null | undefined): boolean {
  return raw === "1";
}
