#!/usr/bin/env node
/**
 * P2-153: release asset completeness gate for the release workflow.
 *
 * Every packaging job in .github/workflows/release.yml (desktop-dmg,
 * desktop-win) uploads its own artifacts and nothing looked at the final
 * result: a Windows job dying mid-upload left the release public with only a
 * DMG and no signal until a stage-5 user missed their installer — and the
 * P2-131 per-platform update feed answered 404. This module turns the
 * expected-asset list for a tag into a pure, testable contract:
 *
 *   - expectedAssets(tag)  → every download asset a complete release carries,
 *                            each with a human-readable label and its matching
 *                            rule: extension + bare version for the dmg, the
 *                            Squirrel.Mac zip (P2-146) and the NSIS setup exe
 *                            (P2-126); exact name for latest-mac.yml,
 *                            update-mac.json and latest.yml.
 *   - missingAssets(...)   → the expected labels with no matching published
 *                            name.
 *   - tagProblems(tag)     → tag shape problems, same format as
 *                            scripts/release-preflight.ts: empty tag and
 *                            non-semver tag; the leading v is accepted but
 *                            optional, exactly like scripts/relay-image.ts
 *                            (P2-151).
 *
 * Pure logic never touches disk; the CLI reads the published asset names from
 * stdin (one per line, `gh release view --json assets`) or from argv, prints
 * every problem at once and exits 1 — the fail-closed dist-smoke pattern
 * (P2-146 lesson: a half-complete release must never pass silently).
 *
 * Run: gh release view "$GITHUB_REF_NAME" --json assets --jq '.assets[].name' \
 *      | npx tsx scripts/release-assets.ts "$GITHUB_REF_NAME"
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Matching rule for one expected download asset. */
export type AssetMatch =
  /** A file whose name ends with `ext` and carries the bare version (a dmg
   * named after a different version does NOT satisfy the slot). */
  | { kind: "extension+version"; ext: string; version: string }
  /** A file with exactly this name. */
  | { kind: "exact"; name: string };

export interface ExpectedAsset {
  /** Human-readable label, printed (and tested) verbatim. */
  label: string;
  match: AssetMatch;
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Bare semver of a release tag — the leading v is dropped (P2-151). */
export function bareVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * Tag shape problems, in the release-preflight format. Empty list means the
 * tag is a valid semver with or without the leading v.
 */
export function tagProblems(tag: string): string[] {
  const problems: string[] = [];
  if (tag === "") {
    problems.push("tag is empty — expected vX.Y.Z");
  } else if (!SEMVER.test(bareVersion(tag))) {
    problems.push(`tag "${tag}" is not a semver version — expected vX.Y.Z`);
  }
  return problems;
}

/** Every download asset a complete release for `tag` must carry. */
export function expectedAssets(tag: string): ExpectedAsset[] {
  const version = bareVersion(tag);
  return [
    {
      label: `macOS DMG installer (*.dmg carrying ${version})`,
      match: { kind: "extension+version", ext: ".dmg", version },
    },
    {
      label: `macOS Squirrel.Mac zip (*.zip carrying ${version})`,
      match: { kind: "extension+version", ext: ".zip", version },
    },
    {
      label: `Windows NSIS setup (*.exe carrying ${version})`,
      match: { kind: "extension+version", ext: ".exe", version },
    },
    {
      label: "macOS update metadata (latest-mac.yml)",
      match: { kind: "exact", name: "latest-mac.yml" },
    },
    {
      label: "macOS Squirrel.Mac JSON feed (update-mac.json)",
      match: { kind: "exact", name: "update-mac.json" },
    },
    {
      label: "Windows update metadata (latest.yml)",
      match: { kind: "exact", name: "latest.yml" },
    },
  ];
}

/** True when publishedName satisfies the asset's matching rule. */
export function assetMatches(asset: ExpectedAsset, publishedName: string): boolean {
  if (asset.match.kind === "exact") return publishedName === asset.match.name;
  if (!publishedName.toLowerCase().endsWith(asset.match.ext.toLowerCase())) return false;
  // Version token match with boundaries so "10.2.0" never satisfies a 0.2.0
  // slot (plain includes would) while "Setup 0.2.0.exe" still does: the name
  // may not continue the version with another digit — "0.2.0.1", "0.2.01" —
  // but the extension dot right after the version is fine.
  const escaped = asset.match.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.])${escaped}(?!\\.?\\d)`).test(publishedName);
}

/** Expected labels with no matching name among the published ones. */
export function missingAssets(
  expected: readonly ExpectedAsset[],
  published: readonly string[],
): string[] {
  return expected
    .filter((asset) => !published.some((name) => assetMatches(asset, name)))
    .map((asset) => asset.label);
}

function cli(argv: readonly string[]): void {
  const tag = argv[0] ?? process.env.GITHUB_REF_NAME ?? "";
  const nameArgs = argv.slice(1);
  let raw: string;
  if (nameArgs.length > 0) {
    raw = nameArgs.join("\n");
  } else if (process.stdin.isTTY) {
    console.error(
      "release-assets: usage: tsx scripts/release-assets.ts <tag> [names...]\n" +
        "  (asset names one per line, normally piped from\n" +
        "   `gh release view --json assets --jq '.assets[].name'`)",
    );
    process.exitCode = 1;
    return;
  } else {
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      raw = "";
    }
  }
  // Line-based: GitHub asset names contain spaces ("OpenCode Remote Setup
  // 0.2.0.exe"), so whitespace-splitting would shred them.
  const published = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const problems = tagProblems(tag);
  const missing = problems.length === 0 ? missingAssets(expectedAssets(tag), published) : [];
  if (problems.length > 0 || missing.length > 0) {
    console.error(`release-assets: FAIL ${tag}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    for (const label of missing) console.error(`  - missing: ${label}`);
    console.error(`release-assets: ${problems.length + missing.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }
  const expected = expectedAssets(tag);
  console.log(`release-assets: OK ${tag} — all ${expected.length} expected asset(s) published`);
  for (const asset of expected) console.log(`  ${asset.label}`);
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
