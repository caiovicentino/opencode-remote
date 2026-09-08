/**
 * P3-345 — unit battery for scripts/daemonrestart.ts.
 *
 * Uses a fake child (a local EventEmitter with the ExitingChild shape) — no
 * real process, no POSIX signals — so the file runs unmodified on the portable
 * Windows battery. Covers: slow daemon shutdown (1500ms > the old fixed 1s
 * sleep) resolved without escalation, SIGKILL escalation for a child that
 * ignores the graceful window, an unkillable child rejecting loudly, an
 * already-dead child resolving instantly without a signal, the closed
 * isRetriableOp verdict table and the module's own purity (lesson P2-300).
 * Run: npx tsx scripts/daemonrestart.test.ts
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { isRetriableOp, waitForChildExit, type ExitingChild } from "./daemonrestart";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("daemonrestart test timed out (global 30s)");
  process.exit(1);
}, 30_000).unref();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake child with the ExitingChild shape; records every signal it is sent. */
class FakeChild extends EventEmitter implements ExitingChild {
  exitCode: number | null = null;
  signalCode: string | null = null;
  kills: string[] = [];
  /** When true, kill() schedules the exit event (a child that dies to SIGKILL). */
  diesToSigkill: boolean;
  constructor(opts: { diesToSigkill?: boolean } = {}) {
    super();
    this.diesToSigkill = opts.diesToSigkill ?? false;
  }
  kill(signal: string): boolean {
    this.kills.push(signal);
    if (this.diesToSigkill && signal === "SIGKILL") {
      setTimeout(() => {
        this.signalCode = "SIGKILL";
        this.emit("exit", null, "SIGKILL");
      }, 10).unref();
    }
    return true;
  }
}

// --- 1. slow shutdown: 1500ms (> the old fixed 1s sleep), no escalation ------
{
  const child = new FakeChild();
  // simulate the old daemon: drain (unload/flush) finishes only after 1500ms
  setTimeout(() => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  }, 1500).unref();
  const t0 = Date.now();
  const pending = waitForChildExit(child);
  const early = await Promise.race([
    pending.then(() => "resolved"),
    sleep(750).then(() => "still-pending"),
  ]);
  check("slow exit: the promise does NOT resolve before the real exit", early === "still-pending");
  const res = await pending;
  const wall = Date.now() - t0;
  check(`slow exit: waitedMs >= 1500 (got ${res.waitedMs})`, res.waitedMs >= 1500);
  check("slow exit: wall clock agrees with the measured wait", wall >= 1500);
  check("slow exit: resolved without SIGKILL escalation", res.forced === false);
  check("slow exit: no extra signal was sent", child.kills.length === 0);
}

// --- 2. clean drain outlives the grace window: SIGKILL escalation ------------
{
  const child = new FakeChild({ diesToSigkill: true });
  const res = await waitForChildExit(child, { graceMs: 30, killGraceMs: 1000 });
  check("escalation: resolves forced=true after the grace expires", res.forced === true);
  check("escalation: exactly one SIGKILL was sent", child.kills.length === 1 && child.kills[0] === "SIGKILL");
}

// --- 3. child that ignores even SIGKILL: loud rejection -----------------------
{
  const child = new FakeChild(); // kill() is a no-op, exit never fires
  let message = "";
  try {
    await waitForChildExit(child, { graceMs: 20, killGraceMs: 20 });
  } catch (e) {
    message = (e as Error).message;
  }
  check(
    "unkillable: rejects with the named reason",
    message === "old daemon never exited (graceMs+killGraceMs)",
  );
  check("unkillable: the SIGKILL was attempted", child.kills.length === 1);
}

// --- 4. already-dead child: instant resolve, no signal ------------------------
{
  const dead = new FakeChild();
  dead.exitCode = 0;
  const res = await waitForChildExit(dead);
  check("already dead: resolves at 0ms", res.waitedMs === 0);
  check("already dead: not forced", res.forced === false);
  check("already dead: no signal sent (no recycled-PID kill)", dead.kills.length === 0);

  const signaled = new FakeChild();
  signaled.signalCode = "SIGTERM";
  const res2 = await waitForChildExit(signaled);
  check("already signaled: resolves at 0ms without a signal", res2.waitedMs === 0 && signaled.kills.length === 0);
}

// --- 5. isRetriableOp: closed verdict table -----------------------------------
check("retriable: POST /__ocr/upload/chunk", isRetriableOp("POST", "/__ocr/upload/chunk") === true);
check("retriable: POST /__ocr/transcribe/chunk", isRetriableOp("POST", "/__ocr/transcribe/chunk") === true);
check("not retriable: POST /__ocr/upload/complete (consumes uploadChunks)", isRetriableOp("POST", "/__ocr/upload/complete") === false);
check("not retriable: POST /session/<id>/message (consumes uploads)", isRetriableOp("POST", "/session/ses_x/message") === false);
check("not retriable: unknown route", isRetriableOp("POST", "/__ocr/unknown") === false);
check("not retriable: wrong method on a chunk route", isRetriableOp("GET", "/__ocr/upload/chunk") === false);
check("not retriable: method casing does not create a new verdict", isRetriableOp("post", "/__ocr/upload/chunk") === true);

// --- 6. module purity (lesson P2-300) -----------------------------------------
{
  const src = readFileSync(new URL("./daemonrestart.ts", import.meta.url), "utf8");
  check(
    "daemonrestart.ts stays pure: zero imports, no fetch, no dynamic import",
    !/^import/m.test(src) && !src.includes("fetch(") && !src.includes("await import("),
  );
}

if (failures) process.exit(1);
console.log("daemonrestart: ALL OK");
process.exit(0);
