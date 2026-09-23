#!/usr/bin/env node
/**
 * P3-460: suspend or advance the gradual rollout of an ALREADY PUBLISHED
 * release without republishing anything.
 *
 * Until P3-460 only the release build could declare the percentage (P3-458's
 * ROLLOUT_PERCENT at feed-build time) — a defective build already in the
 * wild could only be braked by re-running the whole packaging workflow (two
 * runners, signing, notarization) to move one number the installed clients
 * consult from the feed (apps/desktop/src/updaterollout.ts). This CLI is the
 * operator's lever, and it is deliberately thin:
 *
 *   1. the tag and percentage arrive as positional arguments; the percentage
 *      is validated by the ONE shared validator (parseRolloutPercent, the
 *      P3-458 module) BEFORE anything else runs — an invalid value exits 1
 *      listing every problem without calling `gh` at all;
 *   2. `gh release download <tag>` fetches ONLY the four update feeds
 *      (update-mac.json, update-mac-arm64.json, update-mac-x64.json,
 *      latest.yml) into a temporary directory — never the zip, the DMG, the
 *      exe or the blockmaps;
 *   3. the pure module apps/desktop/scripts/rolloutrewrite.mjs rewrites only
 *      the rollout field of each feed (byte-for-byte everywhere else);
 *   4. `gh release upload <tag> ... --clobber` re-attaches exactly the four
 *      rewritten feeds — the installers stay on the release untouched.
 *
 * Fail closed on every path: a tag without the complete feed set, a
 * corrupt/divergent feed (the update-mac.json alias must remain byte-identical
 * to update-mac-arm64.json, the P2-191 contract), a `gh` failure or an
 * invalid percentage exits 1 with every problem listed and uploads NOTHING.
 * `0` is the documented suspension command (the P2-342 release brake — no
 * machine is offered the release, not even through an explicit check) and
 * `100` is the full release; anything between widens the rollout gradually.
 * The short runbook lives in docs/PILOT.md (release section).
 *
 * Usage: node scripts/rollout.mjs <tag> <percent>
 *        e.g. node scripts/rollout.mjs v0.3.0 40    (gradual 40%)
 *             node scripts/rollout.mjs v0.3.0 0     (suspend)
 *             node scripts/rollout.mjs v0.3.0 100   (full release)
 *
 * Requires the `gh` CLI authenticated (GH_TOKEN or `gh auth login`); it
 * resolves the repository from the current checkout's git remote, so run it
 * from the repo root. No new dependencies: node built-ins + `gh`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRolloutPercent, ROLLOUT_JSON_FIELD, ROLLOUT_YML_FIELD } from "./rolloutpercent.mjs";
import { rewriteFeedPercent } from "./rolloutrewrite.mjs";

/** The complete feed set a published release carries (the P2-191/P2-153
 * contract): the three Squirrel JSON feeds (the legacy arch-less alias first,
 * then the per-arch documents) and the Windows yml. Exactly these are
 * downloaded and re-uploaded — never the installers. Declared once so the
 * CLI, the alias check and the tests cite the same names. */
export const ROLLOUT_FEED_ASSETS = ["update-mac.json", "update-mac-arm64.json", "update-mac-x64.json", "latest.yml"];

/** The legacy alias must stay a byte-identical copy of the arm64 document
 * (P2-191): the rewriter verifies it BEFORE touching anything, so a rollout
 * change can never deepen a broken release. */
export const ALIAS_ASSET = "update-mac.json";
export const ALIAS_OF_ASSET = "update-mac-arm64.json";

/** Per-`gh`-call ceiling: the four feeds are a few KB; 2 minutes is generous
 * even on a slow link, and a hung `gh` must never wedge the operator. */
export const GH_TIMEOUT_MS = 120_000;

const USAGE =
  "usage: node apps/desktop/scripts/rollout.mjs <tag> <percent>\n" +
  "       e.g. node apps/desktop/scripts/rollout.mjs v0.3.0 40   (gradual rollout 40%)\n" +
  "            node apps/desktop/scripts/rollout.mjs v0.3.0 0    (suspend the rollout)\n" +
  "            node apps/desktop/scripts/rollout.mjs v0.3.0 100  (full release)";

/** One gh interaction. Returns the parsed result or null with a problem. */
function runGh(args, problems, label) {
  const res = spawnSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS });
  if (res.error) {
    const notFound = res.error.code === "ENOENT";
    const timedOut = res.signal === "SIGTERM" || res.error.code === "ETIMEDOUT";
    problems.push(
      notFound
        ? "gh CLI not found — install the GitHub CLI (https://cli.github.com) or run this command where it is on PATH"
        : timedOut
          ? `gh ${label} timed out after ${Math.round(GH_TIMEOUT_MS / 1000)}s`
          : `gh ${label} failed to start: ${res.error.message}`,
    );
    return null;
  }
  if (res.status !== 0) {
    const detail = `${res.stderr ?? ""}${res.stdout ?? ""}`.trim();
    problems.push(
      `gh ${label} exited ${res.status === null ? `on signal ${res.signal}` : res.status}${detail ? `: ${detail.split("\n").join(" ")}` : ""}`,
    );
    return null;
  }
  return res;
}

