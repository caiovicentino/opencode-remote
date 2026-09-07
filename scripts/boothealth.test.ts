/**
 * P2-270: boot-health plan tests (apps/desktop/src/boothealth.ts) — the
 * portable twin of the unit.test.ts block. Pure node: no Electron, no
 * sockets, no chmod, no spawn; the only fs use is reading the real
 * boothealth.ts/main.ts sources for the hygiene and wiring assertions, via a
 * URL relative to this file (Windows-safe).
 * Run: npx tsx scripts/boothealth.test.ts
 */
import { readFileSync } from "node:fs";
import {
  bootHealthVerdict,
  BOOT_HEALTH_DIALOG_DETAIL,
  BOOT_HEALTH_DIALOG_MESSAGE,
  BOOT_HEALTH_DIALOG_TITLE,
  BOOT_HEALTH_BUTTON_CONTINUE,
  BOOT_HEALTH_BUTTON_DIAGNOSTIC,
  BOOT_HEALTH_OPENING_FLOOR,
  normalizeBootHealthRecord,
  type BootHealthRecord,
} from "../apps/desktop/src/boothealth";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const now = 1_700_000_000_000;
const json = (v: unknown) => JSON.stringify(v);
const noSlash = (s: string) => !s.includes("/") && !s.includes("://") && !s.includes("\\");
const rec = (over: Partial<BootHealthRecord> = {}): BootHealthRecord => ({
  lastSeenVersion: "1.2.0",
  lastHealthyVersion: "1.1.0",
  unmatchedOpenings: 0,
  lastOpeningAt: now,
  ...over,
});
const verdict = (over: Partial<Parameters<typeof bootHealthVerdict>[0]> = {}) =>
  bootHealthVerdict({
    harnessSession: false,
    runningVersion: "1.2.0",
    record: rec(),
    nowMs: now,
    floor: BOOT_HEALTH_OPENING_FLOOR,
    ...over,
  });

// --- the verdict table, in the documented rule order --------------------------------
{
  check(
    "harness: an active harness session is normal even with a count above the floor",
    verdict({ harnessSession: true, record: rec({ unmatchedOpenings: 99 }) }).verdict === "normal",
  );
  check(
    "rule order: an illegible record with a nominally high count is still normal",
    verdict({ record: { lastSeenVersion: "1.2.0", unmatchedOpenings: "99", lastOpeningAt: now } }).verdict === "normal" &&
      verdict({ record: "corrupt" }).verdict === "normal",
  );
  check(
    "absent, empty and non-object records are normal, never recuperar",
    ["", undefined, null, 42, [], {}].every((r) => verdict({ record: r }).verdict === "normal") &&
      verdict({ record: undefined }).count === 0,
  );
  const changed = verdict({
    record: rec({ lastSeenVersion: "1.1.0", lastHealthyVersion: "1.0.0", unmatchedOpenings: 99 }),
    runningVersion: "1.2.0",
  });
  check(
    "a changed version zeroes the count before any comparison",
    changed.verdict === "suspeito" && changed.count === 0,
  );
  check(
    "the already-healthy version is normal even with a high count",
    verdict({ record: rec({ lastHealthyVersion: "1.2.0", unmatchedOpenings: 99 }) }).verdict === "normal",
  );
  check(
    `a count exactly at the explicit floor (${BOOT_HEALTH_OPENING_FLOOR}) is recuperar`,
    verdict({ record: rec({ unmatchedOpenings: BOOT_HEALTH_OPENING_FLOOR, lastHealthyVersion: "1.0.0" }) }).verdict === "recuperar",
  );
  check(
    "one below the explicit floor is suspeito",
    verdict({ record: rec({ unmatchedOpenings: 3, lastHealthyVersion: "1.0.0" }), floor: 4 }).verdict === "suspeito" &&
      verdict({ record: rec({ unmatchedOpenings: 4, lastHealthyVersion: "1.0.0" }), floor: 4 }).verdict === "recuperar",
  );
  const future = verdict({ record: rec({ unmatchedOpenings: 99, lastOpeningAt: now + 60_000, lastHealthyVersion: "1.0.0" }) });
  check(
    "an opening instant in the future is treated as now (record usable, instant clamped)",
    future.verdict === "recuperar" && future.record?.lastOpeningAt === now,
  );
  check(
    "a non-finite current instant is refused instead of guessed",
    [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].every(
      (bad) => verdict({ nowMs: bad, record: rec({ unmatchedOpenings: 99 }) }).verdict === "normal",
    ),
  );
  check(
    "the same input in two calls yields an identical view",
    json(verdict({ record: rec({ unmatchedOpenings: 2 }) })) === json(verdict({ record: rec({ unmatchedOpenings: 2 }) })),
  );
}

