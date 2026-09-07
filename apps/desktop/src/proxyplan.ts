// P2-285: pure proxy-decision planner for the desktop shell. On a corporate
// or university machine the only way out to the internet is a proxy — and the
// shell never read that configuration, so the update check and every
// Browser-pane load died with a raw Chromium network error while no screen
// ever said the word "proxy". This module owns the DECISION: given the
// machine's proxy environment (already normalized by the caller) plus the
// stored manual preference, it returns exactly one of four modes — "sistema",
// "direto", "fixo" or "desconhecido" — plus the final proxy rule in text, the
// bypass exception list and a short static label for the reason.
//
// Same module hygiene as gpuplan.ts / wakeplan.ts / installloc.ts: NO
// electron, no node:fs, no node:child_process, no node:net, no fetch, no I/O
// of any kind — main.ts reads the real environment, applies the verdict to
// the default session exactly once before the first window load, and
// scripts/unit.test.ts plus the portable twin scripts/proxyplan.test.ts
// exercise every rule in plain Node.
//
// RULE ORDER CONTRACT (the gate depends on it) — rules apply in THIS order:
//  1. an unreadable entry — the input missing, not an object, or carrying a
//     non-textual value where a proxy setting is expected — turns into
//     "desconhecido" and NEVER into "fixo", fail-closed: sending traffic to
//     an address nobody validated is worse than admitting we do not know;
//  2. the machine's own loopback address and local name ALWAYS enter the
//     exception list, in all four modes, even when the owner configured a
//     proxy — the daemon sidecar lives on loopback and routing it through
//     the proxy would take the whole product down;
//  3. an address with a scheme outside the documented list (http, https,
//     socks4, socks5), an address with embedded credentials or an address
//     that does not parse is DISCARDED — it never becomes the rule and never
//     appears in any returned text;
//  4. a proxy auto-config file (PAC) turns into "sistema" instead of "fixo"
//     because executing such a configuration is out of scope;
//  5. an empty environment with no preference turns into "sistema" — exactly
//     today's behavior;
//  6. only the remaining valid address turns into "fixo", with the rule
//     assembled. The result is identical for the same input on every call.
//
// PRIVACY BOUNDARY: no returned value contains a user, password, token, an
// absolute machine path or the raw environment variable — same spirit as the
// relay-address wording. A validated credential-free host:port may only
// appear inside the "fixo" rule text; the reason labels are static, and a
// discarded address leaves no trace in any returned text.

/** The four possible answers of the planner. "sistema" follows the OS proxy
 * (today's behavior), "direto" bypasses every proxy, "fixo" applies one
 * validated address, "desconhecido" applies nothing and says so. */
export type ProxyMode = "sistema" | "direto" | "fixo" | "desconhecido";

export interface ProxyPlanVerdict {
  mode: ProxyMode;
  /** The final proxy rule in text — the Electron proxyRules string for
   * "fixo", a static description otherwise. Credential-free by contract. */
  rule: string;
  /** Hosts that must always bypass the proxy (loopback first). Safe to feed
   * a bypass list: entries are plain host-shaped text, lowercased, deduped. */
  exceptions: string[];
  /** Short static pt-BR label for the decision — no address, no credential. */
  reason: string;
}

export interface ProxyPlanInput {
  /** The machine's proxy environment, already normalized by the caller: a
   * plain object keyed by the documented names (case-insensitive):
   * HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY and PAC_URL. undefined/null
   * means "absent"; empty strings count as absent; any other non-textual
   * value fails the whole verdict closed (rule 1). */
  env?: unknown;
  /** The stored manual preference — null today (no choice screen yet; it is
   * a documented continuation). Vocabulary: "direto"/"direct", "sistema"/
   * "system", or one proxy address. A non-textual value fails closed. */
  preference?: unknown;
  /** The machine's local hostname(s) — always added to the exceptions. */
  localNames?: unknown;
}

/** Documented address schemes; anything else is discarded (rule 3). */
export const PROXY_SCHEMES: readonly string[] = ["http", "https", "socks4", "socks5"];

/** Loopback hosts that always bypass the proxy (rule 2) — the daemon sidecar
 * and the local web bridge live here, so these precede every other entry. */
export const PROXY_LOOPBACK_EXCEPTIONS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

const RULE_SYSTEM = "modo system — a sessão segue o proxy do sistema";
const RULE_DIRECT = "modo direct — conexão direta, sem proxy";
const RULE_NONE = "nenhuma regra aplicada — a sessão fica no padrão";

