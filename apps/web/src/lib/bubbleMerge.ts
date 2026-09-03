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
  /** P3-085: the model's reasoning for this turn — collapsible "Pensou por Xs"
   * block above the answer text. secs is only known for live-streamed turns. */
  thinking?: { text: string; secs?: number };
}

/** History row as served by GET /session/:id/message (paginated or legacy). */
export interface HistoryRow {
  info: { id?: string; role?: string };
  parts: {
    type: string;
    text?: string;
    url?: string;
    callID?: string;
    tool?: string;
    state?: { status?: string; title?: string; output?: string };
  }[];
}

/** text/file/reasoning parts -> chat bubbles, in the order the rows arrive */
export function rowsToBubbles(rows: HistoryRow[]): Bubble[] {
  const out: Bubble[] = [];
  for (const row of rows) {
    const text = row.parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
    const images = row.parts
      .filter((p) => p.type === "file" && typeof p.url === "string" && p.url.startsWith("data:image/"))
      .map((p) => p.url as string);
    // P3-085: persisted reasoning renders as the collapsed thinking block;
    // history carries no timing, so the label falls back to "Pensou"
    const thinkingText = row.parts
      .filter((p) => p.type === "reasoning" && p.text)
      .map((p) => p.text)
      .join("\n");
    if (text || images.length || thinkingText) {
      out.push({
        role: row.info.role === "user" ? "user" : "assistant",
        text,
        images,
        messageID: row.info.id,
        thinking: thinkingText ? { text: thinkingText } : undefined,
      });
    }
  }
  return out;
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
