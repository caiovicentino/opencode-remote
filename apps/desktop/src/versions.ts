// Pure daemon/app version-compat decision (P3-054). Kept free of electron
// imports so scripts/unit.test.ts can exercise it without booting Electron.
//
// Why: in the adopted-daemon mode (P1-053) the shell may talk to a daemon
// installed by launchd/an older app bundle. The symptom for a lay user is a
// random breakage (unknown IPC shapes, missing routes) that looks like a bug
// in the app. The shell already reads {healthy, version} from /api/health —
// this module turns the two versions into the single banner decision.

/** Semver core with tolerance: ignores any prerelease/build suffix, so
 * "1.2.3-dev", "1.2.3+build" and "1.2.3" all compare as 1.2.3. */
function parseSemver(v: string | null | undefined): { major: number; minor: number; patch: number } | null {
  if (!v) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * True when the shell (app) and the daemon are INCOMPATIBLE and the UI must
 * show the non-blocking "restart the daemon" banner. The rule mirrors the
 * daemon protocol guarantee — same major and the daemon not older than the
 * app is compatible:
 *
 *   app 1.2.3 / daemon 1.2.3 → false (equal)
 *   app 1.2.3 / daemon 1.3.0 → false (daemon minor ahead: additive, fine)
 *   app 1.2.3 / daemon 1.1.9 → true  (daemon older than the app)
 *   app 1.2.3 / daemon 2.0.0 → true  (different major, either direction)
 *
 * Unknown/unparseable versions (dev builds without semver, a daemon that
 * predates the field) never flag — a false positive nags every healthy
 * user, a false negative only misses a corner case the log still records.
 */
export function versionMismatch(appV: string | null | undefined, daemonV: string | null | undefined): boolean {
  const app = parseSemver(appV);
  const daemon = parseSemver(daemonV);
  if (!app || !daemon) return false;
  if (app.major !== daemon.major) return true;
  // Same major: the daemon must not be older than the app (lexicographic on
  // minor/patch — safe because both sides are non-negative numbers).
  if (daemon.minor !== app.minor) return daemon.minor < app.minor;
  return daemon.patch < app.patch;
}
