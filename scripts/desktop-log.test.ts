/**
 * Desktop file-logging tests (P3-012): append, ~1MB cap with rotation to
 * desktop.log.1 (only 2 files kept on disk) and a failing fs that must never
 * throw. Pure logic under an injected fs subset — no Electron needed.
 * Run: npx tsx scripts/desktop-log.test.ts
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDesktopLogger,
  desktopLogFile,
  formatLine,
  formatTimestamp,
  LOG_CAP_BYTES,
  LOG_MAX_FILES,
  logsDir,
  rotateLog,
  serializePart,
  type LogFs,
} from "../apps/desktop/src/desktop-log";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

function tempUserData(): string {
  return mkdtempSync(join(tmpdir(), "ocr-desktop-log-"));
}

/** Real fs routed through the injected subset (signature widening for the test). */
const realFs: LogFs = {
  existsSync,
  mkdirSync: (dir, opts) => mkdirSync(dir, opts),
  statSync: (file) => statSync(file),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (file) => unlinkSync(file),
  appendFileSync: (file, data) => appendFileSync(file, data),
};

// --- append --------------------------------------------------------------------
{
  const userData = tempUserData();
  try {
    const captured: string[] = [];
    const logger = createDesktopLogger(userData, {
      fs: realFs,
      out: (_level, line) => captured.push(line),
    });
    logger.log("daemon sidecar spawned", { pid: 42 });
    const file = desktopLogFile(userData);
    check("append: file created under userData/logs", existsSync(file));
    const raw = readFileSync(file, "utf8");
    check("append: message and payload present", raw.includes("[log] daemon sidecar spawned") && raw.includes('{"pid":42}'));
    check("append: line has local timestamp + level", /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\] \[log\] /.test(raw));
    check("append: mirror sink received the line", captured.length === 1 && captured[0].includes("daemon sidecar spawned"));

    logger.error(new Error("boom"));
    const raw2 = readFileSync(file, "utf8");
    check("append: error level flagged", raw2.includes("[error] "));
    check("append: Error serialized with message", raw2.includes("boom"));
    check("append: two entries total (stacks may span lines)", (raw2.match(/^\[\d{4}-/gm) ?? []).length === 2);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

// --- cap + rotation ------------------------------------------------------------
{
  const userData = tempUserData();
  try {
    const logger = createDesktopLogger(userData, { fs: realFs, capBytes: 50 });
    logger.log("L1-first");
    logger.log("L2-second");
    // The first line already fills past the 50B cap, so the second rotates.
    logger.log("L3-third");
    const file = desktopLogFile(userData);
    const one = `${file}.1`;
    check("cap: rotated previous file exists", existsSync(one));
    const prev = readFileSync(one, "utf8");
    const cur = readFileSync(file, "utf8");
    check("cap: previous file holds the old lines", prev.includes("L1-first") && prev.includes("L2-second") && !prev.includes("L3-third"));
    check("cap: active file holds only post-rotation lines", cur.includes("L3-third") && !cur.includes("L1-first"));
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

// --- rotation keeps exactly 2 files ---------------------------------------------
{
  const userData = tempUserData();
  try {
    const logger = createDesktopLogger(userData, { fs: realFs, capBytes: 1 });
    for (let i = 0; i < 10; i++) logger.log(`line-${i}`);
    const entries = readdirSync(logsDir(userData)).sort();
    check(
      `rotation: only ${LOG_MAX_FILES} files kept`,
      entries.length === LOG_MAX_FILES && entries[0] === "desktop.log" && entries[1] === "desktop.log.1",
    );
    check("rotation: active file still appends", readFileSync(desktopLogFile(userData), "utf8").includes("line-9"));
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

// --- failing fs never throws ----------------------------------------------------
{
  const userData = tempUserData();
  const boom = (): never => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  const failingFs: LogFs = {
    existsSync: () => false,
    mkdirSync: boom,
    statSync: boom,
    renameSync: boom,
    unlinkSync: boom,
    appendFileSync: boom,
  };
  const captured: string[] = [];
  const logger = createDesktopLogger(userData, { fs: failingFs, out: (_l, line) => captured.push(line) });
  let threw = false;
  try {
    logger.log("survives a full disk");
    logger.error("and an error too");
  } catch {
    threw = true;
  }
  check("failing fs: never throws", !threw);
  check("failing fs: mirror still receives every line", captured.length === 2);
  rmSync(userData, { recursive: true, force: true });
}

// --- logs dir deleted mid-run: ENOENT path degrades, no throw -------------------
{
  const userData = tempUserData();
  try {
    const logger = createDesktopLogger(userData, { fs: realFs });
    logger.log("before-wipe");
    rmSync(logsDir(userData), { recursive: true, force: true });
    let threw = false;
    try {
      logger.log("after-wipe");
    } catch {
      threw = true;
    }
    check("ENOENT: recreating dir keeps logging without throw", !threw && readFileSync(desktopLogFile(userData), "utf8").includes("after-wipe"));
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

// --- rotateLog / formatLine / serializePart units --------------------------------
  {
    const userData = tempUserData();
    try {
      mkdirSync(logsDir(userData), { recursive: true });
      const file = desktopLogFile(userData);
      realFs.appendFileSync(file, "old");
    check("rotate: renames active → .1", rotateLog(file, realFs) && readFileSync(`${file}.1`, "utf8") === "old");
    check("rotate: failed rotation is a false, not a throw", rotateLog(join(userData, "missing.log"), realFs) === false);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }

  check(
    "formatLine: assembles timestamp, level and message",
    formatLine("error", ["x", 1, { a: true }], new Date("2026-09-01T12:00:00Z")).endsWith("[error] x 1 {\"a\":true}"),
  );
  check("serializePart: null/undefined become String()", serializePart(null) === "null" && serializePart(undefined) === "undefined");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  check("serializePart: circular object does not throw", serializePart(circular).length > 0);
  check("serializePart: Error keeps stack", serializePart(new Error("oops")).includes("oops"));

  const ts = formatTimestamp(new Date("2026-09-01T12:00:00Z"));
  check("formatTimestamp: offset-suffixed local time", /^[+-]\d{2}:\d{2}$/.test(ts.slice(-6)) && ts.length === 29);
  check("LOG_CAP_BYTES is ~1MB", LOG_CAP_BYTES === 1_000_000);
}

console.log(failures === 0 ? "\ndesktop log tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
