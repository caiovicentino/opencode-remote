import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { agentStream, exec, runAgent, runAgentForRole } from "./runner";
import { log, nowLocalISO } from "./log";
import { notifySupervisor } from "./notify";
import { emit } from "./events";
import { addTask, nextId } from "./backlog";
import { landMetaCommit } from "./metapush";
import { writeSandboxConfig } from "./pipeline";
import { saveState, touchHeartbeat, type PilotConfig, type PilotState } from "./state";

/**
 * P3-052 — nightly computer-use explorer. A vision agent drives the real
 * desktop app through the P1-051 harness (tools/desktop.mjs) like a first-time
 * user: onboarding, complete flows, deliberate error states. Findings become
 * BACKLOG.md lines with an attached screenshot and a severity. The layer is
 * strictly non-blocking: every failure path is log-only and can never fail a
 * merge or the scheduler loop.
 *
 * P2-105 — closed product-review loop: the run now captures a MANDATORY set of
 * six stable-named journey shots (first boot, pairing, chat, artifact pane,
 * browser pane, Mission Control) and, after the exploration, dispatches the
 * tier-B FABLE product reviewer over those shots + docs/PRODUCT.md. Its top-10
 * improvements land as P3 backlog lines (refill candidates) and surface in
 * events.jsonl / the dashboard as "product review" events.
 */

/** Hard per-run caps — the explorer's cost must stay predictable. */
export const EXPLORER_MAX_STEPS = 24; // harness commands the agent may run
export const EXPLORER_MAX_FINDINGS = 5; // backlog lines inserted per run
export const EXPLORER_TIMEOUT_MIN = 25; // agent wall-clock budget
/** Push retry budget: concurrent researcher/scribe pushes can move origin/main. */
export const EXPLORER_PUSH_RETRIES = 3;
export const EXPLORER_PUSH_WAIT_MS = 3_000;

/** P2-105: the fable product-review pass — budget, marker and output contract. */
export const FABLE_MARKER = "FABLE: DONE";
export const FABLE_MAX_FINDINGS = 10;
export const FABLE_TIMEOUT_MIN = 15;

export const EXPLORER_SEVERITIES = new Set(["high", "medium", "low"]);

/**
 * P2-105: the mandatory per-run journey shot set. Every explorer run must
 * leave exactly these six PNGs (stable names, one per journey step) in the
 * shots directory — they are the visual evidence the fable review consumes.
 */
export const JOURNEY_STEPS = [
  "first-boot",
  "pairing",
  "chat",
  "artifact-pane",
  "browser-pane",
  "mission-control",
] as const;
export type JourneyStep = (typeof JOURNEY_STEPS)[number];

/** Stable shot name for a journey step on a given day (digits-only date). */
export function journeyShotName(step: JourneyStep, today: string): string {
  return `journey-${step}-${today.replace(/[^0-9]/g, "")}.png`;
}

export interface ExplorerFinding {
  title: string;
  severity: string;
  area: string;
  shot: string;
  detail: string;
}

/** P2-105: one prioritized improvement distilled by the fable review pass. */
export interface FableFinding {
  title: string;
  priority: string; // P1 | P2 | P3 (product priority, not the task priority)
  shot: string; // journey screenshot the improvement comes from
  where: string; // file:line reference in the repo, or "" when unknown
  detail: string;
  area: string;
}

/** Shots land outside the repo so agent runs never dirty the worktree. */
export function explorerShotsDir(): string {
  return join(homedir(), ".opencode-remote", "pilot", "shots", "explorer");
}

/**
 * P1-071: a fresh-state explorer run keys its own `OCR_DESKTOP_SESSION` —
 * digits only, no spaces, safe as a /tmp session-dir suffix. Each day gets a
 * session name never used before, so `tools/desktop.mjs`'s keeper spawns fresh
 * and `hermeticEnv()` mints a brand-new temp userData: a true first install,
 * never a reused keeper of a previous run.
 */
export function explorerSessionName(today: string): string {
  return `explorer-fresh-${today.replace(/[^0-9]/g, "")}`;
}

/**
 * Pure parser for the agent's structured output. A finding is only kept when
 * it has a title, a known severity and a screenshot that actually exists on
 * disk (evidence is the point of the exercise); unknown areas degrade to ""
 * (serial scheduling) instead of dropping the finding. Duplicate titles are
 * deduped case-insensitively, and `max` enforces the per-run budget.
 */
