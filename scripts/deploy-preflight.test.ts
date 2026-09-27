/**
 * eval r5 (dimension 07) — deploy safety & restart preflight.
 *
 * Pins, without ever reaching the mutation half of deploy() (it kickstarts
 * real launchd services):
 *  - the catch-up plan: a large clean range ships in bounded oldest-first
 *    steps (the 09-24 shape: prod 57 first-parent commits behind, 16 verified
 *    merges), a range holding a quarantined sha goes straight to the newest
 *    (fix-forward), prod off-history falls back to the legacy single jump;
 *  - the reinforced soak for multi-merge deploys and the rollback hold;
 *  - the judge-drift comparator (types/comments ignored, the RT-390 change
 *    caught) and the judge guard: a stale mirror refuses BEFORE any mutation,
 *    spends no attempt and quarantines nothing (the 09-10 → 09-22 incident);
 *  - the new doctor checks (judge, tier-B role completeness) and the
 *    doctorRefs failed-checkout fix (09-24 07:12, repo-2);
 *  - scripts/pilot-preflight.ts: pure verdict rules and a hermetic end-to-end
 *    run (temp HOME, temp git repos, loopback fake endpoints on an ephemeral
 *    port) that proves the preflight writes NOTHING — not even a git index
 *    refresh.
 * Run: npx tsx scripts/deploy-preflight.test.ts
 */
