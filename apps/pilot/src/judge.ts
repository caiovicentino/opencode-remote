/**
 * Judge bridge: the pilot never runs the gate itself anymore — it sends a
 * request to the pinned judge copy and verifies the signed verdict.
 * Fail-closed: a missing/moved/tampered judge (or an unsigned verdict) is an
 * infra failure, never a pass.
 *
 * This file is protected gate machinery (P3-353): the pinned judge refuses to
 * certify a branch that edits it unless the operator authorized the task.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emit } from "./events";
import { checkVerdictBinding, verifyVerdict, type Verdict } from "./judgeverdict.js";

export const JUDGE_DIR = join(homedir(), ".opencode-remote", "judge");
const JUDGE_PIN_FILE = join(homedir(), ".opencode-remote", "judge.json");

export class JudgeError extends Error {}

function fail(msg: string): never {
  throw new JudgeError(msg);
}

/** Where the judge lives — injectable so the unit battery runs a fake judge. */
export interface JudgeLocation {
  dir?: string;
  pinFile?: string;
}

export interface ResolvedJudge {
  dir: string;
  cli: string;
  pub: string;
  pin: string;
  /** The judge's OWN tsx entry — never `npx`, which resolves from PATH/cwd. */
  tsx: string;
  /** Verdict version the pinned tree declares (package.json ocrJudge.verdict). */
  version: number;
}

/** Declared by the pinned tree itself, so the pin attests it; absent = 1. */
export function judgeVerdictVersion(dir: string): number {
  try {
    const v = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { ocrJudge?: { verdict?: unknown } }).ocrJudge?.verdict;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : 1;
  } catch {
    return 1;
  }
}

/** Null when the judge checkout is exactly the pinned commit, else why not. */
export function judgeTreeProblem(dir: string, pin: string): string | null {
  let head: string;
  let dirty: string;
  try {
    head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    dirty = execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
  } catch (err) {
    return `judge checkout unreadable: ${String(err).slice(0, 200)}`;
  }
  if (!head.startsWith(pin)) {
    return `judge HEAD ${head.slice(0, 8)} != pinned ${pin.slice(0, 8)} — update the pin file after reviewing the judge diff`;
  }
  if (dirty) return `judge checkout is dirty — the pin attests HEAD, not uncommitted edits:\n${dirty.slice(0, 400)}`;
  return null;
}

/** Fail-closed: the judge copy must exist and match the pinned commit. */
export function resolveJudge(loc: JudgeLocation = {}): ResolvedJudge {
  const dir = loc.dir ?? JUDGE_DIR;
  const cli = join(dir, "src", "cli.ts");
  const pub = join(dir, "judge.pub");
  const tsx = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(cli)) fail(`judge missing: ${cli} (P1-056)`);
  if (!existsSync(pub)) fail(`judge pubkey missing: ${pub} (P1-056)`);
  if (!existsSync(tsx)) fail(`judge tsx missing: ${tsx} — the judge runs its own interpreter, never npx (P1-056)`);
  const pinFile = loc.pinFile ?? JUDGE_PIN_FILE;
  let pin: string | undefined;
  try {
    pin = (JSON.parse(readFileSync(pinFile, "utf8")) as { pin?: string }).pin;
  } catch {}
  if (!pin || !/^[0-9a-f]{7,64}$/.test(pin)) fail(`judge pin missing: ${pinFile} — the operator must pin a judge commit`);
  const problem = judgeTreeProblem(dir, pin);
  if (problem) fail(problem.replace("the pin file", pinFile));
  return { dir, cli, pub, pin, tsx, version: judgeVerdictVersion(dir) };
}

/**
 * The judge's standalone constitution check as a shell command for exec():
 * the judge's node + tsx + invariants.ts by absolute path, run with cwd = the
 * judge. `npx tsx` with cwd = the prod checkout (the pre-fix deploy.ts)
 * resolved tsx from the audited repo's node_modules — the C2 shadowing the
 * gate's own invariants step was already hardened against.
 */
