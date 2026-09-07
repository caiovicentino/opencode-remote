// P2-288 + P2-292 + P2-296: additive settings-channel mirror of the
// machine-readiness verdicts. Pure module — no node:fs, node:http,
// node:child_process or fetch imports and no I/O of any kind on purpose,
// because index.ts runs main() on import and unit tests must never boot a
// daemon (same pattern as browsecap.ts / doccap.ts / routinedue.ts, lessons
// P2-149 and P2-228). All
// I/O (probing the capabilities, reading the settings file, answering the
// HTTP route) stays in the caller — index.ts probes and answers; this module
// only decides WHICH fields ride the GET /__ocr/settings response.
//
// Why this exists: the machine-state screen already knows how to draw the
// readiness rows (apps/web machinestate.ts puts relay and agent FIRST in
// MACHINE_ROW_ORDER, P2-232/P2-287), but until P2-292 the daemon never sent
// those two verdicts through the settings channel the screen reads — the two
// most decisive facts for a lay user (can the phone reach this machine
// through the relay, is the agent installed and ready) were the only ones the
// panel never showed. GET /api/health already publishes both verdicts; this
// module mirrors exactly those names and values onto the existing settings
// read — no new route, no new request, no new poll, no new timer.
//
// RULE ORDER CONTRACT — settingsMirror evaluates the rules in THIS order and
// the order is part of the contract:
//   1. absent input, input that is not an object, or a snapshot carrying any
//      present-but-non-textual flat field yields the EMPTY SET — a snapshot
//      that violates its normalization contract is trusted nowhere; the same
//      rule keeps a relay or opencode entry that is present but not a plain
//      object from ever becoming a field (the other capabilities of the
//      snapshot are unaffected);
//   2. a capability whose verdict is outside the documented table yields no
//      field for that capability (the other capabilities are unaffected —
//      this is the rule the order-proof case pins): a relay verdict is in
//      table only with ok exactly true or false beside a phrase that is null
//      or an ADDRESS-FREE string, an agent verdict only with binaryFound
//      exactly true or false beside binarySource exactly "path", "known" or
//      null, a voice verdict only with a state in the documented table beside
//      a PATH-FREE phrase, and the phrase member (reason / binarySource /
//      voiceMessage) must be present beside the state — an incomplete,
//      ill-typed or address-carrying pair is trusted nowhere;
//   3. a capability that was never measured yields no field INSTEAD of a
//      field announcing readiness — fail-closed, because announcing a
//      readiness that was never measured (a connected relay nobody measured,
//      an installed agent nobody checked) is worse than the screen staying
//      silent. The never-measured cases are an absent capability entry and
//      an absent state member (ok / binaryFound / voiceState); the mirror
//      never synthesizes or defaults a field;
//   4. the machine's phrase travels literally — a phrase that rides is
//      copied verbatim, never rewritten, never re-authored by this module;
//      the mirror's only editorial power is refusing a phrase entirely
//      (rule 2), never rewording it;
//   5. the result is identical for the same input on every call: no clock,
//      no randomness, no module state.
//
// Documented tables — exactly the measured verdicts GET /api/health publishes
// for each capability today (docs/api.md):
//   document conversion: "complete" | "partial" | "unavailable"
//   site navigation:     "ready" | "no-browser" | "disabled"
//   voice transcription: "ready" | "missing-binary" | "missing-model"
//   relay link:          ok true | false, with the phrase reason:
//                        string | null (null while connected)
//   agent binary:        binaryFound true | false, with the origin
//                        companion binarySource "path" | "known" | null
//
// PRIVACY BOUNDARY (part of the contract): no value returned by this module
// ever contains a relay address, a host, a port, an absolute path, a volume
// name, a device identifier, a raw environment variable or a secret. Two
// deterministic enforcement points make that true rather than aspirational:
// the relay entry's url is stripped, and a reason phrase rides only when it
// is free of address material — no URL authority ("://"), no colon-digit run
// (host:port, IPv6) and no dotted host token. The boot-validation phrases
// relayurl.ts authors for /api/health embed the (userinfo-redacted) URL or
// the host verbatim — redaction there is userinfo-only — so a misconfigured
// RELAY_URL yields NO relay field at all: the line stays silent instead of
// leaking the address, the same fail-closed trade the spec bakes into rule 3
// (silence beats announcing). The address-free connected verdict (reason
// null) rides normally, and binarySource is the origin tag ("path"/"known"),
// never a filesystem path; the doc/browse phrases are the ones doccap.ts and
// browsecap.ts author under the P2-232 discipline (no path, no URL scheme,
// no secret). The voice phrases (P2-296) are the ones voicecap.ts authors
// under the same discipline and ride only when free of path material — no
// absolute path, no model file name, no install script name, no port, no
// address, no raw environment variable, no secret (PATH_MATERIAL below).
// Same spirit as the P2-285 address-redaction wording.

