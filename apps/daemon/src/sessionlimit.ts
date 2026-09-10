// P3-403: per-session sliding-window rate limiter for the daemon's voice-loop
// routes (/__ocr/transcribe, /__ocr/voice/tts). A runaway client must not spin
// whisper or edge-tts forever — the window bounds the per-session cost while
// staying generous for a human pacing a conversation. Pure and clock-injectable
// so the unit battery can walk the window deterministically; the camera-ask
// frame route (P3-402) adopts the same limiter when it lands.

const WINDOW_MS = 60_000;
// defense-in-depth against key churn: past this many tracked sessions the next
// allow() drops fully-expired entries instead of growing without bound
const MAX_KEYS = 512;

export interface SessionLimiter {
  /** Admission verdict for one op on `key` (the session id) at time `at`. */
  allow(key: string, at?: number): boolean;
  /** Ops admitted inside the current window — diagnostics and tests. */
  count(key: string, at?: number): number;
  /** Drops entries with no live hits in the window. */
  prune(at: number): void;
}

export function createSessionLimiter(
  maxPerWindow: number,
  now: () => number = Date.now,
): SessionLimiter {
  const hits = new Map<string, number[]>();
  function prune(at: number): void {
    for (const [key, list] of hits) {
      const alive = list.filter((t) => at - t < WINDOW_MS);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  }
  return {
    allow(key, atArg) {
      const at = atArg ?? now();
      const list = (hits.get(key) ?? []).filter((t) => at - t < WINDOW_MS);
      if (list.length >= maxPerWindow) {
        hits.set(key, list);
        return false;
      }
      list.push(at);
      hits.set(key, list);
      if (hits.size > MAX_KEYS) prune(at);
      return true;
    },
    count(key, atArg) {
      const at = atArg ?? now();
      return (hits.get(key) ?? []).filter((t) => at - t < WINDOW_MS).length;
    },
    prune,
  };
}
