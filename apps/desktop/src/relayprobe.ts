// P2-328: "Test connection" for the Settings relay card. Saving a relay
// address is blind by design (a wrong typed host only shows up later as the
// daemon's "reconnecting" state), so the operator gets a button that dials the
// relay's public /healthz probe ONCE and says, calmly, what happened. The
// relay serves /healthz on the same server that takes the ws upgrade
// (apps/relay/src/index.ts), so one plain GET is a faithful stand-in for the
// dial the daemon is about to attempt.
//
// Same module hygiene as webreach.ts / sidecarexit.ts: NO electron, NO
// node:fs, no fetch, no timers, no I/O — main.ts performs the actual probe at
// runtime and scripts/unit.test.ts exercises every branch in plain Node.
// Messages are static pt-BR and English with no URL, no host, no IP, no port
// and no raw error (the P2-140 bar): a short phrase the operator can act on.

import { relayUrlProblems } from "./relaysetting";

/** Documented probe ceiling — mirrors the AbortSignal timeout in main.ts (5s). */
export const RELAY_PROBE_TIMEOUT_MS = 5_000;

/** Body bytes the probe is willing to read — the /healthz JSON is tiny; a
 * hostile or broken peer must not stream gigabytes into the shell. */
export const RELAY_PROBE_BODY_MAX = 4_096;

export type RelayProbeState =
  | "ok"
  | "draining"
  | "not-a-relay"
  | "dns"
  | "refused"
  | "tls"
  | "timeout"
  | "unreachable"
  | "invalid";

export interface RelayProbeVerdict {
  state: RelayProbeState;
  /** static pt-BR phrase — no URL, host, IP, port or raw error */
  message: string;
  /** static en phrase — same bar as the pt one above */
  messageEn: string;
}

/** Inputs of one probe attempt, already normalized by the caller. */
export interface RelayProbeInput {
  /** the raw relay address the probe was about to test (any type — the
   * classification re-validates it and refuses to bless an invalid one) */
  raw: unknown;
  /** HTTP status of the answer, or null when the attempt failed before one */
  status: number | null;
  /** true when the answer was a redirect — the probe never follows one */
  redirected: boolean;
  /** first ≤RELAY_PROBE_BODY_MAX bytes of the answer body, "" when none read */
  body: string;
  /** short error name/code (err.cause.code ?? err.message, "" when none) */
  errorName: string;
}

const DNS_RE = /enotfound|eai_again|eai_nodata|getaddrinfo|err_name_not_resolved/i;
const REFUSED_RE = /econnrefused|err_connection_refused/i;
const TLS_RE = /cert_|err_tls|err_ssl|unable_to_verify_leaf_signature|self_signed_cert_in_chain|depth_zero_self_signed_cert|eproto/i;
const TIMEOUT_RE = /aborterror|timeouterror|abort_err|etimedout|err_timed_out|err_connection_timed_out/i;

const VERDICTS: Record<RelayProbeState, { message: string; messageEn: string }> = {
  ok: {
    message: "o relay respondeu e está saudável",
    messageEn: "the relay answered and is healthy",
  },
  draining: {
    message: "o relay respondeu, mas está encerrando — teste de novo em instantes",
    messageEn: "the relay answered, but it is draining — test again shortly",
  },
  "not-a-relay": {
    message: "algo respondeu aí, mas não é este relay — confira o endereço digitado",
    messageEn: "something answered there, but it is not this relay — check the address you typed",
  },
  dns: {
    message: "o nome do relay não foi encontrado — confira o endereço digitado",
    messageEn: "the relay name was not found — check the address you typed",
  },
  refused: {
    message: "nada está servindo esse endereço agora — confira o relay hospedado",
    messageEn: "nothing is serving that address right now — check the hosted relay",
  },
  tls: {
    message: "o certificado do relay não é confiável — renove-o no relay hospedado",
    messageEn: "the relay certificate is not trusted — renew it on the hosted relay",
  },
  timeout: {
    message: "o relay não respondeu a tempo — teste de novo",
    messageEn: "the relay did not answer in time — test again",
  },
  unreachable: {
    message: "o relay não respondeu — confira se ele está no ar e teste de novo",
    messageEn: "the relay did not answer — check that it is up and test again",
  },
  invalid: {
    message: "endereço de relay inválido — confira o campo",
    messageEn: "invalid relay address — check the field",
  },
};

function verdict(state: RelayProbeState): RelayProbeVerdict {
  return { state, ...VERDICTS[state] };
}

/**
 * Derive the /healthz URL of the relay from a ws:// or wss:// address: same
 * host, same explicit-or-default port (ws defaults to 80, wss to 443), path
 * replaced by /healthz, query/hash/credentials stripped. Returns null when the
 * input is not a parseable ws/wss URL — never guesses a scheme it was not
 * given.
 */
export function relayHealthUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme === "wss:") url.protocol = "https:";
  else if (scheme === "ws:") url.protocol = "http:";
  else return null;
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString();
}

/**
 * Map one probe attempt to (state, pt message, en message). Deterministic and
 * secret-free. An address with relayUrlProblems is "invalid" and never dials
 * (the caller honors the same rule); a network failure classifies by its short
 * error name; with a status, only a 200 carrying the relay's own healthz JSON
 * (ok true + version string) is "ok", a 503 with ok false is "draining" and
 * everything else — other statuses, redirects, non-JSON bodies, JSON without
 * a version — is "not-a-relay".
 */
export function relayProbeVerdict(p: RelayProbeInput): RelayProbeVerdict {
  if (relayUrlProblems(p.raw).length > 0) return verdict("invalid");
  const errorName = typeof p.errorName === "string" ? p.errorName : "";
  if (p.status === null) {
    if (TIMEOUT_RE.test(errorName)) return verdict("timeout");
    if (DNS_RE.test(errorName)) return verdict("dns");
    if (REFUSED_RE.test(errorName)) return verdict("refused");
    if (TLS_RE.test(errorName)) return verdict("tls");
    return verdict("unreachable");
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(p.body);
  } catch {
    parsed = null;
  }
  const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (p.status === 200 && !p.redirected && body?.ok === true && typeof body.version === "string") {
    return verdict("ok");
  }
  if (p.status === 503 && !p.redirected && body?.ok === false) return verdict("draining");
  return verdict("not-a-relay");
}