export function judgeInvariantsCommand(repo: string, opts: { live?: boolean; loc?: JudgeLocation } = {}): { cmd: string; cwd: string } {
  const j = resolveJudge(opts.loc);
  const q = (s: string) => JSON.stringify(s);
  const argv = [process.execPath, j.tsx, join(j.dir, "src", "invariants.ts"), "--repo", repo, ...(opts.live ? ["--live"] : [])];
  return { cmd: argv.map((a) => (a.startsWith("--") ? a : q(a))).join(" "), cwd: j.dir };
}

export interface JudgeGateInput {
  ws: string;
  sha: string;
  task: { id: string; area?: string; title?: string; size?: string; spec?: string; priority?: string };
  builderOutput: string;
  startedAtMs: number;
  nameOnly: string;
  /** Pipeline base branch for the judge's own diff (default origin/HEAD|main|master). */
  baseBranch?: string;
}

export interface JudgeGateResult {
  ok: boolean;
  step: string;
  tail: string;
  flaky: string[];
  /** short pin of the judge that signed the verdict (absent on bridge failure) */
  judge?: string;
  /** P3-353: the diff touched protected gate machinery. */
  constitutionChange: boolean;
  /** P3-353: protected changes the operator has not authorized. */
  protected: string[];
  /** P3-359: flaky passes counted against the judge's budget this run. */
  flakes: { step: string; count: number; budget: number; exhausted: boolean }[];
  /** eval-04: early-warning lines of green steps (e.g. desktop-flow above 80% of its budget). */
  warnings: string[];
  /** Verdict v2: nonce + judge HEAD were checked (false on a v1 judge). */
  bound: boolean;
}

export interface JudgeDeps extends JudgeLocation {
  /** Runs `node <argv>` with cwd; returns stdout. Default: execFileSync. */
  run?: (argv: string[], cwd: string) => string;
  nonce?: () => string;
  /** Parent of the per-request temp dir (default ~/.opencode-remote). */
  reqRoot?: string;
  /** Escalation hook for a protected refusal (default: pilot alert event). */
  onConstitutionChange?: (taskId: string, ids: string[]) => void;
  /** Alert hook when the battery touched production (runtime files changed
   * outside its sandbox, launchctl/pkill refused) — default: pilot alert. */
  onProductionTouch?: (taskId: string, what: string[]) => void;
}

function defaultRun(argv: string[], cwd: string): string {
  return execFileSync(process.execPath, argv, { encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024, cwd });
}

function alertProductionTouch(taskId: string, what: string[]): void {
  emit("alert", {
    task: taskId,
    ok: false,
    detail: `gate battery of ${taskId} tried to touch production (${what.slice(0, 3).join(" | ")}) — verdict refused by the judge`,
  });
}

function alertConstitutionChange(taskId: string, ids: string[]): void {
  emit("alert", {
    task: taskId,
    ok: false,
    detail: `constitution-change: ${taskId} edits protected gate machinery (${ids.slice(0, 4).join(", ") || "flag missing"}) — needs operator authorization in the judge (P3-353)`,
  });
}

/**
 * Run the deterministic gate through the judge and verify the signed verdict.
 * Same failure shape as the old in-process deterministicGate (ok/step/tail/flaky)
 * so the pipeline acts on it unchanged.
 */
