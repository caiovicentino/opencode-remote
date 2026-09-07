/** P2-232: machine-state readiness rows for the Settings screen. Pure on
 * purpose — no React, no fetch, no I/O (same discipline as degraded.ts and
 * welcome.ts): scripts/unit.test.ts pins the full table, so a malformed or
 * partial payload can never crash the view or invent a row the machine never
 * spoke.
 *
 * The input is the daemon's readiness block (versionState, diskState,
 * docConvertState, browseState, voiceState, the relay object, the opencode
 * object) — every field is read tolerantly: absent or ill-typed fields are
 * simply ignored and never become a row. The app feeds the module the
 * readiness verdicts mirrored on the existing GET /__ocr/settings read —
 * since P2-292/P2-296 the settings mirror carries every capability (relay,
 * the agent binary pair, doc conversion, browse, voice) and, since P2-297,
 * the view wires ALL of them from the same mount read, so the section still
 * makes no new request, no new route, no new poll and no new timer. A
 * verdict the connected daemon does not report simply yields no row (the
 * calm empty state covers it, mirroring the P2-213/P2-215 fail-open
 * discipline).
 *
 * Severity has exactly three levels. The ordering is worst-first with a fixed,
 * documented key order as the tie-break, so the list never dances between two
 * polls that report the same verdicts. The daemon's phrases are rendered
 * verbatim — the module never rewrites them and never invents its own; the
 * only UI copy (labels, header) travels as i18n keys per the P2-118 lesson.
 *
 * The browse row (P2-287) maps the four documented P2-284 verdicts by THIS
 * table, written here so tests and reviews share one truth:
 *   ready      → ok
 *   no-browser → unavailable  (the machine cannot open sites at all)
 *   disabled   → attention    (the machine's owner turned browsing off)
 *   unknown    → attention    (fail-closed, NEVER ok — announcing a readiness
 *                             that was never measured is worse than admitting
 *                             we do not know)
 * It is the documented exception to the "unknown stays silent" rule below:
 * a browse verdict of "unknown" IS a row, with attention severity.
 *
 * The voice row (P2-297) maps the three documented P2-296 verdicts by THIS
 * closed table, written here so tests and reviews share one truth:
 *   ready          → ok
 *   missing-model  → attention    (the engine is there, the model is not)
 *   missing-binary → unavailable  (the machine cannot hear at all)
 * Every other value — absent, non-textual or out-of-table — yields no row:
 * the general silence rule holds, and navigation keeps being the ONLY
 * documented exception where a verdict outside the measured table
 * ("unknown") becomes a row. */

export type MachineSeverity = "ok" | "attention" | "unavailable";

export type MachineRowKey = "relay" | "agent" | "version" | "disk" | "docs" | "browse" | "voice";

export interface MachineReadinessRow {
  /** Stable row key — doubles as the documented fixed tie-break order. */
  key: MachineRowKey;
  severity: MachineSeverity;
  /** i18n key of the short label; the view resolves it per locale (P2-118). */
  labelKey: string;
  /** The daemon's own phrase, verbatim. "" when the daemon sends no phrase
   * for this verdict (the label alone carries the row). */
  message: string;
}

/** Fixed row order: the module's build order AND the tie-break for rows of
 * the same severity — documented here so tests and reviews share one truth.
 * P2-297: new capability keys are APPENDED at the end (voice last) so no
 * existing row ever changes position. */
export const MACHINE_ROW_ORDER: readonly MachineRowKey[] = [
  "relay",
  "agent",
  "version",
  "disk",
  "docs",
  "browse",
  "voice",
];

/** Severity → the shared .status-dot chrome class (apps/web/src/index.css).
 * attention reuses the amber "wait" dot; unavailable the red "err" dot. */
export const MACHINE_SEVERITY_DOT: Record<MachineSeverity, string> = {
  ok: "ok",
  attention: "wait",
  unavailable: "err",
};

/** The four documented P2-284 browse verdicts the browse row accepts — the
 * executable form of the table in the header, exported so the view's
 * documented evidence hatch reuses one truth instead of duplicating it. */
export const BROWSE_STATES: readonly string[] = ["ready", "no-browser", "disabled", "unknown"];

/** The documented measured table for the document-conversion verdict (also
 * the one owner of the view's docs evidence hatch — P2-297). */
export const DOC_STATES: readonly string[] = ["complete", "partial", "unavailable"];

/** The three documented P2-296 voice-transcription verdicts the voice row
 * accepts — the executable form of the closed table in the header, exported
 * so the view's documented evidence hatch reuses one truth instead of
 * duplicating it (same discipline as BROWSE_STATES, P2-297). */
export const VOICE_STATES: readonly string[] = ["ready", "missing-binary", "missing-model"];

const SEVERITY_RANK: Record<MachineSeverity, number> = { ok: 0, attention: 1, unavailable: 2 };

/** i18n key of the short label per row (P2-118: the view resolves it). */
const LABEL_KEYS: Record<MachineRowKey, string> = {
  relay: "machineLabelRelay",
  agent: "machineLabelAgent",
  version: "machineLabelVersion",
  disk: "machineLabelDisk",
  docs: "machineLabelDocs",
  browse: "machineLabelBrowse",
  voice: "machineLabelVoice",
};

