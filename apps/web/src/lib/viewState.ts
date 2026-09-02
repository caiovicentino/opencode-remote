// P1-046: single source of truth for app navigation. Replaces the five
// boolean view flags (session/settings/filesView/artifactsView/browserView)
// whose independent toggles let two rail buttons be active at once and let
// opening a pane destroy the open chat. Pure and dependency-free so
// scripts/unit.test.ts can exercise it directly.

export type Slot = "chat" | "artifacts" | "browser" | "files" | "settings" | "share" | "mission";

/** Slots rendered in the desktop right-hand pane (everything but the chat). */
export const PANE_SLOTS: readonly Slot[] = ["artifacts", "browser", "files", "settings", "share", "mission"];

export interface ViewState {
  /** Navigation history, no duplicates; the last entry is the visible slot. */
  stack: Slot[];
  /** Open conversation — never cleared by opening a pane. */
  chatSession: string | null;
}

export type ViewAction =
  | { type: "open"; slot: Slot }
  | { type: "openChat"; sessionId: string }
  | { type: "closeChat" }
  | { type: "back" }
  | { type: "replace"; slot: Slot }
  | { type: "reset" };

export const initialViewState: ViewState = { stack: [], chatSession: null };

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case "open": {
      // Raising a pane moves it to the top of the history and keeps everything
      // else — in particular the chat. Idempotent when already on top.
      const stack = state.stack.filter((s) => s !== action.slot);
      stack.push(action.slot);
      return { ...state, stack };
    }
    case "openChat":
      // A fresh chat navigation replaces the history: mobile back from the
      // chat lands on the sessions board, like the pre-reducer goBack did.
      return { stack: ["chat"], chatSession: action.sessionId };
    case "closeChat":
      return { stack: state.stack.filter((s) => s !== "chat"), chatSession: null };
    case "back": {
      const top = state.stack[state.stack.length - 1];
      if (!top) return state;
      const stack = state.stack.slice(0, -1);
      // Popping the chat slot closes the conversation with it.
      return { stack, chatSession: top === "chat" ? null : state.chatSession };
    }
    case "replace": {
      // Swap the visible slot in place (tab semantics: settings <-> files).
      const rest = state.stack.slice(0, -1).filter((s) => s !== action.slot);
      return { ...state, stack: [...rest, action.slot] };
    }
    case "reset":
      // disconnect / switchMachine: the only paths besides closeChat/back that
      // clear chatSession.
      return { stack: [], chatSession: null };
  }
}

/** The visible slot; the home screen (empty stack) behaves as the chat. */
export function topSlot(state: ViewState): Slot {
  return state.stack[state.stack.length - 1] ?? "chat";
}

/**
 * Rail painting: exactly the top slot, so two active buttons at once is
 * structurally impossible (the P1-046 bug this replaces).
 */
export function activeSlots(state: ViewState): Set<Slot> {
  return new Set([topSlot(state)]);
}

/** True while the right-hand desktop pane has content to show. */
export function isPaneOpen(state: ViewState): boolean {
  return PANE_SLOTS.includes(topSlot(state));
}