export function judgeGate(input: JudgeGateInput, deps: JudgeDeps = {}): JudgeGateResult {
  const j = resolveJudge(deps);
  // Read the key BEFORE the run: the battery executes branch code as this same
  // user, so anything read afterwards could have been swapped mid-gate.
  const pubPem = readFileSync(j.pub, "utf8");
  const nonce = (deps.nonce ?? (() => randomBytes(16).toString("hex")))();
  const tmp = mkdtempSync(join(deps.reqRoot ?? join(homedir(), ".opencode-remote"), "judge-req-"));
  try {
    const reqFile = join(tmp, "req.json");
    writeFileSync(
      reqFile,
      JSON.stringify({
        ws: input.ws,
        sha: input.sha,
        task: input.task,
        builderOutput: input.builderOutput,
        startedAtMs: input.startedAtMs,
        nameOnly: input.nameOnly,
        nonce,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
      }),
      { mode: 0o600 },
    );
    let raw: string;
    try {
      raw = (deps.run ?? defaultRun)([j.tsx, j.cli, "gate", "--repo", input.ws, "--req", reqFile], j.dir);
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: Buffer };
      const detail = e.stdout?.toString().slice(-400) || e.stderr?.toString().slice(-400) || String(err);
      fail(`judge spawn failed: ${detail}`);
    }
    let parsed: { verdict: Verdict; sig: string };
    try {
      parsed = JSON.parse(raw.trim().split("\n").filter(Boolean).at(-1)!);
    } catch {
      fail("judge emitted no parseable verdict");
    }
    const { verdict, sig } = parsed;
    if (!verdict || typeof sig !== "string" || !verifyVerdict(pubPem, verdict, sig)) {
      fail("judge verdict signature INVALID — refusing to act (P1-056)");
    }
    const unbound = checkVerdictBinding(verdict, { sha: input.sha, task: input.task.id, nonce, pin: j.pin, version: j.version });
    if (unbound) fail(unbound);
    // The judge must still be the pinned tree after the battery ran.
    const after = judgeTreeProblem(j.dir, j.pin);
    if (after) fail(`judge tree changed during the gate run — ${after}`);
    const blocked = Array.isArray(verdict.protected) ? verdict.protected.filter((x): x is string => typeof x === "string") : [];
    if (!verdict.ok && verdict.step === "protected") (deps.onConstitutionChange ?? alertConstitutionChange)(input.task.id, blocked);
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const touched = [...strings(verdict.runtimeChanged), ...strings(verdict.blockedCommands)];
    if (touched.length) (deps.onProductionTouch ?? alertProductionTouch)(input.task.id, touched);
    return {
      ok: verdict.ok,
      step: verdict.ok ? "none" : verdict.step,
      tail: verdict.ok ? "gate green" : verdict.tail,
      flaky: verdict.flaky ?? [],
      judge: j.pin.slice(0, 8),
      constitutionChange: verdict.constitutionChange === true,
      protected: blocked,
      flakes: Array.isArray(verdict.flakes) ? verdict.flakes : [],
      warnings: strings(verdict.warnings).slice(0, 3),
      bound: j.version >= 2,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * P3-353 negative canary for the doctor pass: the pinned judge's own canary
 * (malicious fixture branches refused, forged verdicts rejected), run with
 * the judge's interpreter. Never throws — a missing/unpinned judge is a red
 * canary with the reason.
 */
export function runJudgeCanary(deps: JudgeDeps = {}): { ok: boolean; output: string } {
  let j: ResolvedJudge;
  try {
    j = resolveJudge(deps);
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
  if (j.version < 2) {
    // the v1 canary only checked a forged signature — green there proves nothing
    return { ok: false, output: `pinned judge ${j.pin.slice(0, 8)} is verdict v1: no protected-path policy and no real canary (P3-353) — review and re-pin a v2 judge` };
  }
  try {
    const out = (deps.run ?? ((argv, cwd) => execFileSync(process.execPath, argv, { encoding: "utf8", timeout: 5 * 60_000, cwd })))([j.tsx, j.cli, "canary"], j.dir);
    return { ok: /^CANARY OK$/m.test(out), output: out.slice(-2000) };
  } catch (err) {
    const e = err as { stdout?: string };
    return { ok: false, output: (e.stdout?.toString() || String(err)).slice(-2000) };
  }
}

/** verifyFindings support stays in-repo for now (review phase, not gate). */
export { verifyVerdict };