/** Tolerant read of an object-typed field: only a plain object passes. */
function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Tolerant read of a string field: anything else is absent. */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function row(key: MachineRowKey, severity: MachineSeverity, message: unknown): MachineReadinessRow {
  return { key, severity, labelKey: LABEL_KEYS[key], message: asString(message) };
}

/**
 * Build the readiness rows from a possibly partial or malformed health
 * payload. Never throws, never invents: a payload that is not an object
 * yields [], a field of the wrong type is ignored, and — except for the
 * documented browse exception in the header (unknown → attention, fail-
 * closed) — an "unknown" verdict yields no row (the daemon's neutral state,
 * the calm empty state covers it, mirroring the P2-213/P2-215 fail-open
 * discipline).
 */
export function readinessRows(health: unknown): MachineReadinessRow[] {
  const body = asObject(health);
  if (!body) return [];
  const opencode = asObject(body.opencode);

  const candidates: MachineReadinessRow[] = [];

  // relay — the daemon↔relay link: ok=false is a down remote link, and the
  // daemon's reason (already redacted — no URL, no secret) is the phrase.
  const relay = asObject(body.relay);
  if (relay && typeof relay.ok === "boolean") {
    candidates.push(row("relay", relay.ok ? "ok" : "unavailable", relay.ok ? "" : relay.reason));
  }

  // agent — is the opencode binary present at all. binarySource is an
  // internal origin tag, not a human phrase, and is deliberately not rendered.
  if (opencode && typeof opencode.binaryFound === "boolean") {
    candidates.push(row("agent", opencode.binaryFound ? "ok" : "unavailable", ""));
  }

  // version — the agent-server version verdict. Accepts the real nested
  // shape (opencode.versionState) and the flat spelling of the readiness
  // block as a fallback. unknown stays silent (neutral, never accusatory).
  const versionState = opencode
    ? asString(opencode.versionState) || asString(body.versionState)
    : asString(body.versionState);
  const versionMessage = opencode
    ? asString(opencode.versionMessage) || asString(body.versionMessage)
    : asString(body.versionMessage);
  if (versionState === "ok" || versionState === "too-old") {
    candidates.push(row("version", versionState === "ok" ? "ok" : "attention", versionMessage));
  }

  // disk — space on the volume hosting the daemon's state dir.
  const diskState = asString(body.diskState);
  if (diskState === "ok" || diskState === "low" || diskState === "critical") {
    candidates.push(
      row(
        "disk",
        diskState === "ok" ? "ok" : diskState === "low" ? "attention" : "unavailable",
        asString(body.diskMessage),
      ),
    );
  }

  // docs — document→PDF conversion readiness.
  const docState = asString(body.docConvertState);
  if (DOC_STATES.includes(docState)) {
    candidates.push(
      row(
        "docs",
        docState === "complete" ? "ok" : docState === "partial" ? "attention" : "unavailable",
        asString(body.docConvertMessage),
      ),
    );
  }

  // browse — site-opening readiness (P2-284 payload fields, P2-287 row).
  // Only the four documented verdicts become a row, each with exactly the
  // severity of the table in the header; absent, non-textual or out-of-table
  // values yield no row — same tolerance as every other line. "unknown" is
  // the fail-closed exception: an attention row, never an approved one.
  const browseState = asString(body.browseState);
  if (BROWSE_STATES.includes(browseState)) {
    candidates.push(
      row(
        "browse",
        browseState === "ready" ? "ok" : browseState === "no-browser" ? "unavailable" : "attention",
        asString(body.browseMessage),
      ),
    );
  }

  // voice — speech-to-text readiness (P2-296 payload fields, P2-297 row).
  // Only the three documented verdicts become a row, each with exactly the
  // severity of the closed table in the header; absent, non-textual or
  // out-of-table values yield no row — the general silence rule, with
  // navigation remaining the only documented "unknown" exception.
  const voiceState = asString(body.voiceState);
  if (VOICE_STATES.includes(voiceState)) {
    candidates.push(
      row(
        "voice",
        voiceState === "ready" ? "ok" : voiceState === "missing-model" ? "attention" : "unavailable",
        asString(body.voiceMessage),
      ),
    );
  }

  // Worst first; same-severity rows keep the fixed MACHINE_ROW_ORDER via the
  // explicit index tie-break (stable across calls with the same input).
  return candidates
    .map((r, i) => ({ r, i }))
    .sort((a, b) => SEVERITY_RANK[b.r.severity] - SEVERITY_RANK[a.r.severity] || a.i - b.i)
    .map(({ r }) => r);
}

export interface MachineStateSummary {
  severity: MachineSeverity;
  /** i18n key of the one-line header; the view resolves it per locale. */
  titleKey: string;
}

/**
 * Worst severity of the list plus ONE short header line (an i18n key — no
 * path, no URL scheme, no secret can ever ride the header). An empty list is
 * the documented calm state: nothing is known yet, nothing is wrong.
 */
export function summarize(rows: MachineReadinessRow[] | null | undefined): MachineStateSummary {
  if (!rows || rows.length === 0) return { severity: "ok", titleKey: "machineStateEmpty" };
  if (rows.some((r) => r.severity === "unavailable"))
    return { severity: "unavailable", titleKey: "machineStateUnavailableTitle" };
  if (rows.some((r) => r.severity === "attention"))
    return { severity: "attention", titleKey: "machineStateAttentionTitle" };
  return { severity: "ok", titleKey: "machineStateAllOkTitle" };
}
