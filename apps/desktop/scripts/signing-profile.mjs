#!/usr/bin/env node
/**
 * P2-136: signing preflight for the mac release pipeline.
 *
 * Pure module + CLI. `signingProfile(env)` inspects the codesigning-related
 * environment (exactly what the release workflow receives) and reports:
 *
 *   - mode: "developer-id" when a usable Developer ID signing identity is
 *     configured, "adhoc" otherwise (today's default — right-click → Open);
 *   - notarizes: true only when the profile is developer-id AND the Apple
 *     notarization credentials are present AND no problems were found;
 *   - problems: human-readable findings in the same spirit as dist-smoke's
 *     listProblems() — each names the env vars to fix, nothing more.
 *
 * Known problem classes (both make notarization impossible, so they must not
 * turn `-c.mac.notarize=true` on):
 *   1. notarization requested (all three APPLE_* vars) without a signing
 *      certificate — notarization requires a Developer ID signed build;
 *   2. a certificate configured while CSC_IDENTITY_AUTO_DISCOVERY=false —
 *      electron-builder then skips identity lookup entirely (util/flags.js:
 *      `CSC_IDENTITY_AUTO_DISCOVERY !== "false"`), so CSC_LINK would be
 *      silently ignored and the build would ship ad-hoc while claiming
 *      otherwise.
 *
 * Exit code is always 0: the preflight informs the release, it never breaks
 * the job on its own (the workflow decides what to do with the outputs).
 *
 * Usage: node scripts/signing-profile.mjs
 * In GitHub Actions it also writes `mode=` / `notarize=` to GITHUB_OUTPUT and
 * emits a ::warning:: annotation per problem.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Env value counts as configured when it is a non-empty string (Actions sets
 * missing secrets as "" — must not read as "present"). */
function configured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Derive the signing profile for a release run. `env` defaults to
 * process.env for CLI use; tests pass explicit objects.
 */
export function signingProfile(env = process.env) {
  const problems = [];

  const hasCert = configured(env.CSC_LINK) || configured(env.CSC_NAME);
  // Same all-three rule the release workflow applies before flipping
  // -c.mac.notarize on (partial credentials never notarize).
  const hasNotaryCredentials =
    configured(env.APPLE_ID) &&
    configured(env.APPLE_APP_SPECIFIC_PASSWORD) &&
    configured(env.APPLE_TEAM_ID);
  // electron-builder's own rule (app-builder-lib out/util/flags.js): any value
  // other than the exact string "false" means auto discovery is enabled.
  const autoDiscovery = env.CSC_IDENTITY_AUTO_DISCOVERY !== "false";

  if (hasCert && !autoDiscovery) {
    problems.push(
      "signing certificate configured (CSC_LINK/CSC_NAME) but CSC_IDENTITY_AUTO_DISCOVERY=false — " +
        "electron-builder skips identity lookup and the certificate is ignored; " +
        "unset the flag or set it to true to sign with Developer ID",
    );
  }
  if (hasNotaryCredentials && !hasCert) {
    problems.push(
      "notarization credentials set (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID) but no " +
        "signing certificate (CSC_LINK/CSC_NAME) — notarization requires a Developer ID signed build",
    );
  }

  const mode = hasCert && autoDiscovery ? "developer-id" : "adhoc";
  const notarizes = mode === "developer-id" && hasNotaryCredentials && problems.length === 0;
  return { mode, notarizes, problems };
}

function main() {
  const profile = signingProfile(process.env);
  for (const problem of profile.problems) {
    console.error(`signing-profile: ${problem}`);
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::warning::signing-profile: ${problem}`);
    }
  }
  console.log(`signing-profile: mode=${profile.mode} notarize=${profile.notarizes}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${profile.mode}\nnotarize=${profile.notarizes}\n`);
  }
}

// CLI guard: skip main() when imported by the unit test (same as dist-smoke).
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
