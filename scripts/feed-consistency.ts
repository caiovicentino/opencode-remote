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
 * P2-212: since P2-191 the packaged shell (publicFeedUrl in
 * apps/desktop/src/update.ts) consumes the two PER-ARCHITECTURE feeds instead
 * of the alias — update-mac-arm64.json on Apple Silicon, update-mac-x64.json
 * on Intel — so exactly those two feeds were never content-checked. Both are
 * now held to the same bar, plus the architecture itself: the file the `url`
 * points at must carry the feed's own arch token, so an arm64 feed pointing
 * at the x64 zip (or vice versa) is a problem — an Intel Mac would otherwise
 * be handed an update that never runs, forever. The legacy update-mac.json
 * alias must stay identical to the arm64 document (the P2-191 contract): it
 * exists only for the pre-P2-191 installed base, and a drifted alias is the
 * same stale-feed failure under an old name.
 *
 * Pure logic (feedProblems / archFeedProblems) never touches disk; the CLI
 * reads the feed files by path and the published asset names from stdin (one
 * per line, `gh release view --json assets`), prints every problem at once
 * and exits 1 — the fail-closed dist-smoke/release-assets pattern (P2-146
 * lesson: a half-valid feed must never ship silently). A missing or
 * unreadable feed file is itself an explicit problem, never a silent skip.
 *
 * Run: gh release view "$GITHUB_REF_NAME" --json assets --jq '.assets[].name' \
 *      | npx tsx scripts/feed-consistency.ts "$GITHUB_REF_NAME" \
 *          feeds/update-mac.json feeds/latest.yml \
 *          feeds/update-mac-arm64.json feeds/update-mac-x64.json
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const JSON_LABEL = "update-mac.json";
export const YML_LABEL = "latest.yml";
export const ARM64_LABEL = "update-mac-arm64.json";
export const X64_LABEL = "update-mac-x64.json";

/** Architectures the macOS per-feed gate distinguishes (P2-191). */
export const MAC_FEED_ARCHES = ["arm64", "x64"] as const;

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Bare semver of a release tag — the leading v is dropped (P2-151). */
export function bareVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * Architecture token carried by a file name ("OpenCode-Remote-0.3.0-arm64.zip"
 * → "arm64"), or null when the name carries none. Same boundary discipline as
 * update-feed.mjs / release-assets.ts (P2-191): the token must sit on a [-_.]
 * boundary so "x64" never matches inside "x86_64" and "arm64" never inside
 * "arm64e"; the extension is stripped first so the trailing dot never
 * participates. A legacy arch-less name ("OpenCode Remote-0.3.0-mac.zip")
 * matches nothing — by design: a per-arch feed must point at a zip that is
 * unambiguously its own architecture.
 */
