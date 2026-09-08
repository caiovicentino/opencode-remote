/**
 * P2-325: tests for the artifact-size budget gate.
 *
 * scripts/artifactbudget.ts (pure verdict) gets the table battery: every
 * cause (valid, absent, zero, negative, non-numeric size, above the ceiling),
 * the empty list, a missing expected type, the ignored unknown suffix and
 * determinism. scripts/check-artifact-size.ts (the collector) runs against a
 * temp dir the test mounts itself — in-ceiling approval, above-ceiling exit
 * code 1 through the real CLI, fail-closed on a missing or empty dir — and
 * the real .github/workflows/ci.yml is pinned fail-closed: both packaging
 * jobs must declare the new step, after the bundle smoke, with shell bash and
 * its own timeout-minutes.
 * Run: npx tsx scripts/artifactbudget.test.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_BUDGETS, artifactProblems, artifactTypeOf, type ArtifactEntry } from "./artifactbudget";
import { PACKAGING_DIR, collectProblems } from "./check-artifact-size";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const DMG_CEILING = ARTIFACT_BUDGETS.dmg;
const IN = DMG_CEILING - 1_000_000;
const OVER = DMG_CEILING + 1_000_000;

// --- table: the size causes of one known-type artifact ------------------------

check(
  "valid: dmg within the ceiling has no problems",
  artifactProblems([{ name: "OpenCode-Remote-0.2.0-arm64.dmg", bytes: IN }]).length === 0,
);

const absent = artifactProblems([{ name: "a.dmg" }]);
check(
  "absent: missing size is a problem citing the file",
  absent.length === 1 && absent[0].includes("a.dmg") && absent[0].includes("size missing"),
  JSON.stringify(absent),
);

const zero = artifactProblems([{ name: "a.dmg", bytes: 0 }]);
check(
  "zero: 0 bytes is a broken package, reported",
  zero.length === 1 && zero[0].includes("0 bytes"),
  JSON.stringify(zero),
);

const negative = artifactProblems([{ name: "a.dmg", bytes: -7 }]);
check(
  "negative: negative size is reported with the value",
  negative.length === 1 && negative[0].includes("-7"),
  JSON.stringify(negative),
);

const notNumber = artifactProblems([
  { name: "a.dmg", bytes: "big" as unknown as number },
  { name: "b.dmg", bytes: Number.NaN },
]);
check(
  "non-numeric: string and NaN sizes are reported",
  notNumber.length === 2 && notNumber.every((p) => p.includes("not a number")),
  JSON.stringify(notNumber),
);

const above = artifactProblems([{ name: "OpenCode-Remote-0.2.0-arm64.dmg", bytes: OVER }]);
check(
  "above ceiling: cites measured value, ceiling and remaining slack",
  above.length === 1 &&
    above[0].includes("measured") &&
    above[0].includes("dmg") &&
    above[0].includes("slack"),
  JSON.stringify(above),
);

check(
  "above ceiling: exactly at the ceiling is green",
  artifactProblems([{ name: "a.dmg", bytes: DMG_CEILING }]).length === 0,
);

// --- table: fixed order, no short-circuit, unknown suffix ignored -------------

const mixed = artifactProblems([
  { name: "z-last.dmg", bytes: OVER },
  { name: "broken.zip", bytes: 0 },
  { name: "notes.txt", bytes: -5 },
  { name: "latest-mac.yml", bytes: Number.NaN },
  { name: "OpenCode Remote", bytes: OVER },
  { name: "a.exe", bytes: OVER },
]);
check(
  "fixed order: problems come in input order and every cause is reported at once",
  mixed.length === 3 &&
    mixed[0].includes("z-last.dmg") &&
    mixed[1].includes("broken.zip") &&
    mixed[2].includes("a.exe"),
  JSON.stringify(mixed),
);

check(
  "unknown suffix: ignored even with absurd sizes, dotfile and suffixless too",
  artifactProblems([
    { name: "notes.txt", bytes: 10 ** 12 },
    { name: ".yml", bytes: -1 },
    { name: "binary-no-suffix", bytes: Number.NaN },
  ]).length === 0,
);

check("type: uppercase suffix is normalized", artifactTypeOf("Setup.DMG") === "dmg");
check("type: dotfile has no type", artifactTypeOf(".yml") === null);
check("type: suffixless has no type", artifactTypeOf("OpenCode Remote") === null);

// --- table: expected types -----------------------------------------------------

const missingExpected = artifactProblems([{ name: "a.zip", bytes: IN }], ["dmg", "zip"]);
check(
  "expected: the type that never appeared is reported once, the seen one is not",
  missingExpected.length === 1 && missingExpected[0].includes('"dmg"') && missingExpected[0].includes("ceiling"),
  JSON.stringify(missingExpected),
);

check(
  "expected: unknown expected type fails closed instead of being ignored",
  artifactProblems([{ name: "a.dmg", bytes: IN }], ["msi"]).length === 1,
);

check(
  "empty list: no expectations → no problems",
  artifactProblems([], []).length === 0,
);
const emptyWithExpect = artifactProblems([], ["dmg", "exe"]);
check(
  "empty list: with expectations every missing type is reported in order",
  emptyWithExpect.length === 2 && emptyWithExpect[0].includes("dmg") && emptyWithExpect[1].includes("exe"),
  JSON.stringify(emptyWithExpect),
);

// --- determinism ----------------------------------------------------------------

const input: ArtifactEntry[] = [
  { name: "OpenCode-Remote-0.2.0-arm64.dmg", bytes: OVER },
  { name: "broken.zip" },
  { name: "notes.txt", bytes: 3 },
];
check(
  "determinism: same input twice → identical verdict",
  JSON.stringify(artifactProblems(input, ["exe"])) === JSON.stringify(artifactProblems(input, ["exe"])),
);

// --- the collector against a temp dir -------------------------------------------

const root = mkdtempSync(join(tmpdir(), "ocr-artifact-budget-"));
try {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "OpenCode-Remote-0.2.0-arm64.dmg"), "x");
  truncateSync(join(dist, "OpenCode-Remote-0.2.0-arm64.dmg"), IN);
  writeFileSync(join(dist, "OpenCode-Remote-0.2.0-arm64.zip"), "x");
  truncateSync(join(dist, "OpenCode-Remote-0.2.0-arm64.zip"), IN);
  writeFileSync(join(dist, "builder-debug.yml"), "blockmap");
  check("collector: in-ceiling distributables plus unknown suffix approve", collectProblems(dist).length === 0);
  check(
    "collector: --expect satisfied when the type is present",
    collectProblems(dist, ["dmg", "zip"]).length === 0,
  );

  // The unpacked payload dirs are skipped, so a fat .exe app binary inside
  // win-unpacked is never mistaken for the NSIS installer.
  const winUnpacked = join(dist, "win-unpacked");
  mkdirSync(winUnpacked, { recursive: true });
  writeFileSync(join(winUnpacked, "OpenCode Remote.exe"), "x");
  truncateSync(join(winUnpacked, "OpenCode Remote.exe"), OVER);
  check("collector: unpacked payload dirs are skipped", collectProblems(dist).length === 0);
  rmSync(winUnpacked, { recursive: true, force: true });

  truncateSync(join(dist, "OpenCode-Remote-0.2.0-arm64.dmg"), OVER);
  const over = collectProblems(dist);
  check(
    "collector: one artifact above its ceiling is the only problem",
    over.length === 1 && over[0].includes("OpenCode-Remote-0.2.0-arm64.dmg"),
    JSON.stringify(over),
  );

  check(
    "collector: missing packaging dir fails closed",
    collectProblems(join(root, "ghost")).length === 1,
  );
  const emptyDir = join(root, "empty");
  mkdirSync(emptyDir, { recursive: true });
  check("collector: empty packaging dir fails closed", collectProblems(emptyDir).length === 1);

  // Real CLI: the exit codes the CI step relies on.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(repoRoot, "scripts", "check-artifact-size.ts");
  let code = 0;
  try {
    execFileSync(process.execPath, [tsxEntry, script, "--dir", join(root, "ghost")], { stdio: "pipe" });
    code = 0;
  } catch (err) {
    code = (err as { status?: number }).status ?? -1;
  }
  check("cli: missing dir exits 1", code === 1, `exit ${code}`);
  try {
    execFileSync(process.execPath, [tsxEntry, script, "--dir", dist], { stdio: "pipe" });
    code = 0;
  } catch (err) {
    code = (err as { status?: number }).status ?? -1;
  }
  check("cli: above-ceiling artifact exits 1", code === 1, `exit ${code}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// --- real-repo assertion: ci.yml declares the step in both packaging jobs --------

const ci = readFileSyncSafe(join(repoRoot(), ".github", "workflows", "ci.yml"));
const lines = ci.split(/\r?\n/);

function jobBlock(jobKey: string): string[] {
  const start = lines.findIndex((l) => l === `  ${jobKey}:`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_.-]+:\s*$/.test(l));
  return lines.slice(start, end < 0 ? lines.length : end);
}

const STEP_NAME = "Check artifact sizes";
for (const job of ["desktop-package", "desktop-package-win"]) {
  const block = jobBlock(job);
  check(`ci.yml: job ${job} exists`, block.length > 0);
  const nameIdx = block.map((l) => l.trim()).indexOf(`- name: ${STEP_NAME}`);
  check(`ci.yml: ${job} declares the "${STEP_NAME}" step exactly once`, nameIdx > 0 && block.filter((l) => l.trim() === `- name: ${STEP_NAME}`).length === 1);
  const after = block.slice(nameIdx, nameIdx + 6).map((l) => l.trim());
  check(`ci.yml: ${job} step declares shell: bash`, after.includes("shell: bash"), after.join(" | "));
  check(
    `ci.yml: ${job} step declares its own timeout-minutes`,
    after.some((l) => /^timeout-minutes: \d+$/.test(l)),
    after.join(" | "),
  );
  const smokeIdx = block.findIndex((l) => l.includes("run: npm run dist:smoke --workspace @ocr/desktop -- --no-installer"));
  check(
    `ci.yml: ${job} runs the artifact-size gate right after the bundle smoke step`,
    smokeIdx > 0 && nameIdx > smokeIdx && nameIdx - smokeIdx < 12,
    `smoke at ${smokeIdx}, gate at ${nameIdx}`,
  );
  const runIdx = block.findIndex((l) => l.trim() === "run: npm run check:artifact-size");
  check(`ci.yml: ${job} gate invokes npm run check:artifact-size`, runIdx > 0, `run at ${runIdx}`);
}

// package.json wiring
const pkg = JSON.parse(readFileSyncSafe(join(repoRoot(), "package.json")));
check(
  "package.json: check:artifact-size runs the collector",
  pkg.scripts["check:artifact-size"] === "tsx scripts/check-artifact-size.ts",
);
check(
  "package.json: the test battery includes this file",
  pkg.scripts["test:unit"].includes("scripts/artifactbudget.test.ts"),
);

check(
  "docs: the packaging dir constant still matches the real output path",
  PACKAGING_DIR === "apps/desktop/dist",
);

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readFileSyncSafe(path: string): string {
  return readFileSync(path, "utf8");
}

console.log(failures === 0 ? "\nartifactbudget tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
