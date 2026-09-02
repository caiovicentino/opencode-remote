import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { homedir } from "node:os";
import { agentStream, cachedExec, exec, runAgent, runAgentForRole, type AgentIds, type RerunResults } from "./runner";
import { nowLocalISO } from "./log";
import { markDone, mayPush, type Task } from "./backlog";
import { emit } from "./events";
import { latestUiShot } from "./shot";
import { defaultVerifiedMergesFile, recordVerifiedMerge } from "./deployguard";
import { touchHeartbeat, type PilotConfig, type PilotState } from "./state";
import { appendLessonsToWorkspace, pickRelevantLessons, readExperienceFile } from "./experience";
import { defaultLessonsFile, failureLessonsBlock, readRecentFailureLessons } from "./failureLessons";
import { captureGateCorpus, CORPUS_COMMANDS, CORPUS_DIR, loadGateCorpus } from "./gate-corpus";

export const CONSTITUTION = `CONSTITUTION (never violate):
1. E2E crypto stays E2E: the relay must remain a blind router; never log plaintext frames.
2. Auth surface only grows more strict: handshake allowlist, replay protection (seq in AAD) and the 0600 state file are untouchable.
3. scripts/invariants.ts and deploy/ are safety-critical: changes there need explicit justification in the commit message.
4. No secrets in the repo. No network listeners beyond the documented ports.
5. Every user-visible change is documented (README/AGENTS/docs) and covered by the eval battery.
6. Design bar: the product must look professionally designed, never AI-generated. Banned tells: generic purple/blue gradients, glassmorphism abuse, emoji as icons, inconsistent spacing/typography, rounded-everything, placeholder copy. Every UI change reads as intentional craft (reference bar: Linear, Raycast, Claude Desktop).
7. Product premise (P1-071): local = no auth ceremony; every flow must be reachable from first boot.`;

/** P1-007: injected into planner/builder/strategist prompts — top keyword-matched lessons. */
export function lessonsBlock(lessons: string[]): string {
  return lessons.length ? `\nEXPERIENCE — relevant lessons from past merges (follow them):\n${lessons.join("\n")}\n` : "";
}

// ── P2-008 spec-before-build: PLANNER phase for P0/P1 tasks ─────────────────

/** Planner agents are read-only code readers; 10 min like the scribe. */
export const PLANNER_TIMEOUT_MIN = 10;
export const PLANNER_MARKER = "PLANNER:DONE";
export const SPEC_SECTIONS = [
  "Problem",
  "Approach",
  "Touched files",
  "Edge cases",
  "Acceptance criteria",
  "Out of scope",
] as const;

/** P2-008: only high-priority tasks pay the planner tax before the builder. */
export function needsPlanner(priority: string): boolean {
  return priority === "P0" || priority === "P1";
}

/** P2-008: branch-relative spec path; null when the id can't reach a shell. */
export function specPathFor(id: string): string | null {
  if (!TASK_ID_RE.test(id)) return null;
  return `specs/${id}.md`;
}

export function plannerPrompt(t: Task, attempt: number, lessons: string[] = [], failureBlock = ""): string {
  const retry = attempt > 1
    ? `\nATTENTION: this is attempt ${attempt}. Your previous run did not leave a valid specs/${t.id}.md on disk — write the file this time.\n`
    : "";
  const milestones = t.size === "L"
    ? "\n- Long-horizon task (P1-060): this task is size L. The ## Approach must be a numbered list of milestones M1..Mn, each with its own acceptance criterion — the builder executes them in order, 1+ per round across several reviewed rounds.\n"
    : "";
  // P1-077 cache-aware assembly: the STABLE prefix (role, section template,
  // rules, CONSTITUTION) is byte-identical across tasks and requests so the
  // provider prefix-caches it; the VARIABLE tail (task, retry, milestones,
  // lessons, failure lessons) always comes last.
  return `You are the PLANNER agent of the opencode-remote autonomous pipeline (READ-ONLY).
The task at the end of this prompt is high priority; before any builder touches it, you must produce its build spec.

Read the relevant code in this repository and write the build spec to the file
specs/<TASK-ID>.md (create the specs/ directory if needed) with EXACTLY these markdown sections:
## Problem
## Approach
## Touched files
## Edge cases
## Acceptance criteria
## Out of scope

Rules:
- ${CONSTITUTION}
- READ-ONLY except for specs/<TASK-ID>.md: do NOT modify, create or delete any other file, do NOT commit.
- Keep the spec short and concrete (<= ~120 lines) — the builder is another agent that will follow it.
- Acceptance criteria must be testable: commands to run, observable behaviors, numbers when applicable.
- Touched files must cite real repo paths you actually inspected.

TASK (${t.id}) [${t.priority}]: ${t.title}
spec: ${t.spec || "(no extra spec — use judgement, keep the change small and shippable)"}
The spec file to write is specs/${t.id}.md on this branch.${retry}${milestones}${lessonsBlock(lessons)}${failureBlock}
When finished, your LAST line of output must be exactly: PLANNER:DONE`;
}

/**
 * P2-008: deterministic check — every required section heading is present.
 * The body is still LLM text (same trust level as a BACKLOG spec), so it is
 * bounded (size caps) and must not contain the pipeline's own control markers
 * (VERDICT:/...-DONE) which downstream output parsers trust.
 */
export function validateSpec(content: string): boolean {
  if (content.split("\n").length > 400 || content.length > 40_000) return false;
  if (/VERDICT:|PILOT:TASK-DONE|PLANNER:DONE|SCRIBE:DONE/i.test(content)) return false;
  const headings = content
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim().toLowerCase());
  return SPEC_SECTIONS.every((s) => headings.some((h) => h.startsWith(s.toLowerCase())));
}

/**
 * P2-009 (round 2): single predicate for "UI evidence required", shared by the
 * builder prompt and the gatekeeper so the builder is always asked for exactly
 * what the gate will demand. The diff half (renderTouched) is only known at
 * gate time — at prompt time the conditional wording covers it.
 */
export function needsUiEvidence(area: string | undefined, renderTouched: boolean): boolean {
  return renderTouched || area === "ui" || area === "desktop";
}

// ── P1-060 long-horizon tasks: size budgets, branch preservation, checkpoints ─

/** Effective per-run budgets for a task, keyed by its BACKLOG size tag. */
export interface TaskBudgets {
  rounds: number;
  timeoutMin: number;
  attempts: number;
}

/**
 * P1-060: pure budget table. S/M keep the classic budgets for any task;
 * size L (genuine long-horizon epics) scales them so the flash can chew on
 * big work: 6 rounds, 90min per builder round, 6 attempts before blocking.
 */
export function budgetsFor(size: Task["size"]): TaskBudgets {
  return size === "L"
    ? { rounds: 6, timeoutMin: 90, attempts: 6 }
    : { rounds: 3, timeoutMin: 45, attempts: 4 };
}

/** P1-060: pure circuit-breaker decision — attempts vs the task-size cap. */
export function isOverCap(attempts: number | undefined, size: Task["size"]): boolean {
  return (attempts ?? 0) >= budgetsFor(size).attempts;
}

/**
 * P1-060 (P1-036 prerequisite): pure decision for branch preservation across
 * attempts. The FIRST attempt starts clean (delete + recreate `pilot/<ID>`);
 * any later attempt continues the preserved branch so failed-attempt work
 * survives. A missing branch always falls back to the fresh path.
 */
export function preserveBranch(attempts: number | undefined, branchExists: boolean): boolean {
  return (attempts ?? 0) > 0 && branchExists;
}

/**
 * P1-036: branch setup at the start of EVERY attempt, extracted verbatim from
 * `runPipeline` for testability. Fetches origin, clears worktree dirt, then
 * keeps the `pilot/<ID>` branch when this is a retry (P1-060: attempts > 0 and
 * the branch exists) and recreates it at origin/main otherwise — deleting the
 * branch ONLY on the fresh path so preserved attempt work survives retries.
 * Precondition: `id` was already TASK_ID_RE-checked by the caller (it is
 * interpolated into shell commands here). Returns true when the workspace
 * resumed an existing preserved branch.
 */
export function setupTaskBranch(ws: string, id: string, attempts: number | undefined): boolean {
  const branch = `pilot/${id}`;
  exec("git fetch origin", { cwd: ws });
  exec("git reset -q --hard", { cwd: ws }); // clear dirt on whatever branch we are on
  exec("git clean -qfd", { cwd: ws });
  let resumed = false;
  if (preserveBranch(attempts, branchExists(ws, branch))) {
    resumed = exec(`git checkout -q ${branch}`, { cwd: ws, allowFail: true }).ok;
  }
  if (resumed) {
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "branch preserved from previous attempt", data: { task: id, attempt: (attempts ?? 0) + 1 } }));
  } else {
    exec(`git branch -qD ${branch} 2>/dev/null || true`, { cwd: ws, allowFail: true });
    exec(`git checkout -q -B ${branch} origin/main`, { cwd: ws });
    clearCheckpoint(id); // no stale range diff may resurrect deleted work
  }
  return resumed;
}

export interface RoundCheckpoint {
  task: string;
  /** Branch head sha at builder-round start (40-hex, validated on load). */
  sha: string;
  round: number;
  at: string;
}

/** Per-task round checkpoint file (path-safe: id is TASK_ID_RE-checked). */
function checkpointFile(taskId: string): string | null {
  if (!TASK_ID_RE.test(taskId)) return null;
  return join(homedir(), ".opencode-remote/pilot/checkpoints", `${taskId}.json`);
}

/** Record the branch head at builder-round start (best-effort by design). */
export function saveCheckpoint(taskId: string, sha: string, round: number): void {
  const f = checkpointFile(taskId);
  if (!f) return;
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ task: taskId, sha, round, at: nowLocalISO() } satisfies RoundCheckpoint, null, 2));
  } catch {}
}

/**
 * Load the last checkpoint for a task. The sha is re-validated against the
 * object-id charset before it may reach a shell `git diff` (the file lives
 * outside the repo, so treat it as untrusted input).
 */
export function loadCheckpoint(taskId: string): RoundCheckpoint | null {
  const f = checkpointFile(taskId);
  if (!f) return null;
  try {
    const c = JSON.parse(readFileSync(f, "utf8")) as RoundCheckpoint;
    if (typeof c?.sha !== "string" || !/^[0-9a-f]{7,40}$/.test(c.sha)) return null;
    return c;
  } catch {
    return null;
  }
}

function clearCheckpoint(taskId: string): void {
  const f = checkpointFile(taskId);
  if (!f) return;
  try {
    rmSync(f);
  } catch {}
}

// ── P2-013 cheap resumption: failed rounds carry resumable ids ──────────────

/** Cap so a noisy round cannot flood the next prompt with ids. */
export const RESUME_MAX_TASK_IDS = 10;

