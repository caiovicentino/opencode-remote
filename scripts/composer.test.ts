/**
 * P3-086 unit tests: composer geometry + selector label — the pure helpers
 * from apps/web/src/lib/composer.ts. The DOM wiring (auto-grow effect,
 * dropdown rendering) is exercised by the desktop-flow gate beat.
 * Run: npx tsx scripts/composer.test.ts
 */
import {
  COMPOSER_MAX_LINES,
  clampComposerHeight,
  composerSelectorLabel,
} from "../apps/web/src/lib/composer";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const LH = 22;
const PAD = 20; // 10px top + 10px bottom padding

// single line: the resting height is exactly one line + padding
check("one line of text keeps the single-line height", clampComposerHeight(LH + PAD, LH, PAD) === LH + PAD);

// grows line by line while under the cap
check(
  "three lines grow to three line-heights + padding",
  clampComposerHeight(3 * LH + PAD, LH, PAD) === 3 * LH + PAD,
);

// the cap: anything taller flattens to ~6 lines — the box stops growing and
// the CSS overflow-y: auto takes over (scroll inside, never a giant box)
const cap = clampComposerHeight(40 * LH + PAD, LH, PAD);
check(
  `a 40-line paste clamps to the ${COMPOSER_MAX_LINES}-line cap`,
  cap === LH * COMPOSER_MAX_LINES + PAD,
);

// degenerate inputs never produce a degenerate box
check("zero/negative scrollHeight floors at one line", clampComposerHeight(0, LH, PAD) === LH + PAD);
check("sub-pixel scrollHeights round up to one line", clampComposerHeight(0.4, LH, PAD) === LH + PAD);
check("degenerate line-height is floored at 1px", clampComposerHeight(5, 0, PAD) === 1 + PAD);

// fractional line-height (computed style) lands on whole pixels
check(
  "fractional computed line-height rounds to whole px",
  Number.isInteger(clampComposerHeight(2.5 * LH + PAD, 21.75, 20.5)),
);

// selector label: "agent · model", trimming empty edges, never " · "
check("label joins agent and model", composerSelectorLabel("build", "gpt-5") === "build · gpt-5");
check("label with default model shows only the agent", composerSelectorLabel("plan", "") === "plan");
check("label with empty agent shows only the model", composerSelectorLabel("", "gpt-5") === "gpt-5");
check("label with nothing set is empty", composerSelectorLabel(" ", " ") === "");

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncomposer helpers: all green");
