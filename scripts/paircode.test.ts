/**
 * P3-369: the pairing paste box is styled, not a raw browser textarea.
 * Source pins: index.css carries the .pair-code rule (compact, mono,
 * resize: none) and PairingView renders it with rows=2 — the same class the
 * scanner's paste CTA focuses (PairingView backToPaste), so the rule must
 * keep living on index.css, not inline.
 * Run: npx tsx scripts/paircode.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
const css = src("apps/web/src/index.css");
const view = src("apps/web/src/components/PairingView.tsx");

const rule = css.match(/\.pair-code\s*\{[^}]*\}/);
check("index.css styles .pair-code", rule !== null);
check(".pair-code removes the resize grip", !!rule && /resize:\s*none/.test(rule[0]));
check(".pair-code uses the mono token", !!rule && /font-family:\s*var\(--font-mono\)/.test(rule[0]));
check(".pair-code is compact (8px vertical padding)", !!rule && /padding:\s*8px/.test(rule[0]));
check("pairing textarea renders rows=2", /className="pair-code"\s*\n\s*rows=\{2\}/.test(view));

// P3-431: a rejected submit flags the field itself — aria-invalid follows
// codeError, the field carries the danger border and the global accent
// focus-visible ring reads danger while the inline error block stands.
// P3-440: the empty submit joins the same state (codeError || emptyHint), so
// both failing paths wear the flag instead of only the garbled-code one.
check("invalid code sets aria-invalid on the paste box", /aria-invalid=\{codeError \|\| emptyHint \? true : undefined\}/.test(view));
const invalidRule = css.match(/\.pair-code\[aria-invalid="true"\][^{]*\{[^}]*\}/);
check("index.css styles the invalid paste box with the danger border", !!invalidRule && /border-color:\s*var\(--danger\)/.test(invalidRule[0]));
const ringRule = css.match(/\.pair-code\[aria-invalid="true"\]:focus-visible\s*\{[^}]*\}/);
check("invalid paste box suppresses the accent ring in favor of danger", !!ringRule && /outline-color:\s*var\(--danger\)/.test(ringRule[0]) && !/var\(--accent\)/.test(ringRule[0]));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall pair-code checks passed");
