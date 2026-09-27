/**
 * The unit battery (`npm run test:unit`) — one runner, one list.
 *
 * The battery used to be a one-line `tsx a && tsx b && …` chain in
 * package.json. Nearly every task appended to that single line, so any two
 * tasks in flight collided on it and the pilot's conflict repair escalated
 * ("package.json: code hunk changes semantics" — P3-358, RT-439). The list
 * now lives in scripts/unit-suite.txt, one test file per line in run order,
 * and .gitattributes merges that file with `merge=union`: two branches that
 * each append a line merge cleanly in every local merge/rebase (the pilot's
 * conflict repair and resume rebase, an operator's fold).
 *
 * Behavior is the chain's:
 *   - same files, same order, same extra argv (e.g. `--unit-only`);
 *   - each file runs as `tsx <file> [flags]` from the repo root with the
 *     inherited stdio and environment — no shell, no per-file timeout;
 *   - the first failing file stops the battery and its exit code becomes the
 *     battery's (a signal death maps to 128+signo, like sh).
 * Added on top: a `run`/`ok` line per file with its duration and a closing
 * total. Every runner line is deterministic modulo the durations, which the
 * evidence gate normalizes (`\d+ms` / `\d+(.\d+)?s` → TIME in
 * normalizeEvidenceLine), so an honestly pasted tail still matches the
 * gate's re-run — never print ranking- or threshold-dependent text here. A
 * failure adds two stderr lines naming the file and the exact rerun command
 * (stderr is the end of the gate tail). On CI the per-file table, slowest
 * first, lands in the job summary ($GITHUB_STEP_SUMMARY) instead of stdout.
 *
 * `--list` prints the entries; `--fold-chain <git-ref | package.json path>
 * [--dry-run]` folds a legacy chain (a branch cut before the switch) into
 * the list: missing entries are appended in chain order and package.json is
 * rewritten to that ref's content with test:unit pointing back here.
 *
 * Pure helpers are exported for scripts/unit-suite.test.ts; importing this
 * module is side-effect free (CLI guard at the bottom).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The one package.json body of `test:unit`. */
export const UNIT_SUITE_COMMAND = "tsx scripts/unit-suite.ts";
/** The list, repo-relative (POSIX separators, as git and the gate see it). */
export const UNIT_SUITE_LIST = "scripts/unit-suite.txt";

export interface SuiteEntry {
  /** Repo-relative test file, e.g. "scripts/foo.test.ts". */
  file: string;
  /** Extra argv passed to the file (flags only), e.g. ["--unit-only"]. */
  args: string[];
}

export interface ParsedSuite {
  entries: SuiteEntry[];
  problems: string[];
}

/** Tests live in scripts/ (the reachability and portable guards scan it). */
const FILE_RE = /^scripts\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.ts$/;
/** Only flags may follow a file — the list names files, not commands. */
const FLAG_RE = /^--?[A-Za-z0-9][A-Za-z0-9._:=-]*$/;

export function entryLabel(e: SuiteEntry): string {
  return [e.file, ...e.args].join(" ");
}

function entryProblem(file: string, args: readonly string[], at: string): string | null {
  if (!FILE_RE.test(file)) {
    return `unit-suite: ${at}: "${file}" is not a scripts/<name>.test.ts path — one repo-relative test file per line`;
  }
  const bad = args.filter((a) => !FLAG_RE.test(a));
  if (bad.length > 0) {
    return `unit-suite: ${at}: ${file} is followed by ${bad.map((a) => `"${a}"`).join(", ")} — only --flags may follow the file`;
  }
  return null;
}

/**
 * Parse the list: `#` comment lines and blank lines are ignored, every other
 * line is `<file> [--flag…]`. One problem per bad line (malformed path,
 * non-flag argument, a file listed twice — a union merge of two identical
 * appends produces exactly that), plus one when nothing is listed. CRLF is
 * tolerated.
 */
export function parseUnitSuite(text: string): ParsedSuite {
  const entries: SuiteEntry[] = [];
  const problems: string[] = [];
  const firstLine = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const [file, ...args] = line.split(/\s+/);
    const problem = entryProblem(file, args, `line ${i + 1}`);
    if (problem) {
      problems.push(problem);
      return;
    }
    const prev = firstLine.get(file);
    if (prev !== undefined) {
      problems.push(`unit-suite: line ${i + 1}: ${file} is already listed on line ${prev} — a file runs once, keep a single line`);
      return;
    }
    firstLine.set(file, i + 1);
    entries.push({ file, args });
  });
  if (entries.length === 0) {
    problems.push("unit-suite: the list is empty — the battery would run nothing and pass");
  }
  return { entries, problems };
}

