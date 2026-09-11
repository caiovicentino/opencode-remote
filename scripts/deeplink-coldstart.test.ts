/**
 * P2-329: the Windows cold-start deep-link plan. An invite link clicked with
 * the app closed launches the packaged shell with the URI in argv — the plan
 * (apps/desktop/src/deeplink.ts coldStartDeepLink) decides whether that argv
 * is consumed, in a fixed rule order: harness session → dev build → platform
 * (only win32; macOS delivers via open-url) → deepLinkFromArgv. This file
 * pins every branch of the plan AND the real main.ts wiring: the consult
 * happens exactly once, its result rides the existing handleDeepLink cache,
 * and no log line ever includes the URI (it carries pairing key material).
 * Portable by construction — node:fs reads plus pure functions only, no
 * Electron, no sockets, no timers (scripts/portable-suite.ts).
 * Run: npx tsx scripts/deeplink-coldstart.test.ts
 */
import { readFileSync } from "node:fs";
import { DEEP_LINK_QUERY_MAX, coldStartDeepLink } from "../apps/desktop/src/deeplink";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const deepUri =
  `opencode-remote://pair?v=2&relay=wss%3A%2F%2Frelay.example.com&room=abc123` +
  `&k=${encodeURIComponent("abcd1234efgh")}&name=mac`;

// --- the plan: rules in the documented order ---------------------------------

const coldArgv = ["C:\\Program Files\\opencode-remote\\opencode-remote.exe", "--hidden", deepUri];

check("coldStartDeepLink ignores the link in a harness session", coldStartDeepLink({ harnessSession: true, packaged: true, platform: "win32", argv: coldArgv }) === null);

check("coldStartDeepLink ignores the link in a dev build", coldStartDeepLink({ harnessSession: false, packaged: false, platform: "win32", argv: coldArgv }) === null);

check("coldStartDeepLink ignores argv on darwin (open-url delivers the link)", coldStartDeepLink({ harnessSession: false, packaged: true, platform: "darwin", argv: coldArgv }) === null);

check("coldStartDeepLink extracts the URI from a packaged win32 argv", coldStartDeepLink({ harnessSession: false, packaged: true, platform: "win32", argv: coldArgv }) === deepUri);

check("coldStartDeepLink returns null when argv has only the executable path", coldStartDeepLink({ harnessSession: false, packaged: true, platform: "win32", argv: ["C:\\Program Files\\opencode-remote\\opencode-remote.exe"] }) === null);

check("coldStartDeepLink rejects a foreign scheme in argv", coldStartDeepLink({ harnessSession: false, packaged: true, platform: "win32", argv: ["C:\\app.exe", "https://evil.example/pair?v=2&room=x"] }) === null);

check("coldStartDeepLink rejects an unknown action in argv", coldStartDeepLink({ harnessSession: false, packaged: true, platform: "win32", argv: ["C:\\app.exe", "opencode-remote://evil?v=2&room=x"] }) === null);

check(
  "coldStartDeepLink rejects an oversize query in argv",
  coldStartDeepLink({
    harnessSession: false,
    packaged: true,
    platform: "win32",
    argv: ["C:\\app.exe", `opencode-remote://pair?v=2&room=${"a".repeat(DEEP_LINK_QUERY_MAX)}`],
  }) === null,
);

// --- the real main.ts wiring --------------------------------------------------

const mainTsSource = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");

check("main.ts consults the cold-start plan exactly once", (mainTsSource.match(/coldStartDeepLink\(/g) ?? []).length === 1);

check("main.ts feeds the cold-start result through handleDeepLink", /handleDeepLink\s*\(\s*coldStartDeepLink\(/.test(mainTsSource));

check("main.ts cold-start consult passes the harness, packaged, platform and argv inputs", /coldStartDeepLink\(\{[\s\S]*?harnessSession:[\s\S]*?packaged:[\s\S]*?platform:[\s\S]*?argv:[\s\S]*?\}\)/.test(mainTsSource));

const deepLinkSection = mainTsSource.slice(
  mainTsSource.indexOf("// --- opencode-remote:// deep links"),
  mainTsSource.indexOf("// --- first-run pairing watcher"),
);

const deepLinkSectionLogs = deepLinkSection.match(/^\s*log\([^\n]*$/gm) ?? [];

check("deep-link section has exactly one log line and it never names the URI", deepLinkSectionLogs.length === 1 && deepLinkSectionLogs[0].includes("deep link accepted (opencode-remote://pair)"));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall deeplink cold-start checks passed");
