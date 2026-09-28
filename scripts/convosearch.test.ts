/**
 * eval-20 unit tests: the first UI of the P3-400 conversation CONTENT search
 * (lib/convosearch + components/ContentSearch wiring), the find handoff that
 * lands a search hit on its occurrence (lib/convosearch, handoff section), and the keyboard
 * map behind the shortcuts sheet and the palette key hints (lib/shortcuts).
 *
 * Before this slice the daemon answered GET /__ocr/search but no screen
 * called it (apps/daemon/src/index.ts said "no screen consumes the route
 * yet" on d046075); the wiring pins below fail on that tree. The contract block feeds the REAL
 * daemon matcher/orchestrator into the client parser, so an offset or shape
 * drift on either side fails here, not in the owner's hands.
 * Run: npx tsx scripts/convosearch.test.ts
 */
import "./testhome"; // throwaway HOME before any app module loads (testhome.ts)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTENT_SEARCH_DEBOUNCE_MS,
  CONTENT_SEARCH_MIN,
  CONTENT_SEARCH_TIMEOUT_MS,
  FIND_ON_OPEN_TTL_MS,
  SNIPPET_LEAD_PALETTE,
  SNIPPET_LEAD_ROWS,
  contentSearchTerm,
  createScanGate,
  createSearchSequence,
  findHandoffVersion,
  freshHits,
  markFindOnOpen,
  parseContentAnswer,
  snippetSegments,
  subscribeFindHandoff,
  takeFindOnOpen,
} from "../apps/web/src/lib/convosearch";
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  comboFromAccelerator,
  comboKeys,
  comboLabel,
  isMacPlatform,
  isShortcutsToggle,
  isTypingTarget,
  shortcutFor,
} from "../apps/web/src/lib/shortcuts";
import { SEARCH_MIN_TERM, runConversationSearch, searchConversations } from "../apps/daemon/src/searchindex";
import { menuSpec, type MenuItemSpec } from "../apps/desktop/src/menu";
import { dict } from "../apps/web/src/lib/i18n";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const root = join(import.meta.dirname, "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const marked = (segs: { text: string; mark: boolean }[]) => segs.filter((s) => s.mark).map((s) => s.text).join("|");
const plain = (segs: { text: string; mark: boolean }[]) => segs.map((s) => s.text).join("");

// --- term gating ----------------------------------------------------------------
// eval-20 fix round: the verifier measured a production-sized history pulled
// through the tunnel on EVERY settled term — the client raises its own bar
// (3 chars, 500ms pause, one scan in flight) instead of mirroring the route's
// floor. The pin keeps drift protection: the client never drops BELOW the
// daemon's floor (the route still answers 400 under it).
check("term: parity — the client never sits below the daemon's SEARCH_MIN_TERM", CONTENT_SEARCH_MIN >= SEARCH_MIN_TERM, `${CONTENT_SEARCH_MIN} vs ${SEARCH_MIN_TERM}`);
check("term: empty query stays on the device", contentSearchTerm("") === null);
check("term: whitespace-only query stays on the device", contentSearchTerm("   \t") === null);
check("term: one character is too short", contentSearchTerm(" a ") === null);
check("term: two characters never fire a scan (a scan reads up to 200 conversations)", contentSearchTerm(" ab ") === null);
check("term: three characters are searched, trimmed", contentSearchTerm("  abc ") === "abc");
check("term: non-string input fails closed", contentSearchTerm(undefined) === null && contentSearchTerm(42) === null);
check(
  "timing: the pause stays a pause (500ms floor — 250ms fired 7 overlapping scans per word) and the timeout covers the daemon's 1.5s scan",
  CONTENT_SEARCH_DEBOUNCE_MS >= 500 && CONTENT_SEARCH_DEBOUNCE_MS <= 1_000 && CONTENT_SEARCH_TIMEOUT_MS >= 3_000,
  `${CONTENT_SEARCH_DEBOUNCE_MS}ms / ${CONTENT_SEARCH_TIMEOUT_MS}ms`,
);

// --- single-flight gate (verifier B2) ---------------------------------------------
{
  const gate = createScanGate();
  check("gate: the first fire goes out", gate.tryFire() === true);
  check("gate: a second fire is held while one scan is in flight", gate.tryFire() === false);
  check("gate: the landing releases at most ONE held fire (the latest term wins)", gate.landed() === true);
  check("gate: the hold is consumed once — no queue of stale terms", gate.landed() === false);
  check("gate: a fresh fire goes out after the hold was consumed", gate.tryFire() === true);
}

// --- fail-closed parsing -----------------------------------------------------------
check("parse: 404 means an older daemon (unsupported), not an empty result", parseContentAnswer(404, null).kind === "unsupported");
check("parse: 500 is an error", parseContentAnswer(500, { results: [] }).kind === "error");
check("parse: 400 is an error (never sent by the gate, never 'nothing found')", parseContentAnswer(400, { error: "valid q required" }).kind === "error");
check("parse: a non-object body is an error", parseContentAnswer(200, "oops").kind === "error" && parseContentAnswer(200, null).kind === "error");
check("parse: a body without a results array is an error", parseContentAnswer(200, { results: "x" }).kind === "error");
{
  const a = parseContentAnswer(200, {
    truncated: true,
    results: [
      { id: "s1", title: "Deploy", instant: 5, snippet: "the rollback stays", matchStart: 4, matchEnd: 12 },
      null,
      "junk",
      { id: "", snippet: "no id" },
      { id: "s2", snippet: 7 },
      { id: "s1", title: "dup", instant: 1, snippet: "rollback", matchStart: 0, matchEnd: 8 },
      { id: "s3", title: "   ", instant: Number.NaN, snippet: "short", matchStart: 3, matchEnd: 99 },
    ],
  });
  check("parse: a well-formed answer is ok", a.kind === "ok");
  if (a.kind === "ok") {
    check("parse: malformed entries are skipped, never thrown", a.hits.map((h) => h.id).join(",") === "s1,s3", JSON.stringify(a.hits));
    check("parse: one conversation appears once (first wins)", a.hits[0]!.title === "Deploy");
    check("parse: truncated flag is carried", a.truncated === true);
    const s3 = a.hits[1]!;
    check("parse: blank title falls back to the id", s3.title === "s3");
    check("parse: non-finite instant becomes 0", s3.instant === 0);
    check("parse: out-of-range offsets render unmarked, not dropped", s3.matchStart === 0 && s3.matchEnd === 0);
  }
  const b = parseContentAnswer(200, { results: [] });
  check("parse: empty results + missing flag = ok, not truncated", b.kind === "ok" && b.hits.length === 0 && b.truncated === false);
}

// --- de-duplication against the title matches on screen --------------------------------
{
  const hits = ["a", "b", "c"].map((id, i) => ({ id, title: id, instant: 10 - i, snippet: id, matchStart: 0, matchEnd: 1 }));
  check("fresh: title matches already listed are not repeated", freshHits(hits, ["b"]).map((h) => h.id).join("") === "ac");
  check("fresh: server (recency) order is kept", freshHits(hits, []).map((h) => h.id).join("") === "abc");
}

// --- snippet segments ----------------------------------------------------------------
{
  const hit = { snippet: "keep the rollback on", matchStart: 9, matchEnd: 17 };
  const segs = snippetSegments(hit, 40);
  check("segments: exactly the occurrence is marked", marked(segs) === "rollback", JSON.stringify(segs));
  check("segments: short lead context is kept verbatim", plain(segs) === "keep the rollback on", plain(segs));
  const long = { snippet: "one two three four five six seven eight nine ten rollback after", matchStart: 49, matchEnd: 57 };
  const cut = snippetSegments(long, 12);
  check("segments: long lead is cut with an ellipsis", plain(cut).startsWith("…") && marked(cut) === "rollback", plain(cut));
  check("segments: the cut lands on a word boundary", plain(cut) === "…nine ten rollback after", plain(cut));
  check("segments: lead never exceeds the budget (+ellipsis)", plain(cut).indexOf("rollback") <= 13, String(plain(cut).indexOf("rollback")));
  const zero = snippetSegments(long, 0);
  check("segments: lead 0 still shows the match first", plain(zero).startsWith("…rollback"), plain(zero));
  const ws = snippetSegments({ snippet: "line one\n\n  then rollback\nnext", matchStart: 17, matchEnd: 25 }, 40);
  check("segments: whitespace runs collapse in the context", plain(ws) === "line one then rollback next", JSON.stringify(plain(ws)));
  const bad = snippetSegments({ snippet: "  no  range  ", matchStart: 0, matchEnd: 0 }, 20);
  check("segments: no valid range renders one plain segment", bad.length === 1 && !bad[0]!.mark && bad[0]!.text === "no range", JSON.stringify(bad));
  check("segments: row lead < palette lead (narrow sidebar)", SNIPPET_LEAD_ROWS < SNIPPET_LEAD_PALETTE);
}

// --- stale-response guard -----------------------------------------------------------------
{
  const seq = createSearchSequence();
  const first = seq.next();
  const second = seq.next();
  check("sequence: an older request can no longer land", !seq.isCurrent(first) && seq.isCurrent(second));
}

// --- the contract end to end: REAL daemon matcher -> client parser -> segments -------------
{
  const convs = [
    { id: "ses_release", title: "Planejar release 0.3", instant: 1_000, texts: ["O Rollback do auto-update fica no updater."] },
    { id: "ses_deploy", title: "Pipeline de deploy", instant: 3_000, texts: ["Paralelizar o soak.", "Qualquer falha dispara o rollback automático."] },
    { id: "ses_nao", title: "Acentos", instant: 2_000, texts: ["Isso NÃO é regex: a.b literal."] },
    { id: "ses_other", title: "Outra", instant: 4_000, texts: ["nada aqui"] },
  ];
  const direct = searchConversations("rollback", convs);
  const parsed = parseContentAnswer(200, { results: direct, truncated: false });
  check("contract: the daemon's hit shape parses as ok", parsed.kind === "ok");
  if (parsed.kind === "ok") {
    check("contract: recency order survives (deploy before release)", parsed.hits.map((h) => h.id).join(",") === "ses_deploy,ses_release", JSON.stringify(parsed.hits.map((h) => h.id)));
    const marks = parsed.hits.map((h) => marked(snippetSegments(h, SNIPPET_LEAD_ROWS)));
    check("contract: every snippet marks the occurrence, case-folded (rollback / Rollback)", marks.join(",") === "rollback,Rollback", marks.join(","));
  }
  const acc = parseContentAnswer(200, { results: searchConversations("nao", convs), truncated: false });
  check(
    "contract: accent-folded match marks the accented text (nao -> NÃO)",
    acc.kind === "ok" && acc.hits.length === 1 && marked(snippetSegments(acc.hits[0]!, SNIPPET_LEAD_ROWS)) === "NÃO",
    JSON.stringify(acc),
  );
  const regex = parseContentAnswer(200, { results: searchConversations("a.b", convs), truncated: false });
  check("contract: regex characters stay literal through the whole chain", regex.kind === "ok" && regex.hits.length === 1 && regex.hits[0]!.id === "ses_nao");
  const longText = `${"palavra ".repeat(40)}rollback final`;
  const far = searchConversations("rollback", [{ id: "far", title: "Longa", instant: 1, texts: [longText] }]);
  const farParsed = parseContentAnswer(200, { results: far, truncated: false });
  check(
    "contract: a centered daemon snippet is re-cut so the match is visible early in a row",
    farParsed.kind === "ok" && plain(snippetSegments(farParsed.hits[0]!, SNIPPET_LEAD_ROWS)).indexOf("rollback") <= SNIPPET_LEAD_ROWS + 1,
    farParsed.kind === "ok" ? plain(snippetSegments(farParsed.hits[0]!, SNIPPET_LEAD_ROWS)) : "",
  );
}
await (async () => {
  // the orchestrator the route runs, with an injected origin: the route body
  // is { results, truncated } — exactly what parseContentAnswer consumes
  const origin = {
    sessions: async () => [
      { id: "x1", title: "Um", instant: 20 },
      { id: "x2", title: "Dois", instant: 10 },
    ],
    messages: async (id: string) => (id === "x2" ? ["fala do rollback aqui"] : ["nada"]),
  };
  const run = await runConversationSearch("rollback", origin);
  const parsed = parseContentAnswer(200, { results: run.results, truncated: run.truncated });
  check("contract: orchestrator output parses and keeps the only hit", parsed.kind === "ok" && parsed.hits.length === 1 && parsed.hits[0]!.id === "x2", JSON.stringify(run));
  const failed = await runConversationSearch("rollback", { sessions: async () => null, messages: async () => null });
  const fp = parseContentAnswer(200, { results: failed.results, truncated: failed.truncated });
  check("contract: an origin failure reads as an empty PARTIAL answer, never 'nothing exists'", fp.kind === "ok" && fp.hits.length === 0 && fp.truncated === true);
})();

// --- find handoff ------------------------------------------------------------------------------
{
  const t0 = 1_000_000;
  let calls = 0;
  const off = subscribeFindHandoff(() => calls++);
  const v0 = findHandoffVersion();
  markFindOnOpen("ses_a", "  rollback ", t0);
  check("handoff: marking bumps the snapshot version and notifies", findHandoffVersion() === v0 + 1 && calls === 1);
  check("handoff: a foreign conversation never consumes the flag", takeFindOnOpen("ses_b", t0 + 10) === null);
  check("handoff: the named conversation gets the trimmed term", takeFindOnOpen("ses_a", t0 + 20) === "rollback");
  check("handoff: consumed once", takeFindOnOpen("ses_a", t0 + 30) === null);
  markFindOnOpen("ses_a", "deploy", t0);
  check("handoff: expired flag is dropped", takeFindOnOpen("ses_a", t0 + FIND_ON_OPEN_TTL_MS + 1) === null);
  check("handoff: ...and stays dropped", takeFindOnOpen("ses_a", t0 + 5) === null);
  markFindOnOpen("ses_a", "deploy", t0);
  check("handoff: a clock that went backwards drops the flag", takeFindOnOpen("ses_a", t0 - 1) === null);
  markFindOnOpen("ses_a", "   ", t0);
  check("handoff: a blank term clears instead of arming", takeFindOnOpen("ses_a", t0) === null);
  off();
  markFindOnOpen("ses_z", "x y", t0);
  check("handoff: unsubscribe stops notifications", calls === 4, String(calls));
  takeFindOnOpen("ses_z", t0);
}

// --- keyboard map -----------------------------------------------------------------------------
check("platform: MacIntel is mac", isMacPlatform("MacIntel") && isMacPlatform("macOS"));
check("platform: iPad/iPhone print mac key caps", isMacPlatform("iPad") && isMacPlatform("iPhone"));
check("platform: Windows/Linux/unknown are not", !isMacPlatform("Win32") && !isMacPlatform("Linux x86_64") && !isMacPlatform(undefined));
check("caps: ⌘K on macOS", comboKeys({ mod: true, key: "K" }, true).join(" ") === "⌘ K" && comboLabel({ mod: true, key: "K" }, true) === "⌘K");
check("caps: Ctrl+K elsewhere", comboKeys({ mod: true, key: "K" }, false).join(" ") === "Ctrl K" && comboLabel({ mod: true, key: "K" }, false) === "Ctrl+K");
check("caps: shift order follows each platform (⇧Enter / Shift+Enter)", comboLabel({ shift: true, key: "Enter" }, true) === "⇧Enter" && comboLabel({ shift: true, key: "Enter" }, false) === "Shift+Enter");

const key = (k: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }> = {}) => ({ key: k, ...m });
check("toggle: ⌘/ on macOS", isShortcutsToggle(key("/", { metaKey: true }), true, false));
check("toggle: ⌘/ works while typing (like ⌘K)", isShortcutsToggle(key("/", { metaKey: true }), true, true));
check("toggle: Ctrl+/ is not the mac binding", !isShortcutsToggle(key("/", { ctrlKey: true }), true, false));
check("toggle: Ctrl+/ on Windows/Linux", isShortcutsToggle(key("/", { ctrlKey: true }), false, false));
check("toggle: ⌘? (shifted slash) also toggles", isShortcutsToggle(key("?", { metaKey: true, shiftKey: true }), true, false));
check("toggle: bare ? outside a text field", isShortcutsToggle(key("?", { shiftKey: true }), true, false));
check("toggle: bare ? INSIDE a text field stays typing", !isShortcutsToggle(key("?", { shiftKey: true }), true, true));
check("toggle: Alt combos never toggle", !isShortcutsToggle(key("/", { metaKey: true, altKey: true }), true, false));
check("toggle: plain / never toggles", !isShortcutsToggle(key("/"), true, false));
check("toggle: auto-repeat never toggles (a held ⌘/ flips the sheet once, not per repeat)", !isShortcutsToggle(key("/", { metaKey: true, repeat: true }), true, false));
check("toggle: auto-repeat never toggles (bare ? held)", !isShortcutsToggle(key("?", { shiftKey: true, repeat: true }), true, false));