/** One problem per listed file that does not exist (`exists` gets the repo-relative path). */
export function missingFileProblems(entries: readonly SuiteEntry[], exists: (file: string) => boolean): string[] {
  return entries
    .filter((e) => !exists(e.file))
    .map((e) => `unit-suite: ${e.file} is listed but does not exist — remove the line or restore the file`);
}

/**
 * Parse a legacy test:unit chain (`tsx a && tsx b --flag`, the body before
 * the switch) into entries. A segment that is not `tsx <scripts/x.test.ts>
 * [--flags]` — or a file repeated — is a problem: fold it by hand.
 */
export function chainEntries(chain: string): ParsedSuite {
  const entries: SuiteEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  chain.split("&&").forEach((raw, i) => {
    const [tool, file = "", ...args] = raw.trim().split(/\s+/);
    const at = `chain segment ${i + 1}`;
    if (tool !== "tsx") {
      problems.push(`unit-suite: ${at}: "${raw.trim()}" is not a tsx invocation — fold it by hand`);
      return;
    }
    const problem = entryProblem(file, args, at);
    if (problem) {
      problems.push(problem);
      return;
    }
    if (seen.has(file)) {
      problems.push(`unit-suite: ${at}: ${file} appears twice in the chain — fold it by hand`);
      return;
    }
    seen.add(file);
    entries.push({ file, args });
  });
  return { entries, problems };
}

export interface FoldPlan {
  /** Chain entries missing from the list, in chain order — appended by the fold. */
  append: SuiteEntry[];
  /** Files present on both sides with different flags (never auto-changed). */
  flagDrift: string[];
  /** The files both sides share keep the chain's relative order in the list. */
  orderKept: boolean;
  /** Listed files absent from the chain (tests added after the switch). */
  listOnly: string[];
}

export function foldPlan(list: readonly SuiteEntry[], chain: readonly SuiteEntry[]): FoldPlan {
  const at = new Map(list.map((e, i) => [e.file, i]));
  const append = chain.filter((c) => !at.has(c.file));
  const flagDrift: string[] = [];
  const positions: number[] = [];
  for (const c of chain) {
    const i = at.get(c.file);
    if (i === undefined) continue;
    positions.push(i);
    if (list[i].args.join(" ") !== c.args.join(" ")) {
      flagDrift.push(`${c.file}: chain runs "${entryLabel(c)}", the list runs "${entryLabel(list[i])}"`);
    }
  }
  const chainFiles = new Set(chain.map((c) => c.file));
  return {
    append,
    flagDrift,
    orderKept: positions.every((p, k) => k === 0 || p > positions[k - 1]),
    listOnly: list.filter((e) => !chainFiles.has(e.file)).map((e) => e.file),
  };
}

/** The list text with `entries` appended, one per line (newline-terminated). */
export function appendEntries(listText: string, entries: readonly SuiteEntry[]): string {
  if (entries.length === 0) return listText;
  const base = listText === "" || listText.endsWith("\n") ? listText : `${listText}\n`;
  return base + entries.map((e) => `${entryLabel(e)}\n`).join("");
}

/**
 * package.json text with ONLY the value of scripts["test:unit"] replaced by
 * the runner command — every other byte kept. Null when the key is absent
 * or the rewrite would change anything else (verified by a parse).
 */
export function withUnitSuiteCommand(pkgText: string): string | null {
  const re = /^(\s*"test:unit"\s*:\s*)"(?:[^"\\]|\\.)*"/m;
  if (!re.test(pkgText)) return null;
  const out = pkgText.replace(re, `$1${JSON.stringify(UNIT_SUITE_COMMAND)}`);
  try {
    const before = JSON.parse(pkgText) as { scripts?: Record<string, string> };
    const after = JSON.parse(out) as { scripts?: Record<string, string> };
    if (!before.scripts || !after.scripts) return null;
    if (JSON.stringify({ ...before, scripts: { ...before.scripts, "test:unit": UNIT_SUITE_COMMAND } }) !== JSON.stringify(after)) {
      return null;
    }
  } catch {
    return null;
  }
  return out;
}

export interface FileTiming {
  label: string;
  ms: number;
  ok: boolean;
}

export interface SuiteRunResult {
  /** The battery's exit code: 0, or the first failing file's. */
  code: number;
  /** One row per file that ran, in run order. */
  timings: FileTiming[];
  /** The failing file, when one failed. */
  failed?: { index: number; label: string };
}

