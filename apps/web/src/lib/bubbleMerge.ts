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
    /** opencode: text the system added to the turn (never typed by the user) */
    synthetic?: boolean;
    url?: string;
    filename?: string;
    callID?: string;
    tool?: string;
    state?: { status?: string; title?: string; output?: string };
  }[];
}

/**
 * eval-10 (r4 PR-B1): the daemon appends a `[ocr-artifacts-path] …` text
 * part to a session's first turn (apps/daemon/src/sessionctx.ts, again after
 * every daemon restart) and opencode stores it inside the USER message — the
 * bubble showed the internal marker plus the machine's home path. Mirror of
 * the daemon's ARTIFACTS_PATH_MARKER (pinned by scripts/pwa-mobile-ux.test.ts).
 */
export const INJECTED_PATH_MARKER = "[ocr-artifacts-path]";

/**
 * True for text the user never typed: opencode's `synthetic` parts (file
 * reads it inlines, anything a server marks synthetic) and the daemon's path
 * line in user turns. The model still sees them — only the bubble skips them.
 */
export function isInjectedPart(part: { type?: string; text?: unknown; synthetic?: unknown }, role?: string): boolean {
  if (part.type !== "text") return false;
  if (part.synthetic === true) return true;
  return role !== "assistant" && typeof part.text === "string" && part.text.trimStart().startsWith(INJECTED_PATH_MARKER);
}

/** text/file/reasoning parts -> chat bubbles, in the order the rows arrive */
export function rowsToBubbles(rows: HistoryRow[]): Bubble[] {
  const out: Bubble[] = [];
  for (const row of rows) {
    let text = row.parts
      .filter((p) => p.type === "text" && p.text && !isInjectedPart(p, row.info.role))
      .map((p) => p.text)
      .join("\n");
    const images = row.parts
      .filter((p) => p.type === "file" && typeof p.url === "string" && p.url.startsWith("data:image/"))
      .map((p) => p.url as string);
    // eval-10: a document-only turn keeps its bubble — its only text parts
    // were opencode's synthetic file reads, so name the files instead (the
    // same `[file …]` label the optimistic bubble used at send time)
    if (!text && !images.length && row.info.role === "user") {
      text = row.parts
        .filter((p) => p.type === "file" && typeof p.filename === "string" && p.filename)
        .map((p) => `[file ${p.filename}]`)
        .join(" ");
    }
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
 * eval-10: a history read that lands BEFORE the server stored the prompt in
 * flight — the chat opens and sends in the same tick on the home composer's
 * send-on-open, so the mount's history GET races the prompt POST — replaced
 * the optimistic user bubble with a history that did not contain it yet: the
 * first message vanished and only the reply showed (hermetic 390px repro).
 * In-flight user bubbles (pending === true, no messageID yet) survive a
 * history replace unless the history's newest user row already carries the
 * same text. Queued (offline) bubbles are NOT kept: the reconnect flush
 * re-renders them as fresh sends.
 */
export function keepInflight(history: Bubble[], current: Bubble[]): Bubble[] {
  const inflight = current.filter((b) => b.role === "user" && !b.messageID && b.pending === true);
  if (inflight.length === 0) return history;
  let lastUser: Bubble | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") {
      lastUser = history[i];
      break;
    }
  }
  const kept = inflight.filter((b) => !storedIsSameSend(lastUser, b, current));
  return kept.length ? [...history, ...kept] : history;
}

/**
 * eval-10 verify round: does the history's newest user row already carry this
 * send? Text prompts match by text (unchanged). An image-only send renders as
 * "[image]" in flight while the stored row shows the image parts with no text
 * — the same message in two renderings, matched by the label's image count.
 * The count match only counts as THIS send when no settled image-only bubble
 * in `current` already holds it: otherwise the stored row is an earlier send
 * (e.g. the previous picture) and the in-flight one is a new message that
 * must survive the replace — never dropped on a guess.
 */
export function storedIsSameSend(stored: Bubble | undefined, inflight: Bubble, current: Bubble[]): boolean {
  if (!stored) return false;
  if (stored.text === inflight.text) return true;
  const storedImgs = stored.images?.length ?? 0;
  if (!storedImgs || stored.text.trim()) return false;
  const m = /^\[images?(?: x(\d+))?\](?: \[file [^\]]+\])*$/.exec(inflight.text.trim());
  if (!m) return false;
  if (storedImgs !== (m[1] ? Number(m[1]) : 1)) return false;
  return !current.some(
    (b) => b.role === "user" && b.messageID && (b.images?.length ?? 0) === storedImgs && !b.text.trim(),
  );
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
