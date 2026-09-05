#!/usr/bin/env node
/**
 * P2-168: Chromium sandbox RCE exposure audit for the desktop shell.
 *
 * The app is an embedded Chromium (Electron), so an actively exploited sandbox
 * RCE in Chromium is an app-level emergency even though we ship no web content
 * of our own beyond the local UI. This script answers one question — is the
 * electron devDependency in apps/desktop/package.json vulnerable to a known
 * CVE, and which patch closes it — the same way release-preflight.ts answers
 * the tag/version question.
 *
 * Pure logic (electronExposure) never touches disk; the CLI reads
 * apps/desktop/package.json, prints the verdict and exits 1 when affected so
 * CI or a human can gate on it.
 *
 * Run: npx tsx scripts/electron-vuln.ts [electronVersion]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DESKTOP_LABEL = "apps/desktop/package.json";

/** CVE-2026-85046: Chromium sandbox escape → RCE, actively exploited in the wild. */
export const CVE = "CVE-2026-85046";

/**
 * Static map, curated from Electron release notes: electron version → bundled
 * Chromium version. Only versions we verified against the release notes belong
 * here; anything else resolves to "unknown" (the verdict still stands, because
 * affectedness is decided by the electron version comparison below).
 */
export const CHROMIUM_IN_ELECTRON: Record<string, string> = {
  "44.0.0": "152.0.7977.54",
  "44.1.0": "152.0.7977.54",
  "44.1.1": "152.0.7977.54",
  "44.2.0": "152.0.7977.76",
};

/**
 * Static map of fixed versions: CVE → first Electron release whose Chromium
 * build contains the fix. 44.2.0 bumped Chromium to 152.0.7977.76
 * (electron#53382), which carries the CVE-2026-85046 patch — that is the
 * minimum safe bump on the 44 line (the line this app ships on). Other
 * supported majors (42/43) receive their own backports; pinning those is out
 * of scope here.
 */
export const FIXED_IN: Record<string, string> = {
  [CVE]: "44.2.0",
};

export interface Exposure {
  /** True when the electron version predates the fix for at least mapped CVE. */
  affected: boolean;
  /** Chromium bundled by the given electron version, or "unknown". */
  chromiumVersion: string;
  /** One line per CVE, in the release-preflight "problems" string style. */
  reason: string;
}

/** Semver compare: numeric major/minor/patch, prerelease < release. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = v.split("-", 2);
    const [maj = "0", min = "0", pat = "0"] = core.split(".");
    return { nums: [maj, min, pat].map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  // Same numeric core: a prerelease sorts below the release.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  return pa.pre.localeCompare(pb.pre);
}

/**
 * Exposure of one electron version to every CVE in the fixed-versions map.
 * Empty `problems`-style reasons mean clean; every mapped CVE is reported.
 */
export function electronExposure(
  electronVersion: string,
  fixedIn: Record<string, string> = FIXED_IN,
  chromiumMap: Record<string, string> = CHROMIUM_IN_ELECTRON,
): Exposure {
  const chromiumVersion = chromiumMap[electronVersion] ?? "unknown";
  const reasons: string[] = [];
  for (const [cve, fixed] of Object.entries(fixedIn)) {
    if (compareVersions(electronVersion, fixed) < 0) {
      reasons.push(
        `${DESKTOP_LABEL}: electron ${electronVersion} (Chromium ${chromiumVersion}) is affected by ${cve}` +
          ` — sandbox RCE, actively exploited; fixed in electron ${fixed} (Chromium ${chromiumMap[fixed] ?? "unknown"})`,
      );
    }
  }
  return {
    affected: reasons.length > 0,
    chromiumVersion,
    reason: reasons.join("\n"),
  };
}

function main() {
  const explicit = process.argv[2];
  let electronVersion: string | null = explicit ?? null;
  if (!electronVersion) {
    try {
      const path = fileURLToPath(new URL("../apps/desktop/package.json", import.meta.url));
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { devDependencies?: Record<string, string> };
      electronVersion = parsed.devDependencies?.electron ?? null;
    } catch (err) {
      console.error(`electron-vuln: cannot read ${DESKTOP_LABEL} — ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!electronVersion) {
    console.error(`electron-vuln: no electron devDependency found in ${DESKTOP_LABEL}`);
    process.exitCode = 1;
    return;
  }

  const exposure = electronExposure(electronVersion);
  if (exposure.affected) {
    console.error(`electron-vuln: FAIL ${DESKTOP_LABEL} electron ${electronVersion}`);
    console.error(`  - ${exposure.reason}`);
    console.error(`electron-vuln: bump the electron devDependency to >= ${FIXED_IN[CVE]} and re-run the desktop battery`);
    process.exitCode = 1;
    return;
  }
  console.log(`electron-vuln: OK ${DESKTOP_LABEL} electron ${electronVersion} (Chromium ${exposure.chromiumVersion})`);
  for (const [cve, fixed] of Object.entries(FIXED_IN)) {
    console.log(`  ${cve}: fixed in electron ${fixed}`);
  }
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
