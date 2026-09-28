import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  comboKeys,
  comboLabel,
  isShortcutsToggle,
  isTypingTarget,
  shortcutFor,
} from "../lib/shortcuts";
import { FIND_OPEN_EVENT, KeyCaps, PALETTE_OPEN_EVENT, SHORTCUTS_EVENT, platformIsMac } from "./ShortcutsShared";
import { IconX } from "./icons";

/**
 * eval-20: the keyboard map, one keystroke away. ⌘/ (Ctrl+/ off macOS)
 * toggles it from anywhere and the bare "?" does too while the focus is not
 * in a text field — the Claude/ChatGPT desktop convention. Every row comes
 * from lib/shortcuts (the same table the palette's key hints read), so the
 * sheet can never teach a combination the app does not bind. Calm modal in
 * the AskDialog vocabulary: scrim click and Esc close, focus is trapped in
 * the card (aria-modal), focus returns to the opener, motion dies under
 * prefers-reduced-motion.
 */
export default function ShortcutsSheet() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const mac = platformIsMac();
  const cardRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcutsToggle(e, mac, isTypingTarget(document.activeElement as HTMLElement | null))) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    const onRequest = () => setOpen(true);
    // verifier B5c: the palette (⌘K, Go menu or fallback) and the find bar
    // (⌘F) close the sheet instead of focusing surfaces buried below it
    const onPalette = () => setOpen(false);
    const onFind = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHORTCUTS_EVENT, onRequest);
    window.addEventListener(PALETTE_OPEN_EVENT, onPalette);
    window.addEventListener(FIND_OPEN_EVENT, onFind);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHORTCUTS_EVENT, onRequest);
      window.removeEventListener(PALETTE_OPEN_EVENT, onPalette);
      window.removeEventListener(FIND_OPEN_EVENT, onFind);
    };
  }, [mac]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    // the card itself takes the focus (tabIndex -1): screen readers land on
    // the labelled dialog, Tab reaches the close button, and no focus ring
    // shouts from the corner the moment the sheet opens
    cardRef.current?.focus();
    // verifier B4: Esc must close the TOPMOST surface only. The AskDialog and
    // the tool-activity Modal listen on document in the BUBBLE phase and were
    // registered first, so a bubble-phase listener here (even with
    // stopPropagation) fires AFTER them — one Esc closed the rename dialog
    // underneath and threw away the typed name. A window listener in the
    // CAPTURE phase runs before every bubble listener; stopping the event
    // there is a real block.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      openerRef.current?.focus?.();
    };
  }, [open]);

  // verifier B5b: aria-modal="true" without a focus trap let Tab walk out of
  // the card into the page behind the scrim — the same trap AskDialog uses
  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const nodes = cardRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input, [tabindex]:not([tabindex='-1'])",
    );
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;
  const palette = shortcutFor("palette");

  return (
    <div
      className="ask-scrim shortcuts-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={cardRef}
        className="ask-card shortcuts-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabIndex={-1}
        data-shortcuts-sheet
        onKeyDown={trapTab}
      >
        <header className="shortcuts-head">
          <h2 id="shortcuts-title" className="ask-title">
            {t("shortcutsTitle")}
          </h2>
          <button type="button" className="shortcuts-close" aria-label={t("close")} title={t("close")} onClick={() => setOpen(false)}>
            <IconX size={16} />
          </button>
        </header>
        <div className="shortcuts-groups">
          {SHORTCUT_GROUPS.map(({ group, labelKey }) => (
            <section key={group} className="shortcuts-group" data-group={group}>
              <h3 className="shortcuts-group-head">{t(labelKey)}</h3>
              <dl className="shortcuts-list">
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <div key={s.id} className="shortcuts-row" data-shortcut={s.id}>
                    <dt>{t(s.labelKey)}</dt>
                    <dd>
                      <KeyCaps keys={comboKeys(s.combo, mac)} label={comboLabel(s.combo, mac)} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        {palette && <p className="shortcuts-foot">{t("shortcutsFoot", { combo: comboLabel(palette.combo, mac) })}</p>}
      </div>
    </div>
  );
}
