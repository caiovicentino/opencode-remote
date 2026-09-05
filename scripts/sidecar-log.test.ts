/**
 * Sidecar log tee tests (P3-018): raw chunks appended to
 * userData/logs/daemon-sidecar.log, ~1MB cap with rotation to
 * daemon-sidecar.log.1 (only 2 files kept on disk), a failing fs that must
 * never throw, and the process-wide tee daemon.ts uses (no-op before init).
 * Pure logic under an injected fs subset — no Electron needed.
 * Run: npx tsx scripts/sidecar-log.test.ts
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
import type { LogFs } from "../apps/desktop/src/desktop-log";
import {
  createSidecarTee,
  initSidecarLog,
  SIDECAR_LOG_CAP_BYTES,
  SIDECAR_LOG_MAX_FILES,
  sidecarLogFile,
  teeSidecarChunk,
} from "../apps/desktop/src/sidecar-log";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

function tempUserData(): string {
  return mkdtempSync(join(tmpdir(), "ocr-sidecar-log-"));
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

// --- append: raw JSONL chunks land verbatim -------------------------------------
{
  const userData = tempUserData();
  try {
    const tee = createSidecarTee(userData, { fs: realFs });
    tee('{"ts":1,"msg":"daemon boot"}\n');
    const file = sidecarLogFile(userData);
    check("append: file created under userData/logs", existsSync(file));
    check("append: chunk bytes verbatim", readFileSync(file, "utf8") === '{"ts":1,"msg":"daemon boot"}\n');
    tee('{"ts":2,"msg":"pairing uri printed"}\n');
    const raw = readFileSync(file, "utf8");
    check("append: subsequent chunks accumulate in order", raw.endsWith('{"ts":2,"msg":"pairing uri printed"}\n'));
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

// --- cap + rotation -------------------------------------------------------------
{
  const userData = tempUserData();
  try {
    const tee = createSidecarTee(userData, { fs: realFs, capBytes: 20 });
    tee("L1-rotated-out-line\n"); // fills the active file past the 20B cap
    tee("L2-newest\n"); // append at/above cap → rotate first
    const file = sidecarLogFile(userData);
    const prev = readFileSync(`${file}.1`, "utf8");
    const cur = readFileSync(file, "utf8");
    check("cap: previous file holds the rotated-out line", prev.includes("L1-rotated-out-line") && !prev.includes("L2-newest"));
    check("cap: active file holds the newest line", cur.includes("L2-newest") && !cur.includes("L1-rotated-out-line"));
    for (let i = 0; i < 5; i++) tee(`L${i}\n`);
    const entries = readdirSync(join(userData, "logs")).sort();
    check(
      `cap: only ${SIDECAR_LOG_MAX_FILES} files kept`,
      entries.length === SIDECAR_LOG_MAX_FILES && entries[0] === "daemon-sidecar.log" && entries[1] === "daemon-sidecar.log.1",
    );
    check("cap: active file still appends after rotations", readFileSync(file, "utf8").includes("L4\n"));
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
  const errors: string[] = [];
  const tee = createSidecarTee(userData, { fs: failingFs, onFailure: (err) => errors.push(String(err)) });
  let threw = false;
  try {
    tee("survives a full disk\n");
    tee("and a second chunk\n");
  } catch {
    threw = true;
  }
  check("failing fs: never throws", !threw);
  check("failing fs: every failure reported through the sink", errors.length === 2);
  rmSync(userData, { recursive: true, force: true });
}

// --- oversized lineless chunk is flushed, not dropped ----------------------------
// P2-160: chunks now flow through the line redactor first, so a lineless chunk
// is held in the partial-line buffer until it exceeds maxPartialBytes — then
// force-flushed (already redacted). Same original intent: bytes never lost.
{
  const userData = tempUserData();
  try {
    const tee = createSidecarTee(userData, { fs: realFs, capBytes: 1000, maxPartialBytes: 50 });
    const big = "x".repeat(100); // larger than the partial cap, no newline at all
    tee(big); // exceeds maxPartialBytes → forced redacted flush
    tee("tail\n"); // proves the buffer drained: nothing stuck, nothing lost
    const raw = readFileSync(sidecarLogFile(userData), "utf8");
    check("oversized: lineless chunk force-flushed whole", raw.startsWith(big));
    check("oversized: next chunk appends after the forced flush", raw === `${big}tail\n`);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

// --- process-wide tee used by daemon.ts -----------------------------------------
{
  let threw = false;
  try {
    teeSidecarChunk("before init — must be a silent no-op\n");
  } catch {
    threw = true;
  }
  check("process tee: no-op (no throw) before init", !threw);

  const userData = tempUserData();
  try {
    initSidecarLog(userData, { fs: realFs });
    teeSidecarChunk('{"jsonl":"line from the daemon"}\n');
    const file = sidecarLogFile(userData);
    check(
      "process tee: chunk lands in the installed file",
      existsSync(file) && readFileSync(file, "utf8").includes('{"jsonl":"line from the daemon"}'),
    );
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

// --- production defaults ---------------------------------------------------------
check("defaults: cap is ~1MB and 2 files kept", SIDECAR_LOG_CAP_BYTES === 1_000_000 && SIDECAR_LOG_MAX_FILES === 2);

console.log(failures === 0 ? "\nsidecar log tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
