/**
 * P2-350: proxy-auth verdict tests (apps/desktop/src/proxyauth.ts) — the
 * portable twin of the unit.test.ts block. Pure node: no Electron, no
 * sockets, no chmod, no spawn; the only fs use is reading the real main.ts
 * and proxyauth.ts sources for the wiring/purity assertions, via URLs
 * relative to this file (Windows-safe).
 * Run: npx tsx scripts/proxyauth.test.ts
 */
import { readFileSync } from "node:fs";
import { proxyAuthVerdict } from "../apps/desktop/src/proxyauth";
import { buildDiagnosticReport, type DiagnosticsInput } from "../apps/desktop/src/diagnostics";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const json = (v: unknown) => JSON.stringify(v);

// --- the three closed outputs ----------------------------------------------------
{
  const PROXY = proxyAuthVerdict({ isProxy: true, scheme: "basic", host: "proxy.corp" });
  const NOTPROXY = proxyAuthVerdict({ isProxy: false, scheme: "negotiate", host: "example.com" });
  const UNKNOWN = proxyAuthVerdict({});
  check("isProxy true → proxy-auth-required", PROXY.state === "proxy-auth-required");
  check("isProxy false → not-proxy", NOTPROXY.state === "not-proxy");
  check("every state carries its own static phrase", new Set([PROXY.message, NOTPROXY.message, UNKNOWN.message]).size === 3);
  check(
    "no phrase carries the host, a port, the scheme or a credential",
    [PROXY, NOTPROXY, UNKNOWN].every(
      (v) =>
        !v.message.includes("proxy.corp") &&
        !v.message.includes("example.com") &&
        !v.message.includes("basic") &&
        !v.message.includes("negotiate") &&
        !/\d/.test(v.message) &&
        !v.message.includes("://") &&
        !v.message.includes("@"),
    ),
  );
}

// --- fail-closed table: every malformed shape is "unknown" ------------------------
{
  check(
    "non-object and missing input become unknown",
    ["junk", 42, true, [], new Date(), () => 1].map((v) => proxyAuthVerdict(v).state).every((s) => s === "unknown") &&
      proxyAuthVerdict().state === "unknown" &&
      proxyAuthVerdict(undefined).state === "unknown" &&
      proxyAuthVerdict(null).state === "unknown",
  );
  check(
    "a missing or non-boolean isProxy is unknown",
    proxyAuthVerdict({ scheme: "basic", host: "h" }).state === "unknown" &&
      ["true", 1, 0, null].every((x) => proxyAuthVerdict({ isProxy: x }).state === "unknown"),
  );
  check(
    "a non-textual scheme or host fails closed to unknown",
    proxyAuthVerdict({ isProxy: true, scheme: 42 }).state === "unknown" &&
      proxyAuthVerdict({ isProxy: true, scheme: [] }).state === "unknown" &&
      proxyAuthVerdict({ isProxy: true, scheme: { bad: 1 } }).state === "unknown" &&
      proxyAuthVerdict({ isProxy: true, host: {} }).state === "unknown" &&
      proxyAuthVerdict({ isProxy: true, host: 9 }).state === "unknown",
  );
  check(
    "null scheme/host count as absent, not as garbage",
    proxyAuthVerdict({ isProxy: true, scheme: null, host: null }).state === "proxy-auth-required" &&
      proxyAuthVerdict({ isProxy: false, scheme: null, host: null }).state === "not-proxy",
  );
  let threw = false;
  try {
    for (const input of [NaN, undefined, null, 42, "boom", true, [], new Date(), () => 1, { isProxy: true, scheme: {} }, { isProxy: NaN }]) {
      proxyAuthVerdict(input);
    }
  } catch {
    threw = true;
  }
  check("no input shape ever throws", !threw);
  const input = { isProxy: true, scheme: "basic", host: "proxy.corp" };
  check("determinism: the same input yields the exact same verdict twice", json(proxyAuthVerdict(input)) === json(proxyAuthVerdict(input)));
}

