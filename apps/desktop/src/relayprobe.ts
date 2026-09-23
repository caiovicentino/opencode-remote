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
//
// P2-344: the probe also reads the `instanceId` field the relay publishes on
// /healthz (P3-401). One healthy read cannot prove the address is served by
// exactly ONE relay replica — two replicas behind one public address split
// every room in half and pairing breaks in silence while every probe looks
// green. So after an ok FIRST read, main.ts samples the same healthz up to
// RELAY_PROBE_EXTRA_READS more times (same ceilings, each best-effort) and
// relayReplicaVerdict turns a divergence between the sanitized ids into the
// additive split-replicas state. A failed read, an absent value, an
// out-of-grammar value or fewer than two valid values never change the
// verdict (P2-338 lesson: fail-closed, sanitize to a closed grammar or null).

import { RELAY_WIRE_PROTOCOL } from "@ocr/protocol/relaywire.js";
import { relayUrlProblems } from "./relaysetting";

/** Documented probe ceiling — mirrors the AbortSignal timeout in main.ts (5s). */
export const RELAY_PROBE_TIMEOUT_MS = 5_000;

/** Body bytes the probe is willing to read — the /healthz JSON is tiny; a
 * hostile or broken peer must not stream gigabytes into the shell. */
export const RELAY_PROBE_BODY_MAX = 4_096;

/** P2-344: how many EXTRA /healthz reads the replica sampler may spend after
 * an ok first read ("at most two more sequential reads"). Three samples in
 * total make two distinct ids very likely to surface behind a round-robin
 * load balancer; divergence exits the loop early. */
export const RELAY_PROBE_EXTRA_READS = 2;

export type RelayProbeState =
  | "ok"
  | "protocol-mismatch"
  | "protocol-outdated"
  | "split-replicas"
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
  /** short error token the caller normalized through relayProbeErrorName —
   * the DOMException NAME ("TimeoutError"/"AbortError") for a timed-out or
   * aborted dial, otherwise cause.code ?? message ?? name ("" when none) */
  errorName: string;
}

const DNS_RE = /enotfound|eai_again|eai_nodata|getaddrinfo|err_name_not_resolved/i;
const REFUSED_RE = /econnrefused|err_connection_refused/i;
const TLS_RE = /cert_|err_tls|err_ssl|unable_to_verify_leaf_signature|self_signed_cert_in_chain|depth_zero_self_signed_cert|eproto/i;
const TIMEOUT_RE = /aborterror|timeouterror|abort_err|etimedout|err_timed_out|err_connection_timed_out|err_aborted/i;
// Electron 44's net.fetch never surfaces a redirect answer: with
// redirect:"manual" it cancels the request ("Redirect was cancelled") — which
// is exactly the signal that SOMETHING else answered at that address.
const REDIRECT_RE = /redirect/i;

const VERDICTS: Record<RelayProbeState, { message: string; messageEn: string }> = {
  ok: {
    message: "o relay respondeu e está saudável",
    messageEn: "the relay answered and is healthy",
  },
  "protocol-mismatch": {
    message: "o relay fala outro formato de fio — atualize o app ou o relay hospedado",
    messageEn: "the relay speaks another wire format — update the app or the hosted relay",
  },
  "protocol-outdated": {
    message: "o relay é antigo — convém atualizá-lo",
    messageEn: "the relay is old — consider updating it",
  },
  "split-replicas": {
    message: "mais de uma instância do relay responde nesse endereço — o pareamento vai falhar até sobrar uma só",
    messageEn: "more than one relay instance answers this address — pairing will fail until only one remains",
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

/** P2-344: the replica sampler's verdict builder — the narrow union keeps the
 * returned state exactly the two documented values while the phrase comes
 * from the same sibling table the probe uses. */
function replicaVerdict(state: RelayReplicaState): RelayReplicaVerdict {
  return { state, ...VERDICTS[state] };
}

/**
 * Normalize one probe failure into the short token relayProbeVerdict
 * classifies. Pure shape-mapping (no electron, no I/O) so unit tests can pin
 * the REAL errors the IPC delivers — measured on Electron 44:
 *   - a timed-out dial rejects as a DOMException whose prose message ("The
 *     operation was aborted due to timeout") matches none of the classifier's
 *     regexes; only the NAME ("TimeoutError"/"AbortError") is the reliable
 *     token, so it wins over the message;
 *   - every other failure (refused, DNS, TLS…) rides message
 *     ("net::ERR_CONNECTION_REFUSED") or cause.code — kept verbatim.
 * Never throws; an unknown shape degrades to "" (→ unreachable).
 */
export function relayProbeErrorName(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  if (!e || typeof e !== "object") return "";
  if (e.name === "TimeoutError" || e.name === "AbortError") return e.name;
  if (typeof e.cause?.code === "string" && e.cause.code) return e.cause.code;
  if (typeof e.message === "string" && e.message) return e.message;
  return typeof e.name === "string" ? e.name : "";
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
 * (ok true + version string) can bless the address: it is "ok" only when the
 * body's protocol field is a positive integer equal to RELAY_WIRE_PROTOCOL,
 * "protocol-mismatch" when it is a different positive integer, and
 * "protocol-outdated" when the field is absent or not a positive integer (a
 * relay that predates P2-331 keeps working — it is old, not broken); a 503
 * with ok false is "draining" and
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
    // Electron cancels a manual redirect before any status exists — the
    // address answers, just not as this relay.
    if (REDIRECT_RE.test(errorName)) return verdict("not-a-relay");
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
    // P2-332: the /healthz protocol field (P2-331) splits the healthy-looking
    // answer into three outcomes. ok only when the relay speaks the exact
    // wire protocol this build was compiled with; a positive integer that
    // differs is an incompatible relay (protocol-mismatch — the daemon would
    // never join, so say so BEFORE saving); anything else — field absent, or
    // not a positive integer — is an old relay that never published the
    // field (protocol-outdated: it keeps working, it is just old). The value
    // compared is the imported RELAY_WIRE_PROTOCOL constant, never a literal.
    const proto = body.protocol;
    if (typeof proto === "number" && Number.isInteger(proto) && proto > 0) {
      return verdict(proto === RELAY_WIRE_PROTOCOL ? "ok" : "protocol-mismatch");
    }
    return verdict("protocol-outdated");
  }
  if (p.status === 503 && !p.redirected && body?.ok === false) return verdict("draining");
  return verdict("not-a-relay");
}

// --- P2-344: replica identity sampler ------------------------------------------
//
// The relay publishes an opaque per-instance id on /healthz (P3-401,
// apps/relay/src/instanceid.ts). Two replicas behind one public address split
// the in-memory room map and pairing breaks in silence while every individual
// probe looks green — the only signal the CLIENT can gather is "the id changed
// between reads". These helpers keep the sampling pure: the grammar is
// duplicated from apps/relay/src/instanceid.ts on purpose (apps cannot import
// each other without dragging Electron-adjacent or server sources into the
// build — P2-338/P2-335 lessons) and scripts/unit.test.ts pins parity against
// the real instanceid.ts source, failing the moment the two diverge.

/** P2-344: longest accepted instance id — byte-for-byte the
 *  INSTANCE_ID_MAX_LENGTH of apps/relay/src/instanceid.ts (parity-tested). */
const INSTANCE_ID_MAX_LENGTH = 64;

/** P2-344: the whole accepted grammar — letters, digits and dashes; anything
 *  else (spaces, underscores, dots, control bytes, non-ASCII) is unsafe for a
 *  public probe field. Byte-for-byte the INSTANCE_ID_PATTERN of
 *  apps/relay/src/instanceid.ts (parity-tested). */
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * P2-344: sanitize one raw `instanceId` value to the closed grammar of
 * apps/relay/src/instanceid.ts — a non-empty string of at most 64 letters,
 * digits and dashes. Fail-closed (P2-338 lesson): an absent, null, non-string,
 * empty, oversized or out-of-grammar value degrades to null and NEVER changes
 * the verdict; no id is ever invented from partial input. Returns the value
 * verbatim (no trimming, no case folding — an id either is fully inside the
 * grammar or is rejected whole).
 */
export function sanitizeInstanceId(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > INSTANCE_ID_MAX_LENGTH) return null;
  return INSTANCE_ID_PATTERN.test(raw) ? raw : null;
}

