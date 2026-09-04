/**
 * Instance-hygiene tests (P2-069): the boot-record parse/write round-trip, the
 * zombie-warning decision matrix and the OCR_KEEPER_PID leash hatch. Pure
 * logic under injected fs/ps — no Electron needed.
 * Run: npx tsx scripts/instances.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  instanceRecordPath,
  keeperPidFromEnv,
  parseInstanceRecord,
  parsePsLstart,
  processStartedBefore,
  readInstanceRecord,
  writeInstanceRecord,
  zombieWarning,
} from "../apps/desktop/src/instances";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const dir = mkdtempSync(join(tmpdir(), "ocr-instances-"));

// --- parseInstanceRecord -------------------------------------------------------
check("parse: valid record passes", JSON.stringify(parseInstanceRecord('{"pid":42,"startedAt":123}')) === '{"pid":42,"startedAt":123}');
check("parse: garbage is null", parseInstanceRecord("not json") === null);
check("parse: negative pid rejected", parseInstanceRecord('{"pid":-1,"startedAt":123}') === null);
check("parse: zero pid rejected", parseInstanceRecord('{"pid":0,"startedAt":123}') === null);
check("parse: missing startedAt rejected", parseInstanceRecord('{"pid":42}') === null);
check("parse: non-number startedAt rejected", parseInstanceRecord('{"pid":42,"startedAt":"x"}') === null);

// --- read/write round-trip -----------------------------------------------------
const file = instanceRecordPath(dir);
check("path: record lives inside userData", file.endsWith("instance.json") && file.startsWith(dir));
check("read: missing file is null", readInstanceRecord(join(dir, "nope.json")) === null);
check("write: valid record persists", writeInstanceRecord(file, { pid: 7, startedAt: 999 }));
const round = readInstanceRecord(file);
check("read: round-trip returns the record", round?.pid === 7 && round?.startedAt === 999);
check("write: unwritable path is false, never throws", writeInstanceRecord(join(dir, "no-such-dir", "x.json"), { pid: 1, startedAt: 1 }) === false);
check("read: corrupted content is null", (() => {
  const bad = join(dir, "bad.json");
  writeInstanceRecord(bad, { pid: 1, startedAt: 1 });
  writeFileSync(bad, "{oops", "utf8");
  return readInstanceRecord(bad) === null;
})());

// --- zombieWarning decision matrix ---------------------------------------------
const NOW = 1_000_000;
const prev = { pid: 1234, startedAt: NOW - 5_000 };
check("zombie: alive + earlier start warns", zombieWarning({ previous: prev, currentPid: 2, nowMs: NOW, alive: true, startedBeforeCurrent: true })?.includes("1234") === true);
check("zombie: alive + unknowable lstart still warns (fail direction = warn)", zombieWarning({ previous: prev, currentPid: 2, nowMs: NOW, alive: true, startedBeforeCurrent: null })?.includes("1234") === true);
check("zombie: dead holder stays quiet", zombieWarning({ previous: prev, currentPid: 2, nowMs: NOW, alive: false, startedBeforeCurrent: null }) === null);
check("zombie: same pid (reboot reuse of our own record) stays quiet", zombieWarning({ previous: { ...prev }, currentPid: 1234, nowMs: NOW, alive: true, startedBeforeCurrent: true }) === null);
check("zombie: ps proves a younger process (PID reuse) stays quiet", zombieWarning({ previous: prev, currentPid: 2, nowMs: NOW, alive: true, startedBeforeCurrent: false }) === null);
check("zombie: clock-skewed future record stays quiet", zombieWarning({ previous: { pid: 1234, startedAt: NOW + 60_000 }, currentPid: 2, nowMs: NOW, alive: true, startedBeforeCurrent: true }) === null);

// --- parsePsLstart ---------------------------------------------------------------
// BSD `ps -o lstart=` shape, local time, double spaces after short months.
const parsed = parsePsLstart("Fri Sep  4 21:15:00 2026");
check("lstart: BSD line parses into the right local date", parsed !== null && parsed.getFullYear() === 2026 && parsed.getMonth() === 8 && parsed.getDate() === 4 && parsed.getHours() === 21 && parsed.getMinutes() === 15);
check("lstart: garbage is null", parsePsLstart("root     1234  0.0  0.1") === null);
check("lstart: empty is null", parsePsLstart("") === null);

// --- processStartedBefore (injected ps runner) -----------------------------------
check("startedBefore: null ps output is unknowable", processStartedBefore(1, NOW, () => null) === null);
// Deterministic comparison around a known boundary via fixed local-time lines.
{
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  const lstartLine = (ms: number) => {
    const d = new Date(ms);
    return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
  };
  check("startedBefore: one minute ago is earlier", processStartedBefore(1, NOW, () => lstartLine(NOW - 60_000)) === true);
  check("startedBefore: future-dated process is NOT earlier (PID reuse)", processStartedBefore(1, NOW, () => lstartLine(NOW + 60_000)) === false);
  check("startedBefore: unparsable line is unknowable", processStartedBefore(1, NOW, () => "???") === null);
}

// --- keeperPidFromEnv ------------------------------------------------------------
check("leash: absent env is null", keeperPidFromEnv({}) === null);
check("leash: garbage is null", keeperPidFromEnv({ OCR_KEEPER_PID: "abc" }) === null);
check("leash: pid 0/1 rejected", keeperPidFromEnv({ OCR_KEEPER_PID: "0" }) === null && keeperPidFromEnv({ OCR_KEEPER_PID: "1" }) === null);
check("leash: own pid rejected", keeperPidFromEnv({ OCR_KEEPER_PID: String(process.pid) }) === null);
check("leash: foreign pid accepted", keeperPidFromEnv({ OCR_KEEPER_PID: "4242" }) === 4242);

// --- sanity: the record file we wrote earlier still reads back -------------------
check("sanity: record file content is compact JSON", readFileSync(file, "utf8") === '{"pid":7,"startedAt":999}');
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall instance-hygiene tests passed");