/** The documented measured table for the document-conversion verdict. */
const DOC_STATES: readonly string[] = ["complete", "partial", "unavailable"];

/** The documented measured table for the site-navigation verdict. */
const BROWSE_STATES: readonly string[] = ["ready", "no-browser", "disabled"];

/** P2-296: the documented measured table for the voice-transcription verdict. */
const VOICE_STATES: readonly string[] = ["ready", "missing-binary", "missing-model"];

/** P2-292: a relay phrase rides only when free of address material. The
 * boot-validation phrases relayurl.ts authors embed the (userinfo-redacted)
 * URL, the host or a dotted address verbatim, so any URL authority ("://"),
 * any colon-digit run (host:port, IPv6) and any dotted token mark the phrase
 * out-of-table and the whole relay field stays silent — fail-closed, because
 * silence beats leaking the address. */
const ADDRESS_MATERIAL = /:\/\/|:\d|[a-z0-9-]+\.[a-z0-9-]+/i;

/** P2-296: a voice phrase rides only when free of path material — the same
 * fail-closed trade as ADDRESS_MATERIAL: the phrases voicecap.ts authors are
 * short actionable sentences with no filesystem location in them, so any
 * slash (absolute path) or backslash, any "$" (raw environment variable), any
 * colon-digit run (port, IPv6, Windows drive) and any script/model-file
 * extension (".sh", ".bin", ".gguf") mark the phrase out-of-table and the
 * whole voice field stays silent — silence beats leaking where the model or
 * the install script lives. */
const PATH_MATERIAL = /[/\\$]|:\d|\.(?:sh|bin|gguf)\b/i;

/** P2-292: the relay-link verdict — the same names and values the /api/health
 * relay object publishes; the url field never rides this mirror. */
export interface SettingsMirrorRelay {
  /** State: true while RELAY_URL is valid and the daemon may dial. */
  ok: boolean;
  /** The machine's own phrase (the boot-validation problems, joined); null
   * while connected — copied verbatim, never rewritten. */
  reason: string | null;
}

/** P2-292: the agent-binary verdict — the same names and values the
 * /api/health opencode object publishes for the binary pair (P2-149). */
export interface SettingsMirrorAgent {
  /** State: true when an executable opencode binary exists on this machine. */
  binaryFound: boolean;
  /** Origin of the pick ("path" = a PATH entry, "known" = a known install
   * location), null when none is executable — an origin tag, never a path. */
  binarySource: string | null;
}

/** The additive fields this mirror can put on the settings channel. */
export interface SettingsMirrorFields {
  docConvertState?: string;
  docConvertMessage?: string;
  browseState?: string;
  browseMessage?: string;
  relay?: SettingsMirrorRelay;
  opencode?: SettingsMirrorAgent;
  voiceState?: string;
  voiceMessage?: string;
}

