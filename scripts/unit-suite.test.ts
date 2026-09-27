/**
 * scripts/unit-suite.ts — the unit battery runner and its list
 * (scripts/unit-suite.txt), which replaced the one-line `&&` chain in
 * package.json that nearly every task edited and every pair of tasks in
 * flight collided on.
 *
 * Pins: the list grammar (and its fail-closed problems), the chain's
 * semantics (order, flags, stop at the first failure, the failing file's
 * exit code, 128+signo on a signal death), output that is deterministic
 * modulo durations (the evidence gate's normalization), the legacy-chain
 * fold, a real run through tsx in a throwaway repo (cwd, argv, stop), a
 * real git merge + rebase of two parallel appends (clean only because of
 * merge=union), and the real repo wiring — including the portable-suite
 * parity (PORTABLE_TESTS ⊆ the list) and the P2-133 orphan-test
 * reachability over the real repo.
 * Run: npx tsx scripts/unit-suite.test.ts
 */
import "./testhome"; // throwaway HOME before any pilot module loads (testhome.ts)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PILOT_GATE_STEPS } from "../apps/pilot/src/gateprofile";
import { PORTABLE_TESTS } from "./portable-suite";
import { unreachableTests, type DeclaredRegistry } from "./testreachability";
import {
  UNIT_SUITE_COMMAND,
  UNIT_SUITE_LIST,
  appendEntries,
  chainEntries,
  entryLabel,
  exitCodeOf,
  foldPlan,
  invokedDirectly,
  missingFileProblems,
  parseUnitSuite,
  readUnitSuite,
  runUnitSuite,
  spawnEntry,
  stepSummaryMarkdown,
  withUnitSuiteCommand,
  type EntryOutcome,
  type SuiteEntry,
} from "./unit-suite";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const A: SuiteEntry = { file: "scripts/a.test.ts", args: [] };
const B: SuiteEntry = { file: "scripts/b.test.ts", args: ["--unit-only"] };
const C: SuiteEntry = { file: "scripts/c.test.ts", args: [] };

// --- the list grammar ------------------------------------------------------------
{
  const p = parseUnitSuite("# header\n\nscripts/a.test.ts\r\n  scripts/b.test.ts   --unit-only  \n# tail\n");
  check(
    "parse: comments and blank lines skipped, CRLF tolerated, order and flags kept",
    p.problems.length === 0 && JSON.stringify(p.entries) === JSON.stringify([A, B]),
    JSON.stringify(p),
  );

  for (const bad of [
    "/abs/scripts/a.test.ts",
    "../scripts/a.test.ts",
    "scripts/../a.test.ts",
    "scripts/sub/a.test.ts",
    "scripts\\a.test.ts",
    "scripts/a.ts",
    "apps/web/a.test.ts",
    "tsx scripts/a.test.ts",
  ]) {
    const r = parseUnitSuite(`${bad}\nscripts/ok.test.ts\n`);
    check(
      `parse: "${bad}" is one problem naming line 1, the valid line still parses`,
      r.problems.length === 1 && r.problems[0].includes("line 1") && r.entries.length === 1,
      JSON.stringify(r.problems),
    );
  }

  const nonFlag = parseUnitSuite("scripts/a.test.ts extra\nscripts/b.test.ts --ok; rm -rf /\nscripts/c.test.ts\n");
  check(
    "parse: anything but --flags after the file is a problem (the list names files, not commands)",
    nonFlag.problems.length === 2 &&
      nonFlag.problems[0].includes('"extra"') &&
      nonFlag.problems[1].includes('"--ok;"') &&
      nonFlag.problems[1].includes('"rm"') &&
      JSON.stringify(nonFlag.entries) === JSON.stringify([C]),
    JSON.stringify(nonFlag.problems),
  );

  const dup = parseUnitSuite("scripts/a.test.ts\nscripts/b.test.ts\nscripts/a.test.ts --unit-only\n");
  check(
    "parse: a file listed twice (what a union merge of two identical appends yields) is one problem naming both lines",
    dup.problems.length === 1 && dup.problems[0].includes("line 3") && dup.problems[0].includes("line 1") && dup.entries.length === 2,
    JSON.stringify(dup.problems),
  );

  const empty = parseUnitSuite("# nothing but comments\n\n");
  check("parse: an empty list is a problem (the battery would run nothing and pass)", empty.problems.length === 1 && empty.problems[0].includes("empty"));

  const missing = missingFileProblems([A, B], (f) => f === A.file);
  check("missing files: one problem per listed file absent from disk", missing.length === 1 && missing[0].includes(B.file));
}

