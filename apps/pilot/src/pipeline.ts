import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { agentStream, exec, runAgent } from "./runner";
import { nowLocalISO } from "./log";
import { markDone, type Task } from "./backlog";
import { emit } from "./events";
import { latestUiShot } from "./shot";
import { touchHeartbeat, type PilotConfig, type PilotState } from "./state";
import { appendLessonsToWorkspace, pickRelevantLessons, readExperienceFile } from "./experience";

export const CONSTITUTION = `CONSTITUTION (never violate):
1. E2E crypto stays E2E: the relay must remain a blind router; never log plaintext frames.
2. Auth surface only grows more strict: handshake allowlist, replay protection (seq in AAD) and the 0600 state file are untouchable.
3. scripts/invariants.ts and deploy/ are safety-critical: changes there need explicit justification in the commit message.
4. No secrets in the repo. No network listeners beyond the documented ports.
5. Every user-visible change is documented (README/AGENTS/docs) and covered by the eval battery.`;

/** P1-007: injected into builder/strategist prompts — top keyword-matched lessons. */
export function lessonsBlock(lessons: string[]): string {
  return lessons.length ? `\nEXPERIENCE — relevant lessons from past merges (follow them):\n${lessons.join("\n")}\n` : "";
}

// ── P2-008 spec-before-build: PLANNER phase for P0/P1 tasks ─────────────────

/** Planner agents are read-only code readers; 10 min like the scribe. */
export const PLANNER_TIMEOUT_MIN = 10;
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

