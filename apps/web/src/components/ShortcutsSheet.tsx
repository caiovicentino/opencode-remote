import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  comboKeys,
  comboLabel,
  isMacPlatform,
  isShortcutsToggle,
  isTypingTarget,
  shortcutFor,
} from "../lib/shortcuts";
import { IconX } from "./icons";

/** Window event the palette's "Keyboard shortcuts" action dispatches. */
export const SHORTCUTS_EVENT = "ocr:shortcuts";

/** Open the sheet from anywhere (the palette action) without prop plumbing. */
export function openShortcutsSheet(): void {
  window.dispatchEvent(new Event(SHORTCUTS_EVENT));
}

export function platformIsMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return isMacPlatform(nav.userAgentData?.platform || nav.platform);
}

/** Key caps for one combination, printed the platform's way. */
export function KeyCaps({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="kbd-combo" aria-label={label} title={label}>
      {keys.map((k, i) => (
        <kbd key={i} className="kbd" aria-hidden>
          {k}
        </kbd>
      ))}
    </span>
  );
}

/**
 * eval-20: the keyboard map, one keystroke away. ⌘/ (Ctrl+/ off macOS)
 * toggles it from anywhere and the bare "?" does too while the focus is not
 * in a text field — the Claude/ChatGPT desktop convention. Every row comes
 * from lib/shortcuts (the same table the palette's key hints read), so the
 * sheet can never teach a combination the app does not bind. Calm modal in
 * the AskDialog vocabulary: scrim click and Esc close, focus returns to the
 * opener, motion dies under prefers-reduced-motion.
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
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHORTCUTS_EVENT, onRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHORTCUTS_EVENT, onRequest);
    };
  }, [mac]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    // the card itself takes the focus (tabIndex -1): screen readers land on
    // the labelled dialog, Tab reaches the close button, and no focus ring
    // shouts from the corner the moment the sheet opens
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Esc closes the topmost surface only: stopping here (document)
        // keeps the chat's find bar (a window listener) open underneath
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openerRef.current?.focus?.();
    };
  }, [open]);

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
