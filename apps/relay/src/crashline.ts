/**
 * Structured crash line for the relay process (P2-351).
 *
 * The bug this closes: neither app registered `process.on("uncaughtException")`
 * or `process.on("unhandledRejection")`, so one discarded promise (the red
 * team's `void handleMessage` findings) or one unexpected exception killed the
 * whole hosted relay with Node's default raw stack — every room of every
 * tenant went down together and the log carried no structured line, no metric
 * and no context, only a multi-line stack dump of the host's file layout.
 *
 * This module is the whole shape of the fix's first half: the two fatal
 * listeners in index.ts hand the crash here and get back one structured log
 * object to write to stderr before the P2-145 drain takes the process down
 * with exit code 1 (the supervisor restarts it; peers reconnect with backoff).
 *
 * The object carries ONLY:
 * - `event` — which fatal listener fired ("uncaughtException" or
 *   "unhandledRejection");
 * - `class` — the error's class name (e.g. "RangeError"); a sanitized token,
 *   never free text, and for non-Error values the Object.prototype.toString
 *   kind ("String", "Object", "Null", ...);
 * - `message` — the error message truncated to CRASH_MESSAGE_MAX_CHARS with
 *   room ids, IPs and frame content redacted (see below);
 * - `stack` — the FIRST stack frame line only (the "where", never the whole
 *   trace), with every absolute path reduced to its basename so provider log
 *   retention never learns the host's directory layout;
 * - `uptimeS` — whole seconds the process had been up (clamped at 0), the
 *   crash-loop sibling of the `relay_uptime_seconds` gauge.
 *
 * Why the message is redacted so aggressively (P2-174 spirit): a hosted relay
 * writes JSONL into provider-retained log storage, so NOTHING a room id, a
 * client address or a payload fragment could ride into it may survive. A room
 * id is by grammar 8+ characters of `[A-Za-z0-9_-]`, and this process cannot
 * know which such tokens are words and which are ids — so EVERY token of that
 * shape is replaced with a fixed marker. The diagnosis is not lost: the class
 * name and the first stack frame (file:line) carry the actionable signal, and
 * messages stay recognizable because only the long tokens change ("Cannot
 * read [room:removed] of [room:removed]"). Failing closed over fidelity is
 * the deliberate trade — the reverse would let one hostile room id ride a
 * crash line into months of provider retention.
 *
 * Frame content: the relay never embeds payloads in error messages (every
 * frame path is guarded), so the boundary is (a) the redaction above, which
 * also removes any long printable payload run, (b) the wash of control
 * characters, which removes binary payload material an error message could
 * only ever surface as garbage bytes, and (c) the 200-character ceiling, which
 * bounds whatever remains.
 *
 * Pure by contract: no imports at all — no node:*, no ws, no process, no
 * timers — so the unit battery (and any future consumer) can load and pin it
 * without booting anything, and index.ts keeps all wiring (the stderr sink,
 * the counter, the drain) on its side.
 */

/** The two fatal process events the relay takes over at boot (P2-351). */
export type CrashEvent = "uncaughtException" | "unhandledRejection";

/** The one structured log object a fatal event emits (the `data` field). */
export interface CrashLine {
  /** Which fatal listener fired. */
  event: CrashEvent;
  /** Sanitized error class name — a fixed-vocabulary token, never free text. */
  class: string;
  /** Message truncated to CRASH_MESSAGE_MAX_CHARS, room ids / IPs / frame content redacted. */
  message: string;
  /** First stack frame only, absolute paths reduced to basenames ("" when none). */
  stack: string;
  /** Whole seconds the process had been up, clamped at 0. */
  uptimeS: number;
}

/** Message ceiling: the crash line is a hint, not a dump. */
export const CRASH_MESSAGE_MAX_CHARS = 200;
/** The stack field is one frame line, bounded like the message. */
export const CRASH_STACK_MAX_CHARS = 200;
/** What a redacted room id (any 8+ token of the room charset) becomes. */
export const CRASH_REDACTED_ROOM = "[room:removed]";
/** What a redacted IPv4/IPv6 address becomes. */
export const CRASH_REDACTED_IP = "[ip:removed]";
/** Class-name fallback when nothing trustworthy can be extracted. */
export const CRASH_CLASS_FALLBACK = "Error";

/** A room id is 8+ chars of the accepted grammar — so is any other such token. */
const ROOM_TOKEN_RE = /[A-Za-z0-9_-]{8,}/g;
/** Dotted-quad addresses, word-bounded so version-like triples stay untouched. */
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
/**
 * IPv6-shaped runs: hex/colon/dot material containing at least two colons
 * ("::1", "fe80::1", "::ffff:127.0.0.1", ":::8787"). Anchored to token
 * boundaries so identifiers like `node:internal/...` are never touched —
 * those never carry two bare colons of hex anyway.
 */
const IPV6_RE = /(?<![0-9A-Za-z:.])[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?![0-9A-Za-z.])/g;
/** C0 controls except the line breaks, DEL and C1 — binary garbage in, nothing out. */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/**
 * Absolute-path-looking tokens: an optional `file://` scheme or drive letter
 * followed by separator-led segments. The lookbehind keeps identifiers like
 * `node:internal/process/...` intact (the preceding char is a word char),
 * while real host paths — always preceded by a space, quote or bracket —
 * collapse to their basename.
 */