/**
 * P2-013 (round 2): pure state transition for the resume bookkeeping across
 * builder rounds. Only a round that actually failed (no PILOT:TASK-DONE in its
 * output) leaves resumable state — a successful round RESETS it, so a normal
 * review-fix round never gets a false "resume the crash" block. Failed rounds
 * merge their captured ids into the accumulated ones (dedupe, arrival order,
 * capped at the FIRST ${RESUME_MAX_TASK_IDS} so later garbage cannot evict
 * real ids captured earlier); the session id always tracks the latest round
 * (it is the one -s resumes).
 */
export function updateResumeState(prev: AgentIds | null, roundFailed: boolean, round: AgentIds): AgentIds | null {
  if (!roundFailed) return null;
  const taskIds = [...(prev?.taskIds ?? [])];
  for (const id of round.taskIds) {
    if (taskIds.length >= RESUME_MAX_TASK_IDS) break;
    if (!taskIds.includes(id)) taskIds.push(id);
  }
  return { sessionId: round.sessionId ?? prev?.sessionId, taskIds };
}

/**
 * P2-013 (round 2): pure decision for a builder round that finished without
 * the PILOT:TASK-DONE marker (crash or timeout). Retry within the existing
 * round budget or abort on the final round, exactly like the pre-spike
 * behavior. The failure notice itself lives in the resume block (prompt
 * hygiene round 3: findings stay reviewer-only).
 */
export function crashRoundDecision(round: number, maxRounds: number): { retry: boolean; detail: string } {
  if (round >= maxRounds) {
    return { retry: false, detail: `builder did not finish (round ${round})` };
  }
  return { retry: true, detail: "" };
}

/**
 * P2-013: prompt section injected into round N+1 after a failed round N — the
 * caller only passes non-null resume state (`updateResumeState`) when the
 * previous round actually failed. opencode >=1.18.20 surfaces failed subagent
 * tool calls with a resumable task_id — handing the ids back lets the builder
 * inspect and resume partial work instead of paying for a cold restart.
 * `failedRound` (the caller's round - 1) names the crashed round; omit it for
 * the generic wording. Empty string when there is nothing resumable (round 1
 * or no ids captured).
 */
export function resumeBlock(resume: AgentIds | null | undefined, failedRound?: number): string {
  const tasks = [...new Set(resume?.taskIds ?? [])].slice(0, RESUME_MAX_TASK_IDS);
  if (!resume?.sessionId && tasks.length === 0) return "";
  const lines = [
    failedRound !== undefined
      ? `RESUME PARTIAL WORK (P2-013): round ${failedRound} failed mid-work (crash or timeout) and left recoverable state.`
      : "RESUME PARTIAL WORK (P2-013): the previous round on this task failed mid-work and left recoverable state.",
  ];
  if (resume?.sessionId) {
    lines.push(`- Previous builder session: ${resume.sessionId} (this round continues it via -s — its context is intact).`);
  }
  if (tasks.length) {
    lines.push(
      `- Resumable subagent task ids surfaced by opencode >=1.18.20: ${tasks.join(", ")} — inspect these failed tasks and recover whatever partial work they hold.`,
    );
  }
  lines.push("- Inspect the partial work already on this branch and CONTINUE from it — do not restart from scratch.");
  return `\n${lines.join("\n")}\n`;
}

export function builderPrompt(
  t: Task,
  round: number,
  findings: string,
  lessons: string[] = [],
  specFile: string | null = null,
  resume: AgentIds | null = null,
  attempt = 1,
): string {
  const uiTask = needsUiEvidence(t.area, false);
  // P2-008: when a planner spec exists on the branch, the builder must follow it
  const specBlock = specFile
    ? `\nPLANNER SPEC: ${specFile} exists on this branch — read it FIRST. It holds the agreed problem analysis, approach, touched files, edge cases, acceptance criteria and out-of-scope. Follow it; if you must deviate, justify the deviation in the commit message. Do not delete or rewrite the spec.\n`
    : "";
  // P1-060: long-horizon tasks — the spec carries ordered milestones and the
  // branch survives across attempts, so rounds build on prior work
  const longBlock = t.size === "L"
    ? `\nLONG-HORIZON TASK (P1-060): this task is size L and its spec's ## Approach is structured as numbered milestones (M1..Mn). Execute milestones IN ORDER, one or more per round, and keep the branch green at the end of every round (typecheck + build + unit). You have a larger round/timeout budget than a size-S task — use it to finish milestones, not to gold-plate.\n`
    : "";
  const attemptBlock = attempt > 1
    ? `\nATTEMPT ${attempt} (P1-060): the branch pilot/${t.id} already exists with committed work from previous attempts and was PRESERVED for you. Continue from the existing history (git log, \`git diff main...pilot/${t.id}\`) — do NOT restart from scratch and do NOT undo already-committed work.\n`
    : "";
  const roundBlock = round > 1
    ? `\nRounds 1..${round - 1} already committed work on this branch. Inspect it first with \`git diff main...pilot/${t.id}\` and fix the findings INCREMENTALLY — do not restart from scratch or re-read files you already understand.`
    : "";
  const uiBullet = uiTask
    ? `\n- UI self-driving (P2-011): this task changes the UI. Validate your own output visually before finishing: build the app, then use the host browser CLI — \`node tools/browse.mjs open <url> ~/.opencode-remote/pilot/shots/builder/${t.id}-r${round}.png\` — and inspect the PNG. Produce TWO sized screenshots with the browse CLI — \`node tools/browse.mjs shot <path>.png 1440 900\` (desktop) and \`node tools/browse.mjs shot <path>.png 390 844\` (phone), positional width/height — and cite both paths in the EVIDENCE block below; PNG dimensions are verified at the gate (1440x900 exactly, 2x Retina accepted; width 390). This is YOUR pre-merge self-check; post-deploy evidence is captured separately by the pipeline.`
    : "";
  // P1-077 cache-aware assembly: the STABLE prefix (role, rules, CONSTITUTION,
  // EVIDENCE contract — generic <TASK-ID> placeholder, no round) is
  // byte-identical across tasks and rounds within the uiTask variant so the
  // provider prefix-caches it; the VARIABLE tail (task text, round, spec/
  // attempt/resume blocks, findings, lessons, UI bullet) always comes after
  // the last stable line.
  return `You are the BUILDER agent of the opencode-remote autonomous pipeline.
Work inside this repository (your cwd is a dedicated clone; production runs elsewhere).

Rules:
- ${CONSTITUTION}
- Create/keep working on branch pilot/<TASK-ID>. Commit your work with a conventional message "pilot(<TASK-ID>): ...".
- Run "npm run typecheck" and "npm run build" and fix any errors before committing.
- Document user-visible changes in the relevant docs (README.md / AGENTS.md / docs/).
- Do NOT push, do NOT touch production services, do NOT modify BACKLOG.md.
- Keep the diff focused: one task, no drive-by refactors.

MANDATORY EVIDENCE (P2-009): when finished, end your output with exactly this EVIDENCE
block — the deterministic gatekeeper parses it, re-executes every cited command and
REJECTS the merge when the block is missing or the real output diverges from what you
pasted. Only real output you produced this round; only "npm run typecheck --silent",
"npm run test:unit --silent" and "npm run build --silent" may be cited. Paste the FINAL
lines of each output verbatim (the tail is what the gate compares) — NEVER summarize
with "..." or add annotations like "(exit 0)": any line that the re-run does not print
is treated as fabrication and rejects the merge. The gate also
requires both screenshot lines whenever your diff touches apps/web/ or apps/desktop/ —
even when this task is not tagged ui/desktop — so take them fresh this round and cite
the fresh files:

EVIDENCE:
$ npm run typecheck --silent
<paste the real command output here>
$ npm run test:unit --silent
<paste the real command output here>${
    uiTask
      ? `\nshot-1440x900: <absolute path of a real 1440x900 PNG screenshot>\nshot-390: <absolute path of a real 390px-wide PNG screenshot>`
      : `\n(if this round's diff touches apps/web/ or apps/desktop/, also cite:\nshot-1440x900: <absolute path of a real 1440x900 PNG screenshot>\nshot-390: <absolute path of a real 390px-wide PNG screenshot>)`
  }

TASK (${t.id}) [${t.priority}]: ${t.title}
spec: ${t.spec || "(no extra spec — use judgement, keep the change small and shippable)"}
This is builder round ${round} of this task.${specBlock}${longBlock}${attemptBlock}${resumeBlock(resume, round - 1)}${findings ? `\nREVIEWER FINDINGS TO ADDRESS:\n${findings}\n` : ""}${lessonsBlock(lessons)}${roundBlock}${uiBullet}

Your LAST line of output must be exactly: PILOT:TASK-DONE`;
}

/**
 * P1-007 SCRIBE role: distill ≤3 reusable lessons from a just-merged diff.
 * The agent only OUTPUTS lesson lines — the runner validates, dedupes, appends
 * to docs/EXPERIENCE.md and commits, so an LLM never edits the file directly.
 */
export function scribePrompt(t: Task, diff: string, findings: string): string {
  // P1-077 cache-aware assembly: stable role + rules + LESSONS contract first
  // (the format line uses a generic <TASK-ID> placeholder), variable task/
  // findings tail and the DIFF last.
  return `You are the SCRIBE agent of the opencode-remote autonomous pipeline.
The task at the end of this prompt was just merged after passing adversarial reviews and the deterministic gatekeeper.
Your job: distill reusable engineering lessons for future agents.

Rules:
- Read the diff below (and the repo if needed). Do NOT modify any files.
- Output 1 to 3 lessons: concrete, generalizable rules a future agent must
  follow when touching similar code (gotchas, root causes, invariants). Skip the obvious.
- One lesson per line, EXACTLY this format (plain text, no markdown headings or code blocks):
  - When <situation>, do <action> (fonte: <TASK-ID>)

Your LAST lines must be exactly:
LESSONS:
<lesson lines>
SCRIBE:DONE

TASK (${t.id}) [${t.priority}]: ${t.title}
spec: ${t.spec || "(none)"}
${findings ? `\nREVIEWER FINDINGS (already addressed by the merge):\n${findings}\n` : ""}
DIFF:
\`\`\`diff
${diff.slice(0, 30_000)}
\`\``;
}

/** Parse the lesson lines between the LESSONS: marker and SCRIBE:DONE (max 3). */
export function parseScribeLessons(output: string): string[] {
  const idx = output.lastIndexOf("LESSONS:");
  if (idx < 0 || !/SCRIBE:DONE/.test(output.slice(idx))) return [];
  const tail = output.slice(idx + "LESSONS:".length);
  const body = tail.split("SCRIBE:DONE")[0] ?? "";
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^- \S/.test(l))
    .slice(0, 3);
}

/**
 * Append lessons to the workspace EXPERIENCE.md and push to main. Retries the
 * whole append+commit+push cycle: concurrent slots' scribes can move main
 * between the reset and the push, so a non-fast-forward is expected and cheap
 * to redo (the append is recomputed from the freshly fetched file each time).
 */
