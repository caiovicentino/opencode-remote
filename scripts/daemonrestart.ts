/**
 * P3-345 — zombie-daemon restart helpers for the e2e harness.
 *
 * Two problems this module closes in scripts/reconnect.test.ts:
 *
 * 1. The old daemon was killed with SIGTERM and followed by a fixed 1s sleep.
 *    Its drain (`createShutdown`, apps/daemon/src/shutdown.ts) can legally take
 *    longer than 1s (whisper unload, disk flush + DRAIN_MS=3000 cap), and while
 *    its relay socket stays open the relay never runs leaveAll — the room now
 *    has TWO daemons sharing one ECDH key. The blind router delivers every
 *    frame to both, so chunk/complete can land on the new daemon (200) while
 *    the message post lands on the old one, which no longer has the upload in
 *    its maps and answers 410 "attachment expired" (CI run 34281044412) or an
 *    unopenable stale-key frame. Waiting for the REAL process exit (the child's
 *    own `exit` event) removes the race at its root.
 *
 * 2. The bounded retry around every post-restart op re-sent ANY op that timed
 *    out, including ops that consume state server-side. Only the staging chunk
 *    routes are safe to retry: re-staging the same chunk index replaces the
 *    previous copy in place. Everything else fails closed here.
 *
 * Pure by construction (lesson P2-300): no node:fs, node:http,
 * node:child_process, ws or fetch — the caller owns the real child process and
 * passes it behind the structural `ExitingChild` interface below. Timers and
 * the clock are injectable so the unit battery can pin every branch without a
 * real process, keeping the file in the portable (Windows) battery.
 */

/**
 * The slice of a Node ChildProcess the wait logic needs, declared locally so
 * this module never imports node:child_process (keeps it portable/pure).
 */
export interface ExitingChild {
  /** Set when the child exited normally; null while running. */
  readonly exitCode: number | null;
  /** Set when the child was terminated by a signal; null while running. */
  readonly signalCode: string | null;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  /** Send a POSIX signal (SIGKILL here); return value is intentionally ignored. */
  kill(signal: string): boolean | undefined;
}

export interface WaitForChildExitDeps {
  /** Grace period for a clean exit after the caller's own SIGTERM. Default 15000ms. */
  graceMs?: number;
  /** Extra wait for the exit event after the SIGKILL escalation. Default 3000ms. */
  killGraceMs?: number;
  /** Injectable clock (ms); defaults to Date.now. */
  now?: () => number;
  /** Injectable timer; defaults to the global ones. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

export interface ChildExitResult {
  /** Elapsed ms from the call to the observed exit (0 when already gone). */
  waitedMs: number;
  /** True when the clean grace expired and SIGKILL had to finish the job. */
  forced: boolean;
}

/**
 * Wait for a child process to actually be gone. Fixed decision order, no
 * hidden short-circuits:
 *   (a) already exited (exitCode or signalCode set) → resolve {waitedMs: 0,
 *       forced: false} without touching the process (never signal a recycled
 *       PID);
 *   (b) otherwise register `once("exit")` BEFORE any kill (an exit racing the
 *       timer is never lost) and wait up to `graceMs`;
 *   (c) grace expired → kill("SIGKILL") and wait `killGraceMs` more;
 *   (d) not even the SIGKILL produced an exit event → reject loudly: a test
 *       that keeps going from here would only fail three lines later with a
 *       baffling 410 or "request timeout".
 */
export function waitForChildExit(
  child: ExitingChild,
  deps: WaitForChildExitDeps = {},
): Promise<ChildExitResult> {
  const graceMs = deps.graceMs ?? 15_000;
  const killGraceMs = deps.killGraceMs ?? 3_000;
  const now = deps.now ?? (() => Date.now());
  const setTimeout = deps.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimeout = deps.clearTimeout ?? ((t: unknown) => globalThis.clearTimeout(t as ReturnType<typeof globalThis.setTimeout>));
  return new Promise<ChildExitResult>((resolve, reject) => {
    // (a) already gone — resolve at once, no signal, nothing to wait for
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ waitedMs: 0, forced: false });
      return;
    }
    const startedAt = now();
    let stage: "grace" | "kill" = "grace";
    let timer: unknown;
    const onExit = () => {
      clearTimeout(timer);
      resolve({ waitedMs: now() - startedAt, forced: stage === "kill" });
    };
    // (b) listener first, kill later — the exit event can never be missed
    child.once("exit", onExit);
    timer = setTimeout(() => {
      // (c) clean drain exceeded the grace window: escalate hard
      stage = "kill";
      child.kill("SIGKILL");
      timer = setTimeout(() => {
        // (d) unkillable child — fail with the reason named
        clearTimeout(timer);
        reject(new Error("old daemon never exited (graceMs+killGraceMs)"));
      }, killGraceMs);
    }, graceMs);
  });
}

/**
 * Closed, deterministic verdict: which e2e ops may be safely re-sent after a
 * timeout. TRUE only for the two staging-chunk routes — re-staging the same
 * index replaces the previous copy in place (apps/daemon/src/index.ts
 * `stageChunk`, `entry.parts[idx] = data`). FALSE for everything else, and in
 * particular for the routes that CONSUME state on arrival:
 * - POST /__ocr/upload/complete → `uploadChunks.delete(id)` on read;
 * - POST /session/<id>/message  → `uploads.delete(id)` once attachments are
 *   substituted into data URLs.
 * Retrying a consumed op fabricates the very 404/410 the retry was supposed to
 * mask, so the verdict fails closed for any unknown method+path pair.
 */
const RETRIABLE_OPS: ReadonlySet<string> = new Set([
  "POST /__ocr/upload/chunk",
  "POST /__ocr/transcribe/chunk",
]);

export function isRetriableOp(method: string, path: string): boolean {
  return RETRIABLE_OPS.has(`${method.toUpperCase()} ${path}`);
}
