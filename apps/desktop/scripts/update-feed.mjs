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
 *      and writes `dist/update-mac-arm64.json`, `dist/update-mac-x64.json`
 *      and `dist/update-mac.json` — the last one a byte-identical alias of
 *      the arm64 document so the pre-P2-191 installed base keeps its update
 *      path (P2-191);
 *   3. the release workflow uploads update-mac*.json next to the DMG, and
 *      `publicFeedUrl()` hands the architecture's feed to Squirrel.Mac on
 *      darwin.
 *
 * Problem reporting mirrors scripts/dist-smoke.mjs: one string per problem,
 * ALL problems printed at once, exit code 1 when any exists (and no feed file
 * written — fail closed, a half-valid feed must not ship).
 *
 * P3-458: the script also declares the gradual rollout (P2-342) when the
 * ROLLOUT_PERCENT environment variable is set (the release workflow passes
 * its optional `rollout_percent` input through). Without the variable NOTHING
 * is added — the feeds leave byte for byte as this script always wrote them.
 * With a valid integer 0..100 the three update-mac JSON feeds gain
 * `rolloutPercent` (ROLLOUT_JSON_FIELD). With an invalid value the script
 * exits 1 listing the problem BEFORE writing anything — fail closed: a
 * misconfigured percentage must never ship, and the validity rule lives in
 * the single shared validator apps/desktop/scripts/rolloutpercent.mjs so
 * every writer (this script and the future release-rewriting tool) can never
 * drift from the client reader (updaterollout.ts).
 *
 * `--staging-yml` switches to the Windows side of the release: the mode only
 * injects a top-level `stagingPercentage:` line (ROLLOUT_YML_FIELD — the
 * field electron-updater's own staged rollout reads) into `<dist>/latest.yml`
 * — the file electron-builder writes on the windows runner, where this
 * script runs for exactly this purpose — and never builds the Squirrel JSON
 * feeds (the mac dist root has no latest.yml and the windows dist root has
 * no mac zips). Same validation, same no-input no-op: a blank/absent
 * ROLLOUT_PERCENT leaves latest.yml byte for byte as electron-builder wrote
 * it. The mac dist root's latest-mac.yml is deliberately never touched — no
 * consumer reads it (the macOS client consumes the JSON feeds), so the
 * percentage ships only where it counts.
 *
 * Usage: node scripts/update-feed.mjs [--tag vX.Y.Z] [--dist <path>]
 *        (tag defaults to GITHUB_REF_NAME, dist to apps/desktop/dist)
 *        node scripts/update-feed.mjs --staging-yml [--dist <path>]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRolloutPercent, ROLLOUT_JSON_FIELD, ROLLOUT_YML_FIELD } from "./rolloutpercent.mjs";

/** P3-458: the argv flag that switches to the Windows side of the job —
 * inject `stagingPercentage` into <dist>/latest.yml only. Declared once so
 * the workflow step and the tests cite the same string. */
export const STAGING_YML_MODE = "--staging-yml";

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

/** Architectures the macOS release must ship, in feed-document order. */
export const MAC_FEED_ARCHES = ["arm64", "x64"];

/**
 * Architecture token of a dist file name ("OpenCode-Remote-0.3.0-arm64.zip" →
 * "arm64"), or null when the name carries no architecture. The token must sit
 * on a [-_.] boundary so "x64" never matches inside "arm64"/"x86_64" and
 * "arm64" never matches inside "arm64e"; the extension is stripped first so
 * the trailing dot never participates. A legacy arch-less name
 * ("OpenCode-Remote-0.3.0-mac.zip") matches nothing — by design (P2-191): a
 * feed must never point an architecture at the wrong build.
 */
export function archOfFileName(fileName) {
  const base = String(fileName ?? "").replace(/\.[^.]+$/, "");
  for (const arch of MAC_FEED_ARCHES) {
    if (new RegExp(`(^|[-_.])${arch}([-_.]|$)`).test(base)) return arch;
  }
  return null;
}