export function parseExplorerFindings(
  output: string,
  opts: { exists?: (path: string) => boolean; max?: number } = {},
): ExplorerFinding[] {
  const exists = opts.exists ?? existsSync;
  const max = opts.max ?? EXPLORER_MAX_FINDINGS;
  const findings: ExplorerFinding[] = [];
  const seen = new Set<string>();
  const blocks = output.split(/^\s*EXPLORER: FINDING\s*$/m).slice(1);
  for (const block of blocks) {
    const field = (name: string): string => {
      const m = new RegExp(`^\\s*${name}:\\s*(.+)$`, "m").exec(block);
      return (m?.[1] ?? "").trim();
    };
    const title = field("title").replace(/\s+/g, " ").slice(0, 120);
    const shot = field("shot").replace(/\s+/g, "");
    const detail = field("detail").replace(/\s+/g, " ").slice(0, 500);
    const severityRaw = field("severity").toLowerCase();
    const areaRaw = field("area").toLowerCase();
    if (!title || !detail) continue;
    if (!EXPLORER_SEVERITIES.has(severityRaw)) continue;
    if (!shot || !exists(shot)) continue; // no real evidence → not a finding
    const dedupeKey = title.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    findings.push({
      title,
      severity: severityRaw,
      area: ["ui", "daemon", "desktop", "infra", "relay"].includes(areaRaw) ? areaRaw : "",
      shot,
      detail,
    });
    if (findings.length >= max) break;
  }
  return findings;
}

/**
 * P2-105: pure parser for the fable review's structured output. Same
 * fail-closed contract as parseExplorerFindings (P1-103 lesson): a finding is
 * only kept when it has a title, a known product priority, a detail and an
 * evidence screenshot that actually exists on disk — anything ambiguous is
 * dropped, never guessed. `where` (file:line) is free text capped at 120
 * chars; unknown areas degrade to "" (serial scheduling). Duplicate titles are
 * deduped case-insensitively and `max` enforces the per-run budget.
 */
export function parseFableFindings(
  output: string,
  opts: { exists?: (path: string) => boolean; max?: number } = {},
): FableFinding[] {
  const exists = opts.exists ?? existsSync;
  const max = opts.max ?? FABLE_MAX_FINDINGS;
  const findings: FableFinding[] = [];
  const seen = new Set<string>();
  const blocks = output.split(/^\s*FABLE: FINDING\s*$/m).slice(1);
  for (const block of blocks) {
    const field = (name: string): string => {
      const m = new RegExp(`^\\s*${name}:\\s*(.+)$`, "m").exec(block);
      return (m?.[1] ?? "").trim();
    };
    const title = field("title").replace(/\s+/g, " ").slice(0, 120);
    const shot = field("evidence").replace(/\s+/g, "");
    const where = field("where").replace(/\s+/g, " ").slice(0, 120);
    const detail = field("detail").replace(/\s+/g, " ").slice(0, 500);
    const priorityRaw = field("priority").toUpperCase();
    const areaRaw = field("area").toLowerCase();
    if (!title || !detail) continue;
    if (!["P1", "P2", "P3"].includes(priorityRaw)) continue;
    if (!shot || !exists(shot)) continue; // no real evidence → not a finding
    const dedupeKey = title.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    findings.push({
      title,
      priority: priorityRaw,
      area: ["ui", "daemon", "desktop", "infra", "relay"].includes(areaRaw) ? areaRaw : "",
      shot,
      where,
      detail,
    });
    if (findings.length >= max) break;
  }
  return findings;
}

/**
 * Spec text handed to addTask: detail + evidence + trailing area tag. The
 * `(area: ...)` suffix MUST stay the last thing on the line — the scheduler's
 * AREA_RE anchors there.
 */
export function explorerSpec(f: ExplorerFinding): string {
  return `${f.detail} (severity: ${f.severity}, evidence: ${f.shot})${f.area ? ` (area: ${f.area})` : ""}`;
}

/**
 * P2-105: spec text for a fable improvement. The `(area: ...)` suffix MUST
 * stay the last thing on the line — the scheduler's AREA_RE anchors there.
 */
export function fableSpec(f: FableFinding): string {
  const where = f.where ? `, where: ${f.where}` : "";
  return `${f.detail} (priority: ${f.priority}, evidence: ${f.shot}${where})${f.area ? ` (area: ${f.area})` : ""}`;
}