/** What one file's run reports back — the fields of spawnSync's result that matter. */
export interface EntryOutcome {
  status: number | null;
  signal: string | null;
  error?: Error;
}

export interface SuiteRunDeps {
  exec: (entry: SuiteEntry) => EntryOutcome;
  /** Monotonic milliseconds. */
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** sh's view of a child's end: its status, or 128+signo for a signal death. */
export function exitCodeOf(o: EntryOutcome): number {
  if (o.error) return 1;
  if (typeof o.status === "number") return o.status;
  const signo = o.signal ? (constants.signals as Record<string, number | undefined>)[o.signal] : undefined;
  return typeof signo === "number" ? 128 + signo : 1;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Run the entries in order, stop at the first failure. Pure over `deps`, so
 * the semantics are pinned with a fake exec and a fake clock.
 */
export function runUnitSuite(entries: readonly SuiteEntry[], deps: SuiteRunDeps): SuiteRunResult {
  const n = entries.length;
  const timings: FileTiming[] = [];
  deps.out(`unit-suite: ${n} file(s) from ${UNIT_SUITE_LIST}`);
  const started = deps.now();
  for (let i = 0; i < n; i++) {
    const entry = entries[i];
    const label = entryLabel(entry);
    const pos = `${i + 1}/${n}`;
    deps.out(`unit-suite: run ${pos} ${label}`);
    const t0 = deps.now();
    const outcome = deps.exec(entry);
    const ms = Math.round(deps.now() - t0);
    const code = exitCodeOf(outcome);
    if (code !== 0) {
      timings.push({ label, ms, ok: false });
      const how = outcome.error
        ? `could not start (${outcome.error.message})`
        : outcome.status === null && outcome.signal
          ? `killed by ${outcome.signal} (exit ${code})`
          : `exit ${code}`;
      deps.err(`unit-suite: FAIL ${pos} ${label} — ${how} after ${ms}ms (${i} passed, ${n - i - 1} not run)`);
      deps.err(`unit-suite: rerun just this file: npx tsx ${label}`);
      return { code, timings, failed: { index: i, label } };
    }
    timings.push({ label, ms, ok: true });
    deps.out(`unit-suite: ok ${pos} ${label} (${ms}ms)`);
  }
  deps.out(`unit-suite: OK ${n} file(s) in ${seconds(Math.round(deps.now() - started))}`);
  return { code: 0, timings };
}

/** Markdown for $GITHUB_STEP_SUMMARY: every file that ran, slowest first. */
export function stepSummaryMarkdown(result: SuiteRunResult, listed: number): string {
  const total = result.timings.reduce((sum, t) => sum + t.ms, 0);
  const verdict = result.failed ? `FAILED at \`${result.failed.label}\` (exit ${result.code})` : `all ${listed} file(s) passed`;
  const rows = [...result.timings].sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label));
  return [
    "### Unit battery (scripts/unit-suite.txt) — per-file timings",
    "",
    `${verdict} · ${result.timings.length}/${listed} file(s) ran · ${seconds(total)} in test files`,
    "",
    "| file | time | result |",
    "| --- | ---: | --- |",
    ...rows.map((t) => `| \`${t.label}\` | ${seconds(t.ms)} | ${t.ok ? "ok" : "FAIL"} |`),
    "",
  ].join("\n");
}

/** The real exec: `node <tsx cli> <file> [flags]` from the repo root, stdio inherited. */
export function spawnEntry(root: string, tsxCli: string): (entry: SuiteEntry) => EntryOutcome {
  return (entry) => {
    const r = spawnSync(process.execPath, [tsxCli, entry.file, ...entry.args], { cwd: root, stdio: "inherit" });
    return { status: r.status, signal: r.signal, error: r.error };
  };
}

/** The real list of a checkout (throws when the file cannot be read). */
export function readUnitSuite(root = resolve(dirname(fileURLToPath(import.meta.url)), "..")): ParsedSuite {
  return parseUnitSuite(readFileSync(join(root, UNIT_SUITE_LIST), "utf8"));
}

const USAGE = "usage: tsx scripts/unit-suite.ts [--list | --fold-chain <git-ref | package.json path> [--dry-run]]";