/**
 * P2-191: one Squirrel.Mac feed document per architecture. The dist root of a
 * two-arch release carries two zips; pointing every mac install at the same
 * JSON (the pre-P2-191 single update-mac.json) would hand an Intel Mac the
 * arm64 zip — an update that does not run on the machine. This pure core
 * returns { feeds, problems }: feeds maps arm64/x64 to the document whose url
 * ends in that architecture's zip, problems are human-readable strings in the
 * buildSquirrelFeed style (ALL reported at once, and feeds is null whenever
 * any problem exists — fail closed, a partial feed must not ship).
 *
 * @param {string[]} fileNames entries of the dist root
 * @param {string} tag release tag (e.g. "v0.3.0")
 * @param {string} repoSlug GitHub "owner/repo" the release was published on
 * @param {{ notes?: string, pubDate?: string, rolloutPercent?: number }} [meta]
 *        notes/pub_date injected by the CLI from latest-mac.yml so the alias
 *        file stays byte-identical; rolloutPercent (P3-458) must be an
 *        integer 0..100 already validated by parseRolloutPercent — it is
 *        re-checked here (fail closed, a problem aborts the whole plan) so a
 *        caller bypassing the validator can never publish a garbage field.
 *        Absent (undefined) keeps the documents exactly as they always were.
 */
export function macFeedPlan(fileNames, tag, repoSlug, meta = {}) {
  const problems = [];
  const cleanTag = String(tag ?? "").trim();
  const version = cleanTag.replace(/^v/i, "");
  if (!version) problems.push("release tag is empty — pass --tag vX.Y.Z or set GITHUB_REF_NAME");

  const zips = [...(fileNames ?? [])].filter((n) => n.toLowerCase().endsWith(".zip")).sort();
  if (zips.length === 0) {
    problems.push(
      "missing file: *.zip under dist root — Squirrel.Mac only installs from a zip (add the `zip` target to the electron-builder.yml mac block)",
    );
  }

  const picks = {};
  for (const arch of MAC_FEED_ARCHES) {
    const matching = zips.filter((z) => archOfFileName(z) === arch);
    if (matching.length === 0 && zips.length > 0) {
      problems.push(`missing file: *.zip carrying ${arch} under dist root — the ${arch} feed has nothing to point at`);
    } else if (matching.length > 1) {
      problems.push(`ambiguous: ${matching.length} zips carrying ${arch} under dist root: ${matching.join(", ")}`);
    } else if (matching.length === 1) {
      picks[arch] = matching[0];
    }
  }

  // P3-458: the rollout percentage rides along only when the caller passed
  // one — undefined keeps every document byte-identical to the pre-P3-458
  // shape; anything present but not an integer in 0..100 is a fail-closed
  // problem (no feed may ship carrying an illegible percentage).
  const rolloutRaw = meta.rolloutPercent;
  const rolloutPresent = rolloutRaw !== undefined;
  if (rolloutPresent && !(Number.isInteger(rolloutRaw) && rolloutRaw >= 0 && rolloutRaw <= 100)) {
    problems.push(
      `rolloutPercent ${JSON.stringify(rolloutRaw ?? null)} is not an integer in 0..100 — validate ROLLOUT_PERCENT with parseRolloutPercent (apps/desktop/scripts/rolloutpercent.mjs) before calling macFeedPlan`,
    );
  }

  if (problems.length > 0) return { feeds: null, problems };

  const notes = typeof meta.notes === "string" ? meta.notes : "";
  const pubDate = typeof meta.pubDate === "string" ? meta.pubDate : new Date().toISOString();
  const feeds = {};
  for (const arch of MAC_FEED_ARCHES) {
    feeds[arch] = {
      url: `https://github.com/${repoSlug}/releases/download/${cleanTag}/${encodeURIComponent(picks[arch])}`,
      name: version,
      notes,
      pub_date: pubDate,
      ...(rolloutPresent ? { [ROLLOUT_JSON_FIELD]: rolloutRaw } : {}),
    };
  }
  return { feeds, problems };
}

