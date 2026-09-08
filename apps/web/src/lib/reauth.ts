/**
 * Bug 1 (silent crypto death), client side. Pure decisions behind the
 * `session-reauth-required` control frame the daemon now answers auth
 * failures with (apps/daemon/src/reauth.ts): what the client does on receipt
 * and which storage keys the "pair again" button is allowed to wipe.
 *
 * No DOM, no sockets, no crypto, no timers — scripts/reauth.test.ts drives
 * every branch in plain Node (same hygiene as framegate.ts).
 *
 * The frame is CLEAR and the relay room id leaks by design, so a room member
 * can forge it. The rules therefore never wipe anything on their own:
 *  - paired: the frame is a hint — verify with a ping over the current
 *    session (a sealed pong proves the key is fine → ignored) and only fall
 *    into a rehandshake when nothing sealed answers in time (client.ts reuses
 *    the RT-341 hint-verify path exactly, no new rehandshake call site);
 *  - connecting after a hello went out: the daemon refused OUR hello. One
 *    strike retries a fresh dial (a lost frame / a race must not cost the
 *    pairing); the second consecutive strike is the verdict "expired";
 *  - anything else (connecting before a hello, closed, rejected, expired):
 *    ignored.
 * A confirmed handshake resets the strike count.
 */

/** Consecutive refused hellos before the session counts as expired. */
export const REAUTH_STRIKES = 2;

export type ReauthAction = "verify" | "retry" | "expired" | "ignore";

export function reauthVerdict(status: string, strikes: number, helloSent: boolean): ReauthAction {
  if (status === "paired") return "verify";
  if (status === "connecting" && helloSent) {
    return strikes + 1 >= REAUTH_STRIKES ? "expired" : "retry";
  }
  return "ignore";
}

/** Error message the initial connect() rejects with once the session expired. */
export const REAUTH_ERROR = "session-reauth-required";

/**
 * EVAL4-F2 (fable r4): error message the initial connect() rejects with when
 * the daemon answered `not-allowed` (device revoked, or the bootstrap pairing
 * window is closed). Replaces the old hardcoded English sentence that told a
 * phone user to run `manage.ts revoke-all` — the shell maps this constant to
 * a localized message with a real next step (lib/pairerror.ts).
 */
export const REJECTED_ERROR = "session-rejected";

/**
 * EVAL4-F5 (fable r4): a clear `session-reauth-required` received while
 * CONNECTING (our hello is out) used to count as a strike on the spot. The
 * frame is forgeable by any room member (the room id rides the QR, `from`
 * is client-supplied at the relay), so two forged frames timed with the
 * client's dial cycle could push every phone in the room to the re-pair wall.
 * The frame is now only a hint here too: it shortens the confirm watchdog to
 * this grace window, and the strike is counted when the window closes with
 * NO sealed confirmation — a real refusal is followed by silence, a forged
 * frame is followed by the real confirm.
 */
export const REAUTH_CONFIRM_GRACE_MS = 2_500;

/**
 * EVAL4-F3 (fable r4): minimum delay before the retry dial after a refused
 * hello. The daemon throttles reauth replies to one per sender per 2 s
 * (apps/daemon/src/reauth.ts REAUTH_REPLY_MIN_INTERVAL_MS): the old 1 s
 * retry landed inside that window, its refusal was suppressed, and the
 * client sat on the 15 s confirm watchdog before the second strike — long
 * enough for the initial connect's own 15 s timeout to win and show
 * "pairing timeout" instead of the expired card.
 */
export const REAUTH_RETRY_DELAY_MS = 2_500;

/** What the client does the moment a reauth frame arrives (EVAL4-F5). */
export type ReauthFrameAction = "verify" | "grace" | "ignore";

/**
 * Frame-time decision: paired → verify with a ping (unchanged); connecting
 * with our hello out → arm the grace window (the strike is decided later by
 * reauthVerdict when the window closes unconfirmed); anything else → ignore.
 */
export function reauthFrameAction(status: string, helloSent: boolean): ReauthFrameAction {
  if (status === "paired") return "verify";
  if (status === "connecting" && helloSent) return "grace";
  return "ignore";
}

/** IndexedDB database holding the non-extractable identity + WebAuthn id. */
export const IDENTITY_DB_NAME = "ocr-identity";

/**
 * localStorage keys the "pair again" wipe removes — identity/pairing state
 * and per-pairing caches of THIS app only (the dotted `ocr.` namespace plus
 * the flat flags tied to a pairing). Preferences that belong to the person,
 * not the pairing — language, theme, font, voice, model, agent, TTS — are
 * deliberately kept: a re-pair must not reset the UI to English.
 */
export const IDENTITY_STORAGE_FLAT_KEYS: readonly string[] = ["ocr_unread", "ocr_daemon_seen", "ocr_welcome_done"];

export function isIdentityStorageKey(key: string): boolean {
  return key.startsWith("ocr.") || IDENTITY_STORAGE_FLAT_KEYS.includes(key);
}

/** Subset of `keys` the wipe removes, in input order (never keys of others). */
export function identityStorageKeys(keys: readonly string[]): string[] {
  return keys.filter(isIdentityStorageKey);
}
