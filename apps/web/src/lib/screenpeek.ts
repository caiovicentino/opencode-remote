// Screen-peek decisions (P3-404). Pure on purpose — no React, no DOM, no
// fetch — in the spirit of pasteattach.ts: ChatView/App convert the raw
// event payloads and timestamps into this module's plain shape and act on
// the verdict, and scripts/unit.test.ts pins the tables so the flow cannot
// regress into capturing without consent or waiting forever without an
// escape.
//
// Privacy posture (same as the voice/camera features): ONE frame per
// explicit request, NEVER streaming or periodic. The shell only captures
// when a `screen.capture-requested` event carries a fresh, well-formed
// request; the phone only waits a bounded time and then shows the labeled
// manual escape (open the desktop app) instead of spinning.

/** How long a capture request stays fresh for the shell — a stale event
 * must never trigger a capture. */
export const SCREEN_REQUEST_TTL_MS = 30_000;

/** How long the phone's card waits for a frame before the labeled escape. */
export const SCREEN_WAIT_TIMEOUT_MS = 20_000;

export type CaptureRequestVerdict = "capture" | "stale" | "foreign";

/**
 * Decides whether THIS client should act on a `screen.capture-requested`
 * event. Only the desktop shell captures (it is the TCC-responsible
 * context); the phone always answers "foreign". A missing/non-numeric
 * timestamp or an older-than-TTL request fails closed to "stale" — never a
 * capture from a replayed or malformed event.
 */
export function captureRequestVerdict(
  props: unknown,
  desktopShell: boolean,
  now: number,
  ttlMs: number = SCREEN_REQUEST_TTL_MS,
): CaptureRequestVerdict {
  if (!desktopShell) return "foreign";
  const p = (props ?? {}) as { requestId?: unknown; at?: unknown };
  if (typeof p.requestId !== "string" || !p.requestId) return "stale";
  if (typeof p.at !== "number" || !Number.isFinite(p.at)) return "stale";
  if (now - p.at > ttlMs || now - p.at < -5_000) return "stale";
  return "capture";
}

export type ScreenWaitVerdict = "waiting" | "timeout";

/** Bounded wait on the phone: past the timeout the card must show the
 * labeled escape instead of a spinner. */
export function screenWaitVerdict(
  startedAt: number,
  now: number,
  timeoutMs: number = SCREEN_WAIT_TIMEOUT_MS,
): ScreenWaitVerdict {
  return now - startedAt > timeoutMs ? "timeout" : "waiting";
}

/** Static i18n keys for a `screen.capture-failed` reason (the daemon
 * truncates and defaults the reason; unknown shapes fail to "unknown"). */
export function screenFailKey(reason: unknown): string {
  switch (reason) {
    case "blocked-by-system":
      return "screenPeekFailBlocked";
    case "will-ask":
      return "screenPeekFailWillAsk";
    default:
      return "screenPeekFailUnknown";
  }
}

/**
 * Decode a stored frame into a File for the ask-about-the-screen flow —
 * the frame rides the EXISTING attachment pipeline (attachImage →
 * ocr-upload://), so the phone needs the bytes as a real File. Returns
 * null when the base64 payload is malformed (fail closed, never a broken
 * attachment).
 */
export async function frameToFile(b64: string, mime: string, at: number): Promise<File | null> {
  try {
    const clean = b64.replace(/\s/g, "");
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) return null;
    return new File([bytes], `tela-${at}.jpg`, { type: mime || "image/jpeg" });
  } catch {
    return null;
  }
}
