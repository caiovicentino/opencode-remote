#!/usr/bin/env node
/**
 * P2-130: release preflight — the tag and the two package.json versions must
 * agree BEFORE anything is published. A drifting version used to produce a
 * `latest-mac.yml` feed whose `version` field does not match the app binary,
 * breaking electron-updater for every already-installed copy; this check runs
 * as the first step of the release job (.github/workflows/release.yml), so a
 * mismatch fails before `gh release create` instead of after.
 *
 * Pure logic (checkTagVersion) never touches disk; the CLI reads the two
 * package.json files and exits 1 listing every problem at once, in the same
 * format as dist-smoke.
 *
 * Run: npx tsx scripts/release-preflight.ts <tag>   (or set GITHUB_REF_NAME)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT_LABEL = "package.json";
export const DESKTOP_LABEL = "apps/desktop/package.json";

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * All problems with a release tag against the two versions the tag ships.
 * Empty list means the tag matches; every problem is reported (not just the
 * first). Non-semver tags short-circuit — comparing versions against them
 * would only produce noise.
 */
export function checkTagVersion(tag: string, rootVersion: string, desktopVersion: string): string[] {
  const problems: string[] = [];
  const bare = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!SEMVER.test(bare)) {
    // One precise problem: with a non-version tag, the missing v is not the
    // real issue — only complain about the shape.
    if (!tag.startsWith("v")) {
      problems.push(`tag "${tag}" must start with "v" and be semver — expected vX.Y.Z`);
    } else {
      problems.push(`tag "${tag}" is not a semver version — expected vX.Y.Z`);
    }
    return problems;
  }
  if (!tag.startsWith("v")) {
    problems.push(`tag "${tag}" must start with "v" (release tags are vX.Y.Z)`);
  }
  if (rootVersion !== bare) {
    problems.push(`${ROOT_LABEL}: version ${rootVersion} does not match tag ${tag}`);
  }
  if (desktopVersion !== bare) {
    problems.push(`${DESKTOP_LABEL}: version ${desktopVersion} does not match tag ${tag}`);
  }
  return problems;
}

/** Version string of a package.json, or null when unreadable/absent. */
function readVersion(path: string, label: string, problems: string[]): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    problems.push(`${label}: has no "version" field`);
  } catch (err) {
    problems.push(`${label}: cannot read version — ${(err as Error).message}`);
  }
  return null;
}

function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
  if (!tag) {
    console.error("release-preflight: usage: tsx scripts/release-preflight.ts <tag>  (or set GITHUB_REF_NAME)");
    process.exitCode = 1;
    return;
  }

  const rootJson = fileURLToPath(new URL("../package.json", import.meta.url));
  const desktopJson = fileURLToPath(new URL("../apps/desktop/package.json", import.meta.url));
  const readProblems: string[] = [];
  const rootVersion = readVersion(rootJson, ROOT_LABEL, readProblems);
  const desktopVersion = readVersion(desktopJson, DESKTOP_LABEL, readProblems);

  const problems = [...readProblems];
  if (rootVersion !== null && desktopVersion !== null) {
    problems.push(...checkTagVersion(tag, rootVersion, desktopVersion));
  }
  if (problems.length > 0) {
    console.error(`release-preflight: FAIL ${tag}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`release-preflight: ${problems.length} problem(s) found`);
    console.error("release-preflight: bump BOTH package.json (root + apps/desktop) together with the tag");
    process.exitCode = 1;
    return;
  }
  console.log(`release-preflight: OK ${tag}`);
  console.log(`  ${ROOT_LABEL} ${rootVersion}`);
  console.log(`  ${DESKTOP_LABEL} ${desktopVersion}`);
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