// --- the legacy chain and the fold -------------------------------------------
{
  // the real chain spelled one segment as `&&tsx` (no space) — must parse
  const c = chainEntries("tsx scripts/a.test.ts && tsx scripts/b.test.ts --unit-only &&tsx scripts/c.test.ts");
  check("chain: tsx segments parse in order, flags kept, `&&tsx` tolerated", c.problems.length === 0 && JSON.stringify(c.entries) === JSON.stringify([A, B, C]));

  const bad = chainEntries("tsx scripts/a.test.ts && npm run other && tsx scripts/a.test.ts");
  check(
    "chain: a non-tsx segment and a repeated file are problems (fold them by hand)",
    bad.problems.length === 2 && bad.problems[0].includes("npm run other") && bad.problems[1].includes("twice"),
    JSON.stringify(bad.problems),
  );

  const X: SuiteEntry = { file: "scripts/x.test.ts", args: [] };
  const Y: SuiteEntry = { file: "scripts/y.test.ts", args: [] };
  const plan = foldPlan([A, B, C], [A, X, B, Y]);
  check(
    "fold: chain entries missing from the list are appended in chain order",
    JSON.stringify(plan.append) === JSON.stringify([X, Y]) && plan.orderKept && plan.flagDrift.length === 0,
    JSON.stringify(plan),
  );
  check("fold: listed files absent from the chain are reported, never removed", JSON.stringify(plan.listOnly) === JSON.stringify([C.file]));

  const drift = foldPlan([A, B], [A, { file: B.file, args: [] }]);
  check("fold: a flag difference is reported and left as listed", drift.append.length === 0 && drift.flagDrift.length === 1 && drift.flagDrift[0].includes(B.file));
  check("fold: a shared file out of the chain's relative order is flagged", foldPlan([A, B], [B, A]).orderKept === false);
  check("fold: identical list and chain → nothing to append", foldPlan([A, B, C], [A, B, C]).append.length === 0);

  check("append: entries land one per line after a newline-terminated list", appendEntries("# h\nscripts/a.test.ts\n", [B]) === "# h\nscripts/a.test.ts\nscripts/b.test.ts --unit-only\n");
  check("append: a list without a trailing newline gets one first", appendEntries("scripts/a.test.ts", [C]) === "scripts/a.test.ts\nscripts/c.test.ts\n");
  check("append: nothing to append → text unchanged", appendEntries("scripts/a.test.ts", []) === "scripts/a.test.ts");

  const pkg = '{\n  "name": "x",\n  "scripts": {\n    "build": "b",\n    "test:unit": "tsx scripts/a.test.ts && tsx scripts/b.test.ts",\n    "lint": "l"\n  }\n}\n';
  check(
    "fold: package.json rewrite touches only the test:unit value, byte for byte",
    withUnitSuiteCommand(pkg) === pkg.replace('"tsx scripts/a.test.ts && tsx scripts/b.test.ts"', `"${UNIT_SUITE_COMMAND}"`),
  );
  check("fold: package.json without test:unit → null (never invent the key)", withUnitSuiteCommand('{ "scripts": { "build": "b" } }') === null);
  check("fold: unparseable package.json → null", withUnitSuiteCommand('{ "scripts": { "test:unit": "x" }') === null);
}

