// P2-252: the tray speaks about the whole journey, not just the local
// sidecar. Since P3-007 the tooltip only said "daemon ok/down" — with the
// window closed to the tray (P2-021) the only information available claimed
// everything was fine because the local process was alive, even with the
// relay unreachable and no phone able to reach the machine. This module turns
// the three facts the pairing-watcher tick already holds — sidecar health,
// the daemon↔relay link verdict computed by linkVerdict (P2-199) and the
// paired-phone count from the devices route — into the tray tooltip plus the
// menu status line. P2-276: the phrases come from the shelllang.ts table in
// the resolved shell language (pt table by default — byte-identical to the
// static pt-BR copy this module spoke before the selector existed).
//
// Rule order (the rules below are evaluated exactly in this order):
//   1. Sidecar down wins over everything — without the local process nothing
//      works and no other fact matters.
//   2. Link state: refused, misconfigured, dialing and unknown each carry
//      their own phrase.
//   3. Only with the sidecar up and the link connected or local: zero paired
//      phones becomes the invite-to-pair phrase; local mode with phones keeps
//      its local-network phrase.
//   4. The only remaining case — connected with phones — is the all-ready
//      phrase.
// A phone count that is not a safe integer (text, NaN, Infinity, fractional,
// negative) is treated as zero — fail-closed, never guessed. A link state the
// module does not know falls to the neutral phrase instead of throwing.
//
// Every phrase is static and never echoes the daemon's raw reason (P2-140 /
// P2-182 lessons): no file path, no address, no port, no URL scheme, no phone
// label, no secret.
//
// Tooltip budget: Windows truncates a tray tooltip to 128 characters
// (NOTIFYICONDATA szTip), so every tooltip stays under TRAY_TIP_MAX_CHARS.
//
// No harness-session rule on purpose: the tray is an operating-system surface
// that never appears in a window screenshot — the text opens no window, steals
// no focus and changes no evidence-screenshot framing, so test sessions need
// no special casing here.
//
// Same module hygiene as tray.ts / relaylink.ts / notify.ts: NO electron, NO
// node:fs, no fetch, no I/O of any kind — scripts/unit.test.ts exercises every
// branch in plain Node.

import { shellLabels, type ShellLabels } from "./shelllang";

/** Windows truncates tray tooltips at 128 chars (NOTIFYICONDATA szTip) — every
 * tooltip this module produces must fit under this budget. */
export const TRAY_TIP_MAX_CHARS = 128;

export interface TrayStatusText {
  /** Short tooltip for the tray icon. */
  tooltip: string;
  /** Disabled, non-clickable status line at the top of the tray menu. */
  menuLine: string;
}

/** The link states linkVerdict can mint. Anything else — or nothing at all —
 * degrades to the neutral phrase instead of throwing. */
const KNOWN_LINK_STATES = new Set(["connected", "local", "dialing", "refused", "misconfigured", "unknown"]);

/**
 * Map (sidecar health, link state, paired-phone count) to the tray tooltip and
 * the menu status line. Deterministic, static and secret-free by construction.
 * `labels` (P2-276) is the shelllang.ts vocabulary for the resolved shell
 * language; the default keeps the pt phrases this module always spoke.
 */
export function trayStatus(
  sidecarHealthy: boolean,
  linkState: string | null | undefined,
  phones: unknown,
  labels: ShellLabels = shellLabels("pt"),
): TrayStatusText {
  // Rule 1: without the local process nothing works — no other fact matters.
  if (!sidecarHealthy) {
    return { tooltip: labels.tray.down.tooltip, menuLine: labels.tray.down.menuLine };
  }
  // Rule 2: the link verdict already computed by linkVerdict — an unknown or
  // unrecognized state falls to the neutral phrase, never an accusation.
  const state = typeof linkState === "string" && KNOWN_LINK_STATES.has(linkState) ? linkState : "unknown";
  switch (state) {
    case "refused":
      return { tooltip: labels.tray.refused.tooltip, menuLine: labels.tray.refused.menuLine };
    case "misconfigured":
      return { tooltip: labels.tray.misconfigured.tooltip, menuLine: labels.tray.misconfigured.menuLine };
    case "dialing":
      return { tooltip: labels.tray.dialing.tooltip, menuLine: labels.tray.dialing.menuLine };
    case "unknown":
      return { tooltip: labels.tray.unknown.tooltip, menuLine: labels.tray.unknown.menuLine };
  }
  // Rules 3–4 need a real phone count: anything that is not a safe integer is
  // treated as zero (fail-closed — a nonsense count must never read as "ready").
  const paired = typeof phones === "number" && Number.isSafeInteger(phones) && phones > 0 ? phones : 0;
  if (paired === 0) {
    return { tooltip: labels.tray.invite.tooltip, menuLine: labels.tray.invite.menuLine };
  }
  if (state === "local") {
    return { tooltip: labels.tray.local.tooltip, menuLine: labels.tray.local.menuLine };
  }
  return { tooltip: labels.tray.ready.tooltip, menuLine: labels.tray.ready.menuLine };
}