check("typing: textarea and text inputs take text", isTypingTarget({ tagName: "TEXTAREA" }) && isTypingTarget({ tagName: "INPUT", type: "search" }) && isTypingTarget({ tagName: "input" }));
check("typing: contentEditable takes text", isTypingTarget({ tagName: "DIV", isContentEditable: true }));
check("typing: buttons/checkboxes/body do not", !isTypingTarget({ tagName: "BUTTON" }) && !isTypingTarget({ tagName: "INPUT", type: "checkbox" }) && !isTypingTarget({ tagName: "BODY" }) && !isTypingTarget(null));

// parity with the desktop Go menu (the real bindings in the Electron shell)
{
  const flat = (items: MenuItemSpec[]): MenuItemSpec[] => items.flatMap((i) => [i, ...flat(i.submenu ?? [])]);
  const menu = flat(menuSpec("darwin", null, false));
  const menuWin = flat(menuSpec("win32", null, false));
  const withAcc = SHORTCUTS.filter((s) => s.menuAccelerator);
  check("parity: every navigation shortcut mirrors a Go-menu accelerator", withAcc.length === 8, String(withAcc.length));
  for (const s of withAcc) {
    const item = menu.find((i) => i.accelerator === s.menuAccelerator);
    const combo = comboFromAccelerator(s.menuAccelerator!);
    check(
      `parity: ${s.id} = ${s.menuAccelerator} in the Go menu (mac + win) and the same combo in the sheet`,
      !!item && !!menuWin.find((i) => i.accelerator === s.menuAccelerator) &&
        !!combo && combo.mod === s.combo.mod && combo.key === s.combo.key.toUpperCase() && !!combo.shift === !!s.combo.shift &&
        item.action === s.id,
      JSON.stringify({ item, combo }),
    );
  }
  const goAccelerated = menu.filter((i) => i.action && i.accelerator && i.registerAccelerator !== false);
  const missing = goAccelerated.filter((i) => !SHORTCUTS.some((s) => s.menuAccelerator === i.accelerator));
  check("parity: no Go-menu accelerator is missing from the sheet", missing.length === 0, JSON.stringify(missing));
}
// the renderer fallback (PWA / no bridge) binds the same keys
{
  const app = src("apps/web/src/App.tsx");
  check(
    "parity: App's renderer fallback maps ⌘1..⌘6 in the sheet's pane order",
    app.includes('const PANE_ACCELERATORS = ["chat", "artifacts", "browser", "files", "settings", "mission"] as const;') &&
      ["chat", "artifacts", "browser", "files", "settings", "mission"].every((p, i) => shortcutFor(`pane:${p}`)?.combo.key === String(i + 1)),
  );
  check("parity: App's renderer fallback binds ⌘T and ⌘K", /k === "t"/.test(app) && /k === "k"/.test(app));
  const chat = src("apps/web/src/components/ChatView.tsx");
  check("parity: ChatView binds ⌘F for find and Enter/Shift+Enter in the composer", chat.includes('e.key.toLowerCase() === "f"') && chat.includes('e.key === "Enter" && !e.shiftKey'));
}
for (const s of SHORTCUTS) {
  check(`i18n: shortcut "${s.id}" has its label in en and pt`, !!(dict.en as Record<string, string>)[s.labelKey] && !!(dict.pt as Record<string, string>)[s.labelKey]);
}
check("sheet: every shortcut belongs to a rendered group", SHORTCUTS.every((s) => SHORTCUT_GROUPS.some((g) => g.group === s.group)));

