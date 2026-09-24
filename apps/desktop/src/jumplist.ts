// Pure Dock-menu / Jump-List specification (P2-353). Same module hygiene as
// menu.ts, tray.ts and badge.ts: NO electron, NO node:fs, no I/O, no timer —
// the only import is the ShellLabels type — so scripts/unit.test.ts can
// exercise every branch in plain Node. main.ts is the only place that
// translates these descriptors into the real system surfaces (app.dock.setMenu
// on darwin, app.setUserTasks on win32) and that interprets the dedicated argv
// flag in the second-instance handler and in the cold-start argv.

import type { ShellLabels } from "./shelllang";

/** The dedicated argv flag a Jump List task (and every relaunch it can
 * produce — a second instance or a cold start) carries. One constant here so
 * main.ts, this module and the unit test can never drift apart on the exact
 * spelling. */
export const NEW_CHAT_FLAG = "--ocr-new-chat";

/** The renderer action id the item fires — the same one the Go menu's
 * go-new-chat broadcasts over ocr:menu-action (the P1-046 contract). */
export const NEW_CHAT_ACTION = "newChat";

/** Plain-data dock item: everything Menu.buildFromTemplate needs except the
 * click wiring, which main.ts attaches from the action contract — byte-a-byte
 * the Go menu behavior, so the renderer keeps one path for the action. */
export interface DockMenuItemSpec {
  /** The visible label — the same phrase the Go menu shows (P2-276). */
  label: string;
  /** Renderer action id broadcast over ocr:menu-action. */
  action: string;
}

/** Plain-data Jump List task. main.ts adds the Electron-only fields (icon
 * path/index, the space-joined arguments string) at the single translation
 * point, so this module carries no Electron vocabulary at all. */
export interface UserTaskSpec {
  /** Visible title in the taskbar's right-click menu. */
  title: string;
  /** Hover description — the same phrase, never a second copy to drift. */
  description: string;
  /** The executable the task relaunches (the packaged app itself). */
  program: string;
  /** The dedicated argv flag. */
  args: string[];
}

/** The macOS Dock menu: exactly ONE item — "Nova conversa" — wired to the
 * newChat action. Pure and deterministic: the same labels always produce the
 * same single-item menu. */
export function dockMenuSpec(labels: ShellLabels): DockMenuItemSpec[] {
  return [{ label: labels.menu.newChat, action: NEW_CHAT_ACTION }];
}

/**
 * The Windows Jump List user task: exactly ONE task that relaunches the
 * packaged app with the dedicated flag. An unpackaged dev run registers
 * nothing — the OS task would launch a binary the installer never registered.
 * Pure and deterministic: same inputs, same list.
 */
export function windowsUserTasks(execPath: string, isPackaged: boolean, labels: ShellLabels): UserTaskSpec[] {
  if (!isPackaged) return [];
  return [
    {
      title: labels.menu.newChat,
      description: labels.menu.newChat,
      program: execPath,
      args: [NEW_CHAT_FLAG],
    },
  ];
}

/** Whether an argv carries EXACTLY the dedicated flag — a lookalike argument
 * (a longer spelling, a different dash count) never matches, so a real Jump
 * List relaunch is the only thing this rule answers. Pure and deterministic. */
export function hasNewChatFlag(argv: readonly string[]): boolean {
  return Array.isArray(argv) && argv.some((arg) => arg === NEW_CHAT_FLAG);
}
