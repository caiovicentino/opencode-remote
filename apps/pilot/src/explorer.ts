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

/**
 * One nightly run. Once-per-day guarded via state, budget-capped, and
 * non-blocking: any error is logged, never rethrown.
 */
export async function runExplorer(cfg: PilotConfig, state: PilotState): Promise<void> {
  const today = nowLocalISO().slice(0, 10);
  if (state.explorerLast === today) return;
  state.explorerLast = today;
  saveState(state); // persisted before the run: a crash must not re-run it same-day
  const shotsDir = explorerShotsDir();
  try {
    mkdirSync(shotsDir, { recursive: true });
    log("info", "nightly explorer starting");
    const r = await runAgent(explorerPrompt(shotsDir), {
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

function explorerPrompt(shotsDir: string): string {
  return `You are the EXPLORER agent of the opencode-remote autonomous pipeline (nightly computer-use pass).
Your job: explore the REAL desktop app like a first-time user and report UX/robustness findings.

The app is driven with the hermetic harness from the repo root (it launches the Electron
app with no production daemon — safe to poke):
  OCR_DESKTOP_SESSION=explorer node tools/desktop.mjs open "${shotsDir}/01-boot.png" 1440 900
  OCR_DESKTOP_SESSION=explorer node tools/desktop.mjs see "<text>"
  OCR_DESKTOP_SESSION=explorer node tools/desktop.mjs click "<selector>"
  OCR_DESKTOP_SESSION=explorer node tools/desktop.mjs type "<selector>" "<text>"
  OCR_DESKTOP_SESSION=explorer node tools/desktop.mjs shot "${shotsDir}/NN-name.png" 1440 900
  OCR_DESKTOP_SESSION=explorer node tools/desktop.mjs ipc "<js expr>"
  OCR_DESKTOP_SESSION=explorer node tools/desktop.mjs close

If apps/web/dist/index.html or apps/desktop/dist-electron/main.js is missing, build
them first (does NOT count toward the harness budget):
  npm run build --workspace @ocr/web && npm run build --workspace @ocr/desktop

HARD BUDGET: at most ${EXPLORER_MAX_STEPS} harness commands this run — count them and stop.
Do not run any other commands against the app. Do not git commit or push anything.

How to explore (user mindset, not code mindset):
- Onboarding/pairing first: what does a brand-new user see? Try an INVALID pairing code
  and capture the error state. Try empty input. What happens after the error?
- Then complete flows: navigate every pane (Conversas, Artifacts, ...) from the pairing
  screen, open/close things, resize if the harness allows, look for dead ends.
- Deliberate error states: malformed input, double clicks, interactions while disconnected.
- Every finding MUST be backed by a screenshot you actually took (PNG in ${shotsDir}).

Output format — for each finding, one block exactly like:
EXPLORER: FINDING
title: <one line, <=80 chars>
severity: <high|medium|low>
area: <ui|desktop|daemon|infra|relay>
shot: <absolute path of the screenshot>
detail: <what is wrong, why it matters, where — 1-3 sentences, single line>

Aim for at least 3 real findings — quality over quantity, no invented filler. If a finding
cannot be seen in a screenshot, it is not a finding.
Your LAST line of output must be exactly: EXPLORER: DONE`;
}
