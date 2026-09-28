#!/usr/bin/env node
/**
 * eval-16: keep the release body under GitHub's ceiling.
 *
 * GitHub refuses a release whose body exceeds 125,000 characters (HTTP 422
 * "body is too long (maximum is 125000 characters)"). The release job used to
 * create the draft with `gh release create --generate-notes`, which (without
 * --notes-start-tag) asks the server to generate the notes from EVERY merged
 * PR since the previous release. The repository has never been released, so
 * the first release would carry the whole history: measured on 2026-09-27
 * through the same Release Notes API (POST /releases/generate-notes,
 * tag_name=v0.2.0, target main) the body is 203,972 characters / 1,386 lines
 * — the create call (or, at the latest, the P2-216 download-guide edit, which
 * PATCHes the full body back) dies before a single installer is attached.
 *
 * capReleaseNotes() is pure: it returns the body unchanged when it fits the
 * budget, and otherwise keeps the header and the NEWEST entries of the first
 * bullet list (GitHub lists merged PRs oldest first, so the tail is the most
 * recent work), states how many earlier entries were left out, and keeps the
 * trailing "**Full Changelog**" line that links the complete history. The
 * budget (RELEASE_NOTES_BUDGET_CHARS) leaves headroom below the hard ceiling
 * for the download guide release-notes.ts prepends later; that CLI checks the
 * final body against RELEASE_BODY_MAX_CHARS itself.
 *
 * CLI (same fail-closed pattern as release-publish / release-notes):
 *   tsx scripts/release-body.ts <tag> <generated.md> <out.md>
 * reads the generated notes, writes the capped body to <out.md> and prints one
 * verdict line. Exit 1 on a usage error or an unreadable/unwritable file —
 * nothing is created on GitHub by this script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** GitHub's hard ceiling for a release body, in characters. */
export const RELEASE_BODY_MAX_CHARS = 125_000;

/** Budget for the generated notes — leaves room below the ceiling for the
 * download guide (release-notes.ts) the release-publish job prepends. */
export const RELEASE_NOTES_BUDGET_CHARS = 100_000;

export interface CappedNotes {
  /** The body to publish — never longer than the budget. */
  body: string;
  /** How many list entries were left out (0 when unchanged). */
  omitted: number;
  /** True when the input did not fit and was capped. */
  capped: boolean;
}

const BULLET = /^\s*[*-]\s/;
const FULL_CHANGELOG = /^\*\*Full Changelog\*\*/;

/** The note that replaces the omitted entries — one bullet, so the list still reads as a list. */
export function omissionLine(omitted: number): string {
  return `* … ${omitted} earlier change(s) are not listed here — a GitHub release body is capped at ${RELEASE_BODY_MAX_CHARS.toLocaleString("en-US")} characters; the Full Changelog link below has the complete history.`;
}

/**
 * The body capped to `budget` characters. Unchanged (byte for byte) when it
 * already fits. Otherwise: everything before the first bullet run (the
 * "## What's Changed" header), the omission line, the newest bullets that fit,
 * and the trailing "**Full Changelog**" line when the input had one. A body
 * with no bullet run at all degrades to its first lines plus the changelog
 * line — never longer than the budget.
 */
export function capReleaseNotes(body: string, budget: number = RELEASE_NOTES_BUDGET_CHARS): CappedNotes {
  if (body.length <= budget) return { body, omitted: 0, capped: false };
  const lines = body.split("\n");
  const changelog = lines.find((line) => FULL_CHANGELOG.test(line)) ?? "";
  const tail = changelog ? `\n\n${changelog}\n` : "\n";

  const first = lines.findIndex((line) => BULLET.test(line));
  if (first === -1) {
    // No list to trim: keep whole leading lines while they fit.
    const kept: string[] = [];
    let size = tail.length;
    for (const line of lines) {
      if (FULL_CHANGELOG.test(line)) continue;
      if (size + line.length + 1 > budget) break;
      kept.push(line);
      size += line.length + 1;
    }
    return { body: `${kept.join("\n").trimEnd()}${tail}`, omitted: 0, capped: true };
  }
  let end = first;
  while (end < lines.length && BULLET.test(lines[end] ?? "")) end++;
  const bullets = lines.slice(first, end);
  const head = lines.slice(0, first).join("\n");
  const prefix = head.length > 0 ? `${head}\n` : "";

  // Newest entries first: walk the run from its end while the result fits.
  // The omission line's length depends on the count, so reserve the widest
  // possible count (every bullet omitted) — the result can only be shorter.
  const reserve = prefix.length + omissionLine(bullets.length).length + 1 + tail.length;
  const kept: string[] = [];
  let size = reserve;
  for (let i = bullets.length - 1; i >= 0; i--) {
    const line = bullets[i] ?? "";
    if (size + line.length + 1 > budget) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  const omitted = bullets.length - kept.length;
  const listed = [omissionLine(omitted), ...kept].join("\n");
  let capped = `${prefix}${listed}${tail}`;
  if (capped.length > budget) {
    // Pathological header (larger than the budget itself): drop it.
    capped = `${listed}${tail}`.slice(0, budget);
  }
  return { body: capped, omitted, capped: true };
}

function cli(argv: readonly string[]): void {
  const [tag = "", inPath = "", outPath = ""] = argv;
  if (!tag || !inPath || !outPath) {
    console.error(
      "release-body: usage: tsx scripts/release-body.ts <tag> <generated.md> <out.md>\n" +
        "  (generated.md: the body from POST /repos/{owner}/{repo}/releases/generate-notes)",
    );
    process.exitCode = 1;
    return;
  }
  let generated: string;
  try {
    generated = readFileSync(inPath, "utf8");
  } catch (err) {
    console.error(`release-body: cannot read the generated notes — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const result = capReleaseNotes(generated);
  try {
    writeFileSync(outPath, result.body, "utf8");
  } catch (err) {
    console.error(`release-body: cannot write the release body — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    result.capped
      ? `release-body: CAPPED ${tag} — ${generated.length} → ${result.body.length} chars, ${result.omitted} earlier entr(ies) left to the Full Changelog link`
      : `release-body: OK ${tag} — ${result.body.length} chars (under the ${RELEASE_NOTES_BUDGET_CHARS}-char budget, unchanged)`,
  );
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
