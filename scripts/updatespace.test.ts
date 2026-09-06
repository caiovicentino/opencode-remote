/**
 * P2-264: disk-space gate tests (apps/desktop/src/updatespace.ts) — the
 * portable twin of the unit.test.ts block. Pure node: no Electron, no
 * sockets, no chmod, no spawn; the only fs use is reading the real
 * updatespace.ts and main.ts sources for the purity/wiring assertions, via
 * URLs relative to this file (Windows-safe).
 * Run: npx tsx scripts/updatespace.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRAY_TIP_MAX_CHARS } from "../apps/desktop/src/traystatus";
import {
  UPDATE_SPACE_FLOOR_BYTES,
  UPDATE_SPACE_HEADROOM_BYTES,
  UPDATE_SPACE_LABEL_DOWNLOAD,
  UPDATE_SPACE_LABEL_POSTPONED,
  UPDATE_SPACE_LABEL_POSTPONED_UNKNOWN,
  UPDATE_SPACE_LABEL_SIZE_UNKNOWN,
  UPDATE_SPACE_LABEL_WARN,
  UPDATE_SPACE_LIMITS,
  UPDATE_SPACE_SIZE_MULTIPLIER,
  updateSpaceVerdict,
} from "../apps/desktop/src/updatespace";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const here = dirname(fileURLToPath(import.meta.url));

// --- the full rule table ---------------------------------------------------------
{
  const limits = { sizeMultiplier: UPDATE_SPACE_LIMITS.sizeMultiplier, headroomBytes: UPDATE_SPACE_LIMITS.headroomBytes };
  const size = 500_000_000; // 500 MB announced release
  // The threshold, explicit: necessary = size × multiplier + headroom.
  const necessary = size * UPDATE_SPACE_SIZE_MULTIPLIER + UPDATE_SPACE_HEADROOM_BYTES;

  // Rule 1: free bytes that are absent, text, non-finite or negative postpone
  // fail-closed — downloading without knowing is exactly what breaks today.
  const badFree: unknown[] = [null, undefined, "500000000", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1];
  for (const free of badFree) {
    const view = updateSpaceVerdict(free as number, size, limits);
    check(
      `P2-264: free bytes ${String(free)} → postpone (fail-closed)`,
      view.verdict === "postpone" && view.reason === "invalid-free-bytes" && view.label === UPDATE_SPACE_LABEL_POSTPONED_UNKNOWN,
    );
  }

  // Rule 2: an announced size that is absent or <= 0 warns and NEVER
  // postpones for the missing size alone — the feed may omit the size and
  // refusing for that would stop the whole product. With roomy free space
  // (above the documented conservative floor) the verdict is warn.
  const roomyFree = 10_000_000_000; // 10 GB — above the 2 GB floor
  const badSizes: unknown[] = [null, undefined, 0, -1, "500000000", Number.NaN, Number.POSITIVE_INFINITY];
  for (const announced of badSizes) {
    const view = updateSpaceVerdict(roomyFree, announced as number, limits);
    check(
      `P2-264: announced size ${String(announced)} → warn (never refuse the update)`,
      view.verdict === "warn" && view.reason === "invalid-release-size" && view.label === UPDATE_SPACE_LABEL_SIZE_UNKNOWN,
    );
  }
  // Rule 2's floor exception (the verified round-2 finding): a release that
  // does not announce its size on a disk below the conservative floor is the
  // exact blind download this gate exists to stop — it postpones.
  const belowFloor = updateSpaceVerdict(UPDATE_SPACE_FLOOR_BYTES - 1, null, limits);
  check(
    "P2-264: unknown size below the conservative floor postpones (no blind download)",
    belowFloor.verdict === "postpone" && belowFloor.reason === "unknown-size-low-space" && belowFloor.label === UPDATE_SPACE_LABEL_POSTPONED,
  );
  const atFloor = updateSpaceVerdict(UPDATE_SPACE_FLOOR_BYTES, null, limits);
  check(
    "P2-264: unknown size exactly at the conservative floor warns (free >= floor proceeds)",
    atFloor.verdict === "warn" && atFloor.reason === "invalid-release-size",
  );
  // The floor governs the UNKNOWN-size case only: a release whose size is
  // announced is judged by rules 3–5 alone — a proven fit downloads even
  // below the floor.
  const provenFit = updateSpaceVerdict(UPDATE_SPACE_FLOOR_BYTES - 100_000_000, size, limits);
  check(
    "P2-264: a known size that provably fits downloads even below the conservative floor",
    provenFit.verdict === "download" && provenFit.reason === "enough-space",
  );

  // Rule 3 with the threshold explicit: free exactly AT the necessary is not
  // below it (warn band); one byte below postpones.
  const atThreshold = updateSpaceVerdict(necessary, size, limits);
  check(
    "P2-264: free exactly at the necessary (size × multiplier + headroom) is NOT postponed",
    atThreshold.verdict === "warn" && atThreshold.reason === "low-space-warning",
  );
  const oneByteBelow = updateSpaceVerdict(necessary - 1, size, limits);
  check(
    "P2-264: one byte below the necessary postpones",
    oneByteBelow.verdict === "postpone" && oneByteBelow.reason === "insufficient-space" && oneByteBelow.label === UPDATE_SPACE_LABEL_POSTPONED,
  );
  const halfWay = updateSpaceVerdict(size + UPDATE_SPACE_HEADROOM_BYTES + 1, size, limits);
  check("P2-264: free above the plain size but below size × multiplier postpones", halfWay.verdict === "postpone");

  // Rule 4: inside the warning headroom above the necessary → warn.
  const inBand = updateSpaceVerdict(necessary + 1, size, limits);
  check(
    "P2-264: free above the necessary but inside the warning headroom warns",
    inBand.verdict === "warn" && inBand.reason === "low-space-warning" && inBand.label === UPDATE_SPACE_LABEL_WARN,
  );
  // Rule 5: at the end of the warning band and comfortably above → download.
  const atBandEnd = updateSpaceVerdict(necessary + UPDATE_SPACE_HEADROOM_BYTES, size, limits);
  check(
    "P2-264: free at the end of the warning band downloads",
    atBandEnd.verdict === "download" && atBandEnd.reason === "enough-space" && atBandEnd.label === UPDATE_SPACE_LABEL_DOWNLOAD,
  );
  const roomy = updateSpaceVerdict(necessary * 4, size, limits);
  check("P2-264: comfortable free space downloads", roomy.verdict === "download");

  // Rule order proven: non-finite free bytes AND an absent announced size at
  // the same time — the free-bytes rule wins and the result is postpone.
  const order = updateSpaceVerdict(Number.NaN, null, limits);
  check(
    "P2-264: invalid free bytes beat an absent size (rule order)",
    order.verdict === "postpone" && order.reason === "invalid-free-bytes",
  );

  // Determinism: same input → identical verdict in two calls.
  const first = updateSpaceVerdict(necessary, size, limits);
  const second = updateSpaceVerdict(necessary, size, limits);
  check("P2-264: same input → identical verdict in two calls", JSON.stringify(first) === JSON.stringify(second));

  // Label hygiene: every reason's label is static, carries no path, no volume
  // name, no address, no port and no secret, and fits the documented tray
  // text budget.
  const views = [
    updateSpaceVerdict(null, size, limits),
    updateSpaceVerdict(roomyFree, null, limits),
    updateSpaceVerdict(UPDATE_SPACE_FLOOR_BYTES - 1, null, limits),
    updateSpaceVerdict(necessary - 1, size, limits),
    updateSpaceVerdict(necessary + 1, size, limits),
    updateSpaceVerdict(necessary * 4, size, limits),
  ];
  for (const view of views) {
    const clean =
      !view.label.includes("/") &&
      !view.label.includes("://") &&
      !view.label.includes("127.") &&
      !view.label.includes("localhost") &&
      !view.label.includes("Macintosh") &&
      !view.label.includes("HD") &&
      !/[A-Za-z0-9_]{24,}/.test(view.label) &&
      view.label.length <= TRAY_TIP_MAX_CHARS;
    check(`P2-264: "${view.label}" is static, volume-free and secret-free within the tray budget`, clean);
  }

  // The documented constants themselves.
  check("P2-264: the documented multiplier is 2 (package + unpacked copy)", UPDATE_SPACE_SIZE_MULTIPLIER === 2);
  check(
    "P2-264: the documented headroom is positive and finite",
    Number.isFinite(UPDATE_SPACE_HEADROOM_BYTES) && UPDATE_SPACE_HEADROOM_BYTES > 0,
  );
  check(
    "P2-264: the documented conservative floor is the daemon's 2 GB warn threshold",
    UPDATE_SPACE_FLOOR_BYTES === 2_000_000_000,
  );
}

// --- source hygiene and main.ts wiring --------------------------------------------
{
  const spaceSrc = readFileSync(join(here, "..", "apps", "desktop", "src", "updatespace.ts"), "utf8");
  check(
    "P2-264: updatespace.ts stays pure — no electron, no node:fs, no fetch",
    !spaceSrc.includes("from \"electron\"") && !spaceSrc.includes("node:fs") && !spaceSrc.includes("fetch("),
  );
  check("P2-264: the harness-session reason is documented in the module header", spaceSrc.includes("OCR_DESKTOP_SESSION"));

  const mainSrc = readFileSync(join(here, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const blockStart = mainSrc.indexOf("disk-space gate for the scheduled update (P2-264)");
  const blockEnd = mainSrc.indexOf("deferred-update reminder (P2-257)");
  const block = blockStart >= 0 && blockEnd > blockStart ? mainSrc.slice(blockStart, blockEnd) : "";
  check("P2-264: main.ts has the disk-space gate block", blockStart >= 0 && blockEnd > blockStart);
  check(
    "P2-264: the gate reads the real free space exactly once per decision (one statfsSync)",
    block.includes("statfsSync") && (block.match(/statfsSync/g) ?? []).length === 1,
  );
  check(
    "P2-264: the gate block opens no window, dialog or focus — nothing for the harness rule to gate",
    block.length > 0 &&
      !block.includes("dialog.") &&
      !block.includes("shell.") &&
      !block.includes("showMainWindow") &&
      !block.includes("new BrowserWindow") &&
      !block.includes("openExternal"),
  );
  check(
    "P2-264: the gate block adds no timer and no IPC channel",
    block.length > 0 && !block.includes("setTimeout") && !block.includes("setInterval") && !block.includes("ipcMain"),
  );
  check(
    "P2-264: no new periodic timer in main.ts (the two pre-existing setInterval calls stay alone)",
    (mainSrc.match(/setInterval/g) ?? []).length === 2,
  );
  check(
    "P2-264: the gate is consulted before any check for updates is started in runUpdateCheck",
    mainSrc.indexOf("updateSpaceGateSkip()") > 0 &&
      mainSrc.indexOf("updateSpaceGateSkip()") < mainSrc.indexOf("void checkForUpdatesOnBoot({"),
  );

  const trayStart = mainSrc.indexOf("function trayMenuItems");
  const trayEnd = mainSrc.indexOf("function ", trayStart + 10);
  const traySrc = mainSrc.slice(trayStart, trayEnd);
  const markers = ["trayMenuLine", "Open OpenCode Remote", "Check for updates", "Restart daemon", "Start at login", "Open logs folder", "Quit"];
  const positions = markers.map((m) => traySrc.indexOf(m));
  check(
    "P2-264: existing tray items keep their order",
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
  );
}

if (failures > 0) {
  console.error(`UPDATESPACE TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("UPDATESPACE TESTS PASSED");
process.exit(0);
