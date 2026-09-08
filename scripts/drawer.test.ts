/**
 * PWA shell (Bug 2) unit tests: the drawer's pure helpers (rows, recents,
 * unread dot, active row), the time-of-day greeting, the i18n parity of the
 * new copy and the CSS / source pins that keep the shell honest (no tab bar,
 * no session cards, reduced-motion guarantees, 56px rows).
 * Run: npx tsx scripts/drawer.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeDrawerRow, DRAWER_ROWS, hasUnreadDot, recentRows, RECENTS_LIMIT } from "../apps/web/src/lib/drawer";
import { timeGreetingKey } from "../apps/web/src/lib/home";
import { dict, translate } from "../apps/web/src/lib/i18n";
import { PANE_SLOTS, isPaneOpen, topSlot, viewReducer, initialViewState } from "../apps/web/src/lib/viewState";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

// --- drawer rows --------------------------------------------------------------
check("drawer: the four primary rows come first, in the brief's order", DRAWER_ROWS.slice(0, 4).map((r) => r.id).join(",") === "chats,artifacts,mission,settings");
check("drawer: files is the quiet fifth row", DRAWER_ROWS[4]?.id === "files" && DRAWER_ROWS.length === 5);
for (const lang of ["en", "pt"] as const) {
  check(`drawer rows resolve per locale (${lang})`, DRAWER_ROWS.every((r) => translate(lang, r.labelKey) !== r.labelKey && translate(lang, r.labelKey).trim() !== ""));
}
check("pt: Conversas / Artifacts / Mission Control / Configurações / Arquivos", DRAWER_ROWS.map((r) => translate("pt", r.labelKey)).join("|") === "Conversas|Artifacts|Mission Control|Configurações|Arquivos");

// --- recents -------------------------------------------------------------------
const base = Date.parse("2026-09-08T12:00:00Z");
const sessions = [
  { id: "old", title: "Older chat", updatedAt: base - 3 * 86_400_000 },
  { id: "new", title: "Newest chat", updatedAt: base },
  { id: "pilot", title: "P3-329 wizard", updatedAt: base + 1 },
  { id: "untitled", title: "   ", updatedAt: base - 1 },
  { id: "mid", time: { updated: new Date(base - 3_600_000).toISOString() } },
];
const rows = recentRows(sessions, { old: 2, new: 1 }, "new");
check("recents: newest first, pilot sessions excluded", rows.map((r) => r.id).join(",") === "new,untitled,mid,old");
check("recents: blank title falls back to the short id", rows[1].title === "untitled".slice(0, 12));
check("recents: the open conversation is active and never unread", rows[0].active && !rows[0].unread);
check("recents: unread marks other sessions with a badge", rows[3].unread && !rows[2].unread);
check("recents: limit is honored", recentRows(sessions, {}, null, 2).length === 2 && RECENTS_LIMIT === 8);
check("recents: negative limit yields nothing", recentRows(sessions, {}, null, -1).length === 0);
check("recents: empty input", recentRows([], {}, null).length === 0);

// --- unread dot -----------------------------------------------------------------
check("dot: no unread → no dot", !hasUnreadDot({}, null));
check("dot: unread only on the open session → no dot", !hasUnreadDot({ a: 3 }, "a"));
check("dot: unread elsewhere → dot", hasUnreadDot({ a: 0, b: 1 }, "a"));

// --- active row --------------------------------------------------------------------
check("active row: chats slot", activeDrawerRow("chats", false) === "chats");
check("active row: panes map to themselves", ["artifacts", "mission", "settings", "files"].every((s) => activeDrawerRow(s, false) === s));
check("active row: home/chat/browser/share → none", ["chat", "browser", "share"].every((s) => activeDrawerRow(s, true) === null));

// --- view reducer: chats is a slot, not a pane ------------------------------------
const opened = viewReducer(initialViewState, { type: "open", slot: "chats" });
check("viewState: chats opens as the top slot", topSlot(opened) === "chats");
check("viewState: chats is NOT a desktop pane", !PANE_SLOTS.includes("chats") && !isPaneOpen(opened));
check("viewState: back from chats lands on the home (empty stack)", topSlot(viewReducer(opened, { type: "back" })) === "chat");
check("viewState: openChat still replaces the stack", viewReducer(opened, { type: "openChat", sessionId: "s1" }).stack.join(",") === "chat");

// --- greeting -------------------------------------------------------------------------
check("greeting: 5–11 is morning", [5, 8, 11].every((h) => timeGreetingKey(h, true) === "homeMorning"));
check("greeting: 12–17 is afternoon", [12, 15, 17].every((h) => timeGreetingKey(h, true) === "homeAfternoon"));
check("greeting: 18–23 and 0–4 are evening", [18, 21, 23, 0, 4].every((h) => timeGreetingKey(h, true) === "homeEvening"));
check("greeting: anonymous variants when no name", timeGreetingKey(15, false) === "homeAfternoonAnon");
check("greeting: an impossible hour falls back to the timeless key", timeGreetingKey(24, true) === "homeGreeting" && timeGreetingKey(-1, false) === "homeGreetingAnon" && timeGreetingKey(Number.NaN, true) === "homeGreeting");
check("pt: Boa tarde, {name}", translate("pt", "homeAfternoon", { name: "caio vicentino" }) === "Boa tarde, caio vicentino");
check("en: Good afternoon, {name}", translate("en", "homeAfternoon", { name: "caio" }) === "Good afternoon, caio");
const greetKeys = ["homeMorning", "homeAfternoon", "homeEvening", "homeMorningAnon", "homeAfternoonAnon", "homeEveningAnon"];
check("greeting keys resolve in both locales", (["en", "pt"] as const).every((l) => greetKeys.every((k) => translate(l, k) !== k)));

// --- i18n parity + no emoji for the shell copy ------------------------------------------
const shellKeys = ["drawerOpen", "drawerClose", "drawerRecents", "navFiles", "rowMenu", "navConversations", "navArtifacts", "navMission", "navSettings", "newConversation", "unpair", "accountSwitch"];
check("shell keys resolve in both locales", (["en", "pt"] as const).every((l) => shellKeys.every((k) => translate(l, k) !== k && translate(l, k).trim() !== "")));
check("en/pt stay key-aligned", Object.keys(dict.en).length === Object.keys(dict.pt).length);
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2500}-\u{25FF}\u{FE0F}]/u;
check("shell copy has no emoji", (["en", "pt"] as const).every((l) => [...shellKeys, ...greetKeys].every((k) => !EMOJI.test(translate(l, k)))));

// --- source pins: the shell replaced the tab bar / cards -----------------------------------
const app = src("apps/web/src/App.tsx");
check("App: no bottom tab bar anymore", !app.includes("TabBar") && !app.includes("tabbar"));
check("App: hamburger carries the unread dot from the pure helper", app.includes("hasUnreadDot(unread, session)") && app.includes("shell-menu-dot"));
check("App: mobile home is the HomeView mobile variant", /variant="mobile"/.test(app));
check("App: chats is a drawer destination rendered as the list", app.includes('top === "chats"\n                ? sessionsNode'));
check("App: mobile list variant / desktop rows variant", app.includes('variant={isDesktop ? "rows" : "list"}'));
const sessionsView = src("apps/web/src/components/SessionsView.tsx");
check("SessionsView: no card grid, no card edit/delete buttons", !sessionsView.includes("session-card") && !sessionsView.includes("session-grid") && !sessionsView.includes("card-rename"));
check("SessionsView: edit/delete live in the per-row sheet (kebab + long-press)", sessionsView.includes('data-action="rename"') && sessionsView.includes('data-action="delete"') && sessionsView.includes("LONG_PRESS_MS") && sessionsView.includes("convo-row-menu"));
check("SessionsView: one full-width pill for the new conversation", sessionsView.includes("chats-new-pill"));
const home = src("apps/web/src/components/HomeView.tsx");
check("HomeView: mobile variant renders no ideas", home.includes("const ideas = mobile ? [] : homeIdeas(getLang());"));
check("HomeView: product mark is an SVG, not a glyph", home.includes("<IconMark") && !home.includes("✻"));
check("HomeView: mobile greeting is time-of-day", home.includes("timeGreetingKey(new Date().getHours()"));
check("HomeView: mobile model chip reads agent · model", home.includes('mobile ? t("agentOption") : ""'));
const drawer = src("apps/web/src/components/Drawer.tsx");
check("Drawer: exit animation via the shared motion hook (reduced-motion aware)", drawer.includes("useExitAnimation(open, 300)"));
check("Drawer: Escape closes", drawer.includes('e.key === "Escape"'));

// --- CSS pins: tokens, 56px rows, reduced motion, no dead tab-bar rules ------------------
const css = src("apps/web/src/index.css");
check("CSS: tab bar and session-card rules are gone", !css.includes(".tabbar") && !css.includes(".session-card") && !css.includes(".session-grid"));
check("CSS: drawer rows and recents are 56px", /\.drawer-row,\n\.drawer-recent \{[\s\S]*?min-height: 56px;/.test(css));
check("CSS: chats rows are 56px with ellipsis titles", /\.convo-row \{[\s\S]*?min-height: 56px;/.test(css) && /\.convo-row-title \{[\s\S]*?text-overflow: ellipsis;/.test(css));
check("CSS: drawer slide + sheet + home use the motion tokens", css.includes("animation: drawer-in var(--motion-slow) var(--ease-out)") && css.includes("animation: sheet-up var(--motion-slow) var(--ease-out)"));
const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
check("CSS: explicit reduced-motion block covers drawer, sheet, rows, home and card", [".drawer", ".sheet", ".convo-row", ".home-mobile .home-col", ".reauth-card"].every((sel) => reduced.includes(sel)) && reduced.includes("animation: none;"));
check("CSS: home mobile greeting is serif via the shared rule", /\.home-greeting \{[\s\S]*?font-family: ui-serif/.test(css));
check("CSS: no raw hex colors in the new shell block", !/#[0-9a-f]{3,8}\b/i.test(css.slice(css.indexOf("PWA shell (Bug 2)"))));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall drawer checks passed");
