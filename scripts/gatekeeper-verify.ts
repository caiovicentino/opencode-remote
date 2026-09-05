#!/usr/bin/env node
/**
 * P2-170: Gatekeeper verdict gate for the packaged mac bundle.
 *
 * The desktop-dmg job already picks a signing profile (P2-136), notarizes when
 * the profile allows and smoke-checks the bundle (P2-130) — but nothing
 * verified that the RESULT is actually accepted by Gatekeeper, so a notarization
 * ticket that never got stapled, an expired identity or a profile that silently
 * fell back to ad-hoc produced a published DMG whose first launch dies with
 * "app is damaged" and no signal anywhere in CI. Same silent-failure class the
 * P2-164 bundle smoke closed, on the signing side.
 *
 * gatekeeperProblems() is pure: it receives the signing-profile mode, whether
 * notarization was requested, and the text outputs of the three verification
 * tools (codesign --verify --deep --strict --verbose=2, spctl -a -vv -t exec,
 * xcrun stapler validate — each captured with 2>&1) and returns problems in the
 * same format as scripts/release-preflight.ts and scripts/release-assets.ts:
 * one human-readable string per finding, every finding reported at once.
 *
 * Problems: an invalid/failed codesign verification, an spctl `rejected`
 * verdict when the mode is developer-id (an ad-hoc build is expected to be
 * rejected — right-click → Open is the documented flow), a missing staple
 * ticket when notarization was requested, and empty/unrecognizable output from
 * ANY of the three tools (fail-closed: if Apple's wording changes, the gate
 * fails loudly instead of waving a broken DMG through). Explicitly problem-free:
 * the ad-hoc mode with no notarization requested — the documented no-secrets
 * release path.
 *
 * CLI (same fail-closed pattern as dist-smoke and release-assets): the three
 * outputs come from files and the mode/verdict from argv; prints every problem
 * at once and exits 1.
 *
 * Run: npx tsx scripts/gatekeeper-verify.ts <mode> <notarize> <codesign.txt> <spctl.txt> <stapler.txt>
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface GatekeeperInput {
  /** Signing profile mode from apps/desktop/scripts/signing-profile.mjs: "developer-id" or "adhoc". */
  mode: string;
  /** True when the profile turned `-c.mac.notarize=true` on. */
  notarizeRequested: boolean;
  /** Combined stdout+stderr of `codesign --verify --deep --strict --verbose=2 <app>`. */
  codesign: string;
  /** Combined stdout+stderr of `spctl -a -vv -t exec <app>`. */
  spctl: string;
  /** Combined stdout+stderr of `xcrun stapler validate <app>`. */
  stapler: string;
}

/** `codesign -v --verbose=2` prints this on a valid signature (silent otherwise). */
const CODESIGN_VALID = /valid on disk/i;
/** spctl prints `<path>: accepted` or `<path>: rejected (<reason>)`. */
const SPCTL_ACCEPTED = /:\s*accepted\b/i;
const SPCTL_REJECTED = /:\s*rejected\b/i;
/** stapler validate success line. */
const STAPLER_WORKED = /validate action worked/i;
/** stapler validate failure phrasing (no ticket, invalid staple, refused). */
const STAPLER_FAILED =
  /validate action failed|does not have a ticket stapled|doesn't verify|does not verify|ticket not found|invalid staple|not stapled|refused|failed|error/i;

/** First line of a tool output, for quoting evidence inside a problem. */
function evidence(output: string): string {
  const line = output.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Every Gatekeeper problem with the verified bundle. Empty list means the
 * artifact is exactly what the signing profile promised.
 */
export function gatekeeperProblems(input: GatekeeperInput): string[] {
  const problems: string[] = [];
  const { mode, notarizeRequested, codesign, spctl, stapler } = input;

  if (mode !== "developer-id" && mode !== "adhoc") {
    problems.push(`mode "${mode}" is neither developer-id nor adhoc — signing-profile output drifted`);
  }
  const developerId = mode === "developer-id";

  // --- codesign: signature must verify (verbose=2 success prints "valid on disk")
  if (!codesign.trim()) {
    problems.push("codesign: no output — verification could not be confirmed (verbose=2 must print \"valid on disk\")");
  } else if (!CODESIGN_VALID.test(codesign)) {
    problems.push(`codesign: signature verification failed — "${evidence(codesign)}"`);
  }

  // --- spctl: Gatekeeper assessment (a rejected verdict is only fatal for a
  // Developer ID build; ad-hoc builds are expected to be rejected and users
  // right-click → Open once, per README)
  if (!spctl.trim()) {
    problems.push("spctl: no output — Gatekeeper assessment could not be confirmed");
  } else if (!SPCTL_ACCEPTED.test(spctl)) {
    if (SPCTL_REJECTED.test(spctl)) {
      if (developerId) {
        problems.push(`spctl: rejected — Gatekeeper would block a developer-id build ("${evidence(spctl)}")`);
      }
      // adhoc: expected rejection, documented flow — no problem.
    } else {
      problems.push(`spctl: unrecognizable output — "${evidence(spctl)}"`);
    }
  }

  // --- stapler: notarization ticket must be present when it was requested;
  // in a no-notarization run the validate failure is expected and fine, but
  // the tool must still have produced a recognizable verdict.
  if (!stapler.trim()) {
    problems.push("stapler: no output — ticket validation could not be confirmed");
  } else if (!STAPLER_WORKED.test(stapler)) {
    if (STAPLER_FAILED.test(stapler)) {
      if (notarizeRequested) {
        problems.push(`stapler: no ticket — notarization was requested but the bundle is not stapled ("${evidence(stapler)}")`);
      }
      // No notarization requested: an unstapled bundle is the documented path.
    } else {
      problems.push(`stapler: unrecognizable output — "${evidence(stapler)}"`);
    }
  }

  return problems;
}

function readOutput(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    return `gatekeeper-verify: cannot read file — ${(err as Error).message}`;
  }
}

function cli(argv: readonly string[]): void {
  const [mode, notarize, codesignPath, spctlPath, staplerPath] = argv;
  if (!mode || !notarize || !codesignPath || !spctlPath || !staplerPath) {
    console.error(
      "gatekeeper-verify: usage: tsx scripts/gatekeeper-verify.ts <mode> <notarize> <codesign.txt> <spctl.txt> <stapler.txt>\n" +
        "  <mode>      signing-profile mode: developer-id | adhoc\n" +
        "  <notarize>  whether notarization was requested: true | false\n" +
        "  *.txt       captured outputs (stdout+stderr) of codesign --verify --deep --strict --verbose=2,\n" +
        "              spctl -a -vv -t exec and xcrun stapler validate",
    );
    process.exitCode = 1;
    return;
  }
  if (notarize !== "true" && notarize !== "false") {
    console.error(`gatekeeper-verify: <notarize> must be true or false, got "${notarize}"`);
    process.exitCode = 1;
    return;
  }

  const problems = gatekeeperProblems({
    mode,
    notarizeRequested: notarize === "true",
    codesign: readOutput(codesignPath),
    spctl: readOutput(spctlPath),
    stapler: readOutput(staplerPath),
  });

  if (problems.length > 0) {
    console.error(`gatekeeper-verify: FAIL (mode=${mode} notarize=${notarize})`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`gatekeeper-verify: ${problems.length} problem(s) found`);
    console.error("gatekeeper-verify: a bundle Gatekeeper rejects must not be attached to the release — fix signing/notarization and rebuild");
    process.exitCode = 1;
    return;
  }
  console.log(`gatekeeper-verify: OK (mode=${mode} notarize=${notarize}) — bundle passes the Gatekeeper verdicts`);
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
