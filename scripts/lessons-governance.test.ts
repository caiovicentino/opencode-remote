/**
 * Eval 05 (2026-09-27) — lessons & experience governance battery.
 *
 * Pins the fixes measured against production data (read-only snapshots):
 * - failure-lesson feed (forensic 2026-09-24 rec 6): only real blocked tasks
 *   (attempts > 0, never the legacy archived success lessons), one per task,
 *   filtered BEFORE the recency window, ranked by relevance for the planner,
 *   rendered without the stop-loss boilerplate / OK-line tails / ANSI codes;
 *   the doctor diagnosis ignores archived rows; the nightly archive writes its
 *   own kind;
 * - IER injection: idf-weighted matching with a relevance floor, spec
 *   boilerplate ignored, paraphrases not injected twice; word-boundary
 *   clipping; re-landed lessons refresh instead of duplicating; the scribe
 *   prompt contract (0–2 lessons, budget, existing lessons);
 * - lessonImpactV2: per-run token deltas, untreated runs outside the cohorts,
 *   survives the midnight rollover; the v1 record is never rewritten, so a
 *   state file round-trips through this branch and back to older code intact;
 * - loadState's midnight rollover keeps the nightly guards and lifetime
 *   counters (forensicLast & co. were dropped: weekly forensic re-ran daily).
 * Every state file lives in a temp dir (injected paths — never the real HOME).
 * Pure node (fs/os/path in a temp dir) — portable battery.
 * Run: npx tsx scripts/lessons-governance.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiagnosis } from "../apps/pilot/src/audit";
import {
  appendLessons,
  dedupeAndPrune,
  lessonsNearDiff,
  LESSON_MAX_CHARS,
  normalizeLesson,
  parseLessons,
  pickRelevantLessons,
  SCRIBE_LESSON_BUDGET,
  SCRIBE_MAX_LESSONS,
} from "../apps/pilot/src/experience";
import {
  appendFailureLesson,
  compactFindings,
  failureLessonsBlock,
  FAILURE_TITLE_CAP,
  formatFailureLesson,
  isBlockedFailure,
  latestBlockedFailures,
  parseFailureLessons,
  readRecentFailureLessons,
  tailSignal,
  type FailureLesson,
} from "../apps/pilot/src/failureLessons";
import { normalizeLessonImpactV2, recordLessonImpact, runTokenDelta } from "../apps/pilot/src/lessonimpact";
import { loadState, saveState, type LessonImpact, type LessonImpactV2, type PilotState } from "../apps/pilot/src/state";
import { scribePrompt } from "../apps/pilot/src/pipeline";
import type { Task } from "../apps/pilot/src/backlog";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), "ocr-lessons-gov-"));

// ── failure-lesson feed ─────────────────────────────────────────────────────
const real = (task: string, extra: Partial<FailureLesson> = {}): FailureLesson => ({
  kind: "failure",
  ts: "2026-09-10T10:00:00-03:00",
  task,
  attempts: 4,
  step: "desktop-flow",
  findings: `finding of ${task}`,
  tail: "",
  ...extra,
});
const legacyArchived = (task: string, n: number) =>
  JSON.stringify({ kind: "failure", ts: "2026-09-24T02:23:25-03:00", task, attempts: 0, step: "archived", findings: `- When archived success lesson ${n} (fonte: ${task})`, tail: "" });

{
  check("feed: a blocked task (attempts > 0) is a real failure", isBlockedFailure(real("P3-401")));
  check("feed: a legacy archived row is not", !isBlockedFailure({ ...real("P2-353"), attempts: 0, step: "archived" }));
  check("feed: 0 attempts is not a block even without the archived step", !isBlockedFailure({ ...real("P2-353"), attempts: 0 }));

  const reblocked = latestBlockedFailures([real("P3-371", { findings: "first block" }), real("P3-374"), real("P3-371", { findings: "second block" })]);
  check(
    "feed: one row per task, the newest wins at its newest position",
    reblocked.length === 2 && reblocked[0]!.task === "P3-374" && reblocked[1]!.task === "P3-371" && reblocked[1]!.findings === "second block",
  );
  check("feed: latestBlockedFailures caps at max (most recent kept)", latestBlockedFailures([real("A-1"), real("A-2"), real("A-3")], 2).map((l) => l.task).join() === "A-2,A-3");
  check("feed: max 0 → nothing", latestBlockedFailures([real("A-1")], 0).length === 0);

  // production shape (2026-09-27 snapshot): 15 real blocks, then 192 archived
  // rows appended by the nightly maintenance — the last-10 window held only
  // archived rows, so the planner/strategist block was 3 success lessons.
  const prodLike = [
    ...Array.from({ length: 15 }, (_, i) => JSON.stringify(real(`P3-${400 + i}`))),
    ...Array.from({ length: 192 }, (_, i) => legacyArchived(`P2-${200 + (i % 150)}`, i)),
    JSON.stringify({ kind: "experience-archived", ts: "2026-09-24T02:23:25-03:00", task: "P2-999", lesson: "- When new-kind archive (fonte: P2-999)" }),
  ].join("\n");
  const file = join(dir, "lessons.jsonl");
  writeFileSync(file, `${prodLike}\n`);
  const recent = readRecentFailureLessons(file);
  check("feed: the recency window is taken AFTER filtering (10 real, 0 archived)", recent.length === 10 && recent.every((l) => l.attempts === 4) && recent[9]!.task === "P3-414");
  const block = failureLessonsBlock(recent);
  check(
    "feed: the strategist block carries real blocks only",
    (block.match(/\n- \[P3-4/g) ?? []).length === 10 && !block.includes("archived") && block.includes("10 most recent blocked tasks"),
  );
  check("feed: the new experience-archived kind never parses as a failure", !parseFailureLessons(prodLike).some((l) => l.task === "P2-999"));
  check("feed: forensic window of 100 = the 15 real blocks", readRecentFailureLessons(file, 100).length === 15);

  // planner: relevance first when the pool is larger than the block
  const pool = [
    real("P2-126", { step: "pipeline", findings: "gate green but the PR merge failed: PR not mergeable" }),
    real("P3-401", { step: "evidence", findings: "infra ci-red", tail: "UI task without shot-1440x900 path in the EVIDENCE block" }),
    real("P1-102", { step: "pipeline", findings: "planner did not produce a valid specs/P1-102.md" }),
    real("P3-457", { step: "desktop-flow", findings: "builder did not finish", tail: "FAILURES: 3\n   condition never held (12 probes)" }),
    real("P2-099", { step: "evidence", findings: "pasted output diverges from re-run of: npm run build" }),
  ];
  const planner = failureLessonsBlock(pool, 2, "Janela do app desktop — spec: novo beat no desktop-flow com screenshot 1440x900 e shot 390");
  check(
    "feed: planner block ranks the failures closest to the task",
    planner.includes("[P3-457]") && planner.includes("[P3-401]") && !planner.includes("[P1-102]") && planner.includes("2 blocked tasks closest to this task"),
  );
  check("feed: without a query the block is the most recent", failureLessonsBlock(pool, 2).includes("[P2-099]") && failureLessonsBlock(pool, 2).includes("[P3-457]"));
  check("feed: nothing real → no block", failureLessonsBlock(parseFailureLessons(legacyArchived("P2-001", 1))) === "");
  check("feed: max 0 → no block (never the whole pool)", failureLessonsBlock(pool, 0) === "" && failureLessonsBlock(pool, 0, "desktop-flow") === "");
}

{
  const boiler =
    'infra "ci-red" failed 3x in a row on this task — treated as a hard failure instead of an endless free retry — last detail: gate green but the PR merge failed: PR #1316 not merged (skip): CI red: ci-gate aggregate failed (verify=FAILURE)';
  check("render: stop-loss boilerplate compacted, the CI job name survives", compactFindings(boiler) === 'infra "ci-red" 3x in a row: gate green but the PR merge failed: PR #1316 not merged (skip): CI red: ci-gate aggregate failed (verify=FAILURE)');
  check(
    "render: boilerplate without a detail keeps kind + streak only",
    compactFindings('infra "ci-red" failed 3x in a row on this task — treated as a hard failure instead of an endless free retry (read-only remote, dead gh, or unreachable API?)') === 'infra "ci-red" 3x in a row',
  );
  check("render: other findings pass through untouched", compactFindings("planner did not produce a valid spec") === "planner did not produce a valid spec");
  // eval-03 wording (PR #1399): red jobs after the count + ci-red hypothesis
  check(
    "render: eval-03 reason keeps the red job list and the last detail",
    compactFindings('infra "ci-red" failed 3x in a row on this task (red: verify, relay-image) — treated as a hard failure instead of an endless free retry — last detail: gate green but the PR merge failed') ===
      'infra "ci-red" 3x in a row (red: verify, relay-image): gate green but the PR merge failed',
  );
  check(
    "render: eval-03 ci-red hypothesis without a detail compacts to kind + streak",
    compactFindings('infra "ci-red" failed 3x in a row on this task — treated as a hard failure instead of an endless free retry (remote CI checks red on the task PR)') === 'infra "ci-red" 3x in a row',
  );
  const ciTail = ['remote CI red on "ci / verify (ubuntu-latest)" — scripts/unit.test.ts: FAIL relay-image import', "PR #1316 · rejected head 0123456789ab · branch origin/pilot/P3-459", "OK   typecheck"].join("\n");
  check("render: eval-03 CI summary tail leads with the full job name", tailSignal(ciTail).startsWith('remote CI red on "ci / verify (ubuntu-latest)"') && !tailSignal(ciTail).includes("OK "));
  const line = formatFailureLesson(real("P3-459", { findings: boiler, step: "evidence" }));
  check("render: the rendered line keeps the job verdict inside the part budget", line.includes("verify=FAILURE") && !line.includes("treated as a hard failure"));

  const flowTail = [
    "OK   P2-152: hint flag stamped in userData",
    '{"ts":"2026-09-09T10:41:22.084Z","event":"session.historyPage","data":{}}',
    "desktop flow duration: 192.3s (budget 420s)",
    "FAILURES: 3",
    '   condition never held (12 probes), last value: "false|ROWS:0|MENU:false"',
    '   condition never held (12 probes), last value: "false|ROWS:0|MENU:false"',
  ].join("\n");
  const sig = tailSignal(flowTail);
  check("render: tail keeps failure lines, drops OK lines / JSON events / duration", sig.startsWith("FAILURES: 3") && sig.includes("condition never held") && !sig.includes("OK ") && !sig.includes("historyPage") && !sig.includes("duration"));
  check("render: duplicate tail lines collapse", (sig.match(/condition never held/g) ?? []).length === 1);
  check("render: a tail with no signal falls back to its non-noise lines", tailSignal("OK   a\nreviewer finding: rename x") === "reviewer finding: rename x");
  check("render: an all-noise tail renders nothing", tailSignal("OK   a\nOK   b") === "");

  const ansi = formatFailureLesson(real("P3-457", { findings: "\u001b[91m\u001b[1mError: \u001b[0mCannot connect to API", tail: `shot: ${homedir()}/.opencode-remote/pilot/shots/x.png not a readable PNG` }));
  check("render: ANSI codes stripped and the home prefix shortened", ansi.includes("Error: Cannot connect to API") && !ansi.includes("\u001b") && ansi.includes("~/.opencode-remote") && !ansi.includes(homedir() + "/"));
  const titled = formatFailureLesson(real("P3-401", { title: "Composer: anexos colados " + "x".repeat(200) }));
  check("render: the task title rides the line, bounded", titled.startsWith("- [P3-401] Composer: anexos colados") && titled.length < 700);

  const file = join(dir, "titled.jsonl");
  appendFailureLesson(file, real("P3-500", { title: "t".repeat(1000) }));
  const stored = readRecentFailureLessons(file);
  check("feed: the stored title is bounded and parsed back", stored.length === 1 && stored[0]!.title!.length === FAILURE_TITLE_CAP);
}

{
  // doctor diagnosis (prod log 2026-09-23: "top failure steps: archived(182)")
  const file = join(dir, "diag.jsonl");
  writeFileSync(file, [JSON.stringify(real("P3-401", { step: "evidence" })), legacyArchived("P2-269", 1), legacyArchived("P2-269", 2), legacyArchived("P2-269", 3)].join("\n") + "\n");
  const diag = buildDiagnosis({ lessonsFile: file, gateFailDir: join(dir, "no-gate-fail") });
  check("diagnosis: archived rows are not failure steps", !diag.topSteps.some((s) => s.step === "archived") && diag.topSteps[0]?.step === "evidence");
  check("diagnosis: merged tasks with archived lessons are not 'rejected'", !diag.topTasks.some((t) => t.task === "P2-269"));
}

// ── IER injection ───────────────────────────────────────────────────────────
const md = (lines: string[]) => `# Experience memory (IER)\n\n## Lessons\n${lines.join("\n")}\n`;
{
  const hub = "- When adding a module that apps/web and apps/desktop both need, keep it pure, add a unit test in scripts/unit.test.ts, update README and the build (fonte: P2-001)";
  const forced = "- When drawing focus rings in CSS, never rely on box-shadow alone — forced-colors mode discards it, pair it with an outline (fonte: P3-464)";
  const pool = md([hub, forced, "- When a relay frame duplicates, check the seq watermark first (fonte: P1-002)"]);
  const pick = pickRelevantLessons(pool, "Anel de foco some no Windows com contraste alto", "apps/web/src/index.css desenha o foco com box-shadow; forced-colors descarta — typecheck, build e test:unit verdes com EVIDENCE");
  check("inject: the specific lesson is picked, the boilerplate hub is not", pick.length === 1 && pick[0] === forced);
  check(
    "inject: spec boilerplate alone (apps/src/unit/test/build/evidence) is not relevance",
    pickRelevantLessons(pool, "Tarefa qualquer", "apps/web/src scripts/unit.test.ts typecheck build test:unit EVIDENCE output real").length === 0,
  );
  const para1 = "- When wiring an async handler into ws.on message, never leave a floating rejection via void fn — route it through one catch backstop (fonte: RT-424)";
  const para2 = "- When dispatching an async handler from ws.on message, never leave void handler floating — route it through a catch backstop that logs (fonte: RT-455)";
  const twice = pickRelevantLessons(md([para1, para2]), "async handler rejection on ws message", "floating void handler catch backstop");
  // the better-matching wording (it also names the "rejection") takes the slot
  check("inject: two paraphrases of one lesson are injected once", twice.length === 1 && twice[0] === para1);
}

{
  const long = `When the renderer action can arrive via OS relaunch or a cold start, do queue it as a pending flag and flush it on did-finish-load, because a webContents.send broadcast fired before the renderer listens is silently dropped and the click does nothing at all for the user`;
  const clipped = normalizeLesson(long, "P2-353");
  const body = clipped.replace(/^- /, "").replace(/ \(fonte: P2-353\)$/, "");
  check("clip: never longer than LESSON_MAX_CHARS", body.length <= LESSON_MAX_CHARS && body.endsWith("…"));
  check("clip: cut at a word boundary, never mid-word", long.startsWith(body.slice(0, -1)) && long.charAt(body.length - 1) === " ");
  check("clip: short lessons untouched", normalizeLesson("When X happens often, do Y now", "P1-001") === "- When X happens often, do Y now (fonte: P1-001)");
}

{
  // refresh: a lesson re-learned by a later merge survives the oldest-first prune
  const recurring = "- When a Jump List task relaunches the app, read the dedicated argv flag in second-instance (fonte: P2-100)";
  const filler = (n: number) => `- When filler${n} alpha${n} breaks, do mend${n} beta${n} gamma${n} (fonte: P9-${String(n).padStart(3, "0")})`;
  let file = md([recurring, ...Array.from({ length: 4 }, (_, i) => filler(i))]);
  const again = appendLessons(file, ["When a Jump List task relaunches the app, read the dedicated argv flag in second-instance"], "P2-200");
  file = again.md;
  const lessons = parseLessons(file);
  check("refresh: the re-landed lesson moves to the newest slot with the new fonte", again.refreshed.length === 1 && lessons[lessons.length - 1]!.includes("(fonte: P2-200)") && lessons.length === 5);
  const pruned = parseLessons(dedupeAndPrune(file, 3).md);
  check("refresh: the refreshed lesson survives a prune that drops the oldest", pruned.some((l) => l.includes("Jump List")) && pruned.length === 3);
  const capped = appendLessons(md([]), ["When one alpha thing, do one", "When two beta thing, do two", "When three gamma thing, do three"], "P1-001");
  check("append: at most SCRIBE_MAX_LESSONS new lessons per merge", capped.added.length === SCRIBE_MAX_LESSONS && SCRIBE_MAX_LESSONS === 2);
}

{
  const pool = md([
    "- When a CSS invariant must hold per theme block in tokens.css, assert the file-wide total after stripping comments (fonte: P3-467)",
    "- When a relay frame duplicates, check the seq watermark first (fonte: P1-002)",
  ]);
  const diff = "diff --git a/apps/web/src/tokens.css b/apps/web/src/tokens.css\n+++ b/apps/web/src/tokens.css\n+  /* theme block */\n+  color-scheme: dark;\n+  comments stripped before counting the invariant\n";
  const near = lessonsNearDiff(pool, "Controles nativos ignoram o tema", "declarar no bloco de tema", diff);
  check("scribe: existing lessons are found through the diff's paths and added lines", near.length === 1 && near[0]!.includes("tokens.css"));
}

