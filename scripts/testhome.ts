/**
 * Throwaway HOME for test suites — import it FIRST (before any app module).
 *
 * Pilot, daemon and desktop modules resolve `~/.opencode-remote` from
 * `homedir()` when they load (state.json, heartbeat, daemon.json, logs…). A
 * suite that imports them under the owner's real HOME — which is how every
 * pilot gate run and every local `npm run test:unit` on the host executes —
 * reaches the production runtime: on 2026-09-27 `runDoctor()` in
 * unit.test.ts normalized and rewrote the live pilot state.json (lessonImpact
 * zeroed, the *Last nightly guards dropped) and the battery refreshed the
 * dead pilot's heartbeat, making it look alive.
 *
 * ES modules evaluate in import order, so a side-effect import placed above
 * every other import points HOME (and USERPROFILE on Windows) at a fresh
 * temp directory before any app module computes its paths. Child processes
 * inherit it. Caches that legitimately live under the real home (Playwright
 * browsers) stay reachable through their env overrides. Nested imports
 * reuse the first sandbox (OCR_TEST_HOME), and the directory is removed on
 * exit. On POSIX it also puts a PATH shim first: read-only `launchctl`
 * verbs pass through, mutating ones (kickstart, bootout, stop…) and
 * pkill/killall are refused — launchd is per user, not per HOME.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Read-only launchctl verbs a test may still run against the real launchd. */
export const TESTHOME_LAUNCHCTL_READ_VERBS = ["print", "list", "print-disabled", "blame", "version", "help"] as const;
/** Marker every refusal prints on stderr (tests assert on it). */
export const TESTHOME_REFUSAL = "testhome: refusing";

if (!process.env.OCR_TEST_HOME) {
  const realHome = homedir();
  // os.tmpdir() carries no trailing separator, so HOME never contains "//"
  // (tests compare resolved paths against HOME).
  const home = mkdtempSync(join(tmpdir(), "ocr-test-home-"));
  process.env.OCR_TEST_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const os = platform();
    process.env.PLAYWRIGHT_BROWSERS_PATH =
      os === "darwin"
        ? join(realHome, "Library", "Caches", "ms-playwright")
        : os === "win32"
          ? join(process.env.LOCALAPPDATA ?? join(realHome, "AppData", "Local"), "ms-playwright")
          : join(process.env.XDG_CACHE_HOME ?? join(realHome, ".cache"), "ms-playwright");
  }
  // launchd is per USER, not per HOME: a suite that falls through to deploy
  // code (apps/pilot/src/deploy.ts kickstart → `launchctl kickstart -k
  // gui/<uid>/com.ocr.*`) restarts the owner's REAL relay/daemon — it did,
  // twice, on 2026-09-27 at 12:56. unit.test.ts calls deploy() with the real
  // exec and relies on its guards refusing first, so one guard regression
  // would do it again from any gate run. A PATH shim (exec's shell resolves
  // commands through PATH) lets read-only launchctl verbs through and
  // refuses mutating verbs and pattern kills, loudly.
  if (platform() !== "win32") {
    const bin = join(home, ".ocr-test-bin");
    mkdirSync(bin, { recursive: true });
    const refuse = (tool: string) =>
      `#!/bin/sh\necho "${TESTHOME_REFUSAL} '${tool} $*' under test — inject a fake runner" >&2\nexit 1\n`;
    writeFileSync(
      join(bin, "launchctl"),
      `#!/bin/sh\ncase "$1" in ${TESTHOME_LAUNCHCTL_READ_VERBS.join("|")}) exec /bin/launchctl "$@";; esac\n` +
        refuse("launchctl").replace("#!/bin/sh\n", ""),
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "pkill"), refuse("pkill"), { mode: 0o755 });
    writeFileSync(join(bin, "killall"), refuse("killall"), { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  }
  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort: a leftover temp dir is harmless
    }
  });
}
