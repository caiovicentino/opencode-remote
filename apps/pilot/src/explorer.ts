import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { agentStream, exec, runAgent } from "./runner";
import { log, nowLocalISO } from "./log";
import { notifySupervisor } from "./notify";
import { emit } from "./events";
import { addTask, nextId } from "./backlog";
import { saveState, touchHeartbeat, type PilotConfig, type PilotState } from "./state";

/**
 * P3-052 — nightly computer-use explorer. A vision agent drives the real
 * desktop app through the P1-051 harness (tools/desktop.mjs) like a first-time
 * user: onboarding, complete flows, deliberate error states. Findings become
 * BACKLOG.md lines with an attached screenshot and a severity. The layer is
 * strictly non-blocking: every failure path is log-only and can never fail a
 * merge or the scheduler loop.
 */

/** Hard per-run caps — the explorer's cost must stay predictable. */
export const EXPLORER_MAX_STEPS = 24; // harness commands the agent may run
export const EXPLORER_MAX_FINDINGS = 5; // backlog lines inserted per run
export const EXPLORER_TIMEOUT_MIN = 25; // agent wall-clock budget
/** Push retry budget: concurrent researcher/scribe pushes can move origin/main. */
export const EXPLORER_PUSH_RETRIES = 3;
export const EXPLORER_PUSH_WAIT_MS = 3_000;

export const EXPLORER_SEVERITIES = new Set(["high", "medium", "low"]);

