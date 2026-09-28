/**
 * eval-12: the one structured line a fatal process event leaves behind.
 *
 * Before, a stray exception or rejection ended the daemon with Node's raw
 * multi-line stack in daemon.err.log — no timestamp, no level, nothing a log
 * scan can correlate (the 2026-09 forensics had to guess which of 119
 * unannounced restarts were crashes). The process still exits — same policy
 * as the relay's P2-351: a supervisor restart beats running on half-updated
 * state — but first it logs this summary and drains like SIGTERM.
 *
 * Only the error NAME and the FIRST stack frame travel (the frame-handler
 * backstop's rule): a message can carry frame content, a request path or a
 * JSON.parse snippet of daemon.json. The frame keeps the "where" (function,
 * file basename, line:col) and drops the directory — paths may contain spaces
 * ("/Volumes/SSD Major/…"), so the cut is the last separator before
 * `file:line:col`, never a whitespace split.
 *
 * Pure and total: no import, never throws (it runs inside a dying process).
 */

export type FatalEvent = "uncaughtException" | "unhandledRejection";

export interface CrashSummary {
  event: FatalEvent;
  /** constructor/name token of the error, or the typeof kind for non-errors */
  error: string;
  /** first "at …" frame with directories stripped, "" when there is none */
  frame: string;
}

const MAX_FRAME_CHARS = 200;

export function crashSummary(event: FatalEvent, err: unknown): CrashSummary {
  const ev: FatalEvent = event === "unhandledRejection" ? "unhandledRejection" : "uncaughtException";
  try {
    return { event: ev, error: errorName(err), frame: firstFrame(err) };
  } catch {
    return { event: ev, error: "unknown", frame: "" };
  }
}

function errorName(err: unknown): string {
  if (err instanceof Error) {
    const name = typeof err.name === "string" ? /^[A-Za-z0-9_$]{1,40}/.exec(err.name)?.[0] : undefined;
    return name ?? "Error";
  }
  return err === null ? "null" : typeof err;
}

function firstFrame(err: unknown): string {
  if (err === null || typeof err !== "object") return "";
  const stack = (err as { stack?: unknown }).stack;
  if (typeof stack !== "string") return "";
  const line = stack.split("\n").find((l) => l.trim().startsWith("at "));
  if (!line) return "";
  // "(…/dir with spaces/file.ts:12:3)" and "at /…/file.ts:12:3" → basename:line:col
  const stripped = line
    .trim()
    .replace(/\((?:[^()]*[\\/])?([^\\/()]+:\d+:\d+)\)/, "($1)")
    .replace(/^at (?:file:\/\/)?(?:[^()]*[\\/])([^\\/()]+:\d+:\d+)$/, "at $1")
    .replace(/[\u0000-\u001f\u007f]/g, "");
  return stripped.length > MAX_FRAME_CHARS ? stripped.slice(0, MAX_FRAME_CHARS) : stripped;
}
