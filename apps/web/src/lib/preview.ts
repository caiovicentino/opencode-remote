// P1-072: auto-preview — client side of the daemon's synthetic `ocr.preview`
// event. Pure helpers so scripts/preview.test.ts can pin them directly.

export interface PreviewPayload {
  sessionID: string;
  url: string;
}

/** http/https only, ≤2048 chars — same contract as the daemon's browseTarget.
 * Kept local to the web bundle: apps/daemon sources are outside this app's
 * tsconfig root, and the daemon module pulls node builtins with it. */
export function normalizeHttpUrl(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Extracts {sessionID, url} from a daemon `ocr.preview` event envelope.
 * Returns null for anything else (unknown events are ignored, never thrown).
 */
export function previewFromEvent(
  evt: { type?: string; properties?: unknown } | null | undefined,
): PreviewPayload | null {
  if (!evt || evt.type !== "ocr.preview") return null;
  const props = (evt.properties ?? {}) as { sessionID?: unknown; url?: unknown };
  if (typeof props.sessionID !== "string" || !props.sessionID) return null;
  const url = normalizeHttpUrl(typeof props.url === "string" ? props.url : "");
  if (!url) return null;
  return { sessionID: props.sessionID, url };
}
