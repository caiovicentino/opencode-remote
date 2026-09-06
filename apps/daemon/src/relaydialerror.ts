// P2-260: dial-error triage for the daemon's relay socket. Pure module — no
// ws/net/tls imports on purpose, because index.ts runs main() on import and
// unit tests must never boot a daemon (same pattern as relayclose.ts /
// relayretry.ts / relayurl.ts).
//
// A relay DIAL failure — the name does not resolve, the connection is
// refused, the connect time runs out, the relay certificate is expired,
// self-signed or for a different hostname — never produces a close code: ws
// emits `error` and then a generic 1006 close, so relayclose.ts can only ever
// answer "transient" and the P2-129 curve would re-dial an unreachable relay
// every few seconds forever, with nothing but a raw Node message (which
// embeds the relay host and port) telling the machine's owner why no phone
// ever arrives.
//
// The rules below are consulted in THIS order:
//   1. a certificate cause beats a network cause when both appear in the
//      same input — a wrong certificate never heals with waiting, and
//      insisting only burns battery and log;
//   2. a known error code beats any message-text heuristic;
//   3. the text heuristic is consulted only when the error code is not a
//      known one;
//   4. empty, missing or unknown input is transient (fail-closed), keeping
//      the P2-129 curve exactly as it is — inventing a permanent cause from
//      unknown text could stop reconnecting a relay that only had a network
//      hiccup.
//
// The permanent configuration and certificate causes floor the re-dial wait
// high (the address only starts working again when a human fixes something),
// and the floor is applied by the same max(jittered, floor) rule
// relayclose.ts established — no new timer, no new route.
//
// The short pt-BR hints are operator-facing log/health copy: static, no URL,
// no host, no port, no file path, no certificate subject or issuer, no phone
// label, no secrets — and the raw error message never leaves this module.

export type RelayDialKind =
  | "unresolved-name"
  | "refused"
  | "timed-out"
  | "cert-expired"
  | "cert-untrusted"
  | "cert-name-mismatch"
  | "cert-other"
  | "transient";

/** Minimum wait before re-dialing, per kind. Transient keeps the P2-129 curve. */
export const RELAY_DIAL_FLOOR_MS: Record<RelayDialKind, number> = {
  "unresolved-name": 60_000,
  refused: 60_000,
  "timed-out": 60_000,
  "cert-expired": 300_000,
  "cert-untrusted": 300_000,
  "cert-name-mismatch": 300_000,
  "cert-other": 300_000,
  transient: 0,
};

const HINTS: Record<RelayDialKind, string> = {
  "unresolved-name": "o nome do relay não resolve: confira o endereço configurado no daemon",
  refused: "o relay recusou a conexão: confira o endereço configurado no daemon",
  "timed-out": "a conexão com o relay esgotou o tempo: confira o endereço configurado e a rede desta máquina",
  "cert-expired": "o certificado do relay está vencido: quem hospeda o relay precisa renová-lo",
  "cert-untrusted": "o certificado do relay não é confiável: quem hospeda o relay precisa corrigi-lo",
  "cert-name-mismatch": "o nome do relay não confere com o certificado: quem hospeda o relay precisa corrigi-lo",
  "cert-other": "o relay tem um problema de certificado: quem hospeda o relay precisa corrigi-lo",
  transient: "falha temporária ao alcançar o relay: tentando de novo",
};

export interface RelayDialVerdict {
  kind: RelayDialKind;
  /** Minimum wait in ms before the next dial (0 = follow the retry schedule). */
  floorMs: number;
  /** Short pt-BR hint for logs/health — no URL, host, port, path or secret. */
  hint: string;
}

/**
 * Node/TLS error codes the classifier knows. Certificate codes are listed
 * first on purpose — rule 1 makes a certificate cause win over a network
 * cause, and the lookup order mirrors that.
 */
const CODE_KINDS: Record<string, RelayDialKind> = {
  // certificate codes (the TLS layer rejected the relay's certificate)
  CERT_HAS_EXPIRED: "cert-expired",
  ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED: "cert-expired",
  ERR_TLS_CERT_ALTNAME_INVALID: "cert-name-mismatch",
  DEPTH_ZERO_SELF_SIGNED_CERT: "cert-untrusted",
  SELF_SIGNED_CERT_IN_CHAIN: "cert-untrusted",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "cert-untrusted",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "cert-untrusted",
  UNABLE_TO_GET_ISSUER_CERT: "cert-untrusted",
  // network codes
  ENOTFOUND: "unresolved-name",
  ECONNREFUSED: "refused",
  ETIMEDOUT: "timed-out",
  // temporary DNS failure ("try again") — keep the fast P2-129 curve
  EAI_AGAIN: "transient",
};

/**
 * Rule 3: consulted only when the error code is not a known one. Rule 1
 * holds inside the heuristic too — certificate patterns are checked before
 * network patterns, so a message carrying both causes classifies as a
 * certificate problem.
 */
function classifyByText(message: string): RelayDialKind {
  if (/certificat/i.test(message)) {
    if (/expire|vencid/i.test(message)) return "cert-expired";
    if (/altname|does not match|não confere/i.test(message)) return "cert-name-mismatch";
    if (/self[ -]?signed|untrusted|not trusted|unable to verify|unable to get issuer/i.test(message)) {
      return "cert-untrusted";
    }
    return "cert-other";
  }
  if (/getaddrinfo|enotfound/i.test(message)) return "unresolved-name";
  if (/refused|recusad/i.test(message)) return "refused";
  if (/timed out|timeout|esgotou o tempo/i.test(message)) return "timed-out";
  return "transient";
}

/**
 * Classify a relay socket error (normalized code + message). The code
 * decides when it is known (rule 2); the text heuristic only runs when it is
 * not (rule 3); empty, missing or unknown input is transient (rule 4), so
 * the raw message is never needed beyond this call and never escapes it.
 */
export function relayDialVerdict(
  code: string | null | undefined,
  message: string | null | undefined,
): RelayDialVerdict {
  const known = typeof code === "string" ? CODE_KINDS[code] : undefined;
  const kind = known ?? classifyByText(typeof message === "string" ? message : "");
  return { kind, floorMs: RELAY_DIAL_FLOOR_MS[kind], hint: HINTS[kind] };
}
