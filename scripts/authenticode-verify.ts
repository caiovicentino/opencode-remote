#!/usr/bin/env node
/**
 * P2-183: Authenticode verdict gate for the packaged Windows installer.
 *
 * The desktop-win job already picks a signing profile (P2-159) and
 * smoke-checks the bundle (P2-164) — but nothing verified that the packaged
 * setup exe is ACTUALLY signed when the profile decided mode=authenticode, so
 * an expired certificate, a password signtool silently accepted, or a signing
 * step that never ran published an installer whose first launch shows the
 * SmartScreen "Windows protected your PC" wall, with no signal anywhere in
 * CI. Same silent-failure class the P2-170 Gatekeeper check closed on the mac
 * side, on the Windows side of the same release.
 *
 * authenticodeProblems() is pure: it receives the signing-profile mode (the
 * `mode` output of apps/desktop/scripts/signing-profile-win.mjs) and the text
 * output of the PowerShell Get-AuthenticodeSignature verification captured to
 * a file by the workflow step, and returns problems in the same format as
 * scripts/gatekeeper-verify.ts and scripts/release-preflight.ts: one
 * human-readable string per finding, every finding reported at once.
 *
 * Problems (authenticode mode): an empty or unrecognizable verification
 * output (fail-closed — if the PowerShell wording changes the gate fails
 * loudly instead of waving a broken installer through), any signature status
 * other than Valid — NotSigned, HashMismatch, NotTrusted, UnknownError,
 * Expired, Revoked, Incompatible — and a Valid signature whose certificate
 * carries no subject line. Explicitly problem-free: the unsigned mode, which
 * continues the documented no-secrets release path (SmartScreen warning,
 * README) exactly like the mac ad-hoc mode.
 *
 * CLI (same fail-closed pattern as dist-smoke, release-assets, the P2-170
 * gatekeeper-verify and the P2-179 release-publish): the mode comes from argv
 * and the verification output from a file path; prints every problem at once
 * and exits 1.
 *
 * Run: npx tsx scripts/authenticode-verify.ts <mode> <signtool.txt>
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface AuthenticodeInput {
  /** Signing profile mode from apps/desktop/scripts/signing-profile-win.mjs: "authenticode" or "unsigned". */
  mode: string;
  /** Captured output (stdout+stderr) of the PowerShell Get-AuthenticodeSignature verification. */
  signtool: string;
}

/** The workflow step prints one `Status: <value>` line via Write-Output. */
const STATUS_LINE = /^Status[ \t]*:[ \t]*(.*)$/im;
/** The workflow step prints one `Subject: <value>` line (empty when no certificate). */
const SUBJECT_LINE = /^Subject[ \t]*:[ \t]*(.*)$/im;

/** Get-AuthenticodeSignature status meaning "the signature verifies end to end". */
const VALID = "valid";

/** First line of an output, for quoting evidence inside a problem. */
function evidence(output: string): string {
  const line = output.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Human phrasing for the signature statuses a broken release actually hits. */
function statusHint(status: string): string {
  const s = status.toLowerCase();
  if (s === "notsigned") return "the file is not signed at all";
  if (s === "hashmismatch") return "the file hash does not match the signature (modified after signing)";
  if (s === "nottrusted") return "the certificate chain is not trusted";
  if (s === "unknownerror") return "signtool/PowerShell failed for an unknown reason";
  if (s === "expired") return "the signing certificate expired";
  if (s === "revoked") return "the signature is revoked";
  if (s === "incompatible") return "the signature is incompatible with this file";
  return "the signature does not verify";
}

/**
 * Every Authenticode problem with the packaged installer. Empty list means the
 * artifact is exactly what the signing profile promised. The unsigned mode is
 * the documented no-secrets release path and never produces a problem.
 */
export function authenticodeProblems(input: AuthenticodeInput): string[] {
  const problems: string[] = [];
  const { mode, signtool } = input;

  if (mode !== "authenticode" && mode !== "unsigned") {
    problems.push(`mode "${mode}" is neither authenticode nor unsigned — signing-profile-win output drifted`);
  }
  // The documented no-secrets path: an unsigned installer is expected to trip
  // SmartScreen once (README) — the verification verdict is irrelevant there.
  if (mode === "unsigned") return problems;

  if (!signtool.trim()) {
    problems.push("authenticode: no output — signature verification could not be confirmed (Get-AuthenticodeSignature must print a Status)");
    return problems;
  }

  const statusMatch = STATUS_LINE.exec(signtool);
  if (!statusMatch) {
    problems.push(`authenticode: unrecognizable output — no Status line in "${evidence(signtool)}"`);
    return problems;
  }
  const status = statusMatch[1]?.trim() ?? "";

  if (status.toLowerCase() !== VALID) {
    problems.push(
      `authenticode: signature status is ${status || "empty"} — ${statusHint(status)} ("${evidence(signtool)}")`,
    );
  } else {
    const subject = SUBJECT_LINE.exec(signtool)?.[1]?.trim() ?? "";
    if (!subject) {
      problems.push(`authenticode: Valid signature but the certificate has no subject — "${evidence(signtool)}"`);
    }
  }

  return problems;
}

function readOutput(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    return `authenticode-verify: cannot read file — ${(err as Error).message}`;
  }
}

function cli(argv: readonly string[]): void {
  const [mode, signtoolPath] = argv;
  if (!mode || !signtoolPath) {
    console.error(
      "authenticode-verify: usage: tsx scripts/authenticode-verify.ts <mode> <signtool.txt>\n" +
        "  <mode>          signing-profile-win mode: authenticode | unsigned\n" +
        "  <signtool.txt>  captured output (stdout+stderr) of the PowerShell Get-AuthenticodeSignature verification",
    );
    process.exitCode = 1;
    return;
  }

  const problems = authenticodeProblems({ mode, signtool: readOutput(signtoolPath) });

  if (problems.length > 0) {
    console.error(`authenticode-verify: FAIL (mode=${mode})`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`authenticode-verify: ${problems.length} problem(s) found`);
    console.error("authenticode-verify: an installer SmartScreen would flag must not be attached to the release — fix signing and rebuild");
    process.exitCode = 1;
    return;
  }
  console.log(`authenticode-verify: OK (mode=${mode}) — installer matches the signing profile`);
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