export function plannerPrompt(t: Task, attempt: number): string {
  const retry = attempt > 1
    ? `\nATTENTION: this is attempt ${attempt}. Your previous run did not leave a valid specs/${t.id}.md on disk — write the file this time.\n`
    : "";
  return `You are the PLANNER agent of the opencode-remote autonomous pipeline (READ-ONLY).
The task below is high priority; before any builder touches it, you must produce its build spec.

TASK (${t.id}) [${t.priority}]: ${t.title}
spec: ${t.spec || "(no extra spec — use judgement, keep the change small and shippable)"}
${retry}
Read the relevant code in this repository and write the build spec to the file
specs/${t.id}.md (create the specs/ directory if needed) with EXACTLY these markdown sections:
## Problem
## Approach
## Touched files
## Edge cases
## Acceptance criteria
## Out of scope

Rules:
- ${CONSTITUTION}
- READ-ONLY except for specs/${t.id}.md: do NOT modify, create or delete any other file, do NOT commit.
- Keep the spec short and concrete (<= ~120 lines) — the builder is another agent that will follow it.
- Acceptance criteria must be testable: commands to run, observable behaviors, numbers when applicable.
- Touched files must cite real repo paths you actually inspected.

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

export function builderPrompt(
  t: Task,
  round: number,
  findings: string,
  lessons: string[] = [],
  specFile: string | null = null,
): string {
  const uiTask = needsUiEvidence(t.area, false);
  // P2-008: when a planner spec exists on the branch, the builder must follow it
  const specBlock = specFile
    ? `\nPLANNER SPEC: ${specFile} exists on this branch — read it FIRST. It holds the agreed problem analysis, approach, touched files, edge cases, acceptance criteria and out-of-scope. Follow it; if you must deviate, justify the deviation in the commit message. Do not delete or rewrite the spec.\n`
    : "";
  return `You are the BUILDER agent of the opencode-remote autonomous pipeline (round ${round}).
Work inside this repository (your cwd is a dedicated clone; production runs elsewhere).

TASK (${t.id}) [${t.priority}]: ${t.title}
spec: ${t.spec || "(no extra spec — use judgement, keep the change small and shippable)"}
${specBlock}${findings ? `\nREVIEWER FINDINGS TO ADDRESS:\n${findings}\n` : ""}${lessonsBlock(lessons)}
Rules:
- ${CONSTITUTION}
- Create/keep working on branch pilot/${t.id}. Commit your work with a conventional message "pilot(${t.id}): ...".
- Run "npm run typecheck" and "npm run build" and fix any errors before committing.
- Document user-visible changes in the relevant docs (README.md / AGENTS.md / docs/).
- Do NOT push, do NOT touch production services, do NOT modify BACKLOG.md.
- Keep the diff focused: one task, no drive-by refactors.
${round > 1 ? `- Rounds 1..${round - 1} already committed work on this branch. Inspect it first with \`git diff main...pilot/${t.id}\` and fix the findings INCREMENTALLY — do not restart from scratch or re-read files you already understand.` : ""}${
    uiTask
      ? `\n- UI self-driving (P2-011): this task changes the UI. Validate your own output visually before finishing: build the app, then use the host browser CLI — \`node tools/browse.mjs open <url> ~/.opencode-remote/pilot/shots/builder/${t.id}-r${round}.png\` — and inspect the PNG. Produce TWO sized screenshots with the browse CLI — \`node tools/browse.mjs shot <path>.png 1440 900\` (desktop) and \`node tools/browse.mjs shot <path>.png 390 844\` (phone), positional width/height — and cite both paths in the EVIDENCE block below; PNG dimensions are verified at the gate (1440x900 exactly, 2x Retina accepted; width 390). This is YOUR pre-merge self-check; post-deploy evidence is captured separately by the pipeline.`
      : ""
  }

MANDATORY EVIDENCE (P2-009): when finished, end your output with exactly this EVIDENCE
block — the deterministic gatekeeper parses it, re-executes every cited command and
REJECTS the merge when the block is missing or the real output diverges from what you
pasted. Only real output you produced this round; only "npm run typecheck --silent",
"npm run test:unit --silent" and "npm run build --silent" may be cited. The gate also
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

Your LAST line of output must be exactly: PILOT:TASK-DONE`;
}

/**
 * P1-007 SCRIBE role: distill ≤3 reusable lessons from a just-merged diff.
 * The agent only OUTPUTS lesson lines — the runner validates, dedupes, appends
 * to docs/EXPERIENCE.md and commits, so an LLM never edits the file directly.
 */
export function scribePrompt(t: Task, diff: string, findings: string): string {
  return `You are the SCRIBE agent of the opencode-remote autonomous pipeline.
The task below was just merged after passing adversarial reviews and the deterministic gatekeeper.
Your job: distill reusable engineering lessons for future agents.

TASK (${t.id}) [${t.priority}]: ${t.title}
spec: ${t.spec || "(none)"}
${findings ? `\nREVIEWER FINDINGS (already addressed by the merge):\n${findings}\n` : ""}
Rules:
- Read the diff below (and the repo if needed). Do NOT modify any files.
- Output 1 to 3 lessons: concrete, generalizable rules a future agent must
  follow when touching similar code (gotchas, root causes, invariants). Skip the obvious.
- One lesson per line, EXACTLY this format (plain text, no markdown headings or code blocks):
  - When <situation>, do <action> (fonte: ${t.id})

Your LAST lines must be exactly:
LESSONS:
<lesson lines>
SCRIBE:DONE

DIFF:
\`\`\`diff
${diff.slice(0, 30_000)}
\`\`\``;
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
    if (exec("git push -q origin main", { cwd: ws, allowFail: true }).ok) return true;
  }
  return false;
}