{
  const task = (id: string, title: string): Task => ({ id, priority: "P2", title, spec: "s", area: "ui", line: "" });
  const a = scribePrompt(task("P2-001", "first"), "diff a", ["- When X, do Y (fonte: P1-001)"]);
  const b = scribePrompt(task("P2-002", "second"), "diff b");
  check("scribe prompt: 0 to 2 lessons, empty answer allowed", a.includes("Output 0 to 2 lessons") && a.includes("Zero lessons is a valid answer"));
  check("scribe prompt: the character budget is stated", a.includes(`At most ${SCRIBE_LESSON_BUDGET} characters`) && SCRIBE_LESSON_BUDGET < LESSON_MAX_CHARS);
  check("scribe prompt: existing lessons ride the variable tail only when given", a.includes("EXISTING LESSONS") && a.includes("(fonte: P1-001)") && !b.includes("EXISTING LESSONS"));
  check("scribe prompt: stable prefix byte-identical across tasks (P1-077)", a.slice(0, a.indexOf("TASK (")) === b.slice(0, b.indexOf("TASK (")) && a.indexOf("EXISTING LESSONS") > a.indexOf("TASK ("));
  check("scribe prompt: LESSONS/SCRIBE:DONE contract kept", a.includes("LESSONS:\n<lesson lines>\nSCRIBE:DONE"));
}

