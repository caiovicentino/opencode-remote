// P2-335: relay wire-protocol verdict for the daemon's reconnect loop. Pure
// module — no network, no node:fs, no timers, no imports at all (index.ts runs
// main() on import, so unit tests must never boot a daemon; same pattern as
// relayclose.ts / relaydialerror.ts / relayredial.ts).
//
// Stage 4 of docs/VISION.md introduces a hosted relay that operators update on
// their own schedule. When a hosted relay starts speaking an INCOMPATIBLE wire
// version (a bumped RELAY_WIRE_PROTOCOL — the RelayFrame format and the join
// sequence), the daemon's dial failures are indistinguishable from a relay
// that is merely off the air: both end in the same P2-129 reconnect loop, so a
// machine installed before the bump reconnects forever with nothing in the log
// or the health payload saying why. P2-331 made the relay announce its wire
// protocol on the public /healthz probe; this module is the daemon-side
// consumer, consulted inside the EXISTING reconnect path only.
//
// The expected value never lives here: index.ts passes the RELAY_WIRE_PROTOCOL
// constant imported from @ocr/protocol (the same constant the relay's healthz
// publishes and the join sequence speaks), so a wire bump in packages/protocol
// re-classifies relays without touching this file.
//
// Fail-closed in the P2-114 spirit: ONLY a positive integer that differs from
// the expected constant is a hard verdict ("mismatch"). Everything else — a
// relay that predates the field ("legacy": it keeps working, it just does not
// announce), a non-200 answer, an unparseable body, a body without the relay's
// `version`, a network error or a timeout — is "unknown" and preserves byte
// for byte the behavior the daemon had before this module existed. The pt-BR
// phrases are static operator copy: no URL, no host, no IP, no port, no
// version number and no raw error ever rides them (the P2-140 bar).

/** The closed set of wire-protocol verdicts the daemon can hold. */
export type RelayProtocolState = "ok" | "mismatch" | "legacy" | "unknown";

/** Documented probe ceiling — the same 5s the P2-328 desktop probe uses. */
export const RELAY_PROTOCOL_PROBE_TIMEOUT_MS = 5_000;

/** Body bytes the probe is willing to read — the /healthz JSON is tiny; a
 * hostile or broken peer must not stream unbounded data into the daemon. */
export const RELAY_PROTOCOL_BODY_MAX = 4_096;

/**
 * Failed dial cycles the loop must observe before the first probe: a blip
 * (one dropped connection, one refused dial) probes nothing — only a pattern
 * that looks like the relay stopped speaking to this build does.
 */
export const RELAY_PROTOCOL_PROBE_MIN_FAILURES = 3;

/**
 * Documented throttle window between two probes (10 minutes). A down or
 * misbehaving relay must not be hammered by a probe on every reconnect.
 */
export const RELAY_PROTOCOL_PROBE_THROTTLE_MS = 10 * 60_000;

/** Static pt-BR phrase for /api/health — one per state of the closed set. */
export const RELAY_PROTOCOL_PHRASES: Record<RelayProtocolState, string> = {
  ok: "o relay anuncia o mesmo protocolo de fio deste app",
  mismatch: "o relay fala um protocolo de fio diferente deste app — atualize o app ou o relay hospedado",
  legacy: "o relay não anuncia o protocolo de fio — deve ser uma versão antiga e continua funcionando",
  unknown: "a versão do protocolo de fio do relay é desconhecida — o app continua tentando reconectar",
};

/** Static log line per state transition — the same P2-140 bar as the phrases. */
export const RELAY_PROTOCOL_LOG: Record<RelayProtocolState, string> = {
  ok: "relay wire protocol matches this build",
  mismatch: "relay wire protocol mismatch — update the app or the hosted relay",
  legacy: "relay does not announce its wire protocol (likely an older relay; it keeps working)",
  unknown: "relay wire protocol unknown — reconnect loop unchanged",
};

export interface RelayProtocolVerdict {
  state: RelayProtocolState;
  /** static pt-BR phrase — no URL, host, IP, port or raw error */
  message: string;
}

/** Inputs of one verdict, already normalized by the caller. */
export interface RelayProtocolProbeInput {
  /** HTTP status of the healthz answer, or null when the attempt failed
   * before one arrived (network error, timeout, abort). */
  status: number | null;
  /** The ALREADY-PARSED body (JSON.parse by the caller), or null when the
   * body was not readable/parseable — never a raw string here. */
  body: unknown;
  /** The RELAY_WIRE_PROTOCOL constant this build speaks (from @ocr/protocol). */
  expected: number;
}

const VERDICTS: Record<RelayProtocolState, RelayProtocolVerdict> = {
  ok: { state: "ok", message: RELAY_PROTOCOL_PHRASES.ok },
  mismatch: { state: "mismatch", message: RELAY_PROTOCOL_PHRASES.mismatch },
  legacy: { state: "legacy", message: RELAY_PROTOCOL_PHRASES.legacy },
  unknown: { state: "unknown", message: RELAY_PROTOCOL_PHRASES.unknown },
};

