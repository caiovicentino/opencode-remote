/**
 * P3-419: the desk panes (Artifacts, Browser, Mission Control) led their
 * headers with a "←" back arrow even in the desktop shell, where the rail is
 * the navigator and "back" semantics are unclear (explorer shot
 * journey-artifact-pane-20260911). Same surface as P1-005's .chat-back: at
 * >=1024px the arrow no longer leads — the title does, and the arrow paints
 * after it (flex order). The button stays rendered: at the gate shell the
 * rail's Conversas slot is disabled and the pane's own back button is the
 * only way back to the hero, which is exactly what the P3-365 desktop-flow
 * beats click. The threshold is the desk-shell one (the desktop window
 * cannot go below WINDOW_MIN.width = 1024, App's isDesktop gate agrees),
 * NOT isSplitViewport's 900px: between 900 and 1023 the app still renders
 * the mobile shell with no rail, and a pane filling the whole screen there
 * needs its leading arrow. Source pins keep every pane back button marked
 * and the CSS rule alive, so a new header cannot reintroduce the unmarked
 * arrow.
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
const chromeStart = css.indexOf("@media (min-width: 1024px) {");
const chromeEnd = css.indexOf("\n}", chromeStart);
const chrome = chromeStart >= 0 && chromeEnd > chromeStart ? css.slice(chromeStart, chromeEnd) : "";
check("index.css has the desktop-only chrome block", chromeStart >= 0);
check(
  "chrome block moves .pane-back after the title (order: 1) at desk widths",
  /\/?\.pane-back\s*\{[^}]*order:\s*1/.test(chrome),
);
check(
  "chrome block keeps .pane-back rendered — the gate's only pane exit (P3-365)",
  !/\.pane-back[^{]*\{[^}]*display:\s*none/.test(chrome),
);
check("chrome block keeps the P1-005 .chat-back precedent intact", chrome.includes(".chat-back"));
check("no narrower (900px) media rule touches .pane-back", !css.match(/@media \(min-width:\s*900px\)[^{]*\{[^@]*\.pane-back/));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall pane-back checks passed");