/** Injectable sinks for commitAndPushFindings (unit battery pins the semantics). */
export interface PushIo {
  exec: (cmd: string) => { ok: boolean; output: string };
  sleep: (ms: number) => Promise<void>;
}

/** Shared landing core: apply() inserts the BACKLOG lines, the meta-PR lands. */
async function landFindings(
  ws: string,
  message: string,
  io: PushIo,
  attempts: number,
  apply: () => { action: "apply" | "noop" | "abort" },
): Promise<boolean> {
  const result = await landMetaCommit(
    ws,
    io,
    { files: ["BACKLOG.md"], message, guardFile: "BACKLOG.md", apply },
    attempts,
  );
  return result === "pushed";
}

/**
 * Land the findings as a BACKLOG.md commit on the `pilot/meta` PR branch
 * (P1-076). The addTask insertions are re-applied inside every attempt — the
 * `checkout -B` rewind wipes prior edits, and nextId derives from the rewound
 * file so retried commits are byte-identical. Returns true only when the
 * landing actually armed (or completed) the PR merge.
 */
export async function commitAndPushFindings(
  ws: string,
  findings: ExplorerFinding[],
  message: string,
  io: PushIo,
  attempts: number = EXPLORER_PUSH_RETRIES,
): Promise<boolean> {
  return landFindings(ws, message, io, attempts, () => {
    for (const f of findings) {
      const id = nextId(ws, "P3");
      addTask(ws, id, "P3", `[explorer][${f.severity}] ${f.title}`, explorerSpec(f));
    }
    return { action: "apply" };
  });
}

/**
 * P2-105: land the fable product-review improvements as P3 backlog lines
 * (`[fable][<priority>]`) — the strategist's refill picks them up as
 * candidates exactly like the explorer's own findings.
 */
export async function commitAndPushFableFindings(
  ws: string,
  findings: FableFinding[],
  message: string,
  io: PushIo,
  attempts: number = EXPLORER_PUSH_RETRIES,
): Promise<boolean> {
  return landFindings(ws, message, io, attempts, () => {
    for (const f of findings) {
      const id = nextId(ws, "P3");
      addTask(ws, id, "P3", `[fable][${f.priority}] ${f.title}`, fableSpec(f));
    }
    return { action: "apply" };
  });
}

/** Injectable sinks for runExplorer — scripts/explorer-proof.ts (committed
 * proof driver) runs the real flow against a hermetic scratch workspace and
 * injects a no-op save so the production state.json is never touched. */
export interface ExplorerIo {
  save?: (st: PilotState) => void;
}

/**
 * Once-per-day guard: claim today's run in `state` and persist it BEFORE the
 * agent spawns — a crash mid-run must not re-run it same-day. Returns false
 * when today's run was already claimed (no save, no run). Extracted from
 * runExplorer so the battery can pin the persistence property without
 * spawning an agent.
 */
export function claimExplorerRun(state: PilotState, today: string, save: (st: PilotState) => void = saveState): boolean {
  if (state.explorerLast === today) return false;
  state.explorerLast = today;
  save(state);
  return true;
}

/**
 * One nightly run. Once-per-day guarded via state, budget-capped, and
 * non-blocking: any error is logged, never rethrown. P2-105: after the
 * exploration the tier-B fable product review consumes the six journey shots
 * and files its top-10 improvements as P3 refill candidates.
 */
