// Pure menu specification (P2-176). Kept free of electron and node:fs imports
// so scripts/unit.test.ts can exercise it (same pattern as tray.ts, badge.ts
// and closehint.ts): main.ts hands it the platform, the update-status label
// already resolved by updateMenuLabel(), the updatesEnabled() verdict and the
// shell label table resolved by shelllang.ts (P2-276), and gets back a plain
// data descriptor — id, label, optional role, optional accelerator, submenu —
// with no Electron types anywhere. buildMenu() in main.ts is the only place
// that translates this descriptor into the Electron template.

import type { HotkeyPlan } from "./hotkey";
import { zoomVerdict } from "./zoomlevel";
import { shellLabels, type ShellLabels } from "./shelllang";

/** The roles the shell relies on. A closed union on purpose: editMenu and
 * windowMenu stay native roles exactly so the OS keeps translating them by
 * itself (P2-176), and the macOS app submenu keeps the system behaviors.
 * P2-238: the zoom roles left the union — the three View items are shell-owned
 * ids now, so the level can be tracked, limited and persisted. */
export type MenuRole =
  | "about"
  | "hide"
  | "quit"
  | "editMenu"
  | "windowMenu"
  | "reload"
  | "forceReload"
  | "toggleDevTools";

/** Plain-data menu item: everything the Electron template needs except the
 * click wiring, which main.ts attaches from the id/action contract. */
export interface MenuItemSpec {
  /** Stable id. The go-* ids are the renderer's menu contract (P1-046) and
   * must never drift; the help-* ids are resolved by main.ts to the same
   * shell handlers the tray items run. */
  id?: string;
  label?: string;
  role?: MenuRole;
  accelerator?: string;
  /** Renderer action id broadcast over ocr:menu-action (P1-046). Present on
   * the Go items; shell-side items (Help submenu) are wired in main.ts by id. */
  action?: string;
  /** Informational-only items (the update status line) render disabled. */
  enabled?: boolean;
  type?: "separator";
  submenu?: MenuItemSpec[];
}

// P2-276: every visible phrase comes from the shelllang.ts table in the
// caller's language — no label lives as a literal in this file anymore.
// Product terms the UI keeps untranslated in both languages stay exactly as
// the table carries them.

/** P2-229: the informational item shown when the global hotkey IS registered
 * (the accelerator renders right beside it). When the plan refuses, the item
 * shows the plan's reason phrase instead — never a lying combination. */
function zoomSubmenu(level: number | undefined, labels: ShellLabels): MenuItemSpec[] {
  const enabled = (current: unknown, action: "increase" | "decrease" | "restore"): boolean | undefined => {
    if (level === undefined) return undefined;
    return !zoomVerdict(current, action).atLimit;
  };
  return [
    { id: "view-zoom-reset", label: labels.menu.zoomReset, accelerator: "CmdOrCtrl+0", enabled: enabled(level, "restore") },
    { id: "view-zoom-in", label: labels.menu.zoomIn, accelerator: "CmdOrCtrl+Plus", enabled: enabled(level, "increase") },
    { id: "view-zoom-out", label: labels.menu.zoomOut, accelerator: "CmdOrCtrl+-", enabled: enabled(level, "decrease") },
  ];
}

/** Help submenu: the tray-grade support actions a lay user looks for in the
 * menu bar (P3-016/P3-019 handlers, now reachable without the tray). The
 * update items exist only when a feed is configured — without one the Help
 * menu is the same three items everywhere. `hotkey` rides along since P2-229:
 * when present, the plan's outcome leads the submenu as a disabled line. */