/** P2-344: the states the replica sampler can answer. "ok" means "nothing
 * contradicts today's verdict" — the caller keeps whatever the probe said;
 * "split-replicas" is the additive fault state (relayprobe VERDICTS carries
 * its static pt/en phrases, so the shape stays RelayProbeVerdict-compatible). */
export type RelayReplicaState = "ok" | "split-replicas";

/** P2-344: verdict of the replica sampling. Structurally a
 * RelayProbeVerdict (its state is inside RelayProbeState), so main.ts can
 * return it wherever the probe verdict travels. */
export interface RelayReplicaVerdict {
  state: RelayReplicaState;
  /** static pt-BR phrase — no URL, host, IP, port or instance id */
  message: string;
  /** static en phrase — same bar as the pt one above */
  messageEn: string;
}

/**
 * P2-344: decide whether the instance ids read from consecutive /healthz
 * answers contradict "exactly one relay instance serves this address".
 * Every value is sanitized through the closed instanceid.ts grammar first;
 * an absent, null, non-string, empty, oversized or out-of-grammar value is
 * dropped and can never change the verdict (a legacy relay publishing no
 * field at all, or one replica newer than the other, must NOT turn a healthy
 * probe into an alarm). Rules, in order:
 *   1. a non-array input (or one that is not a list of values) carries no
 *      evidence — "ok" (fail-closed: fewer than two valid values never
 *      changes today's verdict);
 *   2. fewer than two valid values after sanitization → "ok";
 *   3. every valid value identical → "ok" (one stable instance);
 *   4. two or more distinct valid values → "split-replicas".
 * The split phrase is the sibling static pair from VERDICTS — no URL, host,
 * IP, port, id or raw error, and the caller never renders the ids anywhere.
 */
export function relayReplicaVerdict(values: unknown): RelayReplicaVerdict {
  const list = Array.isArray(values) ? values : [];
  const ids: string[] = [];
  for (const v of list) {
    const id = sanitizeInstanceId(v);
    if (id !== null) ids.push(id);
  }
  if (ids.length < 2) return replicaVerdict("ok");
  if (new Set(ids).size <= 1) return replicaVerdict("ok");
  return replicaVerdict("split-replicas");
}

/**
 * P2-344: the raw `instanceId` field of one /healthz body — `undefined`
 * whenever the body is not a JSON object carrying the field (a legacy relay,
 * a stranger body or a failed read contribute no value and can never change
 * the verdict). The VALUE is returned raw on purpose: the sanitization to the
 * closed grammar lives in relayReplicaVerdict/sanitizeInstanceId so the unit
 * battery can pin both halves of the contract separately.
 */
export function relayInstanceIdFromBody(body: string): unknown {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>).instanceId;
    }
  } catch {
    // not JSON — no value; the caller treats it like any other failed read
  }
  return undefined;
}
