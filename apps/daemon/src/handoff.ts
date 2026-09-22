/**
 * RT-439: shell/AppleScript injection hardening for `POST /__ocr/handoff`.
 *
 * The old handler interpolated the session directory straight into an
 * AppleScript `do script "cd ${dir} && opencode -s ${id}"` string. Escaping
 * only `"` protected the AppleScript literal layer, but NOT the shell layer —
 * `do script` hands the text to the user's shell, so `;`, `$()`, backticks,
 * `&&`, `|`, a trailing `\` or a newline inside `dir` executed arbitrary
 * commands (same class as the takeover fix, P2-048 — see the comment in
 * pilotforensic.ts). `sessionId` was only prefix-checked (`startsWith("ses")`),
 * so it interpolated raw into both the shell command and the opencode URL
 * (`ses/../..` reached the API as a path traversal).
 *
 * Both layers are now inert by construction:
 *   1. shell — the directory and the session id are POSIX single-quoted
 *      (shellQuote), so every byte the shell sees after the opening quote is
 *      literal: no glob, no `~` expansion, no command substitution.
 *   2. AppleScript — the quoted command reaches osascript as argv (`on run
 *      argv` + `do script (item 1 of argv)`), never interpolated into the
 *      source, so quotes and backslashes in the value cannot close or reshape
 *      the script.
 *
 * Pure on purpose (frameguard/helloguard house pattern): validators, quoting
 * and argv assembly only — no I/O, no clock, no logging. The call site never
 * logs the rejected directory value (log-injection).
 */

/** Real opencode ids are `ses_` plus an alphanumeric nanoid; the same shape
 * the other session-scoped routes already enforce (`/__ocr/context`). */
const HANDOFF_SESSION_RE = /^ses_[A-Za-z0-9]{4,64}$/;

/** Same ceiling the daemon already applies to tunneled paths — long enough
 * for any real project cwd, short enough to stay one log line. */
const MAX_HANDOFF_DIRECTORY_LENGTH = 4096;

/** NUL..US and DEL: a newline inside `dir` becomes an Enter typed into the
 * Terminal window, so control characters are refused outright. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * The session id must be a real opencode id shape — anything else never
 * reaches the fetch URL or the shell command.
 */
export function validateHandoffSessionId(s: unknown): string | null {
  return typeof s === "string" && HANDOFF_SESSION_RE.test(s) ? s : null;
}

/**
 * The directory may contain anything a real project cwd contains (spaces,
 * accents, `'`, `(`, `$`, backticks…), so no narrow allowlist — the safety
 * comes from the quoting. What is refused: non-strings, empty, relative
 * paths, anything over the length ceiling and control characters.
 */
export function validateHandoffDirectory(d: unknown): string | null {
  if (typeof d !== "string") return null;
  if (d.length < 1 || d.length > MAX_HANDOFF_DIRECTORY_LENGTH) return null;
  if (!d.startsWith("/")) return null;
  if (CONTROL_CHARS.test(d)) return null;
  return d;
}

/**
 * POSIX single-quote: wrap in `'…'` and splice every inner `'` as
 * `'\''` (close, escaped quote, reopen) — the one rule all shells agree on.
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * The shell command that `do script` will hand to the user's shell — every
 * interpolated value quoted, so the shell receives both as literals.
 */
export function buildHandoffCommand(dir: string, sessionId: string): string {
  return `cd ${shellQuote(dir)} && opencode -s ${shellQuote(sessionId)}`;
}

/**
 * argv for `execFile("osascript", …)`: the script reads its first argument
 * instead of embedding it, so the command value (which quotes hostile
 * directories) is never part of the AppleScript source.
 */
export function buildHandoffOsascriptArgs(command: string): string[] {
  return [
    "-e",
    "on run argv",
    "-e",
    'tell application "Terminal"',
    "-e",
    "activate",
    "-e",
    "do script (item 1 of argv)",
    "-e",
    "end tell",
    "-e",
    "end run",
    command,
  ];
}
