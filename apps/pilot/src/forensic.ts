/**
 * P1-059 — Weekly failure forensic (tier B): a strong model reads the last
 * failure lessons, the open gate-failure carryovers and the recent merge log,
 * and produces a failure taxonomy (patterns → root causes → recommendations)
 * written to ~/.opencode-remote/pilot/forensic-latest.md. Best-effort by
 * design: runs once per 7 days inside the nightly pass (first >= 2h idle gap
 * of the day — P1-095), never blocks
 * the loop, and its output is extracted from agent stdout — the agent itself
 * never gains access outside the workspace clone (anti-exfiltration rule).
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { agentStream, exec, runAgentForRole } from "./runner";
import { nowLocalISO } from "./log";
import { emit } from "./events";
import { digest } from "./push";
import { defaultLessonsFile, formatFailureLesson, readRecentFailureLessons } from "./failureLessons";
import { saveState, type PilotConfig, type PilotState } from "./state";

export const FORENSIC_MARKER = "FORENSIC:DONE";
export const FORENSIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Report path lives outside the repo, next to the other pilot state files. */
export function forensicReportPath(): string {
  return join(homedir(), ".opencode-remote", "pilot", "forensic-latest.md");
}

/**
 * Weekly guard: true when the forensic never ran, or the recorded date is
 * unparsable, or it is older than 7 days. Second run in the same week → false.
 */
export function forensicDue(forensicLast: string | undefined, now = Date.now()): boolean {
  if (!forensicLast) return true;
  const t = Date.parse(forensicLast);
  if (!Number.isFinite(t)) return true;
  return now - t >= FORENSIC_WINDOW_MS;
}

export interface GateFailSummary {
  task: string;
  step: string;
}

/** One line per open gate-failure carryover file, newest first, capped to keep
 * prompts sane — the sort by mtime descending happens BEFORE the cap so the
 * forensic evidence always carries the most recent carryovers (round-2 review). */
export function listGateFails(dir: string, max = 100): GateFailSummary[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const byRecency = files
    .map((f) => {
      let mtime = 0;
      try {
        mtime = statSync(join(dir, f)).mtimeMs;
      } catch {}
      return { f, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((t) => t.f);
  const out: GateFailSummary[] = [];
  for (const f of byRecency.slice(0, max)) {
    const task = f.replace(/\.json$/, "");
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { task?: string; step?: string };
      out.push({ task: typeof j.task === "string" && j.task ? j.task : task, step: typeof j.step === "string" ? j.step : "" });
    } catch {
      out.push({ task, step: "" });
    }
  }
  return out;
}

/** Pure prompt builder so the eval battery can pin the forensic contract. */
export function forensicPrompt(lessons: string, gateFails: GateFailSummary[], gitLog: string): string {
  return `You are the FORENSIC agent of the opencode-remote autonomous pipeline (weekly run).
Your job: turn the pipeline's raw failure record into a taxonomy the operator can act on.

Write the report in Markdown with EXACTLY these sections:
## Patterns
## Root causes
## Recommendations

Rules:
- Ground every pattern in the evidence below (task ids, failing steps, gate tails). Do not invent data.
- Recommendations must be concrete and actionable: prompt changes, gate steps, spec drafting rules, backlog hygiene.
- Be short: the operator reads this to fix the system, not to admire it.
- Do not read files outside your workspace; everything you need is in this prompt.

FAILURE LESSONS — the most recent blocked tasks (chronological):
${lessons || "(none recorded)"}

OPEN GATE FAILURES (per-task carryover files):
${gateFails.length ? gateFails.map((f) => `- ${f.task}: ${f.step || "unknown step"}`).join("\n") : "(none)"}

RECENT MERGES (git log --oneline -50):
${gitLog || "(unavailable)"}

Your LAST line must be exactly: ${FORENSIC_MARKER}`;
}

/**
 * The report is the agent stdout up to the completion marker (lastIndexOf: an
 * echoed instruction containing the marker must not truncate the body).
 */
export function extractReport(output: string, max = 20_000): string {
  const idx = output.lastIndexOf(FORENSIC_MARKER);
  const body = idx >= 0 ? output.slice(0, idx) : output;
  return body.trim().slice(0, max);
}

/**
 * Weekly tier-B forensic pass. Guard state is persisted BEFORE the agent runs
 * so a crash mid-run cannot re-run it the next day; the report file is written
 * by the runner (not the agent) from stdout. Any failure is logged and
 * swallowed — the nightly window must never block the scheduler loop.
 */
export async function runForensic(cfg: PilotConfig, st: PilotState): Promise<void> {
  if (!forensicDue(st.forensicLast)) return;
  st.forensicLast = nowLocalISO().slice(0, 10);
  saveState(st); // before the run: a crash must not re-run it the next day
  const log = (level: string, msg: string, data: unknown) =>
    console.log(JSON.stringify({ ts: nowLocalISO(), level, msg, data }));
  try {
    const lessons = readRecentFailureLessons(defaultLessonsFile(), 100).map((l) => formatFailureLesson(l)).join("\n");
    const gateFails = listGateFails(join(homedir(), ".opencode-remote/pilot/gate-fail"));
    const gitLog = exec("git log --oneline -50", { cwd: cfg.workspace, allowFail: true }).output;
    log("info", "weekly forensic starting", { lessons: lessons ? lessons.split("\n").length : 0, gateFails: gateFails.length });
    const r = await runAgentForRole(
      "forensic",
      forensicPrompt(lessons, gateFails, gitLog),
      {
        cwd: cfg.workspace,
        timeoutMin: 20,
        label: "forensic",
        onStdout: agentStream("forensic"),
        models: cfg.models,
        marker: FORENSIC_MARKER,
      },
    );
    const report = extractReport(r.output);
    if (!report) {
      log("warn", "forensic produced no report", { ok: r.ok, timedOut: r.timedOut });
      emit("phase", { task: "forensic", phase: "forensic", ok: false, detail: "no report" });
      return;
    }
    const path = forensicReportPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${report}\n`);
    const summary = report.split("\n").find((l) => l.trim()) ?? "";
    log("info", "forensic report written", { path, chars: report.length });
    emit("phase", { task: "forensic", phase: "forensic", ok: true, detail: summary.slice(0, 120) });
    if (cfg.digest) {
      await digest("Pilot forensic semanal", summary.slice(0, 160) || "taxonomia de falhas atualizada", "#/");
    }
  } catch (err) {
    log("warn", "forensic failed (best-effort)", { err: String(err).slice(0, 200) });
  }
}