function commitLessons(ws: string, id: string, lessons: string[]): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    exec("git fetch -q origin", { cwd: ws, allowFail: true });
    exec("git checkout -q main", { cwd: ws, allowFail: true });
    exec("git reset -q --hard origin/main", { cwd: ws, allowFail: true });
    exec("git clean -qfd", { cwd: ws, allowFail: true });
    const added = appendLessonsToWorkspace(ws, lessons, id);
    if (!added) return true; // all deduped away — nothing to commit
    const commit = exec(`git add docs/EXPERIENCE.md && git commit -qm "pilot(scribe): ${added} lesson(s) from ${id}"`, {
      cwd: ws,
      allowFail: true,
    });
    if (!commit.ok) return false; // e.g. index.lock churn — give up, next merge tries again
    // P1-057 push guard: the scribe may only ever push docs/EXPERIENCE.md —
    // re-read from the real branch diff on every retry attempt.
    const names = exec("git diff --name-only origin/main...HEAD", { cwd: ws, allowFail: true });
    if (!mayPush(names.output, "docs/EXPERIENCE.md")) {
      logScribe(id, "aux push refused — diff not limited to docs/EXPERIENCE.md", false);
      return false;
    }
    if (exec("git push -q origin main", { cwd: ws, allowFail: true }).ok) return true;
  }
  return false;
}

async function runScribe(
  ws: string,
  t: Task,
  diff: string,
  findings: string,
  trackSession?: (id: string | undefined) => string | undefined,
): Promise<void> {
  emit("phase", { task: t.id, phase: "scribe" });
  // P1-057: the scribe ingests the merged diff — run it read-only; the lessons
  // come back as TEXT and the runner validates + commits them. The next
  // pipeline start rewrites the full sandbox config (writeSandboxConfig).
  writeAuxSandboxConfig(ws);
  const out = await runAgent(scribePrompt(t, diff, findings), {
    cwd: ws,
    timeoutMin: 10,
    label: `scribe-${t.id}`,
    onStdout: agentStream("scribe"),
  });
  trackSession?.(out.sessionId);
  if (!out.output.includes("SCRIBE:DONE")) {
    logScribe(t.id, "scribe did not finish — lessons skipped");
    return;
  }
  const lessons = parseScribeLessons(out.output);
  if (!lessons.length) {
    logScribe(t.id, "no parsable lessons — nothing recorded");
    return;
  }
  const ok = commitLessons(ws, t.id, lessons);
  logScribe(t.id, `committed ${lessons.length} lesson(s) to docs/EXPERIENCE.md`, ok);
  emit("phase", { task: t.id, phase: "scribe-done", ok, detail: `${lessons.length} lesson(s)` });
}

function logScribe(task: string, msg: string, ok?: boolean) {
  console.log(
    JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "scribe", data: { task, msg, ok } }),
  );
}

export function reviewerPrompt(
  role: string,
  focus: string,
  t: Task,
  diff: string,
  uiShot: string | null,
  specFile: string | null = null,
  incrementalFrom: string | null = null,
): string {
  const incrementalNote = incrementalFrom
    ? `- INCREMENTAL REVIEW (P1-060): this is a later round of a long-horizon task. Earlier
  rounds were already reviewed and accepted; judge ONLY the incremental diff below
  (commits since ${incrementalFrom}), not the whole branch history.`
    : "";
  const specNote =
    (role === "QUALITY" || role === "ESCALATION") && specFile
      ? `\n- Spec compliance (P2-008): this branch carries a planner spec at "${specFile}" (read it in the workspace). Answer explicitly in your review: does the diff fulfill ${specFile}? A deviation from its approach, touched-files list or acceptance criteria is a finding unless the diff justifies it.`
      : "";
  const uiShotNote = uiShot
    ? `\n- UI evidence (P2-011): the most recent available screenshot for this task is "${uiShot}". It may predate this diff (captured after an earlier deploy) — treat it as a regression baseline, not proof of this diff. Read it (it is an image), say what it shows, and state explicitly whether the diff could plausibly regress it. You can take a fresh screenshot of your local build: \`node tools/browse.mjs shot <path>.png\`.`
    : "";
  // P1-077 cache-aware assembly: stable role line, rules, CONSTITUTION and the
  // verdict contract first (byte-identical across tasks within a role); the
  // variable tail (task, focus, conditional notes) and the DIFF come last.
  return `You are the ${role} REVIEWER agent of the opencode-remote autonomous pipeline.
A builder implemented the task described at the end of this prompt.

Rules:
- ${CONSTITUTION}
- Product premise (P1-071): if the diff presupposes a user flow (auth, onboarding,
  connection), question the premise, not just the implementation.
- Judge only this diff against the task and the constitution. Do not rewrite the code.
- Be strict but concrete: every finding must reference a file and a problem.
- Cite or it didn't happen (P2-015): every finding bullet must cite a repo-relative
  \`path/file.ext:LINE\` (line matching the workspace files) or quote a literal snippet
  from the diff. Findings without a verifiable citation are mechanically dropped as
  hallucinated; a reviewer whose findings ALL fail verification counts as APPROVE.
- P2-038: the verdict is the LAST \`VERDICT:\` marker in your output, and an APPROVE
  followed by verified findings is processed as a rejection — if you have findings,
  verdict REQUEST_CHANGES; APPROVE only with an empty findings list.

Your LAST lines must be exactly one of:
VERDICT: APPROVE
or
VERDICT: REQUEST_CHANGES
followed by a bullet list of findings.

TASK (${t.id}) [${t.priority}]: ${t.title}
spec: ${t.spec || "(none)"}

Review the following diff with this focus: ${focus}
${incrementalNote}${specNote}${uiShotNote}

DIFF:
\`\`\`diff
${diff.slice(0, 60_000)}
\`\`\``;
}

/** P1-059: a tier-B escalation reviewer's output must carry a verdict marker. */
export const ESCALATION_MARKER = "VERDICT:";

export type ReviewerVerdict = "APPROVE" | "REQUEST_CHANGES";

/**
 * P2-038: the verdict is the LAST `VERDICT:` marker in the output. Reviewers
 * discuss example verdicts in prose; an APPROVE quoted early must not mask a
 * REQUEST_CHANGES written after it (or vice versa). `null` when no marker —
 * a malformed output can never approve anything.
 */
export function parseVerdict(output: string): ReviewerVerdict | null {
  const matches = [...output.matchAll(/VERDICT:\s*(APPROVE|REQUEST_CHANGES)/gi)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return last[1]!.toUpperCase() === "APPROVE" ? "APPROVE" : "REQUEST_CHANGES";
}

/**
 * P2-038: one reviewer's verdict outcome. The LAST marker decides
 * (`parseVerdict`); an APPROVE that carries verified findings is a rejection —
 * findings that verify are evidence, not noise. A REQUEST_CHANGES whose
 * findings ALL fail verification degenerates to an effective approve, and an
 * output without any marker fails closed.
 */
export function reviewerOk(output: string, kept: string[], dropped: string[]): boolean {
  const verdict = parseVerdict(output);
  if (verdict === "APPROVE") return kept.length === 0;
  return verdict === "REQUEST_CHANGES" && dropped.length > 0 && kept.length === 0;
}

/**
 * P1-059: pure escalation predicate — round-1 review outcomes that are
 * ambiguous enough to deserve a stronger-model arbitration: divergent verdicts
 * (one approve, one request-changes) or a reviewer whose findings all failed
 * verification (allDropped ⇒ "effective approve" is unproven). Round > 1
 * already carries the previous round's findings into the builder — no
 * escalation. Both-approve (nothing suspicious) → false.
 */
export function needsEscalation(
  round: number,
  secOk: boolean,
  qualOk: boolean,
  secAllDropped: boolean,
  qualAllDropped: boolean,
): boolean {
  if (round !== 1) return false;
  return secOk !== qualOk || secAllDropped || qualAllDropped;
}

export interface PipelineResult {
  ok: boolean;
  detail: string;
  sha?: string;
  /** P2-011: true when the merged diff touched the UI (apps/web | apps/desktop)
   * — triggers a post-deploy screenshot for the review log. */
  touchedUi?: boolean;
}

/** Task IDs come from BACKLOG.md; only this charset ever reaches a shell command. */
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * P2-011: does this diff (from `git diff --name-only`) touch the UI surfaces?
 * Pure function so the eval battery can pin the acceptance criterion: a
 * UI-changing cycle must produce a post-deploy screenshot.
 */
export function touchedUiFromDiff(nameOnly: string): boolean {
  return nameOnly
    .split("\n")
    .some((l) => l.trim().startsWith("apps/web/") || l.trim().startsWith("apps/desktop/"));
}

/**
 * P1-044 autocatalysis lane: does this diff touch the pilot's own code?
 * Tasks that edit the brain that edits the code (apps/pilot/**) get the
 * reinforced gate (golden corpus) and the reinforced deploy (doubled soak,
 * extra live invariants, failure-rate rollback). Pure like touchedUiFromDiff.
 */
export function touchedPilotInfraFromDiff(nameOnly: string): boolean {
  return nameOnly
    .split("\n")
    .some((l) => l.trim().startsWith("apps/pilot/"));
}

/** P1-044 (a): the corpus must hold at least this many samples per command to
 * count as green — mirrors the P3-033 acceptance criterion (>=3 per command). */
export const MIN_CORPUS_SAMPLES = 3;

/**
 * P1-044 (a): deterministic golden-corpus gate for self-modifying changes.
 * The pilot editing itself is exactly when the gate's own calibration
 * (evidence matcher + corpus, P3-033) could silently regress, so the gate
 * re- verifies the corpus is present and still green: >= MIN_CORPUS_SAMPLES
 * samples per evidence command, every real sample matches itself and its
 * truncated form, and a fabricated line over a real sample is still rejected.
 * `matches` is injectable so the eval battery can drive the tamper branches
 * (permissive/rejecting matcher regressions) without fixtures that could never
 * occur naturally. Returns null when green, else the reason.
 */
export function corpusGateDetail(
  dir = CORPUS_DIR,
  matches: (pasted: string, actual: string) => boolean = evidenceMatches,
): string | null {
  const corpus = loadGateCorpus(dir);
  for (const cmd of CORPUS_COMMANDS) {
    const samples = corpus.filter((s) => s.cmd === cmd);
    if (samples.length < MIN_CORPUS_SAMPLES) {
      return `golden corpus too thin for ${cmd}: ${samples.length}/${MIN_CORPUS_SAMPLES} samples`;
    }
    for (const s of samples) {
      if (!matches(s.output, s.output)) return `corpus sample no longer matches itself: ${s.file}`;
      const truncated = s.output.split("\n").slice(0, Math.ceil(s.output.split("\n").length / 2)).join("\n");
      if (!matches(truncated, s.output)) return `corpus sample no longer matches truncated: ${s.file}`;
      // prepended: appended lines beyond the 600-line paste cap are sliced away
      if (matches(`FABRICATED-CORPUS-PROBE-LINE\n${s.output}`, s.output)) {
        return `corpus sample accepts a fabricated line: ${s.file}`;
      }
    }
  }
  return null;
}

/**
 * P2-008: non-empty `git diff --name-only` lines minus the planner spec path.
 * The spec commit is pipeline bookkeeping — deciding whether the BUILDER
 * produced changes (empty-diff self-heal) must look at code changes only.
 * Pure so the eval battery can pin the exclusion.
 */
export function codeChanges(nameOnly: string, specFile: string | null): string[] {
  return nameOnly
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== specFile);
}

