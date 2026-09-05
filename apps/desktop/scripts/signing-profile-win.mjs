#!/usr/bin/env node
/**
 * P2-159: signing preflight for the Windows release pipeline.
 *
 * Pure module + CLI. `signingProfileWin(env)` inspects the Windows
 * codesigning environment (exactly what the release workflow receives) and
 * reports:
 *
 *   - mode: "authenticode" when a usable WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD
 *     pair is configured (electron-builder signs the NSIS installer with
 *     signtool), "unsigned" otherwise — including when ANY problem exists
 *     (fail-closed);
 *   - reasons: the fail-closed findings, each naming the env var to fix.
 *
 * Known problem classes (all force mode=unsigned and abort the job via the
 * CLI's exit code, so a half-configured profile can never publish an
 * installer that looks signed but is not):
 *   1. WIN_CSC_LINK configured without WIN_CSC_KEY_PASSWORD;
 *   2. WIN_CSC_KEY_PASSWORD configured without WIN_CSC_LINK;
 *   3. either variable present but blank after trim (an operator paste error
 *      that must not silently read as "not configured"). A missing secret —
 *      rendered as "" by Actions — is the normal unsigned path, not a problem.
 *
 * WIN_CSC_SUBJECT_NAME is optional and never changes the mode: it only selects
 * the certificate inside the store (electron-builder's
 * `win.signtoolOptions.certificateSubjectName`).
 *
 * Unlike the mac preflight this CLI exits 1 when problems exist — the
 * Windows job must abort instead of shipping a broken signature. With no
 * problems it writes `mode=` to GITHUB_OUTPUT (when present) and exits 0.
 *
 * Usage: node scripts/signing-profile-win.mjs
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Env value counts as configured when it is a non-empty string (Actions sets
 * missing secrets as "" — must not read as "present"). */
function configured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Present in the environment but blank after trim — a misconfiguration, not
 * an absence (P2-151: collect these in the same pass, fail closed). */
function blankButPresent(value) {
  return typeof value === "string" && value.length > 0 && value.trim().length === 0;
}

/**
 * Derive the Windows signing profile for a release run. `env` defaults to
 * process.env for CLI use; tests pass explicit objects.
 */
export function signingProfileWin(env = process.env) {
  const reasons = [];

  if (blankButPresent(env.WIN_CSC_LINK)) {
    reasons.push("WIN_CSC_LINK is set but blank — unset it or provide the real certificate file/base64 value");
  }
  if (blankButPresent(env.WIN_CSC_KEY_PASSWORD)) {
    reasons.push("WIN_CSC_KEY_PASSWORD is set but blank — unset it or provide the real password");
  }

  const hasLink = configured(env.WIN_CSC_LINK);
  const hasPassword = configured(env.WIN_CSC_KEY_PASSWORD);

  if (hasLink && !hasPassword) {
    reasons.push(
      "WIN_CSC_LINK is configured but WIN_CSC_KEY_PASSWORD is not — set both (the certificate password) " +
        "or neither (ship unsigned)",
    );
  }
  if (hasPassword && !hasLink) {
    reasons.push(
      "WIN_CSC_KEY_PASSWORD is configured but WIN_CSC_LINK is not — set both (the certificate file/base64) " +
        "or neither (ship unsigned)",
    );
  }

  // Fail-closed: ANY reason forces unsigned — half-valid profiles never sign.
  const mode = hasLink && hasPassword && reasons.length === 0 ? "authenticode" : "unsigned";
  return { mode, reasons };
}

function main() {
  const profile = signingProfileWin(process.env);
  for (const reason of profile.reasons) {
    console.error(`signing-profile-win: ${reason}`);
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::warning::signing-profile-win: ${reason}`);
    }
  }
  console.log(`signing-profile-win: mode=${profile.mode}`);
  if (profile.reasons.length > 0) {
    // Fail-closed: no GITHUB_OUTPUT write, non-zero exit aborts the job.
    process.exit(1);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${profile.mode}\n`);
  }
}

// CLI guard: skip main() when imported by the unit test (same as signing-profile).
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
