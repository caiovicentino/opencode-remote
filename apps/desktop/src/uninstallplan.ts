// P2-249: pure uninstall-cleanup planner for the packaged app. The Windows
// uninstaller (NSIS) today only deletes program files — while P2-218 turned
// on "start at login", so an uninstalled app left a boot entry pointing at a
// removed executable (the machine tries to open a program that no longer
// exists on every reboot), and the app-data folder kept every state file the
// app ever wrote on disk. This module is the documented, testable model of
// that cleanup: which immediate children of an app-data root are the app's
// own (and therefore go into the removal) and which are not (and are
// preserved, never guessed).
//
// Why removal exists (the reason for every choice below): a shared computer
// must not keep holding the machine identity and the paired-phone list after
// the owner uninstalled the app — and a phone pairing is worthless the
// instant the daemon of that machine ceases to exist, because there is no
// daemon left to pair with. The removal therefore wipes the app's own data
// roots; it exists for privacy, not for tidiness.
//
// Rules apply in this exact order:
//
//  1. a name that does not belong to the documented set of the app's own
//     names (UNINSTALL_REMOVABLE_NAMES) is always PRESERVED — the plan never
//     guesses that something it did not document is disposable;
//  2. an empty name is REFUSED — refused names are neither removed nor
//     preserved, they are surfaced so the caller can audit them;
//  3. a name carrying a directory separator ("/" or "\") is REFUSED — the
//     plan only ever classifies immediate children, never paths;
//  4. a name that jumps to the parent directory ("..") is REFUSED;
//  5. an absolute path (leading "/", leading "\" / UNC, or a Windows drive
//     prefix like "C:") is REFUSED.
//
// Every returned bucket is deduplicated and sorted by ascending name (plain
// code-unit order, no locale), so the same input in two different orders
// yields an identical plan, and the plan never contains a name it was not
// given. Refused names are echoed back verbatim solely so the caller can
// audit them — logging discipline is the caller's duty (the P2-140 bar).
//
// Same module hygiene as loginitem.ts / wakeplan.ts / installloc.ts: NO
// electron, NO node:fs, NO node:path, no fetch, no I/O of any kind — pure
// string classification exercised by scripts/unit.test.ts in plain Node.

/** Documented vocabulary of the app's own immediate-child names inside its
 * data roots. Anything outside this set is preserved, never guessed. */
export const UNINSTALL_REMOVABLE_NAMES: readonly string[] = [
  // Daemon state file (P2-165/P2-234, 0600): machine identity — ECDH and
  // VAPID keys, machine name — and the paired-phone list. The privacy reason
  // the uninstall cleanup exists: on a shared computer this must not outlive
  // the app the owner removed.
  "daemon.json",
  // Shell state under the app-data root.
  "startup.json",
  "quit-ask.json",
  "relay.json",
  "gpu-state.json",
  "window-state.json",
  "close-hint.flag",
  // Directories the shell owns.
  "logs",
  "update-staging",
];

/** What the plan decided for each observed name. */
export type UninstallCleanupVerdict = "remove" | "preserve" | "refuse";

export interface UninstallCleanupPlan {
  /** The app-data root name the plan is scoped to (echoed input). */
  dataRootName: string;
  /** Documented app names scheduled for removal — deduped, ascending. */
  remove: string[];
  /** Names kept because they are not the app's own — deduped, ascending. */
  preserve: string[];
  /** Unsafe names (empty, separator, parent jump, absolute path) — neither
   * removed nor preserved; echoed verbatim for the caller's audit. */
  refused: string[];
}

/** The safety gate: is this observed child name structurally unsafe to
 * classify as removable content? Empty, separator-bearing, parent-jump and
 * absolute-path names are refused instead of removed — the plan only ever
 * names an immediate child of the data root it was given. */
export function isRefusedChildName(name: string): boolean {
  if (name.length === 0) return true;
  if (name.includes("/") || name.includes("\\")) return true;
  if (name === "..") return true;
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[a-z]:/i.test(name)) return true;
  return false;
}

/** Classify each observed immediate-child name of the app-data root against
 * the documented vocabulary. Deterministic and order-insensitive: the same
 * input in any order produces the same plan. */
export function uninstallCleanupPlan(
  dataRootName: string,
  observedNames: readonly string[],
): UninstallCleanupPlan {
  const remove: string[] = [];
  const preserve: string[] = [];
  const refused: string[] = [];
  for (const name of new Set(observedNames)) {
    if (isRefusedChildName(name)) {
      refused.push(name);
    } else if ((UNINSTALL_REMOVABLE_NAMES as readonly string[]).includes(name)) {
      remove.push(name);
    } else {
      preserve.push(name);
    }
  }
  const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    dataRootName,
    remove: remove.sort(asc),
    preserve: preserve.sort(asc),
    refused: refused.sort(asc),
  };
}