/**
 * P1-006: per-task gatekeeper failure file (path-safe: id is TASK_ID_RE-checked).
 * Concurrent slots must not overwrite each other's carryover findings.
 */
function gateFailFile(taskId: string): string | null {
  if (!TASK_ID_RE.test(taskId)) return null;
  return join(homedir(), ".opencode-remote/pilot/gate-fail", `${taskId}.json`);
}

/**
 * P1-006: the gate battery (reconnect/integration) binds fixed eval ports and
 * the merge pushes to main — run the whole gatekeeper exclusively across
 * concurrent slots. Builders/reviewers stay parallel; only the gate queues.
 */
let gateLock: Promise<void> = Promise.resolve();
function runGateExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const prev = gateLock;
  let release!: () => void;
  gateLock = new Promise<void>((r) => (release = r));
  return prev.then(fn).finally(release);
}

/** Sandbox permissions: agents in the clone get full tool access. Must exist for
 * EVERY headless run (builder, reviewers, strategist) or opencode aborts on the
 * first permission-requiring action — `git clean` removes it after each sync. */
export function writeSandboxConfig(ws: string) {
  writeFileSync(
    join(ws, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        permission: { edit: "allow", bash: "allow", external_directory: "allow", webfetch: "allow" },
      },
      null,
      2,
    ),
  );
}

/**
 * P1-057: sandbox for aux agents that ingest untrusted external content
 * (researcher via webfetch, strategist, redteam, scribe). Shell, edits and
 * external dirs are denied — a prompt-injected page cannot execute commands on
 * the host. The agents only produce TEXT, which the runner validates
 * (parseAuxTaskLines/parseScribeLessons) and commits deterministically under a
 * push guard (mayPush). webfetch stays allowed: injection dies at bash:"deny".
 */
export function writeAuxSandboxConfig(ws: string) {
  writeFileSync(
    join(ws, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        permission: { edit: "deny", bash: "deny", external_directory: "deny", webfetch: "allow" },
      },
      null,
      2,
    ),
  );
}

/**
 * P2-008: deterministically validate and commit the planner spec. The planner
 * agent only leaves the file on disk — the runner owns the commit (id is
 * TASK_ID_RE-checked, so the interpolation is safe). "Commit ONLY the spec" is
 * enforced here, not just prompted: the branch is rewound to origin/main and
 * replayed as exactly one commit touching specs/<ID>.md, so anything else the
 * read-only planner created or modified (tracked, untracked or committed) is
 * gone before the builder ever runs.
 */
export function commitSpec(ws: string, id: string): boolean {
  const path = specPathFor(id);
  if (!path) return false;
  const abs = join(ws, path);
  if (!existsSync(abs)) return false;
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return false;
  }
  if (!validateSpec(content)) return false;
  // rewind branch AND worktree to origin/main; keep the specs/ dir (validated
  // content is rewritten from memory) and the agent sandbox config
  exec("git reset -q --hard origin/main", { cwd: ws, allowFail: true });
  exec(`git clean -qfd -e specs -e opencode.json`, { cwd: ws, allowFail: true });
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  } catch {
    return false;
  }
  exec(`git add ${path}`, { cwd: ws, allowFail: true });
  exec(`git commit -qm "pilot(${id}): planner spec"`, { cwd: ws, allowFail: true });
  // airtight: the branch diff must be exactly the spec file, nothing else
  const names = exec("git diff --name-only origin/main...HEAD", { cwd: ws, allowFail: true });
  return names.ok && names.output.trim() === path;
}

/** P1-060: true when a local branch ref exists in the workspace. */
function branchExists(ws: string, branch: string): boolean {
  return exec(`git rev-parse -q --verify refs/heads/${branch}`, { cwd: ws, allowFail: true }).ok;
}

/** P1-060: the planner spec already sits valid on the (preserved) branch. */
function specOnDisk(ws: string, path: string): boolean {
  try {
    return validateSpec(readFileSync(join(ws, path), "utf8"));
  } catch {
    return false;
  }
}

/**
 * P1-060 (round-2 review): recover the planner spec from the preserved
 * branch's history when the worktree copy is missing or tampered — walks the
 * commits touching the spec path (newest first) and returns the first blob
 * that validates. `path` is always specs/<ID>.md (id TASK_ID_RE-checked) and
 * shas are re-validated against the object-id charset before interpolation.
 * Null when no commit carries a valid spec.
 */
export function recoverSpecFromBranch(ws: string, id: string, path: string): string | null {
  const log = exec(`git log -q --format=%H -n 10 -- ${path}`, { cwd: ws, allowFail: true });
  if (!log.ok) return null;
  for (const sha of log.output.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
    const blob = exec(`git show ${sha}:${path}`, { cwd: ws, allowFail: true });
    if (blob.ok && validateSpec(blob.output)) return blob.output;
  }
  return null;
}

/** P1-060: true when the task branch carries commits beyond origin/main. */
export function branchHasCommits(ws: string, branch: string): boolean {
  const r = exec(`git log -q --oneline origin/main..${branch}`, { cwd: ws, allowFail: true });
  return r.ok && r.output.trim().length > 0;
}

// ── P2-009 mandatory builder evidence ────────────────────────────────────────

export const EVIDENCE_MARKER = "EVIDENCE:";
export const TASK_DONE_MARKER = "PILOT:TASK-DONE";

/** The only commands a builder may cite as evidence — the gatekeeper re-executes
 * them verbatim in the workspace, so this allowlist doubles as the injection
 * guard between LLM output and the pipeline's shell. */
export const EVIDENCE_COMMANDS: readonly string[] = [
  "npm run typecheck --silent",
  "npm run test:unit --silent",
  "npm run build --silent",
];

/** Every task must prove typecheck + unit; build is covered by the gate battery. */
export const EVIDENCE_REQUIRED: readonly string[] = [
  "npm run typecheck --silent",
  "npm run test:unit --silent",
];

export interface EvidenceCommand {
  cmd: string;
  output: string;
}

export interface EvidenceBlock {
  commands: EvidenceCommand[];
  shots: Record<string, string>;
}

/**
 * Parse the builder's final EVIDENCE block: `$ <cmd>` lines introduce a command,
 * following lines are its pasted output, and `shot-<label>: <path>` lines cite
 * screenshot files. Only the LAST marker counts (prose earlier in the output
 * may quote it); the block ends at the task-done marker when present. Returns
 * null when the block is missing or pathologically padded.
 *
 * Round 2: only ALLOWLISTED `$ ` lines open a command entry — a prompt-looking
 * line inside a real command's pasted output (or a transcript echo like
 * `$ npm run typecheck` without --silent) must not become a spurious command
 * and reject an honest block. Non-allowlisted `$ ` lines are dropped entirely:
 * never executed, never counted as output (the allowlist in verifyEvidence
 * stays as a defensive second layer).
 */
export function parseEvidenceBlock(output: string): EvidenceBlock | null {
  const lines = output.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trim() === EVIDENCE_MARKER) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.trim() === TASK_DONE_MARKER) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  // headroom pinned by the eval battery: the unit battery alone prints ~300
  // lines today and keeps growing — 600 keeps honest full pastes parseable
  if (body.length > 600) return null;
  const block: EvidenceBlock = { commands: [], shots: {} };
  let current: EvidenceCommand | null = null;
  for (const line of body) {
    const t = line.trim();
    if (t.startsWith("$ ")) {
      const cmd = t.slice(2).trim();
      if (!EVIDENCE_COMMANDS.includes(cmd)) continue;
      current = { cmd, output: "" };
      block.commands.push(current);
      continue;
    }
    const shot = t.match(/^(shot-[0-9a-z]+):\s*(\S+)\s*$/i);
    if (shot) {
      block.shots[shot[1]!.toLowerCase()] = shot[2]!;
      continue;
    }
    if (current && t) current.output += (current.output ? "\n" : "") + t;
  }
  return block;
}

/** Whitespace/ANSI-insensitive line normalization for evidence comparison.
 * Also neutralizes tokens that legitimately differ between two SUCCESSFUL runs:
 * content-hashed asset names (index-BUzAmikJ.css), durations (694ms, duration_ms 12),
 * file sizes (0.65 kB), clock stamps, ISO-8601 timestamps (with or without
 * date/millis/offset — two green runs never share them), run-variant process
 * counters (pid, uptimeS, activeConnections) and mkdtemp-style random directory
 * suffixes (ocr-winstate-w9xFX1/). The golden corpus
 * (apps/pilot/src/__fixtures__/gate-corpus/, P3-033) pins all of this against
 * real captured gate outputs; a fabricated line has no source in the re-run
 * either way, so the anti-fabrication property is preserved. */
export function normalizeEvidenceLine(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "STAMP")
    .replace(/-[A-Za-z0-9_-]{8,}\.(css|js|mjs|cjs|map)\b/g, ".HASH")
    .replace(/-[A-Za-z0-9_.-]{6,}\//g, "-HASH/")
    .replace(/("(?:pid|uptimeS|activeConnections)"\s*:\s*)\d+/g, "$1N")
    .replace(/\b\d+(\.\d+)?\s?(kB|MB|GB)\b/g, "SIZE")
    .replace(/\b\d+(\.\d+)?(ms|min|h|s)\b/g, "TIME")
    .replace(/\b\d{2}:\d{2}(:\d{2})?\b/g, "TIME")
    .replace(/(duration_ms|duration_total_ms)\s+\d+/g, "$1 T")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Containment check: every non-empty pasted line must appear (normalized) in
 * the real re-run output. Subset semantics tolerate truncated pastes; a single
 * fabricated line — the thing this gate exists to catch — has no source in the
 * re-run and fails the merge.
 * Round 3: an empty paste is only honest when the re-run itself printed nothing
 * (e.g. silent tsc success) — citing a verbose command and pasting nothing must
 * not pass on re-execution alone ("outputs reais colados").
 */
export function evidenceMatches(pasted: string, actual: string): boolean {
  // Truncation markers and exit-code annotations are builder summaries, not
  // output — skipping them keeps an honest-but-lazy paste from failing while
  // real fabrication (any line with a source-free claim) still rejects.
  const skip = (l: string) => l === "..." || l === "…" || /^\(exit \d+\)$/.test(l);
  const actualLines = new Set(actual.split("\n").map(normalizeEvidenceLine).filter(Boolean));
  const pastedLines = pasted
    .split("\n")
    .map(normalizeEvidenceLine)
    .filter(Boolean)
    .filter((l) => !skip(l))
    .slice(0, 600);
  if (pastedLines.length === 0) return actualLines.size === 0;
  return pastedLines.every((l) => actualLines.has(l));
}

/** PNG IHDR dimensions (first 24 bytes) or null when not a readable PNG. */
export function pngSize(path: string): { w: number; h: number } | null {
  try {
    const buf = readFileSync(path);
    if (buf.length < 24) return null;
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buf.subarray(0, 8).equals(magic)) return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return w > 0 && h > 0 ? { w, h } : null;
  } catch {
    return null;
  }
}

