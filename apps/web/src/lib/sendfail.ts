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

/**
 * eval-10 verify round: is this user message the echo of the prompt in
 * flight? Any NEW user-message id used to mark it delivered — but opencode
 * re-emits old user messages (a session switch replays the conversation) and
 * prompts can arrive from another device, so a stale sighting swallowed the
 * resend: the prompt vanished without queue or error. A message counts as
 * the echo only when it was created at or after the send. `time.created`
 * travels as epoch ms (the daemon's own parsers bet on ms), seconds are
 * tolerated, ISO strings parse; a missing or unparsable timestamp keeps the
 * old behavior (fail-open — never worse than today) instead of risking a
 * resend that would run the whole turn twice.
 */
export const ECHO_CLOCK_SKEW_MS = 2 * 60_000;

export function echoIsFresh(
  info: { time?: { created?: unknown } } | undefined,
  sentAt: number,
): boolean {
  const raw = info?.time?.created;
  const ms =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw < 1e11
        ? raw * 1000
        : raw
      : typeof raw === "string" && raw
        ? Date.parse(raw)
        : NaN;
  if (!Number.isFinite(ms)) return true;
  return ms >= sentAt - ECHO_CLOCK_SKEW_MS;
}
