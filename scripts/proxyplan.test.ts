/**
 * P2-285: proxy-plan tests (apps/desktop/src/proxyplan.ts) — the portable
 * twin of the unit.test.ts block. Pure node: no Electron, no sockets, no
 * chmod, no spawn; the only fs use is reading the real main.ts and
 * proxyplan.ts sources for the wiring/purity assertions, via URLs relative
 * to this file (Windows-safe).
 * Run: npx tsx scripts/proxyplan.test.ts
 */
import { readFileSync } from "node:fs";
import {
  PROXY_LOOPBACK_EXCEPTIONS,
  PROXY_SCHEMES,
  parseProxyAddress,
  proxyPlan,
} from "../apps/desktop/src/proxyplan";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const json = (v: unknown) => JSON.stringify(v);
const FIXO_ENV = { HTTPS_PROXY: "http://proxy.corp:3128" };
const loopback = (v: ReturnType<typeof proxyPlan>) =>
  PROXY_LOOPBACK_EXCEPTIONS.every((host) => v.exceptions.includes(host));
const noCredentialText = (v: ReturnType<typeof proxyPlan>, ...secrets: string[]) =>
  [v.rule, v.reason, v.exceptions.join(",")].every((text) => !secrets.some((s) => text.includes(s)));

// --- rule 1: unreadable input fails closed, never into "fixo" -----------------------
{
  check("unreadable: missing input becomes desconhecido", proxyPlan().mode === "desconhecido" && proxyPlan(undefined).mode === "desconhecido" && proxyPlan(null).mode === "desconhecido");
  check("unreadable: non-object input becomes desconhecido", ["proxy", 42, true, []].map((v) => proxyPlan(v).mode).every((m) => m === "desconhecido"));
  check("unreadable: a plain object without proxy keys is not garbage — it is empty", proxyPlan({ unrelated: 1 }).mode === "sistema");
  check("unreadable: a non-object env becomes desconhecido", proxyPlan({ env: "http://p:1" }).mode === "desconhecido" && proxyPlan({ env: [] }).mode === "desconhecido");
  check(
    "unreadable: non-textual values become desconhecido and NEVER fixo",
    proxyPlan({ env: { HTTPS_PROXY: 42 } }).mode === "desconhecido" &&
      proxyPlan({ env: { HTTPS_PROXY: true } }).mode === "desconhecido" &&
      proxyPlan({ env: { NO_PROXY: { bad: 1 } } }).mode === "desconhecido" &&
      proxyPlan({ preference: 42 }).mode === "desconhecido" &&
      proxyPlan({ preference: ["direto"] }).mode === "desconhecido",
  );
  check(
    "unreadable: a discarded input never routes traffic anywhere",
    proxyPlan(null).rule.includes("nenhuma regra aplicada") && proxyPlan(null).exceptions.length > 0,
  );
  check("unreadable: null and empty values count as absent, not as garbage", proxyPlan({ env: { HTTPS_PROXY: null, HTTP_PROXY: "" } }).mode === "sistema");
}

// --- rule 2: loopback is always in the exceptions, in all four modes ----------------
{
  check("exceptions: sistema mode keeps loopback", loopback(proxyPlan({})) && proxyPlan({}).mode === "sistema");
  check("exceptions: direto mode keeps loopback", loopback(proxyPlan({ preference: "direto" })) && proxyPlan({ preference: "direto" }).mode === "direto");
  check("exceptions: fixo mode keeps loopback", loopback(proxyPlan({ env: FIXO_ENV })) && proxyPlan({ env: FIXO_ENV }).mode === "fixo");
  check("exceptions: desconhecido mode keeps loopback", loopback(proxyPlan(null)));
  check("exceptions: the local name rides along in every verdict", proxyPlan({ preference: "direto", localNames: ["Mbp.Corp.local"] }).exceptions.includes("mbp.corp.local"));
  check("exceptions: NO_PROXY content merges after loopback", json(proxyPlan({ env: { NO_PROXY: ".corp.local, *.lan" } }).exceptions).includes(".corp.local"));
}

// --- rule 3: invalid addresses are discarded without a trace ------------------------
{
  const credential = proxyPlan({ env: { HTTPS_PROXY: "http://user:pass@proxy.corp:3128" } });
  check("discard: a credential-bearing address never becomes fixo", credential.mode === "sistema");
  check("discard: the credential address is absent from every returned text", noCredentialText(credential, "user", "pass", "3128"));
  const scheme = proxyPlan({ env: { HTTPS_PROXY: "ftp://proxy.corp:21" } });
  check("discard: a scheme outside the documented list is discarded", scheme.mode === "sistema" && !scheme.rule.includes("ftp") && !scheme.exceptions.includes("ftp://proxy.corp:21"));
  const junk = ["http:/proxy:1", "proxy with space:1", "http://host:0", "http://host:99999", "http://host:abc", "http://h/p", "http://h?x", "http://h#f"];
  check("discard: unparseable addresses are discarded", junk.every((j) => parseProxyAddress(j) === null));
  check("discard: a valid address still parses", parseProxyAddress("http://proxy.corp:3128") !== null && parseProxyAddress("proxy.corp:3128") !== null && parseProxyAddress("socks5://[::1]:1080") !== null);
  const pref = proxyPlan({ preference: "http://user:pass@p.corp:1", env: FIXO_ENV });
  check("discard: an invalid preference falls through to the environment", pref.mode === "fixo" && pref.rule.includes("proxy.corp:3128") && noCredentialText(pref, "user", "pass"));
}