const REASON_UNREADABLE = "entrada de proxy ausente ou ilegível — nenhuma regra aplicada";
const REASON_NONTEXTUAL = "valor de proxy não textual — nenhuma regra aplicada";
const REASON_PREFERENCE_DIRECT = "escolha guardada pede conexão direta, sem proxy";
const REASON_PREFERENCE_SYSTEM = "escolha guardada pede o proxy do sistema";
const REASON_PREFERENCE_FIXED = "escolha guardada define um proxy fixo";
const REASON_PAC = "configuração automática de proxy presente — executá-la está fora do escopo, seguindo o sistema";
const REASON_EMPTY = "nenhum proxy configurado no ambiente — seguindo o proxy do sistema";
const REASON_FIXED_ENV = "endereço de proxy válido no ambiente — regra fixa aplicada";
const REASON_NO_VALID = "nenhum endereço de proxy validável no ambiente — seguindo o sistema";

/** One documented proxy variable, trimmed; null/undefined/empty = absent. */
function textualValue(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim();
}

/**
 * Parse one proxy address against the documented vocabulary. Returns the
 * lowercased scheme and the credential-free host:port text, or null when the
 * address is discarded by rule 3: a scheme outside the documented list,
 * embedded credentials, a path/query/fragment, a bad port or anything that
 * does not parse as host[:port]. Pure string work — no URL parser, no I/O.
 */
export function parseProxyAddress(raw: string): { scheme: string; hostPort: string } | null {
  const value = raw.trim();
  if (value === "" || /\s/.test(value)) return null;
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(value);
  let scheme = "http";
  let rest = value;
  if (schemeMatch) {
    scheme = (schemeMatch[1] ?? "").toLowerCase();
    rest = value.slice((schemeMatch[0] ?? value).length);
  }
  if (!PROXY_SCHEMES.includes(scheme)) return null;
  if (rest.includes("@")) return null;
  if (/[/?#]/.test(rest)) return null;
  let host = rest;
  let port = "";
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return null;
    host = rest.slice(1, close);
    const after = rest.slice(close + 1);
    if (after !== "" && !after.startsWith(":")) return null;
    port = after.slice(1);
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon !== -1) {
      host = rest.slice(0, colon);
      port = rest.slice(colon + 1);
    }
  }
  if (host === "") return null;
  if (port !== "") {
    if (!/^\d{1,5}$/.test(port)) return null;
    const numeric = Number(port);
    if (numeric < 1 || numeric > 65535) return null;
  }
  return { scheme, hostPort: port === "" ? host : `${host}:${port}` };
}

/** Entry shape guard for the exception list: plain host-shaped text only —
 * no credentials, no schemes, no paths, no whitespace. */
