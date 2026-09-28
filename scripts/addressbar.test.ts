/**
 * P3-378 (eval-09): the Browser pane's address bar answers every input class.
 * The first P3-378 fix classified a rejection by "does new URL() parse it?",
 * so "localhost:5173" — the dev-server address the auto-preview story is
 * built around — parsed as an opaque URL with the scheme "localhost:" and got
 * the local-FILE sentence ("serve the folder over HTTP and open its localhost
 * URL") telling the user to open the very URL they had typed; "example.com"
 * was an "invalid URL"; javascript:/data:/about: were called local files.
 * lib/addressbar.resolveAddress is the one verdict both panes (webview and
 * the PWA screenshot fallback) now route through: http(s) loads, a
 * schemeless host is completed the omnibox way, file:// and pasted paths get
 * the local-file sentence, any other scheme is named, the rest is a typo.
 * Run: npx tsx scripts/addressbar.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAddress } from "../apps/web/src/lib/addressbar";
import { dict, translate } from "../apps/web/src/lib/i18n";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const verdict = (raw: string) => JSON.stringify(resolveAddress(raw));
const go = (url: string) => JSON.stringify({ kind: "go", url });
const reject = (reason: string) => JSON.stringify({ kind: "reject", reason });

// input → expected verdict (null = nothing to do)
const table: Array<[string, string, string]> = [
  // empty bar: Enter is a no-op, never an "invalid URL" scolding
  ["empty", "", "null"],
  ["whitespace only", "   ", "null"],
  // explicit http(s) — normalized and loaded
  ["http localhost", "http://localhost:5173", go("http://localhost:5173/")],
  ["https domain, padded", "  https://example.com/docs  ", go("https://example.com/docs")],
  ["http without slashes", "http:example.com", go("http://example.com/")],
  // schemeless hosts — the P3-378 regression: completed, never rejected
  ["bare localhost:port", "localhost:5173", go("http://localhost:5173/")],
  ["bare LOCALHOST with path/query/hash", "LOCALHOST:3000/x?y=1#z", go("http://localhost:3000/x?y=1#z")],
  ["bare localhost", "localhost", go("http://localhost/")],
  ["bare loopback IPv4:port", "127.0.0.1:8080", go("http://127.0.0.1:8080/")],
  ["bare IPv6 loopback:port", "[::1]:3000", go("http://[::1]:3000/")],
  ["bare LAN IPv4:port", "192.168.0.10:3000", go("http://192.168.0.10:3000/")],
  ["bare domain → https", "example.com", go("https://example.com/")],
  ["bare domain:port/path → https", "example.com:8443/p", go("https://example.com:8443/p")],
  ["bare IDN domain", "münchen.de", go("https://xn--mnchen-3ya.de/")],
  // local files — the sandboxed pane never opens them (named, with a way out)
  ["file URL", "file:///tmp/explorer-page.html", reject("local-file")],
  ["FILE URL uppercase", "FILE:///tmp/x.html", reject("local-file")],
  ["POSIX path", "/tmp/explorer-page.html", reject("local-file")],
  ["home path", "~/Desktop/x.html", reject("local-file")],
  ["relative path", "./index.html", reject("local-file")],
  ["Windows drive path", "C:\\Users\\x.html", reject("local-file")],
  ["UNC path", "\\\\server\\share", reject("local-file")],
  // other schemes — named as such, never called "local files"
  ["javascript:", "javascript:alert(1)", reject("scheme")],
  ["data:", "data:text/html,hi", reject("scheme")],
  ["about:", "about:blank", reject("scheme")],
  ["chrome:", "chrome://settings", reject("scheme")],
  ["ftp:", "ftp://x.org", reject("scheme")],
  // typos — the generic sentence
  ["bare word", "foo", reject("invalid")],
  ["words with spaces", "hello world", reject("invalid")],
  ["scheme without host", "http://", reject("invalid")],
  ["host with a space", "https://exa mple.com", reject("invalid")],
  ["over the 2048-char contract", `https://example.com/${"x".repeat(2100)}`, reject("invalid")],
];
for (const [name, raw, want] of table) {
  const got = verdict(raw);
  check(`resolveAddress: ${name}`, got === want, `input ${JSON.stringify(raw.slice(0, 60))} → ${got}, want ${want}`);
}
check("resolveAddress: non-string input degrades to null (never throws)", resolveAddress(undefined as unknown as string) === null);
// every "go" verdict is http(s) — the resolver can never widen the pane
const everyGoIsHttp = table
  .map(([, raw]) => resolveAddress(raw))
  .every((v) => !v || v.kind !== "go" || /^https?:\/\//.test(v.url));
check("resolveAddress: every go verdict is http(s)", everyGoIsHttp);

// --- both panes route through the one verdict ---------------------------------
const src = readFileSync(join(import.meta.dirname, "..", "apps", "web", "src", "components", "BrowserView.tsx"), "utf8");
check("BrowserView: both panes resolve typed input via resolveAddress", src.split("resolveAddress(target)").length - 1 === 2);
check("BrowserView: no pane keeps its own http(s) normalizer", !src.includes("normalizeHttpUrl("));
check(
  "BrowserView: the screenshot fallback sends the resolved URL, never the raw text",
  src.includes('callJson("/api/browse/open", "POST", { url: verdict.url })') && !src.includes("{ url: target }"),
);
const reject3 = src.match(/function rejectMessage\(t: TFn, reason: AddressRejection\): string \{([\s\S]*?)\n\}/);
check(
  "BrowserView: rejectMessage maps each reason to its own key",
  !!reject3 &&
    /"local-file"\) return t\("browserLocalFile"\)/.test(reject3[1] ?? "") &&
    /"scheme"\) return t\("browserSchemeBlocked"\)/.test(reject3[1] ?? "") &&
    /return t\("browserInvalidUrl"\)/.test(reject3[1] ?? ""),
);
check("BrowserView: the webview pane's error line is announced (role=alert)", src.includes('<p className="browser-error" role="alert">'));
check(
  "BrowserView: the fallback shows the localized rejection as-is (no {msg} wrapper)",
  src.includes("{rejected ? error : browserErrorText(error, t)}"),
);
check(
  "BrowserView: editing the bar dissolves a rejection in both panes",
  src.split("if (rejected) {\n              setRejected(false);\n              setError(\"\");").length - 1 === 2,
);

// --- copy -------------------------------------------------------------------
for (const lang of ["en", "pt"] as const) {
  const s = translate(lang, "browserSchemeBlocked");
  check(`i18n ${lang}: browserSchemeBlocked resolves and names http(s)`, s !== "browserSchemeBlocked" && s.includes("http(s)"));
  check(
    `i18n ${lang}: the scheme sentence never talks about local files`,
    !/local|arquivo/i.test(s),
    s,
  );
}
check("i18n: en/pt stay key-aligned", Object.keys(dict.en).length === Object.keys(dict.pt).length);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall address-bar checks passed");