// --- rule 4: a PAC file always degrades to sistema -----------------------------------
{
  const pac = proxyPlan({ env: { PAC_URL: "http://wpad.corp/proxy.pac", HTTPS_PROXY: "http://proxy.corp:3128" } });
  check("pac: auto-config becomes sistema instead of fixo, even with a valid address", pac.mode === "sistema" && !pac.rule.includes("proxy.corp"));
  check("pac: the pac text never leaks into the verdict", noCredentialText(pac, "wpad", "proxy.pac"));
}

// --- rule 5: empty environment and no preference is today's behavior -----------------
{
  check("empty: no env and no preference becomes sistema", proxyPlan({}).mode === "sistema" && proxyPlan({ env: {}, preference: null }).mode === "sistema");
  check("empty: only NO_PROXY still counts as empty", proxyPlan({ env: { NO_PROXY: "localhost" } }).mode === "sistema");
}

// --- rule 6: valid addresses become fixo with the rule assembled ---------------------
{
  const onlyHttps = proxyPlan({ env: FIXO_ENV });
  check("fixo: a valid address assembles the per-scheme rule", onlyHttps.mode === "fixo" && onlyHttps.rule === "https=proxy.corp:3128");
  const both = proxyPlan({ env: { HTTPS_PROXY: "http://p1:3128", HTTP_PROXY: "http://p2:8080" } });
  check("fixo: distinct http/https addresses assemble the mapping rule", both.mode === "fixo" && both.rule === "http=p2:8080;https=p1:3128");
  const socks = proxyPlan({ env: { ALL_PROXY: "socks5://socks.corp:1080" } });
  check("fixo: ALL_PROXY with socks keeps the scheme marker", socks.mode === "fixo" && socks.rule === "socks5://socks.corp:1080");
  const allHttp = proxyPlan({ env: { ALL_PROXY: "all.corp:3128" } });
  check("fixo: ALL_PROXY without a scheme applies bare to all protocols", allHttp.mode === "fixo" && allHttp.rule === "all.corp:3128");
  check("fixo: scheme-specific vars win over ALL_PROXY", proxyPlan({ env: { HTTPS_PROXY: "http://p1:3128", ALL_PROXY: "socks5://s:1" } }).rule === "https=p1:3128");
  check("fixo: the bypass exceptions ride with the fixed rule", proxyPlan({ env: { HTTPS_PROXY: "http://p1:3128", NO_PROXY: ".corp" } }).exceptions.includes(".corp"));
  const prefFixed = proxyPlan({ preference: "proxy.corp:3128" });
  check("fixo: a valid stored preference wins over the environment", prefFixed.mode === "fixo" && prefFixed.rule === "proxy.corp:3128");
  check("fixo: the explicit direct preference becomes direto", proxyPlan({ preference: "direto" }).mode === "direto" && proxyPlan({ preference: "DIRECT" }).mode === "direto");
  check("fixo: the explicit system preference becomes sistema", proxyPlan({ preference: "system", env: FIXO_ENV }).mode === "sistema");
}

// --- rule order proven: credential + loopback valid at the same time -----------------
{
  const order = proxyPlan({ env: { HTTPS_PROXY: "http://user:pass@127.0.0.1:8080" } });
  check(
    "order: a credential-bearing loopback address is discarded (sistema) while loopback stays in the exceptions",
    order.mode === "sistema" && loopback(order) && noCredentialText(order, "user", "pass", ":8080"),
  );
}

// --- determinism ----------------------------------------------------------------------
{
  const input = { env: { HTTPS_PROXY: "http://p:1", NO_PROXY: "a.local" }, preference: null, localNames: ["mbp"] };
  check("determinism: the same input yields the exact same verdict twice", json(proxyPlan(input)) === json(proxyPlan(input)));
  check("determinism: fresh exception arrays each call", proxyPlan(input).exceptions !== proxyPlan(input).exceptions);
}

// --- the real sources: wiring and module purity ----------------------------------------
{
  const mainSrc = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  check("wiring: exactly one proxy application site in main.ts", mainSrc.split("setProxy").length - 1 === 1);
  check("wiring: the application targets the default session", mainSrc.includes("session.defaultSession"));
  check("wiring: the verdict is applied exactly once", mainSrc.split("applyProxyVerdict();").length - 1 === 1);
  const applyAt = mainSrc.indexOf("applyProxyVerdict();");
  const firstWindowCall = mainSrc.indexOf("createWindow();");
  check("wiring: the application happens before the first window creation", applyAt >= 0 && firstWindowCall > applyAt);
  const proxySrc = readFileSync(new URL("../apps/desktop/src/proxyplan.ts", import.meta.url), "utf8");
  check(
    "purity: proxyplan.ts imports no electron, node:fs, node:child_process, node:net or fetch",
    !/(^|\n)\s*import[^\n]*(electron|node:fs|node:child_process|node:net|fetch)/.test(proxySrc) && !/^import\b/m.test(proxySrc),
  );
  check(
    "purity: the header documents the rule order and the privacy boundary",
    proxySrc.includes("RULE ORDER CONTRACT") && proxySrc.includes("PRIVACY BOUNDARY"),
  );
  check("vocabulary: the documented scheme list is the exported one", json(PROXY_SCHEMES) === json(["http", "https", "socks4", "socks5"]));
}

// --- never throws ----------------------------------------------------------------------
{
  let threw = false;
  try {
    for (const input of [NaN, () => 1, Symbol("x"), { env: { HTTPS_PROXY: {} } }, { localNames: 7, preference: {} }, new Date()]) {
      proxyPlan(input);
    }
  } catch {
    threw = true;
  }
  check("robustness: no input shape ever throws", !threw);
}

console.log(failures === 0 ? "\nproxyplan tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
