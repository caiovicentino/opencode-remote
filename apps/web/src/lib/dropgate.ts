/**
 * P3-398: OS file-drop decision logic for the surfaces ChatView's own window
 * listeners leave uncovered. Pure on purpose — no React, no DOM, no fetch,
 * no I/O — in the spirit of pasteattach.ts and composer.ts: App converts the
 * DOM DragEvent into this module's plain inputs (which surface the user is
 * on, whether the shell bridge is present, how many files arrived) and acts
 * on the verdict, and scripts/unit.test.ts pins the full table so a drop can
 * never regress into a silent nothing.
 *
 * The gesture being fixed: dragging a file from the Finder onto the Home or
 * the first-boot gate used to be swallowed in silence — the only window-level
 * drop listeners lived in ChatView, mounted just once a session exists.
 *
 * dropVerdict returns exactly one of three actions — "attach" (hand the
 * files to the open chat's composer), "open" (create a conversation and
 * deliver the files to it) or "refuse" (show the short calm reason). The
 * rules, in THIS order:
 *
 *   1. A surface outside the closed set is "refuse" with the invalid reason
 *      — never guessed, fail-closed.
 *   2. The gate ALWAYS refuses: until the app is paired there is no
 *      composer and no conversation to receive a file. The shell bridge
 *      picks the copy — inside the desktop shell the calm warning points at
 *      pairing the machine (and the GateHint toast carries the labeled
 *      "pair now" escape); in a plain browser it points at the QR ceremony.
 *   3. A missing, non-numeric, negative or fractional file count is
 *      "refuse" with the invalid reason — fail-closed for absent or
 *      non-numeric input, never an assumed 0 or 1.
 *   4. Zero files is "refuse" too: the OS announced files (the caller only
 *      reaches here with the Files drag type) but delivered none — saying
 *      so beats the old silence.
 *   5. A quantity above the per-drop ceiling is "refuse" — never silently
 *      attaching just the first ones (same product rule as pasteattach).
 *   6. Home is "open": the drop creates the conversation and the files ride
 *      the same fresh-identity traversal paneArtifact uses (App holds them,
 *      the newly mounted ChatView adopts and uploads via attachFile — no new
 *      upload path). Chat is "attach": the composer receives the files.
 */

/** How many files a single drop may carry — matches the four attachment
 * chips the composer strip can actually show (pasteattach's ceiling). */
export const DROP_MAX_FILES = 4;

/** Static i18n reason keys (resolved through apps/web/src/lib/i18n.ts). */
export const DROP_REFUSE_NO_FILES = "dropNoFiles";
export const DROP_REFUSE_TOO_MANY = "dropTooMany";
export const DROP_REFUSE_INVALID = "dropInvalid";
export const DROP_REFUSE_GATE = "dropGateRefuse";
export const DROP_REFUSE_GATE_SHELL = "dropGateShellRefuse";

/** The closed surface set: first-boot gate, paired home (any non-chat view)
 * and the chat itself. */
export type DropSurface = "gate" | "home" | "chat";

export type DropAction = "attach" | "open" | "refuse";

/**
 * P3-398 r2: which surface absorbs an OS file drop, decided from MOUNT truth
 * so a single drop can never be handled twice. While the app is not paired
 * the gate owns the screen. The moment a session exists the persistent
 * ChatView is mounted — its own window drop listeners are live EVEN when a
 * desktop pane (Settings, Artifacts, Files, Browser, Mission Control) is
 * raised above the chat — so the App-level absorber must stand down (null),
 * or one drop would both attach to the current chat and spawn an unwanted
 * new conversation. With no session the home is the visible main surface
 * (HomeView renders exactly there) and the drop opens a conversation.
 * Unit-tested as a table in scripts/unit.test.ts.
 */
export function dropSurfaceFor(
  phase: string,
  sessionOpen: boolean,
): DropSurface | null {
  if (phase !== "paired") return "gate";
  return sessionOpen ? null : "home";
}

export interface DropVerdict {
  action: DropAction;
  /** Static reason key (i18n) when action is "refuse", otherwise "". */
  reason: string;
}

const SURFACES: readonly string[] = ["gate", "home", "chat"];

/** Pure verdict for one OS file drop. See the header for the rule order; the
 * ceiling defaults to this module's documented constant. */
export function dropVerdict(
  surface: unknown,
  shellBridge: unknown,
  count: unknown,
  maxFiles: number = DROP_MAX_FILES,
): DropVerdict {
  // rule 1 — unknown surface: refuse, never guess
  if (typeof surface !== "string" || !SURFACES.includes(surface)) {
    return { action: "refuse", reason: DROP_REFUSE_INVALID };
  }
  // rule 2 — the gate has no composer yet: always refuse, copy per bridge
  if (surface === "gate") {
    return {
      action: "refuse",
      reason: shellBridge === true ? DROP_REFUSE_GATE_SHELL : DROP_REFUSE_GATE,
    };
  }
  // rule 3 — absent or non-numeric count: fail-closed
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0 || !Number.isInteger(count)) {
    return { action: "refuse", reason: DROP_REFUSE_INVALID };
  }
  // rule 4 — the OS announced files but delivered none
  if (count === 0) {
    return { action: "refuse", reason: DROP_REFUSE_NO_FILES };
  }
  // rule 5 — quantity ceiling: refuse, never silently truncate
  if (count > maxFiles) {
    return { action: "refuse", reason: DROP_REFUSE_TOO_MANY };
  }
  // rule 6 — home opens a conversation with the files, chat attaches them
  return { action: surface === "home" ? "open" : "attach", reason: "" };
}
