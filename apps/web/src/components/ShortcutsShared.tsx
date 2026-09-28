import { comboKeys, comboLabel, isMacPlatform } from "../lib/shortcuts";

/** Window event the palette's "Keyboard shortcuts" action dispatches. */
export const SHORTCUTS_EVENT = "ocr:shortcuts";

/**
 * eval-20 (verifier B5c): the sheet must not survive a palette or a find bar
 * opening on top of it. The palette is opened by the Go menu (Electron IPC —
 * no keydown ever reaches the renderer) and by ⌘K in the fallback; the find
 * bar by ⌘F. Both dispatch these window events and the sheet closes itself.
 */
export const PALETTE_OPEN_EVENT = "ocr:palette-open";
export const FIND_OPEN_EVENT = "ocr:find-open";

/** Open the sheet from anywhere (the palette action) without prop plumbing. */
export function openShortcutsSheet(): void {
  window.dispatchEvent(new Event(SHORTCUTS_EVENT));
}

export function platformIsMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return isMacPlatform(nav.userAgentData?.platform || nav.platform);
}

/**
 * Key caps for one combination, printed the platform's way. The combination
 * also exists as visually hidden text (verifier B5a): the chips are
 * aria-hidden decorations, so each row reads as its label + "⌘K" — the
 * bare kbd caps are not announced, and an aria-label on a plain span is
 * invalid and ignored.
 */
export function KeyCaps({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="kbd-combo" title={label}>
      <span className="sr-only">{label}</span>
      {keys.map((k, i) => (
        <kbd key={i} className="kbd" aria-hidden>
          {k}
        </kbd>
      ))}
    </span>
  );
}
