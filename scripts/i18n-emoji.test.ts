/**
 * P2-107: no emoji/glyph-as-icon anywhere in the i18n dictionaries — chrome
 * icons live in components/icons.tsx (SVG, currentColor), copy is plain text.
 * Run: npx tsx scripts/i18n-emoji.test.ts
 */
import { dict } from "../apps/web/src/lib/i18n";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// emoji blocks + symbol/dingbat glyphs used as icons (U+2600–27BF ✓ ⚠ ✔,
// U+2300–23FF ⏪⏳, geometric shapes U+2500–25FF ▾▴, variation selectors).
// Arrows U+2190–21FF are typographic copy ("Settings → Safari") — allowed.
const BANNED = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2500}-\u{25FF}\u{FE0F}]/u;

for (const lang of ["en", "pt"] as const) {
  const entries = Object.entries(dict[lang]);
  const offenders: string[] = [];
  for (const [key, value] of entries) {
    if (BANNED.test(value)) offenders.push(`${key}=${JSON.stringify(value)}`);
  }
  check(`${lang}: zero emoji/glyph-as-icon strings`, offenders.length === 0, offenders.join(", "));
}

// the keys this task de-emojified still exist and stay plain
check("en pushOn is plain", dict.en.pushOn === "Push enabled", dict.en.pushOn);
check("pt pushOn is plain", dict.pt.pushOn === "Notificações ativadas", dict.pt.pushOn);
check("en copied is plain", dict.en.copied === "Copied", dict.en.copied);
check("pt rewindBtn is plain", dict.pt.rewindBtn === "Voltar pra cá", dict.pt.rewindBtn);
check("en/pt stay key-aligned", Object.keys(dict.en).length === Object.keys(dict.pt).length);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall i18n-emoji checks passed");
