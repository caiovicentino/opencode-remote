/**
 * P1-056 / P3-353 / eval-08: the judge bridge (apps/pilot/src/judge.ts) had no
 * test at all — signature verification, pin/dirty checks and the sha binding
 * were only ever exercised in production. Pins, against a hermetic fake judge
 * (temp git repo + ephemeral ed25519 key + injected runner):
 *   - a genuine verdict is accepted; forged, tampered, cross-sha, cross-task,
 *     replayed (nonce) and wrong-judge verdicts are refused (verdict v2);
 *   - a v1 judge (pinned before the binding) keeps working on sha + task;
 *   - pin mismatch, dirty tree, missing interpreter and a judge tree modified
 *     DURING the run fail closed;
 *   - the per-request temp dir never leaks (it did: 2 judge-req-* dirs from
 *     09/09 and 11/09 are still under ~/.opencode-remote) and holds a 0600
 *     request;
 *   - a protected refusal surfaces the ids and escalates;
 *   - deploy's live invariants run the judge's own node + tsx, never `npx`;
 *   - the doctor canary is red on a v1 judge (it has no real canary).
 * (The vendored-protocol drift check is eval-07's apps/pilot/src/judgedrift.ts.)
 * Run: npx tsx scripts/judge-bridge.test.ts
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PILOT_EVENTS_FILE = join(mkdtempSync(join(tmpdir(), "judge-bridge-events-")), "events.jsonl");

const { judgeGate, judgeInvariantsCommand, resolveJudge, runJudgeCanary, JudgeError } = await import("../apps/pilot/src/judge");
const { checkVerdictBinding } = await import("../apps/pilot/src/judgeverdict");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: GIT_ENV }).trim();

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIV = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const signV = (v: object) => sign(null, Buffer.from(createHash("sha256").update(JSON.stringify(v)).digest("hex"), "hex"), PRIV).toString("base64");

/** A pinned fake judge: git repo with cli.ts, judge.pub, its own tsx entry. */
function fakeJudge(version: number | null) {
  const root = mkdtempSync(join(tmpdir(), "judge-bridge-"));
  const dir = join(root, "judge");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "tsx", "dist"), { recursive: true });
  writeFileSync(join(dir, "src", "cli.ts"), "// fake judge cli\n");
  writeFileSync(join(dir, "node_modules", "tsx", "dist", "cli.mjs"), "// fake tsx\n");
  writeFileSync(join(dir, "judge.pub"), publicKey.export({ type: "spki", format: "pem" }) as string);
  writeFileSync(join(dir, "package.json"), JSON.stringify(version === null ? { name: "ocr-judge" } : { name: "ocr-judge", ocrJudge: { verdict: version } }));
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "judge");
  const pin = git(dir, "rev-parse", "HEAD");
  const pinFile = join(root, "judge.json");
  writeFileSync(pinFile, JSON.stringify({ pin }));
  const reqRoot = join(root, "req");
  mkdirSync(reqRoot);
  return { root, dir, pin, pinFile, reqRoot };
}

const SHA = "a".repeat(40);
const input = { ws: "/nonexistent/ws", sha: SHA, task: { id: "P3-353" }, builderOutput: "", startedAtMs: 0, nameOnly: "" };
type Req = { nonce?: string; sha: string; task: { id: string } };
const readReq = (argv: string[]): Req => JSON.parse(readFileSync(argv[argv.indexOf("--req") + 1]!, "utf8")) as Req;

/** Runner that answers like the judge: builds the verdict from the request. */
function answering(build: (req: Req, pin: string) => object, pin: string, sigOf: (v: object) => string = signV) {
  return (argv: string[]) => {
    const v = build(readReq(argv), pin);
    return `some npx noise\n${JSON.stringify({ verdict: v, sig: sigOf(v) })}\n`;
  };
}
const green = (req: Req, pin: string) => ({ sha: req.sha, task: req.task.id, ok: true, step: "none", tail: "gate green", flaky: [], hallucinations: [], v: 2, nonce: req.nonce, judge: pin, base: "b".repeat(40), constitutionChange: false, protected: [], flakes: [] });

function expectJudgeError(name: string, fn: () => unknown, re: RegExp) {
  try {
    fn();
    check(name, false, "no error thrown");
  } catch (err) {
    check(name, err instanceof JudgeError && re.test((err as Error).message), String(err));
  }
}

