/**
 * P2-257: update reminder tests (apps/desktop/src/updateremind.ts) — the
 * portable twin of the unit.test.ts block. Pure node: no Electron, no
 * sockets, no chmod, no spawn; the only fs use is reading the real
 * updateremind.ts and main.ts sources for the purity/wiring assertions, via
 * URLs relative to this file (Windows-safe).
 * Run: npx tsx scripts/updateremind.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UPDATE_DOWNLOADED_TRAY_LABEL, UPDATE_REMIND_LIMITS, updateReminderPlan } from "../apps/desktop/src/updateremind";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const here = dirname(fileURLToPath(import.meta.url));

// --- the full rule table ---------------------------------------------------------
{
  const downloaded = { status: "update-downloaded", version: "0.3.0", harnessSession: false };
  const limits = { minIntervalMs: UPDATE_REMIND_LIMITS.minIntervalMs, maxPerVersion: UPDATE_REMIND_LIMITS.maxPerVersion };
  const now = 10_000_000_000;
  const oldOffer = { version: "0.3.0", at: now - limits.minIntervalMs - 1, count: 1 };

  // Rule 1: every state that is not "update-downloaded" waits — there is
  // nothing downloaded to apply.
  const nonDownloaded = [
    "disabled",
    "update-available",
    "update-available-manual",
    "update-installer-ready",
    "update-not-available",
    "unrecognized-feed",
    "feed-unreachable",
  ];
  for (const status of nonDownloaded) {
    const plan = updateReminderPlan({ status, version: null, harnessSession: false }, oldOffer, now, limits);
    check(`P2-257: state ${status} never reminds`, plan.action === "wait" && plan.reason === "state-not-downloaded");
  }
  // Rule order proven: state-not-downloaded AND an expired interval hold at
  // the same time — the state rule wins.
  const ruleOrder = updateReminderPlan({ status: "update-not-available", version: null, harnessSession: false }, oldOffer, now, limits);
  check(
    "P2-257: state rule beats an expired interval (rule order)",
    ruleOrder.action === "wait" && ruleOrder.reason === "state-not-downloaded",
  );
  // Rule 0 proven the same way: the harness-session rule is the FIRST decision.
  const harness = updateReminderPlan({ ...downloaded, harnessSession: true }, oldOffer, now, limits);
  check(
    "P2-257: harness session is the first decision of the path",
    harness.action === "wait" && harness.reason === "harness-session",
  );

  // Rule 2: a new version resets the count instead of inheriting it — even a
  // version whose cap was already reached reminds once the release changes.
  const inherited = updateReminderPlan(downloaded, { version: "0.2.9", at: now - 60_000, count: limits.maxPerVersion }, now, limits);
  check(
    "P2-257: a new version zeroes the count (cap of the old one not inherited)",
    inherited.action === "remind" && inherited.reason === "due",
  );

  // Rule 3: the per-version cap is respected.
  const atCap = updateReminderPlan(downloaded, { version: "0.3.0", at: now - limits.minIntervalMs - 1, count: limits.maxPerVersion }, now, limits);
  check("P2-257: cap reached never reminds", atCap.action === "wait" && atCap.reason === "cap-reached");
  const underCap = updateReminderPlan(downloaded, oldOffer, now, limits);
  check(
    "P2-257: one offer under the cap with the interval elapsed reminds",
    underCap.action === "remind" && underCap.reason === "due",
  );

  // Rule 4: the documented minimum interval, with the threshold explicit.
  const exactlyAtLimit = updateReminderPlan(downloaded, { version: "0.3.0", at: now - limits.minIntervalMs, count: 1 }, now, limits);
  check(
    "P2-257: offer exactly at the minimum interval (age === minIntervalMs) reminds",
    exactlyAtLimit.action === "remind",
  );
  const olderThanLimit = updateReminderPlan(
    downloaded,
    { version: "0.3.0", at: now - limits.minIntervalMs - 3_600_000, count: 1 },
    now,
    limits,
  );
  check("P2-257: offer older than the interval reminds", olderThanLimit.action === "remind");
  const newerThanLimit = updateReminderPlan(
    downloaded,
    { version: "0.3.0", at: now - limits.minIntervalMs + 1, count: 1 },
    now,
    limits,
  );
  check(
    "P2-257: offer newer than the interval waits",
    newerThanLimit.action === "wait" && newerThanLimit.reason === "interval-not-elapsed",
  );

  // Fail-closed edges.
  const future = updateReminderPlan(downloaded, { version: "0.3.0", at: now + 60_000, count: 1 }, now, limits);
  check(
    "P2-257: a future offer instant is treated as now (age never negative)",
    future.action === "wait" && future.reason === "interval-not-elapsed",
  );
  const nonFiniteNow = updateReminderPlan(downloaded, oldOffer, Number.NaN, limits);
  check(
    "P2-257: a non-finite current instant is refused, not guessed",
    nonFiniteNow.action === "wait" && nonFiniteNow.reason === "invalid-instant",
  );
  const textCount = updateReminderPlan(downloaded, { version: "0.3.0", at: now - limits.minIntervalMs - 1, count: "2" as unknown as number }, now, {
    ...limits,
    maxPerVersion: 2,
  });
  check("P2-257: a textual count is treated as zero", textCount.action === "remind");
  const negativeCount = updateReminderPlan(downloaded, { version: "0.3.0", at: now - limits.minIntervalMs - 1, count: -1 }, now, {
    ...limits,
    maxPerVersion: 0,
  });
  check(
    "P2-257: a negative count is normalized to zero before the cap check",
    negativeCount.action === "wait" && negativeCount.reason === "cap-reached",
  );

  // Determinism: the same inputs produce the same verdict twice.
  const first = updateReminderPlan(downloaded, oldOffer, now, limits);
  const second = updateReminderPlan(downloaded, oldOffer, now, limits);
  check("P2-257: same input → identical verdict in two calls", JSON.stringify(first) === JSON.stringify(second));
}

// --- the truthful tray label ------------------------------------------------------
{
  check(
    "P2-257: label says installation happens by accepting the offer",
    UPDATE_DOWNLOADED_TRAY_LABEL.includes("aceitar a oferta"),
  );
  check(
    "P2-257: label does not promise a plain restart",
    !UPDATE_DOWNLOADED_TRAY_LABEL.toLowerCase().includes("reinicie") &&
      !UPDATE_DOWNLOADED_TRAY_LABEL.toLowerCase().includes("reinicializa") &&
      !UPDATE_DOWNLOADED_TRAY_LABEL.toLowerCase().includes("restart"),
  );
  check(
    "P2-257: label carries no path, no address, no port and no secret",
    !UPDATE_DOWNLOADED_TRAY_LABEL.includes("/") &&
      !UPDATE_DOWNLOADED_TRAY_LABEL.includes("://") &&
      !UPDATE_DOWNLOADED_TRAY_LABEL.includes("127.") &&
      !UPDATE_DOWNLOADED_TRAY_LABEL.includes("localhost") &&
      !/\b\d{2,}\b/.test(UPDATE_DOWNLOADED_TRAY_LABEL) &&
      !/[A-Za-z0-9_]{24,}/.test(UPDATE_DOWNLOADED_TRAY_LABEL),
  );
}

// --- source hygiene and main.ts wiring --------------------------------------------
{
  const remindSrc = readFileSync(join(here, "..", "apps", "desktop", "src", "updateremind.ts"), "utf8");
  check(
    "P2-257: updateremind.ts stays pure — no electron, no node:fs, no fetch",
    !remindSrc.includes("from \"electron\"") && !remindSrc.includes("node:fs") && !remindSrc.includes("fetch("),
  );

  const mainSrc = readFileSync(join(here, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const reminderBlock = mainSrc.slice(
    mainSrc.indexOf("function scheduleUpdateReminder"),
    mainSrc.indexOf("async function offerUpdateReminderDialog"),
  );
  check(
    "P2-257: the reminder arms the SAME timer updateschedule.ts feeds — no new periodic timer",
    reminderBlock.includes("updateRecheckTimer = setTimeout(() => fireUpdateReminder()") &&
      !reminderBlock.includes("setInterval"),
  );
  check("P2-257: the reminder adds no IPC channel", !reminderBlock.includes("ipcMain"));

  const dialogStart = mainSrc.indexOf("async function offerUpdateReminderDialog");
  const askAt = mainSrc.indexOf("updateDialogSinks.askInstall", dialogStart);
  const harnessAt = mainSrc.indexOf("HERMETIC_E2E", dialogStart);
  check(
    "P2-257: the harness-session rule is evaluated before any dialog opening",
    dialogStart >= 0 && askAt > dialogStart && harnessAt > dialogStart && harnessAt < askAt,
  );

  const trayStart = mainSrc.indexOf("function trayMenuItems");
  const trayEnd = mainSrc.indexOf("function ", trayStart + 10);
  const traySrc = mainSrc.slice(trayStart, trayEnd);
  const markers = ["trayMenuLine", "Open OpenCode Remote", "Restart daemon", "Start at login", "Open logs folder", "Quit"];
  const positions = markers.map((m) => traySrc.indexOf(m));
  check(
    "P2-257: existing tray items keep their order",
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
  );
}

if (failures > 0) {
  console.error(`UPDATEREMIND TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("UPDATEREMIND TESTS PASSED");
process.exit(0);