async function runScribe(ws: string, t: Task, diff: string, findings: string): Promise<void> {
  emit("phase", { task: t.id, phase: "scribe" });
  const out = await runAgent(scribePrompt(t, diff, findings), {
    cwd: ws,
    timeoutMin: 10,
    label: `scribe-${t.id}`,
    onStdout: agentStream("scribe"),
  });
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
): string {
  return `You are the ${role} REVIEWER agent of the opencode-remote autonomous pipeline.
A builder implemented TASK (${t.id}): ${t.title}
spec: ${t.spec || "(none)"}

Review the following diff with this focus: ${focus}

Rules:
- ${CONSTITUTION}
- Judge only this diff against the task and the constitution. Do not rewrite the code.
- Be strict but concrete: every finding must reference a file and a problem.
- Cite or it didn't happen (P2-015): every finding bullet must cite a repo-relative
  \`path/file.ext:LINE\` (line matching the workspace files) or quote a literal snippet
  from the diff. Findings without a verifiable citation are mechanically dropped as
  hallucinated; a reviewer whose findings ALL fail verification counts as APPROVE.
${
  role === "QUALITY" && specFile
    ? `- Spec compliance (P2-008): this branch carries a planner spec at "${specFile}" (read it in the workspace). Answer explicitly in your review: does the diff fulfill ${specFile}? A deviation from its approach, touched-files list or acceptance criteria is a finding unless the diff justifies it.`
    : ""
}
${
  uiShot
    ? `- UI evidence (P2-011): the most recent available screenshot for this task is "${uiShot}". It may predate this diff (captured after an earlier deploy) — treat it as a regression baseline, not proof of this diff. Read it (it is an image), say what it shows, and state explicitly whether the diff could plausibly regress it. You can take a fresh screenshot of your local build: \`node tools/browse.mjs shot <path>.png\`.`
    : ""
}

Your LAST lines must be exactly one of:
VERDICT: APPROVE
or
VERDICT: REQUEST_CHANGES
followed by a bullet list of findings.

DIFF:
\`\`\`diff
${diff.slice(0, 60_000)}
\`\`\``;
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