function main() {
  const argv = process.argv.slice(2);
  const problems = [];
  // A negative-number second argument ("-1") is a percent candidate, not a
  // flag: it must reach the shared validator so the problem names the rule,
  // not a generic usage line.
  const percentLooksNegative = /^-\d+$/.test(argv[1] ?? "");
  const flagged =
    (argv[0] ?? "").startsWith("-") || ((argv[1] ?? "").startsWith("-") && !percentLooksNegative);
  if (argv.length < 2 || !argv[0] || !argv[1] || flagged) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const cleanTag = argv[0].trim();

  // The ONE validity rule, shared with every writer (P3-458): validated FIRST,
  // before any gh call — an invalid percentage downloads nothing, rewrites
  // nothing, uploads nothing.
  const parsed = parseRolloutPercent(argv[1]);
  if ("problems" in parsed) {
    console.error(`rollout: FAIL ${JSON.stringify(argv[1])}`);
    for (const problem of parsed.problems) console.error(`  - ${problem}`);
    console.error("rollout: nothing was downloaded or uploaded — pass an integer 0..100");
    process.exitCode = 1;
    return;
  }
  const percent = parsed.value;

  if (!cleanTag) {
    console.error("rollout: FAIL");
    console.error("  - release tag is empty — pass the tag (e.g. v0.3.0)");
    process.exitCode = 1;
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "rollout-"));
  const failOut = (suffix) => {
    console.error(`rollout: FAIL ${cleanTag}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`rollout: ${problems.length} problem(s) found`);
    if (suffix) console.error(suffix);
  };
  try {
    // 1. download ONLY the four feeds (never the installers) into the temp dir.
    const download = runGh(["release", "download", cleanTag, ...ROLLOUT_FEED_ASSETS, "--dir", dir], problems, "release download");
    if (!download) {
      failOut("rollout: nothing was uploaded — the release is untouched");
      process.exitCode = 1;
      return;
    }

    // 2. the complete feed set must be on the release — a tag without the
    //    feeds is a problem listing what is missing, never a partial rewrite.
    for (const name of ROLLOUT_FEED_ASSETS) {
      if (!existsSync(join(dir, name))) {
        problems.push(
          `missing file: ${name} on release ${cleanTag} — the release must carry the complete feed set (publish it through the release workflow)`,
        );
      }
    }
    if (problems.length > 0) {
      failOut("rollout: nothing was uploaded — the release is untouched");
      process.exitCode = 1;
      return;
    }

    // 3. the alias contract: update-mac.json must be byte-identical to the
    //    arm64 document BEFORE the rewrite (both get the same rewrite, so the
    //    identity survives — a divergent pair is a broken release the tool
    //    refuses to deepen).
    const aliasText = readFileSync(join(dir, ALIAS_ASSET), "utf8");
    const arm64Text = readFileSync(join(dir, ALIAS_OF_ASSET), "utf8");
    if (aliasText !== arm64Text) {
      problems.push(
        `${ALIAS_ASSET} is not a byte-identical alias of ${ALIAS_OF_ASSET} on release ${cleanTag} — refusing to publish a rollout that deepens the divergence (fix the release by hand or republish through the release workflow)`,
      );
      failOut("rollout: nothing was uploaded — the release is untouched");
      process.exitCode = 1;
      return;
    }

    // 4. rewrite every feed through the pure module — all problems at once,
    //    nothing written until every feed rewrote cleanly.
    const results = [];
    for (const name of ROLLOUT_FEED_ASSETS) {
      const before = readFileSync(join(dir, name), "utf8");
      const rewrite = rewriteFeedPercent(before, percent);
      if (rewrite.problems.length > 0 || rewrite.text === null) {
        for (const problem of rewrite.problems) problems.push(`${name}: ${problem}`);
        continue;
      }
      results.push({ name, text: rewrite.text });
    }
    if (problems.length > 0 || results.length !== ROLLOUT_FEED_ASSETS.length) {
      failOut("rollout: nothing was uploaded — the release is untouched");
      process.exitCode = 1;
      return;
    }

    // 5. only now the temp files are written — then the four feeds go back up
    //    with --clobber. The installers were never downloaded, never uploaded.
    for (const result of results) writeFileSync(join(dir, result.name), result.text);
    const upload = runGh(
      ["release", "upload", cleanTag, ...results.map((r) => join(dir, r.name)), "--clobber"],
      problems,
      "release upload",
    );
    if (!upload) {
      // The upload may have partially succeeded (gh uploads asset by asset);
      // --clobber makes the retry converge, so the message says so instead of
      // claiming the release is untouched.
      failOut("rollout: re-run the same command to retry — --clobber overwrites the same four feeds");
      process.exitCode = 1;
      return;
    }

    console.log(`rollout: OK ${cleanTag} — ${percent}`);
    for (const result of results) {
      const field = result.name === ROLLOUT_FEED_ASSETS[3] ? ROLLOUT_YML_FIELD : ROLLOUT_JSON_FIELD;
      console.log(`  ${result.name}: ${field} ${percent}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// CLI guard: skip main() when imported by the unit test (same pattern as
// scripts/update-feed.mjs).
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
