// P2-288: additive settings-channel mirror of the machine-readiness verdicts.
// Pure module — no node:fs, node:http, node:child_process or fetch imports and
// no I/O of any kind on purpose, because index.ts runs main() on import and
// unit tests must never boot a daemon (same pattern as browsecap.ts /
// doccap.ts / routinedue.ts, lessons P2-149 and P2-228). All I/O (probing the
// capabilities, reading the settings file, answering the HTTP route) stays in
// the caller — index.ts probes and answers; this module only decides WHICH
// fields ride the GET /__ocr/settings response.
//
// Why this exists: the machine-state screen already knows how to draw the
// document-conversion and site-navigation rows (apps/web machinestate.ts,
// P2-232/P2-287), but the daemon never sent those two verdicts through the
// settings channel the screen reads — a lay user only discovered a missing
// capability after asking for the task. GET /api/health already publishes
// both verdicts; this module mirrors exactly those names and values onto the
// existing settings read — no new route, no new request, no new poll.
//
// RULE ORDER CONTRACT — settingsMirror evaluates the rules in THIS order and
// the order is part of the contract:
//   1. absent input, input that is not an object, or a snapshot carrying any
//      present-but-non-textual field yields the EMPTY SET — a snapshot that
//      violates its normalization contract is trusted nowhere;
//   2. a capability whose verdict is outside the documented table yields no
//      field for that capability (the other capability is unaffected — this
//      is the rule the order-proof case pins);
//   3. a capability that was never measured yields no field INSTEAD of a
//      field announcing readiness — fail-closed, because announcing a
//      readiness that was never measured is worse than the screen staying
//      silent. The never-measured cases are an absent capability and the
//      browse "unknown" verdict (the neutral no-measurement state of
//      browsecap.ts); the mirror never synthesizes or defaults a field;
//   4. the machine's phrase travels literally — state and message are copied
//      verbatim, never rewritten, never re-authored by this module;
//   5. the result is identical for the same input on every call: no clock,
//      no randomness, no module state.
//
// Documented tables — exactly the measured verdicts GET /api/health publishes
// for each capability today (docs/api.md):
//   document conversion: "complete" | "partial" | "unavailable"
//   site navigation:     "ready" | "no-browser" | "disabled"
//
// PRIVACY BOUNDARY (part of the contract): no value returned by this module
// ever contains an absolute path, a volume name, a port, an address, a raw
// environment variable or a secret. The mirror only ever copies the state
// tag and the already-redacted pt-BR phrase the capability modules authored
// (doccap.ts / browsecap.ts), so mirroring cannot introduce a leak.

/** The documented measured table for the document-conversion verdict. */
const DOC_STATES: readonly string[] = ["complete", "partial", "unavailable"];

/** The documented measured table for the site-navigation verdict. */
const BROWSE_STATES: readonly string[] = ["ready", "no-browser", "disabled"];

/** The additive fields this mirror can put on the settings channel. */
export interface SettingsMirrorFields {
  docConvertState?: string;
  docConvertMessage?: string;
  browseState?: string;
  browseMessage?: string;
}

/**
 * Decide which readiness verdicts ride the GET /__ocr/settings response,
 * given the already-normalized readiness snapshot /api/health publishes
 * (docConvertState/docConvertMessage, browseState/browseMessage). Tolerant
 * and fail-closed: see the module header for the rule order and the privacy
 * boundary.
 */
export function settingsMirror(input?: unknown): SettingsMirrorFields {
  // rule 1a — absent or non-object input: nothing to mirror, empty set
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const snap = input as Record<string, unknown>;
  const fields = [snap.docConvertState, snap.docConvertMessage, snap.browseState, snap.browseMessage];
  // rule 1b — a present-but-non-textual field breaks the snapshot contract:
  // trust nothing instead of manufacturing a malformed field
  if (fields.some((v) => v !== undefined && typeof v !== "string")) return {};
  const out: SettingsMirrorFields = {};
  // rules 2+3 — only a measured, in-table verdict WITH its textual phrase
  // becomes a field pair; out-of-table, never-measured or incomplete
  // capabilities stay silent (the other capability is unaffected)
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
  // rules 4+5 — the values above are verbatim copies; the same input always
  // builds the same object with the same key order
  return out;
}
