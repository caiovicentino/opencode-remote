// P2-257: the deferred-update reminder plan. Pure module — no GUI-framework
// import, no file-system access, no network, no I/O of any kind (same hygiene
// as updateschedule.ts, tray.ts and badge.ts) so scripts/unit.test.ts and the
// portable twin scripts/updateremind.test.ts can exercise every branch in
// plain Node.
//
// Why: under the P1-050 consent flow a plain restart never installs anything
// (update.ts) and a pending "update-downloaded" offer is never re-scheduled
// (updateschedule.ts) — a lay user (stage 3 of docs/VISION.md) who closes the
// dialog once would keep the app pinned to the downloaded-but-unapplied
// release forever, because since P2-152 closing the window keeps the app
// alive indefinitely. This module decides when the offer comes back and
// carries the truthful tray label for that state; main.ts turns the plan into
// a re-arm of the SAME timer updateschedule.ts already feeds and reopens the
// EXACT consent dialog — nothing here installs anything by itself.
//
// Rule order (evaluated exactly in this order):
//   0. Harness session (OCR_DESKTOP_SESSION) — the FIRST decision of the
//      path, before any other consideration: a hermetic run (tools/desktop.mjs,
//      test:desktop-flow) must never open a window or steal focus (P2-235 /
//      P2-238 lessons), so the plan returns "wait" and no evidence screenshot
//      changes framing.
//   1. Any state other than "update-downloaded" never reminds — there is
//      nothing downloaded to apply.
//   2. A version different from the one that generated the previous offers
//      resets the count instead of inheriting it.
//   3. The per-version reminder cap already reached never reminds — endless
//      insistence is harassment and helps nobody.
//   4. An offer newer than the documented minimum interval waits.
//   5. Only the remainder reminds ("due").
//
// Fail-closed details: a non-finite current instant is refused instead of
// guessed; a last-offer instant in the future is treated as "now" (the age is
// never negative); a count that is not a positive safe integer (text, NaN,
// ±Infinity, fractional, negative) counts as zero. Limits are normalized too:
// a non-finite/negative interval falls back to the documented default and a
// non-finite/negative cap means zero reminders — a broken configuration must
// never produce a reminder flood.
//
// The tray label below is a static pt-BR phrase (P2-140 / P2-182 lessons): no
// file path, no address, no port, no secret — and it fits inside
// TRAY_TIP_MAX_CHARS, the max size documented for tray text (traystatus.ts).

/** Minimum ms between offers of the same downloaded release: 4 h. */
export const UPDATE_REMIND_MIN_INTERVAL_MS = 4 * 60 * 60_000;
/** Maximum offers per version (the original dialog + reminders): 3. */
export const UPDATE_REMIND_MAX_PER_VERSION = 3;

/** The documented limits, as consumed by main.ts and pinned by the tests. */
export const UPDATE_REMIND_LIMITS = Object.freeze({
  minIntervalMs: UPDATE_REMIND_MIN_INTERVAL_MS,
  maxPerVersion: UPDATE_REMIND_MAX_PER_VERSION,
});

/**
 * Truthful tray label for the "update-downloaded" state. update.ts's
 * "Update ready — restart to install" is false under the consent flow: a
 * plain restart never installs, accepting the offer does.
 */
export const UPDATE_DOWNLOADED_TRAY_LABEL = "Atualização baixada — a instalação acontece ao aceitar a oferta";

/** The resolved update state the plan decides about. */
export interface UpdateReminderState {
  /** One of update.ts's UpdateStatus strings (kept as string for purity). */
  status: string;
  /** The downloaded release the tray is currently talking about. */
  version: string | null;
  /** Rule 0: true under OCR_DESKTOP_SESSION — never reminds. */
  harnessSession: boolean;
}

/** The offers already shown for one version, kept in main.ts process memory. */
export interface UpdateOfferRecord {
  /** Version the recorded offers were for (null = none shown yet). */
  version: string | null;
  /** Instant (Date.now() base) of the last offer shown; 0 when never. */
  at: number;
  /** How many times that version was offered so far. */
  count: number;
}

/** The documented limits, injected so every value stays testable. */
export interface UpdateReminderLimits {
  minIntervalMs: number;
  maxPerVersion: number;
}

export interface UpdateReminderPlan {
  /** "remind" = reopen the consent dialog now; "wait" = stay quiet. */
  action: "remind" | "wait";
  /** Why: harness-session | state-not-downloaded | invalid-instant |
   * cap-reached | interval-not-elapsed | due. */
  reason: string;
}

/**
 * Decide whether the deferred update offer should come back now. Deterministic
 * (same inputs → same verdict — no clock, no randomness, no I/O); see the rule
 * order in the header.
 */
export function updateReminderPlan(
  state: UpdateReminderState,
  lastOffer: UpdateOfferRecord,
  now: number,
  limits: UpdateReminderLimits,
): UpdateReminderPlan {
  // Rule 0 — the harness-session rule comes before any other consideration.
  if (state.harnessSession) return { action: "wait", reason: "harness-session" };
  // Rule 1 — only a downloaded release can be applied by the dialog.
  if (state.status !== "update-downloaded") return { action: "wait", reason: "state-not-downloaded" };
  // A non-finite "now" cannot age anything — refuse instead of guessing.
  if (!Number.isFinite(now)) return { action: "wait", reason: "invalid-instant" };
  // Rule 2 — a different release starts its own count, never inherits one.
  const sameOffer = typeof state.version === "string" && state.version !== "" && lastOffer.version === state.version;
  const rawCount = typeof lastOffer.count === "number" && Number.isSafeInteger(lastOffer.count) && lastOffer.count > 0
    ? lastOffer.count
    : 0;
  const shown = sameOffer ? rawCount : 0;
  const max = typeof limits.maxPerVersion === "number" && Number.isFinite(limits.maxPerVersion) && limits.maxPerVersion > 0
    ? limits.maxPerVersion
    : 0;
  // Rule 3 — the per-version cap: insisting without end is harassment.
  if (shown >= max) return { action: "wait", reason: "cap-reached" };
  // Rule 4 — the documented minimum interval between offers. The interval
  // falls back to the documented default when a broken limit arrives; a cap
  // of 0 above already fails closed.
  const interval =
    typeof limits.minIntervalMs === "number" && Number.isFinite(limits.minIntervalMs) && limits.minIntervalMs >= 0
      ? limits.minIntervalMs
      : UPDATE_REMIND_MIN_INTERVAL_MS;
  if (sameOffer) {
    // A last-offer instant the caller could not measure is refused too.
    if (!Number.isFinite(lastOffer.at)) return { action: "wait", reason: "invalid-instant" };
    // A future instant reads as "now": the age is never negative.
    const age = Math.max(0, now - lastOffer.at);
    if (age < interval) return { action: "wait", reason: "interval-not-elapsed" };
  }
  // Rule 5 — the remainder reminds.
  return { action: "remind", reason: "due" };
}
