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
const prefs = src("apps/web/src/index.css");
// Count-based (P3-337 lesson) over the card's controls region only — the file
// header's prose comment ("<select> is a replaced element") must never count.
const degradedCard = (() => {
  const localAt = view.indexOf('className="degraded-local"');
  return view.slice(localAt, view.indexOf('className="degraded-manual"', localAt));
})();
check("DegradedView renders the theme select (themeLabel aria-label)", view.includes(`aria-label={t("themeLabel")}`));
check(
  "DegradedView offers system/dark/light",
  view.includes(`value="system"`) && view.includes(`value="dark"`) && view.includes(`value="light"`),
);
check("DegradedView persists through the shared THEME_KEY + applyTheme", view.includes("THEME_KEY") && view.includes("applyTheme()"));
check("DegradedView keeps the language select beside it", view.includes(`aria-label={t("language")}`));
check(
  "exactly two selects in the card, one theme control (count-based, P3-337 lesson)",
  (degradedCard.match(/<select/g) ?? []).length === 2,
);

// --- P3-429: the selects carry visible micro-labels (P3-448 lesson: paired pin) --
// The aria-labels alone are invisible — a first-boot user had to guess which
// select was Idioma and which was Tema. Pin the new labeled groups present AND
// the old unlabeled direct-child markup absent.
check(
  "each prefs select sits under a visible micro-label (2 wrapping label groups)",
  (view.match(/<label className="degraded-select">/g) ?? []).length === 2 &&
    (view.match(/className="degraded-select-label"/g) ?? []).length === 2 &&
    view.includes('<span className="degraded-select-label">{t("language")}</span>') &&
    view.includes('<span className="degraded-select-label">{t("themeLabel")}</span>'),
);
check(
  "the unlabeled direct-child markup is gone (old pattern absent)",
  !/className="degraded-select">\s*<select/.test(degradedCard) &&
    /className="degraded-select">\s*<span className="degraded-select-label"/.test(degradedCard),
);
const labelRule = prefs.match(/\.degraded-select-label\s*\{[^}]*\}/);
check(
  "the micro-label rides the shared quiet-caps grammar (muted, one step small)",
  !!labelRule && /color:\s*var\(--muted\)/.test(labelRule[0]) &&
    /font-size:\s*var\(--font-size-xs\)/.test(labelRule[0]) &&
    /text-transform:\s*uppercase/.test(labelRule[0]),
);
const selectFocus = prefs.match(/\.degraded-local-prefs select:focus-visible\s*\{[^}]*\}/);
check(
  "focus escalates to the fg border like the queue field's active-field grammar",
  !!selectFocus && /border-color:\s*var\(--fg\)/.test(selectFocus[0]),
);

const settings = src("apps/web/src/components/SettingsView.tsx");
check(
  "Settings appearance card uses the same THEME_KEY + applyTheme",
  settings.includes("THEME_KEY") && settings.includes("applyTheme()"),
);
check("single source of truth: lib/theme owns the key", src("apps/web/src/lib/theme.ts").includes(`export const THEME_KEY = "ocr_theme"`));
check("lib/theme keeps the key aligned with Settings' storage", THEME_KEY === "ocr_theme");

// --- P3-445: the selects wear the card's control skin, never OS chrome ---------
// Source pin (P3-421 lesson: a DOM test can't see the token ladder, so pin
// which var() token each state class uses) — a silent revert of appearance:none
// would resurrect the native macOS select chrome inside the otherwise flat
// card (the "detalhe que denuncia cuidado" failure the fable review flagged).
const selectRule = prefs.match(/\.degraded-local-prefs select\s*\{[^}]*\}/);
const selectHover = prefs.match(/\.degraded-local-prefs select:hover\s*\{[^}]*\}/);
check("index.css styles .degraded-local-prefs select", selectRule !== null);
check("select drops the OS chrome (appearance: none)", !!selectRule && /appearance:\s*none/.test(selectRule[0]));
check(
  "select paints the card's surface like the queue-save button (var(--surface))",
  !!selectRule && /background:\s*var\(--surface\)/.test(selectRule[0]),
);
check(
  "select carries the composer/save firm resting border (var(--border-strong))",
  !!selectRule && /border-color:\s*var\(--border-strong\)/.test(selectRule[0]),
);
check(
  "select escalates to the focus border on hover like the save button (var(--fg))",
  !!selectHover && /border-color:\s*var\(--fg\)/.test(selectHover[0]),
);
check(
  "select keeps the card's small type step",
  !!selectRule && /font-size:\s*var\(--font-size-sm\)/.test(selectRule[0]),
);
check(
  "the wrapper owns the flex sizing (the select fills it at 100%)",
  /(\.degraded-select\s*\{[^}]*flex:\s*1 1 auto)/.test(prefs) && !!selectRule && /width:\s*100%/.test(selectRule[0]),
);
const chevronRule = prefs.match(/\.degraded-select svg\s*\{[^}]*\}/);
check(
  "the drawn chevron is positioned by CSS with the muted token (no OS art)",
  !!chevronRule && /position:\s*absolute/.test(chevronRule[0]) && /pointer-events:\s*none/.test(chevronRule[0]) && /color:\s*var\(--muted\)/.test(chevronRule[0]),
);
check(
  "DegradedView renders the shared chevron icon on each wrapper (::after never renders on a replaced element)",
  (view.match(/<IconChevronDown size=\{12\} \/>/g) ?? []).length === 2,
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\ndegraded-theme checks passed");