/** Accepted dimensions per shot key: 1x and 2x (Retina `screencapture`). */
export function evidenceShotDimsOk(key: string, size: { w: number; h: number }): boolean {
  if (key === "shot-1440x900") return (size.w === 1440 && size.h === 900) || (size.w === 2880 && size.h === 1800);
  if (key === "shot-390") return size.w === 390 || size.w === 780;
  return false;
}

export interface EvidenceResult {
  ok: boolean;
  detail: string;
}

/**
 * P2-009 deterministic gate step: parse the builder's EVIDENCE block, then
 * re-execute every cited command in the workspace and require the pasted
 * output to be reproducible. Static checks (block present, commands allowlisted,
 * required commands cited, screenshot paths/dimensions/freshness) run BEFORE
 * any re-execution so hostile or malformed blocks fail fast without touching
 * npm.
 *
 * Round 2: screenshots must be fresh — `minShotMtimeMs` (the pipeline start)
 * bounds their mtime, so a stale PNG from an earlier task/round cannot pass
 * as this round's UI evidence. `run` is injectable for the eval battery; the
 * gatekeeper injects a caching runner so re-executed commands double as the
 * gate battery's typecheck/build/unit results (no double execution while
 * holding the cross-slot gate lock).
 */
export function verifyEvidence(
  ws: string,
  builderOutput: string,
  requireShots: boolean,
  minShotMtimeMs = 0,
  run?: (cmd: string, cwd: string) => { ok: boolean; output: string },
): EvidenceResult {
  const runCmd =
    run ?? ((cmd: string, cwd: string) => exec(cmd, { cwd, timeoutMin: 20, allowFail: true }));
  const block = parseEvidenceBlock(builderOutput);
  if (!block) return { ok: false, detail: "no EVIDENCE block in builder output" };
  for (const c of block.commands) {
    if (!EVIDENCE_COMMANDS.includes(c.cmd)) {
      return { ok: false, detail: `evidence cites non-allowlisted command: ${c.cmd}` };
    }
  }
  const cited = new Set(block.commands.map((c) => c.cmd));
  for (const req of EVIDENCE_REQUIRED) {
    if (!cited.has(req)) return { ok: false, detail: `evidence missing required command: ${req}` };
  }
  if (requireShots) {
    for (const key of ["shot-1440x900", "shot-390"]) {
      const p = block.shots[key];
      if (!p) return { ok: false, detail: `UI task without ${key} path in the EVIDENCE block` };
      const abs = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
      const size = pngSize(abs);
      if (!size) return { ok: false, detail: `${key}: not a readable PNG: ${p}` };
      if (!evidenceShotDimsOk(key, size)) {
        return { ok: false, detail: `${key}: wrong PNG dimensions ${size.w}x${size.h}: ${p}` };
      }
      if (minShotMtimeMs > 0) {
        let mtime = 0;
        try {
          mtime = statSync(abs).mtimeMs;
        } catch {}
        if (mtime < minShotMtimeMs) {
          return { ok: false, detail: `${key}: stale screenshot (predates this round): ${p}` };
        }
      }
    }
  }
  for (const c of block.commands) {
    const rerun = runCmd(c.cmd, ws);
    if (!rerun.ok) return { ok: false, detail: `cited command failed on re-run: ${c.cmd}` };
    // A silent successful re-run (e.g. `tsc --silent`) prints nothing, so there
    // is no text to contain the paste — the re-execution itself is the proof.
    // Fabrication is still caught: a failing command exits non-zero above.
    const rerunEmpty = !rerun.output.split("\n").some((l) => normalizeEvidenceLine(l));
    if (rerunEmpty) continue;
    if (!evidenceMatches(c.output, rerun.output)) {
      const emptyPaste = !c.output.split("\n").some((l) => normalizeEvidenceLine(l));
      return {
        ok: false,
        detail: emptyPaste
          ? `no output pasted for: ${c.cmd} (the re-run produced output)`
          : `pasted output diverges from re-run of: ${c.cmd}\nre-run tail:\n${rerun.output.slice(-400)}`,
      };
    }
  }
  return { ok: true, detail: `${block.commands.length} command(s) re-executed` };
}