// ── v2 judge: binding ────────────────────────────────────────────────────────
{
  const j = fakeJudge(2);
  const deps = { dir: j.dir, pinFile: j.pinFile, reqRoot: j.reqRoot, onConstitutionChange: () => {} };
  let mode = -1;
  const ok = judgeGate(input, {
    ...deps,
    run: (argv, cwd) => {
      const reqFile = argv[argv.indexOf("--req") + 1]!;
      mode = statSync(reqFile).mode & 0o777;
      check("spawn: the judge's own tsx + cli, cwd = judge (never npx)", argv[0] === join(j.dir, "node_modules", "tsx", "dist", "cli.mjs") && argv[1] === join(j.dir, "src", "cli.ts") && argv[2] === "gate" && cwd === j.dir);
      return answering(green, j.pin)(argv);
    },
  });
  check("v2: genuine verdict accepted and bound", ok.ok && ok.step === "none" && ok.bound && ok.judge === j.pin.slice(0, 8));
  check("request file is 0600", mode === 0o600, `mode=${mode.toString(8)}`);
  check("request carries a fresh 32-hex nonce", (() => {
    let seen = "";
    judgeGate(input, { ...deps, run: (argv) => ((seen = readReq(argv).nonce ?? ""), answering(green, j.pin)(argv)) });
    return /^[0-9a-f]{32}$/.test(seen);
  })());

  expectJudgeError("forged signature refused", () => judgeGate(input, { ...deps, run: answering(green, j.pin, () => "dGhhb3MtZm9yZWFkLW5ldmVyLXZhbGlk") }), /signature INVALID/);
  expectJudgeError(
    "red verdict flipped to green after signing refused",
    () =>
      judgeGate(input, {
        ...deps,
        run: (argv) => {
          const req = readReq(argv);
          const red = { ...green(req, j.pin), ok: false, step: "unit", tail: "1 failing" };
          return JSON.stringify({ verdict: { ...red, ok: true, step: "none" }, sig: signV(red) });
        },
      }),
    /signature INVALID/,
  );
  expectJudgeError("verdict for another sha refused", () => judgeGate(input, { ...deps, run: answering((r, p) => ({ ...green(r, p), sha: "c".repeat(40) }), j.pin) }), /verdict is for/);
  expectJudgeError("verdict for another task refused", () => judgeGate(input, { ...deps, run: answering((r, p) => ({ ...green(r, p), task: "P1-001" }), j.pin) }), /task P1-001/);
  // replay: a genuine green verdict captured from an earlier request
  let captured = "";
  judgeGate(input, { ...deps, run: (argv) => (captured = answering(green, j.pin)(argv)) });
  expectJudgeError("replayed verdict (earlier request's nonce) refused", () => judgeGate(input, { ...deps, run: () => captured }), /nonce mismatch/);
  expectJudgeError("v2 verdict without a nonce refused", () => judgeGate(input, { ...deps, run: answering((r, p) => ({ ...green(r, p), nonce: undefined }), j.pin) }), /nonce mismatch/);
  expectJudgeError("verdict naming another judge HEAD refused", () => judgeGate(input, { ...deps, run: answering((r) => green(r, "d".repeat(40)), j.pin) }), /pinned/);
  expectJudgeError("spawn failure fails closed", () => judgeGate(input, { ...deps, run: () => { throw Object.assign(new Error("boom"), { stdout: "judge fatal: x" }); } }), /judge spawn failed/);
  expectJudgeError("unparseable output fails closed", () => judgeGate(input, { ...deps, run: () => "not json" }), /no parseable verdict/);
  expectJudgeError(
    "judge tree modified during the run fails closed",
    () =>
      judgeGate(input, {
        ...deps,
        run: (argv) => {
          writeFileSync(join(j.dir, "src", "cli.ts"), "// swapped mid-gate\n");
          return answering(green, j.pin)(argv);
        },
      }),
    /changed during the gate/,
  );
  git(j.dir, "checkout", "--", ".");
  check("no judge-req-* dir leaks on any path (success, invalid signature, spawn failure…)", readdirSync(j.reqRoot).length === 0, readdirSync(j.reqRoot).join());

  // protected refusal: ids surfaced + escalation hook
  const escalated: string[][] = [];
  const prot = judgeGate(input, {
    ...deps,
    onConstitutionChange: (_t, ids) => escalated.push(ids),
    run: answering((r, p) => ({ ...green(r, p), ok: false, step: "protected", tail: "constitution-change required", constitutionChange: true, protected: ["apps/pilot/src/judge.ts"] }), j.pin),
  });
  check("protected: red step, ids and flag surfaced", !prot.ok && prot.step === "protected" && prot.constitutionChange && prot.protected.join() === "apps/pilot/src/judge.ts");
  check("protected: escalated once with the ids", escalated.length === 1 && escalated[0]?.join() === "apps/pilot/src/judge.ts");
  const flakes = judgeGate(input, { ...deps, run: answering((r, p) => ({ ...green(r, p), flaky: ["desktop-flow"], flakes: [{ step: "desktop-flow", count: 2, budget: 2, exhausted: false }] }), j.pin) });
  check("flakes: budget notes surfaced to the pipeline", flakes.flaky.join() === "desktop-flow" && flakes.flakes[0]?.count === 2);

  // pin / tree / interpreter
  writeFileSync(j.pinFile, JSON.stringify({ pin: "e".repeat(40) }));
  expectJudgeError("pin mismatch fails closed", () => resolveJudge(deps), /!= pinned/);
  writeFileSync(j.pinFile, JSON.stringify({ pin: "not-a-sha" }));
  expectJudgeError("malformed pin fails closed", () => resolveJudge(deps), /pin missing/);
  writeFileSync(j.pinFile, JSON.stringify({ pin: j.pin }));
  writeFileSync(join(j.dir, "judge.pub"), "tampered\n");
  expectJudgeError("dirty judge tree fails closed", () => resolveJudge(deps), /dirty/);
  git(j.dir, "checkout", "--", ".");

  // deploy: live invariants through the judge's interpreter
  const inv = judgeInvariantsCommand("/prod checkout", { live: true, loc: deps });
  check("invariants: node + judge tsx + judge invariants.ts, cwd = judge, --live", inv.cwd === j.dir && inv.cmd.startsWith(JSON.stringify(process.execPath)) && inv.cmd.includes(JSON.stringify(join(j.dir, "node_modules", "tsx", "dist", "cli.mjs"))) && inv.cmd.includes(JSON.stringify(join(j.dir, "src", "invariants.ts"))) && inv.cmd.includes('--repo "/prod checkout" --live') && !inv.cmd.includes("npx"), inv.cmd);
  const deploy = src("apps/pilot/src/deploy.ts");
  check("deploy.ts: both live-invariants runs use judgeInvariantsCommand, none `npx tsx` the judge", (deploy.match(/judgeInvariantsCommand\(cfg\.repo, \{ live: true \}\)/g) ?? []).length === 2 && !/npx tsx \$\{JSON\.stringify\(judgeCli/.test(deploy));

  // doctor canary
  check("canary: green only on the judge's CANARY OK line", runJudgeCanary({ ...deps, run: () => "OK   x\nCANARY OK\n" }).ok && !runJudgeCanary({ ...deps, run: () => "FAIL x\nCANARY FAILED\n" }).ok);
  check("canary: a crashing canary is red with its output", (() => {
    const r = runJudgeCanary({ ...deps, run: () => { throw Object.assign(new Error("exit 1"), { stdout: "FAIL canary: planted" }); } });
    return !r.ok && r.output.includes("planted");
  })());
}

// ── v1 judge (pinned before the binding) ─────────────────────────────────────
{
  const j = fakeJudge(null);
  const deps = { dir: j.dir, pinFile: j.pinFile, reqRoot: j.reqRoot, onConstitutionChange: () => {} };
  const v1 = judgeGate(input, { ...deps, run: answering((r) => ({ sha: r.sha, task: r.task.id, ok: true, step: "none", tail: "gate green", flaky: [], hallucinations: [] }), j.pin) });
  check("v1 judge: sha+task-bound verdict still accepted, reported unbound", v1.ok && !v1.bound);
  expectJudgeError("v1 judge: sha binding still enforced", () => judgeGate(input, { ...deps, run: answering((r) => ({ sha: "f".repeat(40), task: r.task.id, ok: true, step: "none", tail: "", flaky: [] }), j.pin) }), /verdict is for/);
  const c = runJudgeCanary({ ...deps, run: () => "OK   canary: forged verdict rejected\n" });
  check("v1 judge: doctor canary is red with the re-pin reason (its canary proves nothing)", !c.ok && c.output.includes("verdict v1"));
  const missing = runJudgeCanary({ dir: join(j.root, "nope"), pinFile: j.pinFile });
  check("canary: missing judge is red, never a throw", !missing.ok && missing.output.includes("judge missing"));
}

// ── binding rules in isolation ───────────────────────────────────────────────
{
  const v = { sha: SHA, task: "P1-001", ok: true, step: "none", tail: "", flaky: [], nonce: "ab".repeat(16), judge: "1".repeat(40) };
  const want = { sha: SHA, task: "P1-001", nonce: "ab".repeat(16), pin: "1111111", version: 2 };
  check("binding: exact match → null", checkVerdictBinding(v, want) === null);
  check("binding: prefix pin accepted (judge.json may hold a short sha)", checkVerdictBinding(v, { ...want, pin: "1".repeat(12) }) === null);
  check("binding: v1 expectation ignores nonce/judge", checkVerdictBinding({ ...v, nonce: undefined, judge: undefined }, { ...want, version: 1 }) === null);
  check("binding: empty pin never matches", checkVerdictBinding(v, { ...want, pin: "" }) !== null);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\njudge-bridge checks passed");
