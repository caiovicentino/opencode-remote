// P3-084: last-message preview for the ⌘K switcher (PRODUCT.md: "Cmd+K … com
// preview"). Source: the app's live event buffer — every conversation streams
// message.part.updated while the app is open, so the switcher shows the last
// known line without N per-session fetches. Pure and dependency-free so
// scripts/unit.test.ts can exercise it directly.

/** Minimal structural view of an event envelope (EventEnvelope-compatible). */
export interface PreviewEvent {
  type: string;
  properties?: unknown;
}

interface PartProperties {
  sessionID?: string;
  part?: { text?: string; state?: { title?: string } };
}

/** One-line, truncated, whitespace-collapsed text for the preview slot. */
export function clipPreview(text: string, maxLen = 90): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

/**
 * Map sessionId → last streamed message text. Later events win; events with
 * no text part (idle, permission, …) never erase an existing preview.
 */
export function previewFromEvents(events: PreviewEvent[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const evt of events) {
    if (evt.type !== "message.part.updated") continue;
    const props = (evt.properties ?? {}) as PartProperties;
    const text = props.part?.text ?? props.part?.state?.title ?? "";
    if (!props.sessionID || !text) continue;
    map[props.sessionID] = clipPreview(text);
  }
  return map;
}
