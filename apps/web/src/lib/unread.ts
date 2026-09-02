// P3-053: dock unread badge derivation (Claude Desktop parity). A message
// landing in the open conversation must show on the dock badge — but only
// when the reader could not see it arrive: window blurred, or scrolled away
// from the tail. The state machine itself is pure (no DOM, no Electron) so
// scripts/unit.test.ts can drive every transition; only `sendUnreadToShell`
// touches the outside world.

export interface UnreadState {
  /** Window focus (document.hasFocus / focus-blur events). */
  focused: boolean;
  /** Reader is parked at the conversation tail (P2-049 atBottom). */
  atEnd: boolean;
  /** Messages that arrived unread. Never negative, never spuriously reset. */
  count: number;
}

export type UnreadEvent =
  /** A new message bubble landed at the tail of the open conversation. */
  | { kind: "message" }
  /** The window gained OS focus — the reader is back: badge clears. */
  | { kind: "focus" }
  /** The window lost OS focus — arrivals from now on are unread. */
  | { kind: "blur" }
  /** The reader jumped to (or away from) the tail; reaching it reads all. */
  | { kind: "atEnd"; atEnd: boolean }
  /** The open session changed — the fresh conversation starts fully read. */
  | { kind: "reset" };

export function initialUnreadState(focused: boolean, atEnd: boolean): UnreadState {
  return { focused, atEnd, count: 0 };
}

export function reduceUnread(state: UnreadState, evt: UnreadEvent): UnreadState {
  switch (evt.kind) {
    case "message":
      // Focused and parked at the tail means the message was seen streaming
      // in — the count stays at zero instead of regressing below it.
      if (state.focused && state.atEnd) return state;
      return { ...state, count: state.count + 1 };
    case "focus":
      return { ...state, focused: true, count: 0 };
    case "blur":
      return { ...state, focused: false };
    case "atEnd":
      return evt.atEnd ? { ...state, atEnd: true, count: 0 } : { ...state, atEnd: false };
    case "reset":
      return { ...state, count: 0 };
  }
}

/** Pushes the current count through the desktop shell bridge (preload
 * P3-053). Absent in plain browsers, and any bridge failure is swallowed —
 * the badge is cosmetic and must never break the chat. */
export function sendUnreadToShell(count: number): void {
  try {
    const bridge = (window as unknown as {
      ocrDesktop?: { sendUnread?: (n: number) => void };
    }).ocrDesktop;
    bridge?.sendUnread?.(count);
  } catch {
    // no shell, or the bridge rejected — badge stays as-is
  }
}
