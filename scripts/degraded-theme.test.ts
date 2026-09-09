/**
 * P3-368: the offline card's copy promises "language and theme live on this
 * machine — they work right now", but only the language select shipped. Pins
 * the contract of the shared theme lib (parseTheme fail-safe), the i18n keys
 * the new control renders in every supported locale (result ≠ raw key, the
 * P3-329 lesson), and the source wiring: the degraded card renders the theme
 * select and persists through the SAME ocr_theme key + applyTheme path as the
 * Settings appearance card.
 * Run: npx tsx scripts/degraded-theme.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTheme, THEME_KEY } from "../apps/web/src/lib/theme";
import { translate } from "../apps/web/src/lib/i18n";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

// --- parseTheme: fail-safe contract -------------------------------------------
check("parseTheme: null (no stored choice) → system", parseTheme(null) === "system");
check(
  "parseTheme: explicit dark/light pass through",
  parseTheme("dark") === "dark" && parseTheme("light") === "light",
);
check("parseTheme: garbage → system", parseTheme("bloody") === "system" && parseTheme("") === "system");

// --- i18n: every rendered key resolves in every locale (P3-329 lesson) ---------
for (const lang of ["en", "pt"] as const) {
  for (const key of ["language", "themeLabel", "themeSystem", "themeDark", "themeLight"] as const) {
    const rendered = translate(lang, key);
    check(
      `${lang}.${key} resolves (≠ raw key)`,
      rendered !== key && rendered.trim() !== "",
      JSON.stringify(rendered),
    );
  }
}

// --- source wiring: the card renders the control, Settings shares the path -----
const view = src("apps/web/src/components/DegradedView.tsx");
check("DegradedView renders the theme select (themeLabel aria-label)", view.includes(`aria-label={t("themeLabel")}`));
check(
  "DegradedView offers system/dark/light",
  view.includes(`value="system"`) && view.includes(`value="dark"`) && view.includes(`value="light"`),
);
check("DegradedView persists through the shared THEME_KEY + applyTheme", view.includes("THEME_KEY") && view.includes("applyTheme()"));
check("DegradedView keeps the language select beside it", view.includes(`aria-label={t("language")}`));
check(
  "exactly one theme select in the card (count-based, P3-337 lesson)",
  (view.match(/themeLabel/g) ?? []).length === 1,
);

const settings = src("apps/web/src/components/SettingsView.tsx");
check(
  "Settings appearance card uses the same THEME_KEY + applyTheme",
  settings.includes("THEME_KEY") && settings.includes("applyTheme()"),
);
check("single source of truth: lib/theme owns the key", src("apps/web/src/lib/theme.ts").includes(`export const THEME_KEY = "ocr_theme"`));
check("lib/theme keeps the key aligned with Settings' storage", THEME_KEY === "ocr_theme");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\ndegraded-theme checks passed");
