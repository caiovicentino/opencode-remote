/**
 * P3-361: an empty "Parear" click must not be a dead end — the submit button
 * stays live (busy is the only disabled reason) and the form answers with an
 * inline, screen-reader-announced hint plus focus on the paste box, the same
 * recovery voice an invalid code already gets. Typing clears the nudge.
 * Run: npx tsx scripts/pairempty.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dict } from "../apps/web/src/lib/i18n";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const view = readFileSync(join(import.meta.dirname, "..", "apps/web/src/components/PairingView.tsx"), "utf8");

// the button's only disabled reason is busy — an empty box keeps it clickable
const btn = view.match(/<button[^>]*className=\{preferPaste \? "pair-submit primary" : "pair-submit"\}[\s\S]*?\/>/);
check("pair-submit button found", btn !== null);
check("pair-submit disabled only while busy", !!btn && /disabled=\{busy\}/.test(btn[0]));
check("pair-submit no longer disabled by empty code", !!btn && !/\!code\.trim\(\)/.test(btn[0]));

// empty submit: inline alert hint + focus on the paste box
check("empty submit shows the inline hint", /setEmptyHint\(true\)/.test(view));
check("empty submit focuses the paste box", /setEmptyHint\(true\);[\s\S]{0,200}\.pair-code"\)\??\.focus\(\)/.test(view));
check("hint renders as an alert", /className="pair-empty-hint"[^>]*role="alert"/.test(view) || /role="alert"[^>]*>[\s\S]{0,80}pairEmptyCode/.test(view));
check("hint copy comes from pairEmptyCode", view.includes('t("pairEmptyCode")'));

// typing clears the nudge — one dismissal per mistake, not a sticky label
check("typing clears the hint", /onChange=\{\(e\) => \{[\s\S]{0,80}setCode\(e\.target\.value\);[\s\S]{0,40}setEmptyHint\(false\);/.test(view));

// the valid path is untouched: submit still forwards the code verbatim
check("non-empty submit still calls onPair(code)", /setEmptyHint\(false\);\s*\n\s*onPair\(code\);/.test(view));

// both locales speak the hint, keys stay aligned (i18n-emoji contract)
check("en has pairEmptyCode", typeof dict.en.pairEmptyCode === "string" && dict.en.pairEmptyCode.length > 0);
check("pt has pairEmptyCode", typeof dict.pt.pairEmptyCode === "string" && dict.pt.pairEmptyCode.length > 0);
check("en/pt stay key-aligned", Object.keys(dict.en).length === Object.keys(dict.pt).length);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall pair-empty-submit checks passed");
