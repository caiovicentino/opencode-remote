// Pure menu specification (P2-176). Kept free of electron and node:fs imports
// so scripts/unit.test.ts can exercise it (same pattern as tray.ts, badge.ts
// and closehint.ts): main.ts hands it the platform, the update-status label
// already resolved by updateMenuLabel() and the updatesEnabled() verdict, and
// gets back a plain data descriptor — id, label, optional role, optional
// accelerator, submenu — with no Electron types anywhere. buildMenu() in
// main.ts is the only place that translates this descriptor into the
// Electron template.

import type { HotkeyPlan } from "./hotkey";

/** The roles the shell relies on. A closed union on purpose: editMenu and
 * windowMenu stay native roles exactly so the OS keeps translating them by
 * itself (P2-176), and the macOS app submenu keeps the system behaviors. */
export type MenuRole =
  | "about"
  | "hide"
  | "quit"
  | "editMenu"
  | "windowMenu"
  | "reload"
  | "forceReload"
  | "resetZoom"
  | "zoomIn"
  | "zoomOut"
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

// pt-BR copy (P2-176): the native menu speaks the same language as the UI
// since P2-118. Product terms the UI itself keeps untranslated in pt-BR
// ("Artifacts", "Browser", "Mission Control" — apps/web/src/lib/i18n.ts nav*)
// stay exactly as they are; everything else mirrors the i18n strings.
const APP_TITLE = "OpenCode Remote";
const GO_TITLE = "Ir";
const VIEW_TITLE = "Visualizar";
const HELP_TITLE = "Ajuda";

/** P2-229: the informational item shown when the global hotkey IS registered
 * (the accelerator renders right beside it). When the plan refuses, the item
 * shows the plan's reason phrase instead — never a lying combination. */
export const HOTKEY_MENU_LABEL = "Atalho global para reabrir a janela";

/** Help submenu: the tray-grade support actions a lay user looks for in the
 * menu bar (P3-016/P3-019 handlers, now reachable without the tray). The
 * update items exist only when a feed is configured — without one the Help
 * menu is the same three items everywhere. `hotkey` rides along since P2-229:
 * when present, the plan's outcome leads the submenu as a disabled line. */
function helpSubmenu(updateLabel: string | null, updatesEnabled: boolean, hotkey?: HotkeyPlan | null): MenuItemSpec[] {
  const items: MenuItemSpec[] = [];
  if (hotkey) {
    items.push(
      hotkey.register && hotkey.accelerator
        ? { id: "help-hotkey", label: HOTKEY_MENU_LABEL, accelerator: hotkey.accelerator, enabled: false }
        : { id: "help-hotkey", label: hotkey.reason, enabled: false },
    );
  }
  if (updatesEnabled) {
    // Informational-only status line, same contract as the tray (P3-019):
    // the install itself needs the consent dialog, never a menu mis-click.
    if (updateLabel) items.push({ id: "help-update-status", label: updateLabel, enabled: false });
    items.push({ id: "help-updates", label: "Verificar atualizações" });
  }
  items.push({ id: "help-logs", label: "Abrir pasta de logs" });
  items.push({ id: "help-diagnostics", label: "Copiar diagnóstico" });
  return items;
}

/**
 * The whole application menu as plain data. `platform` is process.platform,
 * `updateLabel` the tray's status label (updateMenuLabel(lastUpdateStatus) —
 * null when no check resolved yet or updates are disabled), `updatesEnabled`
 * the updatesEnabled() verdict and `hotkey` the resolved P2-229 plan (the
 * caller rebuilds the menu on every status change so no label goes stale).
 */
export function menuSpec(
  platform: string,
  updateLabel: string | null,
  updatesEnabled: boolean,
  hotkey?: HotkeyPlan | null,
): MenuItemSpec[] {
  const items: MenuItemSpec[] = [];
  if (platform === "darwin") {
    items.push({
      label: APP_TITLE,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        // P2-221: wired by id to the same explicitQuit() path as the tray Quit
        // item — the Electron quit role would bypass both the verdict and the
        // confirmation box (a role ignores click handlers), and the Cmd+Q
        // accelerator moves here to keep the system shortcut.
        { id: "app-quit", label: "Encerrar OpenCode Remote", accelerator: "CmdOrCtrl+Q" },
      ],
    });
  }
  items.push(
    { role: "editMenu" },
    {
      label: GO_TITLE,
      submenu: [
        { id: "go-new-chat", label: "Nova conversa", accelerator: "CmdOrCtrl+T", action: "newChat" },
        { id: "go-palette", label: "Paleta de comandos", accelerator: "CmdOrCtrl+K", action: "palette" },
        { type: "separator" },
        { id: "go-pane-chat", label: "Conversas", accelerator: "CmdOrCtrl+1", action: "pane:chat" },
        { id: "go-pane-artifacts", label: "Artifacts", accelerator: "CmdOrCtrl+2", action: "pane:artifacts" },
        { id: "go-pane-browser", label: "Browser", accelerator: "CmdOrCtrl+3", action: "pane:browser" },
        { id: "go-pane-files", label: "Arquivos", accelerator: "CmdOrCtrl+4", action: "pane:files" },
        { id: "go-pane-settings", label: "Configurações", accelerator: "CmdOrCtrl+5", action: "pane:settings" },
        { id: "go-pane-mission", label: "Mission Control", accelerator: "CmdOrCtrl+6", action: "pane:mission" },
      ],
    },
    {
      label: VIEW_TITLE,
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
    {
      label: HELP_TITLE,
      submenu: helpSubmenu(updateLabel, updatesEnabled, hotkey),
    },
  );
  return items;
}