/**
 * Classify one healthz probe against the expected wire protocol. Deterministic
 * and secret-free; the rules are consulted in THIS order:
 *   1. any status other than 200 → unknown (a draining or erroring relay says
 *      nothing about its wire protocol);
 *   2. a body that is not a parsed JSON object → unknown;
 *   3. a body without a string `version` → unknown (the version field has
 *      always been a string on the relay's healthz — a body without it is not
 *      a healthz body this build recognizes; deliberately NOT gating on `ok`,
 *      because an incompatible relay may change any other field and this
 *      module must still be able to catch it);
 *   4. a positive-integer `protocol` equal to the expected constant → ok;
 *   5. a positive-integer `protocol` different from it → mismatch (the ONLY
 *      hard verdict);
 *   6. a missing or non-positive-integer `protocol` (zero, negative,
 *      fractional, string, null, anything else) → legacy — a relay older than
 *      the field keeps working exactly as before.
 */
export function relayProtocolVerdict(input: RelayProtocolProbeInput): RelayProtocolVerdict {
  if (input.status !== 200) return VERDICTS.unknown;
  if (typeof input.body !== "object" || input.body === null) return VERDICTS.unknown;
  const body = input.body as Record<string, unknown>;
  if (typeof body.version !== "string") return VERDICTS.unknown;
  const proto = body.protocol;
  if (typeof proto === "number" && Number.isInteger(proto) && proto > 0) {
    return proto === input.expected ? VERDICTS.ok : VERDICTS.mismatch;
  }
  return VERDICTS.legacy;
}

export interface RelayProtocolPlanInput {
  /** RELAY_URL failed boot validation — connectRelay refuses to dial. */
  relayDisabled: boolean;
  /** The relay socket is open. */
  connected: boolean;
  /** Consecutive failed dial cycles: every close of the relay socket is one,
   *  whether the dial itself failed (never opened) or the connection was cut
   *  right after opening. The caller clears the count only when the relay
   *  actually DELIVERS a frame — the only end-to-end proof that the wire
   *  protocol round-trips (an upgrade that answers open-then-close must still
   *  reach the probe). */
  dialFailures: number;
  /** ms since the last probe ATTEMPT (null = never probed in this boot). */
  msSinceLastProbe: number | null;
  /** A previous probe already returned mismatch (skip until it changes). */
  mismatchKnown: boolean;
}

export type RelayProtocolPlanAction = "probe" | "skip";

export type RelayProtocolPlanReason =
  | "disabled"
  | "connected"
  | "few-dial-failures"
  | "mismatch-known"
  | "throttled"
  | "probe-due";

export interface RelayProtocolPlanVerdict {
  action: RelayProtocolPlanAction;
  reason: RelayProtocolPlanReason;
}

/**
 * Decide whether the reconnect loop should spend one best-effort healthz
 * probe on learning the relay's wire protocol. The rules are consulted in
 * THIS order (a stable reason always explains a skip):
 *   1. a disabled relay never probes (connectRelay refuses to dial anyway);
 *   2. a connected relay has nothing to diagnose — frames are flowing;
 *   3. fewer than RELAY_PROTOCOL_PROBE_MIN_FAILURES consecutive failed dial
 *      cycles → a blip probes nothing;
 *   4. a mismatch already on record → the answer will not change until the
 *      relay is updated, so stop probing (the verdict clears itself the
 *      moment the relay delivers a frame again — see the caller);
 *   5. inside the RELAY_PROTOCOL_PROBE_THROTTLE_MS window since the last
 *      probe attempt → throttled (null = first probe ever, never throttled);
 *   6. only then → probe.
 */
export function relayProtocolProbePlan(input: RelayProtocolPlanInput): RelayProtocolPlanVerdict {
  if (input.relayDisabled) return { action: "skip", reason: "disabled" };
  if (input.connected) return { action: "skip", reason: "connected" };
  if (input.dialFailures < RELAY_PROTOCOL_PROBE_MIN_FAILURES) {
    return { action: "skip", reason: "few-dial-failures" };
  }
  if (input.mismatchKnown) return { action: "skip", reason: "mismatch-known" };
  if (input.msSinceLastProbe !== null && input.msSinceLastProbe < RELAY_PROTOCOL_PROBE_THROTTLE_MS) {
    return { action: "skip", reason: "throttled" };
  }
  return { action: "probe", reason: "probe-due" };
}

/**
 * Derive the /healthz URL of the relay from a ws:// or wss:// address: same
 * host, same explicit-or-default port (ws defaults to 80, wss to 443), path
 * replaced by /healthz, query/hash/credentials stripped. Returns null when
 * the input is not a parseable ws/wss URL — never guesses a scheme it was not
 * given.
 *
 * P2-335: this deliberately duplicates the rule of
 * apps/desktop/src/relayprobe.ts (relayHealthUrl) instead of importing it —
 * a cross-app import would drag desktop/electron-adjacent sources into the
 * daemon build. The parity against that implementation is pinned by unit
 * tests over the same host table the desktop probe uses.
 */
export function relayHealthUrlFromWs(raw: unknown): string | null {
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