function fold(root: string, listText: string, suite: ParsedSuite, source: string | undefined, dryRun: boolean): number {
  if (!source) {
    console.error(USAGE);
    return 2;
  }
  let pkgText: string;
  if (existsSync(source)) {
    pkgText = readFileSync(source, "utf8");
  } else {
    const shown = spawnSync("git", ["show", `${source}:package.json`], { cwd: root, encoding: "utf8" });
    if (shown.status !== 0) {
      console.error(`unit-suite: fold: git show ${source}:package.json failed — ${(shown.stderr ?? "").trim()}`);
      return 1;
    }
    pkgText = shown.stdout;
  }
  let chain: unknown;
  try {
    chain = (JSON.parse(pkgText) as { scripts?: Record<string, unknown> }).scripts?.["test:unit"];
  } catch (e) {
    console.error(`unit-suite: fold: ${source}'s package.json does not parse — ${(e as Error).message}`);
    return 1;
  }
  if (typeof chain !== "string") {
    console.error(`unit-suite: fold: ${source}'s package.json has no scripts["test:unit"]`);
    return 1;
  }
  let listOut = listText;
  if (chain.trim() === UNIT_SUITE_COMMAND) {
    console.log(`unit-suite: fold: ${source} already runs the list — no chain to fold`);
  } else {
    const parsed = chainEntries(chain);
    if (parsed.problems.length > 0) {
      for (const p of parsed.problems) console.error(p);
      return 1;
    }
    const plan = foldPlan(suite.entries, parsed.entries);
    console.log(
      `unit-suite: fold: ${source} chain has ${parsed.entries.length} entr${parsed.entries.length === 1 ? "y" : "ies"}; ` +
        `${plan.append.length} missing from the list; shared files keep the chain order: ${plan.orderKept ? "yes" : "NO"}`,
    );
    for (const e of plan.append) console.log(`unit-suite: fold: + ${entryLabel(e)}`);
    for (const d of plan.flagDrift) console.log(`unit-suite: fold: flag drift (left as listed) — ${d}`);
    if (plan.listOnly.length > 0) console.log(`unit-suite: fold: listed but not in the chain: ${plan.listOnly.join(", ")}`);
    listOut = appendEntries(listText, plan.append);
  }
  const pkgOut = withUnitSuiteCommand(pkgText);
  if (pkgOut === null) {
    console.error(`unit-suite: fold: could not point ${source}'s test:unit at the runner without touching anything else`);
    return 1;
  }
  if (dryRun) {
    console.log("unit-suite: fold: --dry-run — nothing written");
    return 0;
  }
  if (listOut !== listText) writeFileSync(join(root, UNIT_SUITE_LIST), listOut);
  writeFileSync(join(root, "package.json"), pkgOut);
  console.log(`unit-suite: fold: wrote ${UNIT_SUITE_LIST} and package.json (${source}'s content, test:unit = "${UNIT_SUITE_COMMAND}")`);
  return 0;
}

function cli(argv: readonly string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let listText: string;
  try {
    listText = readFileSync(join(root, UNIT_SUITE_LIST), "utf8");
  } catch (e) {
    console.error(`unit-suite: cannot read ${UNIT_SUITE_LIST} — ${(e as Error).message}`);
    return 1;
  }
  const suite = parseUnitSuite(listText);
  if (argv[0] === "--fold-chain") {
    const rest = argv.slice(1);
    const dryRun = rest.includes("--dry-run");
    return fold(root, listText, suite, rest.find((a) => a !== "--dry-run"), dryRun);
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--list")) {
    console.error(USAGE);
    return 2;
  }
  // Fail closed before anything runs: a malformed list, a duplicate or a
  // missing file is a red battery, never a partial one.
  const problems = [...suite.problems, ...missingFileProblems(suite.entries, (f) => existsSync(join(root, f)))];
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`unit-suite: FAIL — ${UNIT_SUITE_LIST} is invalid; nothing ran`);
    return 1;
  }
  if (argv[0] === "--list") {
    for (const e of suite.entries) console.log(entryLabel(e));
    return 0;
  }
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxCli)) {
    console.error("unit-suite: FAIL — node_modules/tsx/dist/cli.mjs is missing (run npm ci); nothing ran");
    return 1;
  }
  const result = runUnitSuite(suite.entries, {
    exec: spawnEntry(root, tsxCli),
    now: () => performance.now(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, stepSummaryMarkdown(result, suite.entries.length));
    } catch {
      // best-effort: the job summary never flips the battery's verdict
    }
  }
  return result.code;
}

// CLI guard (same pattern as scripts/portable-suite.ts): run only when
// executed directly. exitCode instead of process.exit() so piped stdout is
// flushed before the process ends (the gate reads it through a pipe).
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) process.exitCode = cli(process.argv.slice(2));