export async function runPipeline(cfg: PilotConfig, t: Task, state: PilotState, sessions?: Set<string>): Promise<PipelineResult> {
  const ws = cfg.workspace;
  // central injection guard: t.id is interpolated into shell commands below
  if (!TASK_ID_RE.test(t.id)) return { ok: false, detail: `invalid task id: ${t.id}` };
  // P2-028: every opencode session this task spawns lands here (planner,
  // builder rounds, reviewers, escalation, scribe) — the caller reconciles
  // their token totals from opencode.db into state.taskCosts after the run.
  const trackSession = (id: string | undefined) => {
    if (id && sessions) sessions.add(id);
    return id;
  };
  const branch = `pilot/${t.id}`;
  // P2-009: pipeline (branch) start — cited UI evidence must be newer than this
  const startedAtMs = Date.now();
  // P1-060/P1-036: first attempt starts clean at origin/main; later attempts
  // keep the branch so the previous attempt's committed work survives — the
  // builder continues it instead of restarting from scratch.
  const attemptNo = state.taskAttempts[t.id] ?? 0;
  const resumed = setupTaskBranch(ws, t.id, attemptNo);

  // sandbox permissions: agents in the clone get full tool access (the real
  // security boundary is the gatekeeper + invariants + staged deploy, not this)
  writeSandboxConfig(ws);

  // ── build ⇄ review loop ─────────────────────────────────────────────────
  let findings = "";
  let touchedUi = false;
  let builderSession: string | undefined;
  // P2-013: non-null only right after a builder round that actually failed —
  // carries the resumable session + task ids into the next round's prompt
  let resume: AgentIds | null = null;
  // carry over the last gatekeeper failure for this task, so the builder can
  // fix the exact failing step instead of rediscovering it (per-task file)
  const failFile = gateFailFile(t.id);
  try {
    if (failFile) {
      const prev = JSON.parse(readFileSync(failFile, "utf8")) as { task?: string; tail?: string };
      if (prev.task === t.id && prev.tail) findings += `[previous gatekeeper failure]\n${prev.tail}\n`;
    }
  } catch {}
  let merged = false;
  let lastStream = 0;
  const stream = (chunk: string) => {
    touchHeartbeat();
    const now = Date.now();
    if (now - lastStream < 10_000) return;
    lastStream = now;
    const lines = chunk.split("\n").filter((l) => l.trim());
    const line = lines[lines.length - 1];
    if (line) {
      emit("agent", { task: t.id, detail: line.trim() });
      console.log(
        JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "agent", data: line.trim().slice(0, 400) }),
      );
    }
  };

  // ── P2-008 spec-before-build: PLANNER phase for P0/P1 tasks ──────────────
  // Skipped when the task is already merged: the spec commit alone would
  // otherwise mask the empty-diff self-heal with a spec-only diff.
  let specFile: string | null = null;
  if (needsPlanner(t.priority) && !taskMergedIn(ws, t.id)) {
    specFile = specPathFor(t.id);
    if (!specFile) return { ok: false, detail: `invalid task id for planner: ${t.id}` };
    // P1-060: a preserved branch already carries its committed spec — reuse it
    // instead of re-running the planner (commitSpec resets the branch to
    // origin/main, which would destroy the preserved work). When the worktree
    // copy is missing/tampered, recover the committed spec from the branch
    // history; if that is impossible AND the branch carries preserved commits,
    // fail fast — never reset over preserved history.
    let specState: "disk" | "recovered" | "planner" = "planner";
    if (resumed) {
      if (specOnDisk(ws, specFile)) {
        specState = "disk";
      } else {
        const recovered = recoverSpecFromBranch(ws, t.id, specFile);
        if (recovered !== null) {
          try {
            mkdirSync(dirname(join(ws, specFile)), { recursive: true });
            writeFileSync(join(ws, specFile), recovered);
            specState = "recovered";
          } catch {}
        } else if (branchHasCommits(ws, branch)) {
          emit("phase", { task: t.id, phase: "planner-done", ok: false, detail: "spec unrecoverable on preserved branch" });
          return {
            ok: false,
            detail: `preserved branch ${branch} carries commits but no recoverable ${specFile} — refusing to run the planner (its reset would destroy preserved work)`,
          };
        }
        // else: branch equals origin/main — the planner's reset destroys nothing
      }
    }
    if (specState === "planner") {
      emit("phase", { task: t.id, phase: "planner" });
      console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "planner", data: { task: t.id } }));
      let plannerSession: string | undefined;
      let specOk = false;
      // P2-042: the planner writes the spec the builder+reviewers are held to,
      // so it must know the same patterns the builder knows — top-5 IER lessons
      // keyword-matched against the task plus the 10 most recent failure lessons.
      const lessons = pickRelevantLessons(readExperienceFile(ws), t.title, t.spec);
      const failureBlock = failureLessonsBlock(readRecentFailureLessons(defaultLessonsFile()));
      for (let attempt = 1; attempt <= 2 && !specOk; attempt++) {
        const out = await runAgentForRole(
          "planner",
          plannerPrompt(t, attempt, lessons, failureBlock),
          {
            cwd: ws,
            timeoutMin: PLANNER_TIMEOUT_MIN,
            label: `planner-${t.id}-a${attempt}`,
            sessionId: plannerSession, // tier A only: tier-B runs are context-less (no resume)
            printLogs: true,
            onStdout: stream,
            models: cfg.models,
            marker: PLANNER_MARKER,
          },
        );
        if (out.sessionId) plannerSession = out.sessionId;
        trackSession(out.sessionId);
        // deterministic validation + commit: the LLM is never trusted, only the
        // on-disk file (all six sections present) counts as a spec
        specOk = commitSpec(ws, t.id);
        if (specOk) break;
        console.log(
          JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "planner attempt produced no valid spec", data: { task: t.id, attempt } }),
        );
      }
      if (!specOk) {
        // terminal ok:false so the dashboard doesn't hang on "working" (round-3)
        emit("phase", { task: t.id, phase: "planner-done", ok: false, detail: "no valid spec" });
        return { ok: false, detail: `planner did not produce a valid ${specFile} after 2 attempt(s)` };
      }
      emit("phase", { task: t.id, phase: "planner-done", ok: true, detail: specFile });
    } else {
      emit("phase", {
        task: t.id,
        phase: "planner-done",
        ok: true,
        detail: specState === "disk" ? `${specFile} (preserved branch)` : `${specFile} (recovered from branch history)`,
      });
    }
  }
  for (let round = 1; round <= cfg.maxReviewRounds && !merged; round++) {
    emit("phase", { task: t.id, phase: "builder", detail: `round ${round}` });
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "builder round", data: { task: t.id, round } }));
    // P1-060 checkpoint review: for size-L tasks record the branch head at
    // round start — reviewers of rounds > 1 receive the incremental diff
    // against this sha instead of the truncated whole-branch diff
    const isLong = t.size === "L";
    if (isLong) saveCheckpoint(t.id, headSha(ws), round);
    // P1-007: top-5 lessons keyword-matched against this task, most recent first
    const lessons = pickRelevantLessons(readExperienceFile(ws), t.title, t.spec);
    const build = await runAgent(builderPrompt(t, round, findings, lessons, specFile, resume, attemptNo + 1), {
      cwd: ws,
      timeoutMin: cfg.taskTimeoutMin,
      label: `builder-${t.id}-r${round}`,
      sessionId: builderSession, // context cache: resume the same session across rounds
      printLogs: true,
      onStdout: stream,
    });
    if (build.sessionId) builderSession = build.sessionId;
    trackSession(build.sessionId);
    // P2-013 (round 2): only a failed round leaves resumable state — a
    // successful one resets it, so review-fix rounds never see a false
    // "resume the crash" block
    const roundFailed = !build.output.includes("PILOT:TASK-DONE");
    resume = updateResumeState(resume, roundFailed, { sessionId: builderSession, taskIds: build.taskIds });
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "builder done", data: { task: t.id, round } }));
    // per-task diagnostic log: concurrent slots would clobber a shared file
    writeFileSync(join(homedir(), ".opencode-remote/pilot", `builder-${t.id}.log`), build.output);
    emit("phase", { task: t.id, phase: "builder-done", ok: !roundFailed });
    if (roundFailed) {
      // P2-013: a failed round (crash/timeout) is exactly when partial work
      // exists — retry within the round budget instead of aborting; the
      // failure notice travels in the resume block, not under the reviewer
      // findings header.
      const crash = crashRoundDecision(round, cfg.maxReviewRounds);
      if (!crash.retry) {
        // P1-074: a timeout with no output is infra (the agent process died
        // silently) — the marker lets runSlot's classifier spare the attempt
        // budget; only empty-output timeouts are infra
        if (build.timedOut && !build.output.trim()) {
          return { ok: false, detail: `[infra] builder timed out without output (round ${round})` };
        }
        return { ok: false, detail: `${crash.detail}: ${build.output.slice(-300)}` };
      }
      continue;
    }
    // --name-only: unified diff lines are prefixed (a/, b/, diff --git) and
    // would never match a bare path — round-2 review caught exactly that.
    const diff = exec(`git diff main...pilot/${t.id}`, { cwd: ws }).output;
    const nameOnly = exec(`git diff --name-only main...pilot/${t.id}`, { cwd: ws }).output;
    touchedUi = touchedUiFromDiff(nameOnly);
    // P2-011: UI tasks get visual evidence — per-task, post-deploy shape only
    // (round-3 review: unscoped mtime pick could serve another task's stale
    // shot or a builder's pre-merge self-shot as "deployed UI" evidence).
    const uiShot = touchedUi ? latestUiShot(t.id) : null;
    // P1-060 checkpoint review (size-L tasks only): rounds after the first are
    // reviewed on the INCREMENTAL diff since the round-start checkpoint —
    // earlier rounds were already reviewed, and a 60k-truncated whole-branch
    // diff would be noise. An empty/failed incremental (e.g. a round that only
    // re-ran evidence) falls back to the total branch diff. Round 1 and S/M
    // tasks keep the total diff.
    let reviewDiff = diff;
    let incrementalFrom: string | null = null;
    if (t.size === "L" && round > 1) {
      const cp = loadCheckpoint(t.id);
      if (cp?.sha) {
        const inc = exec(`git diff ${cp.sha} ${branch}`, { cwd: ws, allowFail: true });
        if (inc.ok && inc.output.trim()) {
          reviewDiff = inc.output;
          incrementalFrom = cp.sha.slice(0, 7);
        }
      }
    }
    // P2-008: the planner spec commit is bookkeeping and must not mask an
    // empty builder diff — the empty-diff/self-heal checks below decide on
    // the builder's non-spec changes only (e.g. a task merged by another push
    // while the builder ran still self-heals on P0/P1)
    const code = codeChanges(nameOnly, specFile);
    if (code.length === 0) {
      // empty-diff self-heal: builder ran after the task was already merged.
      // Refresh origin/main first so the merge check below isn't fooled by a
      // stale local ref (transient network failure → best-effort check).
      exec("git fetch -q origin main", { cwd: ws, allowFail: true });
      if (!taskMergedIn(ws, t.id)) return { ok: false, detail: "builder produced an empty diff" };
      emit("phase", { task: t.id, phase: "already-merged" });
      console.log(
        JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "empty diff but task already merged, self-healing", data: { task: t.id } }),
      );
      // clean worktree BEFORE moving to main: a dirty empty-diff workspace
      // would otherwise dirty the wrong branch or block the checkout
      exec("git reset -q --hard HEAD", { cwd: ws, allowFail: true });
      exec("git clean -qfd", { cwd: ws, allowFail: true });
      const co = exec("git checkout -q -B main origin/main", { cwd: ws, allowFail: true });
      let push = { ok: false, output: "" };
      if (co.ok) {
        markDone(ws, t.id, `already merged — empty-diff self-heal ${nowLocalISO().slice(0, 10)}`);
        exec("git add BACKLOG.md", { cwd: ws, allowFail: true });
        // idempotent: if markDone was a no-op (task already marked), skip the
        // commit instead of failing on an empty commit
        const staged = exec("git diff --cached --quiet", { cwd: ws, allowFail: true });
        if (!staged.ok) {
          exec(`git commit -qm "pilot(${t.id}): mark done (empty-diff self-heal)"`, { cwd: ws, allowFail: true });
          // PERMISSION-SURFACE NOTE (constitution #3 spirit): direct push to
          // origin/main outside the reviewer/gatekeeper path — kept restricted
          // to this bookkeeping path (only BACKLOG.md staged, fixed message).
          push = exec("git push -q origin main", { cwd: ws, allowFail: true });
        } else {
          push = { ok: true, output: "" };
        }
      }
      return {
        ok: co.ok && push.ok,
        detail: !co.ok
          ? `task ${t.id} already merged on main but workspace checkout failed`
          : push.ok
            ? `task ${t.id} already merged on main — marked done (empty-diff self-heal)`
            : `task ${t.id} already merged but BACKLOG update failed`,
      };
    }

    // P2-040: one shared re-run cache per round — the preflight below executes
    // typecheck once and the gate (evidence re-run + step battery) reuses the
    // same (command, workspace) result instead of re-running it. A new round
    // starts with a fresh map: the builder may have changed the code.
    const rerunResults: RerunResults = new Map();

    // preflight: a broken build must never reach the reviewers (they cost LLM
    // tokens and would only re-report the same typecheck errors)
    const pre = cachedExec(rerunResults, "npm run typecheck --silent", ws, { timeoutMin: 10 });
    if (!pre.ok) {
      findings = `${findings}\n[typecheck still failing — fix these first]\n${pre.output.slice(-1500)}`;
      emit("phase", { task: t.id, phase: "builder", detail: "preflight typecheck failed → next round", ok: false });
      continue;
    }

    // two adversarial reviewers in parallel, isolated contexts
    emit("phase", { task: t.id, phase: "reviewers" });
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "reviewers start", data: { task: t.id, round } }));
    const [sec, qual] = await Promise.all([
      runAgent(reviewerPrompt("SECURITY", "crypto, auth, injection, secrets, permission surface", t, reviewDiff, uiShot, null, incrementalFrom), {
        cwd: ws,
        timeoutMin: cfg.reviewTimeoutMin,
        label: `sec-${t.id}-r${round}`,
        onStdout: stream,
      }),
      runAgent(reviewerPrompt("QUALITY", "regressions, UX, docs, test coverage, complexity", t, reviewDiff, uiShot, specFile, incrementalFrom), {
        cwd: ws,
        timeoutMin: cfg.reviewTimeoutMin,
        label: `qual-${t.id}-r${round}`,
        onStdout: stream,
      }),
    ]);
    trackSession(sec.sessionId);
    trackSession(qual.sessionId);
    console.log(
      JSON.stringify({
        ts: nowLocalISO(),
        level: "info",
        msg: "reviewers done",
        data: { task: t.id, round, secOk: parseVerdict(sec.output) === "APPROVE", qualOk: parseVerdict(qual.output) === "APPROVE" },
      }),
    );
    const secParsed = parseFindings(sec.output);
    const qualParsed = parseFindings(qual.output);
    // P2-015: reviewers are LLMs — findings citing files/lines that don't exist
    // (or snippets absent from the diff) are mechanically dropped. A verdict
    // whose findings all fail verification degenerates to an effective APPROVE.
    // P1-060: verification runs against the same diff the reviewers saw
    // (incremental on later rounds of size-L tasks).
    const secVerified = verifyFindings(secParsed, ws, reviewDiff);
    const qualVerified = verifyFindings(qualParsed, ws, reviewDiff);
    for (const d of secVerified.dropped) logHallucination(t.id, "security", d);
    for (const d of qualVerified.dropped) logHallucination(t.id, "quality", d);
    // P2-038: the LAST verdict marker decides and verified findings reject even
    // when an APPROVE marker is present — findings that verify are evidence.
    const allDropped = (o: string, v: { kept: string[]; dropped: string[] }) =>
      parseVerdict(o) === "REQUEST_CHANGES" && v.dropped.length > 0 && v.kept.length === 0;
    const secAllDropped = allDropped(sec.output, secVerified);
    const qualAllDropped = allDropped(qual.output, qualVerified);
    const secOk = reviewerOk(sec.output, secVerified.kept, secVerified.dropped);
    const qualOk = reviewerOk(qual.output, qualVerified.kept, qualVerified.dropped);
    if (secAllDropped || qualAllDropped) {
      console.log(
        JSON.stringify({
          ts: nowLocalISO(),
          level: "info",
          msg: "review findings all unverifiable → effective approve",
          data: { task: t.id, round },
        }),
      );
    }
    // P1-059 reviewer escalation: round-1 divergence (1× approve vs 1× request
    // changes) and all-unverifiable findings are exactly the ambiguous cases a
    // flash pair misjudged in the past (semantic misses through 20 merges). One
    // extra tier-B reviewer arbiters; at most one escalation per round.
    let gateSecOk = secOk;
    let gateQualOk = qualOk;
    let escalationFindings: string[] | null = null;
    if (cfg.models?.tierB?.reviewerEscalation && needsEscalation(round, secOk, qualOk, secAllDropped, qualAllDropped)) {
      emit("phase", { task: t.id, phase: "review-escalation", detail: `round ${round}` });
      console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "review escalation", data: { task: t.id, round } }));
      const esc = await runAgentForRole("reviewerEscalation", reviewerPrompt("ESCALATION", "spec fidelity, semantic correctness, regressions", t, reviewDiff, uiShot, specFile, incrementalFrom), {
        cwd: ws,
        timeoutMin: cfg.reviewTimeoutMin,
        label: `esc-${t.id}-r${round}`,
        onStdout: stream,
        models: cfg.models,
        marker: ESCALATION_MARKER,
      });
      trackSession(esc.sessionId);
      const escParsed = parseFindings(esc.output);
      const escVerified = verifyFindings(escParsed, ws, reviewDiff);
      for (const d of escVerified.dropped) logHallucination(t.id, "escalation", d);
      const escApprove = reviewerOk(esc.output, escVerified.kept, escVerified.dropped);
      if (escApprove) {
        gateSecOk = true;
        gateQualOk = true;
      } else {
        gateSecOk = false;
        gateQualOk = false;
        escalationFindings = escVerified.kept;
      }
      console.log(
        JSON.stringify({
          ts: nowLocalISO(),
          level: "info",
          msg: "review escalation done",
          data: { task: t.id, round, approve: escApprove, kept: escVerified.kept.length },
        }),
      );
    }
    emit("phase", { task: t.id, phase: "reviewers-done", ok: gateSecOk && gateQualOk });
    if (gateSecOk && gateQualOk) {
      emit("phase", { task: t.id, phase: "gatekeeper" });
      // serialized across slots: fixed battery ports + main push (P1-006)
      merged = await runGateExclusive(() => gatekeeper(cfg, ws, t, state, build.output, startedAtMs, rerunResults));
      emit("phase", { task: t.id, phase: "merge", ok: merged });
      if (merged) {
        // gate passed — the per-task carryover file has no reason to linger
        const f = gateFailFile(t.id);
        if (f) {
          try {
            rmSync(f);
          } catch {}
        }
        // P1-007 SCRIBE: distill lessons from the merged diff while the
        // workspace still sits on updated main — outside the gate lock (LLM
        // latency must not block other slots) and before the pipeline returns
        // (the next pipeline resets this worktree, which would race the agent).
        try {
          await runScribe(ws, t, diff, findings, trackSession);
        } catch (err) {
          console.log(
            JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "scribe crashed", data: { task: t.id, err: String(err).slice(0, 200) } }),
          );
        }
      }
      if (!merged) return { ok: false, detail: "gatekeeper rejected: eval battery or invariants failed" };
    } else {
      // Only verified findings reach the builder prompt (P2-015). P1-059 round
      // 2: on escalation rejection the arbiter ADDS its verified findings to
      // the round-1 verified kept findings — it arbiters, it does not erase
      // the reviewers' evidence (union, deduped line-wise).
      const round1Kept = [...(secOk ? [] : secVerified.kept), ...(qualOk ? [] : qualVerified.kept)];
      const allKept = escalationFindings !== null ? [...round1Kept, ...escalationFindings] : round1Kept;
      findings = allKept.filter((f, i) => allKept.indexOf(f) === i).join("\n");
      if (round === cfg.maxReviewRounds) {
        // P2-031: the carryover file must reflect the REAL last failure — a task
        // burning out at review after an old gate failure would otherwise be
        // blocked with a stale step/tail in its failure lesson
        recordGateFail(state, t.id, "review", findings);
        return { ok: false, detail: `max review rounds reached — findings: ${findings.slice(0, 400)}` };
      }
    }
  }
  return {
    ok: true,
    detail: `task ${t.id} merged`,
    sha: headSha(ws),
    touchedUi,
  };
}