/** Whitespace/ANSI-insensitive line normalization for evidence comparison. */
export function normalizeEvidenceLine(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
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
  const actualLines = new Set(actual.split("\n").map(normalizeEvidenceLine).filter(Boolean));
  const pastedLines = pasted
    .split("\n")
    .map(normalizeEvidenceLine)
    .filter(Boolean)
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

export async function runPipeline(cfg: PilotConfig, t: Task, state: PilotState): Promise<PipelineResult> {
  const ws = cfg.workspace;
  // central injection guard: t.id is interpolated into shell commands below
  if (!TASK_ID_RE.test(t.id)) return { ok: false, detail: `invalid task id: ${t.id}` };
  // P2-009: pipeline (branch) start — cited UI evidence must be newer than this
  const startedAtMs = Date.now();
  // fresh workspace at origin/main
  exec("git fetch origin", { cwd: ws });
  exec("git reset -q --hard origin/main", { cwd: ws });
  exec("git clean -qfd", { cwd: ws });
  exec(`git branch -qD pilot/${t.id} 2>/dev/null || true`, { cwd: ws, allowFail: true });
  exec(`git checkout -q -b pilot/${t.id}`, { cwd: ws });

  // sandbox permissions: agents in the clone get full tool access (the real
  // security boundary is the gatekeeper + invariants + staged deploy, not this)
  writeSandboxConfig(ws);

  // ── build ⇄ review loop ─────────────────────────────────────────────────
  let findings = "";
  let touchedUi = false;
  let builderSession: string | undefined;
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
    emit("phase", { task: t.id, phase: "planner" });
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "planner", data: { task: t.id } }));
    let plannerSession: string | undefined;
    let specOk = false;
    for (let attempt = 1; attempt <= 2 && !specOk; attempt++) {
      const out = await runAgent(plannerPrompt(t, attempt), {
        cwd: ws,
        timeoutMin: PLANNER_TIMEOUT_MIN,
        label: `planner-${t.id}-a${attempt}`,
        sessionId: plannerSession, // retry resumes the planner's own context
        printLogs: true,
        onStdout: stream,
      });
      if (out.sessionId) plannerSession = out.sessionId;
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
  }
  for (let round = 1; round <= cfg.maxReviewRounds && !merged; round++) {
    emit("phase", { task: t.id, phase: "builder", detail: `round ${round}` });
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "builder round", data: { task: t.id, round } }));
    // P1-007: top-5 lessons keyword-matched against this task, most recent first
    const lessons = pickRelevantLessons(readExperienceFile(ws), t.title, t.spec);
    const build = await runAgent(builderPrompt(t, round, findings, lessons, specFile), {
      cwd: ws,
      timeoutMin: cfg.taskTimeoutMin,
      label: `builder-${t.id}-r${round}`,
      sessionId: builderSession, // context cache: resume the same session across rounds
      printLogs: true,
      onStdout: stream,
    });
    if (build.sessionId) builderSession = build.sessionId;
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "builder done", data: { task: t.id, round } }));
    // per-task diagnostic log: concurrent slots would clobber a shared file
    writeFileSync(join(homedir(), ".opencode-remote/pilot", `builder-${t.id}.log`), build.output);
    emit("phase", { task: t.id, phase: "builder-done", ok: build.output.includes("PILOT:TASK-DONE") });
    if (!build.output.includes("PILOT:TASK-DONE")) {
      return { ok: false, detail: `builder did not finish (round ${round}): ${build.output.slice(-300)}` };
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

    // preflight: a broken build must never reach the reviewers (they cost LLM
    // tokens and would only re-report the same typecheck errors)
    const pre = exec("npm run typecheck --silent", { cwd: ws, timeoutMin: 10, allowFail: true });
    if (!pre.ok) {
      findings = `${findings}\n[typecheck still failing — fix these first]\n${pre.output.slice(-1500)}`;
      emit("phase", { task: t.id, phase: "builder", detail: "preflight typecheck failed → next round", ok: false });
      continue;
    }

    // two adversarial reviewers in parallel, isolated contexts
    emit("phase", { task: t.id, phase: "reviewers" });
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "reviewers start", data: { task: t.id, round } }));
    const [sec, qual] = await Promise.all([
      runAgent(reviewerPrompt("SECURITY", "crypto, auth, injection, secrets, permission surface", t, diff, uiShot), {
        cwd: ws,
        timeoutMin: cfg.reviewTimeoutMin,
        label: `sec-${t.id}-r${round}`,
        onStdout: stream,
      }),
      runAgent(reviewerPrompt("QUALITY", "regressions, UX, docs, test coverage, complexity", t, diff, uiShot, specFile), {
        cwd: ws,
        timeoutMin: cfg.reviewTimeoutMin,
        label: `qual-${t.id}-r${round}`,
        onStdout: stream,
      }),
    ]);
    console.log(
      JSON.stringify({
        ts: nowLocalISO(),
        level: "info",
        msg: "reviewers done",
        data: { task: t.id, round, secOk: /VERDICT:\s*APPROVE/i.test(sec.output), qualOk: /VERDICT:\s*APPROVE/i.test(qual.output) },
      }),
    );
    const secParsed = parseFindings(sec.output);
    const qualParsed = parseFindings(qual.output);
    // P2-015: reviewers are LLMs — findings citing files/lines that don't exist
    // (or snippets absent from the diff) are mechanically dropped. A verdict
    // whose findings all fail verification degenerates to an effective APPROVE.
    const secVerified = verifyFindings(secParsed, ws, diff);
    const qualVerified = verifyFindings(qualParsed, ws, diff);
    for (const d of secVerified.dropped) logHallucination(t.id, "security", d);
    for (const d of qualVerified.dropped) logHallucination(t.id, "quality", d);
    const approve = (o: string) => /VERDICT:\s*APPROVE/i.test(o);
    const allDropped = (o: string, v: { kept: string[]; dropped: string[] }) =>
      /VERDICT:\s*REQUEST_CHANGES/i.test(o) && v.dropped.length > 0 && v.kept.length === 0;
    const secOk = approve(sec.output) || allDropped(sec.output, secVerified);
    const qualOk = approve(qual.output) || allDropped(qual.output, qualVerified);
    if (allDropped(sec.output, secVerified) || allDropped(qual.output, qualVerified)) {
      console.log(
        JSON.stringify({
          ts: nowLocalISO(),
          level: "info",
          msg: "review findings all unverifiable → effective approve",
          data: { task: t.id, round },
        }),
      );
    }
    emit("phase", { task: t.id, phase: "reviewers-done", ok: secOk && qualOk });
    if (secOk && qualOk) {
      emit("phase", { task: t.id, phase: "gatekeeper" });
      // serialized across slots: fixed battery ports + main push (P1-006)
      merged = await runGateExclusive(() => gatekeeper(cfg, ws, t, state, build.output, startedAtMs));
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
          await runScribe(ws, t, diff, findings);
        } catch (err) {
          console.log(
            JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "scribe crashed", data: { task: t.id, err: String(err).slice(0, 200) } }),
          );
        }
      }
      if (!merged) return { ok: false, detail: "gatekeeper rejected: eval battery or invariants failed" };
    } else {
      // only verified findings reach the builder prompt (P2-015)
      findings = [...(secOk ? [] : secVerified.kept), ...(qualOk ? [] : qualVerified.kept)].join("\n");
      if (round === cfg.maxReviewRounds) {
        return { ok: false, detail: `max review rounds reached — findings: ${findings.slice(0, 400)}` };
      }
    }
  }
  return { ok: true, detail: `task ${t.id} merged`, sha: headSha(ws), touchedUi };
}