export interface ExplorerFinding {
  title: string;
  severity: string;
  area: string;
  shot: string;
  detail: string;
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
 * Spec text handed to addTask: detail + evidence + trailing area tag. The
 * `(area: ...)` suffix MUST stay the last thing on the line — the scheduler's
 * AREA_RE anchors there.
 */
export function explorerSpec(f: ExplorerFinding): string {
  return `${f.detail} (severity: ${f.severity}, evidence: ${f.shot})${f.area ? ` (area: ${f.area})` : ""}`;
}

/** Injectable sinks for commitAndPushFindings (unit battery pins the semantics). */
export interface PushIo {
  exec: (cmd: string) => { ok: boolean; output: string };
  sleep: (ms: number) => Promise<void>;
}

/**
 * Commit the BACKLOG.md edit and push origin/main with retry. The retry loop
 * (round 2 review): pushes land concurrently from the researcher/scribes, and
 * a one-shot push used to silently lose the findings on the next sync. Returns
 * true only when the push actually landed; commit failure aborts before any
 * push is attempted.
 */
export async function commitAndPushFindings(
  message: string,
  io: PushIo,
  attempts: number = EXPLORER_PUSH_RETRIES,
): Promise<boolean> {
  const add = io.exec(`git add BACKLOG.md && git commit -qm ${shq(message)}`);
  if (!add.ok) return false;
  for (let i = 1; i <= attempts; i++) {
    if (io.exec("git push -q origin main").ok) return true;
    if (i < attempts) await io.sleep(EXPLORER_PUSH_WAIT_MS);
  }
  return false;
}

/** POSIX single-quote escape (JSON.stringify is NOT shell quoting). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
 * non-blocking: any error is logged, never rethrown.
 */
export async function runExplorer(cfg: PilotConfig, state: PilotState, io: ExplorerIo = {}): Promise<void> {
  const today = nowLocalISO().slice(0, 10);
  if (!claimExplorerRun(state, today, io.save ?? saveState)) return;
  const shotsDir = explorerShotsDir();
  try {
    mkdirSync(shotsDir, { recursive: true });
    // P1-071: one fresh session per run — first-boot journey, clean userData.
    const session = explorerSessionName(today);
    log("info", "nightly explorer starting", { session });
    const r = await runAgent(explorerPrompt(shotsDir, session), {
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
      return;
    }
    const findings = parseExplorerFindings(r.output, { max: EXPLORER_MAX_FINDINGS });
    if (findings.length === 0) {
      log("info", "explorer produced no backed findings");
      return;
    }
    let inserted = 0;
    for (const f of findings) {
      const id = nextId(cfg.workspace, "P3");
      addTask(cfg.workspace, id, "P3", `[explorer][${f.severity}] ${f.title}`, explorerSpec(f));
      inserted++;
    }
    const push = await commitAndPushFindings(
      `pilot(explorer): ${inserted} finding(s) from nightly run ${today}`,
      {
        exec: (cmd) => exec(cmd, { cwd: cfg.workspace, allowFail: true }),
        sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      },
    );
    if (!push) {
      log("warn", "explorer backlog push failed (non-blocking)", { findings: inserted });
      return;
    }
    log("info", "explorer findings filed", { findings: inserted });
    emit("phase", { task: "explorer", phase: "filed", ok: true, detail: `${inserted} finding(s)` });
    void notifySupervisor(
      "explorer — nightly run",
      true,
      findings.map((f) => `[${f.severity}] ${f.title}`).join(" | ").slice(0, 300),
    ).catch(() => {});
  } catch (err) {
    log("warn", "explorer failed (non-blocking)", { err: String(err).slice(0, 200) });
  }
}

export function explorerPrompt(shotsDir: string, session: string): string {
  return `You are the EXPLORER agent of the opencode-remote autonomous pipeline (nightly computer-use pass).
Your job: review the FIRST-BOOT JOURNEY of the real desktop app with a clean state —
exactly what a brand-new user sees on first install — and report product-premise,
UX and robustness findings.

The app is driven with the hermetic harness from the repo root (it launches the Electron
app with no production daemon — safe to poke). Your session name below is unique to this
run, so the launch is a TRUE first boot: fresh temp userData, no leftover state:
  OCR_DESKTOP_SESSION=${session} node tools/desktop.mjs open "<shot.png>" 1440 900
  OCR_DESKTOP_SESSION=${session} node tools/desktop.mjs see "<text>"
  OCR_DESKTOP_SESSION=${session} node tools/desktop.mjs click "<selector>"
  OCR_DESKTOP_SESSION=${session} node tools/desktop.mjs type "<selector>" "<text>"
  OCR_DESKTOP_SESSION=${session} node tools/desktop.mjs shot "<shot.png>" 1440 900
  OCR_DESKTOP_SESSION=${session} node tools/desktop.mjs ipc "<js expr>"
  OCR_DESKTOP_SESSION=${session} node tools/desktop.mjs close

If apps/web/dist/index.html or apps/desktop/dist-electron/main.js is missing, build
them first (does NOT count toward the harness budget):
  npm run build --workspace @ocr/web && npm run build --workspace @ocr/desktop

HARD BUDGET: at most ${EXPLORER_MAX_STEPS} harness commands this run — count them and stop.
Do not run any other commands against the app. Do not git commit or push anything.

Journey structure (two boots, at most 10 harness commands per phase):

PHASE 1 — FIRST BOOT (the product premise):
- Your VERY FIRST harness command must capture the untouched first screen, before any
  interaction: open with a shot argument, one command:
    OCR_DESKTOP_SESSION=${session} node tools/desktop.mjs open "${shotsDir}/first-boot-<YYYYMMDD>.png" 1440 900
  (open takes an optional shot arg — do NOT run shot before open; the keeper is not
  up yet and a bare shot fails).
- If open reports reused:true, a stale keeper exists: close, then open once more
  (both count toward the budget).
- Then answer the premise questions from what the screen ACTUALLY shows, never invented:
  * Why does a local app show any auth/pairing ceremony on this screen — is it needed?
  * Is every flow reachable from first boot? Any dead ends with a clean state?
  * What are the empty states — do they guide the user or just sit blank?
- Explore onboarding/pairing as a first-time user: try an INVALID code and empty input,
  capture the error states.

PHASE 2 — SECOND BOOT, "daemon detected" (best-effort, same session):
- close the app, then boot again with the reconnecting knob (P1-053, existing harness
  env — no code changes; it shows the "first contact with a daemon" state):
    OCR_DESKTOP_SESSION=${session} OCR_DAEMON_FORCE_RECONNECTING=1 node tools/desktop.mjs open "<shot.png>" 1440 900
- Compare: is the reconnecting/recovery state understandable on its own? Does recovery
  ever demand re-pairing? If phase 2 misbehaves, that is a finding like any other.
- close at the end of the run.

Every finding MUST be backed by a screenshot you actually took (PNG in ${shotsDir}).
The first-boot screenshot is mandatory: findings about the first boot that do not cite
first-boot-*.png are not journey findings.

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
Your LAST line of output must be exactly: EXPLORER: DONE`;
}
