/**
 * P2-276: shell language tests (apps/desktop/src/shelllang.ts) — the portable
 * twin of the unit.test.ts block. Pure node: no Electron, no sockets, no
 * chmod, no spawn; the only fs use is reading the real shelllang.ts and
 * menu.ts sources for the purity/labeling assertions, via URLs relative to
 * this file (Windows-safe).
 * Run: npx tsx scripts/shelllang.test.ts
 */
import { readFileSync } from "node:fs";
import { shellLang, shellLabels, SUPPORTED_SHELL_LANGS, type ShellLabels } from "../apps/desktop/src/shelllang";
import { menuSpec, type MenuItemSpec } from "../apps/desktop/src/menu";
import { TRAY_TIP_MAX_CHARS } from "../apps/desktop/src/traystatus";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const en = shellLabels("en");
const pt = shellLabels("pt");

// --- the full shellLang rule table (rule order per the module header) -----------
{
  // Rule 1 + 3: missing preference → the system decides; Portuguese prefix → pt.
  check(
    "P2-276: absent preference + pt system → pt (system origin)",
    shellLang(null, "pt-BR", SUPPORTED_SHELL_LANGS).lang === "pt" &&
      shellLang(undefined, "pt", SUPPORTED_SHELL_LANGS).lang === "pt" &&
      shellLang(null, "PT-br", SUPPORTED_SHELL_LANGS).origin === "system",
  );
  // Rule 1 + 4: missing preference + unknown system → en, the safe default.
  check(
    "P2-276: absent preference + unknown system → en (default origin)",
    shellLang(null, "es-ES", SUPPORTED_SHELL_LANGS).lang === "en" &&
      shellLang(null, null, SUPPORTED_SHELL_LANGS).lang === "en" &&
      shellLang(undefined, "", SUPPORTED_SHELL_LANGS).origin === "default",
  );
  // Rule 1: non-textual and out-of-list preferences are discarded, never guessed.
  check(
    "P2-276: non-textual and out-of-list preferences are discarded",
    shellLang(7, "pt-BR", SUPPORTED_SHELL_LANGS).origin === "system" &&
      shellLang({ lang: "pt" }, "en-US", SUPPORTED_SHELL_LANGS).origin === "default" &&
      shellLang("fr", "en-US", SUPPORTED_SHELL_LANGS).lang === "en" &&
      shellLang("", "pt-BR", SUPPORTED_SHELL_LANGS).lang === "pt",
  );
  // Rule 2: a supported preference wins over the system, both directions.
  check(
    "P2-276: supported preference beats the system language (rule order)",
    shellLang("en", "pt-BR", SUPPORTED_SHELL_LANGS).lang === "en" &&
      shellLang("en", "pt-BR", SUPPORTED_SHELL_LANGS).origin === "preference" &&
      shellLang("pt", "en-US", SUPPORTED_SHELL_LANGS).lang === "pt",
  );
  // Rule 5: deterministic across calls.
  check(
    "P2-276: identical inputs produce an identical decision across two calls",
    JSON.stringify(shellLang(null, "pt-BR", SUPPORTED_SHELL_LANGS)) ===
      JSON.stringify(shellLang(null, "pt-BR", SUPPORTED_SHELL_LANGS)) &&
      JSON.stringify(shellLang("pt", "en-US", SUPPORTED_SHELL_LANGS)) ===
        JSON.stringify(shellLang("pt", "en-US", SUPPORTED_SHELL_LANGS)),
  );
}

// --- shellLabels: parity + hygiene ----------------------------------------------
{
  const tableValues = (t: ShellLabels): string[] => [
    ...Object.values(t.menu),
    ...Object.values(t.tray).flatMap((p) => [p.tooltip, p.menuLine]),
  ];
  const all = [...tableValues(en), ...tableValues(pt)];

  check(
    "P2-276: exact key parity between en and pt (menu + tray)",
    JSON.stringify(Object.keys(en.menu)) === JSON.stringify(Object.keys(pt.menu)) &&
      JSON.stringify(Object.keys(en.tray)) === JSON.stringify(Object.keys(pt.tray)),
  );
  check(
    "P2-276: every label is non-empty and within the documented ceiling",
    all.every((s) => s.length > 0 && s.length <= TRAY_TIP_MAX_CHARS),
  );
  check(
    "P2-276: no label carries an emoji (P2-107)",
    all.every((s) => !/\p{Extended_Pictographic}/u.test(s)),
  );
  check(
    "P2-276: no label carries a path, address, port or secret",
    all.every(
      (s) =>
        !s.includes("/") &&
        !s.includes("\\") &&
        !/:\d/.test(s) &&
        !/localhost|127\.0\.0\.1|0x[0-9a-f]/i.test(s) &&
        !/token|secret|password|api[- ]?key/i.test(s),
    ),
  );
}

// --- real-source: menu.ts consumes the table, shelllang.ts stays pure -----------
{
  const menuSrc = readFileSync(new URL("../apps/desktop/src/menu.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*/g, " ");
  check(
    "P2-276: the real menu.ts consumes the shell vocabulary with no label literal",
    menuSrc.includes("labels.menu.") && !menuSrc.includes("label: \"") && !menuSrc.includes("Nova conversa"),
  );

  const shellLangSrc = readFileSync(new URL("../apps/desktop/src/shelllang.ts", import.meta.url), "utf8");
  check(
    "P2-276: the real shelllang.ts imports no electron, no node:fs and no node:path",
    shellLangSrc
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import "))
      .every((line) => !line.includes("electron") && !line.includes("node:fs") && !line.includes("node:path")),
  );

  // ids, order and accelerators are identical across languages (P1-046 contract).
  const specIds = (items: MenuItemSpec[]): string[] =>
    items.flatMap((i) => (i.id ? [i.id] : i.submenu ? specIds(i.submenu) : []));
  const specAccel = (items: MenuItemSpec[]): string[] =>
    items.flatMap((i) => (i.accelerator ? [i.accelerator] : i.submenu ? specAccel(i.submenu) : []));
  for (const platform of ["darwin", "win32", "linux"]) {
    const a = menuSpec(platform, null, false, null, undefined, pt);
    const b = menuSpec(platform, null, false, null, undefined, en);
    check(
      `P2-276: ids/order/accelerators unchanged across languages on ${platform}`,
      JSON.stringify(specIds(a)) === JSON.stringify(specIds(b)) &&
        JSON.stringify(specAccel(a)) === JSON.stringify(specAccel(b)),
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll P2-276 shelllang checks passed");
