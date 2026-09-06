// P2-264: the disk-space gate the update download never had. Between "update
// available" and "update downloaded" sits a download of hundreds of
// megabytes that used to start without ever looking at how much free space
// the machine has — so on a nearly full volume it died at the very end (the
// write failed) and the tray went back to inviting a new check as if nothing
// had happened, leaving the machine pinned to the old version with no word
// about why. This module is the pure decision layer, mirroring the daemon's
// P2-215 disk verdict (apps/daemon/src/diskguard.ts) for the shell's own
// download: main.ts feeds it the free bytes of the volume hosting the data
// directory plus the release size the updater itself announced (when it has
// one), and gets back a verdict that is EXACTLY one of three — download,
// warn or postpone — plus a short tray label and one static sentence. No
// electron, no file-system access, no fetch, no I/O of any kind (same
// hygiene as updateprogress.ts, updateremind.ts and traystatus.ts) so
// scripts/unit.test.ts and scripts/updatespace.test.ts exercise every branch
// in plain Node.
//
// Rule order (evaluated exactly in this order; the tests pin each seam):
//   1. Free bytes that are not numeric, not finite or negative become
//      "postpone", fail-closed — downloading without knowing is exactly the
//      case that breaks today.
//   2. An announced size that is absent, not finite or <= 0 becomes "warn"
//      and NEVER "postpone" — the feed may omit the size, and refusing an
//      update for that would stop the whole product.
//   3. Free space below the necessary (the announced size times the
//      documented multiplier plus the documented headroom, because the
//      installer needs the downloaded package and the unpacked copy at the
//      same time) becomes "postpone".
//   4. Free space above the necessary but inside the warning headroom (the
//      same documented headroom, measured above the necessary threshold)
//      becomes "warn".
//   5. Only the remainder becomes "download".
// The result is identical for the same input in two calls — no clock, no
// randomness, no I/O.
//
// Harness-session rule (OCR_DESKTOP_SESSION): by the P2-235/P2-238 lessons it
// is the FIRST decision of any path that would open a window, dialog or
// focus. This module opens nothing by construction — it computes a verdict —
// and the main.ts wiring that consumes it only reads a statfs result, writes
// one static log line and rewrites an operating-system tray label, a surface
// that never appears in an evidence screenshot (same reasoning documented in
// updateprogress.ts and traystatus.ts). Nothing is opened and no screenshot
// framing can change in a harness session; the gate can only SKIP a download,
// never start, cancel or install one.
//
// Label hygiene (P2-140 / P2-182 lessons): every label and sentence is static
// English — the language of the neighboring tray items ("Check for updates",
// "Restart daemon") — with no file path, no volume name, no address, no port,
// no feed URL and no secret, and each fits inside TRAY_TIP_MAX_CHARS, the max
// size documented for tray text (traystatus.ts).
//
// The postpone verdict is a LABEL-ONLY verdict: it never cancels a download
// in flight, never deletes a single file to free space and never installs
// anything. main.ts pairs it with one static log line, the tray label and a
// skip of the scheduled check — the same timer simply re-evaluates at the
// next tick, so freed space unlocks the update by itself (or via the
// existing "Check for updates" item).

/** The installer needs the downloaded package and the unpacked copy at the
 * same time, so the announced size is multiplied by this before comparing. */
export const UPDATE_SPACE_SIZE_MULTIPLIER = 2;

/** Extra bytes above the multiplied size that must exist before the download
 * is called unconditionally safe — filesystem overhead, temp files, deltas. */
export const UPDATE_SPACE_HEADROOM_BYTES = 250_000_000;

/** The documented constants, as consumed by main.ts and pinned by the tests. */
export const UPDATE_SPACE_LIMITS: UpdateSpaceLimits = Object.freeze({
  sizeMultiplier: UPDATE_SPACE_SIZE_MULTIPLIER,
  headroomBytes: UPDATE_SPACE_HEADROOM_BYTES,
});

export interface UpdateSpaceLimits {
  sizeMultiplier: number;
  headroomBytes: number;
}

/** Exactly one of three verdicts, per the rule order in the header. */
export type UpdateSpaceVerdict = "download" | "warn" | "postpone";