// --- copy hygiene ---------------------------------------------------------------------
{
  const allViews = [
    verdict({ harnessSession: true }),
    verdict({ record: null }),
    verdict({ nowMs: Number.NaN }),
    verdict(),
    verdict({ record: rec({ lastHealthyVersion: "1.2.0", unmatchedOpenings: 99 }) }),
    verdict({ record: rec({ lastSeenVersion: "1.1.0" }), runningVersion: "1.2.0" }),
    verdict({ record: rec({ unmatchedOpenings: 99, lastHealthyVersion: "1.0.0" }) }),
  ];
  const allCopy = [
    ...allViews.flatMap((v) => [v.label, v.phrase]),
    BOOT_HEALTH_DIALOG_TITLE,
    BOOT_HEALTH_DIALOG_MESSAGE,
    BOOT_HEALTH_DIALOG_DETAIL,
    BOOT_HEALTH_BUTTON_DIAGNOSTIC,
    BOOT_HEALTH_BUTTON_CONTINUE,
  ];
  check(
    "every label and sentence is static, path-free, volume-free and secret-free",
    allCopy.every(
      (s) =>
        noSlash(s) &&
        !/[A-Za-z]:[\\/]/.test(s) &&
        !s.includes("localhost") &&
        !s.includes("127.0.0.1") &&
        !/Bearer|apiToken|token/i.test(s),
    ),
  );
  check(
    "every tray label fits inside the documented tray text budget (128)",
    allViews.every((v) => v.label.length <= 128 && v.phrase.length <= 128),
  );
}

// --- normalizeBootHealthRecord ---------------------------------------------------------
{
  check(
    "normalize keeps a valid record and drops everything else",
    json(normalizeBootHealthRecord(rec(), now)) === json(rec()) &&
      normalizeBootHealthRecord(undefined, now) === null &&
      normalizeBootHealthRecord("x", now) === null &&
      normalizeBootHealthRecord([], now) === null,
  );
}

// --- the real sources: module hygiene + main.ts wiring -----------------------------------
{
  const bootHealthSrc = readFileSync(new URL("../apps/desktop/src/boothealth.ts", import.meta.url), "utf8");
  check(
    "boothealth.ts imports no electron, node:fs nor node:path",
    !/^\s*import\b.*(?:electron|node:fs|node:path)/m.test(bootHealthSrc) && !bootHealthSrc.includes("require("),
  );
  const mainSrc = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  const verdictAt = mainSrc.indexOf("bootHealthVerdict({");
  const recDialogAt = mainSrc.indexOf("function showBootHealthRecoveryDialog");
  const recHarnessAt = mainSrc.indexOf("HERMETIC_E2E", recDialogAt);
  const recShowAt = mainSrc.indexOf("dialog.showMessageBox", recDialogAt);
  check(
    "wiring: the harness-session rule is evaluated before any dialog opening",
    verdictAt >= 0 && verdictAt < recDialogAt && recHarnessAt > recDialogAt && recHarnessAt < recShowAt,
  );
  const bootHealthLines = mainSrc
    .split("\n")
    .filter((l) => /BootHealth|bootHealth|boot-health|bootRecovery/.test(l));
  check(
    "wiring: no periodic timer in the boot-health lines",
    bootHealthLines.length > 0 && bootHealthLines.every((l) => !l.includes("setInterval") && !l.includes("setTimeout")),
  );
  const traySlice = mainSrc.slice(mainSrc.indexOf("function trayMenuItems"));
  const traySeq = [
    "trayMenuLine, enabled: false",
    "bootHealthAlarmLabel",
    '"Open OpenCode Remote"',
    '"Check for updates"',
    '"Restart daemon"',
    '"Start at login"',
    '"Open logs folder"',
    'label: "Quit"',
  ].map((needle) => traySlice.indexOf(needle));
  check(
    "wiring: the existing tray menu item order stayed unchanged",
    traySeq.every((idx) => idx >= 0) && traySeq.every((idx, i) => i === 0 || idx > traySeq[i - 1]),
  );
}

console.log(failures === 0 ? "\nboothealth tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
