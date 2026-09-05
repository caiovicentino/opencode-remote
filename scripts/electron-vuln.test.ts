/**
 * P2-168: tests for scripts/electron-vuln.ts — the Chromium sandbox RCE
 * exposure audit. The pure electronExposure covers the verdict matrix (before
 * the fix, at the fix, after it, prereleases, unknown chromium mapping); a
 * real CLI spawn proves the exit-code wiring a human or CI would rely on,
 * including the verdict against the REAL apps/desktop/package.json version.
 * Run: npx tsx scripts/electron-vuln.test.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHROMIUM_IN_ELECTRON, CVE, electronExposure, FIXED_IN } from "./electron-vuln";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// --- verdict matrix against the curated static map -----------------------------

const DESKTOP_REASON = (version: string) =>
  `apps/desktop/package.json: electron ${version} (Chromium ${CHROMIUM_IN_ELECTRON[version]}) is affected`;

const vulnerable = electronExposure("44.1.1");
check(
  "affected: 44.1.1 predates the fix and bundles the vulnerable Chromium",
  vulnerable.affected &&
    vulnerable.chromiumVersion === "152.0.7977.54" &&
    vulnerable.reason.includes(DESKTOP_REASON("44.1.1")) &&
    vulnerable.reason.includes(CVE) &&
    vulnerable.reason.includes("fixed in electron 44.2.0"),
  JSON.stringify(vulnerable),
);

const fixed = electronExposure("44.2.0");
check(
  "clean: 44.2.0 is the fixed build and reports its Chromium",
  !fixed.affected && fixed.chromiumVersion === "152.0.7977.76" && fixed.reason === "",
  JSON.stringify(fixed),
);

check(
  "clean: any later patch on the line stays clean",
  !electronExposure("44.3.0").affected,
);

check(
  "clean: a newer major (alpha included) is past the fix",
  !electronExposure("45.0.0-alpha.4").affected,
);

const pre = electronExposure("44.2.0-alpha.1");
check(
  "affected: prerelease of the fixed version sorts below the release",
  pre.affected && pre.reason.includes(CVE),
  JSON.stringify(pre),
);

const unknown = electronExposure("43.9.9");
check(
  "affected: unmapped electron version still gets a verdict, chromium unknown",
  unknown.affected && unknown.chromiumVersion === "unknown" && unknown.reason.includes("Chromium unknown"),
  JSON.stringify(unknown),
);

// --- custom static map (the map is an input, not a global) ---------------------

const custom = electronExposure("1.2.3", { "CVE-test-1": "1.3.0" }, { "1.2.3": "100.0.0.0", "1.3.0": "100.0.1.0" });
check(
  "map input: caller-supplied fixed-versions map drives the verdict",
  custom.affected && custom.reason.includes("CVE-test-1") && custom.reason.includes("fixed in electron 1.3.0"),
  JSON.stringify(custom),
);

const customClean = electronExposure("1.3.0", { "CVE-test-1": "1.3.0" }, {});
check("map input: exactly-at-fixed version is clean", !customClean.affected, JSON.stringify(customClean));

// --- static maps are curated, not empty ----------------------------------------

check("map: the CVE has a fixed version entry", Object.keys(FIXED_IN).includes(CVE) && FIXED_IN[CVE] === "44.2.0");
check(
  "map: fixed build itself has a chromium entry",
  CHROMIUM_IN_ELECTRON[FIXED_IN[CVE]] !== undefined,
);

// --- CLI: real spawn, exit codes against the real package.json -----------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const script = join(repoRoot, "scripts", "electron-vuln.ts");

function runCli(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [tsxEntry, script, ...args], { cwd: repoRoot, encoding: "utf8" });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const realElectron = (
  JSON.parse(readFileSync(join(repoRoot, "apps", "desktop", "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  }
).devDependencies.electron;

const cliReal = runCli();
check(
  "cli: the real apps/desktop electron version exits 0 with a verdict",
  cliReal.code === 0 && cliReal.out.includes(`electron ${realElectron}`) && cliReal.out.includes(CVE),
  cliReal.out,
);

const cliVuln = runCli("44.1.1");
check(
  "cli: explicit vulnerable version exits 1 naming CVE and both Chromium builds",
  cliVuln.code === 1 &&
    cliVuln.out.includes("electron-vuln: FAIL") &&
    cliVuln.out.includes(CVE) &&
    cliVuln.out.includes("152.0.7977.54") &&
    cliVuln.out.includes("152.0.7977.76"),
  cliVuln.out,
);

console.log(failures === 0 ? "\nelectron-vuln tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