// --- chain semantics over a fake exec -----------------------------------------------
{
  function harness(outcomes: EntryOutcome[], tick: number) {
    const ran: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    let t = 1_000;
    const result = runUnitSuite([A, B, C], {
      exec: (e) => {
        ran.push(entryLabel(e));
        t += tick * 7;
        return outcomes[ran.length - 1] ?? { status: 0, signal: null };
      },
      now: () => (t += tick),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { result, ran, out, err };
  }
  const ok: EntryOutcome = { status: 0, signal: null };
  // the evidence gate's duration mask (normalizeEvidenceLine: \d+ms, \d+(.\d+)?s → TIME)
  const TIME = (l: string) => l.replace(/\b\d+(\.\d+)?(ms|min|h|s)\b/g, "TIME");

  const green = harness([ok, ok, ok], 5);
  check(
    "run: all green → exit 0, every file ran once in list order with its flags",
    green.result.code === 0 && JSON.stringify(green.ran) === JSON.stringify(["scripts/a.test.ts", "scripts/b.test.ts --unit-only", "scripts/c.test.ts"]),
    JSON.stringify(green),
  );
  check(
    "run: one run line and one ok line per file, then the total; nothing on stderr",
    green.out.length === 8 &&
      green.out[0] === `unit-suite: 3 file(s) from ${UNIT_SUITE_LIST}` &&
      green.out[1] === "unit-suite: run 1/3 scripts/a.test.ts" &&
      /^unit-suite: ok 2\/3 scripts\/b\.test\.ts --unit-only \(\d+ms\)$/.test(green.out[4]) &&
      /^unit-suite: OK 3 file\(s\) in \d+\.\ds$/.test(green.out[7]) &&
      green.err.length === 0,
    JSON.stringify(green.out),
  );

  const red = harness([ok, { status: 3, signal: null }, ok], 5);
  check("run: the first failure stops the battery — later files never run", JSON.stringify(red.ran) === JSON.stringify(["scripts/a.test.ts", "scripts/b.test.ts --unit-only"]));
  check("run: the battery exits with the failing file's own code", red.result.code === 3 && red.result.failed?.label === "scripts/b.test.ts --unit-only");
  check(
    "run: stderr names the failing file, its exit, the counts and the exact rerun command",
    red.err.length === 2 &&
      /^unit-suite: FAIL 2\/3 scripts\/b\.test\.ts --unit-only — exit 3 after \d+ms \(1 passed, 1 not run\)$/.test(red.err[0]) &&
      red.err[1] === "unit-suite: rerun just this file: npx tsx scripts/b.test.ts --unit-only",
    JSON.stringify(red.err),
  );
  check("run: no OK total after a failure", !red.out.some((l) => l.startsWith("unit-suite: OK")));

  // --keep-going (local diagnosis): every file runs, every failure is listed
  function harnessKeepGoing(outcomes: EntryOutcome[], tick: number) {
    const ran: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    let t = 1_000;
    const result = runUnitSuite(
      [A, B, C],
      {
        exec: (e) => {
          ran.push(entryLabel(e));
          t += tick * 7;
          return outcomes[ran.length - 1] ?? { status: 0, signal: null };
        },
        now: () => (t += tick),
        out: (l) => out.push(l),
        err: (l) => err.push(l),
      },
      { keepGoing: true },
    );
    return { result, ran, out, err };
  }
  const kg = harnessKeepGoing([{ status: 3, signal: null }, ok, { status: 5, signal: null }], 5);
  check("keep-going: every file runs despite failures", kg.ran.length === 3);
  check(
    "keep-going: exit = the FIRST failure's code, both failures recorded",
    kg.result.code === 3 && kg.result.failed?.label === "scripts/a.test.ts" && JSON.stringify(kg.result.failures?.map((f) => f.code)) === "[3,5]",
    JSON.stringify(kg.result),
  );
  check(
    "keep-going: the closing summary lists every failing file with its rerun command",
    kg.err.some((l) => /^unit-suite: FAILED 2 of 3 file\(s\) in \d+\.\ds \(--keep-going\)/.test(l)) &&
      kg.err.includes("unit-suite:   npx tsx scripts/a.test.ts   # exit 3") &&
      kg.err.includes("unit-suite:   npx tsx scripts/c.test.ts   # exit 5") &&
      !kg.out.some((l) => l.startsWith("unit-suite: OK")),
    JSON.stringify(kg.err),
  );
  const kgSlow = harnessKeepGoing([{ status: 3, signal: null }, ok, { status: 5, signal: null }], 977);
  check("keep-going: output identical modulo durations too", kgSlow.err.map(TIME).join("\n") === kg.err.map(TIME).join("\n") && kgSlow.out.map(TIME).join("\n") === kg.out.map(TIME).join("\n"));
  const kgGreen = harnessKeepGoing([ok, ok, ok], 5);
  check("keep-going: all green behaves like the default (OK total, exit 0)", kgGreen.result.code === 0 && kgGreen.out.some((l) => l.startsWith("unit-suite: OK 3 file(s)")) && kgGreen.err.length === 0);

  check("exit code: a SIGKILL death is 137, like sh", exitCodeOf({ status: null, signal: "SIGKILL" }) === 137);
  check("exit code: a spawn error is 1", exitCodeOf({ status: null, signal: null, error: new Error("ENOENT") }) === 1);
  check("exit code: no status and no signal is 1, never a pass", exitCodeOf({ status: null, signal: null }) === 1);
  const killed = harness([{ status: null, signal: "SIGTERM" }], 5);
  check("run: a signal death fails with 128+signo and says so", killed.result.code === 143 && killed.err[0].includes("killed by SIGTERM"));

  // Evidence gate compatibility: the builder pastes the tail of its own run
  // and the gate re-runs the command; lines are compared after
  // normalizeEvidenceLine (durations → TIME). Two runs with very different
  // clocks must therefore print the same lines once durations are masked.
  const slow = harness([ok, ok, ok], 977);
  check("determinism: the raw lines of two runs differ only in durations", slow.out.join("\n") !== green.out.join("\n"));
  check("determinism: runner output is identical modulo durations (evidence-gate safe)", slow.out.map(TIME).join("\n") === green.out.map(TIME).join("\n"), JSON.stringify(slow.out.map(TIME)));
  const redSlow = harness([ok, { status: 3, signal: null }, ok], 977);
  check("determinism: the failure lines too", redSlow.err.map(TIME).join("\n") === red.err.map(TIME).join("\n"));

  const md = stepSummaryMarkdown({ code: 0, timings: [{ label: "scripts/a.test.ts", ms: 10, ok: true }, { label: "scripts/b.test.ts", ms: 900, ok: true }] }, 2);
  check("summary: every file, slowest first", md.indexOf("scripts/b.test.ts") < md.indexOf("scripts/a.test.ts") && md.includes("all 2 file(s) passed"));
  const mdRed = stepSummaryMarkdown({ code: 3, timings: [{ label: "scripts/a.test.ts", ms: 10, ok: false }], failed: { index: 0, label: "scripts/a.test.ts" } }, 2);
  check("summary: a failure names the file and the exit code", mdRed.includes("FAILED at `scripts/a.test.ts` (exit 3)") && mdRed.includes("1/2 file(s) ran"));
  check(
    "summary: the unit list titles it by default, the portable suite passes its own title",
    md.startsWith(`### Unit battery (${UNIT_SUITE_LIST}) — per-file timings`) &&
      stepSummaryMarkdown({ code: 0, timings: [] }, 0, "Portable battery (scripts/portable-suite.ts)").startsWith("### Portable battery (scripts/portable-suite.ts) — per-file timings"),
  );
}

// --- a real run through tsx in a throwaway repo -------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "ocr-unit-suite-"));
  try {
    mkdirSync(join(tmp, "scripts"));
    // relative writes land in the child's cwd — which must be the repo root
    writeFileSync(join(tmp, "scripts", "a.test.ts"), 'import { writeFileSync } from "node:fs";\nwriteFileSync("a.out", JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n');
    writeFileSync(join(tmp, "scripts", "b.test.ts"), "process.exit(7);\n");
    writeFileSync(join(tmp, "scripts", "c.test.ts"), 'import { writeFileSync } from "node:fs";\nwriteFileSync("c.out", "ran");\n');
    const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
    const lines: string[] = [];
    const result = runUnitSuite([{ file: "scripts/a.test.ts", args: ["--unit-only"] }, { file: "scripts/b.test.ts", args: [] }, C], {
      exec: spawnEntry(tmp, tsxCli),
      now: () => performance.now(),
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    const aOut = existsSync(join(tmp, "a.out")) ? (JSON.parse(readFileSync(join(tmp, "a.out"), "utf8")) as { cwd: string; argv: string[] }) : null;
    // native realpath + case-folding on win32: TEMP may be an 8.3 short path
    const samePath = (a: string, b: string) => {
      const [x, y] = [realpathSync.native(a), realpathSync.native(b)];
      return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
    };
    check("real run: the file runs from the repo root (cwd)", aOut !== null && samePath(aOut.cwd, tmp), JSON.stringify(aOut));
    check("real run: the listed flags reach the file's argv", JSON.stringify(aOut?.argv) === JSON.stringify(["--unit-only"]), JSON.stringify(aOut));
    check("real run: the battery exits with the failing file's code (7)", result.code === 7, JSON.stringify(lines));
    check("real run: the file after the failure never ran", !existsSync(join(tmp, "c.out")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- the CLI guard compares real paths ---------------------------------------------
{
  const self = fileURLToPath(import.meta.url);
  check("invokedDirectly: the module's own path is a direct invocation", invokedDirectly(import.meta.url, self));
  check("invokedDirectly: another script is not", !invokedDirectly(import.meta.url, join(root, "scripts", "unit-suite.ts")));
  check("invokedDirectly: an empty argv[1] (REPL, -e) is not", !invokedDirectly(import.meta.url, ""));
}

// --- the real CLI: the whole battery under the testhome sandbox ------------------
// POSIX only (the throwaway repo links node_modules with a symlink); the
// sandbox itself is plain env inheritance, the same on every OS.
if (process.platform !== "win32") {
  const tmp = mkdtempSync(join(tmpdir(), "ocr-unit-suite-cli-"));
  const ownerHome = mkdtempSync(join(tmpdir(), "ocr-unit-suite-owner-"));
  try {
    mkdirSync(join(tmp, "scripts"));
    for (const f of ["unit-suite.ts", "testhome.ts"]) copyFileSync(join(root, "scripts", f), join(tmp, "scripts", f));
    symlinkSync(join(root, "node_modules"), join(tmp, "node_modules"), "dir");
    writeFileSync(join(tmp, "package.json"), '{ "type": "module" }\n');
    const probeOut = join(tmp, "probe.json");
    writeFileSync(
      join(tmp, "scripts", "a.test.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(probeOut)}, JSON.stringify({ home: process.env.HOME, testHome: process.env.OCR_TEST_HOME }));\n`,
    );
    writeFileSync(join(tmp, "scripts", "b.test.ts"), "process.exit(4);\n");
    writeFileSync(join(tmp, "scripts", "c.test.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(tmp, "c.out"))}, "ran");\n`);
    writeFileSync(join(tmp, "scripts", "unit-suite.txt"), "scripts/a.test.ts\nscripts/b.test.ts\nscripts/c.test.ts\n");
    // the invoker looks like an owner: its own HOME, no sandbox yet
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: ownerHome, USERPROFILE: ownerHome };
    delete env.OCR_TEST_HOME;
    delete env.GITHUB_STEP_SUMMARY;
    const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
    const runCli = (...args: string[]) =>
      spawnSync(process.execPath, [tsxCli, join(tmp, "scripts", "unit-suite.ts"), ...args], { cwd: tmp, env, encoding: "utf8" });

    const kept = runCli("--keep-going");
    const probe = existsSync(probeOut) ? (JSON.parse(readFileSync(probeOut, "utf8")) as { home?: string; testHome?: string }) : null;
    check(
      "cli: every suite runs under the testhome sandbox — HOME is OCR_TEST_HOME, never the invoker's",
      probe !== null && !!probe.home && probe.home === probe.testHome && probe.home !== ownerHome && realpathSync.native(dirname(probe.home)) === realpathSync.native(tmpdir()),
      JSON.stringify({ probe, ownerHome, stderr: kept.stderr.slice(-400) }),
    );
    check("cli: the sandbox is removed when the battery ends", !!probe?.home && !existsSync(probe.home));
    check("cli: nothing was written under the invoker's HOME", readdirSync(ownerHome).length === 0, JSON.stringify(readdirSync(ownerHome)));
    check(
      "cli --keep-going: the file after the failure still runs; exit = the failure's code",
      kept.status === 4 && existsSync(join(tmp, "c.out")) && kept.stderr.includes("unit-suite: FAILED 1 of 3 file(s)"),
      `${kept.status} ${kept.stderr.slice(-400)}`,
    );
    rmSync(join(tmp, "c.out"), { force: true });
    const fast = runCli();
    check(
      "cli default: fail-fast — the file after the failure never runs, exit = its code",
      fast.status === 4 && !existsSync(join(tmp, "c.out")) && fast.stderr.includes("unit-suite: rerun just this file: npx tsx scripts/b.test.ts"),
      `${fast.status} ${fast.stderr.slice(-400)}`,
    );
    const usage = runCli("--keep-going", "--list");
    check("cli: unknown flag combinations are a usage error (exit 2), nothing runs", usage.status === 2 && usage.stderr.includes("usage:"));
    // Fail-open regression: through a symlinked path the old string guard
    // skipped the CLI and exited 0 with no output — a green that ran nothing.
    const link = `${tmp}-link`;
    symlinkSync(tmp, link, "dir");
    try {
      const viaLink = spawnSync(process.execPath, [tsxCli, join(link, "scripts", "unit-suite.ts"), "--list"], { cwd: tmp, env, encoding: "utf8" });
      check(
        "cli: started through a symlinked path it still runs (never a silent exit 0)",
        viaLink.status === 0 && viaLink.stdout.trim().split("\n").length === 3 && viaLink.stdout.includes("scripts/b.test.ts"),
        `${viaLink.status} ${JSON.stringify(viaLink.stdout)} ${viaLink.stderr.slice(-300)}`,
      );
    } finally {
      rmSync(link, { force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(ownerHome, { recursive: true, force: true });
  }
}

// --- two branches append in parallel: a real git merge and rebase -----------------
{
  const tmp = mkdtempSync(join(tmpdir(), "ocr-unit-suite-git-"));
  const gitconfig = join(tmp, "gitconfig");
  writeFileSync(gitconfig, "");
  // hermetic git: no system/global config (signing, hooks, merge tools), fixed identity
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  const listRel = UNIT_SUITE_LIST;
  const base = "scripts/a.test.ts\nscripts/b.test.ts\n";
  function scenario(withUnion: boolean, mode: "merge" | "rebase"): { clean: boolean; list: string } | null {
    const repo = join(tmp, `${withUnion ? "union" : "plain"}-${mode}`);
    mkdirSync(join(repo, "scripts"), { recursive: true });
    if (git(repo, "init", "-q", "-b", "main").status !== 0) return null;
    writeFileSync(join(repo, ".gitattributes"), withUnion ? "* text=auto eol=lf\nscripts/unit-suite.txt merge=union\n" : "* text=auto eol=lf\n");
    writeFileSync(join(repo, listRel), base);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    git(repo, "checkout", "-qb", "task-x");
    writeFileSync(join(repo, listRel), `${base}scripts/x.test.ts\n`);
    git(repo, "commit", "-qam", "x");
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, listRel), `${base}scripts/y.test.ts\n`);
    git(repo, "commit", "-qam", "y");
    git(repo, "checkout", "-q", "task-x");
    const r = mode === "merge" ? git(repo, "merge", "--no-edit", "-q", "main") : git(repo, "rebase", "-q", "main");
    return { clean: r.status === 0, list: readFileSync(join(repo, listRel), "utf8") };
  }
  const probe = git(tmp, "--version");
  if (probe.status !== 0) {
    check("git merge: git is available for the union-merge proof", false, probe.stderr ?? String(probe.error));
  } else {
    try {
      const merged = scenario(true, "merge");
      check(
        "git merge: two branches that each append a line merge clean with merge=union — both lines kept",
        merged !== null && merged.clean && merged.list.includes("scripts/x.test.ts\n") && merged.list.includes("scripts/y.test.ts\n") && !merged.list.includes("<<<<<<<"),
        JSON.stringify(merged),
      );
      const rebased = scenario(true, "rebase");
      check(
        "git rebase: the same parallel appends rebase clean (the pilot's resume path)",
        rebased !== null && rebased.clean && rebased.list.includes("scripts/x.test.ts\n") && rebased.list.includes("scripts/y.test.ts\n"),
        JSON.stringify(rebased),
      );
      const plain = scenario(false, "merge");
      check(
        "git merge: control — without the attribute the same appends conflict (the attribute is what fixes it)",
        plain !== null && !plain.clean,
        JSON.stringify(plain),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// --- the real repo wiring -------------------------------------------------------------
{
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  check(
    'real repo: package.json test:unit is exactly "tsx scripts/unit-suite.ts" — new tests go to scripts/unit-suite.txt, never back into a chain',
    pkg.scripts["test:unit"] === UNIT_SUITE_COMMAND,
    pkg.scripts["test:unit"],
  );
  const suite = readUnitSuite(root);
  check("real repo: scripts/unit-suite.txt parses clean", suite.problems.length === 0, suite.problems.join("\n"));
  const missing = missingFileProblems(suite.entries, (f) => existsSync(join(root, f)));
  check("real repo: every listed file exists", missing.length === 0, missing.join("\n"));
  check("real repo: this test file is itself in the battery", suite.entries.some((e) => e.file === "scripts/unit-suite.test.ts"));
  const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
  check(
    "real repo: .gitattributes merges the list with merge=union",
    attrs.split(/\r?\n/).some((l) => l.trim() === "scripts/unit-suite.txt merge=union"),
  );

  // Parity: the Windows job runs a SUBSET of this battery. 18 files once sat
  // only in PORTABLE_TESTS — green on the P2-237 classification guard, yet
  // never run by the gate's `npm run test:unit` nor on Linux CI.
  const listed = new Set(suite.entries.map((e) => e.file));
  const windowsOnly = PORTABLE_TESTS.filter((f) => !listed.has(`scripts/${f}`));
  check(
    "parity: every portable (Windows) test also runs in the unit battery — PORTABLE_TESTS ⊆ scripts/unit-suite.txt",
    windowsOnly.length === 0,
    `append to ${UNIT_SUITE_LIST}: ${windowsOnly.map((f) => `scripts/${f}`).join(", ")}`,
  );

  // P2-133, restored: the real-repo reachability assertion left
  // scripts/unit.test.ts with the P1-056 judge split and nothing replaced
  // it. Every scripts/*.test.ts must run in the unit list, the gate battery
  // or CI, or be declared in scripts/test-registry.json with its runner.
  const testFiles = readdirSync(join(root, "scripts"))
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => `scripts/${f}`);
  // the runner reads the list, so for reachability the list IS test:unit
  const scripts = { ...pkg.scripts, "test:unit": suite.entries.map((e) => `tsx ${entryLabel(e)}`).join(" && ") };
  const orphans = unreachableTests(
    testFiles,
    scripts,
    PILOT_GATE_STEPS.map(([, cmd]) => cmd),
    readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"),
    JSON.parse(readFileSync(join(root, "scripts", "test-registry.json"), "utf8")) as DeclaredRegistry,
  );
  check(
    "P2-133: real repo — every test file is executed by a runner or declared in test-registry.json",
    orphans.length === 0,
    `orphan test files (append to ${UNIT_SUITE_LIST} or declare in scripts/test-registry.json): ${orphans.join(", ")}`,
  );

  // A check() placed after a suite's final `if (failures > 0) { … exit(1) }`
  // gate prints FAIL and the suite still exits 0 — unit.test.ts's P2-331 pin
  // did exactly that (eval-04). No suite may call check() after its last gate.
  const postGate = testFiles.filter((file) => {
    const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
    let gate = -1;
    lines.forEach((l, i) => {
      if (/^if \(failures( > 0)?\) \{\s*$/.test(l)) gate = i;
    });
    if (gate < 0) return false;
    let end = gate + 1;
    while (end < lines.length && lines[end] !== "}") end++;
    return lines.slice(end + 1).some((l) => /^\s*check\(/.test(l));
  });
  check("no suite calls check() after its final failures gate (a FAIL there cannot fail the battery)", postGate.length === 0, postGate.join(", "));
}

if (failures > 0) {
  console.error(`\nunit-suite tests: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nunit-suite tests: all green");
