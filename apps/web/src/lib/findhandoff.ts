// eval-20: one-shot "open this conversation with its find bar holding this
// term" handoff, from a conversation-search hit (sidebar list or ⌘K palette)
// to ChatView's in-conversation find (P2-281). Same shape as the drafts.ts
// send-on-open flag: module-level, memory-only, TTL-bounded, and consumed
// only by the conversation it names — a stale or foreign flag can never pop
// a find bar open in an unrelated chat later. Pure (no React, no DOM) so
// scripts/convosearch.test.ts drives it directly; the listener set exists so
// ChatView can react when the SAME conversation is picked again.

export const FIND_ON_OPEN_TTL_MS = 20_000;

let pending: { sessionId: string; term: string; at: number } | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** Records the handoff (a blank term or session clears it) and notifies. */
export function markFindOnOpen(sessionId: string, term: string, now: number = Date.now()): void {
  const t = typeof term === "string" ? term.trim() : "";
  pending = sessionId && t ? { sessionId, term: t, at: now } : null;
  version += 1;
  listeners.forEach((fn) => fn());
}

/**
 * The pending term for `sessionId`, consumed on the way out. A flag for
 * another conversation stays put (that chat may be the one opening next);
 * an expired or clock-skewed flag is dropped whoever asks.
 */
export function takeFindOnOpen(sessionId: string, now: number = Date.now()): string | null {
  const flag = pending;
  if (!flag) return null;
  if (now - flag.at > FIND_ON_OPEN_TTL_MS || now < flag.at) {
    pending = null;
    return null;
  }
  if (flag.sessionId !== sessionId) return null;
  pending = null;
  return flag.term;
}

/** useSyncExternalStore contract: subscribe + a snapshot that changes on mark. */
export function subscribeFindHandoff(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function findHandoffVersion(): number {
  return version;
}
