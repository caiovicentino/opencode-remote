// P2-199: daemon↔relay link classifier for the pairing QR. webreach.ts judges
// the address the phone opens; NOTHING judged the other end of the journey —
// the WebSocket between the local daemon and the relay written inside the very
// QR the phone scans. A hosted relay that is down, a RELAY_URL refused at boot
// or a dial in backoff all mint a "perfect" QR: the phone joins the room and
// nobody answers, and the person holding the phone blames the camera. The
// daemon already publishes everything needed on GET /api/health
// (relayConnected, relayRetry.attempt/nextDelayMs/lastClose.kind, relay.ok +
// relay.reason from the P2-139 boot validation, and — P2-338 — the
// relayProtocol wire verdict the P2-335 daemon already publishes); this
// module turns that snapshot into one calm verdict.
//
// Same module hygiene as webreach.ts / sidecarexit.ts: NO electron, NO
// node:fs, no fetch, no I/O — main.ts reads /api/health at runtime and
// scripts/unit.test.ts exercises every branch in plain Node. Messages are
// static, actionable pt-BR with no paths, no URL schemes and no secrets (the
// P2-140 bar): the daemon's own relay reason is never echoed because it may
// carry host/port, and attempt/nextDelayMs only shape the wording — they are
// never interpolated as raw numbers.

export type RelayLinkState =
  | "connected"
  | "local"
  | "dialing"
  | "refused"
  | "misconfigured"
  | "incompatible"
  | "unknown";

export interface RelayLinkVerdict {
  state: RelayLinkState;
  /** Short actionable pt-BR phrase — static, never echoes the daemon's reason. */
  message: string;
}

/** P2-338: the closed set of relay wire-protocol verdicts the daemon already
 * publishes on /api/health (apps/daemon/src/relayprotocol.ts
 * RelayProtocolState: ok / mismatch / legacy / unknown). Duplicated on
 * purpose — importing across apps would drag daemon sources into the desktop
 * build; the parity is pinned by a source-reading test in
 * scripts/unit.test.ts that fails when either side drifts. */
export type RelayProtocolState = "ok" | "mismatch" | "legacy" | "unknown";

const PROTOCOL_STATES = new Set<RelayProtocolState>(["ok", "mismatch", "legacy", "unknown"]);

/** P2-338: fail-closed read of the daemon's relayProtocol.state — only the
 * closed set survives; anything absent, null, out-of-set or non-string
 * degrades to null, which linkVerdict treats exactly as before (byte for
 * byte: the field is additive, a legacy or lying daemon must never mint a
 * verdict of its own). */
export function sanitizeRelayProtocolState(raw: unknown): RelayProtocolState | null {
  return typeof raw === "string" && PROTOCOL_STATES.has(raw as RelayProtocolState)
    ? (raw as RelayProtocolState)
    : null;
}

/** What the daemon's /api/health already says about the link. Every field is
 * null when the daemon did not say (legacy payload) — absence is never an
 * error and never an accusation. */
export interface RelayLinkFacts {
  relayConnected: boolean | null;
  relayOk: boolean | null;
  relayReason: string | null;
  attempt: number | null;
  nextDelayMs: number | null;
  lastCloseKind: string | null;
  /** P2-338: the daemon's wire-protocol verdict, sanitized to the closed set
   * (null when the daemon did not say or said something out of set — the
   * field is additive, so absence keeps today's verdict byte for byte). */
  relayProtocolState: RelayProtocolState | null;
  /** quietLocal from the pairing tick: true only when local mode is active AND
   * the user has not asked for the remote QR ceremony (an explicit request
   * uses the real relay, so local mode must not silence the diagnosis). */
  localMode: boolean;
}

/** Close kinds the relay emits for refusal (apps/daemon/src/relayclose.ts:
 * 1013 "capacity" and 4029 "rate-limited"). Any other kind — or none — is a
 * dial in progress, never an accusation. */
const REFUSAL_KINDS = new Set(["capacity", "rate-limited"]);

/**
 * Map the daemon's relay-link snapshot to (state, message). Deterministic and
 * secret-free. Precedence: local mode wins over everything; a legacy payload
 * without relayConnected degrades to a neutral unknown; a boot-refused relay
 * address (relayOk false) is the root cause even when a dial is in flight;
 * a live link is connected — even with a wire-protocol mismatch on record,
 * because a delivered frame is the only end-to-end proof and the daemon
 * clears the verdict the moment the relay speaks this build again (P2-335:
 * the fix self-heals, so a stale mismatch must never outshout a working
 * link); only then does a recorded mismatch become `incompatible` (P2-338 —
 * the wire version differs, waiting is NOT the fix: update the app or the
 * hosted relay), still ahead of a refusal close and the dialing states; a
 * refusal close is refused; everything else is (re)dialing. The protocol
 * states ok/legacy/unknown never mint a verdict of their own — the behavior
 * is exactly what it was before the field existed.
 */
export function linkVerdict(f: RelayLinkFacts): RelayLinkVerdict {
  // Local mode: the phone pairs over the LAN and the relay is irrelevant.
  if (f.localMode) {
    return { state: "local", message: "modo local: o celular pareia direto na rede desta máquina, sem relay" };
  }
  // Legacy daemon: no relayConnected boolean at all → we simply do not know.
  // Neutral wording on purpose — absence of data is never a failure.
  if (typeof f.relayConnected !== "boolean") {
    return {
      state: "unknown",
      message: "sem informação do relay por enquanto — o pareamento pode seguir normalmente",
    };
  }
  // A RELAY_URL refused at boot is the root cause even when a retry is
  // pending — "dialing" here would be misleading.
  if (f.relayOk === false) {
    return {
      state: "misconfigured",
      message: "o endereço do relay foi recusado na partida do daemon — confira o relay do celular nas configurações",
    };
  }
  if (f.relayConnected) {
    return { state: "connected", message: "o daemon está conectado ao relay — a sala está pronta para o celular" };
  }
  // P2-338: the daemon's own healthz probe saw a wire protocol this build
  // does not speak. A connected link wins above (the daemon self-heals and
  // the verdict clears itself), so anything that reaches here is dialing
  // against a relay it can never join — the one state where waiting is not
  // the fix. Static copy, no version number, no address, never the daemon's
  // own message.
  if (f.relayProtocolState === "mismatch") {
    return {
      state: "incompatible",
      message:
        "o relay hospedado fala um protocolo de fio diferente deste app — atualize o app ou o relay hospedado e aguarde a reconexão",
    };
  }
  if (f.lastCloseKind !== null && REFUSAL_KINDS.has(f.lastCloseKind)) {
    return {
      state: "refused",
      message: "o relay recusou a conexão do daemon — aguarde uma vaga e rescaneie o código",
    };
  }
  // transient/normal/draining close — or no close yet — means the daemon is
  // (re)dialing right now.
  if (typeof f.attempt === "number" && f.attempt >= 1) {
    return {
      state: "dialing",
      message: "o daemon está reconectando ao relay — aguarde um instante e rescaneie o código",
    };
  }
  return {
    state: "dialing",
    message: "o daemon está conectando ao relay — aguarde um instante e rescaneie o código",
  };
}
