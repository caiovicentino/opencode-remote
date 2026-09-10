// P3-393: release-notes sanitizer for the update consent dialog.
//
// The feed's `notes` field (update.ts FeedInfo) is untrusted third-party
// text: release authors paste markdown, HTML, control characters, download
// links and file paths into it. None of that belongs in a native message box
// on a lay user's screen (the P2-140 bar: no path, no address, no secret on
// any user-visible surface), so before the notes line is composed into the
// consent dialog the raw feed text passes through this module.
//
// Same module hygiene as shelllang.ts / updateguard.ts / winupdate.ts: NO
// electron, NO node:fs, no fetch, no I/O of any kind — pure text in, pure
// text out, so the unit battery exercises every branch in plain Node.
//
// Contract (documented, pinned by the tests):
//   1. missing, non-textual or empty input → "" (the dialog then shows only
//      the base detail — never an empty notes block);
//   2. markup is removed: HTML tags, markdown headings, emphasis, inline
//      code, images and links (links keep their visible text only);
//   3. control characters are removed (newlines survive, tabs become spaces);
//   4. any snippet that looks like a path or an address is removed: URL
//      schemes, www. hosts, e-mail addresses, POSIX absolute/home paths,
//      Windows drive paths and bare IPv4 hosts;
//   5. blank-line runs collapse to nothing and every line is trimmed — the
//      excerpt is a compact paragraph block, not the raw document; a line
//      with no letter or number left (pure markup residue) is dropped;
//   6. the result is cut at the documented line ceiling first, then at the
//      documented character ceiling;
//   7. input with no useful content left after 1-5 → "" (fail-empty: a
//      notes field made only of links/markup must not render as clutter);
//   8. deterministic: the same input always yields the same excerpt.

/** Documented ceilings for the dialog excerpt (P3-393). */
export const UPDATE_NOTES_LIMITS = Object.freeze({
  /** At most this many lines survive into the dialog. */
  maxLines: 6,
  /** At most this many characters survive into the dialog. */
  maxChars: 400,
});

/** A standalone address: scheme'd URL, www host or e-mail. */
const ADDRESS_TOKEN = /\b(?:[a-z][a-z0-9+.-]*:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi;

/** A bare IPv4 host (feed notes sometimes link "http://192.168.x.y" without a scheme). */
const BARE_IP_TOKEN = /\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\S+)?/g;

/** A POSIX absolute or home-relative path with at least two segments. */
const POSIX_PATH_TOKEN = /(?:^|[\s(])(?:\/|~\/)[\w.@-]+(?:\/[\w.@-]+)+/g;

/** A Windows drive path (C:\...\b) with at least one segment. */
const WIN_PATH_TOKEN = /\b[A-Za-z]:\\(?:[\w.@-]+\\?)+/g;

/** Control characters except \n (tab is normalized to a space below). */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Sanitize raw feed release notes into a safe native-dialog excerpt. See the
 * module contract above; every rule is pinned by the unit table.
 */
export function sanitizeUpdateNotes(
  input: unknown,
  limits: { maxLines: number; maxChars: number } = UPDATE_NOTES_LIMITS,
): string {
  if (typeof input !== "string") return "";
  let text = input;
  if (!text.trim()) return "";

  // 2. markup first, so a markup character can never hide an address from
  // the sweep below (markdown link → visible text; image → dropped; HTML
  // tag → dropped; emphasis/code fences → their inner text).
  text = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]*>/g, " ")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "");

  // 3. control characters; tabs join words like spaces.
  text = text.replace(CONTROL_CHARS, "").replace(/\t/g, " ");

  // 4. paths and addresses — a second pass over the demarkuped text.
  text = text
    .replace(ADDRESS_TOKEN, " ")
    .replace(BARE_IP_TOKEN, " ")
    .replace(POSIX_PATH_TOKEN, " ")
    .replace(WIN_PATH_TOKEN, " ");

  // 5. compact paragraph block: trim each line, drop blanks and empties.
  //    A line with no letter or number left is markup residue ("***", "—")
  //    — dropped, so genuinely useless input fails empty (rule 7).
  const lines = text
    .split("\n")
    .map((line) => line.trim().replace(/\s{2,}/g, " "))
    .filter((line) => line.length > 0 && /[\p{L}\p{N}]/u.test(line));
  if (lines.length === 0) return "";

  // 6. documented ceilings — lines first, then characters.
  const capped = lines.slice(0, Math.max(0, limits.maxLines)).join("\n");
  const excerpt = capped.length > limits.maxChars ? capped.slice(0, Math.max(0, limits.maxChars)).trimEnd() : capped;

  // 7. fail-empty: nothing useful survived the sweep.
  return excerpt.trim();
}
