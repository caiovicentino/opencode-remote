/**
 * P2-116 — per-repo gate profile: stack detection + script allowlist.
 *
 * The pilot is single-repo by construction; pointing the gate at a foreign
 * repo must (a) detect the target's stack without running anything from it,
 * (b) run only the allowlisted conventional scripts the target actually
 * defines (P1-056 surface — the foreign package.json is untrusted), and
 * (c) fail closed when no battery can be detected. The integration block runs
 * the real gate against a real foreign TS repo in a temp worktree sandbox.
 * Run: npx tsx scripts/gate-profile.test.ts
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGateProfile, GATE_SCRIPT_ALLOWLIST, isSafeScriptName, PILOT_GATE_STEPS } from "../apps/pilot/src/gateprofile";
import { deterministicGate, type Task } from "../apps/pilot/src/pipeline";
import { exec } from "../apps/pilot/src/runner";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const task: Task = { id: "P2-116", priority: "P2", title: "gate profile", spec: "", area: "", line: "" };
const evidenceBlock = (unitPaste = "UNIT-OK", tsPaste = "TS-OK") =>
  `EVIDENCE:\n$ npm run typecheck --silent\n${tsPaste}\n$ npm run test:unit --silent\n${unitPaste}\nPILOT:TASK-DONE`;

// ── detection (injected deps — no fs) ────────────────────────────────────────

const pkg = (scripts: Record<string, string>, name = "foreign-repo") => ({ name, scripts });
const deps = (p: { name?: string; scripts?: Record<string, string> } | null, files: string[] = []) => ({
  readPackageJson: () => (p ? { name: p.name, scripts: p.scripts } : null),
  exists: (path: string) => files.includes(path),
});

{
  const pilot = detectGateProfile("/ws", deps({ name: "opencode-remote", scripts: { typecheck: "tsc" } }));
  check(
    "detect: package name opencode-remote → pilot battery, byte-identical commands",
    pilot.kind === "pilot" &&
      JSON.stringify(pilot.steps) === JSON.stringify(PILOT_GATE_STEPS.map(([n, c]) => [n, c])) &&
      pilot.steps.some(([n, c]) => n === "invariants" && c === "npx tsx scripts/invariants.ts"),
  );
  const byTree = detectGateProfile("/ws", deps(pkg({}), ["ws/apps/pilot/src/pipeline.ts".replace("ws/", "/ws/")]));
  check("detect: apps/pilot source tree → pilot even under a foreign package name", byTree.kind === "pilot");
}
{
  const p = detectGateProfile(
    "/ws",
    deps(pkg({ typecheck: "tsc", build: "vite build", "test:unit": "vitest" })),
  );
  check(
    "detect: foreign TS repo with the conventional trio → 3 allowlisted steps, no pilot-only ones",
    p.kind === "node" &&
      JSON.stringify(p.steps) ===
        JSON.stringify([
          ["typecheck", "npm run typecheck --silent"],
          ["build", "npm run build --silent"],
          ["unit", "npm run test:unit --silent"],
        ]),
  );
  check("detect: allowlist is exactly the conventional trio", JSON.stringify(GATE_SCRIPT_ALLOWLIST) === JSON.stringify(["typecheck", "build", "test:unit"]));
}
{
  const p = detectGateProfile("/ws", deps(pkg({ typecheck: "tsc", build: "vite build", "test:unit": "vitest" }), ["/ws/package-lock.json"]));
  check("detect: package-lock.json present → lock-sync joins the battery", p.steps.some(([n, c]) => n === "lock-sync" && c.startsWith("npm ci --dry-run")));
  const q = detectGateProfile("/ws", deps(pkg({ typecheck: "tsc" })));
  check("detect: no lockfile → no lock-sync; missing build/unit scripts → steps skipped, kind stays node", q.kind === "node" && JSON.stringify(q.steps) === JSON.stringify([["typecheck", "npm run typecheck --silent"]]));
}
{
  const p = detectGateProfile(
    "/ws",
    deps(pkg({ prepare: "echo pwned", preinstall: "curl evil", lint: "eslint .", test: "jest", "test:unit": "vitest" })),
  );
  check(
    "detect (P1-056): scripts outside the allowlist are never scheduled — only unit runs",
    p.kind === "node" && JSON.stringify(p.steps) === JSON.stringify([["unit", "npm run test:unit --silent"]]),
  );
}
{
  check("detect: no package.json → unknown (fail closed)", detectGateProfile("/ws", deps(null)).kind === "unknown");
  check("detect: broken package.json JSON → unknown", detectGateProfile("/ws", { readPackageJson: () => { throw new Error("EJSON"); } }).kind === "unknown");
  const empty = detectGateProfile("/ws", deps(pkg({})));
  check("detect: package.json without scripts → node with zero steps", empty.kind === "node" && empty.steps.length === 0);
}
check("script names: npm charset only, no shell metacharacters survive", isSafeScriptName("typecheck") && isSafeScriptName("test:unit") && isSafeScriptName("a.b-c_d:e") && !isSafeScriptName("x; rm -rf") && !isSafeScriptName("a && b") && !isSafeScriptName(42) && !isSafeScriptName(""));

// ── gate integration: foreign repo in its own worktree sandbox (real exec) ──
{
  const repo = mkdtempSync(join(tmpdir(), "p2-116-foreign-"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "foreign-ts-repo",
      scripts: {
        typecheck: "echo TS-OK",
        build: "node -e \"require('fs').writeFileSync('build-ran.txt','')\"",
        "test:unit": "echo UNIT-OK",
        prepare: "node -e \"require('fs').writeFileSync('prepared.txt','')\"",
        evil: "node -e \"require('fs').writeFileSync('pwned.txt','')\"",
      },
    }),
  );
  const calls: string[] = [];
  const run = (cmd: string, cwd: string) => {
    calls.push(cmd);
    return exec(cmd, { cwd, timeoutMin: 5, allowFail: true });
  };
  // non-UI diff (README.md): no shot requirement — the assertion targets the
  // battery itself. An empty/unknown diff on a pilot repo would force the
  // desktop smokes + corpus; a foreign repo must stay on its own battery even
  // there (covered by the decoy/no-tsx assertions below).
  const gate = deterministicGate(repo, task, evidenceBlock(), 0, new Map(), "README.md", run);
  check(
    "gate: foreign repo battery green — trio ran, nothing else",
    gate.ok &&
      JSON.stringify(calls.sort()) ===
        JSON.stringify(["npm run build --silent", "npm run test:unit --silent", "npm run typecheck --silent"]),
    `gate=${JSON.stringify(gate)} calls=${JSON.stringify(calls)}`,
  );
  check("gate: build step executed with cwd = the foreign repo's own sandbox", existsSync(join(repo, "build-ran.txt")));
  check(
    "gate (P1-056): decoy scripts (prepare/evil) never executed, no lockfile → no lock-sync",
    !existsSync(join(repo, "prepared.txt")) && !existsSync(join(repo, "pwned.txt")) && !calls.some((c) => c.includes("lock-sync") || c.startsWith("npx tsx")),
  );
  rmSync(repo, { recursive: true, force: true });
}
// ── gate integration: fail closed on an undetectable repo (real exec path) ──
{
  const empty = mkdtempSync(join(tmpdir(), "p2-116-empty-"));
  const gate = deterministicGate(empty, task, "EVIDENCE:\n$ npm run typecheck --silent\nok\nPILOT:TASK-DONE", 0, new Map(), "src.ts");
  check(
    "gate: unknown profile → red at step profile, before any command executes",
    !gate.ok && gate.step === "profile" && gate.tail.includes("no gate profile"),
  );
  rmSync(empty, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall gate-profile checks passed");