// ── lessonImpactV2 ──────────────────────────────────────────────────────────
{
  // P1-076 in the real log: lifetime totals 23.3M → 27.4M → 35.9M over 3 runs
  const lifetimes = [23_288_442, 27_410_410, 35_896_509];
  const v1 = lifetimes.reduce((a, b) => a + b, 0);
  const v2 = lifetimes.reduce((acc, after, i) => acc + runTokenDelta(i ? lifetimes[i - 1] : undefined, after), 0);
  check("impact: per-run deltas sum to the task's lifetime (v1 counted 86.6M for 35.9M)", v2 === 35_896_509 && v1 === 86_595_361);
  check("impact: runTokenDelta never negative, unknown → 0", runTokenDelta(10, 5) === 0 && runTokenDelta(undefined, undefined) === 0 && runTokenDelta(5, Number.NaN) === 0);

  // the pre-incident production record (orchestrator, 2026-09-27)
  const v1Record: LessonImpact = { with: { merges: 352, roundsTotal: 895, tokensTotal: 6_424_039_987 }, without: { merges: 3, roundsTotal: 4, tokensTotal: 16_530_200 } };
  const st: { lessonImpact?: LessonImpact; lessonImpactV2?: LessonImpactV2 } = { lessonImpact: JSON.parse(JSON.stringify(v1Record)) };
  const now = new Date("2026-09-27T12:00:00-03:00");
  recordLessonImpact(st, { lessons: 5, rounds: 2, ok: true, tokens: 100 }, now);
  recordLessonImpact(st, { lessons: 0, rounds: 0, ok: false, tokens: 0 }, now);
  recordLessonImpact(st, { lessons: 0, rounds: 1, ok: true, tokens: 7 }, now);
  const li = st.lessonImpactV2!;
  check("impact: v2 record stamped with its start day", li.since === "2026-09-27");
  check("impact: a run that never reached a builder stays out of both cohorts", li.untreated === 1 && li.with.runs === 1 && li.without.runs === 1 && li.without.merges === 1 && li.with.tokensTotal === 100);
  check("impact: the legacy v1 record is never rewritten (rollback-safe)", JSON.stringify(st.lessonImpact) === JSON.stringify(v1Record));

  // loadState with an injected path (never the real HOME): a state from an
  // earlier day goes through the midnight rollover — both records survive
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ date: "2026-09-24", tasks: 7, deploys: 1, failures: 0, merges: 5, taskAttempts: {}, lessonImpact: v1Record, lessonImpactV2: li }));
  const loaded = loadState(stateFile);
  check("impact: lessonImpactV2 survives the midnight rollover", loaded.tasks === 0 && JSON.stringify(loaded.lessonImpactV2) === JSON.stringify(li));
  check("impact: the v1 record survives loadState untouched", JSON.stringify(loaded.lessonImpact) === JSON.stringify(v1Record));
  check("impact: v2 round-trips through its normalizer", JSON.stringify(normalizeLessonImpactV2(JSON.parse(JSON.stringify(li)))) === JSON.stringify(li));
  check("impact: garbage normalizes to undefined", normalizeLessonImpactV2("x") === undefined && normalizeLessonImpactV2(null) === undefined);
}

