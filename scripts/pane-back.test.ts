/**
 * P3-419: the desk panes (Artifacts, Browser, Mission Control) led their
 * headers with a "←" back arrow even in the desktop shell, where the rail is
 * the navigator and "back" semantics are unclear (explorer shot
 * journey-artifact-pane-20260911). Same fix class as P1-005's .chat-back:
 * the arrow is mobile chrome, hidden by the desktop-only chrome block at
 * >= 1024px — the desk-shell threshold (the desktop window cannot go below
 * WINDOW_MIN.width = 1024, App's isDesktop gate agrees), NOT
 * isSplitViewport's 900px: between 900 and 1023 the app still renders the
 * mobile shell with no rail, and a pane filling the whole screen there
 * needs its arrow. Source pins keep every pane back button marked and the
 * CSS rule alive, so a new header cannot reintroduce the unmarked arrow.
 * Run: npx tsx scripts/pane-back.test.ts
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

const web = join(import.meta.dirname, "..", "apps", "web", "src");

// every back-arrow button in the three panes carries .pane-back — an unmarked
// "←" would lead the header again in the rail-navigated desktop shell
const panes = ["ArtifactsView.tsx", "BrowserView.tsx", "MissionControlView.tsx"];
for (const pane of panes) {
  const src = readFileSync(join(web, "components", pane), "utf8");
  const arrows = src.split("\n").filter((l) => l.includes("←"));
  const unmarked = arrows.filter((l) => !l.includes("pane-back"));
  check(
    `${pane}: back arrow(s) carry .pane-back`,
    arrows.length > 0 && unmarked.length === 0,
    `${unmarked.length} of ${arrows.length} unmarked`,
  );
}

const css = readFileSync(join(web, "index.css"), "utf8");
const chrome = css.match(/@media \(min-width: 1024px\) \{[^}]*\.chat-back[^}]*\}/);
check(
  "index.css hides .pane-back in the desktop-only chrome block",
  !!chrome && chrome[0].includes(".pane-back"),
);
check("chrome block keeps the P1-005 .chat-back precedent intact", !!chrome && chrome[0].includes(".chat-back"));
check("no narrower (900px) media rule hides .pane-back", !css.match(/@media \(min-width:\s*900px\)[^{]*\{[^@]*\.pane-back/));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall pane-back checks passed");
