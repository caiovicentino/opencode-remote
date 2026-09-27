/**
 * eval-11: the main-window load watch (apps/desktop/src/crash.ts MainLoadWatch)
 * and its wiring in main.ts.
 *
 * Chromium fires did-finish-load for its OWN error page right after a failed
 * main-frame load. Measured on Electron 44.2.0 with the real shell (hermetic
 * launch, OCR_WEB_URL pointing at a missing file:// and at a dead http port):
 *   did-start-loading → did-start-navigation(main) → did-fail-load(-6 / -312)
 *   → dom-ready → did-finish-load → did-stop-loading
 * main.ts used to treat that finish as a success: the P2-247 budget refilled on
 * every attempt (7 "tentando de novo" lines in 9s, never the give-up page) and
 * P2-270 promoted a version whose UI never loaded. The pure tracker is replayed
 * here against that exact sequence, then driven through loadFailVerdict the
 * way main.ts drives it, and the real main.ts source is checked for the wiring.
 *
 * Run: npx tsx scripts/loadwatch.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MainLoadWatch } from "../apps/desktop/src/crash";
import {
  CHROMIUM_ERR_ABORTED,
  LOAD_FAIL_MAX_ATTEMPTS,
  loadFailVerdict,
  sanitizeLoadFailure,
  type LoadFailPlan,
} from "../apps/desktop/src/loadfail";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const APP_URL = "file:///Applications/OpenCode%20Remote.app/Contents/Resources/web-dist/index.html";

// --- 1. the measured event sequence of ONE failed attempt -----------------------
{
  const w = new MainLoadWatch();
  w.navigationStarted(true, false);
  w.failureCounted(); // did-fail-load(-6), verdict "retry"
  check("error page finishing after a counted failure is NOT the app", w.finishedApp(APP_URL) === false);
  // the retry: a fresh cross-document navigation that succeeds
  w.navigationStarted(true, false);
  check("a successful retry finishing IS the app", w.finishedApp(APP_URL) === true);
}

// --- 2. what resets and what does not --------------------------------------------
{
  const w = new MainLoadWatch();
  check("a plain successful boot is the app", w.finishedApp(APP_URL) === true);
  w.failureCounted();
  w.navigationStarted(true, true); // hash route / pushState
  check("a same-document navigation does not clear a counted failure", w.finishedApp(APP_URL) === false);
  w.navigationStarted(false, false); // a subframe (artifact iframe, webview host frame)
  check("a subframe navigation does not clear a counted failure", w.finishedApp(APP_URL) === false);
  w.navigationStarted(true, false);
  check("a new main-frame document clears it", w.finishedApp(APP_URL) === true);
}

// --- 3. data: fallback pages never count ------------------------------------------
{
  const w = new MainLoadWatch();
  w.navigationStarted(true, false);
  check("the P2-247 give-up page (data:) is not the app", w.finishedApp("data:text/html,%3Cbody%3E…") === false);
  check("an uppercase DATA: scheme is not the app either", w.finishedApp("  DATA:text/html,x") === false);
  check("the dev server URL is the app", w.finishedApp("http://localhost:5173/") === true);
}

// --- 4. the P2-247 loop, driven the way main.ts drives it --------------------------
// Replays N failing attempts (each: start → fail → error-page finish) through
// the real verdict. main.ts resets the counter on did-finish-load only when the
// watch says the app finished. The loop must reach "giveup" after exactly
// LOAD_FAIL_MAX_ATTEMPTS retries — the old wiring reset on every error page and
// retried forever.
function driveFailingBoot(guarded: boolean, attempts: number): LoadFailPlan[] {
  const w = new MainLoadWatch();
  let count = 0;
  const plans: LoadFailPlan[] = [];
  for (let i = 0; i < attempts; i++) {
    w.navigationStarted(true, false);
    const record = sanitizeLoadFailure({ code: -6, description: "ERR_FILE_NOT_FOUND", address: APP_URL, isMainFrame: true });
    const verdict = loadFailVerdict(record, count, 1_000 * i);
    count = verdict.count;
    if (verdict.plan !== "ignore") w.failureCounted();
    plans.push(verdict.plan);
    if (verdict.plan === "giveup") break;
    // Chromium's error page finishes right after the failure.
    if (!guarded || w.finishedApp(APP_URL)) count = 0;
  }
  return plans;
}
{
  const fixed = driveFailingBoot(true, 10);
  check(
    `guarded wiring: ${LOAD_FAIL_MAX_ATTEMPTS} retries then give-up`,
    fixed.length === LOAD_FAIL_MAX_ATTEMPTS + 1 &&
      fixed.slice(0, LOAD_FAIL_MAX_ATTEMPTS).every((p) => p === "retry") &&
      fixed[LOAD_FAIL_MAX_ATTEMPTS] === "giveup",
  );
  const old = driveFailingBoot(false, 10);
  check("old wiring (reset on every finish) never gives up — the bug this guards", old.length === 10 && old.every((p) => p === "retry"));
}

// --- 5. an aborted navigation is not a counted failure ------------------------------
{
  const w = new MainLoadWatch();
  w.navigationStarted(true, false);
  const aborted = loadFailVerdict(
    sanitizeLoadFailure({ code: CHROMIUM_ERR_ABORTED, description: "ERR_ABORTED", address: APP_URL, isMainFrame: true }),
    0,
    0,
  );
  if (aborted.plan !== "ignore") w.failureCounted();
  check("ERR_ABORTED stays ignored, so the next finish still counts as the app", aborted.plan === "ignore" && w.finishedApp(APP_URL) === true);
}

// --- 6. the real main.ts wiring ------------------------------------------------------
{
  const main = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const createAt = main.indexOf("function createWindow(");
  const loadUiAt = main.indexOf("function loadUi(");
  const body = main.slice(createAt, loadUiAt);
  check("main.ts creates one MainLoadWatch per window", (body.match(/new MainLoadWatch\(\)/g) ?? []).length === 1);
  check(
    "main.ts feeds did-start-navigation with the main-frame and same-document flags",
    body.includes('win.webContents.on("did-start-navigation", (details) => {') &&
      body.includes("loadWatch.navigationStarted(details.isMainFrame, details.isSameDocument);"),
  );
  const failAt = body.indexOf('win.webContents.on("did-fail-load"');
  const countedAt = body.indexOf('if (verdict.plan !== "ignore") loadWatch.failureCounted();');
  check("main.ts marks every counted failure right after the verdict", countedAt > failAt && countedAt < body.indexOf('if (verdict.plan === "retry")'));
  const finishAt = body.indexOf('win.webContents.on("did-finish-load"');
  const guardAt = body.indexOf("if (!loadWatch.finishedApp(win.webContents.getURL())) return;", finishAt);
  check(
    "main.ts guards did-finish-load BEFORE the budget reset, the newChat flush and the boot-health promotion",
    guardAt > finishAt &&
      guardAt < body.indexOf("loadFailAttempts = 0;", finishAt) &&
      guardAt < body.indexOf("mainWindowLoaded = true;", finishAt) &&
      guardAt < body.indexOf("promoteHealthyOpening({", finishAt),
  );
}

// --- 7. a harness session's crash reports stay in its own userData ---------------------
// Gate runs used to drop "killed" renderer reports into the operator's real
// ~/.opencode-remote/pilot/client-logs, which the real app's diagnostic bundle
// then listed as its own crashes.
{
  const main = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  check(
    "crash reports: a harness session writes under its userData, the real app under client-logs",
    main.includes('return HERMETIC_E2E ? join(app.getPath("userData"), "client-logs") : clientLogsDir(homedir());'),
  );
  check(
    "crash reports: the writer and the diagnostic listing use the same folder",
    main.includes("writeCrashReport(crashReportsDir(),") && main.includes("readdirSync(crashReportsDir())") && !main.includes("writeCrashReport(clientLogsDir("),
  );
}

// --- 8. the dev URL override never reaches a packaged build ----------------------------
// OCR_WEB_URL used to load any URL into the shipped app's window (preload
// bridge included) and count that origin as the shell's own for permissions.
{
  const main = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  check(
    "dev URL: one helper, ignored when packaged",
    main.includes("return app.isPackaged ? undefined : process.env.OCR_WEB_URL;") && (main.match(/process\.env\.OCR_WEB_URL/g) ?? []).length === 1,
  );
  check(
    "dev URL: the window load and the permission context both go through it",
    main.includes("const devUrl = devWebUrl();") && main.includes("devUrl: devWebUrl(),"),
  );
}

console.log(failures === 0 ? "\nloadwatch: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
