// P3-406: the quick-entry decision — what the shell's global shortcut (the
// one key that reveals the window from anywhere) should do ON the revealed
// window. Pure on purpose — no React, no DOM, no fetch, no I/O — in the
// spirit of dropgate.ts and gatequeue.ts: App converts its live state into
// this module's plain inputs and acts on the verdict, and
// scripts/unit.test.ts pins the full table so a shortcut can never regress
// into focus theft or a runaway conversation factory.
//
// The gesture being fixed: the global hotkey only brought the window back,
// and the only "new conversation" action (go-new-chat) needed the app
// focused AND left the composer unfocused. Claude-Desktop-grade quick entry
// is one key → typing into a conversation.

/** Documented minimum interval between two accepted fires — an immediate
 * double-press (or a menu accelerator racing the system-wide one) collapses
 * into one action instead of spawning two conversations. Long enough to
 * swallow a bounce, short enough to feel instant to a human. */
export const QUICK_ENTRY_MIN_MS = 800;

/** The closed surface set App can ask about. */
export type QuickSurface =
  | "empty-chat" // paired, a conversation is open and has no messages
  | "chat" // paired, the open conversation has messages (or none is open)
  | "gate" // the degraded first-boot card with the offline queue composer
  | "pairing" // the pairing ceremony (manual paste/scan, remote QR, machine picker)
  | "wizard"; // the first-run welcome wizard

/** The closed verdict set. */
export type QuickAction =
  /** Focus the composer of the empty conversation already open. */
  | "focus-composer"
  /** Create a conversation and focus its composer. */
  | "create"
  /** Focus the offline first-message queue box on the degraded gate. */
  | "focus-queue"
  /** Only show the window — never steal focus (pairing, wizard, invalid). */
  | "show-only"
  /** Within the minimum interval of the last fire: do nothing. */
  | "ignore";

const SURFACES: readonly string[] = ["empty-chat", "chat", "gate", "pairing", "wizard"];

/**
 * Pure verdict for one quick-entry fire. Rules, in THIS order:
 *
 *  1. any invalid input — an unknown surface, a non-finite/negative instant
 *     or a bad minimum interval — fails closed to "show-only": the shell has
 *     already revealed the window, and that is ALL an untrusted input can
 *     ever get (never a guessed focus target);
 *  2. a fire within QUICK_ENTRY_MIN_MS of the accepted previous one is
 *     "ignore" — the half-open interval means a fire EXACTLY at the boundary
 *     passes (now - last === min is not "within");
 *  3. the surface decides: empty-chat focuses its composer, chat creates a
 *     conversation, gate focuses the offline queue box, pairing and wizard
 *     are show-only (the ceremony owns the screen — no focus theft).
 */
export function quickEntryVerdict(
  surface: unknown,
  now: unknown,
  lastFire: unknown,
  minIntervalMs: number = QUICK_ENTRY_MIN_MS,
): QuickAction {
  if (typeof surface !== "string" || !SURFACES.includes(surface)) return "show-only";
  if (typeof now !== "number" || !Number.isFinite(now) || now < 0) return "show-only";
  if (typeof minIntervalMs !== "number" || !Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
    return "show-only";
  }
  // A never-fired App passes 0: the interval from 0 always passes.
  if (typeof lastFire !== "number" || !Number.isFinite(lastFire) || lastFire < 0) return "show-only";
  if (now - lastFire < minIntervalMs) return "ignore";
  switch (surface) {
    case "empty-chat":
      return "focus-composer";
    case "chat":
      return "create";
    case "gate":
      return "focus-queue";
    case "pairing":
    case "wizard":
      return "show-only";
  }
  return "show-only";
}

/** Everything App knows at fire time, reduced to the closed surface set.
 * Precedence mirrors the render order: the wizard covers every phase, the
 * machine picker covers even a paired phase, and only then does the degraded
 * gate (either render — the gate-shell skeleton or the full calm card, both
 * carrying the offline queue composer) or the plain pairing wall decide.
 * Paired with no open conversation the quick entry has nothing to focus —
 * that is the "create" surface. */
export function quickSurfaceFor(input: {
  phase: string;
  welcome: boolean;
  addingMachine: boolean;
  pairManual: boolean;
  /** The first-boot gate-shell skeleton (wide viewport, nothing stored). */
  gateShellUp: boolean;
  /** The full-card degraded journey (same shell, narrow viewport or a
   * returning user with stored pairing whose daemon is down) — it renders the
   * SAME offline queue composer, so it answers "gate" too. */
  degradedCard: boolean;
  sessionOpen: boolean;
  sessionEmpty: boolean;
}): QuickSurface {
  if (input.phase !== "paired") {
    if (input.welcome) return "wizard";
    if (input.addingMachine || input.pairManual) return "pairing";
    if (input.gateShellUp || input.degradedCard) return "gate";
    return "pairing";
  }
  if (input.addingMachine) return "pairing";
  return input.sessionOpen ? (input.sessionEmpty ? "empty-chat" : "chat") : "chat";
}