function helpSubmenu(
  updateLabel: string | null,
  updatesEnabled: boolean,
  labels: ShellLabels,
  hotkey?: HotkeyPlan | null,
): MenuItemSpec[] {
  const items: MenuItemSpec[] = [];
  if (hotkey) {
    items.push(
      hotkey.register && hotkey.accelerator
        ? { id: "help-hotkey", label: labels.menu.hotkeyLine, accelerator: hotkey.accelerator, enabled: false }
        : { id: "help-hotkey", label: hotkey.reason, enabled: false },
    );
  }
  if (updatesEnabled) {
    // Informational-only status line, same contract as the tray (P3-019):
    // the install itself needs the consent dialog, never a menu mis-click.
    if (updateLabel) items.push({ id: "help-update-status", label: updateLabel, enabled: false });
    items.push({ id: "help-updates", label: labels.menu.checkUpdates });
  }
  items.push({ id: "help-logs", label: labels.menu.openLogs });
  items.push({ id: "help-diagnostics", label: labels.menu.copyDiagnostics });
  // P2-267: the macOS owner has no uninstaller — this item is how the app's
  // own data (identity, paired phones, state, logs) leaves the disk before a
  // machine is sold or shared. Destructive, so it lives behind its own
  // separator; the click runs the two-step native confirmation in main.ts
  // (the verdict's harness rule gates every dialog).
  items.push({ type: "separator" });
  items.push({ id: "help-wipe-data", label: labels.menu.wipeData });
  return items;
}

/**
 * The whole application menu as plain data. `platform` is process.platform,
 * `updateLabel` the tray's status label (updateMenuLabel(lastUpdateStatus) —
 * null when no check resolved yet or updates are disabled), `updatesEnabled`
 * the updatesEnabled() verdict, `hotkey` the resolved P2-229 plan,
 * `zoomLevel` the shell's current zoom level (P2-238 — the caller rebuilds the
 * menu on every status change and every zoom step so nothing goes stale) and
 * `labels` the P2-276 shell vocabulary for the resolved language (defaults to
 * the pt table — the language the shell spoke before the selector existed).
 */
export function menuSpec(
  platform: string,
  updateLabel: string | null,
  updatesEnabled: boolean,
  hotkey?: HotkeyPlan | null,
  zoomLevel?: number,
  labels: ShellLabels = shellLabels("pt"),
): MenuItemSpec[] {
  const items: MenuItemSpec[] = [];
  if (platform === "darwin") {
    items.push({
      label: labels.menu.appTitle,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        // P2-221: wired by id to the same explicitQuit() path as the tray Quit
        // item — the Electron quit role would bypass both the verdict and the
        // confirmation box (a role ignores click handlers), and the Cmd+Q
        // accelerator moves here to keep the system shortcut.
        { id: "app-quit", label: labels.menu.quit, accelerator: "CmdOrCtrl+Q" },
      ],
    });
  }
  items.push(
    { role: "editMenu" },
    {
      label: labels.menu.go,
      submenu: [
        { id: "go-new-chat", label: labels.menu.newChat, accelerator: "CmdOrCtrl+T", action: "newChat" },
        { id: "go-palette", label: labels.menu.commandPalette, accelerator: "CmdOrCtrl+K", action: "palette" },
        { type: "separator" },
        { id: "go-pane-chat", label: labels.menu.paneConversations, accelerator: "CmdOrCtrl+1", action: "pane:chat" },
        { id: "go-pane-artifacts", label: labels.menu.paneArtifacts, accelerator: "CmdOrCtrl+2", action: "pane:artifacts" },
        { id: "go-pane-browser", label: labels.menu.paneBrowser, accelerator: "CmdOrCtrl+3", action: "pane:browser" },
        { id: "go-pane-files", label: labels.menu.paneFiles, accelerator: "CmdOrCtrl+4", action: "pane:files" },
        { id: "go-pane-settings", label: labels.menu.paneSettings, accelerator: "CmdOrCtrl+5", action: "pane:settings" },
        { id: "go-pane-mission", label: labels.menu.paneMission, accelerator: "CmdOrCtrl+6", action: "pane:mission" },
      ],
    },
    {
      label: labels.menu.view,
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        ...zoomSubmenu(zoomLevel, labels),
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
    {
      label: labels.menu.help,
      submenu: helpSubmenu(updateLabel, updatesEnabled, labels, hotkey),
    },
  );
  return items;
}
