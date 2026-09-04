#!/usr/bin/env node
/**
 * P2-146: build the Squirrel.Mac JSON feed (update-mac.json) from a packed
 * dist root.
 *
 * The packaged shell's built-in autoUpdater (Squirrel.Mac) only consumes the
 * JSON feed format ({url, name, notes, pub_date}) — pointing it at an
 * electron-builder `latest-mac.yml` fails outright (spike finding recorded in
 * src/update.ts). Until P2-146 the release workflow only published the yml, so
 * every DMG install resolved to `update-available-manual`: the user saw the
 * release page but the app never updated itself. This module closes that gap:
 *
 *   1. electron-builder.yml mac targets gain `zip` (Squirrel.Mac installs
 *      nothing but a zip — the DMG alone can't be applied);
 *   2. this script validates the dist root (zip present, yml version == tag)
 *      and writes `dist/update-mac.json` with the release-download URL;
 *   3. the release workflow uploads update-mac.json next to the DMG, and
 *      `publicFeedUrl()` hands it to Squirrel.Mac on darwin.
 *
 * Problem reporting mirrors scripts/dist-smoke.mjs: one string per problem,
 * ALL problems printed at once, exit code 1 when any exists (and no feed file
 * written — fail closed, a half-valid feed must not ship).
 *
 * Usage: node scripts/update-feed.mjs [--tag vX.Y.Z] [--dist <path>]
 *        (tag defaults to GITHUB_REF_NAME, dist to apps/desktop/dist)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scripts = fileURLToPath(new URL(".", import.meta.url)); // apps/desktop/scripts
const desktopDir = resolve(scripts, ".."); // apps/desktop

/** Fallback slug when GITHUB_REPOSITORY is unset (local runs). */
export const DEFAULT_REPO_SLUG = "caiovicentino/opencode-remote";

/** The `version:` line of an electron-builder latest-mac.yml, or null. */
export function parseYmlVersion(text) {
  const m = /^version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(text ?? "");
  return m?.[1] ?? null;
}