export async function runExplorer(cfg: PilotConfig, state: PilotState, io: ExplorerIo = {}): Promise<void> {
  const today = nowLocalISO().slice(0, 10);
  if (!claimExplorerRun(state, today, io.save ?? saveState)) return;
  const shotsDir = explorerShotsDir();
  try {
    mkdirSync(shotsDir, { recursive: true });
    // P2-105 bug fix: the nightly flow lands experience-maintenance through the
    // meta-PR right before this pass, and landMetaCommit's `git clean -qfd`
    // wipes the workspace's untracked opencode.json — without it the headless
    // agent has no sandbox config and opencode rejects its first bash call
    // (observed 2026-09-03: "explorer did not finish", no done event ever
    // reached events.jsonl). Re-writing it here makes the run self-healing.
    writeSandboxConfig(cfg.workspace);
    // P1-071: one fresh session per run — first-boot journey, clean userData.
    const session = explorerSessionName(today);
    log("info", "nightly explorer starting", { session });
    const r = await runAgent(explorerPrompt(shotsDir, session, today), {
      cwd: cfg.workspace,
      timeoutMin: EXPLORER_TIMEOUT_MIN,
      label: "explorer",
      // the explorer blocks the scheduler loop for up to ~25min — keep the
      // 3min self-watchdog fed while agent stdout flows (same concern as P1-035)
      onStdout: (chunk) => {
        touchHeartbeat();
        agentStream("explorer")(chunk);
      },
    });
    const done = r.output.includes("EXPLORER: DONE");
    emit("phase", { task: "explorer", phase: done ? "done" : "failed", ok: done });
    if (!done) {
      log("warn", "explorer did not finish", { tail: r.output.slice(-200) });
    } else {
      const findings = parseExplorerFindings(r.output, { max: EXPLORER_MAX_FINDINGS });
      if (findings.length === 0) {
        log("info", "explorer produced no backed findings");
      } else {
        const inserted = findings.length;
        // the landing's git clean wipes opencode.json again — the fable pass
        // below needs it re-written either way, and a failed landing must not
        // stop the product review
        const push = await commitAndPushFindings(
          cfg.workspace,
          findings,
          `pilot(explorer): ${inserted} finding(s) from nightly run ${today}`,
          {
            exec: (cmd) => exec(cmd, { cwd: cfg.workspace, allowFail: true }),
            sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
          },
        );
        if (!push) {
          log("warn", "explorer backlog push failed (non-blocking)", { findings: inserted });
        } else {
          log("info", "explorer findings filed", { findings: inserted });
          emit("phase", { task: "explorer", phase: "filed", ok: true, detail: `${inserted} finding(s)` });
          void notifySupervisor(
            "explorer — nightly run",
            true,
            findings.map((f) => `[${f.severity}] ${f.title}`).join(" | ").slice(0, 300),
          ).catch(() => {});
        }
      }
    }
    // P2-105: closed product-review loop — fable (tier B when configured)
    // reviews the six journey shots against docs/PRODUCT.md and its top-10
    // improvements land as P3 refill candidates. Strictly non-blocking.
    await runFableReview(cfg, shotsDir, today);
  } catch (err) {
    log("warn", "explorer failed (non-blocking)", { err: String(err).slice(0, 200) });
  }
}

/**
 * P2-105: the six stable journey shots of this run, in step order. A step
 * whose PNG is missing is skipped — the fable review only runs on real
 * evidence (and the proof driver asserts all six).
 */
function takenJourneyShots(shotsDir: string, today: string): string[] {
  return JOURNEY_STEPS.map((step) => join(shotsDir, journeyShotName(step, today))).filter((p) => existsSync(p));
}

/**
 * The fable product-review pass: dispatch the judgment role over the journey
 * shots + docs/PRODUCT.md, parse its top-10 improvements and land them as P3
 * backlog lines (refill candidates). Every failure is log-only.
 */
export async function runFableReview(cfg: PilotConfig, shotsDir: string, today: string): Promise<void> {
  try {
    const shots = takenJourneyShots(shotsDir, today);
    if (shots.length < JOURNEY_STEPS.length) {
      log("info", "fable review skipped — journey shot set incomplete", {
        expected: JOURNEY_STEPS.length,
        found: shots.length,
      });
      return;
    }
    writeSandboxConfig(cfg.workspace); // the explorer landing's git clean wiped it
    const r = await runAgentForRole(
      "fable",
      fablePrompt(shots),
      {
        cwd: cfg.workspace,
        timeoutMin: FABLE_TIMEOUT_MIN,
        label: "fable",
        models: cfg.models,
        marker: FABLE_MARKER,
        // tier-B mounts the shots dir read-mostly so the reviewer can actually
        // look at the evidence (P2-105 narrows the P1-059 no-~/.opencode-remote
        // mount rule to this evidence-only directory)
        extraDirs: [shotsDir],
        onStdout: agentStream("fable"),
      },
    );
    const finished = r.output.includes(FABLE_MARKER);
    const findings = finished ? parseFableFindings(r.output, { max: FABLE_MAX_FINDINGS }) : [];
    emit("phase", {
      task: "explorer",
      phase: "product-review",
      ok: finished,
      detail: finished
        ? `fable: ${findings.length} improvement(s) over ${shots.length} journey shot(s)`
        : `fable review did not finish — ${r.output.slice(-120)}`,
    });
    if (!finished) {
      log("warn", "fable review did not finish", { tail: r.output.slice(-200) });
      return;
    }
    if (findings.length === 0) {
      log("info", "fable review produced no backed improvements");
      return;
    }
    const push = await commitAndPushFableFindings(
      cfg.workspace,
      findings,
      `pilot(fable): ${findings.length} improvement(s) from product review ${today}`,
      {
        exec: (cmd) => exec(cmd, { cwd: cfg.workspace, allowFail: true }),
        sleep: (ms) => new Promise<void>((r2) => setTimeout(r2, ms)),
      },
    );
    if (!push) {
      log("warn", "fable backlog push failed (non-blocking)", { findings: findings.length });
      return;
    }
    log("info", "fable improvements filed", { findings: findings.length });
    emit("phase", {
      task: "explorer",
      phase: "product-review-filed",
      ok: true,
      detail: `${findings.length} fable improvement(s) → BACKLOG P3 (refill candidates)`,
    });
    void notifySupervisor(
      "fable — product review",
      true,
      findings.slice(0, 3).map((f) => `[${f.priority}] ${f.title}`).join(" | ").slice(0, 300),
    ).catch(() => {});
  } catch (err) {
    log("warn", "fable review failed (non-blocking)", { err: String(err).slice(0, 200) });
  }
}

