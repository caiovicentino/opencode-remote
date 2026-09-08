// P2-258: the download the tray used to ignore. Between "update available"
// and "update downloaded" sits a background download of hundreds of
// megabytes that happened in total silence, and a download killed by the
// network mid-way simply stopped — leaving the tray label lying forever,
// because nothing in the shell listened to the updater's progress. This
// module is the pure decision layer: main.ts feeds it the bytes the updater's
// own "download-progress" event already reports plus the instants, and gets
// back a short tray label and a verdict that is EXACTLY one of three —
// downloading, stuck or unknown progress. No electron, no file-system
// access, no fetch, no I/O of any kind (same hygiene as updateremind.ts,
// traystatus.ts and badge.ts) so scripts/unit.test.ts and
// scripts/updateprogress.test.ts exercise every branch in plain Node.
//
// Rule order (evaluated exactly in this order; the tests pin each seam):
//   1. Silence greater than the documented limit wins everything and becomes
//      "stuck" even with a high percentage — a download stopped at ninety
//      percent is still stopped.
//   2. A total that is not numeric, not finite or <= 0 becomes "unknown
//      progress" with a label that carries no number — never an invented
//      percentage.
//   3. Non-finite or negative bytes are treated as zero (fail-closed).
//   4. Bytes above the total are capped at one hundred percent, never beyond.
//   5. A non-finite instant is refused instead of guessed ("unknown").
//   6. An instant in the future is treated as "now" — the age is never
//      negative.
//   7. Only the remainder is "downloading".
//
// Harness-session rule (OCR_DESKTOP_SESSION): by the P2-235/P2-238 lessons it
// is the FIRST decision of any path that would open a window, dialog or
// focus. This module opens nothing by construction — it computes a string —
// and the main.ts wiring that consumes the verdict only rewrites an
// operating-system tray label, a surface that never appears in an evidence
// screenshot, so nothing is opened and no framing can change in a harness
// session (same reasoning documented in traystatus.ts).
//
// Label hygiene (P2-140 / P2-182 lessons): every label is static English —
// the language of the neighboring tray items ("Check for updates", "Restart
// daemon") — with no file path, no address, no port, no feed URL and no
// secret, and each fits inside TRAY_TIP_MAX_CHARS, the max size documented
// for tray text (traystatus.ts).
//
// The stuck verdict is a LABEL-ONLY verdict: it never cancels a download,
// never downgrades a version or a feed, never downloads anything new and
// never installs anything. main.ts pairs it with a single static log line.

/** A download silent for longer than this reads as stalled. The updater emits
 * download-progress several times a second on a healthy link, so two full
 * minutes of silence means the bytes stopped flowing. */
export const UPDATE_PROGRESS_SILENCE_MS = 120_000;

/** The documented limits, as consumed by main.ts and pinned by the tests. */
export const UPDATE_PROGRESS_LIMITS: UpdateProgressLimits = Object.freeze({ silenceMs: UPDATE_PROGRESS_SILENCE_MS });

export interface UpdateProgressLimits {
  silenceMs: number;
}

/** Exactly one of three verdicts, per the rule order in the header. */
export type UpdateProgressVerdict = "downloading" | "stuck" | "unknown";

/** Static labels — hygiene contract in the header. The percent variant is
 * `UPDATE_PROGRESS_LABEL_DOWNLOADING` + " N%". */
export const UPDATE_PROGRESS_LABEL_DOWNLOADING = "Downloading update…";
export const UPDATE_PROGRESS_LABEL_STUCK = "Update download stalled — check for updates";

export interface UpdateProgressView {
  verdict: UpdateProgressVerdict;
  /** Short tray label, static and secret-free. */
  label: string;
  /** Integer 0–100, or null when the view refuses to invent one. */
  percent: number | null;
  /** Why: downloading | stuck-silence | unknown-total | invalid-instant. */
  reason: string;
}

/**
 * Map (bytes transferred, announced total, last-progress instant, current
 * instant, limits) to the tray's download-progress view. Deterministic — the
 * same inputs produce the same verdict, no clock, no randomness, no I/O.
 */
export function updateProgressView(
  bytes: number,
  total: number,
  lastProgressAt: number,
  now: number,
  limits: UpdateProgressLimits,
): UpdateProgressView {
  // A broken limit falls back to the documented default instead of widening
  // the window where a dead download reads as alive.
  const silenceMs =
    limits && typeof limits.silenceMs === "number" && Number.isFinite(limits.silenceMs) && limits.silenceMs >= 0
      ? limits.silenceMs
      : UPDATE_PROGRESS_SILENCE_MS;
  // Rule 6/7 preparation: the age is never negative — a last-progress instant
  // in the future reads as "now". A non-finite instant yields null (refused
  // at rule 5) instead of a guessed age.
  const age = Number.isFinite(now) && Number.isFinite(lastProgressAt) ? Math.max(0, now - lastProgressAt) : null;
  // Rule 1 — silence wins everything, even a high percentage.
  if (age !== null && age > silenceMs) {
    return { verdict: "stuck", label: UPDATE_PROGRESS_LABEL_STUCK, percent: null, reason: "stuck-silence" };
  }
  // Rule 2 — no usable total, no number: unknown progress, never an invented
  // percentage.
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) {
    return { verdict: "unknown", label: UPDATE_PROGRESS_LABEL_DOWNLOADING, percent: null, reason: "unknown-total" };
  }
  // Rule 3 — non-finite or negative bytes are zero (fail-closed).
  const transferred = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  // Rule 4 — bytes above the total cap at one hundred percent, never beyond.
  const clamped = transferred > total ? total : transferred;
  // Rule 5 — a non-finite instant is refused, not guessed.
  if (age === null) {
    return { verdict: "unknown", label: UPDATE_PROGRESS_LABEL_DOWNLOADING, percent: null, reason: "invalid-instant" };
  }
  // Rules 6–7 — only the remainder is downloading. Floored so a partial
  // download never rounds up to a whole percent it has not reached (or to
  // 100 before the last byte).
  const percent = Math.floor((clamped / total) * 100);
  return {
    verdict: "downloading",
    label: `${UPDATE_PROGRESS_LABEL_DOWNLOADING} ${percent}%`,
    percent,
    reason: "downloading",
  };
}
