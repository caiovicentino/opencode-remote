/**
 * eval-06: BACKLOG.md is the fleet's queue and must be machine-reliable.
 * Five red-team findings (RT-341/390/424/439/453, all fixed on main) rotted
 * as loose paragraphs under ## Ready for up to 19 days, six `- [x]` items sat
 * in the queue, the boot doctor validated the prod checkout's working tree
 * (the DEPLOYED snapshot — "taskCount: 1" at every boot) and a models-only
 * mission.json was dropped as "invalid" with its pins ignored. This battery
 * pins the line-level structure scan, the writer ratchet, the fixed writers
 * (markDone, blockTask, appendReadyLines, pending refill), the doctor's
 * queue source + merged-work check, the mission file verdict and — last —
 * the REAL BACKLOG.md of this repo, so debris can never land unnoticed again.
 * Run: npx tsx scripts/backlog-integrity.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addTask,
  appendReadyLines,
  backlogShapeIssues,
  blockedTaskIds,
  blockTask,
  blockTaskEdit,
  introducesReadyDebris,
  isValidTaskLine,
  markDone,
  parseBacklog,
  parseTaskLine,
  readyOrphanBlocks,
} from "../apps/pilot/src/backlog";
import { doctorBacklog, mergedOpenTasks, validateBacklog, type RunFn } from "../apps/pilot/src/doctor";
import { redteamFinding } from "../apps/pilot/src/findingline";
import { classifyMissionFile, parseMissionSpec, readMission, standalonePins, MISSION_MODEL_ROLES } from "../apps/pilot/src/mission";
import { readPendingRefill, savePendingRefill } from "../apps/pilot/src/refill";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const root = join(import.meta.dirname, "..");
const withTmp = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-integrity-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const T1 = "- [ ] (P2-501) [P2] First task — spec: do it (area: ui)";
const T2 = "- [ ] (P2-502) [P2] Second task — spec: more (area: daemon)";
const D1 = "- [x] (P2-500) [P2] Old task — spec: x — merged by pilot 2026-09-01";
const clean = ["# BACKLOG", "", "## Ready", "", T1, "", T2, "", "## Blocked", "- [ ] (P3-600) [P3] Stuck — spec: y (area: ui) — blocked after 4 attempts: z", "", "## Done", D1, ""].join("\n");

// --- parseTaskLine: the one definition of "what the queue schedules" ----------

check("parseTaskLine: a tagged task parses (id, priority, area)", parseTaskLine(T1)?.id === "P2-501" && parseTaskLine(T1)?.priority === "P2" && parseTaskLine(T1)?.area === "ui");
check("parseTaskLine: prose, [x] items and headers are not tasks", [" **Title:** x", D1, "## Ready", "`apps/daemon/src/index.ts:1877` builds"].every((l) => parseTaskLine(l) === null));
check("parseBacklog: still reads exactly the Ready tasks (refactor is behavior-neutral)", parseBacklog(clean).map((t) => t.id).join(",") === "P2-501,P2-502");

// --- backlogShapeIssues: every non-blank line is classified -------------------

check("shape: a clean backlog has zero issues", backlogShapeIssues(clean).length === 0, JSON.stringify(backlogShapeIssues(clean)));

// the exact shape commit 6675cc7 wrote (pre-P2-336 redteam flow): a one-line
// task whose "spec" is `**`, then the finding's paragraphs below it
const rtShape = [
  "# BACKLOG",
  "",
  "## Ready",
  "- [ ] (RT-453) [P0] Redteam finding 2026-09-22 — spec: **",
  "",
  "**1. Daemon tunnel SSRF with credential exfiltration — HIGH**",
  "`apps/daemon/src/index.ts:1877` builds the upstream URL with new URL(req.path, OPENCODE_URL)",
  T1,
  "",
  "## Done",
  D1,
].join("\n");
{
  const issues = backlogShapeIssues(rtShape);
  check(
    "shape: the RT-453 paragraphs are two orphan lines at their 1-based line numbers",
    issues.length === 2 && issues.every((i) => i.kind === "orphan" && i.section === "Ready") && issues[0]!.line === 6 && issues[1]!.line === 7,
    JSON.stringify(issues),
  );
}

// P2-341's block scan hid a valid task glued under a `[x]` item (P2-356 under
// P2-330 on main) and counted the `[x]` as prose — the line scan names both
const glued = ["## Ready", "- [x] (P2-330) [P2] Done already — spec: x — done", T1, "", "## Done", D1].join("\n");
{
  const issues = backlogShapeIssues(glued);
  check("shape: a `[x]` item in Ready is done-in-ready with its id", issues.length === 1 && issues[0]!.kind === "done-in-ready" && issues[0]!.id === "P2-330" && issues[0]!.line === 2);
  check("shape: the valid task glued under it is NOT an issue (the scheduler sees it)", !issues.some((i) => i.id === "P2-501") && parseBacklog(glued).length === 1);
  check("shape: P2-341's block scan misreports the same file (baseline for the fix)", readyOrphanBlocks(glued).count === 1 && readyOrphanBlocks(glued).starts[0] === 2);
}
{
  const wrapped = ["## Ready", T1, "wrapped continuation the builder never sees", "", "## Done"].join("\n");
  const issues = backlogShapeIssues(wrapped);
  check("shape: a wrapped continuation line under a task is an orphan", issues.length === 1 && issues[0]!.kind === "orphan" && issues[0]!.line === 3);
}
{
  const statusMix = [
    "## Ready",
    T1,
    "## Blocked",
    "- [x] (P3-601) [P3] Checked but blocked — spec: x",
    "a note under blocked",
    "## Done",
    "- [ ] (P1-056) [P0][MANUAL] Still open — spec: x",
    D1,
    "## Ready",
    T2,
  ].join("\n");
  const kinds = backlogShapeIssues(statusMix).map((i) => `${i.kind}@${i.line}`).join(",");
  check(
    "shape: done-in-blocked, prose, open-in-done and a repeated ## Ready header are all named",
    kinds === "done-in-blocked@4,prose@5,open-in-done@7,duplicate-section@9",
    kinds,
  );
  const dupBlocked = ["## Ready", "", "## Blocked", "", "## Blocked", "", "## Done", ""].join("\n");
  check("shape: repeated ## Blocked stays the P2-142 warning, not a shape issue", backlogShapeIssues(dupBlocked).length === 0);
}
check("shape: a file without pilot sections reports nothing (never throws)", backlogShapeIssues("# just notes\n\nhello\n").length === 0);

// --- introducesReadyDebris: the writer ratchet --------------------------------

check("ratchet: identical text introduces nothing", !introducesReadyDebris(rtShape, rtShape));
check("ratchet: removing debris is always allowed", !introducesReadyDebris(rtShape, clean));
check("ratchet: pre-existing debris never blocks an unrelated edit", !introducesReadyDebris(rtShape, rtShape.replace(T1, T2)));
check("ratchet: a new prose line under ## Ready is refused", introducesReadyDebris(clean, clean.replace(T1, `${T1}\n**Severity:** HIGH`)));
check("ratchet: a new `[x]` item under ## Ready is refused", introducesReadyDebris(clean, clean.replace(T1, `${T1}\n${D1}`)));
check("ratchet: multiset — a second copy of existing debris is refused", introducesReadyDebris(rtShape, rtShape.replace("**1. Daemon", "**1. Daemon tunnel SSRF with credential exfiltration — HIGH**\n**1. Daemon")));
check("ratchet: prose under ## Done is not the queue's business", !introducesReadyDebris(clean, clean.replace(D1, `${D1}\nsome note`)));

// every fs write of backlog.ts goes through the ratchet (seedBacklogSkeleton
// only creates structure): a new writer cannot bypass it by accident
{
  const src = readFileSync(join(root, "apps", "pilot", "src", "backlog.ts"), "utf8");
  const writes = src.match(/writeFileSync\(/g) ?? [];
  check("ratchet: backlog.ts has exactly two writeFileSync calls (writeChecked + skeleton seed)", writes.length === 2, `found ${writes.length}`);
  for (const fn of ["markDone", "blockTask", "addTask", "appendReadyLines"]) {
    const start = src.indexOf(`export function ${fn}(`);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    check(`ratchet: ${fn} writes only through writeChecked`, start >= 0 && body.includes("writeChecked(") && !body.includes("writeFileSync("));
  }
}

// --- writers -------------------------------------------------------------------

withTmp((dir) => {
  const p = join(dir, "BACKLOG.md");
  // the historical rot, reproduced: markDone moves only the task line, the
  // paragraphs stay — which is why the doctor must scan every line at boot
  writeFileSync(p, rtShape);
  check("markDone: moves the RT line and reports applied", markDone(dir, "RT-453", "merged by pilot 2026-09-22") === "applied");
  const after = readFileSync(p, "utf8");
  check("markDone: the line lands under ## Done as [x] with the note", /^## Done\n- \[x\] \(RT-453\) \[P0\] Redteam finding 2026-09-22 — spec: \*\* — merged by pilot 2026-09-22$/m.test(after));
  check("markDone: the left-behind paragraphs are exactly what the boot doctor now flags", backlogShapeIssues(after).filter((i) => i.kind === "orphan").length === 2 && !validateBacklog(after).ok);
  check("markDone: a second call on a done id is noop (file untouched)", markDone(dir, "RT-453", "again") === "noop" && readFileSync(p, "utf8") === after);
  check("markDone: an unknown id is missing", markDone(dir, "P9-999", "x") === "missing");
});

withTmp((dir) => {
  const p = join(dir, "BACKLOG.md");
  // regression: without ## Done the old code removed the line and wrote the
  // file anyway — the task vanished from the backlog
  const noDone = ["## Ready", "", T1, ""].join("\n");
  writeFileSync(p, noDone);
  check("markDone: no ## Done header → missing and the file is untouched (task never vanishes)", markDone(dir, "P2-501", "x") === "missing" && readFileSync(p, "utf8") === noDone);
});

withTmp((dir) => {
  const p = join(dir, "BACKLOG.md");
  // regression: String.replace expands `$'` (rest of input) in a string
  // replacement — a task line carrying it spliced the file into ## Done
  const dollar = "- [ ] (P2-503) [P2] Quote $' and $` in a spec — spec: literal (area: ui)";
  writeFileSync(p, ["## Ready", "", dollar, "", "## Done", D1, ""].join("\n"));
  check("markDone: `$'` / `` $` `` in the line stay literal", markDone(dir, "P2-503", "merged") === "applied");
  const md = readFileSync(p, "utf8");
  check("markDone: the file is not spliced (one ## Done, one ## Ready, the line once)", (md.match(/^## Done$/gm) ?? []).length === 1 && (md.match(/^## Ready$/gm) ?? []).length === 1 && md.includes("- [x] (P2-503) [P2] Quote $' and $` in a spec"));
});

{
  // P3-457's Blocked line carried raw ESC[91m from a colored builder trace
  const colored = "builder did not finish (round 3): \u001b[91m\u001b[1mError: \u001b[0mCannot connect to API\u0007 done";
  const out = blockTaskEdit(clean, "P2-501", colored);
  const line = out.text.split("\n").find((l) => l.includes("(P2-501)")) ?? "";
  check("blockTaskEdit: ANSI sequences and control bytes never reach BACKLOG.md", out.result === "applied" && !/[\u0000-\u001f\u007f]/.test(line) && line.endsWith("— builder did not finish (round 3): Error: Cannot connect to API done"), line);
}

withTmp((dir) => {
  const p = join(dir, "BACKLOG.md");
  writeFileSync(p, clean);
  check("blockTask: still applies through the checked write", blockTask(dir, "P2-502", "kept failing") === "applied" && blockedTaskIds(readFileSync(p, "utf8")).has("P2-502"));
});

withTmp((dir) => {
  const p = join(dir, "BACKLOG.md");
  writeFileSync(p, clean);
  const multi = "- [ ] (P2-510) [P2] Smuggled — spec: first line (area: ui)\n**Severity:** HIGH (area: ui)";
  const good = "- [ ] (P2-511) [P2] Fine — spec: one line (area: infra)";
  check("appendReadyLines: a multiline entry is dropped, the valid one lands", appendReadyLines(dir, [multi, good]) === "applied");
  const md = readFileSync(p, "utf8");
  check("appendReadyLines: nothing of the smuggled entry reached the file", !md.includes("P2-510") && !md.includes("**Severity:**") && md.includes("(P2-511)") && backlogShapeIssues(md).length === 0);
  const before = readFileSync(p, "utf8");
  check("appendReadyLines: only invalid lines → missing, file untouched", appendReadyLines(dir, [multi]) === "missing" && readFileSync(p, "utf8") === before);
});

withTmp((dir) => {
  // the redteam path of today (P2-336) + the ratchet: a multiline finding
  // becomes exactly one task line and the file gains zero debris
  const p = join(dir, "BACKLOG.md");
  writeFileSync(p, clean);
  const raw = "\n**Title:** Replayed handshake resets the seq replay guard\n\n**Severity:** HIGH\n\n**Proof/attack sketch:** the handshake has no freshness\n";
  const f = redteamFinding(raw, "2026-09-27");
  check("redteam: the finding lands as one line", addTask(dir, "RT-600", "P0", f.title, `${f.spec} (area: ${f.area})`) === "applied");
  const md = readFileSync(p, "utf8");
  check("redteam: zero Ready debris after the landing", backlogShapeIssues(md).length === 0 && parseBacklog(md)[0]?.id === "RT-600");
  check("redteam: a raw multiline spec is refused (nothing written)", addTask(dir, "RT-601", "P0", "t", "a\n\n**Severity:** HIGH (area: relay)") === "invalid" && readFileSync(p, "utf8") === md);
});

withTmp((dir) => {
  const file = join(dir, "pending-refill.json");
  const good = "- [ ] (P3-951) [P3] Refill survivor — spec: x (area: infra)";
  savePendingRefill(file, ["- [ ] (P3-952) [P3] Smuggled — spec: y (area: ui)\n**prose**", good], "m");
  check("pendingRefill: a store line failing isValidTaskLine is dropped on read", JSON.stringify(readPendingRefill(file)?.lines) === JSON.stringify([good]));
  savePendingRefill(file, ["not a task line at all"], "m");
  check("pendingRefill: a store with no valid line reads as null (like a corrupt one)", readPendingRefill(file) === null);
});

// --- doctor: validate the scheduler's queue, not the deployed working tree --

{
  const diag = validateBacklog(rtShape);
  check(
    "doctor: orphan lines are a problem citing their lines",
    !diag.ok && diag.problems.some((p) => p.startsWith("## Ready lines that are not task lines") && p.includes("line 6") && p.includes("line 7")),
    JSON.stringify(diag.problems),
  );
  const g = validateBacklog(glued);
  check("doctor: a [x] item in Ready is a problem naming the id", !g.ok && g.problems.some((p) => p.includes("already checked [x]") && p.includes("P2-330@2")));
  check("doctor: a clean backlog stays ok with no warnings", validateBacklog(clean).ok && validateBacklog(clean).warnings.length === 0);
}

withTmp((dir) => {
  // the prod checkout's working tree (deployed snapshot) holds ONE task while
  // origin/main holds two — the old doctor reported the snapshot ("taskCount: 1")
  writeFileSync(join(dir, "BACKLOG.md"), ["## Ready", "", "- [ ] (P2-345) [P2] Deployed-era task — spec: x (area: ui)", "", "## Done", ""].join("\n"));
  const ran: string[] = [];
  const log = ["abc1234\tpilot(P3-600): the real work for the stuck task (#9)", "def5678\tpilot(P3-600): block after 4 failed attempts", "0a1b2c3\tpilot(P2-501): mark done"].join("\n");
  const run: RunFn = (cmd) => {
    ran.push(cmd);
    if (cmd.startsWith("git show origin/main:BACKLOG.md")) return { ok: true, output: clean };
    if (cmd.startsWith("git log origin/main")) return { ok: true, output: log };
    return { ok: true, output: "" };
  };
  const d = doctorBacklog(dir, { base: "main", run });
  check("doctor: fetches, then reads origin/<base>:BACKLOG.md like the scheduler", ran[0] === "git fetch -q origin main" && ran[1] === "git show origin/main:BACKLOG.md");
  check("doctor: taskCount is the queue's (2), not the deployed snapshot's (1)", d.taskCount === 2 && d.source === "origin/main", JSON.stringify(d));
  check("doctor: a blocked task whose work is on main is a warning with the sha", d.ok && d.warnings.some((w) => w.includes("P3-600 (abc1234)")), JSON.stringify(d.warnings));
  const down: RunFn = () => ({ ok: false, output: "fatal: invalid object name" });
  const fb = doctorBacklog(dir, { base: "main", run: down });
  check("doctor: an unreadable ref falls back to the working tree and says so", fb.source === "working tree" && fb.taskCount === 1 && fb.warnings[0]?.includes("origin/main:BACKLOG.md unreadable") === true);
  check("doctor: the legacy call (no base) keeps reading the working tree", doctorBacklog(dir).source === "working tree" && doctorBacklog(dir).taskCount === 1);
});

{
  const log = [
    "1111111\tpilot(P3-600): mark done (empty-diff self-heal)",
    "2222222\tpilot(P3-600): block after 4 failed attempts",
    "3333333\tpilot(P2-501): scaffold the thing (#10)",
    "4444444\tpilot(P9-999): unrelated task (#11)",
  ].join("\n");
  const merged = mergedOpenTasks(clean, log);
  check("mergedOpenTasks: bookkeeping subjects are never work; open ids with work are reported", JSON.stringify(merged) === JSON.stringify([{ id: "P2-501", sha: "3333333" }]), JSON.stringify(merged));
}
{
  const src = readFileSync(join(root, "apps", "pilot", "src", "doctor.ts"), "utf8");
  const boot = src.slice(src.indexOf("export function runDoctor("), src.indexOf("function safe("));
  check("doctor: the boot pass validates the queue ref (base branch), not the working tree", boot.includes('doctorBacklog(cfg.repo, { base: cfg.baseBranch ?? "main" })'));
}

// --- mission.json: the models-only shape is pins, not "invalid" --------------

{
  // the runtime file of 2026-09-11, byte-compatible shape (no v, no prompt)
  const runtime = JSON.stringify({ models: Object.fromEntries(MISSION_MODEL_ROLES.map((r) => [r, "b200x4/glm-5.3-flash"])) }, null, 1);
  const v = classifyMissionFile(runtime);
  check("mission: a models-only file is pins with all five roles", v.kind === "pins" && Object.keys(v.models).length === 5, JSON.stringify(v));
  check("mission: the strict mission parser still rejects it (daemon card unchanged)", parseMissionSpec(runtime) === null);
  const read = readMission("/x/mission.json", () => runtime);
  check("mission: readMission carries the verdict next to spec/hash", read.spec === null && read.verdict.kind === "pins" && typeof read.hash === "string");
  const pins = standalonePins(v.kind === "pins" ? v.models : undefined, { strategist: "opus", planner: "opus" });
  check(
    "mission: pilot.json tierB keeps its judgment role — strategist is shadowed, the tier-A roles apply",
    JSON.stringify(Object.keys(pins.applied ?? {}).sort()) === JSON.stringify(["builder", "researcher", "reviewer", "scribe"]) && JSON.stringify(pins.shadowed) === JSON.stringify(["strategist"]),
    JSON.stringify(pins),
  );
  check("mission: without a tierB table every pin applies", Object.keys(standalonePins(v.kind === "pins" ? v.models : undefined, undefined).applied ?? {}).length === 5);
  check("mission: nothing to pin → no applied block", standalonePins(undefined, undefined).applied === undefined);
}
{
  const at = "2026-09-27T10:00:00Z";
  const cases: [string, string | null, string][] = [
    ["v:1 + models only", JSON.stringify({ v: 1, models: { builder: "p/m" }, setAt: at }), "pins"],
    ["full mission", JSON.stringify({ v: 1, prompt: "ship it", setAt: at }), "mission"],
    ["absent", null, "absent"],
  ];
  for (const [name, raw, kind] of cases) check(`mission verdict: ${name} → ${kind}`, classifyMissionFile(raw).kind === kind);
  const reasons: [string, string, string][] = [
    ["prompt without v", JSON.stringify({ prompt: "x" }), 'missing "v": 1'],
    ["wrong version", JSON.stringify({ v: 2, models: { builder: "p/m" } }), "unsupported version"],
    ["unknown role", JSON.stringify({ models: { planner: "p/m" } }), '"planner"'],
    ["bad repo", JSON.stringify({ v: 1, repoUrl: "https://gitlab.com/a/b" }), "repoUrl"],
    ["nothing useful", JSON.stringify({ v: 1, setAt: at }), "needs a prompt"],
    ["garbage", "{nope", "not valid JSON"],
    ["array", "[1]", "not a JSON object"],
    ["empty", "  ", "empty file"],
  ];
  for (const [name, raw, reason] of reasons) {
    const v = classifyMissionFile(raw);
    check(`mission verdict: ${name} → invalid with the reason`, v.kind === "invalid" && v.reason.includes(reason), JSON.stringify(v));
  }
  const idx = readFileSync(join(root, "apps", "pilot", "src", "index.ts"), "utf8");
  check("mission wiring: the invalid boot line carries the reason", idx.includes("{ reason: missionBoot.verdict.reason }"));
  check("mission wiring: pins feed cfg.missionModels only when no mission is active", idx.includes("cfg.missionModels = activeMission?.models ?? pins?.applied") && idx.includes("standalonePins(missionBoot.verdict.models, cfg.models?.tierB)"));
}

// --- the REAL BACKLOG.md of this repo ------------------------------------------

{
  const real = readFileSync(join(root, "BACKLOG.md"), "utf8");
  const issues = backlogShapeIssues(real);
  check(
    "real BACKLOG.md: zero structure issues (no Ready debris, no misfiled status, no stray prose)",
    issues.length === 0,
    issues.slice(0, 10).map((i) => `${i.kind}@${i.line}${i.id ? ` ${i.id}` : ""}`).join(", "),
  );
  const diag = validateBacklog(real);
  check("real BACKLOG.md: the doctor validator is green with no warnings", diag.ok && diag.warnings.length === 0, JSON.stringify({ problems: diag.problems, warnings: diag.warnings }));
  const tasks = parseBacklog(real);
  check("real BACKLOG.md: every queued task passes the landing validator (P2-341 scan agrees)", tasks.every((t) => isValidTaskLine(t.line)) && readyOrphanBlocks(real).count === 0, JSON.stringify(readyOrphanBlocks(real)));
  check("real BACKLOG.md: no control bytes anywhere", !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(real));
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall backlog-integrity checks passed");
