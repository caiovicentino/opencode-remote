// P1-088: per-session composer drafts, keyed by sessionId. Memory-only (same
// lifecycle as the session bubble cache): switching sessions must neither lose
// the draft you typed nor show it inside another conversation. Pure (no DOM)
// so scripts/unit.test.ts can test it — mirrors the sessionCache.ts precedent.

export const DRAFTS_MAX = 100;

const drafts = new Map<string, string>();

export function getDraft(id: string): string {
  return drafts.get(id) ?? "";
}

export function setDraft(id: string, text: string): void {
  if (text === "") {
    drafts.delete(id);
    return;
  }
  // oldest-evicted on insert, same policy as sessionCache
  drafts.delete(id);
  drafts.set(id, text);
  while (drafts.size > DRAFTS_MAX) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

export function clearDraft(id: string): void {
  drafts.delete(id);
}

/** P2-266: true while any session holds an unsent draft — the sw-update
 * wiring reads it before offering a version swap, so a reload can never
 * discard typed-but-unsent text. */
export function hasDrafts(): boolean {
  return drafts.size > 0;
}

/** Appends with a single space separator and returns the new value. */
export function appendDraft(id: string, text: string): string {
  const prev = getDraft(id);
  const next = prev ? `${prev} ${text}` : text;
  setDraft(id, next);
  return next;
}
