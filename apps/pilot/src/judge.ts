/**
 * Judge bridge: the pilot never runs the gate itself anymore — it sends a
 * request to the pinned judge copy and verifies the signed verdict.
 * Fail-closed: a missing/moved/tampered judge (or an unsigned verdict) is an
 * infra failure, never a pass.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { verifyVerdict, type Verdict } from "./judgeverdict.js";

export const JUDGE_DIR = join(homedir(), ".opencode-remote", "judge");
const JUDGE_PIN_FILE = join(homedir(), ".opencode-remote", "judge.json");

export class JudgeError extends Error {}

function fail(msg: string): never {
  throw new JudgeError(msg);
}

/** Fail-closed: the judge copy must exist and match the pinned commit. */
export function resolveJudge(): { dir: string; cli: string; pub: string } {
  const dir = JUDGE_DIR;
  const cli = join(dir, "src", "cli.ts");
  const pub = join(dir, "judge.pub");
  if (!existsSync(cli)) fail(`judge missing: ${cli} (P1-056)`);
  if (!existsSync(pub)) fail(`judge pubkey missing: ${pub} (P1-056)`);
  const pinFile = JUDGE_PIN_FILE;
  let pin: string | undefined;
  try {
    pin = (JSON.parse(readFileSync(pinFile, "utf8")) as { pin?: string }).pin;
  } catch {}
  if (!pin) fail(`judge pin missing: ${pinFile} — the operator must pin a judge commit`);
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!head.startsWith(pin)) {
    fail(`judge HEAD ${head.slice(0, 8)} != pinned ${pin.slice(0, 8)} — update ${pinFile} after reviewing the judge diff`);
  }
  return { dir, cli, pub };
}

export interface JudgeGateInput {
  ws: string;
  sha: string;
  task: { id: string; area?: string; title?: string; size?: string; spec?: string; priority?: string };
  builderOutput: string;
  startedAtMs: number;
  nameOnly: string;
}

/**
 * Run the deterministic gate through the judge and verify the signed verdict.
 * Same failure shape as the old in-process deterministicGate (ok/step/tail/flaky)
 * so the pipeline acts on it unchanged.
 */
export function judgeGate(input: JudgeGateInput): {
  ok: boolean;
  step: string;
  tail: string;
  flaky: string[];
} {
  const { dir, cli, pub } = resolveJudge();
  const tmp = mkdtempSync(join(homedir(), ".opencode-remote", "judge-req-"));
  const reqFile = join(tmp, "req.json");
  writeFileSync(reqFile, JSON.stringify({ ws: input.ws, sha: input.sha, task: input.task, builderOutput: input.builderOutput, startedAtMs: input.startedAtMs, nameOnly: input.nameOnly }));
  let raw: string;
  try {
    raw = execFileSync(
      "npx",
      ["tsx", cli, "gate", "--repo", input.ws, "--req", reqFile],
      { encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024, cwd: dir },
    );
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
  if (!verifyVerdict(readFileSync(pub, "utf8"), verdict, sig)) {
    fail("judge verdict signature INVALID — refusing to act (P1-056)");
  }
  if (verdict.sha !== input.sha) fail(`judge verdict is for ${verdict.sha}, not ${input.sha}`);
  return { ok: verdict.ok, step: verdict.ok ? "none" : verdict.step, tail: verdict.ok ? "gate green" : verdict.tail, flaky: verdict.flaky ?? [] };
}

/** verifyFindings support stays in-repo for now (review phase, not gate). */
export { verifyVerdict };