function exceptionEntry(raw: string): string | null {
  const entry = raw.trim().toLowerCase();
  if (entry === "") return null;
  if (/[\s@/\\?#]/.test(entry)) return null;
  if (entry.includes("://")) return null;
  return entry;
}

/** NO_PROXY content rides along in the exceptions: comma-separated, plain
 * entries only, deduped. Anything weird is dropped silently — the bypass
 * list never sends traffic anywhere, so it never fails closed. */
function parseNoProxy(raw: unknown): string[] {
  const value = textualValue(raw);
  if (value === "") return [];
  const out: string[] = [];
  for (const piece of value.split(",")) {
    const entry = exceptionEntry(piece);
    if (entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** The caller's local hostname(s): textual entries only, lowercased, deduped
 * after the loopback constants. Non-textual entries are skipped — the
 * fail-closed rule protects where traffic GOES, not the bypass list. */
function collectLocalNames(input: unknown): string[] {
  const candidates: unknown[] = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const entry = exceptionEntry(candidate);
    if (entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Assemble the Electron proxyRules text from the parsed addresses:
 * scheme-specific mappings when the env distinguishes them, the ALL_PROXY
 * address (bare, or socks form) as the all-protocol fallback. */
function assembleRule(
  http: { scheme: string; hostPort: string } | null,
  https: { scheme: string; hostPort: string } | null,
  all: { scheme: string; hostPort: string } | null,
): string | null {
  if (http && https) return `http=${http.hostPort};https=${https.hostPort}`;
  if (https) return `https=${https.hostPort}`;
  if (http) return `http=${http.hostPort}`;
  if (all) return all.scheme.startsWith("socks") ? `${all.scheme}://${all.hostPort}` : all.hostPort;
  return null;
}

/**
 * The one pure decision of this module. Deterministic: the same input yields
 * the exact same verdict on every call, and nothing is ever thrown. See the
 * RULE ORDER CONTRACT in the header.
 */
export function proxyPlan(input?: unknown): ProxyPlanVerdict {
  const names = collectLocalNames(
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as ProxyPlanInput).localNames
      : undefined,
  );
  const always = [...PROXY_LOOPBACK_EXCEPTIONS, ...names];
  const verdict = (mode: ProxyMode, rule: string, exceptions: string[], reason: string): ProxyPlanVerdict => ({
    mode,
    rule,
    exceptions,
    reason,
  });

  // Rule 1 — unreadable input fails closed, never into "fixo".
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return verdict("desconhecido", RULE_NONE, always, REASON_UNREADABLE);
  }
  const { env, preference } = input as ProxyPlanInput;
  if (env !== undefined && env !== null && (typeof env !== "object" || Array.isArray(env))) {
    return verdict("desconhecido", RULE_NONE, always, REASON_UNREADABLE);
  }
  const envObj = (env ?? {}) as Record<string, unknown>;
  const pick = (name: string): unknown => {
    for (const key of Object.keys(envObj)) {
      if (key.toUpperCase() === name) return envObj[key];
    }
    return undefined;
  };
  const httpRaw = pick("HTTP_PROXY");
  const httpsRaw = pick("HTTPS_PROXY");
  const allRaw = pick("ALL_PROXY");
  const noRaw = pick("NO_PROXY");
  const pacRaw = pick("PAC_URL");
  for (const value of [httpRaw, httpsRaw, allRaw, noRaw, pacRaw, preference]) {
    if (value !== undefined && value !== null && typeof value !== "string") {
      return verdict("desconhecido", RULE_NONE, always, REASON_NONTEXTUAL);
    }
  }

  // Rule 2 — the exceptions exist from here on, loopback first.
  const exceptions = [...always, ...parseNoProxy(noRaw)];

  // Rule 4 in reverse (manual beats machine): the stored preference wins.
  const pref = textualValue(preference);
  const prefLower = pref.toLowerCase();
  if (prefLower === "direto" || prefLower === "direct") {
    return verdict("direto", RULE_DIRECT, exceptions, REASON_PREFERENCE_DIRECT);
  }
  if (prefLower === "sistema" || prefLower === "system") {
    return verdict("sistema", RULE_SYSTEM, exceptions, REASON_PREFERENCE_SYSTEM);
  }
  if (pref !== "") {
    const parsedPreference = parseProxyAddress(pref);
    if (parsedPreference) {
      // A manual address applies to every protocol (socks form keeps its
      // scheme marker) — it is the owner's explicit choice, not an env hint.
      const prefRule = parsedPreference.scheme.startsWith("socks")
        ? `${parsedPreference.scheme}://${parsedPreference.hostPort}`
        : parsedPreference.hostPort;
      return verdict("fixo", prefRule, exceptions, REASON_PREFERENCE_FIXED);
    }
    // An invalid preference address is discarded (rule 3) — the environment
    // still gets its chance below.
  }

  // Rule 4 — a PAC file always degrades to "sistema", never "fixo".
  if (textualValue(pacRaw) !== "") {
    return verdict("sistema", RULE_SYSTEM, exceptions, REASON_PAC);
  }

  const httpVal = textualValue(httpRaw);
  const httpsVal = textualValue(httpsRaw);
  const allVal = textualValue(allRaw);

  // Rule 5 — empty environment, no preference: exactly today's behavior.
  if (httpVal === "" && httpsVal === "" && allVal === "") {
    return verdict("sistema", RULE_SYSTEM, exceptions, REASON_EMPTY);
  }

  // Rule 3 — invalid addresses are discarded without becoming the rule.
  const parsedHttp = httpVal === "" ? null : parseProxyAddress(httpVal);
  const parsedHttps = httpsVal === "" ? null : parseProxyAddress(httpsVal);
  const parsedAll = allVal === "" ? null : parseProxyAddress(allVal);
  const rule = assembleRule(parsedHttp, parsedHttps, parsedAll);
  if (!rule) {
    return verdict("sistema", RULE_SYSTEM, exceptions, REASON_NO_VALID);
  }

  // Rule 6 — the remaining valid address becomes the fixed rule.
  return verdict("fixo", rule, exceptions, REASON_FIXED_ENV);
}