/**
 * P3-458: the pure yml transform behind the --staging-yml write — inject a
 * top-level `stagingPercentage: <percent>` line into the electron-builder
 * update yml (latest.yml, the Windows feed) while preserving every other
 * byte. The rewrite touches ONLY the field: an existing top-level
 * `stagingPercentage:` line is replaced in place (same position, same line
 * endings, everything else byte-for-byte), an absent one is inserted right
 * after the `version:` line so the document keeps its shape. Re-running with
 * the same percentage is a byte-for-byte no-op, and a different percentage
 * moves the field without moving anything else. Line-anchored so indented
 * `files:` entries never count — the client reader (update.ts parseFeed) is
 * line-anchored the same way, and the additive field must not corrupt the
 * digest block feedhash.ts confronts. Fail closed: an empty/unreadable yml,
 * a yml with no top-level `version:` line (not an electron-builder feed) or
 * several top-level stagingPercentage lines (refusing to guess which counts)
 * come back as problems — nothing is written by the caller.
 *
 * @param {string} ymlText raw yml contents (never mutated)
 * @param {number} percent integer 0..100, as returned by parseRolloutPercent
 * @returns {{ text: string | null, problems: string[] }} the new yml text, or
 *          null with every problem listed (the dist-smoke reporting style)
 */
export function injectStagingPercentage(ymlText, percent) {
  const problems = [];
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error("injectStagingPercentage: percent must be an integer 0..100 (validated by parseRolloutPercent)");
  }
  if (typeof ymlText !== "string" || ymlText.trim().length === 0) {
    problems.push("latest.yml is empty — a missing or unreadable feed is a problem, never a silent skip");
    return { text: null, problems };
  }
  const lines = ymlText.split("\n");
  const stagingIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^stagingPercentage:/.test(lines[i] ?? "")) stagingIdx.push(i);
  }
  if (stagingIdx.length > 1) {
    problems.push(`latest.yml carries ${stagingIdx.length} top-level "${ROLLOUT_YML_FIELD}:" lines — refusing to guess which one counts`);
    return { text: null, problems };
  }
  if (stagingIdx.length === 1) {
    const original = lines[stagingIdx[0]] ?? "";
    const eol = original.endsWith("\r") ? "\r" : "";
    lines[stagingIdx[0]] = `${ROLLOUT_YML_FIELD}: ${percent}${eol}`;
    return { text: lines.join("\n"), problems };
  }
  const versionIdx = lines.findIndex((l) => /^version:/.test(l ?? ""));
  if (versionIdx === -1) {
    problems.push(`latest.yml has no top-level "version:" line — not an electron-builder feed, nothing to inject into`);
    return { text: null, problems };
  }
  const eol = (lines[versionIdx] ?? "").endsWith("\r") ? "\r" : "";
  lines.splice(versionIdx + 1, 0, `${ROLLOUT_YML_FIELD}: ${percent}${eol}`);
  return { text: lines.join("\n"), problems };
}

