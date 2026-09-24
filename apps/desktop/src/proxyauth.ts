// P2-350: pure proxy-auth verdict for the desktop shell — answers WHAT the
// shell saw when a network challenge asked for authentication. On a corporate
// or university machine the proxy itself demands a user and a password (HTTP
// 407) — and until this slice the shell registered no Electron `login`
// listener at all, so every such challenge was cancelled silently by
// Electron's own default and surfaced only as a raw network error: the update
// check read as a dead feed, the Browser pane read as a broken page, and no
// screen ever said the word "proxy authentication". This module owns the
// DECISION; main.ts owns the one `login` listener that feeds it.
//
// Same module hygiene as proxyplan.ts / sidecarwedge.ts / gpuplan.ts: NO
// electron, no node:fs, no node:net, no fetch, no I/O of any kind — main.ts
// normalizes the event's authInfo down to the three documented fields and
// scripts/unit.test.ts plus the portable twin scripts/proxyauth.test.ts
// exercise every rule in plain Node.
//
// CLOSED CONTRACT (the wiring in main.ts depends on it):
//  1. the verdict is one of exactly three states — "proxy-auth-required"
//     (the challenge came FROM the proxy: `isProxy` is true), "not-proxy"
//     (the challenge came from the origin service itself) and "unknown";
//  2. any unreadable input — non-object, a missing or non-boolean `isProxy`,
//     a non-textual `scheme` or `host` when one is present — degrades to
//     "unknown", fail-closed: a challenge the shell cannot classify must
//     never read as something it is not, and nothing is ever thrown;
//  3. the same input yields the exact same verdict on every call (pure —
//     no state, no clock, no randomness);
//  4. the decision is final and credential-free BY DESIGN: asking for and
//     storing proxy credentials is out of scope for this slice — the wiring
//     cancels the challenge in every state (the documented outcome of a
//     callback without credentials), and the verdict exists so the reason
//     can be named instead of hidden.
//
// PRIVACY BOUNDARY: no returned phrase carries the host, a port, a realm, a
// user or a password — the same spirit as the relay-address wording. The
// caller may pass any garbage (a hostile renderer cannot reach here, but a
// malformed challenge can); nothing that came in can ever leak out.

/** The three possible answers of this module. "proxy-auth-required" means the
 * proxy itself demanded credentials; "not-proxy" means the challenge came
 * from the origin service; "unknown" covers every unreadable input. */
export type ProxyAuthState = "proxy-auth-required" | "not-proxy" | "unknown";

export interface ProxyAuthVerdict {
  state: ProxyAuthState;
  /** Short static pt-BR phrase for desktop.log and the diagnostic bundle —
   * never the host, a port, a realm or a credential. */
  message: string;
}

/** The normalized Electron authInfo: only the three documented fields the
 * caller extracts from the `login` event. `scheme`/`host` ride along for the
 * unreadable-input check only — they are NEVER echoed back. */
export interface ProxyAuthInput {
  isProxy?: unknown;
  scheme?: unknown;
  host?: unknown;
}

const MSG_PROXY =
  "o proxy da rede pediu autenticação — o pedido foi cancelado até o acesso ser configurado";
const MSG_NOT_PROXY = "nenhum proxy pediu autenticação — o pedido veio do próprio serviço remoto";
const MSG_UNKNOWN = "situação de autenticação de rede desconhecida";

const UNKNOWN: ProxyAuthVerdict = { state: "unknown", message: MSG_UNKNOWN };
const PROXY_REQUIRED: ProxyAuthVerdict = { state: "proxy-auth-required", message: MSG_PROXY };
const NOT_PROXY: ProxyAuthVerdict = { state: "not-proxy", message: MSG_NOT_PROXY };

/** A present value must be text — null/undefined count as absent, exactly
 * like proxyplan.ts's tolerance for unset environment entries. */
function textualField(raw: unknown): boolean {
  return raw === undefined || raw === null || typeof raw === "string";
}

/**
 * The one pure decision of this module. Deterministic and total: the same
 * input yields the exact same verdict on every call, and nothing is ever
 * thrown — every malformed shape degrades to "unknown". See the CLOSED
 * CONTRACT in the header.
 */
export function proxyAuthVerdict(input?: unknown): ProxyAuthVerdict {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return UNKNOWN;
  const { isProxy, scheme, host } = input as ProxyAuthInput;
  if (!textualField(scheme) || !textualField(host)) return UNKNOWN;
  if (typeof isProxy !== "boolean") return UNKNOWN;
  return isProxy ? PROXY_REQUIRED : NOT_PROXY;
}
