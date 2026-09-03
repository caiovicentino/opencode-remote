// P1-089: stable bubble identity across the history+stream merge. Two actors
// populate the same transcript — loadHistory (replace) and the stream effect
// replaying buffered events (append) — so both must key bubbles by messageID
// or switching conversations and coming back re-renders the same messages.

export interface Bubble {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  messageID?: string;
  /** true while the relay round-trip is in flight; "queued" when offline */
  pending?: boolean | "queued";
}

/**
 * Merge `incoming` bubbles into `existing`, keyed by messageID:
 * - an incoming bubble whose messageID already exists replaces it IN PLACE
 *   (existing order is the source of truth);
 * - new id-carrying bubbles are appended in arrival order;
 * - id-less bubbles (optimistic user message before the echo tags it) are
 *   appended only when no identical id-less bubble (same role + text) is
 *   already present — that is what makes a full event-buffer replay a no-op
 *   the second time (idempotence, P1-082 last-occurrence-wins lesson).
 */
export function mergeBubbles(existing: Bubble[], incoming: Bubble[]): Bubble[] {
  const out = existing.slice();
  const slot = new Map<string, number>();
  existing.forEach((b, i) => {
    if (b.messageID) slot.set(b.messageID, i);
  });
  const idless = new Set(
    existing.filter((b) => !b.messageID).map((b) => `${b.role}\u0000${b.text}`),
  );
  for (const b of incoming) {
    if (b.messageID) {
      const at = slot.get(b.messageID);
      if (at !== undefined) {
        out[at] = b;
        continue;
      }
      slot.set(b.messageID, out.length);
      out.push(b);
      continue;
    }
    const key = `${b.role}\u0000${b.text}`;
    if (idless.has(key)) continue;
    idless.add(key);
    out.push(b);
  }
  return out;
}