/** P2-015: findings are the bullet lines after (or near) the verdict marker. */
export function parseFindings(output: string): string[] {
  const idx = output.search(/VERDICT:\s*REQUEST_CHANGES/i);
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
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const f of findings) {
    if (findingResolves(f, ws, diff)) kept.push(f);
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
const FILE_CITE_RE = new RegExp(`(\\b[\\w@][\\w@./+-]*\\.(?:${KNOWN_EXT}))(?::(\\d+))?`, "g");
const SNIPPET_RES = [/"([^"\n]{6,})"/g, /`([^`\n]{6,})`/g];

function findingResolves(finding: string, ws: string, diff: string): boolean {
  // URLs are not file citations; they would only produce phantom paths
  const cleaned = finding.replace(/https?:\/\/\S+/g, " ");
  const fileCites: FileCite[] = [...cleaned.matchAll(FILE_CITE_RE)].map((m) => ({
    path: m[1] ?? "", // group 1 always matches when the regex matched
    line: m[2] !== undefined ? Number(m[2]) : undefined,
  }));
  if (fileCites.length > 0) return fileCites.every((c) => pathResolves(ws, c.path, c.line));
  return SNIPPET_RES.some((re) => [...cleaned.matchAll(re)].some((m) => m[1] !== undefined && diff.includes(m[1])));
}

function pathResolves(ws: string, rawPath: string, line: number | undefined): boolean {
  // unified-diff prefixes + traversal attempts are never valid citations
  const rel = rawPath.replace(/^(?:\.\/)+/, "").replace(/^(?:a|b)\//, "");
  if (rel.includes("..")) return false;
  let lines: string[];
  try {
    if (!existsSync(join(ws, rel))) return false;
    lines = readFileSync(join(ws, rel), "utf8").split("\n");
  } catch {
    return false;
  }
  if (line === undefined) return true;
  const l = lines[line - 1];
  return l !== undefined && l.trim().length > 0;
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
  // cross-slot gate lock (P1-006).
  const rerunResults = new Map<string, { ok: boolean; output: string }>();
  const requireShots = needsUiEvidence(t.area, renderTouched);
  const evidence = verifyEvidence(ws, builderOutput, requireShots, startedAtMs, (cmd, cwd) => {
    const cached = rerunResults.get(cmd);
    if (cached) return cached;
    const r = exec(cmd, { cwd, timeoutMin: 20, allowFail: true });
    rerunResults.set(cmd, r);
    return r;
  });
  if (!evidence.ok) {
    recordGateFail(state, t.id, "evidence", evidence.detail);
    return false;
  }
  for (const [name, cmd] of steps) {
    // evidence already re-executed this exact command in this workspace — keep
    // its result; the step list uses the same canonical command strings
    const r = rerunResults.get(cmd) ?? exec(cmd, { cwd: ws, timeoutMin: 20, allowFail: true });
    if (!r.ok) {
      recordGateFail(state, t.id, name, r.output);
      return false;
    }
  }
  // merge via GitHub PR for audit trail
  const title = `pilot(${t.id}): ${t.title}`;
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
  markDone(ws, t.id, `merged by pilot ${nowLocalISO().slice(0, 10)}`);
  exec(`git add BACKLOG.md && git commit -qm "pilot(${t.id}): mark done" && git push -q origin main`, {
    cwd: ws,
    allowFail: true,
  });
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
