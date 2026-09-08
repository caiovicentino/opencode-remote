/**
 * Every workflow under .github/workflows must PARSE. An unquoted `: ` inside
 * a plain scalar — the step name `Push both references (opt-in:
 * PUBLISH_RELAY_IMAGE=true)` introduced by P2-151 — turns the whole file into
 * a mapping error; GitHub then fails EVERY run of that workflow in 0s
 * ("Invalid workflow file") before any job starts, which is how every release
 * tag since P2-151 died silently. Two layers, so the gate never goes blind:
 *   1. a full parse through js-yaml (in node_modules via electron-builder —
 *      resolved at runtime and reported, never a hard import, so a dependency
 *      tree that drops it degrades to layer 2 with a visible warning);
 *   2. a dependency-free lint of the exact failure class (an unquoted scalar
 *      value carrying `: `), which always runs.
 * Run: npx tsx scripts/workflow-yaml.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

/** Line/value regex of a block mapping entry: `key: value` or `- key: value`. */
const ENTRY_RE = /^(\s*)(?:-\s+)?[A-Za-z_][\w.-]*:\s+(.*\S)\s*$/;
/** Values that are NOT plain scalars (quoted, block, flow, anchor, alias, tag). */
const NON_PLAIN_START = /^["'|>[{&*!]/;

/**
 * Dependency-free lint of the failure class: an unquoted plain scalar value
 * that contains `: ` (a nested mapping indicator). Block scalar bodies
 * (`run: |` lines) are skipped by indentation, comments are ignored. Returns
 * one `line N: …` problem per offending line.
 */
export function unquotedColonProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split("\n");
  let blockIndent: number | null = null; // indent of the key that opened a block scalar
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (indent > blockIndent) continue; // still inside the block scalar body
      blockIndent = null;
    }
    const m = ENTRY_RE.exec(line);
    if (!m) continue;
    const value = m[2]!;
    if (/^[|>]/.test(value)) {
      blockIndent = indent;
      continue;
    }
    if (NON_PLAIN_START.test(value)) continue;
    // a ` #` starts a trailing comment — only the scalar part counts
    const scalar = value.split(" #")[0]!;
    if (scalar.includes(": ")) problems.push(`line ${i + 1}: unquoted scalar contains ': ' — quote the value: ${line.trim()}`);
  }
  return problems;
}

// --- the lint itself, pinned on the P2-151 shape ------------------------------

const p2151 = `      - name: Push both references (opt-in: PUBLISH_RELAY_IMAGE=true)\n        if: vars.PUBLISH_RELAY_IMAGE == 'true'\n`;
const p2151Problems = unquotedColonProblems(p2151);
check("lint: the P2-151 step name is flagged with its line number", p2151Problems.length === 1 && p2151Problems[0]!.startsWith("line 1:"), JSON.stringify(p2151Problems));
check("lint: the same name quoted passes", unquotedColonProblems(p2151.replace("name: Push both references (opt-in: PUBLISH_RELAY_IMAGE=true)", 'name: "Push both references (opt-in: PUBLISH_RELAY_IMAGE=true)"')).length === 0);
check(
  "lint: block scalar bodies (run: |) may carry ': ' freely",
  unquotedColonProblems("      - name: ok\n        run: |\n          echo \"Signing profile: ${{ steps.signing.outputs.mode }}\"\n          gh release view --json a,b\n      - uses: x\n").length === 0,
);
check("lint: a trailing comment after the scalar is not part of the value", unquotedColonProblems("      - uses: actions/checkout@11d5960a # v4\n").length === 0);
check("lint: flow/quoted/anchored values are never plain scalars", unquotedColonProblems("a: [x: y]\nb: {k: v}\nc: 'x: y'\nd: \"x: y\"\n").length === 0);
check("lint: comments and blank lines are ignored", unquotedColonProblems("# note: this is fine\n\n").length === 0);

// --- every real workflow file: lint + full parse ------------------------------

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".github", "workflows");
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
check("workflows: at least ci.yml and release.yml exist", files.includes("ci.yml") && files.includes("release.yml"), files.join(","));

type YamlLoader = { load: (text: string) => unknown };
let yaml: YamlLoader | null = null;
try {
  yaml = createRequire(import.meta.url)("js-yaml") as YamlLoader;
} catch {
  console.log("WARN js-yaml not resolvable — full-parse layer skipped (the ': ' lint still ran)");
}

for (const file of files) {
  const text = readFileSync(join(dir, file), "utf8");
  const lint = unquotedColonProblems(text);
  check(`${file}: no unquoted ': ' inside a scalar value`, lint.length === 0, lint.join("\n"));
  if (!yaml) continue;
  let parsed: unknown;
  let error = "";
  try {
    parsed = yaml.load(text);
  } catch (err) {
    error = String(err).split("\n")[0] ?? String(err);
  }
  check(`${file}: parses as YAML`, !error, error);
  const doc = parsed as { jobs?: Record<string, unknown>; on?: unknown } | undefined;
  const jobs = doc && typeof doc === "object" && doc.jobs && typeof doc.jobs === "object" ? Object.keys(doc.jobs) : [];
  check(`${file}: declares a trigger and at least one job`, !!doc && "on" in doc && jobs.length > 0, `jobs: ${jobs.join(",")}`);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall workflow-yaml tests passed");
