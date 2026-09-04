// Pure decision logic for the one-time close-to-tray hint (P2-152). Kept free
// of electron imports so scripts/unit.test.ts can exercise it (same pattern as
// tray.ts / notify.ts / badge.ts): main.ts hands it the platform and the raw
// persisted flag and gets back whether — and what — to notify when the user
// closes the window to the tray for the first time.

import { join } from "node:path";

/** What the shell should do on a non-quitting window close. */
export type CloseHintKind = "notify" | "none";

export interface CloseHintPlan {
  kind: CloseHintKind;
  title: string;
  body: string;
}

/** Exact-match sentinel persisted in userData/close-hint.flag once the hint
 * has been shown (same convention as the P2-148 welcome flag). */
export const CLOSE_HINT_SENTINEL = "1";

/** Unique desktop.log marker the desktop-flow gate counts (P2-152). */
export const CLOSE_HINT_LOG = "[desktop] close-to-tray hint shown";

export const CLOSE_HINT_TITLE = "OpenCode Remote continua rodando";
/** darwin body: the tray lives in the menu bar there. */
export const CLOSE_HINT_BODY_MENUBAR =
  "A janela fechou, mas o app segue na barra de menus. Clique no ícone para abrir de novo.";
/** win32/linux body — and the generic fallback for any other platform. */
export const CLOSE_HINT_BODY_TRAY =
  "A janela fechou, mas o app segue na bandeja do sistema. Clique no ícone para abrir de novo.";

/**
 * Decide what a non-quitting window close should surface: any flag value other
 * than the exact sentinel (absent, empty, corrupted) counts as "not shown yet"
 * — fail-open, P2-148 lesson: at worst the hint shows again, it never gets
 * lost forever. darwin points at the menu bar, win32/linux (and anything
 * unknown) at the system tray.
 */
export function closeHintPlan(platform: string, flag: string | null | undefined): CloseHintPlan {
  if (flag === CLOSE_HINT_SENTINEL) return { kind: "none", title: "", body: "" };
  const body = platform === "darwin" ? CLOSE_HINT_BODY_MENUBAR : CLOSE_HINT_BODY_TRAY;
  return { kind: "notify", title: CLOSE_HINT_TITLE, body };
}

/** Where the shown-once flag lives: userData root, same shape as
 * windowStateFile() in window-state.ts. */
export function hintFlagPath(userDataDir: string): string {
  return join(userDataDir, "close-hint.flag");
}

/** Read the raw flag through the injected sink; a missing file, a bad disk or
 * any throw reads as "not shown yet" (null) — the decision stays fail-open. */
export function readHintFlag(read: () => string): string | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** Stamp the flag through the injected sink; false when the write throws so
 * the caller can log-and-continue instead of taking the shell down. */
export function writeHintFlag(write: (value: string) => void): boolean {
  try {
    write(CLOSE_HINT_SENTINEL);
    return true;
  } catch {
    return false;
  }
}