// ── loadState midnight rollover + rollback round-trip (eval 05) ─────────────
{
  const yesterdayFile = join(dir, "state-yesterday.json");
  const v1Record: LessonImpact = { with: { merges: 352, roundsTotal: 895, tokensTotal: 6_424_039_987 }, without: { merges: 3, roundsTotal: 4, tokensTotal: 16_530_200 } };
  // production shape before the 2026-09-27 incident (date = last pilot day)
  const prod = {
    date: "2026-09-24", tasks: 9, deploys: 2, failures: 1, merges: 7, taskAttempts: { "P2-356": 1 },
    redteamLast: "2026-09-24", researchLast: "2026-09-23", explorerLast: "2026-09-24", forensicLast: "2026-09-24",
    mergesSinceCorpus: 3, auditDiagnosis: "api=healthy | top failure steps: none | top rejected tasks: none",
    expMaintLast: "2026-09-24", lessonImpact: v1Record,
  };
  writeFileSync(yesterdayFile, JSON.stringify(prod, null, 2));
  const rolled = loadState(yesterdayFile);
  check("rollover: daily counters reset on a new day", rolled.date !== "2026-09-24" && rolled.tasks === 0 && rolled.merges === 0 && rolled.deploys === 0);
  check(
    "rollover: nightly guards survive (forensicLast keeps the WEEKLY cadence)",
    rolled.forensicLast === "2026-09-24" && rolled.redteamLast === "2026-09-24" && rolled.researchLast === "2026-09-23" && rolled.explorerLast === "2026-09-24" && rolled.expMaintLast === "2026-09-24",
  );
  check("rollover: lifetime counters survive (gate-corpus cadence, audit chip)", rolled.mergesSinceCorpus === 3 && rolled.auditDiagnosis === prod.auditDiagnosis && rolled.taskAttempts["P2-356"] === 1);
  writeFileSync(yesterdayFile, JSON.stringify({ ...prod, forensicLast: 7, mergesSinceCorpus: -2, auditDiagnosis: { x: 1 } }));
  const garbage = loadState(yesterdayFile);
  check("rollover: garbage-typed guards are dropped, never crash", garbage.forensicLast === undefined && garbage.mergesSinceCorpus === undefined && garbage.auditDiagnosis === undefined && garbage.redteamLast === "2026-09-24");

  // rollback safety: v1 file -> this branch (load, one run, save) -> a v1-only
  // reader (origin/main + prod 1ebbbc1 normalize lessonImpact exactly like
  // this: with/without cohorts copied, finite numbers >= 0) -> intact
  writeFileSync(yesterdayFile, JSON.stringify(prod, null, 2));
  const st: PilotState = loadState(yesterdayFile);
  recordLessonImpact(st, { lessons: 4, rounds: 2, ok: true, tokens: 1234 }, new Date("2026-09-27T12:00:00-03:00"));
  saveState(st, yesterdayFile);
  const saved = JSON.parse(readFileSync(yesterdayFile, "utf8")) as { lessonImpact: LessonImpact; lessonImpactV2: LessonImpactV2; forensicLast: string };
  check("round-trip: the branch never rewrites the v1 record on load/record/save", JSON.stringify(saved.lessonImpact) === JSON.stringify(v1Record));
  const olderReader = (v: { with?: Partial<LessonImpact["with"]>; without?: Partial<LessonImpact["with"]> }) => {
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
    const c = (m: Partial<LessonImpact["with"]> = {}) => ({ merges: n(m.merges), roundsTotal: n(m.roundsTotal), tokensTotal: n(m.tokensTotal) });
    return { with: c(v.with), without: c(v.without) };
  };
  check("round-trip: an older v1-only reader gets the original numbers back", JSON.stringify(olderReader(saved.lessonImpact)) === JSON.stringify(v1Record));
  check("round-trip: the v2 run landed beside it, not inside it", saved.lessonImpactV2.with.runs === 1 && saved.lessonImpactV2.with.tokensTotal === 1234 && saved.forensicLast === "2026-09-24");
  const back = loadState(yesterdayFile);
  check("round-trip: reloading on the branch keeps both records", JSON.stringify(back.lessonImpact) === JSON.stringify(v1Record) && back.lessonImpactV2?.with.runs === 1);
}

rmSync(dir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`LESSONS GOVERNANCE TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("lessons governance: all checks passed");
