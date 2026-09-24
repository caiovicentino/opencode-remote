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
 *   kind reduced to a closed vocabulary ("String", "Object", "Null", ...) —
 *   a crafted or throwing `Symbol.toStringTag` cannot smuggle content or a
 *   throw through this field;
 * - `message` — the error message truncated to CRASH_MESSAGE_MAX_CHARS with
 *   room ids, IPs and frame content redacted AND every absolute path reduced
 *   to its basename: Node fs errors embed host paths in the MESSAGE (not only
 *   in the frames), so the same reduction the stack field gets applies here —
 *   provider log retention never learns the host's directory layout, the TLS
 *   certificate location or a user's account name from a crash line;
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
 * bounds whatever remains. Host paths are not payload, but they carry the
 * host's directory layout — the message field strips them to basenames with
 * the same reduction the stack field applies, so an fs error ("ENOENT: ...
 * open '/etc/letsencrypt/live/relay.example.com/privkey.pem'") leaves only
 * the file name behind, never the tree above it.
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
  /** Sanitized error class name — a closed-vocabulary token, never free text. */
  class: string;
  /** Message truncated to CRASH_MESSAGE_MAX_CHARS: room ids / IPs / frame content redacted, absolute paths reduced to basenames. */
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
/** Kind fallback for a non-Error value the closed vocabulary cannot name. */
export const CRASH_KIND_FALLBACK = "Object";

/**
 * The closed vocabulary a non-Error `class` may ever carry. A hostile
 * `Symbol.toStringTag` (or any crafted shape) can otherwise smuggle free text
 * — room ids included — into the class field through
 * Object.prototype.toString; anything outside this set degrades to the fixed
 * CRASH_KIND_FALLBACK instead.
 */
const KIND_VOCABULARY: ReadonlySet<string> = new Set([
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Undefined",
  "Null",
  "Function",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
]);

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
 * circular structures, crafted `Symbol.toStringTag`s, missing names) —
 * produces a well-formed object and never throws, because the two callers run
 * inside a dying process where a throwing formatter would itself be the
 * crash. Every field pipeline has its own guard (the class/name reads, the
 * message stringification, the stack probe) and the whole body is wrapped one
 * more time as the belt for a future regression: the fallback object keeps
 * the same five-field shape, so the caller's line, counter and drain always
 * run. The event is normalized fail-closed to the more severe spelling when
 * the caller passes something unexpected; the uptime is clamped at 0 and
 * anything non-numeric becomes 0.
 */
export function crashLine(event: CrashEvent, error: unknown, uptimeMs: number): CrashLine {
  const ev: CrashEvent = event === "unhandledRejection" ? "unhandledRejection" : "uncaughtException";
  try {
    return {
      event: ev,
      class: classOf(error),
      // paths are reduced BEFORE redaction so the room/ip passes and the
      // ceiling see the baselined text
      message: truncate(redact(stripPaths(wash(messageOf(error)))), CRASH_MESSAGE_MAX_CHARS),
      stack: truncate(stripPaths(wash(firstStackFrame(error))), CRASH_STACK_MAX_CHARS),
      uptimeS: uptimeS(uptimeMs),
    };
  } catch {
    // unreachable after the per-field guards — the belt for a future
    // regression: same shape, no content, the crash still counts and drains
    return {
      event: ev,
      class: CRASH_CLASS_FALLBACK,
      message: "crash detail unprintable",
      stack: "",
      uptimeS: uptimeS(uptimeMs),
    };
  }
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
 * every other value: the Object.prototype.toString kind, reduced to the
 * closed KIND_VOCABULARY — a crafted `Symbol.toStringTag` (or a throwing
 * one) can never smuggle free text, a room id or a throw through the class
 * field; anything the vocabulary cannot name degrades to CRASH_KIND_FALLBACK.
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
  return kindOf(error);
}

/**
 * The non-Error kind: guarded like every sibling read (a throwing
 * `Symbol.toStringTag` getter is caught here, never at the caller), tokenized
 * by `firstToken` and held to the closed vocabulary, so the field stays a
 * fixed-vocabulary token in every case.
 */
function kindOf(error: unknown): string {
  let kind = "";
  try {
    kind = Object.prototype.toString.call(error).slice(8, -1);
  } catch {
    return CRASH_KIND_FALLBACK;
  }
  const token = firstToken(kind);
  return token && KIND_VOCABULARY.has(token) ? token : CRASH_KIND_FALLBACK;
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