export function explorerPrompt(shotsDir: string, session: string, today: string = nowLocalISO().slice(0, 10)): string {
  const shotList = JOURNEY_STEPS.map((s) => `- ${journeyShotName(s, today)} (${s})`).join("\n");
  return `You are the EXPLORER agent of the opencode-remote autonomous pipeline (nightly computer-use pass).
Your job: review the FIRST-BOOT JOURNEY of the real desktop app with a clean state —
exactly what a brand-new user sees on first install — and report product-premise,
UX and robustness findings.

The app is driven with the hermetic harness from the repo root (it launches the Electron
app with no production daemon — safe to poke). The run's session name and screenshots
directory are listed in the SESSION PARAMETERS block at the end — the launch is a TRUE
first boot: fresh temp userData, no leftover state.

If apps/web/dist/index.html or apps/desktop/dist-electron/main.js is missing, build
them first (does NOT count toward the harness budget):
  npm run build --workspace @ocr/web && npm run build --workspace @ocr/desktop

HARD BUDGET: at most ${EXPLORER_MAX_STEPS} harness commands this run — count them and stop.
Do not run any other commands against the app. Do not git commit or push anything.

MANDATORY JOURNEY SHOT SET — this run MUST leave all six PNGs on disk, each named
EXACTLY as listed in the SESSION PARAMETERS block (stable names; a later automated
review consumes them). One shot per journey step:
  journey-first-boot-<YYYYMMDD>.png      (untouched first screen)
  journey-pairing-<YYYYMMDD>.png         (onboarding/pairing reached)
  journey-chat-<YYYYMMDD>.png            (conversation view as a first-time user)
  journey-artifact-pane-<YYYYMMDD>.png   (artifact surface open)
  journey-browser-pane-<YYYYMMDD>.png    (Browser pane with content)
  journey-mission-control-<YYYYMMDD>.png (Mission Control open)
A step whose screen cannot be reached still needs its shot: capture the closest
truthful state (the empty state, the entry point, or the error state) under that
exact name — an honest empty state is evidence, a missing file is not.

Journey structure (at most 10 harness commands per phase):

PHASE 1 — FIRST BOOT (the product premise):
- Your VERY FIRST harness command must capture the untouched first screen, before any
  interaction: open with a shot argument saved as journey-first-boot-<YYYYMMDD>.png
  (open takes an optional shot arg — do NOT run shot before open; the keeper is not
  up yet and a bare shot fails).
- If open reports reused:true, a stale keeper exists: close, then open once more
  (both count toward the budget).
- Then answer the premise questions from what the screen ACTUALLY shows, never invented:
  * Why does a local app show any auth/pairing ceremony on this screen — is it needed?
  * Is every flow reachable from first boot? Any dead ends with a clean state?
  * What are the empty states — do they guide the user or just sit blank?
- Explore onboarding/pairing as a first-time user: try an INVALID code and empty input,
  capture the error states, then save journey-pairing-<YYYYMMDD>.png.

PHASE 2 — IN-APP JOURNEY (same boot, capture the remaining four shots):
- chat: reach the conversation view as a first-time user (sending a message that queues
  offline counts) and save journey-chat-<YYYYMMDD>.png.
- artifact: open the artifact surface (split-pane or list) and save
  journey-artifact-pane-<YYYYMMDD>.png.
- browser: open the Browser pane with harmless local content (a file:// path is fine)
  and save journey-browser-pane-<YYYYMMDD>.png.
- mission control: open Mission Control and save journey-mission-control-<YYYYMMDD>.png.

PHASE 3 — SECOND BOOT, "daemon detected" (best-effort, same session):
- close the app, then boot again with the reconnecting knob (P1-053, existing harness
  env — no code changes; it shows the "first contact with a daemon" state)
- Compare: is the reconnecting/recovery state understandable on its own? Does recovery
  ever demand re-pairing? If phase 3 misbehaves, that is a finding like any other.
- close at the end of the run.

Every finding MUST be backed by a screenshot you actually took (PNG in the run's
screenshots directory). The first-boot screenshot is mandatory: findings about the
first boot that do not cite journey-first-boot-*.png are not journey findings.

Output format — for each finding, one block exactly like:
EXPLORER: FINDING
title: <one line, <=80 chars>
severity: <high|medium|low>
area: <ui|desktop|daemon|infra|relay>
shot: <absolute path of the screenshot>
detail: <what is wrong, why it matters, where — 1-3 sentences, single line>

Aim for at least 3 real findings — premise and journey findings first, quality over
quantity, no invented filler. If a finding cannot be seen in a screenshot, it is not
a finding. Report only what the shots actually show.

SESSION PARAMETERS (per-run variables — everything above is stable across runs):
- Session env prefix for EVERY harness command (unique to this run: fresh temp
  userData, no leftover state): OCR_DESKTOP_SESSION=${session}
- Screenshots directory for this run: ${shotsDir}
- Journey shot files for this run (exact names, all six mandatory):
${shotList}
- Harness commands (prefix each with the session env above):
    node tools/desktop.mjs open "<shot.png>" 1440 900
    node tools/desktop.mjs see "<text>"
    node tools/desktop.mjs click "<selector>"
    node tools/desktop.mjs type "<selector>" "<text>"
    node tools/desktop.mjs shot "<shot.png>" 1440 900
    node tools/desktop.mjs ipc "<js expr>"
    node tools/desktop.mjs close
- The phase-3 boot adds the reconnecting knob right after the session env:
  OCR_DESKTOP_SESSION=${session} OCR_DAEMON_FORCE_RECONNECTING=1 node tools/desktop.mjs open "<shot.png>" 1440 900
Your LAST line of output must be exactly: EXPLORER: DONE`;
}

