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

// EVAL4-B (fable r4, product track): the home composer's arrow SENDS. Before
// this the home only created the session and left the text as a draft, so
// the primary action of the first screen did nothing visible (390px evidence:
// /tmp/fable-eval4b/shots/12-b2-chat-reply.png — empty chat, text still in
// the composer). One-shot flag, validated twice before it fires: the draft of
// the opened session must equal the flagged text and the flag must be
// younger than SEND_ON_OPEN_TTL_MS — a failed creation can never auto-send an
// unrelated draft later. Ideas (P2-123) keep their edit-first behavior: only
// the composer submit marks the flag.
export const SEND_ON_OPEN_TTL_MS = 20_000;

let sendOnOpen: { text: string; at: number } | null = null;

export function markSendOnOpen(text: string, now: number = Date.now()): void {
  sendOnOpen = text.trim() ? { text: text.trim(), at: now } : null;
}

/** Consumes the flag (always) and returns the text to send when it matches the session's draft. */
export function takeSendOnOpen(id: string, now: number = Date.now()): string | null {
  const flag = sendOnOpen;
  sendOnOpen = null;
  if (!flag) return null;
  if (now - flag.at > SEND_ON_OPEN_TTL_MS || now < flag.at) return null;
  if (getDraft(id).trim() !== flag.text) return null;
  return flag.text;
}

/** Appends with a single space separator and returns the new value. */
export function appendDraft(id: string, text: string): string {
  const prev = getDraft(id);
  const next = prev ? `${prev} ${text}` : text;
  setDraft(id, next);
  return next;
}