/** P2-015: findings are the bullet lines after (or near) the verdict marker.
 * P2-038: anchored at the LAST verdict marker — last marker wins. */
export function parseFindings(output: string): string[] {
  const markers = [...output.matchAll(/VERDICT:\s*(?:APPROVE|REQUEST_CHANGES)/gi)];
  const idx = markers.length > 0 ? (markers[markers.length - 1]!.index ?? -1) : -1;
  const tail = idx >= 0 ? output.slice(idx) : output.slice(-1500);
  return tail
    .split("\n")
    .filter((l) => /^\s*[-*]/.test(l))
    .slice(0, 12);
}

export interface VerifiedFindings {
  kept: string[];
  dropped: string[];
}

/**
 * P2-015 anti-hallucination filter. A finding is resolvable when:
 *  - it cites only repo-relative files that exist in `ws` (every file citation
 *    must resolve; a cited line, when present, must be non-empty); or
 *  - it cites no file but quotes a literal snippet (≥6 chars) that appears
 *    verbatim in the reviewed diff.
 * Pure in spirit — fs reads only touch the workspace, so the eval battery can
 * pin this against fake findings (one real path, one nonexistent).
 */
export function verifyFindings(findings: string[], ws: string, diff: string): VerifiedFindings {
  // P2-038: one workspace file listing per call — bare-name citations
  // (e.g. `CommandPalette.tsx:63`) resolve by suffix match instead of being
  // dropped as hallucinated just because the reviewer omitted the directory.
  const wsFiles = workspaceFiles(ws);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const f of findings) {
    if (findingResolves(f, ws, diff, wsFiles)) kept.push(f);
    else dropped.push(f);
  }
  return { kept, dropped };
}

interface FileCite {
  path: string;
  line?: number;
}

/** Known source extensions keep prose words ("e.g", "v1.2") out of citations. */
const KNOWN_EXT = "ts|tsx|js|jsx|mjs|cjs|json|md|css|html?|sh|py|rb|go|rs|java|ya?ml|toml|sql|txt|xml|svg";
const FILE_CITE_RE = new RegExp(`(\\b[\\w@][\\w@./+-]*\\.(?:${KNOWN_EXT}))(?::(\\d+))?(?!\\w)`, "g");
const FILE_PATH_SHAPE_RE = new RegExp(`^[\\w@./+-]*\\.(?:${KNOWN_EXT})(?::\\d+)?$`);

const SNIPPET_RES = [/"([^"\n]{6,})"/g, /`([^`\n]{6,})`/g];

/** P2-038: quoted spans act as symbol citations inside findings that already
 * cite a file — a code observation has no stdout, so its quoted symbol is the
 * thing to verify. File-path-shaped spans stay the business of FILE_CITE_RE. */
const SYMBOL_RES = [/"([^"\n]{2,})"/g, /`([^`\n]{2,})`/g];

/** Quoted spans (double quotes or backticks) of at least `minLen` chars that
 * are not file-path-shaped — symbol or snippet citations inside a finding. */
function quotedSpans(finding: string, minLen: number): string[] {
  const out: string[] = [];
  for (const re of SYMBOL_RES) {
    for (const m of finding.matchAll(re)) {
      const sym = (m[1] ?? "").trim();
      if (sym.length < minLen || FILE_PATH_SHAPE_RE.test(sym)) continue;
      out.push(sym);
    }
  }
  return out;
}

function symbolCites(finding: string): string[] {
  return quotedSpans(finding, 2);
}

/** P2-038: workspace-relative paths of all scannable files (no .git /
 * node_modules), sorted for determinism. */
function workspaceFiles(ws: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(ws, p).split(sep).join("/"));
    }
  };
  walk(ws);
  return out.sort();
}

function findingResolves(finding: string, ws: string, diff: string, wsFiles: string[]): boolean {
  // URLs are not file citations; they would only produce phantom paths
  const cleaned = finding.replace(/https?:\/\/\S+/g, " ");
  const fileCites: FileCite[] = [...cleaned.matchAll(FILE_CITE_RE)].map((m) => ({
    path: m[1] ?? "", // group 1 always matches when the regex matched
    line: m[2] !== undefined ? Number(m[2]) : undefined,
  }));
  if (fileCites.length > 0) {
    // P2-038 (requirement d) + P1-065: a code observation is verified
    // deterministically — every cited file:line must exist in the workspace,
    // and quoted symbols are checked against the UNION of all resolved
    // citations' contents plus the reviewed diff (not per-citation: a
    // cross-file finding whose symbols are spread across its own citations
    // is valid). Tier-2: when the full symbol set does not resolve, the
    // finding is still kept if at least one quoted span of >=6 chars
    // (symbol or snippet) matches the union. Dropped only when a cited
    // file/line fails to resolve or zero >=6-char spans match.
    const contents: string[] = [];
    for (const c of fileCites) {
      const content = resolveCite(ws, c, wsFiles);
      if (content === null) return false;
      contents.push(content);
    }
    const symbols = symbolCites(cleaned);
    if (symbols.length === 0) return true;
    const union = `${contents.join("\n")}\n${diff}`;
    if (symbols.every((s) => union.includes(s))) return true;
    return quotedSpans(cleaned, 6).some((s) => union.includes(s));
  }
  return SNIPPET_RES.some((re) => [...cleaned.matchAll(re)].some((m) => m[1] !== undefined && diff.includes(m[1])));
}

/** P2-038 + P1-065: one file citation resolves when the cited file exists (at
 * the cited ws-relative path, or anywhere in the workspace for bare-name
 * citations) and the cited line, when present, is non-empty. Returns the file
 * content so the symbol check can run against the union of all citations
 * instead of each citation in isolation; the first candidate (in sorted
 * workspace order) whose cited line is non-empty wins. */
function resolveCite(ws: string, cite: FileCite, wsFiles: string[]): string | null {
  // unified-diff prefixes + traversal attempts are never valid citations
  const rel = cite.path.replace(/^(?:\.\/)+/, "").replace(/^(?:a|b)\//, "");
  if (rel.includes("..")) return null;
  const candidates = existsSync(join(ws, rel)) ? [rel] : wsFiles.filter((f) => f.endsWith(`/${rel}`));
  for (const cand of candidates) {
    let lines: string[];
    try {
      lines = readFileSync(join(ws, cand), "utf8").split("\n");
    } catch {
      continue;
    }
    if (cite.line !== undefined) {
      const l = lines[cite.line - 1];
      if (l === undefined || l.trim().length === 0) continue;
    }
    return lines.join("\n");
  }
  return null;
}

function logHallucination(task: string, reviewer: string, finding: string) {
  console.log(
    JSON.stringify({
      ts: nowLocalISO(),
      level: "warn",
      msg: "finding hallucinated, dropped",
      data: { task, reviewer, finding: finding.trim().slice(0, 200) },
    }),
  );
}

/** Shared gatekeeper failure path: warn log + per-task carryover file + counter. */
function recordGateFail(state: PilotState, taskId: string, step: string, tail: string) {
  console.log(
    JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "gatekeeper fail", data: { task: taskId, step, tail: tail.slice(-300) } }),
  );
  // P2-045: structured step signal on the events feed — the dashboard failure
  // breakdown aggregates these instead of the operator grepping pilot.log
  emit("phase", { task: taskId, phase: "gate-fail", ok: false, detail: step });
  const failFile = gateFailFile(taskId);
  if (failFile) {
    try {
      mkdirSync(dirname(failFile), { recursive: true });
      writeFileSync(
        failFile,
        JSON.stringify({ task: taskId, step, tail: tail.slice(-1200), at: nowLocalISO() }, null, 2),
      );
    } catch {}
  }
  state.failures++;
}

