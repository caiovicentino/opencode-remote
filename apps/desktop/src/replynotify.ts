// Pure decision logic for the agent-reply notification (P2-326). Kept free of
// electron and node:fs imports — no timers, no I/O, same hygiene as badge.ts
// and notify.ts — so scripts/unit.test.ts can exercise it directly: main.ts
// hands it the previous unread push, the new one, whether the main window is
// visible AND focused, the current instant and the instant of the last
// notification, and gets back a closed-set verdict — notify (with a short
// static pt-BR body) or stay quiet.
//
// Rules, in THIS order (a later rule can never rescue an earlier "quiet"):
//   1. A malformed count — absent, non-numeric, non-finite, fractional or
//      negative — is quiet (fail closed, the badge.ts sanitization spirit):
//      only a real integer rise counts.
//   2. A visible, focused window is quiet — the user is already reading.
//   3. Only a real rise (next > prev) may notify; equal or falling is quiet.
//   4. A second notification respects the documented minimum interval
//      (REPLY_NOTIFY_MIN_INTERVAL_MS); the first one (no previous instant)
//      is allowed immediately. A last instant in the future reads as "just
//      notified" — the age is never negative.
// The body is one static pt-BR phrase: no conversation title, no message
// excerpt, no path, no secret — the notification says THAT the agent replied,
// never WHAT it said.
//
// Order contract with main.ts (P1-081 rationale): under the hermetic test
// session (OCR_DESKTOP_SESSION) the shell logs the verdict and NEVER builds
// the native notification — the test-session rule is consulted FIRST, before
// any Notification is constructed, so the operator's screen never sees a test
// artifact. This module stays pure; enforcing that order is main.ts's job,
// proven by a source test in scripts/unit.test.ts.

/** What the shell should do after an unread push. */
export type ReplyNotifyKind = "notify" | "quiet";

export interface ReplyNotifyDecision {
  kind: ReplyNotifyKind;
  /** Static pt-BR body; empty when quiet. */
  body: string;
  /** Static reason for the desktop.log line — never carries counts or content. */
  reason: string;
}

/** Native notification title — the app name, same surface as notify.ts. */
export const REPLY_NOTIFY_TITLE = "OpenCode Remote";
/** The one static body — says the agent replied, nothing about the content. */
export const REPLY_NOTIFY_BODY = "o agente respondeu — abra o OpenCode Remote";
/** Documented minimum interval between two reply notifications: a burst of
 * replies is one notification, never a barrage (the badge carries the count). */
export const REPLY_NOTIFY_MIN_INTERVAL_MS = 60_000;

/** A malformed count is unusable rather than guessed: anything that is not a
 * non-negative finite integer returns null (fail closed). Unlike the
 * badge — where a fractional count floors and still shows — a notification is
 * a one-shot interruption, so a malformed payload never earns one. */
function sanitizeUnread(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    return null;
  }
  return raw;
}

/**
 * Decide whether an unread push deserves a reply notification. Pure and
 * deterministic: the same inputs always return the same verdict.
 */
export function replyNotifyDecision(
  prevRaw: unknown,
  nextRaw: unknown,
  windowFocused: boolean,
  now: number,
  lastNotifiedAt: number | null,
): ReplyNotifyDecision {
  const prev = sanitizeUnread(prevRaw);
  const next = sanitizeUnread(nextRaw);
  if (prev === null || next === null) {
    return { kind: "quiet", body: "", reason: "unread count malformed" };
  }
  if (windowFocused) {
    return { kind: "quiet", body: "", reason: "window visible and focused" };
  }
  if (next <= prev) {
    return { kind: "quiet", body: "", reason: "unread count did not rise" };
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    return { kind: "quiet", body: "", reason: "current instant malformed" };
  }
  if (
    typeof lastNotifiedAt === "number" &&
    Number.isFinite(lastNotifiedAt) &&
    now - lastNotifiedAt < REPLY_NOTIFY_MIN_INTERVAL_MS
  ) {
    return { kind: "quiet", body: "", reason: "inside the minimum interval" };
  }
  return { kind: "notify", body: REPLY_NOTIFY_BODY, reason: "reply arrived out of focus" };
}
