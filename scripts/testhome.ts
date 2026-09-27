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
 * exit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

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
  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort: a leftover temp dir is harmless
    }
  });
}
