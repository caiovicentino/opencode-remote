/**
 * P2-123 unit tests: the living home's pure contract — lib/home.ts helpers,
 * per-locale idea copy, greeting key selection and the reduced-motion CSS
 * guarantee. DOM wiring (toggle, dropdown, idea clicks) is exercised by the
 * desktop-flow gate beat.
 * Run: npx tsx scripts/home.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { greetingKey, homeIdeas } from "../apps/web/src/lib/home";
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

// P1-056: the Chat/Cowork toggle is gone — the home starts the default agent
// and the session composer remains the single place that picks an agent.
// greeting key never produces a dangling comma copy
check("greetingKey with a name uses homeGreeting", greetingKey("mac-mini") === "homeGreeting");
check("greetingKey with whitespace-only name is anon", greetingKey("  ") === "homeGreetingAnon");
check("greetingKey without a name uses homeGreetingAnon", greetingKey("") === "homeGreetingAnon");

// ideas: exactly 3, per-locale, non-empty, distinct between locales
const homeKeys = [
  "homeGreeting",
  "homeGreetingAnon",
  "homePlaceholder",
  "homeIdeasTitle",
  "homeIdea1Label",
  "homeIdea1Prompt",
  "homeIdea2Label",
  "homeIdea2Prompt",
  "homeIdea3Label",
  "homeIdea3Prompt",
  "homeStartError",
];
for (const lang of ["en", "pt"] as const) {
  const ideas = homeIdeas(lang);
  check(`homeIdeas(${lang}) returns exactly 3 ideas`, ideas.length === 3, JSON.stringify(ideas));
  check(
    `homeIdeas(${lang}) labels and prompts are non-empty`,
    ideas.every((i) => i.label.trim() !== "" && i.prompt.trim() !== ""),
  );
  check(
    `homeIdeas(${lang}) icons map to existing SVG icon ids`,
    ideas.every((i) => ["wrench", "book", "file"].includes(i.icon)),
  );
  check(
    `no home* key resolves to itself in ${lang} (dict parity)`,
    homeKeys.every((k) => translate(lang, k) !== k),
  );
}
const pt = homeIdeas("pt");
const en = homeIdeas("en");
check(
  "idea copy differs between locales (no shared fallback)",
  pt.some((p, i) => p.label !== en[i].label) && pt.some((p, i) => p.prompt !== en[i].prompt),
);
check(
  "greeting interpolates {name} in both locales",
  translate("en", "homeGreeting", { name: "foo" }) === "Back in action, foo" &&
    translate("pt", "homeGreeting", { name: "foo" }) === "De volta à ação, foo",
);

// reduced motion: the .home-* entrance/hover transitions must be zeroed inside
// a dedicated prefers-reduced-motion block in index.css (P3-087 lesson: keep
// the guarantee explicit per feature, not only in the global reset)
const css = src("apps/web/src/index.css");
const reducedBlocks = css.split("@media (prefers-reduced-motion: reduce)").slice(1);
check("index.css still has a prefers-reduced-motion block", reducedBlocks.length > 0);
check(
  "index.css zeroes .home-* motion under prefers-reduced-motion",
  reducedBlocks.some((b) => b.slice(0, b.indexOf("\n}") + 1).includes(".home-")),
);

// no hardcoded pt-BR copy in the new sources — everything rides the dict
const sources = [src("apps/web/src/components/HomeView.tsx"), src("apps/web/src/lib/home.ts")];
check(
  "HomeView.tsx/home.ts carry no hardcoded accented pt-BR copy",
  sources.every((s) => !/[ãõçáéíóúâêô]/i.test(s)),
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nhome helpers: all green");
