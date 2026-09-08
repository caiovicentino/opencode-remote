/**
 * RT-341: decision module for inbound relay frames on the PWA client.
 *
 * The relay room id leaks by design (it rides the QR code), so any room
 * member can send clear control frames with a forged `from`. This module
 * classifies every inbound frame before the client acts on it and keeps all
 * judgement logic pure: no DOM, no sockets, no crypto, no timers.
 */

/** How long a `reconnect` hint waits for a sealed frame before rehandshaking. */
export const RECONNECT_HINT_VERIFY_MS = 1500;

/** Minimum spacing between hint-triggered rehandshakes (hint flood floor). */
export const REHANDSHAKE_MIN_INTERVAL_MS = 10_000;

/** Bug 1: clear control the daemon answers auth failures with (reauth.ts on
 * the daemon side). Unauthenticated like `reconnect` — verified, never obeyed. */
export const REAUTH_CLEAR_TYPE = "session-reauth-required";

/** What the client should do with an inbound frame. */
export type FrameVerdict =
  | "ignore" // not from the daemon / not deliverable
  | "hint" // clear `reconnect` — verify it, never obey it
  | "reauth" // clear `session-reauth-required` — verify (paired) / strike (connecting)
  | "pong-clear" // clear `pong` — proves nothing anymore
  | "confirm" // handshake confirmation (only while connecting)
  | "sealed"; // sealed envelope: res / res-chunk / event / pong

/**
 * Fixed-order classification, one cause per return:
 * 1. missing/self-sourced `from` → ignore
 * 2. `from` outside the daemon (daemon always signs `from: <room>`) → ignore
 * 3. clear `session-reauth-required` → reauth (any status: while connecting
 *    it means the hello itself was refused; while paired it is a hint)
 * 4. not paired yet → the frame can only be the handshake confirmation
 * 5. clear `reconnect` → hint
 * 6. clear `pong` → pong-clear
 * 7. anything else → sealed
 */
export function classifyFrame(opts: {
  from?: string;
  self: string;
  room: string;
  clearType: string | null;
  status: string;
}): FrameVerdict {
  const { from, self, room, clearType, status } = opts;
  if (!from || from === self) return "ignore";
  if (from !== room) return "ignore";
  if (clearType === REAUTH_CLEAR_TYPE) return "reauth";
  if (status !== "paired") return "confirm";
  if (clearType === "reconnect") return "hint";
  if (clearType === "pong") return "pong-clear";
  return "sealed";
}

/**
 * Verdict for a received hint: "verify" arms the one-shot ping + timer; any
 * hint arriving mid-verification, mid-rehandshake or inside the flood floor
 * window is ignored.
 */
export function hintVerdict(
  state: { verifying: boolean; rehandshaking: boolean; lastRehandshakeAt: number },
  now: number,
): "verify" | "ignore" {
  if (state.verifying || state.rehandshaking) return "ignore";
  if (now - state.lastRehandshakeAt < REHANDSHAKE_MIN_INTERVAL_MS) return "ignore";
  return "verify";
}

/** Clear control types the client understands. */
export type ClearControlType = "ping" | "pong" | "reconnect" | typeof REAUTH_CLEAR_TYPE;

/** Tolerant reader for clear control payloads: never throws, never trusts. */
export function readClearControl(json: unknown): ClearControlType | null {
  if (typeof json !== "object" || json === null) return null;
  const type = (json as { type?: unknown }).type;
  if (type === "ping" || type === "pong" || type === "reconnect" || type === REAUTH_CLEAR_TYPE) return type;
  return null;
}