export function archOfFileName(fileName: string): string | null {
  const base = String(fileName ?? "").replace(/\.[^.]+$/, "");
  for (const arch of MAC_FEED_ARCHES) {
    if (new RegExp(`(^|[-_.])${arch}([-_.]|$)`, "i").test(base)) return arch;
  }
  return null;
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

/** Tag shape problems (empty / non-semver, P2-151: leading v optional) —
 * shared by both pure entry points so their short-circuit never diverges. */
function tagShapeProblems(tag: string): string[] {
  if (tag === "") return ["tag is empty — expected vX.Y.Z"];
  const version = bareVersion(tag);
  if (!SEMVER.test(version)) {
    return [`tag "${tag}" is not a semver version — expected vX.Y.Z`];
  }
  return [];
}

/**
 * Squirrel.Mac JSON feed shape check, shared by the legacy alias (no arch
 * expectation) and the P2-212 per-arch feeds (expectedArch set). Appends to
 * `problems` — one entry per defect, never short-circuiting between fields.
 */
function jsonFeedProblems(
  problems: string[],
  label: string,
  text: string,
  version: string,
  tag: string,
  published: readonly string[],
  expectedArch: string | null = null,
): void {
  let feed: { url?: unknown; name?: unknown } | null = null;
  try {
    const parsed: unknown = JSON.parse(text ?? "");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      feed = parsed as { url?: unknown; name?: unknown };
    } else {
      problems.push(`${label}: not a JSON object`);
    }
  } catch (err) {
    problems.push(`${label}: invalid JSON — ${(err as Error).message}`);
  }
  if (!feed) return;
  if (typeof feed.name === "string" && feed.name.length > 0) {
    if (feed.name !== version) {
      problems.push(
        `${label}: "name" ${feed.name} does not match release tag ${tag} (expected ${version})`,
      );
    }
  } else {
    problems.push(`${label}: has no "name" field`);
  }
  if (typeof feed.url === "string" && feed.url.length > 0) {
    const fileName = lastUrlSegment(feed.url);
    if (!fileName) {
      problems.push(`${label}: "url" has no file name in its path — ${feed.url}`);
    } else if (!published.includes(fileName)) {
      problems.push(
        `${label}: "url" points to "${fileName}" which is not published in this release`,
      );
    } else if (expectedArch && archOfFileName(fileName) !== expectedArch) {
      problems.push(
        `${label}: "url" points to "${fileName}" which does not carry the ${expectedArch} architecture — the ${expectedArch} feed must install the ${expectedArch} zip`,
      );
    }
  } else {
    problems.push(`${label}: has no "url" field`);
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
  const shape = tagShapeProblems(tag);
  if (shape.length > 0) return shape;
  const version = bareVersion(tag);

  const problems: string[] = [];

  // 1. Squirrel.Mac JSON feed (P2-146 shape: {url, name, notes, pub_date}) —
  //    the legacy alias, consumed by the pre-P2-191 installed base.
  jsonFeedProblems(problems, JSON_LABEL, jsonText, version, tag, published);

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

/**
 * P2-212: the same bar for the two feeds real machines actually consult —
 * update-mac-arm64.json (Apple Silicon) and update-mac-x64.json (Intel) —
 * plus the P2-191 alias contract. Each per-arch feed must parse as a JSON
 * object, carry `name` equal to the tag version, point its `url` at a
 * published file, and that file must carry the feed's own architecture token:
 * an arm64 feed pointing at the x64 zip (or vice versa) would hand a Mac an
 * update that does not run on it. The legacy update-mac.json alias must stay
 * identical to the arm64 document — it exists only for the pre-P2-191
 * installed base, and a drifted alias is a stale feed under an old name.
 * Empty or whitespace-only feed text is itself an explicit problem: a missing
 * or unreadable feed is never silently skipped (fail-closed). Tag shape
 * problems short-circuit exactly like feedProblems.
 */
export function archFeedProblems(
  tag: string,
  aliasText: string,
  arm64Text: string,
  x64Text: string,
  published: readonly string[],
): string[] {
  const shape = tagShapeProblems(tag);
  if (shape.length > 0) return shape;
  const version = bareVersion(tag);

  const problems: string[] = [];
  const empty = (text: string): boolean => !text || text.trim().length === 0;

  const perArch: ReadonlyArray<readonly [string, string, string]> = [
    [ARM64_LABEL, arm64Text, "arm64"],
    [X64_LABEL, x64Text, "x64"],
  ];
  for (const [label, text, arch] of perArch) {
    if (empty(text)) {
      problems.push(`${label}: feed is empty — a missing or unreadable feed is a problem, never a silent skip`);
      continue;
    }
    jsonFeedProblems(problems, label, text, version, tag, published, arch);
  }

  // P2-191 alias contract: update-mac.json is a byte-identical alias of the
  // arm64 document (update-feed.mjs writes the same text to both). Compared
  // trimmed so a trailing newline never fails an otherwise identical alias;
  // skipped when the arm64 document itself is empty — that problem is
  // already reported above and comparing against it would only add noise.
  if (empty(arm64Text)) {
    // arm64 problem already reported; alias comparison would be noise.
  } else if (empty(aliasText)) {
    problems.push(`${JSON_LABEL}: feed is empty — a missing or unreadable feed is a problem, never a silent skip`);
  } else if (aliasText.trim() !== arm64Text.trim()) {
    problems.push(
      `${JSON_LABEL}: alias content differs from ${ARM64_LABEL} — the legacy alias exists only for the installed base and must stay identical to the arm64 document (P2-191)`,
    );
  }

  return problems;
}

function cli(argv: readonly string[]): void {
  const [tag, jsonPath, ymlPath, arm64Path, x64Path] = argv;
  if (!tag || !jsonPath || !ymlPath || !arm64Path || !x64Path) {
    console.error(
      "feed-consistency: usage: tsx scripts/feed-consistency.ts <tag> <update-mac.json> <latest.yml> <update-mac-arm64.json> <update-mac-x64.json>\n" +
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

  // Fail-closed: an unreadable feed is itself a problem, and is reported
  // before any content check — the release cannot be verified without the
  // files, so comparing whatever else against empty text would only be noise.
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
  const arm64Text = read(arm64Path);
  const x64Text = read(x64Path);

  // Tag shape problems short-circuit exactly as before (comparing a version
  // against an invalid tag would only produce noise); unreadable feeds fail
  // closed before any content check. Everything else — every feed, every
  // defect — is collected and printed in one pass.
  const shape = tagShapeProblems(tag);
  const problems =
    readProblems.length > 0
      ? readProblems
      : shape.length > 0
        ? shape
        : [
            ...feedProblems(tag, jsonText, ymlText, published),
            ...archFeedProblems(tag, jsonText, arm64Text, x64Text, published),
          ];

  if (problems.length > 0) {
    console.error(`feed-consistency: FAIL ${tag}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`feed-consistency: ${problems.length} problem(s) found`);
    console.error("feed-consistency: the release is only complete when every update feed points at this tag's artifacts");
    process.exitCode = 1;
    return;
  }
  console.log(`feed-consistency: OK ${tag} — all update feeds point at this release's artifacts`);
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
