// P3-465: the OS window title (Windows Alt+Tab + taskbar, the macOS Window
// menu, screen readers) must name the open conversation — before this, every
// window read just "OpenCode Remote" (the static <title> in index.html was
// the only writer, and nothing in apps/web/src touched document.title). Pure
// and dependency-free (no DOM, no timers) so scripts/unit.test.ts can
// exercise it directly; App.tsx applies the result to document.title in
// exactly one effect (pinned by unit tests).

/** Cap for the conversation portion of the window title — the codebase's
 * clip convention (lib/sessionPreview.ts): cut at max-1 and append the
 * ellipsis, so a truncated title never exceeds the cap. */
export const WINDOW_TITLE_MAX = 60;

/** Control characters (C0, DEL, C1) never belong in a window title — the
 * taskbar, the Window menu and screen readers render it as one line, so a
 * title carrying a line break or a tab must not split or corrupt it. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** Runs of repeated spaces collapse to one. */
const SPACES_RE = / {2,}/g;

/** The window title reads "<conversation> — <app>", matching the tray
 * convention ("OpenCode Remote — daemon ok", apps/desktop/src/tray.ts). */
const TITLE_DASH = " — ";

/**
 * Build the window title from the active conversation's title and the app
 * name. Absent, empty or whitespace-only titles fall back to the bare app
 * name (the pairing gate, the home screen and untitled conversations all
 * read "OpenCode Remote" exactly as before).
 */
export function windowTitle(sessionTitle: string | null | undefined, appName: string): string {
  const clean = (sessionTitle ?? "")
    .replace(CONTROL_RE, "")
    .replace(SPACES_RE, " ")
    .trim();
  if (!clean) return appName;
  const clipped = clean.length > WINDOW_TITLE_MAX ? `${clean.slice(0, WINDOW_TITLE_MAX - 1)}…` : clean;
  return `${clipped}${TITLE_DASH}${appName}`;
}