/** The `releaseDate:` field as ISO (when parseable), else null. */
function parseYmlReleaseDate(text) {
  const m = /^releaseDate:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(text ?? "");
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Minimal yml release-notes reader: inline scalar or `|`/`>` indented block. */
export function parseYmlReleaseNotes(text) {
  const lines = (text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^releaseNotes:\s*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    const inline = m[1]?.trim() ?? "";
    if (inline && !/^[|>]/.test(inline)) return inline.replace(/^["']|["']$/g, "");
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (!/^\s+\S/.test(next)) break;
      block.push(next.trim());
    }
    return block.join("\n");
  }
  return "";
}

/**
 * Pick which dist zip the feed points at. Prefers the artifact the yml itself
 * advertises (`path:` line or a referenced file name — deterministic under
 * multi-arch dist roots), else the first zip in sorted order. Null when the
 * dist carries no zip at all.
 */
export function pickZipName(ymlText, fileNames) {
  const zips = [...(fileNames ?? [])].filter((n) => n.toLowerCase().endsWith(".zip")).sort();
  if (zips.length === 0) return null;
  if (ymlText) {
    const path = /^path:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(ymlText)?.[1];
    if (path && zips.includes(path)) return path;
    const referenced = zips.find((z) => ymlText.includes(z));
    if (referenced) return referenced;
  }
  return zips[0];
}

/**
 * Pure core of the feed builder. Returns { feed, problems }: feed is the
 * Squirrel.Mac JSON document (url/name/notes/pub_date) or null when the
 * problems are fatal (no zip to point at, or the yml/tag contract is broken —
 * publishing such a feed would advertise an update Squirrel can't apply).
 * The download file name is percent-encoded, so artifact names with spaces
 * ("OpenCode Remote-0.2.1-mac.zip") produce valid GitHub download URLs.
 *
 * @param {string} tag release tag (e.g. "v0.3.0")
 * @param {string|null} ymlText contents of latest-mac.yml (null when absent)
 * @param {string[]} fileNames entries of the dist root
 * @param {string} repoSlug GitHub "owner/repo" the release was published on
 */
export function buildSquirrelFeed(tag, ymlText, fileNames, repoSlug) {
  const problems = [];
  const cleanTag = String(tag ?? "").trim();
  const version = cleanTag.replace(/^v/i, "");
  if (!version) problems.push("release tag is empty — pass --tag vX.Y.Z or set GITHUB_REF_NAME");

  const zipName = pickZipName(ymlText, fileNames ?? []);
  if (!zipName) {
    problems.push(
      "missing file: *.zip under dist root — Squirrel.Mac only installs from a zip (add the `zip` target to the electron-builder.yml mac block)",
    );
  }

  const ymlVersion = parseYmlVersion(ymlText);
  if (!ymlVersion) {
    problems.push(
      ymlText == null
        ? "missing file: latest-mac.yml under dist root (electron-builder mac target must run before the feed build)"
        : "latest-mac.yml is unreadable (no `version:` line)",
    );
  } else if (version && ymlVersion !== version) {
    problems.push(`latest-mac.yml version ${ymlVersion} does not match release tag ${cleanTag} (expected ${version})`);
  }

  if (problems.length > 0) return { feed: null, problems };

  const feed = {
    url: `https://github.com/${repoSlug}/releases/download/${cleanTag}/${encodeURIComponent(zipName)}`,
    name: ymlVersion,
    notes: parseYmlReleaseNotes(ymlText),
    pub_date: parseYmlReleaseDate(ymlText) ?? new Date().toISOString(),
  };
  return { feed, problems };
}

function main() {
  const argv = process.argv.slice(2);
  let tag = process.env.GITHUB_REF_NAME?.trim() || null;
  const tagIndex = argv.indexOf("--tag");
  if (tagIndex !== -1 && argv[tagIndex + 1]) tag = argv[tagIndex + 1];
  const tagEq = argv.find((a) => a.startsWith("--tag="));
  if (tagEq) tag = tagEq.slice("--tag=".length);

  let distRoot = join(desktopDir, "dist");
  const distIndex = argv.indexOf("--dist");
  if (distIndex !== -1 && argv[distIndex + 1]) distRoot = resolve(argv[distIndex + 1]);
  const distEq = argv.find((a) => a.startsWith("--dist="));
  if (distEq) distRoot = resolve(distEq.slice("--dist=".length));

  if (!existsSync(distRoot)) {
    console.error(`update-feed: dist root does not exist: ${distRoot}\nrun \`npm run dist --workspace @ocr/desktop\` first`);
    process.exitCode = 1;
    return;
  }
  if (!tag) {
    console.error("update-feed: no release tag — pass --tag vX.Y.Z or set GITHUB_REF_NAME");
    process.exitCode = 1;
    return;
  }

  const files = readdirSync(distRoot);
  const ymlPath = join(distRoot, "latest-mac.yml");
  const ymlText = existsSync(ymlPath) ? readFileSync(ymlPath, "utf8") : null;
  const repoSlug = process.env.GITHUB_REPOSITORY?.trim() || DEFAULT_REPO_SLUG;

  const { feed, problems } = buildSquirrelFeed(tag, ymlText, files, repoSlug);
  if (problems.length > 0) {
    console.error(`update-feed: FAIL ${distRoot}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`update-feed: ${problems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }

  const outPath = join(distRoot, "update-mac.json");
  writeFileSync(outPath, `${JSON.stringify(feed, null, 2)}\n`);
  console.log(`update-feed: OK ${outPath}`);
  console.log(`  url: ${feed.url}`);
  console.log(`  name: ${feed.name}`);
}

// CLI guard: skip main() when imported by the unit test (same pattern as
// scripts/dist-smoke.mjs).
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