// --- i18n for the new surfaces ------------------------------------------------------------------
{
  const keys = [
    "paletteKindMessage",
    "paletteShortcuts",
    "contentSearchHeading",
    "contentSearchLoading",
    "contentSearchNone",
    // eval-20 fix round: the honest degraded state (a partial scan with
    // nothing is never "nothing found") and the deep-handoff pointer
    "contentSearchDegraded",
    "findOlderHint",
    "findOlderLoad",
    "contentSearchPartial",
    "contentSearchError",
    "contentSearchUnsupported",
    "shortcutsTitle",
    "shortcutsGroupNav",
    "shortcutsGroupChat",
    "shortcutsGroupGeneral",
    "shortcutsFoot",
  ];
  const en = dict.en as Record<string, string>;
  const pt = dict.pt as Record<string, string>;
  const missing = keys.filter((k) => !en[k] || !pt[k]);
  check("i18n: every new key exists in en and pt", missing.length === 0, missing.join(","));
  const untranslated = keys.filter((k) => en[k] && en[k] === pt[k]);
  check("i18n: pt-BR is translated, not the English copy", untranslated.length === 0, untranslated.join(","));
  check("i18n: the nothing-found line names the term", en.contentSearchNone?.includes("{q}") && pt.contentSearchNone?.includes("{q}"));
  check("i18n: the foot names the palette combo from code (no ⌘ in the dictionary)", en.shortcutsFoot?.includes("{combo}") && pt.shortcutsFoot?.includes("{combo}"));
}

