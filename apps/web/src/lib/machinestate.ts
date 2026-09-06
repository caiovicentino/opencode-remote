/** P2-232: machine-state readiness rows for the Settings screen. Pure on
 * purpose — no React, no fetch, no I/O (same discipline as degraded.ts and
 * welcome.ts): scripts/unit.test.ts pins the full table, so a malformed or
 * partial payload can never crash the view or invent a row the machine never
 * spoke.
 *
 * The input is the daemon's /api/health readiness block (versionState,
 * diskState, docConvertState, the relay object, the opencode object) — every
 * field is read tolerantly: absent or ill-typed fields are simply ignored and
 * never become a row. The app feeds the module the readiness verdicts already
 * mirrored on the existing GET /__ocr/settings read, so the Settings section
 * makes no new request and starts no new poll; fields the PWA channel does not
 * carry yet (relay, binary, doc conversion) simply yield no row until a
 * future channel delivers them.
 *
 * Severity has exactly three levels. The ordering is worst-first with a fixed,
 * documented key order as the tie-break, so the list never dances between two
 * polls that report the same verdicts. The daemon's phrases are rendered
 * verbatim — the module never rewrites them and never invents its own; the
 * only UI copy (labels, header) travels as i18n keys per the P2-118 lesson. */

export type MachineSeverity = "ok" | "attention" | "unavailable";

export type MachineRowKey = "relay" | "agent" | "version" | "disk" | "docs";

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
 * the same severity — documented here so tests and reviews share one truth. */
export const MACHINE_ROW_ORDER: readonly MachineRowKey[] = [
  "relay",
  "agent",
  "version",
  "disk",
  "docs",
];

/** Severity → the shared .status-dot chrome class (apps/web/src/index.css).
 * attention reuses the amber "wait" dot; unavailable the red "err" dot. */
export const MACHINE_SEVERITY_DOT: Record<MachineSeverity, string> = {
  ok: "ok",
  attention: "wait",
  unavailable: "err",
};

const SEVERITY_RANK: Record<MachineSeverity, number> = { ok: 0, attention: 1, unavailable: 2 };

/** i18n key of the short label per row (P2-118: the view resolves it). */
const LABEL_KEYS: Record<MachineRowKey, string> = {
  relay: "machineLabelRelay",
  agent: "machineLabelAgent",
  version: "machineLabelVersion",
  disk: "machineLabelDisk",
  docs: "machineLabelDocs",
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
 * yields [], a field of the wrong type is ignored, and an "unknown" verdict
 * yields no row (the daemon's neutral state — the calm empty state covers it,
 * mirroring the P2-213/P2-215 fail-open discipline).
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
  if (docState === "complete" || docState === "partial" || docState === "unavailable") {
    candidates.push(
      row(
        "docs",
        docState === "complete" ? "ok" : docState === "partial" ? "attention" : "unavailable",
        asString(body.docConvertMessage),
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
