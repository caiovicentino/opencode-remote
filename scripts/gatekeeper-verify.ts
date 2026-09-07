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
 *
 * P2-295: P2-170 verified the packaged app, but what a user downloads and
 * double-clicks is the DMG CONTAINER — review round 2 pinned the real
 * packaging shape (apps/desktop/electron-builder.yml): electron-builder leaves
 * dmg.sign off and never staples the image, so the container itself is always
 * UNSIGNED/UNSTAPLED in every mode — the signature and the stapled ticket live
 * on the .app inside. dmgProblems() is additive and pure, same list format as
 * gatekeeperProblems(), fed by the combined outputs of codesign on the
 * container, spctl -a -vv -t OPEN on the container (Gatekeeper assesses the
 * image with the open type, not exec) and xcrun stapler validate on the
 * container. Its rules, evaluated in THIS order:
 *   1. a signing-profile mode outside the documented pair (developer-id |
 *      adhoc) is a problem;
 *   2. empty or unrecognizable output of ANY of the three tools is a problem,
 *      fail-closed — an Apple wording change must fail loudly instead of
 *      waving a broken container through;
 *   3. a FAILED signature verification (any verdict that is neither
 *      "valid on disk" nor the documented unsigned "code object is not signed
 *      at all") is a problem — an unsigned container is the documented
 *      packaging output, so only a container that claims a signature and
 *      fails to verify trips the gate;
 *   4. an spctl rejection is a problem only when the container itself
 *      verifies as signed AND the mode is developer-id — an unsigned
 *      container is expected to be rejected in every mode (the app inside
 *      carries the signature; right-click → Open once is the documented
 *      no-secrets flow);
 *   5. a missing staple ticket is a problem only when notarization was
 *      requested AND the container itself verifies as signed — an unsigned
 *      container has nothing to staple (the app inside carries the ticket).
 * The same input yields the same problem list on every call.
 *
 * The CLI gains a second, additive invocation mode for the container —
 * prefix the arguments with `dmg` — without touching today's form or any
 * existing argument name:
 *
 * Run (container): npx tsx scripts/gatekeeper-verify.ts dmg <mode> <notarize> <codesign.txt> <spctl.txt> <stapler.txt>
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
/** codesign's wording for a container electron-builder never signed (dmg.sign off) — the documented DMG baseline. */
const CODESIGN_UNSIGNED = /not signed at all/i;
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

/**
 * Every Gatekeeper problem with the distributed DMG container, in the order
 * documented in the header above. Empty list means the double-click target's
 * own verdicts match the documented packaging shape: an unsigned container
 * (the electron-builder default) or a container that verifies as signed
 * exactly as its mode promised.
 */
export function dmgProblems(input: GatekeeperInput): string[] {
  const problems: string[] = [];
  const { mode, notarizeRequested, codesign, spctl, stapler } = input;

  // 1. mode outside the documented pair
  if (mode !== "developer-id" && mode !== "adhoc") {
    problems.push(`mode "${mode}" is neither developer-id nor adhoc — signing-profile output drifted`);
  }
  const developerId = mode === "developer-id";

  // 2. empty output is fail-closed / 3. a FAILED signature verification is a
  // problem; "not signed at all" is the documented packaging output
  let containerSigned: boolean;
  if (!codesign.trim()) {
    problems.push("codesign: no output for the DMG container — signature verification could not be confirmed");
    containerSigned = false;
  } else if (CODESIGN_VALID.test(codesign)) {
    containerSigned = true;
  } else if (CODESIGN_UNSIGNED.test(codesign)) {
    containerSigned = false;
  } else {
    problems.push(`codesign: signature verification failed for the DMG container — "${evidence(codesign)}"`);
    containerSigned = false;
  }

  // 2. empty output is fail-closed / 4. an spctl rejection is a problem only
  // for a SIGNED container in developer-id mode — an unsigned container is
  // expected to be rejected in every mode (right-click → Open / the app
  // inside carries the Developer ID verdict)
  if (!spctl.trim()) {
    problems.push("spctl: no output for the DMG container — Gatekeeper assessment could not be confirmed");
  } else if (!SPCTL_ACCEPTED.test(spctl)) {
    if (SPCTL_REJECTED.test(spctl)) {
      if (developerId && containerSigned) {
        problems.push(`spctl: rejected — the developer-id DMG container verifies as signed but Gatekeeper would block it ("${evidence(spctl)}")`);
      }
      // Unsigned container: expected rejection, documented flow — no problem.
    } else {
      problems.push(`spctl: unrecognizable output for the DMG container — "${evidence(spctl)}"`);
    }
  }

  // 2. empty output is fail-closed / 5. a missing ticket is a problem only
  // when notarization was requested AND the container verifies as signed —
  // an unsigned container has nothing to staple. Either way the tool must
  // still produce a recognizable verdict.
  if (!stapler.trim()) {
    problems.push("stapler: no output for the DMG container — ticket validation could not be confirmed");
  } else if (!STAPLER_WORKED.test(stapler)) {
    if (STAPLER_FAILED.test(stapler)) {
      if (notarizeRequested && containerSigned) {
        problems.push(`stapler: no ticket — notarization was requested but the signed DMG container is not stapled ("${evidence(stapler)}")`);
      }
      // Unsigned container: an unstapled image is the documented path.
    } else {
      problems.push(`stapler: unrecognizable output for the DMG container — "${evidence(stapler)}"`);
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
  // P2-295: additive container mode — `dmg <mode> <notarize> ...` verifies the
  // distributed DMG; the original 5-argument form keeps verifying the app.
  const container = argv[0] === "dmg";
  const [mode, notarize, codesignPath, spctlPath, staplerPath] = container ? argv.slice(1) : argv;
  if (!mode || !notarize || !codesignPath || !spctlPath || !staplerPath) {
    console.error(
      `gatekeeper-verify: usage: tsx scripts/gatekeeper-verify.ts${container ? " dmg" : ""} <mode> <notarize> <codesign.txt> <spctl.txt> <stapler.txt>\n` +
        "  [dmg]       optional: verify the distributed DMG container instead of the packaged app\n" +
        "  <mode>      signing-profile mode: developer-id | adhoc\n" +
        "  <notarize>  whether notarization was requested: true | false\n" +
        "  *.txt       captured outputs (stdout+stderr) of codesign --verify --deep --strict --verbose=2,\n" +
        `              spctl -a -vv -t ${container ? "open" : "exec"} and xcrun stapler validate`,
    );
    process.exitCode = 1;
    return;
  }
  if (notarize !== "true" && notarize !== "false") {
    console.error(`gatekeeper-verify: <notarize> must be true or false, got "${notarize}"`);
    process.exitCode = 1;
    return;
  }

  const problems = container
    ? dmgProblems({
        mode,
        notarizeRequested: notarize === "true",
        codesign: readOutput(codesignPath),
        spctl: readOutput(spctlPath),
        stapler: readOutput(staplerPath),
      })
    : gatekeeperProblems({
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
    console.error(
      container
        ? "gatekeeper-verify: a DMG container Gatekeeper rejects must not be attached to the release — fix signing/notarization and rebuild"
        : "gatekeeper-verify: a bundle Gatekeeper rejects must not be attached to the release — fix signing/notarization and rebuild",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`gatekeeper-verify: OK (mode=${mode} notarize=${notarize}) — ${container ? "dmg container" : "bundle"} passes the Gatekeeper verdicts`);
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
