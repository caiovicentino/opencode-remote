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

// --- P3-352 (eval r4): the ci-gate aggregate job ---------------------------
// Every pilot merge of 2026-09-08 landed before its first check started and
// three of four turned a check red after landing; main requires no status
// check. `ci-gate` is the single context to require: it always runs, needs
// every other job and decides through the pure scripts/cigate.ts verdict.
{
  const { CI_GATE_JOB, CI_GATE_SPEC, ciGateVerdict } = await import("./cigate");
  const all = (over: Record<string, string> = {}): Record<string, { result: string }> => {
    const base: Record<string, string> = {
      verify: "success",
      scope: "success",
      "desktop-package": "skipped",
      "desktop-package-win": "skipped",
      "verify-win": "success",
      "relay-image": "skipped",
    };
    return Object.fromEntries(Object.entries({ ...base, ...over }).map(([k, v]) => [k, { result: v }]));
  };
  const green = ciGateVerdict(all());
  check("P3-352: success everywhere + skipped scope-gated jobs is green", green.verdict === "green" && green.lines.length === 6, green.lines.join("\n"));
  check("P3-352: a skipped scope-gated job is reported as the scope job's decision", green.lines.some((l) => l.includes("desktop-package-win=skipped (scope-gated")));
  const redWin = ciGateVerdict(all({ "desktop-package-win": "failure" }));
  check("P3-352: one failed scope-gated job is red (the 2026-09-08 #884/#891 shape)", redWin.verdict === "red" && redWin.lines.some((l) => l.startsWith("ci-gate: RED desktop-package-win=failure")));
  check("P3-352: a cancelled job is red", ciGateVerdict(all({ "verify-win": "cancelled" })).verdict === "red");
  const skippedVerify = ciGateVerdict(all({ verify: "skipped" }));
  check("P3-352: an unconditional job (verify) skipped is red, never a pass", skippedVerify.verdict === "red" && skippedVerify.lines.some((l) => l.includes("verify=skipped (unconditional job skipped")));
  check("P3-352: scope skipped is red too (it has no if: of its own)", ciGateVerdict(all({ scope: "skipped" })).verdict === "red");
  const needs = all() as Record<string, unknown>;
  delete needs["relay-image"];
  const missing = ciGateVerdict(needs);
  check("P3-352: a spec job missing from needs is red (dropped graph edge)", missing.verdict === "red" && missing.lines.some((l) => l.includes("relay-image — missing from needs")));
  check("P3-352: a non-string result is treated as missing (red)", ciGateVerdict({ ...all(), verify: { result: 7 } }).verdict === "red");
  const extra = ciGateVerdict({ ...all(), ghost: { result: "failure" } });
  check("P3-352: a job in needs but not in the spec only warns and never decides", extra.verdict === "green" && extra.lines.some((l) => l.includes("WARN ghost")));
  check("P3-352: no short-circuit — every red cause is listed in one run", ciGateVerdict(all({ verify: "failure", "verify-win": "failure" })).lines.filter((l) => l.includes("RED")).length === 2);
  check("P3-352: unreadable needs (null / array / string) is red with one line", ["x", null, [1], 3].every((v) => { const r = ciGateVerdict(v); return r.verdict === "red" && r.lines.length === 1; }));
  check("P3-352: deterministic — identical input yields identical lines", JSON.stringify(ciGateVerdict(all({ verify: "failure" }))) === JSON.stringify(ciGateVerdict(all({ verify: "failure" }))));
  check("P3-352: the spec's unconditional jobs are exactly verify and scope", JSON.stringify(CI_GATE_SPEC.filter((j) => !j.scopeGated).map((j) => j.name)) === JSON.stringify(["verify", "scope"]));

  // real ci.yml wiring — text assertions (no YAML dependency), fail-closed
  const ci = readFileSync(join(dir, "ci.yml"), "utf8");
  const gateAt = ci.indexOf(`\n  ${CI_GATE_JOB}:\n`);
  check("P3-352: the real ci.yml declares the ci-gate job", gateAt > 0);
  const gateBody = gateAt > 0 ? ci.slice(gateAt) : "";
  const needsLine = /^\s{4}needs:\s*\[([^\]]+)\]\s*$/m.exec(gateBody);
  const needed = needsLine ? needsLine[1]!.split(",").map((s) => s.trim()).filter(Boolean).sort() : [];
  const jobsSection = ci.slice(ci.indexOf("\njobs:\n"));
  const jobKeys = [...jobsSection.matchAll(/^ {2}([A-Za-z0-9_.-]+):\s*$/gm)].map((m) => m[1]!).filter((n) => n !== CI_GATE_JOB).sort();
  check("P3-352: ci-gate needs EVERY other job of ci.yml (a new job cannot bypass the gate)", needed.length > 0 && JSON.stringify(needed) === JSON.stringify(jobKeys), `needs=${needed.join(",")} jobs=${jobKeys.join(",")}`);
  check("P3-352: the spec mirrors the real job set", JSON.stringify([...CI_GATE_SPEC.map((j) => j.name)].sort()) === JSON.stringify(jobKeys), jobKeys.join(","));
  check("P3-352: ci-gate always runs (if: always()) so a failed dependency still produces a verdict", /^\s{4}if:\s*always\(\)\s*$/m.test(gateBody));
  check("P3-352: ci-gate is the last job of ci.yml (nothing declared after it escapes the gate)", gateAt > 0 && !/^ {2}[A-Za-z0-9_.-]+:\s*$/m.test(gateBody.slice(gateBody.indexOf(":") + 1)));
  check("P3-352: ci-gate declares a job-level timeout and least-privilege permissions", /^\s{4}timeout-minutes:\s*\d+\s*$/m.test(gateBody) && /^\s{4}permissions:\s*$\n\s{6}contents:\s*read\s*$/m.test(gateBody));
  check("P3-352: the verdict step feeds toJSON(needs) to scripts/check-ci-gate.ts with shell bash and its own timeout", gateBody.includes("toJSON(needs)") && gateBody.includes("scripts/check-ci-gate.ts") && /^\s{8}shell:\s*bash\s*$/m.test(gateBody) && /^\s{8}timeout-minutes:\s*\d+\s*$/m.test(gateBody));
  check("P3-352: ci-gate never uploads, publishes or reads a secret", !/upload-artifact|gh release|secrets\./.test(gateBody));
  for (const j of CI_GATE_SPEC) {
    const at = ci.indexOf(`\n  ${j.name}:\n`);
    // job body = from its key until the next 2-space job key
    const next = at > 0 ? ci.slice(at + 1).search(/\n {2}[A-Za-z0-9_.-]+:\s*\n/) : -1;
    const jobBody = at > 0 ? ci.slice(at, next > 0 ? at + 1 + next : undefined) : "";
    const hasIf = /^\s{4}if:\s*needs\.scope\.outputs/m.test(jobBody);
    check(`P3-352: spec scopeGated=${j.scopeGated} for ${j.name} matches the real if: on the scope outputs`, at > 0 && hasIf === j.scopeGated);
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall workflow-yaml tests passed");
