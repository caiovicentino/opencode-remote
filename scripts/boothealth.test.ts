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
import {
  bootHealthRecordFile,
  markOpeningInProgress,
  promoteHealthyOpening,
  readBootHealthRecord,
  readOwnerRelease,
  writeOwnerRelease,
  type BootHealthFs,
  type StoredBootHealthRecord,
} from "../apps/desktop/src/boothealthstore";
import { updateGuard } from "../apps/desktop/src/updateguard";
import { updateGuardReleaseLabel } from "../apps/desktop/src/tray";

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

// --- P2-291: the update guard table (portable twin of the unit.test.ts block) -----------
{
  const json = (v: unknown) => JSON.stringify(v);
  const guard = (over: Record<string, unknown> = {}) =>
    updateGuard({
      harnessSession: false,
      bootVerdict: "recuperar",
      runningVersion: "1.2.4",
      offeredVersion: "1.2.4",
      updateState: null,
      ownerRelease: false,
      ...over,
    });
  check("P2-291: harness session is seguir even with verdict recuperar and equal versions", guard({ harnessSession: true }).decision === "seguir");
  check(
    "P2-291: absent and non-object inputs are seguir, never segurar",
    [undefined, null, 42, "boom", []].every((raw) => updateGuard(raw).decision === "seguir"),
  );
  check(
    "P2-291: non-textual fields are seguir",
    updateGuard({ bootVerdict: "recuperar", runningVersion: 7 }).decision === "seguir" &&
      updateGuard({ bootVerdict: 7, runningVersion: "1.2.4" }).decision === "seguir" &&
      updateGuard({ bootVerdict: "recuperar", runningVersion: "1.2.4", offeredVersion: 9 }).decision === "seguir",
  );
  check(
    "P2-291: verdict normal and suspeito are seguir",
    guard({ bootVerdict: "normal" }).decision === "seguir" && guard({ bootVerdict: "suspeito" }).decision === "seguir",
  );
  check(
    "P2-291: verdict recuperar with an equal offered version is recusar-oferta",
    guard().decision === "recusar-oferta" && guard().reason === "mesma-versao",
  );
  check(
    "P2-291: verdict recuperar with a different offered version is seguir — the escape route",
    guard({ offeredVersion: "1.2.5" }).decision === "seguir" && guard({ offeredVersion: "1.2.5" }).reason === "nova-versao",
  );
  check(
    "P2-291: the owner release wins over verdict recuperar with equal versions",
    guard({ ownerRelease: true }).decision === "seguir" && guard({ ownerRelease: true }).reason === "liberacao",
  );
  check(
    "P2-291: rule order — harness beats recusar-oferta; release beats recusar-oferta; identical in two calls",
    guard({ harnessSession: true }).decision === "seguir" &&
      guard({ ownerRelease: true }).decision === "seguir" &&
      json(guard()) === json(guard()),
  );
  const guardSrc = readFileSync(new URL("../apps/desktop/src/updateguard.ts", import.meta.url), "utf8");
  check(
    "P2-291: updateguard.ts imports no electron, node:fs, node:path nor fetch",
    !/^\s*import\b.*(?:electron|node:fs|node:path|fetch)/m.test(guardSrc) &&
      !guardSrc.includes("require(") &&
      !guardSrc.includes("fetch("),
  );
  const updateSrc = readFileSync(new URL("../apps/desktop/src/update.ts", import.meta.url), "utf8");
  const updateGuardAt = updateSrc.indexOf("const guard = updateGuard({");
  const versionGateAt = updateSrc.indexOf("if (!isNewerVersion(current, feed.version))");
  check(
    "P2-291: wiring — update.ts consults the guard before the version comparison; the refusal resolves like no-update, so the recheck keeps running",
    updateGuardAt >= 0 &&
      updateGuardAt < versionGateAt &&
      updateSrc.includes('return finish("update-not-available", feed.version)'),
  );
  const mainSrcP291 = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  const guardCallAt = mainSrcP291.indexOf("const guard = updateGuard({");
  const downloadCallAt = mainSrcP291.indexOf("checkForUpdatesOnBoot({");
  const guardLinesP291 = mainSrcP291
    .split("\n")
    .filter((l) => /updateGuard|update guard|ownerUpdateRelease|lastOfferedUpdateVersion/.test(l));
  check(
    "P2-291: wiring — main.ts consults the guard before the check and the automatic download, with no new periodic timer",
    guardCallAt >= 0 &&
      guardCallAt < downloadCallAt &&
      guardLinesP291.length > 0 &&
      guardLinesP291.every((l) => !l.includes("setInterval") && !l.includes("setTimeout")),
  );
  const sinkStartP291 = mainSrcP291.indexOf("onStatus: (status, version) => {");
  const sinkSliceP291 = mainSrcP291.slice(sinkStartP291, mainSrcP291.indexOf("refreshTrayMenu()", sinkStartP291));
  check(
    "P2-291: wiring — the onStatus sink recomputes the tray verdict after recording the offer (release item visible after the first refused check)",
    sinkSliceP291.indexOf("lastOfferedUpdateVersion = version") >= 0 &&
      sinkSliceP291.indexOf("updateGuard({") > sinkSliceP291.indexOf("lastOfferedUpdateVersion = version") &&
      sinkSliceP291.indexOf("updateGuardVerdict =") > sinkSliceP291.indexOf("updateGuard({"),
  );
}