/** Deterministic gate: evidence, typecheck, build, test battery, invariants. No judgement. */
async function gatekeeper(
  cfg: PilotConfig,
  ws: string,
  t: Task,
  state: PilotState,
  builderOutput: string,
  startedAtMs: number,
  // P2-040: the round's shared re-run cache — the preflight typecheck already
  // executed in this workspace, so the evidence re-run and the step battery
  // below reuse it (1 execution per round, not 3) while holding no lock.
  rerunResults: RerunResults,
): Promise<boolean> {
  const steps: Array<[string, string]> = [
    ["typecheck", "npm run typecheck --silent"],
    ["build", "npm run build --silent"],
    ["unit", "npm run test:unit --silent"],
    ["lock-sync", "npm ci --dry-run --no-audit --no-fund --loglevel=error"],
    ["reconnect", "npx tsx scripts/reconnect.test.ts"],
    ["integration", "npx tsx scripts/integration.ts"],
    ["desktop-sidecar", "npx tsx scripts/desktop-sidecar.test.ts"],
    ["invariants", "npx tsx scripts/invariants.ts"],
    // NOTE: live tests (download/push/smoke/live-eval) run post-deploy via
    // `invariants --live` + health checks — they need RELAY_URL + prod pairing.
  ];
  // Desktop render smoke (P0-002): when the diff touches the desktop shell or
  // the web UI it renders, go beyond process boot — did-finish-load + renderer
  // console capture + #root mounted content — so a white window (e.g. asset
  // 404 on file://) is rejected. Most white-window regressions come from
  // apps/web/-only changes, hence the second trigger. Fail closed: when the
  // diff cannot be computed, run the smoke anyway instead of skipping it.
  const diff = exec(`git diff --name-only main...pilot/${t.id}`, { cwd: ws, allowFail: true });
  const renderTouched =
    !diff.ok ||
    diff.output.split("\n").some((l) => {
      const p = l.trim();
      return p.startsWith("apps/desktop/") || p.startsWith("apps/web/");
    });
  if (renderTouched) {
    steps.push(["desktop-render", "npx tsx scripts/desktop-render.test.ts"]);
    // P1-051: real interaction flow against the packaged shell (Playwright
    // _electron via tools/desktop.mjs) — open → interact → shot → assert IPC.
    steps.push(["desktop-flow", "npx tsx scripts/desktop-flow.test.ts"]);
  }
  // P2-009 mandatory evidence: static checks first (missing block, fabricated
  // command, missing screenshot) then re-execution of every cited command —
  // pasted output that diverges from the real one rejects the merge here,
  // before the expensive battery burns time on fabricated work.
  // Round 2: shots are demanded under the SAME predicate the prompt used
  // (needsUiEvidence) — a non-UI-tagged task whose diff touches apps/web or
  // apps/desktop is instructed to bring shots and the gate enforces it.
  // Round 2: re-run results are cached — the typecheck/build/unit steps below
  // reuse them instead of re-executing the same commands while holding the
  // cross-slot gate lock (P1-006). P2-040: the cache is the round's shared
  // map, so a command the preflight already ran in this workspace is not
  // re-executed here either.
  const requireShots = needsUiEvidence(t.area, renderTouched);
  const evidence = verifyEvidence(ws, builderOutput, requireShots, startedAtMs, (cmd, cwd) =>
    cachedExec(rerunResults, cmd, cwd, { timeoutMin: 20 }),
  );
  if (!evidence.ok) {
    recordGateFail(state, t.id, "evidence", evidence.detail);
    return false;
  }
  for (const [name, cmd] of steps) {
    // evidence already re-executed this exact command in this workspace — keep
    // its result; the step list uses the same canonical command strings
    const r = cachedExec(rerunResults, cmd, ws, { timeoutMin: 20 });
    if (!r.ok) {
      recordGateFail(state, t.id, name, r.output);
      return false;
    }
  }
  // P1-044 (a): a task that edits the pipeline's own code must leave the golden
  // corpus green — the gate's own calibration cannot regress through a merge.
  // Unknown diff → fail-closed (the corpus check is cheap and deterministic).
  const pilotInfraTouched = !diff.ok || touchedPilotInfraFromDiff(diff.output);
  if (pilotInfraTouched) {
    const corpus = corpusGateDetail();
    if (corpus) {
      recordGateFail(state, t.id, "corpus", corpus);
      return false;
    }
  }
  // merge via GitHub PR for audit trail
  const title = `pilot(${t.id}): ${t.title}`;
  // P2-058 (round 2): HEAD before the merge attempt — the post-merge record
  // must prove HEAD actually moved past this tip
  const preMergeHead = headSha(ws);
  exec(`git push -q origin pilot/${t.id}`, { cwd: ws, allowFail: true });
  const pr = exec(
    `gh pr create --head pilot/${t.id} --title ${JSON.stringify(title)} --body ${JSON.stringify("Autonomous pipeline merge — gatekeeper green (typecheck, build, reconnect, integration, invariants, download).")}`,
    { cwd: ws, timeoutMin: 5, allowFail: true },
  );
  if (pr.ok) {
    const merge = exec("gh pr merge --squash --delete-branch --auto || gh pr merge --squash --delete-branch", {
      cwd: ws,
      timeoutMin: 5,
      allowFail: true,
    });
    if (!merge.ok) return false;
  } else {
    // fallback: local merge to main and push. origin/main may have moved
    // (concurrent slot/aux pushes): fetch + retry so a non-fast-forward never
    // crashes a post-green pipeline with an unhandled exec error.
    let pushed = false;
    for (let i = 0; i < 3 && !pushed; i++) {
      exec("git fetch -q origin", { cwd: ws, allowFail: true });
      exec("git checkout -q main", { cwd: ws, allowFail: true });
      // reset --hard also clears a conflicted-merge state from a prior attempt
      const base = exec("git reset -q --hard origin/main", { cwd: ws, allowFail: true });
      const merge = exec(`git merge -q --no-ff --no-edit pilot/${t.id}`, { cwd: ws, allowFail: true });
      if (!base.ok || !merge.ok) break; // conflict — only a full pipeline round fixes it
      pushed = exec("git push -q origin main", { cwd: ws, allowFail: true }).ok;
    }
    if (!pushed) return false; // branch is on origin; the next cycle re-runs the task
  }
  // bring workspace main up to date with the merge, then mark the task done
  exec("git checkout -q main", { cwd: ws, allowFail: true });
  exec("git pull -q origin main", { cwd: ws, allowFail: true });
  // P2-058: record the gate-green merge so deploy() only ever ships SHAs this
  // gatekeeper produced. Round-2 hardening: `gh pr merge --auto` can return
  // success while the squash is still QUEUED — recording blind HEAD would pin
  // the pre-merge tip (e.g. a bookkeeping mark-done commit) as a deployable
  // "verified merge", the exact path this task blocks. Only a HEAD that moved
  // past the pre-merge tip AND carries the task's canonical merge identity is
  // recorded; anything else stays unverified (fail-closed — the code ships
  // with the next verified merge).
  const postMergeHead = headSha(ws);
  if (postMergeHead !== preMergeHead && isTaskMergeSha(ws, postMergeHead, t.id)) {
    if (!recordVerifiedMerge(defaultVerifiedMergesFile(), postMergeHead, t.id, nowLocalISO())) {
      console.log(JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "verified-merge recording failed — deploy will stay refused for this sha", data: { task: t.id, sha: postMergeHead.slice(0, 7) } }));
    }
  } else {
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "merge sha not identifiable on main — deploy stays refused until the next verified merge", data: { task: t.id, sha: postMergeHead.slice(0, 7), moved: postMergeHead !== preMergeHead } }));
  }
  markDone(ws, t.id, `merged by pilot ${nowLocalISO().slice(0, 10)}`);
  exec(`git add BACKLOG.md && git commit -qm "pilot(${t.id}): mark done" && git push -q origin main`, {
    cwd: ws,
    allowFail: true,
  });
  // P2-045: honest daily merge counter for the dashboard — state.json resets
  // at midnight (loadState), matching `git log --since=00:00` exactly
  state.merges = (state.merges ?? 0) + 1;
  // P3-033: grow the golden corpus every corpusEveryNMerges successful merges —
  // the evidence gate's own re-run outputs are the real variation the matcher
  // must keep accepting. Best-effort: a corpus problem never fails a green gate.
  const mergesSinceCorpus = (state.mergesSinceCorpus ?? 0) + 1;
  if (mergesSinceCorpus >= (cfg.corpusEveryNMerges ?? 5)) {
    state.mergesSinceCorpus = 0;
    try {
      const files = captureGateCorpus(ws, t.id, rerunResults);
      if (files.length) {
        emit("phase", { task: t.id, phase: "corpus", ok: true, detail: `${files.length} sample(s)` });
        exec("git pull -q origin main", { cwd: ws, allowFail: true });
      }
    } catch (err) {
      console.log(
        JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "corpus capture failed", data: { task: t.id, err: String(err).slice(0, 200) } }),
      );
    }
  } else {
    state.mergesSinceCorpus = mergesSinceCorpus;
  }
  return true;
}

function headSha(ws: string): string {
  return exec("git rev-parse HEAD", { cwd: ws }).output.trim();
}

/**
 * True when a commit on origin/main has the canonical subject `pilot(<id>): ...`.
 * The id is validated against TASK_ID_RE (never reaches a shell unchecked) and
 * regex-escaped, then matched as a line-anchored ERE — so body/revert references
 * to the id don't count as "merged".
 */
export function taskMergedIn(ws: string, id: string): boolean {
  if (!TASK_ID_RE.test(id)) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r = exec(`git log origin/main --extended-regexp --grep='^pilot\\(${escaped}\\):' --oneline`, {
    cwd: ws,
    allowFail: true,
  });
  return r.ok && r.output.trim().length > 0;
}

/**
 * P2-058 (round 2): does this commit on main carry the task's canonical merge
 * identity? Two shapes count: the PR squash commit (subject starts with the
 * anchored `pilot(<id>):` format — same rule as taskMergedIn) and the local
 * `--no-ff` fallback merge commit (two parents, subject `Merge branch
 * 'pilot/<id>'`). Any other commit — bookkeeping or a hostile direct push —
 * is never recorded as a verified merge.
 */
export function isTaskMergeSha(ws: string, sha: string, id: string): boolean {
  if (!TASK_ID_RE.test(id) || !/^[0-9a-f]{7,40}$/.test(sha)) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const subject = exec(`git log -1 --format=%s ${sha}`, { cwd: ws, allowFail: true }).output.trim();
  if (new RegExp(`^pilot\\(${escaped}\\):`).test(subject)) return true;
  const parents = exec(`git log -1 --format=%P ${sha}`, { cwd: ws, allowFail: true }).output.trim();
  return parents.split(" ").filter(Boolean).length === 2 && subject.includes(`'pilot/${id}'`);
}
