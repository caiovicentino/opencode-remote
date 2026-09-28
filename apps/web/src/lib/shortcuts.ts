// eval-20: the keyboard map as data — one table feeds the shortcuts sheet
// (⌘/ or ?) and the key hints on the command palette rows, so what the UI
// teaches can never drift from what the app binds. The Go-menu accelerators
// (apps/desktop/src/menu.ts) and the renderer fallback in App.tsx are the
// bindings; scripts/convosearch.test.ts pins this table against the menu
// spec, and the eval-20 beat of the desktop flow exercises the sheet live.
// Pure: no React, no DOM on import.

export type ShortcutGroup = "nav" | "chat" | "general";

/** A key combination. `mod` is Cmd on macOS and Ctrl everywhere else —
 * Electron's CmdOrCtrl. `key` is the key cap as printed ("K", "1", "/",
 * "Enter", "Esc"). */
export interface KeyCombo {
  mod?: boolean;
  shift?: boolean;
  key: string;
}

export interface Shortcut {
  id: string;
  group: ShortcutGroup;
  /** i18n key of the description */
  labelKey: string;
  combo: KeyCombo;
  /** the Go-menu accelerator this entry mirrors (desktop shell), if any */
  menuAccelerator?: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette", group: "nav", labelKey: "paletteName", combo: { mod: true, key: "K" }, menuAccelerator: "CmdOrCtrl+K" },
  { id: "newChat", group: "nav", labelKey: "paletteNewChat", combo: { mod: true, key: "T" }, menuAccelerator: "CmdOrCtrl+T" },
  { id: "pane:chat", group: "nav", labelKey: "navConversations", combo: { mod: true, key: "1" }, menuAccelerator: "CmdOrCtrl+1" },
  { id: "pane:artifacts", group: "nav", labelKey: "navArtifacts", combo: { mod: true, key: "2" }, menuAccelerator: "CmdOrCtrl+2" },
  { id: "pane:browser", group: "nav", labelKey: "navBrowser", combo: { mod: true, key: "3" }, menuAccelerator: "CmdOrCtrl+3" },
  { id: "pane:files", group: "nav", labelKey: "navFiles", combo: { mod: true, key: "4" }, menuAccelerator: "CmdOrCtrl+4" },
  { id: "pane:settings", group: "nav", labelKey: "navSettings", combo: { mod: true, key: "5" }, menuAccelerator: "CmdOrCtrl+5" },
  { id: "pane:mission", group: "nav", labelKey: "navMission", combo: { mod: true, key: "6" }, menuAccelerator: "CmdOrCtrl+6" },
  { id: "find", group: "chat", labelKey: "shortcutFind", combo: { mod: true, key: "F" } },
  { id: "send", group: "chat", labelKey: "shortcutSend", combo: { key: "Enter" } },
  { id: "newline", group: "chat", labelKey: "shortcutNewline", combo: { shift: true, key: "Enter" } },
  { id: "shortcuts", group: "general", labelKey: "shortcutsTitle", combo: { mod: true, key: "/" } },
  { id: "close", group: "general", labelKey: "shortcutClose", combo: { key: "Esc" } },
];

export const SHORTCUT_GROUPS: readonly { group: ShortcutGroup; labelKey: string }[] = [
  { group: "nav", labelKey: "shortcutsGroupNav" },
  { group: "chat", labelKey: "shortcutsGroupChat" },
  { group: "general", labelKey: "shortcutsGroupGeneral" },
];

/** macOS (and iPadOS with a keyboard) print ⌘/⇧; everyone else Ctrl/Shift. */
export function isMacPlatform(platform: unknown): boolean {
  return typeof platform === "string" && /mac|iphone|ipad|ipod/i.test(platform);
}

/** The key caps of a combination, in the platform's order and vocabulary:
 * ["⌘", "K"] on macOS, ["Ctrl", "K"] elsewhere. */
export function comboKeys(combo: KeyCombo, mac: boolean): string[] {
  const keys: string[] = [];
  if (mac) {
    if (combo.shift) keys.push("⇧");
    if (combo.mod) keys.push("⌘");
  } else {
    if (combo.mod) keys.push("Ctrl");
    if (combo.shift) keys.push("Shift");
  }
  keys.push(combo.key);
  return keys;
}

/** One-string form for titles and accessible names: "⌘K" / "Ctrl+K". */
export function comboLabel(combo: KeyCombo, mac: boolean): string {
  return comboKeys(combo, mac).join(mac ? "" : "+");
}

/** The shortcut of a palette/menu action id, or null. */
export function shortcutFor(id: string): Shortcut | null {
  return SHORTCUTS.find((s) => s.id === id) ?? null;
}

/** Electron accelerator → combo, for the parity pin against menu.ts. */
export function comboFromAccelerator(accelerator: string): KeyCombo | null {
  const parts = accelerator.split("+").filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const combo: KeyCombo = { key: key.toUpperCase() };
  for (const p of parts) {
    if (p === "CmdOrCtrl" || p === "CommandOrControl") combo.mod = true;
    else if (p === "Shift") combo.shift = true;
    else return null;
  }
  return combo;
}

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** auto-repeat (a key held down) — the toggle must not flip every repeat */
  repeat?: boolean;
}

/**
 * Does this keydown toggle the shortcuts sheet? ⌘/ (Ctrl+/ off macOS) works
 * anywhere, like the palette's ⌘K; the bare "?" only when the focus is not
 * in a text field — typing a question mark into the composer must stay
 * typing. Auto-repeat never toggles (a held ⌘/ must flip the sheet once,
 * not strobe it).
 */
export function isShortcutsToggle(e: KeyLike, mac: boolean, typing: boolean): boolean {
  if (e.repeat) return false;
  if (e.altKey) return false;
  const mod = mac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
  if (mod && (e.key === "/" || e.key === "?")) return true;
  return !typing && !e.metaKey && !e.ctrlKey && e.key === "?";
}

/** Structural view of a focused element — true for anything that takes text. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (el.type ?? "text").toLowerCase();
  return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"].includes(type);
}