// --- regression pins for the verifier's findings (behavior rides the eval-20
// --- beat of the desktop flow; these pins fail when the FIX is reverted) ------
{
  const cs = src("apps/web/src/components/ContentSearch.tsx");
  check("wiring: the hook calls the P3-400 route with q", cs.includes('"/__ocr/search"') && cs.includes("{ q: term }"));
  check("wiring: only the latest request may land", cs.includes("seq.current.isCurrent(mine)"));
  check(
    "wiring: single-flight — the hook fires through the scan gate (B2: one scan in flight, one held refire)",
    cs.includes("createScanGate()") && cs.includes("gate.current.tryFire()") && cs.includes("gate.current.landed()"),
  );
  const convosearchLib = src("apps/web/src/lib/convosearch.ts");
  check("wiring: the client debounces at 500ms and gates at 3 chars (B2)", convosearchLib.includes("export const CONTENT_SEARCH_MIN = 3;") && convosearchLib.includes("export const CONTENT_SEARCH_DEBOUNCE_MS = 500;"));
  const daemon = src("apps/daemon/src/index.ts");
  check("wiring: the daemon still serves the same path + param", daemon.includes('req.path === "/__ocr/search"') && daemon.includes("req.query?.q"));
  const sessions = src("apps/web/src/components/SessionsView.tsx");
  check(
    "wiring: the conversation list renders the content section with the title matches excluded",
    sessions.includes("<ContentSearchSection") && sessions.includes("titleMatchIds={filtered.map((s) => s.id)}") && sessions.includes("openFromSearch(id, term, onOpen)"),
  );
  check("wiring: the section receives the live query (never a blank one)", sessions.includes("query={query}"));
  const palette = src("apps/web/src/components/CommandPalette.tsx");
  check("wiring: the palette appends content hits and the shortcuts action", palette.includes("useContentSearch(request, query)") && palette.includes("openShortcutsSheet") && palette.includes("freshHits(content.hits"));
  check(
    "wiring: the palette never shows 'No matches' for a degraded scan (B1: partial-with-nothing is honest, with a retry)",
    palette.includes('content.phase !== "error"') && palette.includes("!(content.phase === \"ok\" && content.truncated)") && palette.includes("contentSearchDegraded"),
  );
  const chat = src("apps/web/src/components/ChatView.tsx");
  check(
    "wiring: the handoff opens the bar even when the term is not on the loaded page (B3: no silent no-op)",
    chat.includes("usePendingFind(sessionId)") && chat.includes("setSearchOpen(true);") && chat.includes("setFindOlder(hasMore)"),
  );
  check(
    "wiring: the deep handoff reuses the P1-064 older-page loader and lands the cursor on the oldest occurrence (the snippet's)",
    chat.includes("void loadMore()") && chat.includes("handoffFindRef.current = true") && chat.includes("setSearchIdx(0);"),
  );
  check("wiring: ⌘F closes the sheet (B5c: the bar opens above the scrim)", chat.includes("FIND_OPEN_EVENT"));
  const app = src("apps/web/src/App.tsx");
  check("wiring: the paired shell mounts the shortcuts sheet once", (app.match(/<ShortcutsSheet \/>/g) ?? []).length === 1);
  check(
    "wiring: ⌘K (menu IPC or fallback) closes the sheet (B5c) and the sheet rides its own chunk (B7: bundle ceiling)",
    app.includes("PALETTE_OPEN_EVENT") && app.includes('lazy(() => import("./components/ShortcutsSheet"))'),
  );
  const sheet = src("apps/web/src/components/ShortcutsSheet.tsx");
  check(
    "wiring: the sheet's Esc is a window CAPTURE listener (B4: it blocks the AskDialog/Modal bubble listeners, which were registered first)",
    sheet.includes('window.addEventListener("keydown", onKey, true)') && sheet.includes("e.stopPropagation();"),
  );
  check(
    "wiring: the sheet traps Tab like AskDialog (B5b: aria-modal without a trap lets focus walk out)",
    sheet.includes("onKeyDown={trapTab}") && sheet.includes("if (e.key !== \"Tab\") return;"),
  );
  check(
    "wiring: the sheet's guard keeps the '?' typing guard (mutating the guard away must fail)",
    sheet.includes("isTypingTarget(document.activeElement as HTMLElement | null)"),
  );
  const shared = src("apps/web/src/components/ShortcutsShared.tsx");
  check(
    "wiring: the key chips read as label + combo (B5a: sr-only text, the kbd caps stay decorative)",
    shared.includes('<span className="sr-only">{label}</span>') && shared.includes('<kbd key={i} className="kbd" aria-hidden>'),
  );
  const css = src("apps/web/src/index.css");
  check(
    "wiring: the sheet close button and the retry link reach the 44px touch convention (B5d)",
    css.includes(".shortcuts-close::before") && css.includes(".content-hits-retry::before") && css.includes(".sr-only"),
  );
}

if (failures > 0) {
  console.error(`FAILURES: ${failures}`);
  process.exit(1);
}
console.log("convosearch: all green");