const ABS_PATH_RE = /(?<![A-Za-z0-9_])(?:file:\/\/)?(?:[A-Za-z]:)?(?:[\/\\][^\s()\\\/]+)+/g;
/** Class names must stay a short, closed-vocabulary token. */
const CLASS_TOKEN_RE = /[A-Za-z0-9_$]{1,40}/;
const NEWLINE_RE = /\r\n?|\n/g;

/**
 * Build the structured crash line for one fatal event.
 *
 * Total function: every input — including hostile shapes (throwing getters,
 * circular structures, missing names) — produces a well-formed object and
 * never throws, because the two callers run inside a dying process where a
 * throwing formatter would itself be the crash. The event is normalized
 * fail-closed to the more severe spelling when the caller passes something
 * unexpected; the uptime is clamped at 0 and anything non-numeric becomes 0.
 */
export function crashLine(event: CrashEvent, error: unknown, uptimeMs: number): CrashLine {
  const ev: CrashEvent = event === "unhandledRejection" ? "unhandledRejection" : "uncaughtException";
  return {
    event: ev,
    class: classOf(error),
    message: truncate(redact(wash(messageOf(error))), CRASH_MESSAGE_MAX_CHARS),
    stack: truncate(stripPaths(wash(firstStackFrame(error))), CRASH_STACK_MAX_CHARS),
    uptimeS: uptimeS(uptimeMs),
  };
}

/** Whole seconds, clamped: a negative or non-numeric input is 0, never -1. */
function uptimeS(uptimeMs: unknown): number {
  const ms = typeof uptimeMs === "number" && Number.isFinite(uptimeMs) ? uptimeMs : 0;
  return Math.max(0, Math.round(ms / 1000));
}

/**
 * The error's class name. For Error instances: `name` when it is a clean
 * token, then the constructor's name, then the fixed fallback — never raw
 * free text, so a weird `name` cannot smuggle content into the line. For
 * every other value: the Object.prototype.toString kind, which is exactly
 * the honest answer for `throw "boom"`-style rejects.
 */
function classOf(error: unknown): string {
  if (error instanceof Error) {
    const name = errorName(error);
    const token = typeof name === "string" ? firstToken(name) : "";
    if (token) return token;
    const ctor = (error as { constructor?: { name?: unknown } }).constructor;
    const ctorName = ctor && typeof ctor.name === "string" ? firstToken(ctor.name) : "";
    return ctorName || CRASH_CLASS_FALLBACK;
  }
  return Object.prototype.toString.call(error).slice(8, -1) || CRASH_CLASS_FALLBACK;
}

function errorName(error: Error): unknown {
  try {
    return (error as { name?: unknown }).name;
  } catch {
    return undefined;
  }
}

/** First clean token of a candidate name; empty when the name is unusable. */
function firstToken(raw: string): string {
  return CLASS_TOKEN_RE.exec(raw)?.[0] ?? "";
}

/**
 * The message. Errors contribute their own message; strings contribute
 * themselves; everything else gets one safe, bounded stringification —
 * `String()` for primitives, `JSON.stringify` for shapes with content, a
 * fixed fallback when stringify throws (circular structures, throwing
 * getters). The redaction below runs over whatever comes out, so a hostile
 * shape's fields are redacted with the same rules as a real message.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    try {
      const m = (error as { message?: unknown }).message;
      return typeof m === "string" ? m : "";
    } catch {
      return "";
    }
  }
  if (typeof error === "string") return error;
  try {
    const json = JSON.stringify(error);
    if (typeof json === "string") return json;
  } catch {
    // circular or throwing getter: fall through to the plain coercion
  }
  try {
    return String(error);
  } catch {
    return "unprintable";
  }
}

/**
 * The FIRST stack frame line only — the "where" of the crash. Stack lines
 * before the first frame (the `Error: message` line for real errors) carry
 * nothing the other fields do not already carry, and never reach this field,
 * which also keeps the fail-closed invariant simple: the stack field can
 * never replay unredacted message content. Empty when there is no usable
 * frame at all.
 */
function firstStackFrame(error: unknown): string {
  const raw = stackText(error);
  if (!raw) return "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("at ")) return trimmed;
  }
  return "";
}

function stackText(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const stack = (error as { stack?: unknown }).stack;
    return typeof stack === "string" ? stack : undefined;
  } catch {
    return undefined;
  }
}

/** Reduce every absolute path in the line to its basename. */
function stripPaths(text: string): string {
  return text.replace(ABS_PATH_RE, (match) => {
    const segments = match.split(/[\/\\]/);
    const base = segments[segments.length - 1] ?? "";
    return base.length > 0 ? base : match;
  });
}

/**
 * Flatten and wash one line of text: line breaks become single spaces (the
 * relay's log contract is one JSON object per line) and every control byte —
 * the shape binary payload material takes inside an error message — is
 * removed rather than carried into a terminal or a log shipper.
 */
function wash(text: string): string {
  return text.replace(NEWLINE_RE, " ").replace(CONTROL_RE, "").trim();
}

/** Room ids, IPs and printable frame runs out; fixed markers in. */
function redact(text: string): string {
  return text.replace(ROOM_TOKEN_RE, CRASH_REDACTED_ROOM).replace(IPV4_RE, CRASH_REDACTED_IP).replace(IPV6_RE, CRASH_REDACTED_IP);
}

/** Hard ceiling applied after redaction, so nothing survives past the bound. */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}
