// P3-085: collapsible "Pensou por Xs" (thinking) block state. Pure and
// pinned by scripts/thinking.test.ts — ChatView only glues events in and
// renders the result, so the collapse rules stay testable without a DOM.
//
// opencode streams the model's reasoning as `message.part.updated` events
// whose `part.type` is "reasoning" (same envelope as text parts; the daemon
// is a blind router and forwards them untouched). Like text parts, the
// event carries a SNAPSHOT of the reasoning so far — latest wins.

export interface ThinkingState {
  /** Latest reasoning snapshot. */
  text: string;
  /** ms timestamp of the first reasoning part of the turn. */
  startedAt: number;
  /** ms timestamp when the answer text started (or the turn went idle) —
   * freezes the "Pensou por Xs" duration. */
  endedAt?: number;
}

function isReasoningPart(evt: { type?: string }): { type?: string; text?: string } | null {
  if (evt.type !== "message.part.updated") return null;
  const props = (evt as { properties?: unknown }).properties as
    | { part?: { type?: string; text?: string } }
    | undefined;
  const part = props?.part;
  if (!part || typeof part !== "object") return null;
  return part;
}

/**
 * Fold one stream event into the thinking state. Returns the (new) state or
 * null when there is nothing to show. Reasoning parts (re)open the block;
 * answer text or the turn going idle freezes the duration.
 */
export function reduceThinking(
  prev: ThinkingState | null,
  evt: { type?: string; properties?: unknown },
  sessionId: string,
  now: number,
): ThinkingState | null {
  const props = (evt.properties ?? {}) as { sessionID?: string; status?: { type?: string } };
  if (props.sessionID && props.sessionID !== sessionId) return prev;
  const part = isReasoningPart(evt);
  if (part && part.type === "reasoning") {
    if (typeof part.text !== "string" || !part.text) return prev;
    return {
      text: part.text,
      startedAt: prev?.startedAt ?? now,
      endedAt: undefined, // reasoning after the text started ⇒ thinking resumed
    };
  }
  if (!prev) return prev;
  if (evt.type === "session.idle") return { ...prev, endedAt: prev.endedAt ?? now };
  if (evt.type === "message.part.updated") {
    // answer text is streaming — the thinking window closed
    return { ...prev, endedAt: prev.endedAt ?? now };
  }
  return prev;
}

/** Whole seconds the thinking window stayed open (min 1 — "0s" reads broken). */
export function thinkingSeconds(st: ThinkingState): number {
  const ms = (st.endedAt ?? Date.now()) - st.startedAt;
  return Math.max(1, Math.round(ms / 1000));
}

/**
 * Collapse rule (PRODUCT.md, Claude Desktop parity): open while the model is
 * still thinking and no answer text has arrived; collapsed the moment the
 * answer starts or the turn ends. The component's manual toggle overrides.
 */
export function thinkingExpanded(st: ThinkingState | null): boolean {
  return !!st && st.endedAt === undefined;
}
