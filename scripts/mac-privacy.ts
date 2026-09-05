#!/usr/bin/env node
/**
 * P2-169: mac privacy preflight — the signed/notarized bundle must carry the
 * mic/camera usage strings (Info.plist, via extendInfo) and the device
 * entitlements (entitlements.mac.plist). Under hardened runtime macOS denies
 * or kills a process that touches those devices without them, and that only
 * ever happened on the stage-5 signed build — never in dev.
 *
 * Pure logic (privacyProblems) works on plain text with no YAML/plist parser
 * (the repo has none); the CLI reads the two real files and exits 1 listing
 * every problem at once, in the same format as dist-smoke/release-preflight.
 *
 * Run: npx tsx scripts/mac-privacy.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIC_KEY = "NSMicrophoneUsageDescription";
export const CAMERA_KEY = "NSCameraUsageDescription";
export const AUDIO_ENTITLEMENT = "com.apple.security.device.audio-input";
export const CAMERA_ENTITLEMENT = "com.apple.security.device.camera";
export const PLIST_LABEL = "apps/desktop/build/entitlements.mac.plist";
export const BUILDER_LABEL = "apps/desktop/electron-builder.yml";

/**
 * Value of a top-level YAML key, matched only outside comments (a `#` before
 * the key makes the line a comment and the key counts as absent). External
 * quotes are stripped and the value trimmed; "" (empty or quote-only) means
 * "present but blank".
 */
function yamlValue(yml: string, key: string): string | null {
  const match = yml.match(new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, "m"));
  if (!match) return null;
  const raw = match[1] ?? "";
  const unquoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
  return unquoted.trim();
}

/** True when `<key>…</key>` is present AND followed by `<true/>` (not `<false/>`). */
function entitlementGranted(xml: string, key: string): boolean {
  return new RegExp(`<key>${key}</key>\\s*<true/>`).test(xml);
}

/**
 * All problems with the mic/camera privacy surface of the packaged app.
 * Empty list means the pair is complete; every problem is reported (not just
 * the first). One problem each for: a usage description missing in the
 * builder yml, a usage description present but blank, and a device
 * entitlement missing (or explicitly false) in the entitlements plist.
 */
export function privacyProblems(entitlementsXml: string, builderYml: string): string[] {
  const problems: string[] = [];
  for (const [key, device] of [
    [MIC_KEY, "microphone"],
    [CAMERA_KEY, "camera"],
  ] as const) {
    const value = yamlValue(builderYml, key);
    if (value === null) {
      problems.push(`${BUILDER_LABEL}: missing ${key} — macOS denies the ${device} under hardened runtime without it`);
    } else if (value.length === 0) {
      problems.push(`${BUILDER_LABEL}: ${key} is present but empty — macOS shows a blank permission prompt`);
    }
  }
  for (const key of [AUDIO_ENTITLEMENT, CAMERA_ENTITLEMENT]) {
    if (!entitlementGranted(entitlementsXml, key)) {
      problems.push(`${PLIST_LABEL}: missing ${key} entitlement — the ${key.endsWith("audio-input") ? "microphone" : "camera"} is denied on the signed build`);
    }
  }
  return problems;
}

function main() {
  const plistPath = fileURLToPath(new URL("../apps/desktop/build/entitlements.mac.plist", import.meta.url));
  const builderPath = fileURLToPath(new URL("../apps/desktop/electron-builder.yml", import.meta.url));
  let entitlementsXml: string;
  let builderYml: string;
  try {
    entitlementsXml = readFileSync(plistPath, "utf8");
    builderYml = readFileSync(builderPath, "utf8");
  } catch (err) {
    console.error(`mac-privacy: FAIL — cannot read the real files: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const problems = privacyProblems(entitlementsXml, builderYml);
  if (problems.length > 0) {
    console.error("mac-privacy: FAIL");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`mac-privacy: ${problems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }
  console.log("mac-privacy: OK");
  console.log(`  ${BUILDER_LABEL}: ${MIC_KEY}, ${CAMERA_KEY}`);
  console.log(`  ${PLIST_LABEL}: ${AUDIO_ENTITLEMENT}, ${CAMERA_ENTITLEMENT}`);
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
