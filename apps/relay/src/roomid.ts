/**
 * Room id validation for the relay (P2-019).
 *
 * The relay is a blind router, so a room id is the only envelope field it
 * must trust structurally: every distinct id allocates an entry in the
 * rooms map. Without a grammar, one socket could grow that map at will
 * (memory DoS on the public hosted relay). The grammar is the daemon's
 * generation rule generalized: `randomUUID().replaceAll("-", "")` is
 * 32 lowercase hex chars, but user-configured ids and the relay probe use
 * the wider URL-safe charset, so accept [A-Za-z0-9_-] with sane length
 * bounds and let everything else be dropped before it can allocate state.
 */

export const ROOM_ID_MIN = 8;
export const ROOM_ID_MAX = 128;

/** Max distinct rooms a single socket may occupy (re-joins are free). */
export const MAX_ROOMS_PER_SOCKET = 8;

const ROOM_ID_RE = /^[A-Za-z0-9_-]+$/;

/** True when `room` is a string in the accepted room-id grammar. */
export function isValidRoomId(room: unknown): room is string {
  return (
    typeof room === "string" &&
    room.length >= ROOM_ID_MIN &&
    room.length <= ROOM_ID_MAX &&
    ROOM_ID_RE.test(room)
  );
}
