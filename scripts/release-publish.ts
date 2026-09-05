#!/usr/bin/env node
/**
 * P2-179: the release goes public only when it is complete.
 *
 * `gh release create` used to publish the release immediately while the
 * installers were still being built minutes later by desktop-dmg and
 * desktop-win: a signing, notarization or packaging failure left a permanent,
 * public, installer-less release on the downloads page — exactly what a
 * stage-5 user hits. The workflow now creates the release as a DRAFT and this
 * module is the final gate that flips it public. publishDecision(isDraft,
 * assetNames, tag) reuses the P2-153 required-asset contract
 * (expectedAssets/missingAssets/tagProblems in scripts/release-assets.ts):
 *
 *   - draft + every required asset attached → publish: true, no problems;
 *   - draft missing any required asset     → publish: false, every missing
 *     label reported at once;
 *   - asset input that is not a list       → publish: false, one problem;
 *   - already-published release            → publish: false, ZERO problems —
 *     a repeated run (workflow re-run, retry) is an idempotent no-op.
 *
 * CLI (same fail-closed pattern as dist-smoke, release-assets and
 * gatekeeper-verify): receives the path of the JSON emitted by
 * `gh release view --json isDraft,tagName,assets`, prints every problem at
 * once and exits 1 — leaving the release a draft for the operator to inspect.
 * Only a clean verdict lets the workflow proceed to
 * `gh release edit --draft=false`.
 *
 * Run: gh release view "$GITHUB_REF_NAME" --json isDraft,tagName,assets > release-view.json
 *      npx tsx scripts/release-publish.ts release-view.json
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { expectedAssets, missingAssets, tagProblems } from "./release-assets";

export interface PublishDecision {
  /** Flip the release public (gh release edit --draft=false)? */
  publish: boolean;
  /** Human-readable one-liner describing the verdict. */
  reason: string;
  /** Everything wrong with the draft, release-assets format, all at once. */
  problems: string[];
}

/** Verdict for going public: publish only a draft with the complete asset list. */
export function publishDecision(isDraft: boolean, assetNames: unknown, tag: string): PublishDecision {
  // Idempotency first: an already-published release is never a failure and
  // never a problem — a re-run must be able to just walk past it.
  if (!isDraft) {
    return {
      publish: false,
      reason: "release is already published — nothing to do",
      problems: [],
    };
  }
  if (!Array.isArray(assetNames)) {
    const got = assetNames === null ? "null" : typeof assetNames;
    return {
      publish: false,
      reason: "asset list is not a list",
      problems: [
        `asset list is not a list — expected the "assets" array from \`gh release view --json assets\`, got ${got}`,
      ],
    };
  }
  if (!assetNames.every((name) => typeof name === "string")) {
    return {
      publish: false,
      reason: "asset list is not a list of names",
      problems: ["asset list carries entries that are not names — every entry must be an asset `name` string"],
    };
  }
  const shape = tagProblems(tag);
  if (shape.length > 0) {
    return { publish: false, reason: "tag is not a valid release tag", problems: shape };
  }
  const missing = missingAssets(expectedAssets(tag), assetNames);
  if (missing.length > 0) {
    return {
      publish: false,
      reason: `draft release is missing ${missing.length} required asset(s)`,
      problems: missing.map((label) => `missing: ${label}`),
    };
  }
  return {
    publish: true,
    reason: `draft release carries every required asset (${expectedAssets(tag).length} checked)`,
    problems: [],
  };
}

/** Shape of `gh release view --json isDraft,tagName,assets`. */
interface ReleaseView {
  isDraft?: unknown;
  tagName?: unknown;
  assets?: unknown;
}

function cli(argv: readonly string[]): void {
  const path = argv[0];
  if (!path) {
    console.error(
      "release-publish: usage: tsx scripts/release-publish.ts <release-view.json>\n" +
        "  (the JSON emitted by `gh release view --json isDraft,tagName,assets`)",
    );
    process.exitCode = 1;
    return;
  }
  let view: ReleaseView;
  try {
    view = JSON.parse(readFileSync(path, "utf8")) as ReleaseView;
  } catch (err) {
    console.error(`release-publish: cannot read the release view JSON — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (typeof view.isDraft !== "boolean") {
    console.error(
      'release-publish: FAIL — the release view carries no boolean "isDraft" field (is `--json isDraft,tagName,assets` missing?)',
    );
    process.exitCode = 1;
    return;
  }
  const tag = typeof view.tagName === "string" ? view.tagName : "";
  // gh hands back asset objects; the verdict only wants their names. Anything
  // else (missing name, non-object) passes through verbatim so the pure
  // verdict flags it instead of silently dropping it.
  const names = Array.isArray(view.assets)
    ? view.assets.map((asset) =>
        asset && typeof asset === "object" && typeof (asset as { name?: unknown }).name === "string"
          ? (asset as { name: string }).name
          : asset,
      )
    : view.assets;
  const verdict = publishDecision(view.isDraft, names, tag);
  if (verdict.problems.length > 0) {
    console.error(`release-publish: FAIL ${tag || "(no tag)"} — ${verdict.reason}`);
    for (const problem of verdict.problems) console.error(`  - ${problem}`);
    console.error(`release-publish: ${verdict.problems.length} problem(s) found — the release stays a draft`);
    process.exitCode = 1;
    return;
  }
  if (verdict.publish) {
    console.log(`release-publish: OK ${tag} — ${verdict.reason}; publishing with \`gh release edit --draft=false\``);
  } else {
    console.log(`release-publish: SKIP ${tag} — ${verdict.reason}`);
  }
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