/** Tolerant plain-object read: only a plain object passes (rule 1). */
function plainObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Decide which readiness verdicts ride the GET /__ocr/settings response,
 * given the already-normalized readiness snapshot /api/health publishes
 * (docConvertState/docConvertMessage, browseState/browseMessage, the relay
 * object, the opencode binary pair, and since P2-296 the voice pair
 * voiceState/voiceMessage). Tolerant and fail-closed: see the module header
 * for the rule order and the privacy boundary.
 */
export function settingsMirror(input?: unknown): SettingsMirrorFields {
  // rule 1a — absent or non-object input: nothing to mirror, empty set
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const snap = input as Record<string, unknown>;
  const fields = [
    snap.docConvertState,
    snap.docConvertMessage,
    snap.browseState,
    snap.browseMessage,
    snap.voiceState,
    snap.voiceMessage,
  ];
  // rule 1b — a present-but-non-textual flat field breaks the snapshot
  // contract: trust nothing instead of manufacturing a malformed field
  if (fields.some((v) => v !== undefined && typeof v !== "string")) return {};
  const out: SettingsMirrorFields = {};
  // rules 2+3 — only a measured, in-table verdict WITH its phrase becomes a
  // field pair; out-of-table, never-measured or incomplete capabilities stay
  // silent (the other capabilities are unaffected)
  const docState = snap.docConvertState as string | undefined;
  const docMessage = snap.docConvertMessage as string | undefined;
  if (docState !== undefined && docMessage !== undefined && DOC_STATES.includes(docState)) {
    out.docConvertState = docState;
    out.docConvertMessage = docMessage;
  }
  const browseState = snap.browseState as string | undefined;
  const browseMessage = snap.browseMessage as string | undefined;
  if (browseState !== undefined && browseMessage !== undefined && BROWSE_STATES.includes(browseState)) {
    out.browseState = browseState;
    out.browseMessage = browseMessage;
  }
  // P2-292 — the relay link rides the same rules, one capability at a time:
  // a malformed or out-of-table entry silences only the relay. The state is
  // ok (exactly boolean) beside a phrase that is null or an address-free
  // string, both copied verbatim; the url, present or not, never becomes a
  // field, and a phrase carrying address material silences the whole verdict.
  const relay = plainObject(snap.relay);
  if (relay) {
    const ok = relay.ok;
    const reason = relay.reason;
    if (
      (ok === true || ok === false) &&
      (reason === null || (typeof reason === "string" && !ADDRESS_MATERIAL.test(reason)))
    ) {
      out.relay = { ok, reason };
    }
  }
  // P2-292 — the agent binary rides the same rules: state binaryFound
  // (exactly boolean) beside its origin companion binarySource ("path" |
  // "known" | null), both copied verbatim.
  const agent = plainObject(snap.opencode);
  if (agent) {
    const binaryFound = agent.binaryFound;
    const binarySource = agent.binarySource;
    if (
      (binaryFound === true || binaryFound === false) &&
      (binarySource === null || binarySource === "path" || binarySource === "known")
    ) {
      out.opencode = { binaryFound, binarySource };
    }
  }
  // P2-296 — the voice-transcription verdict rides the same rules, one
  // capability at a time: the state must be in the documented table beside a
  // phrase that is free of path material, both copied verbatim. A phrase
  // carrying an absolute path, a model file name, an install script name, a
  // port, an address, a raw environment variable or a secret silences the
  // whole verdict — the line stays quiet instead of leaking (rule 4 still
  // holds: the phrase that rides is never rewritten, only refused entirely).
  const voiceState = snap.voiceState as string | undefined;
  const voiceMessage = snap.voiceMessage as string | undefined;
  if (
    voiceState !== undefined &&
    voiceMessage !== undefined &&
    VOICE_STATES.includes(voiceState) &&
    !PATH_MATERIAL.test(voiceMessage)
  ) {
    out.voiceState = voiceState;
    out.voiceMessage = voiceMessage;
  }
  // rules 4+5 — the values above are verbatim copies; the same input always
  // builds the same object with the same key order
  return out;
}
