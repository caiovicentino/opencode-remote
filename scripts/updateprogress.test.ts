/**
 * P2-258: update download progress tests (apps/desktop/src/updateprogress.ts)
 * — the portable twin of the unit.test.ts block. Pure node: no Electron, no
 * sockets, no chmod, no spawn; the only fs use is reading the real
 * updateprogress.ts and main.ts sources for the purity/wiring assertions, via
 * URLs relative to this file (Windows-safe).
 * Run: npx tsx scripts/updateprogress.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRAY_TIP_MAX_CHARS } from "../apps/desktop/src/traystatus";
import {
  UPDATE_PROGRESS_LABEL_DOWNLOADING,
  UPDATE_PROGRESS_LABEL_STUCK,
  UPDATE_PROGRESS_LIMITS,
  updateProgressView,
} from "../apps/desktop/src/updateprogress";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const here = dirname(fileURLToPath(import.meta.url));

// --- the full rule table ---------------------------------------------------------
{
  const limits = { silenceMs: UPDATE_PROGRESS_LIMITS.silenceMs };
  const now = 10_000_000_000;
  const live = now - 1_000;

  // Rule 2: a total that is absent, zero, text or non-finite is unknown
  // progress with a number-free label — never an invented percentage.
  const badTotals: unknown[] = [undefined, 0, -5, "900", Number.NaN, Number.POSITIVE_INFINITY];
  for (const total of badTotals) {
    const view = updateProgressView(100, total as number, live, now, limits);
    check(
      `P2-258: total ${String(total)} → unknown with number-free label`,
      view.verdict === "unknown" && view.label === UPDATE_PROGRESS_LABEL_DOWNLOADING && view.percent === null && !view.label.includes("%"),
    );
  }

  // Rule 3: non-finite or negative bytes are treated as zero.
  for (const bytes of [Number.NaN, Number.NEGATIVE_INFINITY, -1]) {
    const view = updateProgressView(bytes, 1000, live, now, limits);
    check(
      `P2-258: bytes ${String(bytes)} treated as zero`,
      view.verdict === "downloading" && view.percent === 0 && view.label === `${UPDATE_PROGRESS_LABEL_DOWNLOADING} 0%`,
    );
  }

  // Rule 4: bytes above the total cap at one hundred percent, never beyond.
  const over = updateProgressView(1500, 1000, live, now, limits);
  check(
    "P2-258: bytes above the total cap at 100%",
    over.verdict === "downloading" && over.percent === 100 && over.label === `${UPDATE_PROGRESS_LABEL_DOWNLOADING} 100%`,
  );

  // Distinct labels for 0%, an intermediate value and 100%.
  const zero = updateProgressView(0, 1000, live, now, limits);
  const mid = updateProgressView(420, 1000, live, now, limits);
  const full = updateProgressView(1000, 1000, live, now, limits);
  check(
    "P2-258: 0%, intermediate and 100% carry three distinct labels",
    zero.label === `${UPDATE_PROGRESS_LABEL_DOWNLOADING} 0%` &&
      mid.label === `${UPDATE_PROGRESS_LABEL_DOWNLOADING} 42%` &&
      full.label === `${UPDATE_PROGRESS_LABEL_DOWNLOADING} 100%` &&
      new Set([zero.label, mid.label, full.label]).size === 3,
  );

  // Rule 1 with the threshold explicit: silence exactly at the documented
  // limit is still downloading; silence above it is stuck.
  const silence = 1_000;
  const atLimit = updateProgressView(300, 1000, now - silence, now, { silenceMs: silence });
  check(
    "P2-258: silence exactly at the documented limit is NOT stuck (age === silenceMs)",
    atLimit.verdict === "downloading",
  );
  const aboveLimit = updateProgressView(300, 1000, now - silence - 1, now, { silenceMs: silence });
  check(
    "P2-258: silence above the documented limit is stuck",
    aboveLimit.verdict === "stuck" && aboveLimit.label === UPDATE_PROGRESS_LABEL_STUCK && aboveLimit.percent === null,
  );
  const realLimits = updateProgressView(300, 1000, now - UPDATE_PROGRESS_LIMITS.silenceMs - 1, now, limits);
  check("P2-258: stuck also fires with the real documented limit", realLimits.verdict === "stuck");

  // Rule order proven: silence above the limit AND a high percentage hold at
  // the same time — stuck wins, a download stopped at ninety percent is still
  // stopped.
  const order = updateProgressView(900, 1000, now - silence - 1, now, { silenceMs: silence });
  check("P2-258: silence beats a high percentage (rule order)", order.verdict === "stuck" && order.label === UPDATE_PROGRESS_LABEL_STUCK);

  // Rule 6: an instant in the future is treated as now — the age is never
  // negative, so the verdict is the live download, not an error.
  const future = updateProgressView(500, 1000, now + 60_000, now, limits);
  check("P2-258: a future last-progress instant is treated as now", future.verdict === "downloading" && future.percent === 50);

  // Rule 5: a non-finite instant is refused instead of guessed.
  const nonFiniteNow = updateProgressView(500, 1000, live, Number.NaN, limits);
  check(
    "P2-258: a non-finite current instant is refused",
    nonFiniteNow.verdict === "unknown" && nonFiniteNow.reason === "invalid-instant",
  );
  const nonFiniteAt = updateProgressView(500, 1000, Number.POSITIVE_INFINITY, now, limits);
  check(
    "P2-258: a non-finite last-progress instant is refused too",
    nonFiniteAt.verdict === "unknown" && nonFiniteAt.reason === "invalid-instant",
  );

  // Determinism: the same inputs produce the same view twice.
  const first = updateProgressView(420, 1000, live, now, limits);
  const second = updateProgressView(420, 1000, live, now, limits);
  check("P2-258: same input → identical verdict in two calls", JSON.stringify(first) === JSON.stringify(second));

  // Label hygiene: every verdict's label is static, carries no path, no
  // address, no port, no feed URL and no secret, and fits the documented
  // tray text budget.
  const views = [
    updateProgressView(0, 1000, live, now, limits),
    updateProgressView(420, 1000, live, now, limits),
    updateProgressView(1000, 1000, live, now, limits),
    updateProgressView(100, undefined as unknown as number, live, now, limits),
    updateProgressView(900, 1000, now - silence - 1, now, { silenceMs: silence }),
  ];
  for (const view of views) {
    const clean =
      !view.label.includes("/") &&
      !view.label.includes("://") &&
      !view.label.includes("127.") &&
      !view.label.includes("localhost") &&
      !/[A-Za-z0-9_]{24,}/.test(view.label) &&
      view.label.length <= TRAY_TIP_MAX_CHARS;
    check(`P2-258: "${view.label}" is static and secret-free within the tray budget`, clean);
  }
}

// --- source hygiene and main.ts wiring --------------------------------------------
{
  const progressSrc = readFileSync(join(here, "..", "apps", "desktop", "src", "updateprogress.ts"), "utf8");
  check(
    "P2-258: updateprogress.ts stays pure — no electron, no node:fs, no fetch",
    !progressSrc.includes("from \"electron\"") && !progressSrc.includes("node:fs") && !progressSrc.includes("fetch("),
  );
  check(
    "P2-258: the harness-session reason is documented in the module header",
    progressSrc.includes("OCR_DESKTOP_SESSION"),
  );

  const updateSrc = readFileSync(join(here, "..", "apps", "desktop", "src", "update.ts"), "utf8");
  check(
    "P2-258: update.ts forwards the updater's own download-progress event to the injected sink, exactly once",
    (updateSrc.match(/updater\.on\("download-progress"/g) ?? []).length === 1 && updateSrc.includes("hooks.onProgress?.(info)"),
  );

  const mainSrc = readFileSync(join(here, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const blockStart = mainSrc.indexOf("download progress in the tray (P2-258)");
  const blockEnd = mainSrc.indexOf("deferred-update reminder (P2-257)");
  const block = blockStart >= 0 && blockEnd > blockStart ? mainSrc.slice(blockStart, blockEnd) : "";
  check("P2-258: main.ts has the progress wiring block", blockStart >= 0 && blockEnd > blockStart);
  check(
    "P2-258: the progress block opens no window, dialog or focus — nothing for the harness rule to gate",
    block.length > 0 &&
      !block.includes("dialog.") &&
      !block.includes("shell.") &&
      !block.includes("showMainWindow") &&
      !block.includes("new BrowserWindow") &&
      !block.includes("openExternal"),
  );
  check(
    "P2-258: the progress block adds no timer and no IPC channel",
    block.length > 0 && !block.includes("setTimeout") && !block.includes("setInterval") && !block.includes("ipcMain"),
  );
  check(
    "P2-258: no new periodic timer in main.ts (the two pre-existing setInterval calls stay alone)",
    (mainSrc.match(/setInterval/g) ?? []).length === 2,
  );
  check(
    "P2-258: the stalled verdict is evaluated on the SAME tick updateschedule.ts feeds",
    mainSrc.includes("evaluateUpdateProgressSilence();\n    runUpdateCheck(\"scheduled\")"),
  );

  const trayStart = mainSrc.indexOf("function trayMenuItems");
  const trayEnd = mainSrc.indexOf("function ", trayStart + 10);
  const traySrc = mainSrc.slice(trayStart, trayEnd);
  const markers = ["trayMenuLine", "Open OpenCode Remote", "Check for updates", "Restart daemon", "Start at login", "Open logs folder", "Quit"];
  const positions = markers.map((m) => traySrc.indexOf(m));
  check(
    "P2-258: existing tray items keep their order",
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
  );
}

if (failures > 0) {
  console.error(`UPDATEPROGRESS TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("UPDATEPROGRESS TESTS PASSED");
process.exit(0);
