/**
 * P3-387: the degraded stack must never shear the serif brand wordmark
 * against the viewport top. With a pane open the gate column narrows, the
 * stack outgrows the viewport and plain centered flex overflows both edges —
 * the top half of "OpenCode Remote" rendered clipped flush at y=0
 * (explorer shot journey-mission-control-20260910); the pair-wrap path on a
 * narrow desktop window shows the same shear (390px probe). Source pins: the
 * fix lives on index.css as overflow-safe centering on .screen.degraded —
 * the class is unique to DegradedView, so no sibling screen is affected
 * (P3-330 lesson applies to shared base classes; this is not one).
 * P3-423: the pairing gate shows the same shear at 1440x900 once intro +
 * host section + paste form + the 5-row pane map outgrow the viewport —
 * fixed the same way, plus a sticky brand header so the wordmark never
 * scrolls away mid-ceremony.
 * Run: npx tsx scripts/gate-wordmark.test.ts
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

const css = readFileSync(join(import.meta.dirname, "..", "apps", "web", "src", "index.css"), "utf8");

const safeRule = css.match(/\.screen\.degraded\s*\{[^}]*\}/);
check("index.css has the overflow-safe degraded rule", safeRule !== null);
check("rule makes the degraded screen the scroll container", !!safeRule && /overflow-y:\s*auto/.test(safeRule[0]));
check("rule centers with the overflow-safe keyword", !!safeRule && /justify-content:\s*safe\s*center/.test(safeRule[0]));
check("rule keeps focus scrolls below the top inset", !!safeRule && /scroll-padding-top:\s*16px/.test(safeRule[0]));
check("rule carries the P3-387 comment so refactors know why", /P3-387/.test(css));
const baseRule = css.match(/\.degraded\s*\{[^}]*\}/);
check("base .degraded stays centered for the fitting case", !!baseRule && /justify-content:\s*center/.test(baseRule[0]));
check("no other screen adopts the safe-center override", !/\.screen\.(?!degraded)[a-z-]+\s*\{[^}]*safe\s*center/.test(css));

// --- P3-423: the pairing gate keeps its brand header on screen ---------------
// The manual ceremony outgrows 900px (intro + host section + paste form +
// 5-row pane map) and plain centered flex sheared the wordmark half-clipped
// above the scroll origin (explorer shot journey-pairing-20260911). Same
// overflow-safe centering as .screen.degraded, plus the sticky brand header
// the task asks for: the wordmark rides along while the gate scrolls.
const pairRule = css.match(/\.pair-wrap \.pair-screen\s*\{[^}]*\}/);
check("index.css has the overflow-safe pair-screen rule", pairRule !== null);
check("rule makes the pairing gate a real scroll container", !!pairRule && /overflow-y:\s*auto/.test(pairRule[0]));
check("rule centers with the overflow-safe keyword", !!pairRule && /justify-content:\s*safe\s*center/.test(pairRule[0]));
check("rule moves the top inset onto the sticky header", !!pairRule && /padding-top:\s*0/.test(pairRule[0]));
check("rule keeps focus scrolls clear of the stuck header", !!pairRule && /scroll-padding-top:\s*calc\(100px \+ env\(safe-area-inset-top\)\)/.test(pairRule[0]));
const pairHeader = css.match(/\.pair-wrap \.pair-screen header\s*\{[^}]*\}/);
check("pairing brand header is sticky", !!pairHeader && /position:\s*sticky/.test(pairHeader[0]) && /top:\s*0/.test(pairHeader[0]));
check("stuck header carries an opaque page-color background", !!pairHeader && /background:\s*var\(--bg\)/.test(pairHeader[0]));
check("stuck header keeps the screen's safe-area top inset", !!pairHeader && /padding:\s*calc\(16px \+ env\(safe-area-inset-top\)\)/.test(pairHeader[0]));
check("P3-339 centered-header contract survives the sticky upgrade", !!pairHeader && pairHeader[0].includes("display: block") && pairHeader[0].includes("text-align: center"));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall gate-wordmark checks passed");