/**
 * Pure core of the feed builder. Returns { feed, problems }: feed is the
 * Squirrel.Mac JSON document (url/name/notes/pub_date) or null when the
 * problems are fatal (no zip to point at, or the yml/tag contract is broken —
 * publishing such a feed would advertise an update Squirrel can't apply).
 * The download file name is percent-encoded, so even artifact names with
 * spaces produce valid GitHub download URLs (P2-186 renamed the artifacts
 * space-free: "OpenCode-Remote-0.2.1-arm64.zip").
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
  // P3-458: --staging-yml switches to the Windows side — inject
  // stagingPercentage into <dist>/latest.yml only, never build the Squirrel
  // JSON feeds (the windows dist root has no mac zips to point at).
  const stagingOnly = argv.includes(STAGING_YML_MODE);
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

  // P3-458: validate ROLLOUT_PERCENT FIRST — before any read or write. A
  // blank/absent variable (the workflow passes an empty string when the
  // input is not filled) is the documented no-input path: no field is
  // written and every feed stays byte for byte identical to today. An
  // invalid value exits 1 listing every problem and writes nothing (fail
  // closed, the dist-smoke pattern), one shared rule with every writer.
  const rolloutEnv = process.env.ROLLOUT_PERCENT;
  const rolloutRaw = typeof rolloutEnv === "string" ? rolloutEnv.trim() : "";
  let rolloutPercent = null;
  if (rolloutRaw.length > 0) {
    const parsed = parseRolloutPercent(rolloutRaw);
    if ("problems" in parsed) {
      console.error(`update-feed: FAIL ROLLOUT_PERCENT=${JSON.stringify(rolloutEnv)}`);
      for (const problem of parsed.problems) console.error(`  - ${problem}`);
      console.error("update-feed: nothing was written — fix ROLLOUT_PERCENT (integer 0..100) or unset it");
      process.exitCode = 1;
      return;
    }
    rolloutPercent = parsed.value;
  }

  if (stagingOnly) {
    if (rolloutPercent === null) {
      console.log("update-feed: no ROLLOUT_PERCENT — latest.yml stays byte a byte as electron-builder wrote it");
      return;
    }
    if (!existsSync(distRoot)) {
      console.error(`update-feed: dist root does not exist: ${distRoot}\nrun \`npm run dist --workspace @ocr/desktop\` first`);
      process.exitCode = 1;
      return;
    }
    const winYmlPath = join(distRoot, "latest.yml");
    if (!existsSync(winYmlPath)) {
      console.error(`update-feed: FAIL ${distRoot}`);
      console.error("  - missing file: latest.yml under dist root — the Windows feed the staged-rollout percentage must land in");
      console.error("update-feed: nothing was written");
      process.exitCode = 1;
      return;
    }
    const before = readFileSync(winYmlPath, "utf8");
    const injection = injectStagingPercentage(before, rolloutPercent);
    if (injection.problems.length > 0 || injection.text === null) {
      console.error(`update-feed: FAIL ${winYmlPath}`);
      for (const problem of injection.problems) console.error(`  - ${problem}`);
      console.error(`update-feed: ${injection.problems.length} problem(s) found`);
      console.error("update-feed: nothing was written");
      process.exitCode = 1;
      return;
    }
    if (injection.text === before) {
      console.log(`update-feed: OK ${winYmlPath} — ${ROLLOUT_YML_FIELD} already ${rolloutPercent}`);
      return;
    }
    writeFileSync(winYmlPath, injection.text);
    console.log(`update-feed: OK ${winYmlPath}`);
    console.log(`  ${ROLLOUT_YML_FIELD}: ${rolloutPercent}`);
    return;
  }

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

  // P2-191: one feed per architecture, plus the legacy update-mac.json as a
  // byte-identical alias of the arm64 document — the installed base already
  // consults the old name (publicFeedUrl's pre-P2-191 default) and must keep
  // its update path. All three come from the same macFeedPlan so the pub_date
  // matches exactly; any problem (missing/ambiguous per-arch zip, empty tag,
  // an unvalidated ROLLOUT_PERCENT) writes nothing and fails the job.
  const plan = macFeedPlan(files, tag, repoSlug, {
    notes: parseYmlReleaseNotes(ymlText),
    pubDate: feed.pub_date,
    ...(rolloutPercent !== null ? { rolloutPercent } : {}),
  });
  if (plan.problems.length > 0 || !plan.feeds) {
    console.error(`update-feed: FAIL ${distRoot}`);
    for (const problem of plan.problems) console.error(`  - ${problem}`);
    console.error(`update-feed: ${plan.problems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }

  const arm64Path = join(distRoot, "update-mac-arm64.json");
  const x64Path = join(distRoot, "update-mac-x64.json");
  const aliasPath = join(distRoot, "update-mac.json");
  const arm64Doc = `${JSON.stringify(plan.feeds.arm64, null, 2)}\n`;
  writeFileSync(arm64Path, arm64Doc);
  writeFileSync(x64Path, `${JSON.stringify(plan.feeds.x64, null, 2)}\n`);
  // Byte-a-byte alias of the arm64 document (same text, not just same JSON).
  writeFileSync(aliasPath, arm64Doc);
  console.log(`update-feed: OK ${arm64Path}`);
  console.log(`  url: ${plan.feeds.arm64.url}`);
  console.log(`  name: ${plan.feeds.arm64.name}`);
  console.log(`update-feed: OK ${x64Path}`);
  console.log(`  url: ${plan.feeds.x64.url}`);
  console.log(`update-feed: OK ${aliasPath} (alias of update-mac-arm64.json)`);
  // P3-458: with a validated ROLLOUT_PERCENT the JSON feeds above carry the
  // percentage; the Windows half ships through the separate --staging-yml
  // run in the win packaging job (electron-builder writes latest.yml only on
  // the windows runner). The mac dist root's latest-mac.yml is deliberately
  // never touched — no consumer reads it.
  if (rolloutPercent !== null) {
    console.log(`update-feed: rollout ${rolloutPercent}% (${ROLLOUT_JSON_FIELD} in update-mac*.json)`);
  }
}

// CLI guard: skip main() when imported by the unit test (same pattern as
// scripts/dist-smoke.mjs).
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