/** Static labels — hygiene contract in the header. */
export const UPDATE_SPACE_LABEL_POSTPONED = "Update postponed — not enough disk space";
export const UPDATE_SPACE_LABEL_POSTPONED_UNKNOWN = "Update postponed — disk space unknown";
export const UPDATE_SPACE_LABEL_SIZE_UNKNOWN = "Update downloading — disk space tight";
export const UPDATE_SPACE_LABEL_WARN = "Disk space low — update may not fit";
export const UPDATE_SPACE_LABEL_DOWNLOAD = "Enough free space for the update";

export interface UpdateSpaceView {
  verdict: UpdateSpaceVerdict;
  /** Short tray label, static and secret-free. */
  label: string;
  /** One static sentence, safe for the shell log — no path, no volume. */
  phrase: string;
  /** Why: invalid-free-bytes | invalid-release-size | insufficient-space |
   * low-space-warning | enough-space. */
  reason: string;
}

const POSTPONED_PHRASE =
  "The update was postponed because this machine does not have enough free disk space — free up space and click Check for updates.";
const POSTPONED_UNKNOWN_PHRASE =
  "The update was postponed because the free disk space could not be measured — free up space and click Check for updates.";
const SIZE_UNKNOWN_PHRASE =
  "Disk space is tight and the update did not announce its size — the download continues, and freeing space avoids a failed install.";
const WARN_PHRASE =
  "Disk space is running low — the update download continues, and freeing space avoids a failed install.";
const DOWNLOAD_PHRASE = "There is enough free disk space for the update.";

/**
 * Map (free bytes of the volume hosting the data directory, announced release
 * size, documented multiplier, documented headroom) to the space verdict.
 * Deterministic — the same inputs produce the same verdict, no clock, no
 * randomness, no I/O; see the rule order in the header.
 */
export function updateSpaceVerdict(
  freeBytes: number | null | undefined,
  announcedSize: number | null | undefined,
  limits: UpdateSpaceLimits,
): UpdateSpaceView {
  // A broken constant falls back to the documented default instead of
  // widening or collapsing the thresholds (same contract as updateprogress).
  const multiplier =
    typeof limits.sizeMultiplier === "number" && Number.isFinite(limits.sizeMultiplier) && limits.sizeMultiplier >= 1
      ? limits.sizeMultiplier
      : UPDATE_SPACE_SIZE_MULTIPLIER;
  const headroom =
    typeof limits.headroomBytes === "number" && Number.isFinite(limits.headroomBytes) && limits.headroomBytes >= 0
      ? limits.headroomBytes
      : UPDATE_SPACE_HEADROOM_BYTES;
  // Rule 1 — free bytes that cannot be trusted postpone fail-closed.
  if (
    typeof freeBytes !== "number" ||
    !Number.isFinite(freeBytes) ||
    freeBytes < 0
  ) {
    return {
      verdict: "postpone",
      label: UPDATE_SPACE_LABEL_POSTPONED_UNKNOWN,
      phrase: POSTPONED_UNKNOWN_PHRASE,
      reason: "invalid-free-bytes",
    };
  }
  // Rule 2 — no usable announced size never refuses the update: the feed may
  // omit the size, and refusing for that would stop the whole product.
  if (typeof announcedSize !== "number" || !Number.isFinite(announcedSize) || announcedSize <= 0) {
    return {
      verdict: "warn",
      label: UPDATE_SPACE_LABEL_SIZE_UNKNOWN,
      phrase: SIZE_UNKNOWN_PHRASE,
      reason: "invalid-release-size",
    };
  }
  // Rule 3 — below the necessary (size × multiplier + headroom) postpones.
  const necessary = announcedSize * multiplier + headroom;
  if (freeBytes < necessary) {
    return {
      verdict: "postpone",
      label: UPDATE_SPACE_LABEL_POSTPONED,
      phrase: POSTPONED_PHRASE,
      reason: "insufficient-space",
    };
  }
  // Rule 4 — above the necessary but inside the warning headroom warns; the
  // download proceeds either way (rule 2's product-first principle).
  if (freeBytes < necessary + headroom) {
    return {
      verdict: "warn",
      label: UPDATE_SPACE_LABEL_WARN,
      phrase: WARN_PHRASE,
      reason: "low-space-warning",
    };
  }
  // Rule 5 — only the remainder downloads.
  return {
    verdict: "download",
    label: UPDATE_SPACE_LABEL_DOWNLOAD,
    phrase: DOWNLOAD_PHRASE,
    reason: "enough-space",
  };
}