// --- P2-291: the additive owner-release field in the existing store ----------------------
{
  const now = 1_700_000_000_000;
  const memoryFs = () => {
    const files = new Map<string, string>();
    const fs: BootHealthFs = {
      readFileSync: (file) => {
        const value = files.get(file);
        if (value === undefined) {
          const err = new Error("ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return value;
      },
      writeFileSync: (file, data) => {
        files.set(file, data);
      },
      renameSync: (from, to) => {
        const value = files.get(from);
        if (value === undefined) throw new Error("missing tmp");
        files.delete(from);
        files.set(to, value);
      },
      unlinkSync: (file) => {
        files.delete(file);
      },
    };
    return { files, fs };
  };
  const file = bootHealthRecordFile("/ud");
  check(
    "P2-291: tolerant release read — absent, corrupted and non-boolean fields all mean no release",
    readOwnerRelease(undefined) === false &&
      readOwnerRelease(null) === false &&
      readOwnerRelease("x") === false &&
      readOwnerRelease({}) === false &&
      readOwnerRelease({ ownerRelease: "yes" }) === false &&
      readOwnerRelease({ ownerRelease: 1 }) === false &&
      readOwnerRelease({ ownerRelease: true }) === true,
  );
  {
    const { files, fs } = memoryFs();
    // A legacy record written before P2-291 — no ownerRelease field anywhere.
    fs.writeFileSync(file, JSON.stringify({ lastSeenVersion: "1.2.0", lastHealthyVersion: "1.1.0", unmatchedOpenings: 2, lastOpeningAt: now }), { mode: 0o600 });
    const legacy = readBootHealthRecord(file, fs);
    check(
      "P2-291: a legacy record without the field stays legible without migration",
      legacy !== null && readOwnerRelease(legacy) === false,
    );
    const outcome = writeOwnerRelease({ file, fs, harnessSession: false, runningVersion: "1.2.4", nowMs: now });
    const stored = JSON.parse(files.get(file) ?? "null") as StoredBootHealthRecord | null;
    check(
      "P2-291: the release lands as ONE additive field of the existing record and preserves the known fields",
      outcome.written &&
        stored !== null &&
        stored.ownerRelease === true &&
        stored.lastSeenVersion === "1.2.0" &&
        stored.lastHealthyVersion === "1.1.0" &&
        stored.unmatchedOpenings === 2,
    );
    const stored2 = readBootHealthRecord(file, fs);
    const verdict = bootHealthVerdict({ harnessSession: false, runningVersion: "1.2.4", record: stored2, nowMs: now, floor: BOOT_HEALTH_OPENING_FLOOR });
    markOpeningInProgress({
      file,
      fs,
      harnessSession: false,
      runningVersion: "1.2.4",
      base: verdict.record,
      effectiveCount: verdict.count,
      nowMs: now,
    });
    promoteHealthyOpening({ file, fs, harnessSession: false, runningVersion: "1.2.4", nowMs: now });
    check(
      "P2-291: the boot mark and the promotion never erase the owner's choice",
      readOwnerRelease(readBootHealthRecord(file, fs)) === true,
    );
    const harness = writeOwnerRelease({ file, fs, harnessSession: true, runningVersion: "1.2.4", nowMs: now });
    const clock = writeOwnerRelease({ file, fs, harnessSession: false, runningVersion: "1.2.4", nowMs: Number.NaN });
    check(
      "P2-291: a harness session writes no release; a broken clock refuses instead of guessing",
      !harness.written && harness.reason === "harness" && !clock.written && clock.reason === "relogio",
    );
  }
  check(
    "P2-291: the tray release label is static, pt-BR, emoji-free and tray-budget sized",
    updateGuardReleaseLabel().startsWith("OpenCode Remote — ") && updateGuardReleaseLabel().length <= 128,
  );
}

console.log(failures === 0 ? "\nboothealth tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
