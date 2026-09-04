#!/usr/bin/env node
/**
 * P2-157: update-feed consistency gate for the release workflow.
 *
 * P2-153 only checks that the feed FILES are attached to the release — an
 * update-mac.json whose url points at another version's zip, or a latest.yml
 * whose path names an installer that was never uploaded, used to pass green,
 * get published, and then break auto-update (P2-146/P2-131) for every already
 * installed app with no signal until a user complained. This module opens the
 * feeds and checks their CONTENTS against the tag and the list of names
 * actually published:
 *
 *   - update-mac.json: valid JSON; `name` equals the tag version; the `url`'s
 *     last path segment (percent-decoded) is among the published names;
 *   - latest.yml: `version` equals the tag version; `path` is among the
 *     published names.
 *
 * Pure logic (feedProblems) never touches disk; the CLI reads the two feed
 * files by path and the published asset names from stdin (one per line,
 * `gh release view --json assets`), prints every problem at once and exits 1 —
 * the fail-closed dist-smoke/release-assets pattern (P2-146 lesson: a
 * half-valid feed must never ship silently).
 *
 * Run: gh release view "$GITHUB_REF_NAME" --json assets --jq '.assets[].name' \
 *      | npx tsx scripts/feed-consistency.ts "$GITHUB_REF_NAME" \
 *          feeds/update-mac.json feeds/latest.yml
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const JSON_LABEL = "update-mac.json";
export const YML_LABEL = "latest.yml";

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Bare semver of a release tag — the leading v is dropped (P2-151). */
export function bareVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * Value of a top-level `field:` scalar line of an electron-builder feed yml
 * (quoted or bare, spaces allowed — installer names carry them), or null when
 * absent. Line-anchored so indented `files:` entries never match.
 */
export function parseYmlField(text: string, field: string): string | null {
  const m = new RegExp(`^${field}:\\s*["']?([^"'].*?)["']?\\s*$`, "m").exec(text ?? "");
  const value = m?.[1]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

/** Last path segment of a feed URL, percent-decoded (GitHub download URLs
 * encode spaces as %20); null when the URL has no usable path. */
export function lastUrlSegment(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const raw = pathname.split("/").filter(Boolean).pop();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * All problems with a tag's update feeds against the asset names actually
 * published in the release. Empty list means both feeds point at this tag's
 * artifacts. Tag shape problems (empty / non-semver, P2-151: leading v
 * optional) short-circuit — comparing versions against them would only
 * produce noise, exactly like scripts/release-preflight.ts.
 */
export function feedProblems(
  tag: string,
  jsonText: string,
  ymlText: string,
  published: readonly string[],
): string[] {
  if (tag === "") return ["tag is empty — expected vX.Y.Z"];
  const version = bareVersion(tag);
  if (!SEMVER.test(version)) {
    return [`tag "${tag}" is not a semver version — expected vX.Y.Z`];
  }

  const problems: string[] = [];

  // 1. Squirrel.Mac JSON feed (P2-146 shape: {url, name, notes, pub_date}).
  let feed: { url?: unknown; name?: unknown } | null = null;
  try {
    const parsed: unknown = JSON.parse(jsonText ?? "");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      feed = parsed as { url?: unknown; name?: unknown };
    } else {
      problems.push(`${JSON_LABEL}: not a JSON object`);
    }
  } catch (err) {
    problems.push(`${JSON_LABEL}: invalid JSON — ${(err as Error).message}`);
  }
  if (feed) {
    if (typeof feed.name === "string" && feed.name.length > 0) {
      if (feed.name !== version) {
        problems.push(
          `${JSON_LABEL}: "name" ${feed.name} does not match release tag ${tag} (expected ${version})`,
        );
      }
    } else {
      problems.push(`${JSON_LABEL}: has no "name" field`);
    }
    if (typeof feed.url === "string" && feed.url.length > 0) {
      const fileName = lastUrlSegment(feed.url);
      if (!fileName) {
        problems.push(`${JSON_LABEL}: "url" has no file name in its path — ${feed.url}`);
      } else if (!published.includes(fileName)) {
        problems.push(
          `${JSON_LABEL}: "url" points to "${fileName}" which is not published in this release`,
        );
      }
    } else {
      problems.push(`${JSON_LABEL}: has no "url" field`);
    }
  }

  // 2. electron-builder Windows feed (latest.yml).
  const ymlVersion = parseYmlField(ymlText ?? "", "version");
  if (!ymlVersion) {
    problems.push(`${YML_LABEL}: has no "version" field`);
  } else if (ymlVersion !== version) {
    problems.push(
      `${YML_LABEL}: version ${ymlVersion} does not match release tag ${tag} (expected ${version})`,
    );
  }
  const ymlPath = parseYmlField(ymlText ?? "", "path");
  if (!ymlPath) {
    problems.push(`${YML_LABEL}: has no "path" field`);
  } else if (!published.includes(ymlPath)) {
    problems.push(`${YML_LABEL}: "path" points to "${ymlPath}" which is not published in this release`);
  }

  return problems;
}

function cli(argv: readonly string[]): void {
  const [tag, jsonPath, ymlPath] = argv;
  if (!tag || !jsonPath || !ymlPath) {
    console.error(
      "feed-consistency: usage: tsx scripts/feed-consistency.ts <tag> <update-mac.json> <latest.yml>\n" +
        "  (published asset names one per line on stdin, normally piped from\n" +
        "   `gh release view --json assets --jq '.assets[].name'`)",
    );
    process.exitCode = 1;
    return;
  }

  let rawNames: string;
  if (process.stdin.isTTY) {
    console.error(
      "feed-consistency: no published asset names on stdin — pipe them from\n" +
        "  `gh release view <tag> --json assets --jq '.assets[].name'`",
    );
    process.exitCode = 1;
    return;
  }
  try {
    rawNames = readFileSync(0, "utf8");
  } catch {
    rawNames = "";
  }
  const published = rawNames
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Fail-closed: an unreadable feed is itself a problem (all problems listed
  // at once, exit 1 — never a silent pass).
  const readProblems: string[] = [];
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      readProblems.push(`cannot read ${path} — ${(err as Error).message}`);
      return "";
    }
  };
  const jsonText = read(jsonPath);
  const ymlText = read(ymlPath);
  if (readProblems.length > 0) {
    console.error(`feed-consistency: FAIL ${tag}`);
    for (const problem of readProblems) console.error(`  - ${problem}`);
    console.error(`feed-consistency: ${readProblems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }

  const problems = feedProblems(tag, jsonText, ymlText, published);
  if (problems.length > 0) {
    console.error(`feed-consistency: FAIL ${tag}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`feed-consistency: ${problems.length} problem(s) found`);
    console.error("feed-consistency: the release is only complete when both feeds point at this tag's artifacts");
    process.exitCode = 1;
    return;
  }
  console.log(`feed-consistency: OK ${tag} — both update feeds point at this release's artifacts`);
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
