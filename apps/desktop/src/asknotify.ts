// Pure decision logic for the pending-approval notification (P3-399). Kept
// free of electron and node:fs imports — no timers, no I/O, same hygiene as
// replynotify.ts — so scripts/unit.test.ts can exercise it directly: main.ts
// hands it the previous pending-ask count, the new one, whether the main
// window is visible AND focused, the current instant and the instant of the
// last notification, and gets back a closed-set verdict — notify (with a
// short static pt-BR body) or stay quiet.
//
// When the agent stops to wait for human approval and the window sits in the
// background, work is parked and nobody knows — the inverse of the P2-326
// reply case, and the worse of the two because here the human is the blocker.
//
// Rules, in THIS order (a later rule can never rescue an earlier "quiet"):
//   1. A malformed count — absent, non-numeric, non-finite, fractional or
//      negative — is quiet (fail closed, the replynotify.ts discipline):
//      only a real integer rise counts.
//   2. A visible, focused window is quiet — the user is already looking at
//      the approval card.
//   3. Only a real rise (next > prev) may notify; equal or falling is quiet
//      (an ask being answered must never toast).
//   4. A second notification respects the documented minimum interval
//      (ASK_NOTIFY_MIN_INTERVAL_MS); the first one (no previous instant) is
//      allowed immediately. A last instant in the future reads as "just
//      notified" — the age is never negative.
// The body is one static pt-BR phrase: no command, no file path, no
// conversation title, no secret — the notification says THAT the agent is
// waiting for approval, never WHAT it is waiting to approve.
//
// Order contract with main.ts (P1-081 rationale): under the hermetic test
// session (OCR_DESKTOP_SESSION) the shell logs the verdict and NEVER builds
// the native notification — the test-session rule is consulted FIRST, before
// any Notification is constructed, so the operator's screen never sees a test
// artifact. This module stays pure; enforcing that order is main.ts's job,
// proven by a source test in scripts/unit.test.ts.

/** What the shell should do after a pending-ask push. */
export type AskNotifyKind = "notify" | "quiet";

export interface AskNotifyDecision {
  kind: AskNotifyKind;
  /** Static pt-BR body; empty when quiet. */
  body: string;
  /** Static reason for the desktop.log line — never carries counts or content. */
  reason: string;
}

/** Native notification title — the app name, same surface as notify.ts. */
export const ASK_NOTIFY_TITLE = "OpenCode Remote";
/** The one static body — says the agent asks approval, nothing about the work. */
export const ASK_NOTIFY_BODY = "o agente pede sua aprovação — abra o OpenCode Remote";
/** Documented minimum interval between two ask notifications: several asks in
 * a row are one notification, never a barrage (the chat holds the cards). */
export const ASK_NOTIFY_MIN_INTERVAL_MS = 60_000;

/** A malformed count is unusable rather than guessed: anything that is not a
 * non-negative finite integer returns null (fail closed). Unlike a badge —
 * where a fractional count floors and still shows — a notification is a
 * one-shot interruption, so a malformed payload never earns one. Exported
 * because main.ts stores the last known-good push as the previous count and
 * must not let a malformed frame poison it. */
export function sanitizeAskCount(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    return null;
  }
  return raw;
}

/**
 * Decide whether a pending-ask push deserves an approval notification. Pure
 * and deterministic: the same inputs always return the same verdict.
 */
export function askNotifyDecision(
  prevRaw: unknown,
  nextRaw: unknown,
  windowFocused: boolean,
  now: number,
  lastNotifiedAt: number | null,
): AskNotifyDecision {
  const prev = sanitizeAskCount(prevRaw);
  const next = sanitizeAskCount(nextRaw);
  if (prev === null || next === null) {
    return { kind: "quiet", body: "", reason: "pending ask count malformed" };
  }
  if (windowFocused) {
    return { kind: "quiet", body: "", reason: "window visible and focused" };
  }
  if (next <= prev) {
    return { kind: "quiet", body: "", reason: "pending ask count did not rise" };
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    return { kind: "quiet", body: "", reason: "current instant malformed" };
  }
  if (
    typeof lastNotifiedAt === "number" &&
    Number.isFinite(lastNotifiedAt) &&
    now - lastNotifiedAt < ASK_NOTIFY_MIN_INTERVAL_MS
  ) {
    return { kind: "quiet", body: "", reason: "inside the minimum interval" };
  }
  return { kind: "notify", body: ASK_NOTIFY_BODY, reason: "approval requested out of focus" };
}
