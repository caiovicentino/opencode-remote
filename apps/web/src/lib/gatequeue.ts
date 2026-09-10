// P3-360: the first-boot offline queue. On the degraded journey (daemon down,
// nothing stored) the calm card now carries a real composer: whatever the
// user types is saved on this machine and becomes the first message of a new
// conversation as soon as the daemon answers — the "nothing is lost" promise
// the card already makes, made exercisable. Pure (no DOM): every function
// takes the storage it touches, so scripts/gate-queue.test.ts can pin the
// contract without a renderer — same pattern as drafts.ts/composer.ts.

/** localStorage key. Deliberately namespaced like the other renderer keys
 * (ocr_theme, ocr_unread) — never a secret, safe to be 0600-userdata local. */
export const GATE_QUEUE_KEY = "ocr_gate_queue";

/** Sanity cap for one queued prompt (~ a long first message, far above any
 * real composer draft) so a runaway paste can never bloat localStorage. */
export const GATE_QUEUE_MAX = 8000;

/** Trimmed, NUL-free, length-capped queue text. Non-string → "". */
export function sanitizeQueue(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const clean = raw.replaceAll("\u0000", "").trim();
  return clean.length > GATE_QUEUE_MAX ? clean.slice(0, GATE_QUEUE_MAX) : clean;
}

export interface QueueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The queued text, or "" when storage is unavailable/corrupt — a poisoned
 * localStorage must never take the calm card down with it (fail-safe). */
export function readGateQueue(store: QueueStore): string {
  try {
    return sanitizeQueue(store.getItem(GATE_QUEUE_KEY));
  } catch {
    return "";
  }
}

/** Persists the trimmed text; empty clears the key. Returns the text as
 * stored so the caller can keep state and view in sync. Storage failures
 * are swallowed on purpose — the composer still works, the copy just won't
 * survive a private-mode restart. */
export function writeGateQueue(text: string, store: QueueStore): string {
  const clean = sanitizeQueue(text);
  try {
    if (clean) store.setItem(GATE_QUEUE_KEY, clean);
    else store.removeItem(GATE_QUEUE_KEY);
  } catch {}
  return clean;
}

export function clearGateQueue(store: QueueStore): void {
  try {
    store.removeItem(GATE_QUEUE_KEY);
  } catch {}
}
