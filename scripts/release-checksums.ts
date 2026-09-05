#!/usr/bin/env node
/**
 * P2-186: a release download you cannot verify is a download you must trust.
 * Until now no release asset carried a checksum: a naive user, a corporate
 * mirror or a third-party cask had no way to confirm that the DMG/exe they
 * downloaded is the exact bytes CI produced, and P2-183 proved signing alone
 * does not close the gap (it only ever covers Windows). This module is the
 * checksum contract for the release workflow:
 *
 *   - checksumLines(entries)    → the canonical manifest in coreutils format:
 *                                 one line per asset, `<64-hex>  <name>`
 *                                 (two spaces), sorted by name, unix line
 *                                 endings and a final newline — so the OS
 *                                 standard tool verifies it without any
 *                                 translation (sha256sum -c / shasum -a 256 -c).
 *   - checksumProblems(...)     → everything wrong with a candidate entry
 *                                 list, same all-at-once string[] format as
 *                                 scripts/release-assets.ts and
 *                                 scripts/release-publish.ts, reusing the
 *                                 required-asset list from release-assets.ts
 *                                 by import (never duplicated): empty list,
 *                                 repeated name, hash that is not exactly 64
 *                                 lowercase hex digits, name with a space or
 *                                 a path separator, name equal to the
 *                                 manifest itself, and any required download
 *                                 asset absent from the list. Input that is
 *                                 not a list is a problem too.
 *
 * CLI (same fail-closed pattern as dist-smoke, release-assets,
 * gatekeeper-verify, release-publish and authenticode-verify): the tag comes
 * from argv, the entries from a JSON file path, and the manifest is written to
 * the requested output path. When the entries carry ANY problem every one of
 * them is printed at once and the process exits 1 — the release stays a draft
 * (P2-179 contract) instead of publishing unverifiable downloads.
 *
 * Run: npx tsx scripts/release-checksums.ts "$GITHUB_REF_NAME" entries.json checksums.txt
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { expectedAssets, missingAssets } from "./release-assets";

/** Name the manifest itself is published under — no asset may carry it. */
export const MANIFEST_NAME = "checksums.txt";

/** One checksummed release asset: its file name and lowercase sha256 digest. */
export interface ChecksumEntry {
  name: string;
  hash: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Canonical coreutils-format manifest: `<hash>  <name>` lines sorted by name
 * (byte-wise, locale-independent so the output is byte-for-byte stable),
 * joined with unix line endings and always terminated by a final newline.
 */
export function checksumLines(entries: readonly ChecksumEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted.map((entry) => `${entry.hash}  ${entry.name}`).join("\n") + "\n";
}

/**
 * Every problem with a candidate checksum entry list for `tag`, all at once.
 * `entries` is unknown by design — the JSON comes from the workflow (or a
 * human) and any shape drift must be reported, never thrown. An empty list of
 * problems means the manifest can be generated and attached as-is.
 */
export function checksumProblems(entries: unknown, tag: string): string[] {
  if (!Array.isArray(entries)) {
    const got = entries === null ? "null" : typeof entries;
    return [
      `checksum list is not a list — expected an array of {name, hash} entries, got ${got}`,
    ];
  }
  const problems: string[] = [];
  if (entries.length === 0) {
    problems.push(
      "checksum list is empty — a manifest needs one entry per download asset",
    );
  }
  const names: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const name =
      entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
    const hash =
      entry && typeof entry === "object" ? (entry as { hash?: unknown }).hash : undefined;
    if (typeof name !== "string" || name.length === 0 || typeof hash !== "string") {
      problems.push(
        `entry #${index} is not a {name, hash} pair — every entry needs an asset name and a sha256 hash string`,
      );
      return;
    }
    if (!SHA256_RE.test(hash)) {
      problems.push(
        `hash for "${name}" is not a lowercase sha256 digest — expected exactly 64 hex digits (0-9a-f)`,
      );
    }
    if (name.includes(" ")) {
      problems.push(`name "${name}" contains a space — asset names must be space-free`);
    }
    if (name.includes("/") || name.includes("\\")) {
      problems.push(
        `name "${name}" contains a path separator — manifest entries are flat asset names`,
      );
    }
    if (name === MANIFEST_NAME) {
      problems.push(
        `name "${name}" is the manifest itself — a release cannot checksum its own checksum file`,
      );
    }
    if (seen.has(name)) {
      problems.push(`name "${name}" is repeated — one entry per asset`);
    }
    seen.add(name);
    names.push(name);
  });
  // The P2-153 required-download contract, by import instead of a copy: a
  // manifest that skips a required installer/feed is just as broken as a
  // release that skips the asset itself.
  for (const label of missingAssets(expectedAssets(tag), names)) {
    problems.push(`missing: ${label}`);
  }
  return problems;
}

function cli(argv: readonly string[]): void {
  const tag = argv[0] ?? "";
  const entriesPath = argv[1] ?? "";
  const outPath = argv[2] ?? "";
  if (tag === "" || entriesPath === "" || outPath === "") {
    console.error(
      "release-checksums: usage: tsx scripts/release-checksums.ts <tag> <entries.json> <manifest-out>\n" +
        `  (entries.json: an array of {name, hash} pairs, one per download asset;\n` +
        `   the manifest is written to <manifest-out> as ${MANIFEST_NAME})`,
    );
    process.exitCode = 1;
    return;
  }
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(entriesPath, "utf8"));
  } catch (err) {
    console.error(`release-checksums: cannot read the entries JSON — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const problems = checksumProblems(entries, tag);
  if (problems.length > 0) {
    console.error(`release-checksums: FAIL ${tag}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`release-checksums: ${problems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }
  const manifest = checksumLines(entries as ChecksumEntry[]);
  try {
    writeFileSync(outPath, manifest, "utf8");
  } catch (err) {
    console.error(`release-checksums: cannot write the manifest — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const count = manifest.split("\n").length - 1;
  console.log(`release-checksums: OK ${tag} — ${count} sha256 line(s) written to ${outPath}`);
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
