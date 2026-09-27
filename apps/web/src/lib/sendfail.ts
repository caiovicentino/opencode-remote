// eval-10: what a failed prompt POST means. opencode's POST
// /session/:id/message holds the response open until the whole turn ends
// ("streaming the AI response"), and the daemon awaits it before answering
// the op — so the client's default 60 s op timeout fired on every turn longer
// than a minute. ChatView read that timeout as "offline", queued the text and
// the queue flush POSTed it again: the agent received the same prompt twice
// (hermetic repro: a 75 s turn → 2 POSTs at +0 s and +60.3 s, two user
// bubbles). Pure so scripts/pwa-mobile-ux.test.ts pins the decision.

/** Op timeout for the prompt POST — the daemon answers only when the turn ends.
 * Offline detection never depended on it: a dead socket trips the ack
 * watchdog (~6.5 s) and a rehandshake bounds in-flight ops to 8 s. */
export const SEND_TIMEOUT_MS = 30 * 60_000;

/**
 * - "delivered": opencode already echoed the user message (message.updated,
 *   role user) — the prompt is in the conversation; never resend, the stream
 *   and the history carry the rest of the turn.
 * - "queue": no echo and there is text — safe to hold it for the reconnect
 *   flush (the historical offline path).
 * - "error": no echo and nothing re-sendable (attachment-only turn).
 */
export type SendFailPlan = "delivered" | "queue" | "error";

export function sendFailurePlan(input: { echoed: boolean; hasText: boolean }): SendFailPlan {
  if (input.echoed) return "delivered";
  return input.hasText ? "queue" : "error";
}