// --- the diagnostic bundle carries the verdict (P2-345 package) -------------------
{
  const diagBase: DiagnosticsInput = {
    appVersion: "0.2.0",
    electronVersion: "44.1.1",
    platform: "darwin arm64",
    locale: "pt-BR",
    packaged: true,
    userData: "/u",
    daemon: { healthy: true, down: false, reconnecting: false, attempts: 0, port: 8792, portReason: null },
    logTail: [],
    sidecarLogTail: [],
    crashFiles: [],
    updateStatus: null,
  };
  check(
    "diagnostics: the proxy-auth line rides state + static phrase",
    buildDiagnosticReport({ ...diagBase, proxyAuth: proxyAuthVerdict({ isProxy: true, scheme: "basic", host: "proxy.corp" }) }).includes(
      `proxy auth: proxy-auth-required (${proxyAuthVerdict({ isProxy: true, scheme: "basic", host: "proxy.corp" }).message})`,
    ),
  );
  check(
    "diagnostics: the absent field renders the closed unknown once",
    (buildDiagnosticReport(diagBase).match(/^proxy auth: unknown$/gm) ?? []).length === 1,
  );
}

// --- the real sources: wiring and module purity ------------------------------------
{
  const mainSrc = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  check("wiring: exactly one app.on('login') listener in main.ts", mainSrc.split('app.on("login"').length - 1 === 1);
  check("wiring: the watch is registered at exactly one call site", mainSrc.split("registerProxyAuthWatch();").length - 1 === 1);
  const registerAt = mainSrc.indexOf("registerProxyAuthWatch();");
  const bootCheckAt = mainSrc.indexOf('runUpdateCheck("boot")');
  check("wiring: the watch exists before the boot update check", registerAt >= 0 && bootCheckAt > registerAt);
  const fnAt = mainSrc.indexOf("function registerProxyAuthWatch");
  const fnEnd = fnAt >= 0 ? mainSrc.indexOf("\n}", fnAt) : -1;
  const fnSlice = fnAt >= 0 && fnEnd > fnAt ? mainSrc.slice(fnAt, fnEnd) : "";
  check(
    "wiring: the handler feeds the normalized authInfo to the pure verdict",
    fnSlice.includes("proxyAuthVerdict({") &&
      fnSlice.includes("isProxy: authInfo?.isProxy") &&
      fnSlice.includes("scheme: authInfo?.scheme") &&
      fnSlice.includes("host: authInfo?.host"),
  );
  check(
    "wiring: one log line per state transition and the callback cancels in every branch, with no timer",
    fnSlice.includes("lastProxyAuthVerdict.state !== verdict.state") &&
      fnSlice.includes("event.preventDefault();") &&
      fnSlice.includes("callback();") &&
      !/setTimeout|setInterval/.test(fnSlice),
  );
  check(
    "wiring: the diagnostics mirror feeds the last verdict",
    mainSrc.includes("proxyAuth: lastProxyAuthVerdict ? { state: lastProxyAuthVerdict.state, message: lastProxyAuthVerdict.message } : null"),
  );
  const proxyauthSrc = readFileSync(new URL("../apps/desktop/src/proxyauth.ts", import.meta.url), "utf8");
  check(
    "purity: proxyauth.ts imports no electron, node:fs, node:child_process, node:net or fetch",
    !/(^|\n)\s*import[^\n]*(electron|node:fs|node:child_process|node:net|fetch)/.test(proxyauthSrc) && !/^import\b/m.test(proxyauthSrc),
  );
  check(
    "purity: the header documents the closed contract and the privacy boundary",
    proxyauthSrc.includes("CLOSED CONTRACT") && proxyauthSrc.includes("PRIVACY BOUNDARY"),
  );
}

console.log(failures === 0 ? "\nproxyauth tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
