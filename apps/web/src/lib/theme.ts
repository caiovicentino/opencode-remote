/** P3-368: theme persistence shared by the Settings appearance card and the
 * offline (degraded) first-boot card. The offline card's copy promises
 * "language and theme live on this machine — they work right now", so both
 * surfaces must read and write the same localStorage key and re-apply through
 * the same path — otherwise one screen silently contradicts the other. */

export type ThemeChoice = "dark" | "light" | "system";

export const THEME_KEY = "ocr_theme";
export const FONT_KEY = "ocr_font";

/** Fail-safe parse of a stored choice: anything but an explicit override is
 * "system" (follow the OS). Pure so the unit battery can pin the contract
 * without a DOM. */
export function parseTheme(raw: string | null): ThemeChoice {
  return raw === "dark" || raw === "light" ? raw : "system";
}

export function readTheme(): ThemeChoice {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** MediaQueryList of the active `(prefers-color-scheme: light)` probe while
 * the theme is "system", so a live OS switch flips the shell without reload.
 * Re-calling applyTheme() always drops the previous listener — no leaks. */
let schemeQuery: MediaQueryList | null = null;

function onSchemeChange() {
  document.documentElement.dataset.theme = schemeQuery?.matches ? "light" : "dark";
}

export function applyTheme() {
  const theme = readTheme();
  const font = localStorage.getItem(FONT_KEY) ?? "normal";
  if (schemeQuery) {
    schemeQuery.removeEventListener("change", onSchemeChange);
    schemeQuery = null;
  }
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
  } else {
    schemeQuery = window.matchMedia("(prefers-color-scheme: light)");
    onSchemeChange();
    schemeQuery.addEventListener("change", onSchemeChange);
  }
  document.documentElement.style.fontSize = font === "small" ? "14px" : font === "large" ? "19px" : "16.5px";
}
