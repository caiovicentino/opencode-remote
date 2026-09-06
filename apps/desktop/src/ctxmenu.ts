// P2-235: pure context-menu specification for the desktop shell — the
// right-click gesture a lay user actually learns first (copy an answer, paste
// into the composer). Same module hygiene as menu.ts / hotkey.ts: NO electron,
// no node builtins, no I/O — main.ts resolves the session flag, the packaged
// verdict, the link scheme decision (externalOpenDecision, P2-178) and the
// already-normalized edit flags from the context-menu event params, and this
// module answers with the ordered MenuItemSpec list to render (the same spec
// format the application menu already speaks). Short pt-BR labels, no emoji
// (P2-118 / the i18n-emoji lesson), no absolute file paths, no URL scheme in
// any label, no secrets.
//
// RULE ORDER CONTRACT (the gate depends on it):
//  1. the harness-session rule comes FIRST and stays first — before any
//     packaged, selection or link consideration (P2-221 lesson) — because
//     tools/desktop.mjs and the npm run test:desktop-flow battery run on the
//     operator's machine and a native popup would steal focus and stall the
//     gate; a harness session always gets an empty list (no menu at all).
//  2. the packaged rule is second: a packaged build NEVER renders Inspect
//     Element — it is allowed only unpackaged, outside a harness session.
//  3. a link opens only when the P2-178 scheme verdict (extlink.ts) approves
//     the address: an APPROVED scheme renders "Abrir link" + copy address, a
//     REFUSED scheme (file/javascript/data/blob or any unknown scheme) renders
//     at most copy address — never open. The verdict reason is logged at the
//     call site, never here.

import type { ExternalOpenDecision } from "./extlink";
import type { MenuItemSpec } from "./menu";

/** Documented ceiling for spelling suggestions rendered in one menu. */
export const SPELLING_SUGGESTIONS_MAX = 4;

/** Already normalized by main.ts from Electron's context-menu event params:
 * the editable flag, the four action flags (a false flag means the item is
 * not rendered at all — never a dead/disabled edit item), the selected text,
 * the hovered link URL, the misspelled word and its dictionary suggestions. */
export interface ContextMenuInput {
  editable: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
  selectionText: string;
  linkUrl: string;
  misspelledWord: string;
  suggestions: string[];
}

/** Item ids main.ts wires click handlers for (by id, like menuShellHandlers). */
export type ContextMenuItemId =
  | "ctx-cut"
  | "ctx-copy"
  | "ctx-paste"
  | "ctx-select-all"
  | "ctx-open-link"
  | "ctx-copy-link"
  | "ctx-inspect";

/**
 * The ordered context menu as plain data. Empty list = no menu at all.
 * Item order (documented, stable): spelling suggestions, edit actions
 * (Recortar/Copiar/Colar/Selecionar tudo), link actions (Abrir link /
 * Copiar endereço do link) and finally Inspect Element on dev builds;
 * non-empty groups are joined by separators, never leading or trailing ones.
 */
export function contextMenuSpec(
  harnessSession: boolean,
  packaged: boolean,
  linkDecision: ExternalOpenDecision,
  input: ContextMenuInput,
): MenuItemSpec[] {
  // Rule 1 (see the header): a test session never opens a menu.
  if (harnessSession) return [];

  // Spelling suggestions first, capped — mirrors the native editor menus.
  // They only make sense for a misspelled word, and an empty suggestion list
  // must never render an empty placeholder item.
  const suggestions: MenuItemSpec[] =
    input.misspelledWord && Array.isArray(input.suggestions)
      ? input.suggestions
          .slice(0, SPELLING_SUGGESTIONS_MAX)
          .filter((word) => typeof word === "string" && word.trim() !== "")
          .map((word, index): MenuItemSpec => ({ id: `ctx-spell-${index}`, label: word }))
      : [];

  // Edit actions: only the actions actually possible right now render.
  const edit: MenuItemSpec[] = [];
  if (input.editable) {
    if (input.canCut) edit.push({ id: "ctx-cut", label: "Recortar" });
    if (input.canCopy) edit.push({ id: "ctx-copy", label: "Copiar" });
    if (input.canPaste) edit.push({ id: "ctx-paste", label: "Colar" });
    if (input.canSelectAll) edit.push({ id: "ctx-select-all", label: "Selecionar tudo" });
  } else if (input.canCopy) {
    // Selection outside an editable field: copy is meaningful, paste is not.
    edit.push({ id: "ctx-copy", label: "Copiar" });
  }

  // Link actions gated by the extlink verdict (rule 3 in the header):
  // a refused scheme yields at most copy address, never open.
  const link: MenuItemSpec[] = [];
  if (typeof input.linkUrl === "string" && input.linkUrl !== "") {
    if (linkDecision?.allow) link.push({ id: "ctx-open-link", label: "Abrir link" });
    link.push({ id: "ctx-copy-link", label: "Copiar endereço do link" });
  }

  // Rule 2: Inspect Element exists only in dev (unpackaged) builds.
  const dev: MenuItemSpec[] = packaged ? [] : [{ id: "ctx-inspect", label: "Inspecionar elemento" }];

  const groups = [suggestions, edit, link, dev].filter((group) => group.length > 0);
  const items: MenuItemSpec[] = [];
  for (const group of groups) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push(...group);
  }
  return items;
}