/**
 * P2-105: prompt for the fable product-review pass — a tier-B judgment role
 * that reads the six journey shots (mounted via extraDirs) plus
 * docs/PRODUCT.md and distills the top-10 prioritized improvements with
 * verifiable file:line references.
 */
export function fablePrompt(shots: string[]): string {
  const list = shots.map((p) => `- ${p}`).join("\n");
  return `You are the FABLE product reviewer of the opencode-remote autonomous pipeline
(tier-B judgment pass). Tonight the explorer agent drove the real desktop app through a
first-boot journey with a clean state and captured the six journey screenshots below.

Your job: review the product VISUALLY, like a design-engineer pairing with the product
owner, and distill the TOP-10 prioritized improvements.

Inputs:
- Journey shots (Read each PNG — the evidence is mandatory reading):
${list}
- docs/PRODUCT.md in your cwd — the product north star. Ground every
  judgment in its principles (typography first, calm, artifact-first, detail that
  denotes care, visible parallelism, zero AI-generated look).

For each improvement:
- cite the screenshot(s) it comes from (evidence field),
- verify a concrete code anchor in this repository before citing it (file:line in the
  where field — use real files you opened; if no code anchor is verifiable, name the
  UI area instead, never an invented line number),
- rank it: P1 = hurts first-boot users today, P2 = clear quality gap, P3 = polish.
No generic praise — only actionable improvements a builder could implement.

Output format — for each improvement, one block exactly like:
FABLE: FINDING
title: <one line, <=100 chars>
priority: <P1|P2|P3>
evidence: <absolute path of the journey screenshot>
where: <path/to/file.ts:123 or a short UI-area name>
detail: <what to change and why it matters — 1-3 sentences, single line>

Aim for exactly 10, best first — real ones only, no filler. If an improvement cannot
be seen in a screenshot, it is not a product finding.

Your LAST line of output must be exactly: ${FABLE_MARKER}`;
}
