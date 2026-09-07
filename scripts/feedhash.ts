#!/usr/bin/env node
/**
 * P2-308 — feed-declared integrity confrontation for the release workflow.
 *
 * The Windows app (apps/desktop/src/winupdate.ts) fail-closed refuses any
 * installer whose measured sha512 diverges from the digest the feed
 * announces — so a published feed with a mismatched hash blocks every
 * installed Windows machine from updating forever, while the release itself
 * sails green: the release-feeds job checked feed NAMES and VERSIONS only
 * (scripts/feed-consistency.ts) and never hashed a single byte. This module
 * is the missing half of that gate, as pure logic: it receives the entries a
 * sha512-declaring feed declares (file name, sha512 digest in base64, byte
 * size) plus the measurements taken on the published files, and returns the
 * closed list of problems:
 *
 *   - a declared entry with no corresponding measured file;
 *   - a divergent digest;
 *   - a divergent byte size;
 *   - a digest that is absent or outside the expected base64 format;
 *   - a byte size that is absent or not numeric;
 *   - a feed that declares no entries at all.
 *
 * Everything is fail-closed (an unconfirmable value is a problem, never a
 * pass), every problem carries one static sentence, and no problem ever
 * embeds an absolute path — only the file names the caller supplied.
 *
 * parseLatestYmlEntries is the narrow, line-anchored reader for the
 * electron-builder latest.yml shape (the `files:` list with url/sha512/size
 * items) so the workflow's raw feed text can be confronted without a YAML
 * dependency; a feed that does not parse into at least one entry is itself
 * the "no entries" problem.
 *
 * Pure by construction: no file system access, no network, no clocks — the
 * same input always yields exactly the same problem list (pinned by the unit
 * battery). The CLI at the bottom reads one JSON document on stdin (the
 * workflow wires the I/O) and exits 1 when any problem is found:
 *
 *   echo '{"feeds":[{"label":"latest.yml","yml":"..."}],"measured":[...]}' \
 *     | npx tsx scripts/feedhash.ts
 *
 * stdin document shape:
 *   { "feeds":    [{ "label": "latest.yml", "yml": "<raw latest.yml text>" }],
 *     "measured": [{ "fileName": "App Setup 1.1.0.exe",
 *                    "sha512": "<base64>", "size": 74374398 }] }
 */
import { pathToFileURL } from "node:url";

/** One entry as declared by a sha512-declaring feed. Values are unknown on
 * purpose: whatever the feed declares is validated here, never trusted. */
export interface FeedHashEntry {
  /** File name the feed declares (the published artifact it points at). */
  fileName: string;
  /** sha512 digest in base64, as declared by the feed. */
  sha512?: unknown;
  /** Size in bytes, as declared by the feed. */
  size?: unknown;
}

/** A feed label plus the entries it declares, in feed order. */
export interface FeedDeclaration {
  label: string;
  entries: readonly FeedHashEntry[];
}

/** A measurement taken over a published file with node:crypto. A null value
 * means the measurement could not be taken — fail-closed, unconfirmable. */
export interface FeedMeasurement {
  fileName: string;
  sha512: string | null;
  size: number | null;
}

/** Canonical base64: charset + padding, length a multiple of 4 (a sha512
 * digest in base64 is 86 chars + "=="). */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64.test(value);
}

function isByteSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Strip one layer of matching YAML quotes ('...' or "..."). */
function stripQuotes(value: string): string {
  const first = value.charAt(0);
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Narrow reader for the electron-builder latest.yml shape: the `files:` list
 * of `- url:` / `sha512:` / `size:` items. Line-anchored (2-space items,
 * 4-space fields — the shape electron-builder writes and the unit battery
 * fixtures pin), no YAML dependency: any other shape yields fewer or zero
 * entries, and zero entries is itself a fail-closed problem downstream.
 */
export function parseLatestYmlEntries(text: string): FeedHashEntry[] {
  const entries: FeedHashEntry[] = [];
  if (typeof text !== "string" || text.trim().length === 0) return entries;
  let inFiles = false;
  let current: FeedHashEntry | null = null;
  const flush = (): void => {
    if (current) entries.push(current);
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const topKey = /^([A-Za-z][A-Za-z0-9-]*):/.exec(line);
    if (topKey) {
      flush();
      inFiles = topKey[1] === "files";
      continue;
    }
    if (!inFiles) continue;
    const item = /^ {2}-\s*url:\s*(.*?)\s*$/.exec(line);
    if (item) {
      flush();
      current = { fileName: stripQuotes(item[1]) };
      continue;
    }
    if (!current) continue;
    const sha = /^ {4}sha512:\s*(.*?)\s*$/.exec(line);
    if (sha) {
      current.sha512 = stripQuotes(sha[1]);
      continue;
    }
    const size = /^ {4}size:\s*(.*?)\s*$/.exec(line);
    if (size) {
      current.size = /^-?\d+$/.test(size[1]) ? Number(size[1]) : size[1];
    }
  }
  flush();
  return entries;
}

/**
 * Confront every declared entry with the measurements taken on the published
 * files, returning one problem per cause in a stable order (feeds in order,
 * entries in order, digest before size) with no short-circuit between
 * entries or between the two compared fields — every problem is listed at
 * once so a single CI round fixes everything. Empty list means every
 * declared digest and size matches the published bytes.
 */
export function feedHashProblems(
  feeds: readonly FeedDeclaration[],
  measured: readonly FeedMeasurement[],
): string[] {
  const problems: string[] = [];
  for (const feed of feeds) {
    const label = feed.label;
    if (!Array.isArray(feed.entries) || feed.entries.length === 0) {
      problems.push(`${label}: feed declares no entries — fail-closed, there is nothing to confront`);
      continue;
    }
    for (const entry of feed.entries) {
      const name = typeof entry.fileName === "string" ? entry.fileName : "";
      const file = measured.find((m) => m.fileName === name);
      if (!file) {
        problems.push(
          `${label}: entry "${name}" has no corresponding published file in the measured list — fail-closed`,
        );
        continue;
      }
      const declaredDigest = typeof entry.sha512 === "string" ? entry.sha512.trim() : "";
      if (!isBase64(declaredDigest)) {
        problems.push(
          `${label}: entry "${name}" declares no sha512 digest in the expected base64 format — fail-closed`,
        );
      } else if (typeof file.sha512 !== "string" || file.sha512.trim().length === 0) {
        problems.push(`${label}: no sha512 was measured for "${name}" — the declared digest cannot be confirmed`);
      } else if (file.sha512.trim() !== declaredDigest) {
        problems.push(
          `${label}: sha512 of "${name}" does not match the published bytes — declared and measured digests diverge`,
        );
      }
      if (!isByteSize(entry.size)) {
        problems.push(
          `${label}: entry "${name}" declares no byte size in the expected numeric format — fail-closed`,
        );
      } else if (typeof file.size !== "number") {
        problems.push(`${label}: no byte size was measured for "${name}" — the declared size cannot be confirmed`);
      } else if (file.size !== entry.size) {
        problems.push(
          `${label}: byte size of "${name}" does not match the published file — declared ${entry.size}, measured ${file.size}`,
        );
      }
    }
  }
  return problems;
}

// --- CLI: stdin JSON in, problems on stderr, exit 1 on any problem ----------

interface CliInput {
  feeds?: unknown;
  measured?: unknown;
}

function report(label: string, problems: readonly string[]): boolean {
  if (problems.length > 0) {
    console.error(`feedhash: FAIL ${label}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`feedhash: ${problems.length} problem(s) found`);
    console.error(
      "feedhash: a feed whose digest cannot be confirmed refuses the update on every installed machine — the release stays a draft",
    );
    return false;
  }
  console.log(`feedhash: OK ${label} — every declared sha512 digest and byte size matches the published bytes`);
  return true;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}

async function cli(): Promise<void> {
  let parsed: CliInput;
  try {
    parsed = JSON.parse(await readStdin()) as CliInput;
  } catch {
    console.error(
      "feedhash: invalid JSON on stdin — pipe the feed/measurement document (shape in the scripts/feedhash.ts header)",
    );
    process.exitCode = 1;
    return;
  }
  const measured = (Array.isArray(parsed.measured) ? parsed.measured : []).map((m) => {
    const rec = (m ?? {}) as { fileName?: unknown; sha512?: unknown; size?: unknown };
    return {
      fileName: typeof rec.fileName === "string" ? rec.fileName : "",
      sha512: typeof rec.sha512 === "string" ? rec.sha512 : null,
      size: typeof rec.size === "number" ? rec.size : null,
    };
  });
  const feeds: FeedDeclaration[] = [];
  if (Array.isArray(parsed.feeds) && parsed.feeds.length > 0) {
    for (const feed of parsed.feeds as Array<{ label?: unknown; yml?: unknown }>) {
      const declared = (feed ?? {}) as { label?: unknown; yml?: unknown };
      if (typeof declared.label !== "string" || typeof declared.yml !== "string") {
        console.error("feedhash: every feed must carry a string label and the raw yml text — shape in the module header");
        process.exitCode = 1;
        return;
      }
      feeds.push({ label: declared.label, entries: parseLatestYmlEntries(declared.yml) });
    }
  }
  if (feeds.length === 0) {
    console.error("feedhash: no sha512-declaring feed was provided — fail-closed, nothing can be confronted");
    process.exitCode = 1;
    return;
  }
  if (!report(feeds.map((f) => f.label).join(", "), feedHashProblems(feeds, measured))) process.exitCode = 1;
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) void cli();
