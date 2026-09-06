/**
 * P2-237 — portable-suite coverage guard.
 *
 * scripts/portable-suite.ts keeps a hand-written PORTABLE_TESTS list; a test
 * file created after the fact would silently stay outside the verify-win
 * Windows job, typecheck and the portable battery would both stay green, and
 * a separator-only regression would surface again on the machine of a
 * non-technical user (stages 3 and 5 of docs/VISION.md) — the exact failure
 * P2-224 closed once. This module is the deterministic guard: every .test.ts
 * file in scripts/ must be EITHER in the portable list OR declared in
 * PORTABLE_EXCLUSIONS with one of the documented causes below — there is no
 * third option.
 *
 * The documented, closed set of exclusion causes (why a test file is
 * intentionally NOT in the portable Windows battery):
 * - electron: the test boots the real desktop shell and is driven by the
 *   desktop harness, not by plain node.
 * - unix-socket: the test binds a unix domain socket / named pipe pair whose
 *   address shape differs on Windows.
 * - chmod: the test relies on POSIX chmod semantics (mode bits) that node on
 *   Windows does not honor.
 * - long-lived-child: the test spawns the relay, the daemon or a CLI and
 *   keeps the child running across many assertions.
 * - network-port: the test boots http/ws servers or connects out to a live
 *   relay/daemon, i.e. it depends on the real network stack.
 * - symlink: the test creates symlinks, which on Windows require developer
 *   mode or admin rights.
 *
 * Pure by construction: no fs, no child process, no network — the caller
 * reads the real-world inputs (the scripts directory listing, the portable
 * list) and injects them, so the unit battery can pin every branch with
 * synthetic fixtures and the real-repo assertion in scripts/unit.test.ts
 * fails the gate the moment an unclassified test file appears.
 */

/** The documented, closed set of reasons a test file stays out of the portable battery. */
export const PORTABLE_EXCLUSION_CAUSES: Readonly<Record<string, string>> = {
  electron: "boots the real desktop shell and is driven by the desktop harness, not plain node",
  "unix-socket": "binds a unix domain socket / named pipe pair whose address shape differs on Windows",
  chmod: "relies on POSIX chmod semantics (mode bits) that node on Windows does not honor",
  "long-lived-child": "spawns the relay, the daemon or a CLI and keeps the child running across many assertions",
  "network-port": "boots http/ws servers or connects out to a live relay/daemon over the real network stack",
  symlink: "creates symlinks, which on Windows require developer mode or admin rights",
};

export interface PortableExclusion {
  /** Bare file name inside scripts/ (e.g. "localws.test.ts"). */
  file: string;
  /** One of the documented causes above (validated at runtime). */
  cause: string;
}

/**
 * Test files intentionally outside the portable battery, each with its
 * documented cause. This list only records today's state — it moves no file
 * in or out of the battery.
 */
export const PORTABLE_EXCLUSIONS: readonly PortableExclusion[] = [
  { file: "artifact-auto.test.ts", cause: "symlink" },
  { file: "chunk.test.ts", cause: "long-lived-child" },
  { file: "context-checkpoint.test.ts", cause: "network-port" },
  { file: "desktop-crash.test.ts", cause: "electron" },
  { file: "desktop-flow.test.ts", cause: "electron" },
  { file: "desktop-render.test.ts", cause: "electron" },
  { file: "desktop-sidecar.test.ts", cause: "long-lived-child" },
  { file: "desktop-update.test.ts", cause: "long-lived-child" },
  { file: "dist-smoke.test.ts", cause: "chmod" },
  { file: "download.test.ts", cause: "network-port" },
  { file: "e2e-orphans.test.ts", cause: "long-lived-child" },
  { file: "electron-vuln.test.ts", cause: "long-lived-child" },
  { file: "localws.test.ts", cause: "unix-socket" },
  { file: "message-paging.test.ts", cause: "long-lived-child" },
  { file: "preview.test.ts", cause: "long-lived-child" },
  { file: "pwa-watch.test.ts", cause: "long-lived-child" },
  { file: "push.test.ts", cause: "network-port" },
  { file: "reconnect.test.ts", cause: "long-lived-child" },
  { file: "relay-healthz.test.ts", cause: "network-port" },
  { file: "relay-ipcap.test.ts", cause: "long-lived-child" },
  { file: "relay-liveness.test.ts", cause: "long-lived-child" },
  { file: "relay-rooms.test.ts", cause: "long-lived-child" },
  { file: "relay-ratelimit.test.ts", cause: "long-lived-child" },
  { file: "release-preflight.test.ts", cause: "long-lived-child" },
  { file: "routines.test.ts", cause: "network-port" },
  { file: "unit.test.ts", cause: "network-port" },
];

/**
 * Cross-check the classification coverage of the portable battery, returning
 * one problem per cause in the established problems format (a plain string[]
 * a caller can print or count), applying the rules in this order with no
 * short-circuit so two simultaneous causes yield two problems:
 * - an existing test file that is in neither the portable list nor the
 *   exclusion list (the fail-closed case this guard exists for);
 * - a file declared in both lists at the same time;
 * - an entry of either list that no longer exists on disk;
 * - an exclusion entry whose cause is outside the documented set;
 * - an exclusion entry listed more than once.
 * Every problem names the file and says in one sentence what to do to fix
 * it; the order is stable for the same input.
 */
export function portableCoverage(
  testFiles: readonly string[],
  portable: readonly string[],
  exclusions: readonly PortableExclusion[],
): string[] {
  const problems: string[] = [];
  const onDisk = new Set(testFiles);
  const excluded = new Set(exclusions.map((e) => e.file));
  for (const file of testFiles) {
    if (!portable.includes(file) && !excluded.has(file)) {
      problems.push(`portable-coverage: "${file}" exists but is in neither the portable list nor the exclusion list — add it to PORTABLE_TESTS or to PORTABLE_EXCLUSIONS with a documented cause`);
    }
  }
  for (const file of portable) {
    if (excluded.has(file)) {
      problems.push(`portable-coverage: "${file}" is declared in the portable list and in the exclusion list at the same time — pick one: run it on Windows or exclude it`);
    }
  }
  for (const file of portable) {
    if (!onDisk.has(file)) {
      problems.push(`portable-coverage: "${file}" is listed in the portable list but no longer exists in scripts/ — remove the entry or restore the file`);
    }
  }
  for (const entry of exclusions) {
    if (!onDisk.has(entry.file)) {
      problems.push(`portable-coverage: "${entry.file}" is listed as an exclusion but no longer exists in scripts/ — remove the entry or restore the file`);
    }
  }
  for (const entry of exclusions) {
    if (!Object.prototype.hasOwnProperty.call(PORTABLE_EXCLUSION_CAUSES, entry.cause)) {
      problems.push(`portable-coverage: "${entry.file}" declares cause "${entry.cause}" outside the documented set — use one of ${Object.keys(PORTABLE_EXCLUSION_CAUSES).join(", ")}`);
    }
  }
  const seen = new Set<string>();
  for (const entry of exclusions) {
    if (seen.has(entry.file)) {
      problems.push(`portable-coverage: "${entry.file}" is listed as an exclusion more than once — keep a single entry per file`);
    } else {
      seen.add(entry.file);
    }
  }
  return problems;
}
