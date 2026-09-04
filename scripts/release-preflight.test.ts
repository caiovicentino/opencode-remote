/**
 * P2-130: tests for scripts/release-preflight.ts — the tag ↔ package.json
 * version gate that runs as the first step of the release job. The pure
 * checkTagVersion covers the matrix (match, drift per file, missing v,
 * non-semver); a real CLI spawn proves the exit-code wiring CI relies on.
 * Run: npx tsx scripts/release-preflight.test.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTagVersion, DESKTOP_LABEL, ROOT_LABEL } from "./release-preflight";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// --- happy path: tag matches both versions -----------------------------------

check("match: v0.2.0 against 0.2.0/0.2.0 has no problems", checkTagVersion("v0.2.0", "0.2.0", "0.2.0").length === 0);

check(
  "match: prerelease semver tag is accepted",
  checkTagVersion("v1.2.3-beta.1", "1.2.3-beta.1", "1.2.3-beta.1").length === 0,
);

// --- drift in exactly one file reports that exact file ------------------------

const rootDrift = checkTagVersion("v0.3.0", "0.2.0", "0.3.0");
check(
  "drift: root package.json reported by exact path",
  rootDrift.length === 1 && rootDrift[0].startsWith(ROOT_LABEL),
  JSON.stringify(rootDrift),
);

const desktopDrift = checkTagVersion("v0.3.0", "0.3.0", "0.2.0");
check(
  "drift: apps/desktop/package.json reported by exact path",
  desktopDrift.length === 1 && desktopDrift[0].startsWith(DESKTOP_LABEL),
  JSON.stringify(desktopDrift),
);

const bothDrift = checkTagVersion("v0.3.0", "0.1.0", "0.2.0");
check(
  "drift: both files stale → both reported at once",
  bothDrift.length === 2 && bothDrift.some((p) => p.startsWith(ROOT_LABEL)) && bothDrift.some((p) => p.startsWith(DESKTOP_LABEL)),
  JSON.stringify(bothDrift),
);

// --- malformed tags ------------------------------------------------------------

const noV = checkTagVersion("0.2.0", "0.2.0", "0.2.0");
check(
  "tag: missing leading v is reported even when versions match",
  noV.length === 1 && noV[0].includes('must start with "v"'),
  JSON.stringify(noV),
);

for (const bad of ["banana", "vbanana", "v1.2", "v1.2.3.4", "v"]) {
  const problems = checkTagVersion(bad, "0.2.0", "0.2.0");
  check(
    `tag: non-semver "${bad}" is reported`,
    problems.length === 1 && problems[0].includes("semver"),
    JSON.stringify(problems),
  );
}

// --- CLI: real spawn, exit codes and dist-smoke output format ------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const script = join(repoRoot, "scripts", "release-preflight.ts");

function runCli(tag: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [tsxEntry, script, tag], { cwd: repoRoot, encoding: "utf8" });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// Tag built from the real package.json versions must pass (matches CI's OK case).
const realRoot = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
const realDesktop = (JSON.parse(readFileSync(join(repoRoot, "apps", "desktop", "package.json"), "utf8")) as { version: string })
  .version;
check(
  "cli: tag equal to the real versions exits 0",
  realRoot === realDesktop && runCli(`v${realRoot}`).code === 0,
  `root=${realRoot} desktop=${realDesktop}`,
);

const cliFail = runCli("v9.9.9");
check(
  "cli: mismatched tag exits 1 listing every problem",
  cliFail.code === 1 &&
    cliFail.out.includes(`release-preflight: FAIL v9.9.9`) &&
    cliFail.out.includes(`- ${ROOT_LABEL}: version ${realRoot} does not match tag v9.9.9`) &&
    cliFail.out.includes(`- ${DESKTOP_LABEL}: version ${realDesktop} does not match tag v9.9.9`) &&
    cliFail.out.includes("2 problem(s) found"),
  cliFail.out,
);

check(
  "cli: non-semver tag exits 1",
  runCli("vnope").code === 1,
);

console.log(failures === 0 ? "\nrelease-preflight tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