process.env.PILOT_EVENTS_FILE = `${process.env.TMPDIR ?? "/tmp"}/pilot-deploy-preflight-events.jsonl`;
process.env.GIT_AUTHOR_NAME ??= "ocr-unit";
process.env.GIT_AUTHOR_EMAIL ??= "ocr-unit@test.local";
process.env.GIT_COMMITTER_NAME ??= process.env.GIT_AUTHOR_NAME;
process.env.GIT_COMMITTER_EMAIL ??= process.env.GIT_AUTHOR_EMAIL;
process.env.GIT_CONFIG_GLOBAL ??= process.platform === "win32" ? "NUL" : "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM ??= "1";
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) {
  delete process.env[k];
}

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  announceDeployPlan,
  deploy,
  deployPreflight,
  judgeGuardDetail,
  planShipping,
  soakMinutesFor,
  soakWatch,
  type DeployOpts,
} from "../apps/pilot/src/deploy";
import {
  CATCHUP_MIN_TASKS,
  CATCHUP_SOAK_MIN,
  CATCHUP_STEP_TASKS,
  MAX_WALK_COMMITS,
  planDeploy,
  planSummary,
  type QuarantinedSha,
  type VerifiedMerge,
} from "../apps/pilot/src/deployguard";
import { DEPLOY_ROLLBACK_HOLD_MS, noteDeployRollback, rollbackHoldRemaining } from "../apps/pilot/src/deploybackoff";
import { doctorJudge, doctorRefs, doctorTierBRoles, runDoctorGuards, TIER_B_ROLES, TIER_B_ROLES_EXHAUSTIVE, type RunFn } from "../apps/pilot/src/doctor";
import { compareProtocolMirror, inspectJudge, loadTypescript, realGitRead, runtimeTokens, TARGET_PROTOCOL_PATH } from "../apps/pilot/src/judgedrift";
import type { PilotConfig } from "../apps/pilot/src/state";
import {
  collectFacts,
  evaluate,
  missionReason,
  parseLaunchctlList,
  realIo,
  render,
  resolveProdRepo,
  tasksDiedMidPipeline,
  verdict,
  type PreflightEnv,
  type PreflightFacts,
} from "./pilot-preflight";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const ROOT = join(import.meta.dirname, "..");
const CURRENT_CRYPTO = readFileSync(join(ROOT, TARGET_PROTOCOL_PATH), "utf8");
const PRE_RT390 = readFileSync(join(ROOT, "apps", "pilot", "src", "__fixtures__", "judge-drift", "crypto-pre-rt390.ts.txt"), "utf8");
const sha = (n: number) => n.toString(16).padStart(40, "0");
const vm = (s: string, task: string): VerifiedMerge => ({ sha: s, task, at: "t" });
const qz = (s: string, task: string): QuarantinedSha => ({ sha: s, task, at: "t", why: "live invariants failed" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tmp = mkdtempSync(join(tmpdir(), "ocr-deploy-preflight-"));

// ── 1. catch-up plan (pure) ──────────────────────────────────────────────────
{
  // the 09-24 shape: prod 57 first-parent commits below origin/main (beyond
  // pickDeployableSha's 50-commit walk), 16 verified task merges in between,
  // the rest bookkeeping (mark-done, scribe, researcher, redteam)
  const PROD = sha(9999);
  const history: string[] = [];
  const verified: VerifiedMerge[] = [];
  let n = 1;
  for (let task = 16; task >= 1; task--) {
    history.push(sha(n++), sha(n++)); // two bookkeeping commits above each merge
    const s = sha(n++);
    history.push(s);
    verified.push(vm(s, `T${task}`));
  }
  while (history.length < 57) history.push(sha(n++));
  history.push(PROD);
  verified.push(vm(PROD, "T0"));
  const plan = planDeploy(history, PROD, verified, []);
  check("plan: prod found beyond the 50-commit newest walk (anchored)", history.indexOf(PROD) > MAX_WALK_COMMITS && plan.anchored);
  check("plan: newest is the top verified merge (legacy target unchanged)", plan.newest === history[2]);
  check("plan: all 16 verified merges pending, oldest first", plan.pending.length === 16 && plan.pending[0]!.task === "T1" && plan.pending[15]!.task === "T16");
  check(
    `plan: clean 16-merge range ships a bounded step of ${CATCHUP_STEP_TASKS}, oldest first`,
    plan.stepped && plan.step.map((m) => m.task).join(",") === "T1,T2,T3,T4" && plan.target === plan.step[3]!.sha,
  );
  const summary = planSummary(plan);
  check("plan: summary names the step, the remainder and the tasks shipping", summary.includes("catch-up step: 4 of 16") && summary.includes("12 remain") && summary.includes("T1, T2, T3, T4"));

  // step 2 from the new prod: the next 4
  const prod2 = plan.target!;
  const plan2 = planDeploy(history, prod2, verified, []);
  check("plan: the next step starts right above the last shipped merge", plan2.step.map((m) => m.task).join(",") === "T5,T6,T7,T8" && plan2.pending.length === 12);

  // a failure inside the range → fix-forward: straight to the newest, not stepped
  const withBan = planDeploy(history, PROD, verified, [qz(verified[13]!.sha, "T3")]);
  check(
    "plan: a quarantined sha in the range disables stepping (target = newest, rider listed)",
    !withBan.stepped && withBan.target === withBan.newest && withBan.skipped.length === 1 && withBan.pending.length === 15 && planSummary(withBan).includes("carries 1 quarantined merge(s): T3"),
  );

  // small range → single deploy of the newest
  const small = planDeploy(history, verified[12]!.sha, verified, []); // prod at T4 → 12 pending? no: pick near the top
  check("plan: small ranges are not stepped", planDeploy(history, verified[2]!.sha, verified, []).stepped === false && planDeploy(history, verified[2]!.sha, verified, []).pending.length === 2);
  check("plan: bigger range from mid-history still steps", small.stepped && small.step.length === CATCHUP_STEP_TASKS);

  // prod current / off-history / nothing verified
  const current = planDeploy(history, history[2]!, verified, []);
  check("plan: prod at the newest verified merge → nothing to ship", current.anchored && current.target === null && current.newest === history[2]);
  const off = planDeploy(history, sha(123456), verified, []);
  check("plan: prod off the first-parent history → legacy single jump, not enumerated", !off.anchored && off.target === off.newest && off.pending.length === 0 && planSummary(off).includes("not enumerated"));
  check("plan: nothing verified → no target (fail-closed)", planDeploy(history, PROD, [], []).target === null);
  check("plan: shipping size is the step length (1 when unknown)", planShipping(plan) === 4 && planShipping(off) === 1 && planShipping(undefined) === 1);
}

// ── 2. reinforced soak for multi-merge deploys + rollback hold ───────────────
{
  check("soak: single-merge deploys keep the configured window", soakMinutesFor(2, false) === 2 && soakMinutesFor(2, false, 1) === 2 && soakMinutesFor(10, true, 1) === 3);
  check(
    `soak: a catch-up (>= ${CATCHUP_MIN_TASKS} merges) soaks at least ${CATCHUP_SOAK_MIN} min in any lane`,
    soakMinutesFor(2, false, 4) === CATCHUP_SOAK_MIN && soakMinutesFor(2, true, 2) === CATCHUP_SOAK_MIN && soakMinutesFor(15, false, 3) === 15,
  );
  let lives = 0;
  const events: string[] = [];
  const reinforced = await soakWatch({
    checks: CATCHUP_SOAK_MIN,
    pilotInfra: false,
    reinforced: true,
    baselineRate: 0,
    probe: async () => true,
    heartbeat: () => {},
    sleep: () => Promise.resolve(),
    live: () => {
      lives++;
      return { ok: true, output: "" };
    },
    onEvent: (e) => events.push(e.phase),
  });
  check("soak: the catch-up lane reruns live invariants at checks 5 and 10", reinforced.outcome === "ok" && lives === 2 && events.includes("live-invariants 10/10"));
  const seq = [true, true, true, false, false];
  let i = 0;
  const rate = await soakWatch({
    checks: CATCHUP_SOAK_MIN,
    pilotInfra: false,
    reinforced: true,
    baselineRate: 0,
    probe: async () => seq[i++ % seq.length]!,
    heartbeat: () => {},
    sleep: () => Promise.resolve(),
    live: () => ({ ok: true, output: "" }),
  });
  check("soak: the catch-up lane rolls back on a failure-rate regression", rate.outcome === "rate" && rate.at === 5);
  const deploySrc = readFileSync(join(ROOT, "apps", "pilot", "src", "deploy.ts"), "utf8");
  check(
    "soak wiring: deploy() sizes the soak by the merges shipped and passes the reinforced lane",
    deploySrc.includes("soakMinutesFor(cfg.monitorMin, pilotInfra, shipping)") && /soakWatch\(\{\s*checks,\s*pilotInfra,\s*reinforced,/.test(deploySrc) && deploySrc.includes("const reinforced = pilotInfra || catchUp;"),
  );

  const t0 = 1_000_000;
  const hold = noteDeployRollback(sha(7), sha(8), t0);
  check("rollback hold: armed for DEPLOY_ROLLBACK_HOLD_MS while the verified tip is unchanged", rollbackHoldRemaining(hold, sha(8), t0) === DEPLOY_ROLLBACK_HOLD_MS && rollbackHoldRemaining(hold, sha(8), t0 + 60_000) > 0);
  check("rollback hold: a new verified merge (tip moved) releases it at once", rollbackHoldRemaining(hold, sha(9), t0 + 1) === 0);
  check("rollback hold: expires after the window", rollbackHoldRemaining(hold, sha(8), t0 + DEPLOY_ROLLBACK_HOLD_MS) === 0 && rollbackHoldRemaining(null, sha(8), t0) === 0);
  const indexSrc = readFileSync(join(ROOT, "apps", "pilot", "src", "index.ts"), "utf8");
  check(
    "rollback hold wiring: pending path consults the hold; both call sites resolve the plan and report the target",
    indexSrc.includes("&& !backoffHold && !rollbackHeld)") && (indexSrc.match(/resolveDeployPlan\(cfg\.repo, cfg\.baseBranch\)/g) ?? []).length === 2 && (indexSrc.match(/noteDeployOutcome\(dep, target\)/g) ?? []).length === 2,
  );

  // the plan announcement: log + feed always, supervisor only for a catch-up
  const evs: Array<{ phase?: string; detail?: string }> = [];
  const notes: string[] = [];
  const hooks = {
    emitEvent: (_t: string, f: { phase?: string; detail?: string }) => {
      evs.push(f);
    },
    notify: async (task: string, _ok: boolean, detail: string) => {
      notes.push(`${task}:${detail}`);
      return true;
    },
  };
  const hist = [sha(3), sha(2), sha(1), sha(100)];
  const vs = [vm(sha(1), "A1"), vm(sha(2), "A2"), vm(sha(3), "A3"), vm(sha(100), "A0")];
  announceDeployPlan(planDeploy(hist, sha(100), vs, []), hooks as never);
  announceDeployPlan(planDeploy(hist, sha(2), vs, []), hooks as never);
  check("plan announcement: every deploy emits a plan event", evs.length === 2 && evs.every((e) => e.phase === "plan"));
  check("plan announcement: only the multi-merge deploy notifies, listing what ships", notes.length === 1 && notes[0]!.startsWith("deploy-plan:") && notes[0]!.includes("A1, A2, A3"));
}

// ── 3. judge drift comparator ─────────────────────────────────────────────────
{
  check("drift: the compiler loads lazily for the comparison", loadTypescript() !== null);
  const base = `export async function hello(pub: string, id: { k: string }): Promise<string> {\n  return seal({ clientPub: id.k }, pub); // seal it\n}\n`;
  const cosmetic = `/** docs */\nexport async function hello(pub, id) {\n  return seal({ 'clientPub': id.k, }, pub,);\n}\n`;
  check("drift: comments, whitespace, quote style, trailing commas and type annotations never count", compareProtocolMirror(base, cosmetic).state === "match");
  const rt390 = `export async function hello(pub: string, id: { k: string }, now: number = Date.now()): Promise<string> {\n  return seal({ clientPub: id.k, ts: now }, pub);\n}\n`;
  const d = compareProtocolMirror(base, rt390);
  check("drift: the RT-390 shape (timestamp inside the sealed hello) is a runtime drift", d.state === "drift" && Boolean(d.diff?.target.includes("now")));
  check("drift: a string literal change counts", compareProtocolMirror(`const A = "ocr-hello";`, `const A = "ocr-hello2";`).state === "drift");
  const real = compareProtocolMirror(PRE_RT390, CURRENT_CRYPTO);
  check("drift: the real pre-RT-390 protocol (the judge pinned on 09-05) drifts from packages/protocol", real.state === "drift", JSON.stringify(real));
  check(
    "drift: the drift names the symbols — RT-390 (clientHello, serverAccept), RT-424 (seqAad changed, frameSeq new upstream)",
    ["clientHello", "serverAccept", "seqAad"].every((k) => real.changed?.includes(k)) && (real.onlyInTarget ?? []).includes("frameSeq") && real.detail.includes("changed: ") && real.detail.includes("new upstream: frameSeq"),
    JSON.stringify(real),
  );
  const symbolic = compareProtocolMirror(base, rt390);
  check("drift: a one-function change names exactly that function", JSON.stringify(symbolic.changed) === JSON.stringify(["hello"]) && symbolic.onlyInJudge?.length === 0);
  check("drift: a symbol removed upstream is named on the judge side", (compareProtocolMirror(`${base}\nexport const X = 1;`, base).onlyInJudge ?? []).includes("X"));
  // the judge's current copy differs only in ASCII-only comments and a narrower
  // caps type — rebuild that shape from the real file: must stay a match
  const asciiNarrow = CURRENT_CRYPTO.replace(/[→—±≥]/g, "-").replace("caps?: { transcribe?: boolean; tts?: boolean },", "caps?: { transcribe?: boolean },");
  check("drift: the real protocol vs an ASCII-comment / narrowed-type mirror is runtime-identical", asciiNarrow !== CURRENT_CRYPTO && compareProtocolMirror(asciiNarrow, CURRENT_CRYPTO).state === "match");
  check("drift: target without packages/protocol → no-target; missing mirror → no-mirror; no compiler → unknown",
    compareProtocolMirror(base, null).state === "no-target" && compareProtocolMirror(null, base).state === "no-mirror" && compareProtocolMirror(base, base, null).state === "unknown");
  check("drift: runtimeTokens returns null without a compiler", runtimeTokens(base, null) === null);
}

// ── 4. judge inspection (read-only) + judge guard in deployPreflight ─────────
const judgeDir = join(tmp, "judge");
let judgePin = "";
{
  mkdirSync(join(judgeDir, "src"), { recursive: true });
  git(tmp, "init", "-q", "-b", "main", judgeDir);
  writeFileSync(join(judgeDir, "src", "cli.ts"), "// cli\n");
  writeFileSync(join(judgeDir, "judge.pub"), "pub\n");
  writeFileSync(join(judgeDir, "src", "protocol.ts"), PRE_RT390);
  git(judgeDir, "add", "-A");
  git(judgeDir, "commit", "-q", "-m", "judge");
  judgePin = git(judgeDir, "rev-parse", "HEAD");
  const pinFile = join(tmp, "judge.json");
  writeFileSync(pinFile, JSON.stringify({ pin: judgePin }));
  check("judge inspect: pinned + clean → usable", inspectJudge(judgeDir, pinFile).usable);
  writeFileSync(join(tmp, "judge-bad.json"), JSON.stringify({ pin: "deadbeef" }));
  check("judge inspect: HEAD != pin → unusable, named", !inspectJudge(judgeDir, join(tmp, "judge-bad.json")).usable && inspectJudge(judgeDir, join(tmp, "judge-bad.json")).detail.includes("!= pinned deadbeef"));
  check("judge inspect: missing pin file → unusable", inspectJudge(judgeDir, join(tmp, "nope.json")).detail.startsWith("judge pin missing"));
  // read-only proof: a stat-dirty tracked file makes a plain `git status`
  // rewrite the index; inspectJudge must not
  const idx = join(judgeDir, ".git", "index");
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(join(judgeDir, "src", "cli.ts"), new Date(), new Date());
  utimesSync(idx, past, past);
  const before = statSync(idx).mtimeMs;
  inspectJudge(judgeDir, pinFile, realGitRead());
  check("judge inspect: never refreshes (writes) the judge's git index", statSync(idx).mtimeMs === before);
  git(judgeDir, "status", "--porcelain");
  check("judge inspect (control): a plain git status DOES rewrite that index", statSync(idx).mtimeMs !== before);
  writeFileSync(join(judgeDir, "src", "cli.ts"), "// edited\n");
  check("judge inspect: tracked edits → unusable (the pin attests HEAD only)", inspectJudge(judgeDir, pinFile).detail.includes("dirty"));
  git(judgeDir, "checkout", "-q", "--", "src/cli.ts");
}

// prod repo whose target carries the CURRENT protocol
const prodDir = join(tmp, "prod");
const originDir = join(tmp, "origin.git");
let c1 = "";
let c2 = "";
{
  git(tmp, "init", "-q", "--bare", "-b", "main", originDir);
  git(tmp, "clone", "-q", originDir, prodDir);
  git(prodDir, "checkout", "-q", "-B", "main");
  mkdirSync(join(prodDir, "packages", "protocol", "src"), { recursive: true });
  writeFileSync(join(prodDir, "packages", "protocol", "src", "crypto.ts"), PRE_RT390);
  writeFileSync(join(prodDir, "f.txt"), "one\n");
  git(prodDir, "add", "-A");
  git(prodDir, "commit", "-q", "-m", "c1");
  c1 = git(prodDir, "rev-parse", "HEAD");
  writeFileSync(join(prodDir, "packages", "protocol", "src", "crypto.ts"), CURRENT_CRYPTO);
  git(prodDir, "commit", "-qam", "c2 (RT-390 lands)");
  c2 = git(prodDir, "rev-parse", "HEAD");
  git(prodDir, "push", "-q", "origin", "main");
  git(prodDir, "checkout", "-q", c1);
}
const cfgOf = (repo: string): PilotConfig => ({
  repo,
  workspace: repo,
  slots: 1,
  maxTasksPerDay: 1,
  maxDeploysPerDay: 1,
  maxReviewRounds: 1,
  maxAttemptsPerTask: 1,
  taskTimeoutMin: 1,
  reviewTimeoutMin: 1,
  monitorMin: 1,
  digest: false,
  corpusEveryNMerges: 1,
  stateRoot: repo,
});
{
  const staleJudge = { resolve: () => ({ dir: judgeDir, pin: judgePin }) };
  const refusal = judgeGuardDetail(prodDir, c2, staleJudge) ?? "";
  check("judge guard: the pre-RT-390 mirror vs an RT-390 target refuses with the repair", refusal.startsWith("judge drift:") && refusal.includes("re-pin judge.json") && refusal.includes("deploy refused, prod untouched"));
  check("judge guard: a target on the judge's own protocol passes", judgeGuardDetail(prodDir, c1, staleJudge) === null);
  const unusable = judgeGuardDetail(prodDir, c2, {
    resolve: () => {
      throw new Error("judge HEAD 1234 != pinned 5678 — update judge.json\nafter review");
    },
  }) ?? "";
  check("judge guard: an unusable judge refuses BEFORE the mutation (single-line reason)", unusable.startsWith("judge unusable: judge HEAD 1234 != pinned 5678") && !unusable.includes("\n"));
  const plain = mkdtempSync(join(tmp, "plain-"));
  git(plain, "init", "-q", "-b", "main");
  writeFileSync(join(plain, "x.txt"), "x\n");
  git(plain, "add", "-A");
  git(plain, "commit", "-q", "-m", "x");
  check("judge guard: a target without packages/protocol has nothing to mirror (foreign/test repos)", judgeGuardDetail(plain, git(plain, "rev-parse", "HEAD"), { resolve: () => { throw new Error("must not be consulted"); } }) === null);

  // deploy(): refused by the judge guard, no attempt, nothing touched
  const events: Array<{ phase?: string; ok?: boolean }> = [];
  const notifies: string[] = [];
  let attempts = 0;
  const opts: DeployOpts = {
    verifiedMerges: [vm(c1, "P0-001"), vm(c2, "P0-002")],
    quarantine: [],
    probeFreeBytes: async () => 100 * 1024 ** 3,
    notify: async (_task, _ok, detail) => {
      notifies.push(detail);
      return true;
    },
    emitEvent: (_t, f) => {
      events.push(f);
    },
    onAttempt: () => {
      attempts++;
    },
    probeJudge: (repo, target) => judgeGuardDetail(repo, target, staleJudge),
  };
  const res = await deploy(cfgOf(prodDir), c2, { task: "P0-002" }, opts);
  check("deploy: judge drift → refused:\"judge-guard\", not rolled back", res.ok === false && res.rolledBack === false && res.refused === "judge-guard");
  check("deploy: the judge refusal spent no attempt (no budget, no quarantine path)", attempts === 0);
  check("deploy: prod HEAD untouched", git(prodDir, "rev-parse", "HEAD") === c1);
  check("deploy: judge-guard event on the feed", events.some((e) => e.phase === "judge-guard" && e.ok === false));
  await new Promise((r) => setTimeout(r, 10));
  const again = await deploy(cfgOf(prodDir), c2, { task: "P0-002" }, opts);
  await new Promise((r) => setTimeout(r, 10));
  check("deploy: one supervisor notify per distinct judge refusal (the pending path retries every cycle)", again.refused === "judge-guard" && notifies.length === 1);
  const pass = await deployPreflight(cfgOf(prodDir), c2, { task: "P0-002" }, { ...opts, probeJudge: () => null });
  check("deployPreflight: judge in sync + clean + descendant → null (proceed)", pass === null);
}

// ── 5. doctor: tier-B completeness, judge check, refs fix ─────────────────────
{
  check("tierb roles: the runtime list covers every TierBRole (compile-time pinned)", TIER_B_ROLES_EXHAUSTIVE === true && TIER_B_ROLES.length === 5);
  check("tierb roles: no tier-B block is the documented tier-A setup", doctorTierBRoles(undefined).ok && doctorTierBRoles({ tierA: { builder: "x" } }).ok);
  const full = { tierB: { planner: "opus", strategist: "opus", forensic: "opus", reviewerEscalation: "opus", fable: "opus" } };
  check("tierb roles: all five pinned → green", doctorTierBRoles(full).ok);
  const noFable = doctorTierBRoles({ tierB: { planner: "opus", strategist: "opus", forensic: "opus", reviewerEscalation: "opus" } });
  check("tierb roles: the 09-22 shape (no fable) is named as silently tier A", !noFable.ok && noFable.detail.includes("fable silently run tier A"));
  const typo = doctorTierBRoles({ tierB: { ...full.tierB, fabel: "opus" } as never });
  check("tierb roles: an unknown key (typo) is reported", !typo.ok && typo.detail.includes("unknown key(s) ignored: fabel"));

  const usable = () => ({ usable: true, pin: judgePin, head: judgePin, detail: `judge ${judgePin.slice(0, 8)} pinned + clean` });
  const drift = doctorJudge(prodDir, "main", { inspect: usable, mirror: () => PRE_RT390, target: () => CURRENT_CRYPTO });
  check("doctor judge: stale mirror vs origin → red with the repair and the differing window", !drift.ok && drift.detail.startsWith("judge drift:") && drift.detail.includes("[judge:"));
  const inSync = doctorJudge(prodDir, "main", { inspect: usable, mirror: () => CURRENT_CRYPTO, target: () => CURRENT_CRYPTO });
  check("doctor judge: in sync → green", inSync.ok && inSync.detail.includes("match"));
  const broken = doctorJudge(prodDir, "main", { inspect: () => ({ usable: false, pin: null, head: null, detail: "judge missing: x" }) });
  check("doctor judge: unusable judge → red", !broken.ok && broken.detail.includes("judge missing"));
  const realOrigin = doctorJudge(prodDir, "main", { inspect: usable, mirror: () => PRE_RT390 });
  check("doctor judge: reads origin/<base>:packages/protocol by default (real git)", !realOrigin.ok && realOrigin.detail.includes("origin/main"));

  const logs: Array<{ level: string; msg: string }> = [];
  const evs: Array<{ phase?: string }> = [];
  const notes: string[] = [];
  runDoctorGuards(
    { repo: prodDir, models: { tierB: { planner: "opus" } }, baseBranch: "main" },
    (level, msg) => logs.push({ level, msg }),
    {
      judge: { inspect: usable, mirror: () => PRE_RT390, target: () => CURRENT_CRYPTO },
      notify: async (_t, _o, d) => {
        notes.push(d);
        return true;
      },
      emitEvent: (_t, f) => {
        evs.push(f);
      },
    },
  );
  await new Promise((r) => setTimeout(r, 10));
  check("doctor guards: both red checks log warn", logs.filter((l) => l.level === "warn").length === 2);
  check("doctor guards: judge → alert event; tier-B → phase event", evs.some((e) => e.phase === "judge") && evs.some((e) => e.phase === "tierB-roles"));
  check("doctor guards: the supervisor hears both", notes.length === 2);

  // doctorRefs: a failed checkout must never reset the branch the slot is on
  const ran: string[] = [];
  const run: RunFn = (cmd) => {
    ran.push(cmd);
    if (cmd === "git checkout -q main") return { ok: false, output: "error: Your local changes would be overwritten" };
    return { ok: true, output: cmd === "git rev-parse HEAD" ? "abc1234" : "" };
  };
  const r = doctorRefs("/ws", run);
  check(
    "doctor refs: failed checkout → no reset/clean on the task branch (09-24 07:12 repo-2)",
    !r.ok && r.detail.includes("git checkout -q main") && !ran.some((c) => c.startsWith("git reset")) && !ran.some((c) => c.startsWith("git clean")),
  );
}

// ── 6. preflight: pure rules ──────────────────────────────────────────────────
{
  const lc = parseLaunchctlList("PID\tStatus\tLabel\n82535\t0\tcom.ocr.opencode\n-\t0\tcom.ocr.logrotate\n123\t0\tcom.apple.x\n");
  check("preflight: launchctl rows parsed for com.ocr.* only", lc.size === 2 && lc.get("com.ocr.opencode")?.pid === 82535 && lc.get("com.ocr.logrotate")?.pid === null);
  const log = [
    '{"msg":"pilot started"}',
    '{"msg":"pipeline start","data":{"task":"P1-001"}}',
    '{"msg":"pipeline result","data":{"task":"P1-001"}}',
    '{"msg":"pilot started"}',
    '{"msg":"pipeline start","data":{"task":"P2-356","title":"x"}}',
    '{"msg":"pipeline start","data":{"task":"P2-357","title":"y"}}',
  ].join("\n");
  check("preflight: tasks started after the last boot without a result died mid-pipeline", tasksDiedMidPipeline(log).join(",") === "P2-356,P2-357");
  check("preflight: the real invalid mission.json shape is explained", missionReason('{"models":{"builder":"b200x4/glm-5.3-flash"}}').includes("falta v:1") && missionReason(null).startsWith("ausente"));
}

// ── 6b. preflight: read-only by construction (source shape + real plutil) ────
{
  const src = readFileSync(join(ROOT, "scripts", "pilot-preflight.ts"), "utf8");
  const drift = readFileSync(join(ROOT, "apps", "pilot", "src", "judgedrift.ts"), "utf8");
  // `plutil -extract` WITHOUT `-o -` rewrites the plist in place (the 09-27
  // 12:08 incident turned com.ocr.pilot.plist into 81 bytes of JSON)
  const plutilCalls = src.match(/run\("plutil",\s*\[[^\]]*\]/g) ?? [];
  check("read-only: every plutil call writes to stdout (-o -)", plutilCalls.length > 0 && plutilCalls.every((c) => /"-o",\s*"-"/.test(c)), plutilCalls.join(" | "));
  const writers = /\b(writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|copyFileSync|writeFile|appendFile|mkdtempSync)\b/;
  check("read-only: the preflight and judgedrift.ts never call an fs write API", !writers.test(src) && !writers.test(drift));
  check(
    "read-only: the preflight never goes through a normalize-and-save state path",
    !/\b(loadState|saveState|doctorState|runDoctor|normalizePilotState|touchHeartbeat|emit|notifySupervisor)\(/.test(src),
  );
  check("read-only: git never fetches and the git reader always carries --no-optional-locks", !/"fetch"/.test(src) && /io\.run\("git", \["--no-optional-locks", \.\.\.args\]/.test(src) && /"--no-optional-locks", \.\.\.args/.test(drift));

  // real plutil against a COPIED plist fixture (macOS only)
  const plistHome = join(tmp, "plist-home");
  const agents = join(plistHome, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const plist = join(agents, "com.ocr.pilot.plist");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>OCR_PILOT_REPO</key>\n    <string>/tmp/fixture prod repo</string>\n  </dict>\n  <key>Label</key>\n  <string>com.ocr.pilot</string>\n  <key>ProgramArguments</key>\n  <array><string>/opt/homebrew/bin/node</string><string>apps/pilot/src/index.ts</string></array>\n</dict>\n</plist>\n`;
  writeFileSync(plist, xml);
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(plist, past, past);
  const before = statSync(plist);
  if (process.platform === "darwin") {
    const resolved = resolveProdRepo(plistHome, realIo(), undefined);
    const after = statSync(plist);
    check("read-only: resolveProdRepo reads OCR_PILOT_REPO from the launchd plist via real plutil", resolved === "/tmp/fixture prod repo", resolved);
    check(
      "read-only: the plist is byte-, size- and mtime-identical after the real plutil extraction",
      readFileSync(plist, "utf8") === xml && after.size === before.size && after.mtimeMs === before.mtimeMs,
    );
    // control: the incident's shape (`-extract <key> json` WITHOUT `-o -`)
    // rewrites the file in place — proof that the assertion above would catch
    // the regression (measured: `raw` alone prints to stdout, `json` rewrites)
    const control = join(agents, "control.plist");
    writeFileSync(control, xml);
    execFileSync("plutil", ["-extract", "ProgramArguments", "json", control], { stdio: "ignore" });
    check("read-only (control): plutil -extract <key> json without -o - DOES rewrite the plist", readFileSync(control, "utf8") !== xml);
  } else {
    console.log("OK   read-only: real plutil fixture skipped (plutil is macOS-only)");
  }
  check("read-only: OCR_PILOT_REPO in the environment wins without touching the plist", resolveProdRepo(plistHome, realIo(), "/env/repo") === "/env/repo" && statSync(plist).mtimeMs === before.mtimeMs);
}

function goodFacts(): PreflightFacts {
  return {
    at: new Date(0).toISOString(),
    prodRepo: "/prod",
    launchd: ["com.ocr.opencode", "com.ocr.daemon", "com.ocr.relay", "com.ocr.pwa"].map((label, i) => ({ label, loaded: true, pid: 100 + i, lastExit: 0 })),
    heartbeat: { ageMs: 3 * 86_400_000, pid: 1, pidAlive: false },
    frozen: false,
    auditMode: null,
    disks: [{ label: "interno", path: "/", freeBytes: 70 * 1024 ** 3, failBelow: 5 * 1024 ** 3, warnBelow: 20 * 1024 ** 3 }],
    opencodeDbBytes: null,
    judge: { usable: true, pin: "957106c0", head: "957106c0", detail: "judge 957106c0 pinned + clean" },
    judgeDrift: [{ target: "a491841", drift: { state: "match", detail: "runtime-identical" } }],
    gh: { ok: true, account: "owner", detail: "authenticated" },
    opencode: { ok: true, version: "1.18.32", detail: "HTTP 200" },
    daemon: { ok: true, opencodeHealthy: true, relayConnected: true, pwaHealthy: true, uptimeS: 60, detail: "HTTP 200" },
    tierA: { model: "p/m", baseURL: "http://x/v1", status: 200, listed: true, keySent: true, detail: "GET /models → HTTP 200" },
    claude: { ok: true, version: "2.1.283", detail: "ok" },
    tierB: { configured: true, rolesOk: true, detail: "all 5 judgment roles pinned on tier B" },
    notify: { session: "ses_live", sessionExists: true, pending: 0, oldestPendingAgeMs: null, lastDeliveredAgeMs: 60_000, pushSubscriptions: 1 },
    mission: { present: false, valid: false, detail: "ausente" },
    pilotCfg: { slots: 8, maxDeploysPerDay: 200, monitorMin: 2, digest: null },
    deploy: { prod: sha(1), prodDirty: [], originLocal: sha(2), originRemote: sha(2), plan: planDeploy([sha(2), sha(1)], sha(1), [vm(sha(2), "T1")], []), stepwiseInProd: true, rangeTouches: null, queueReady: 2 },
    inflight: { prs: [], localOnly: [], attempts: {}, diedMidPipeline: [] },
  };
}
{
  const ok = goodFacts();
  check("preflight verdict: a healthy runtime is GO", verdict(evaluate(ok)).go, render(ok, evaluate(ok)));
  const hbNoise = goodFacts();
  hbNoise.heartbeat = { ageMs: 30_000, pid: 35139, pidAlive: false };
  check(
    "preflight: a fresh heartbeat without a pilot process is flagged as noise, not liveness",
    evaluate(hbNoise).find((c) => c.id === "heartbeat")!.detail.includes("não é sinal de vida"),
  );
  const noAlerts = goodFacts();
  noAlerts.notify = { session: "ses_gone", sessionExists: false, pending: 100, oldestPendingAgeMs: 4 * 86_400_000, lastDeliveredAgeMs: 16 * 86_400_000, pushSubscriptions: 0 };
  const na = evaluate(noAlerts).find((c) => c.id === "notify")!;
  check("preflight verdict: supervisor session gone + zero push subscriptions = NO-GO (alerts reach nobody)", !verdict(evaluate(noAlerts)).go && na.status === "fail" && na.detail.includes("404"));
  noAlerts.notify.pushSubscriptions = 1;
  check("preflight verdict: session gone but push still subscribed → warning only", evaluate(noAlerts).find((c) => c.id === "notify")!.status === "warn");
  const drift = goodFacts();
  drift.judgeDrift = [{ target: "a491841", drift: { state: "drift", detail: "runtime drift at token 670", diff: { judge: "clientHello ( a , b )", target: "clientHello ( a , b , now" } } }];
  const dc = evaluate(drift).find((c) => c.id === "judge-drift")!;
  check("preflight verdict: judge protocol drift = NO-GO with the differing window", dc.status === "fail" && dc.detail.includes("clientHello ( a , b , now") && !verdict(evaluate(drift)).go);
  const disk = goodFacts();
  disk.disks[0]!.freeBytes = 0.1 * 1024 ** 3;
  check("preflight verdict: < 5 GB on the prod volume = NO-GO", evaluate(disk).find((c) => c.id === "disk:/")!.status === "fail");
  const down = goodFacts();
  down.launchd![1]!.pid = null;
  check("preflight verdict: daemon not running = NO-GO", evaluate(down).find((c) => c.id === "launchd")!.status === "fail");
  const key = goodFacts();
  key.tierA = { ...key.tierA, status: 401, listed: null };
  check("preflight verdict: provider rejecting the configured key = NO-GO", evaluate(key).find((c) => c.id === "tier-a")!.status === "fail");
  const catchUp = goodFacts();
  const hist = Array.from({ length: 17 }, (_, k) => sha(17 - k)); // newest first, prod = sha(1)
  catchUp.deploy.plan = planDeploy(hist, sha(1), hist.slice(0, 16).map((s, k) => vm(s, `T${16 - k}`)), []);
  catchUp.deploy.stepwiseInProd = false;
  const dep = evaluate(catchUp).find((c) => c.id === "deploy")!;
  check(
    "preflight verdict: a 16-merge catch-up on old prod code warns about the single jump and gives the monitorMin lever",
    dep.status === "warn" && dep.detail.includes("UM salto de 16 merges") && dep.detail.includes("4 passo(s)") && (dep.fix ?? "").includes("monitorMin para 10"),
  );
  const inflight = goodFacts();
  inflight.inflight = {
    prs: [{ number: 1390, head: "pilot/P2-357", mergeable: "CONFLICTING", title: "x" }],
    localOnly: [
      { slot: "repo-1", branch: "pilot/P2-356", commits: 1, tip: "716deb7", hasPr: false },
      { slot: "repo-1", branch: "pilot/P3-328", commits: 2, tip: "89b88b1", hasPr: false },
      { slot: "repo-2", branch: "pilot/P2-357", commits: 1, tip: "88efcd3", hasPr: true },
    ],
    attempts: { "P3-328": 1 },
    diedMidPipeline: ["P2-356", "P2-357"],
  };
  const ic = evaluate(inflight).find((c) => c.id === "inflight")!;
  check(
    "preflight verdict: only the branch the boot doctor would delete is at risk, with a backup command",
    ic.status === "warn" && (ic.fix ?? "").includes("branch backup/P2-356 pilot/P2-356") && !(ic.fix ?? "").includes("P3-328") && ic.detail.includes("preservado: tentativa registrada"),
  );
}

// ── 7. preflight end-to-end, hermetic and provably read-only ──────────────────
{
  const home = join(tmp, "home");
  const state = join(home, ".opencode-remote");
  mkdirSync(join(state, "pilot", "repo-1"), { recursive: true });
  mkdirSync(join(state, "logs"), { recursive: true });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "opencode", "opencode.db"), "db");
  // prod clone at c1 (origin/main = c2), judge mirror = pre-RT-390 → drift vs c2
  const prod = join(state, "prod");
  git(tmp, "clone", "-q", originDir, prod);
  git(prod, "checkout", "-q", c1);
  const judge = join(state, "judge");
  git(tmp, "clone", "-q", judgeDir, judge);
  writeFileSync(join(state, "judge.json"), JSON.stringify({ pin: judgePin }));
  // a slot clone carrying a local-only pilot/<ID> commit and no PR
  const slot = join(state, "pilot", "repo-1");
  rmSync(slot, { recursive: true, force: true });
  git(tmp, "clone", "-q", originDir, slot);
  git(slot, "checkout", "-q", "-b", "pilot/P9-001");
  writeFileSync(join(slot, "wip.txt"), "wip\n");
  git(slot, "add", "-A");
  git(slot, "commit", "-q", "-m", "wip");
  writeFileSync(join(state, "pilot.json"), JSON.stringify({ monitorMin: 2, slots: 8, maxDeploysPerDay: 200, supervisorSession: "ses_gone", models: { tierB: { planner: "opus", strategist: "opus", forensic: "opus", reviewerEscalation: "opus" } } }));
  writeFileSync(join(state, "mission.json"), JSON.stringify({ models: { builder: "p/m" } }));
  writeFileSync(join(state, "subscriptions.json"), "[]");
  writeFileSync(join(state, "pilot", "state.json"), JSON.stringify({ taskAttempts: {} }));
  writeFileSync(join(state, "pilot", "verified-merges.jsonl"), [vm(c1, "P9-000"), vm(c2, "P9-002")].map((v) => JSON.stringify(v)).join("\n") + "\n");
  writeFileSync(join(state, "pilot", "quarantine.jsonl"), "");
  writeFileSync(join(state, "pilot", "notify-pending.jsonl"), `${JSON.stringify({ ts: Date.now() - 3_600_000, task: "x", ok: false, text: "t" })}\n`);
  writeFileSync(join(state, "pilot", "heartbeat"), String(Date.now() - 60_000));
  writeFileSync(join(state, "logs", "pilot.log"), '{"msg":"pilot started"}\n{"msg":"pipeline start","data":{"task":"P9-001"}}\n');

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url === "/global/health") return json(200, { healthy: true, version: "9.9.9" });
    if (url === "/session/ses_gone") return json(404, { name: "NotFoundError" });
    if (url === "/metrics") return json(200, { uptime_s: 99, ocr_opencode_healthy: 1, ocr_relay_connected: 1, ocr_pwa_origin_healthy: 1 });
    if (url === "/v1/models") return req.headers.authorization === "Bearer test-key" ? json(200, { data: [{ id: "glm-test" }] }) : json(401, { error: "Unauthorized" });
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(home, ".config", "opencode", "opencode.jsonc"), `{\n  // comment\n  "model": "fake/glm-test",\n  "provider": { "fake": { "options": { "baseURL": "http://127.0.0.1:${port}/v1", "apiKey": "test-key" } } },\n}\n`);

  // stat-dirty tracked files: a plain `git status` would rewrite both indexes
  utimesSync(join(prod, "f.txt"), new Date(), new Date());
  utimesSync(join(judge, "src", "cli.ts"), new Date(), new Date());
  const snapshot = (dir: string): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else out.set(p, `${s.size}:${s.mtimeMs}`);
      }
    };
    walk(dir);
    return out;
  };
  const before = snapshot(home);

  const io = realIo();
  const fakeRun: typeof io.run = (cmd, args, opts) => {
    if (cmd === "git") return io.run(cmd, args, opts);
    if (cmd === "launchctl") return { ok: true, output: "PID\tStatus\tLabel\n11\t0\tcom.ocr.opencode\n12\t0\tcom.ocr.daemon\n13\t0\tcom.ocr.relay\n14\t0\tcom.ocr.pwa\n" };
    if (cmd === "gh" && args[0] === "auth") return { ok: true, output: "github.com\n  ✓ Logged in to github.com account tester (keyring)\n  - Token: gho_************************************\n" };
    if (cmd === "gh" && args[0] === "pr") return { ok: true, output: "[]" };
    if (cmd === "claude") return { ok: true, output: "2.1.999 (Claude Code)\n" };
    return { ok: false, output: `${cmd} not available in the hermetic run` };
  };
  const env: PreflightEnv = {
    home,
    state,
    prodRepo: prod,
    judgeDir: judge,
    judgePinFile: join(state, "judge.json"),
    pilotLog: join(state, "logs", "pilot.log"),
    opencodeConfig: join(home, ".config", "opencode", "opencode.jsonc"),
    opencodeDb: join(home, ".local", "share", "opencode", "opencode.db"),
    opencodeUrl: `http://127.0.0.1:${port}`,
    daemonMetricsUrl: `http://127.0.0.1:${port}/metrics`,
    volumes: [{ label: "interno", path: home, failBelow: 1, warnBelow: 2 }],
    io: { ...io, run: fakeRun },
  };
  try {
    const facts = await collectFacts(env);
    const checks = evaluate(facts);
    const text = render(facts, checks);
    const after = snapshot(home);
    const changed = [...after.entries()].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
    const added = [...after.keys()].filter((p) => !before.has(p));
    check("preflight e2e: NOT A SINGLE file under HOME changed (git indexes included)", changed.length === 0 && added.length === 0 && after.size === before.size, [...changed, ...added].join(", "));
    const byId = (id: string) => checks.find((c) => c.id === id);
    check("preflight e2e: the plan reads prod → newest verified merge from local refs", facts.deploy.prod === c1 && facts.deploy.plan?.newest === c2 && facts.deploy.plan?.pending.map((m) => m.task).join(",") === "P9-002");
    check("preflight e2e: judge mirror (pre-RT-390) vs the RT-390 target → FALHA judge-drift", byId("judge-drift")?.status === "fail" && byId("judge")?.status === "ok");
    check("preflight e2e: supervisor session 404 + 0 push → FALHA caminho de alerta", byId("notify")?.status === "fail" && byId("notify")!.detail.includes("ses_gone"));
    check("preflight e2e: tier-A probe sends the configured key and sees the model served", facts.tierA.status === 200 && facts.tierA.listed === true && facts.tierA.keySent);
    check("preflight e2e: the key never reaches the facts/JSON output", !JSON.stringify(facts).includes("test-key") && !text.includes("test-key"));
    check("preflight e2e: tier-B missing fable → AVISO", byId("tierb-roles")?.status === "warn" && byId("tierb-roles")!.detail.includes("fable"));
    check("preflight e2e: invalid mission.json → AVISO with the reason", byId("mission")?.status === "warn" && byId("mission")!.detail.includes("falta v:1"));
    check("preflight e2e: local-only pilot/P9-001 without PR/attempt → backup command", (byId("inflight")?.fix ?? "").includes("branch backup/P9-001 pilot/P9-001") && facts.inflight.diedMidPipeline.join(",") === "P9-001");
    check("preflight e2e: the verdict is NO-GO and the render lists the failures", !verdict(checks).go && text.includes("VEREDITO: NO-GO") && text.includes("caminho de alerta"));
    check("preflight e2e: gh token is masked in the facts", !JSON.stringify(facts).includes("gho_"));
  } finally {
    server.close();
  }
}

rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall deploy-preflight checks passed");
