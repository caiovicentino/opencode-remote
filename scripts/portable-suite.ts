/**
 * P2-224: portable (Windows-safe) subset of the unit test battery.
 *
 * The CI battery only ever ran on ubuntu-latest, so every module that decides
 * about paths — apps/relay/src/webroot.ts, apps/desktop/src/installloc.ts,
 * apps/desktop/src/loginitem.ts, apps/desktop/src/desktop-log.ts, the
 * logsDirPath of apps/desktop/src/tray.ts, apps/desktop/src/sidecar-log.ts,
 * scripts/ci-scope.ts and apps/desktop/src/versions.ts — was exercised only
 * against the POSIX separator. A separator/normalization/backslash regression
 * therefore surfaced on the machine of a non-technical user, after the signed
 * installer was already published (stages 3 and 5 of docs/VISION.md). The
 * verify-win CI job runs this suite on windows-latest for every PR that
 * touches the desktop surface; locally: `npm run test:unit-win`.
 *
 * Exclusion criteria — why a test file is NOT in PORTABLE_TESTS:
 * - Electron: the shell tests (desktop-flow, desktop-render, desktop-crash,
 *   desktop-update e2e half) boot the real app and are driven by the desktop
 *   harness, not by plain node.
 * - unix socket: localws.test.ts binds a \\.\pipe/ unix socket pair for the
 *   daemon local channel; Windows pipes need a different address shape.
 * - chmod: dist-smoke.test.ts chmods a packaged binary (0o755) — POSIX-only
 *   semantics.
 * - long-lived child process: preview.test.ts, message-paging.test.ts,
 *   relay-ratelimit/ipcap/rooms/liveness, pwa-watch, e2e-orphans,
 *   release-preflight, electron-vuln and desktop-update spawn the relay, the
 *   daemon or a CLI and keep it running across many assertions — CI sockets
 *   and process trees the windows runner should not juggle twice.
 * - network port: unit.test.ts itself (the king of the battery) boots http/ws
 *   servers, connects raw sockets, creates symlinks and spawns processes;
 *   context-checkpoint and relay-healthz listen on 127.0.0.1.
 * - symlink: artifact-auto.test.ts creates directory symlinks, which on
 *   Windows require developer mode or admin rights.
 *
 * Everything listed below is pure node: fs, os and path only — no Electron,
 * no socket, no chmod, no spawn, no listen — so the same files pass on any
 * OS and double as the portable path-logic regression net.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PORTABLE_EXCLUSIONS, portableCoverage } from "./portablecoverage";

export const PORTABLE_TESTS: readonly string[] = [
  "bubble-merge.test.ts",
  "client-ready.test.ts",
  "composer.test.ts",
  "desktop-log.test.ts",
  "gpuplan.test.ts",
  "home.test.ts",
  "i18n-emoji.test.ts",
  "idempotency.test.ts",
  "instances.test.ts",
  "loadfail.test.ts",
  "permission-cards.test.ts",
  "qr-feed.test.ts",
  "relay-backoff.test.ts",
  "relay-knobnames.test.ts",
  "release-watch.test.ts",
  "sidecar-log.test.ts",
  "thinking.test.ts",
  "traystatus.test.ts",
  "updateremind.test.ts",
  "updateprogress.test.ts",
  "updatespace.test.ts",
  "voice.test.ts",
];

/**
 * Validate a portable-suite list, returning one problem per cause in the
 * established problems format (a plain string[] a caller can print or count):
 * - an entry that does not end in .test.ts;
 * - an entry that is not a bare file name inside scripts/ (path separators,
 *   .. segments, absolute paths);
 * - an entry listed more than once;
 * - an empty list (the Windows battery would silently run nothing).
 * Per entry the checks run in that order, entries in list order — two
 * simultaneous causes yield two problems, not one merged verdict.
 */
export function portableSuitePlan(files: readonly string[]): string[] {
  const problems: string[] = [];
  if (files.length === 0) {
    problems.push("portable-suite: list is empty — the Windows battery would run nothing and silently pass");
    return problems;
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".test.ts")) {
      problems.push(`portable-suite: "${file}" does not end in .test.ts — only test files belong in the list`);
    }
    if (file.includes("/") || file.includes("\\") || /^[A-Za-z]:/.test(file) || file === "." || file === "..") {
      problems.push(`portable-suite: "${file}" is outside scripts/ — entries are bare file names resolved against the scripts directory`);
    }
    if (seen.has(file)) {
      problems.push(`portable-suite: "${file}" is listed twice — a duplicate would run twice`);
    } else {
      seen.add(file);
    }
  }
  return problems;
}

function cli(): number {
  const problems = portableSuitePlan(PORTABLE_TESTS);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error("portable-suite: FAIL — the list itself is invalid");
    return 1;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // P2-237: fail-closed coverage guard — every .test.ts file actually in
  // scripts/ (from a directory read, never a second hand-written list) must
  // be either in PORTABLE_TESTS or declared in PORTABLE_EXCLUSIONS with a
  // documented cause. Runs before any test is executed.
  const onDisk = readdirSync(here).filter((f) => f.endsWith(".test.ts")).sort();
  const coverageProblems = portableCoverage(onDisk, PORTABLE_TESTS, PORTABLE_EXCLUSIONS);
  if (coverageProblems.length > 0) {
    for (const problem of coverageProblems) console.error(problem);
    console.error("portable-suite: FAIL — a test file is outside the portable list and the exclusion list");
    return 1;
  }
  const repoRoot = resolve(here, "..");
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  for (const file of PORTABLE_TESTS) {
    const full = join(here, file);
    if (!existsSync(full)) {
      console.error(`portable-suite: FAIL ${file} — file missing on disk`);
      return 1;
    }
    console.log(`portable-suite: run ${file}`);
    const res = spawnSync(process.execPath, [tsxEntry, full], { cwd: repoRoot, stdio: "inherit" });
    if (res.status !== 0) {
      console.error(`portable-suite: FAIL ${file}`);
      return 1;
    }
  }
  console.log(`portable-suite: OK ${PORTABLE_TESTS.length} file(s)`);
  return 0;
}

// CLI guard: run the suite only when executed directly (same pattern as
// scripts/ci-scope.ts) — importing the module must stay side-effect free.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) process.exit(cli());
