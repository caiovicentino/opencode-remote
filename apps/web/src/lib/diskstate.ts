// P3-462: the chat composer's disk-readiness verdict, derived from the
// additive `diskState` field the daemon publishes on GET /api/health
// (P2-215) and mirrors on the GET /__ocr/settings channel as the object
// `disk: { state, message }` — the same read every other readiness screen
// consumes (see machinestate.ts). Pure on purpose — no React, no fetch, no
// I/O — because scripts/unit.test.ts pins the full tables, so a malformed
// or partial payload can never crash the view or invent a verdict the
// machine never spoke.
//
// Why: the phone used to learn the machine's disk was full only when an
// attachment failed mid-upload (a raw write error, P2-215's late failure
// shape). The verdict now reaches the composer BEFORE the send: with
// `critical` the attach button is disabled beside one short line under the
// composer; with `low` a discreet warning renders without blocking
// anything; with `ok` or an unknown verdict (absent, null, malformed,
// out-of-set — lesson P2-338: fail-closed to null, never to a guess) the
// composer stays exactly what it was yesterday.
//
// The daemon's own phrase renders verbatim while it is a short single-line
// string; anything else (absent, non-textual, too long, control
// characters) falls back to the app's static copy, resolved per locale by
// the caller (P2-118: every app sentence travels as an i18n key).

/** The closed set the additive field accepts — exactly the states
 * apps/daemon/src/diskguard.ts publishes for the disk verdict (P2-215). */
export type DiskState = "ok" | "low" | "critical";

export const DISK_STATES: readonly string[] = ["ok", "low", "critical"];

/** A payload phrase renders verbatim only when it is a short single-line
 * string. The daemon's phrases are short actionable pt-BR sentences (no
 * paths, no URLs, no secrets) and never approach this ceiling; anything
 * longer or carrying control characters is treated as untrustworthy and
 * falls back to the app's static copy. */
export const DISK_PHRASE_MAX = 200;

/** Tolerant plain-object read: only a plain object passes (arrays never). */
function plainObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Sanitize the additive `diskState` field to the closed set — the
 * executable form of the table in the header. Accepts the flat string
 * /api/health publishes (`diskState`) and the object shape the settings
 * mirror carries (`disk: { state, message }`); every other value — absent,
 * null, an object without a state member or a value outside the set —
 * becomes null, fail-closed (lesson P2-338), so a legacy daemon and a
 * malformed payload both leave the composer untouched. One unwrap level
 * only: `{ state: { state: "ok" } }` is not a shape the daemon publishes
 * and must not pass.
 */
export function sanitizeDiskState(field: unknown): DiskState | null {
  if (typeof field === "string") {
    return (DISK_STATES as readonly string[]).includes(field) ? (field as DiskState) : null;
  }
  const obj = plainObject(field);
  if (obj) {
    const state = obj.state;
    if (typeof state === "string" && (DISK_STATES as readonly string[]).includes(state)) {
      return state as DiskState;
    }
  }
  return null;
}

/**
 * The payload phrase rides verbatim only while it is a short single-line
 * string; anything else returns null so the caller falls back to its own
 * static copy instead of rendering a sentence the daemon never wrote.
 */
export function sanitizeDiskPhrase(phrase: unknown): string | null {
  if (typeof phrase !== "string") return null;
  const trimmed = phrase.trim();
  if (!trimmed || trimmed.length > DISK_PHRASE_MAX || /[\u0000-\u001F\u007F]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** The composer's derived state from the disk verdict (the header table,
 * executable form). `state` null and `blocked` false with an empty message
 * is the documented no-op: the composer renders exactly as it did before
 * this module existed. */
export interface ComposerDiskAdvice {
  state: DiskState | null;
  /** True only for `critical` — the attach button is disabled. */
  blocked: boolean;
  /** "" for null/ok; the short line under the composer for low/critical. */
  message: string;
}

/**
 * Derive the composer's disk advice from the machine's disk read plus the
 * caller's static copy. The read arrives either as the flat pair
 * /api/health publishes (diskState + diskMessage — preferred when present)
 * or as the object the settings mirror carries (disk: { state, message });
 * both wire shapes sanitize identically, so the composer works with a
 * daemon before and after the field exists. Low warns without blocking;
 * only `critical` disables the attach button, and the rendered line is the
 * machine's own phrase while it is a short single-line string, the static
 * copy otherwise. A flat field present but out-of-set never falls through
 * to the object — the payload that broke its contract is trusted nowhere
 * (fail-closed, lesson P2-338).
 */
export function composerDiskAdvice(
  health: unknown,
  staticLow: string,
  staticCritical: string,
): ComposerDiskAdvice {
  const body = plainObject(health);
  if (!body) return { state: null, blocked: false, message: "" };
  const state = sanitizeDiskState(body.diskState !== undefined ? body.diskState : body.disk);
  if (!state) return { state, blocked: false, message: "" };
  if (state === "ok") return { state: "ok", blocked: false, message: "" };
  const phrase =
    sanitizeDiskPhrase(body.diskMessage) ??
    sanitizeDiskPhrase(plainObject(body.disk)?.message);
  return {
    state,
    blocked: state === "critical",
    message: phrase ?? (state === "critical" ? staticCritical : staticLow),
  };
}
