#!/usr/bin/env node
/**
 * P2-151: relay image tagger for the release workflow.
 *
 * deploy/relay/Dockerfile used to exist without a CI job building it — the
 * stage-4 operator had to compile the image by hand on their own host and a
 * broken Dockerfile only surfaced there, after the release was published
 * (the exact gap P2-147 closed for the desktop packaging). The relay-image
 * job in .github/workflows/release.yml runs this CLI to turn the git tag
 * into the two GHCR references it builds and (opt-in) pushes.
 *
 * Pure logic (imageTags) never touches disk; the CLI reads argv +
 * $GITHUB_OUTPUT and, mirroring release-preflight, exits 1 listing every
 * problem at once and writes no output when anything is wrong — a half-valid
 * reference must never reach `docker build -t`.
 *
 * Run: npx tsx scripts/relay-image.ts <tag> [owner/repo]
 * (tag defaults to GITHUB_REF_NAME, slug to GITHUB_REPOSITORY)
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface RelayImageTags {
  /** `ghcr.io/<lowercase owner/name>:<bare semver>` — empty when problems exist. */
  versionRef: string;
  /** `ghcr.io/<lowercase owner/name>:latest` — empty when problems exist. */
  latestRef: string;
  problems: string[];
}

/**
 * GHCR references for a release tag against a repository slug. GHCR owners
 * and image names are case-insensitive but lowercase-canonical, so the slug
 * is normalized. Docker tags carry the bare semver (the leading `v` of the
 * git tag is dropped), which also makes `v0.2.0` and `0.2.0` agree.
 * Fail-closed: with any problem, both references come back empty.
 */
export function imageTags(tag: string, slug: string): RelayImageTags {
  const problems: string[] = [];
  const bare = tag.startsWith("v") ? tag.slice(1) : tag;
  if (tag === "") {
    problems.push('tag is empty — expected vX.Y.Z');
  } else if (!SEMVER.test(bare)) {
    // One precise problem: with a non-version tag, the missing v is not the
    // real issue — only complain about the shape.
    problems.push(`tag "${tag}" is not a semver version — expected vX.Y.Z`);
  }
  if (!slug.includes("/")) {
    problems.push(`slug "${slug}" must contain a "/" — expected "owner/repo"`);
  }
  if (problems.length > 0) return { versionRef: "", latestRef: "", problems };
  const repo = slug.toLowerCase();
  return {
    versionRef: `ghcr.io/${repo}:${bare}`,
    latestRef: `ghcr.io/${repo}:latest`,
    problems,
  };
}

function cli(argv: readonly string[]): void {
  const tag = argv[0] ?? process.env.GITHUB_REF_NAME ?? "";
  const slug = argv[1] ?? process.env.GITHUB_REPOSITORY ?? "";
  const { versionRef, latestRef, problems } = imageTags(tag, slug);
  if (problems.length > 0) {
    console.error(`relay-image: FAIL ${tag}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`relay-image: ${problems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }
  console.log(`relay-image: ${versionRef}`);
  console.log(`relay-image: ${latestRef}`);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return; // local run: the printed lines are the whole interface
  appendFileSync(output, `version-ref=${versionRef}\nlatest-ref=${latestRef}\n`);
}

// CLI guard: run the GITHUB_OUTPUT mode only when executed directly.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
