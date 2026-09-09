#!/usr/bin/env node
/**
 * P3-348 — pure exit planner for the packaged boot smoke. The smoke used to
 * print its verdict and then hang until the runner timeout: on win32 the
 * Electron process tree / Playwright pipe survive closeApp() (which only
 * SIGKILLs the parent after the deadline) and keep the node event loop alive,
 * while finish() merely set process.exitCode instead of exiting. This module
 * computes the ordered, closed exit plan (kill-tree when needed, then a
 * deterministic process.exit) and runs it with injected dependencies, so the
 * unit battery proves the exit path without touching the OS.
 *
 * Pure by construction (same bar as packaged-boot-layout.mjs): no filesystem,
 * OS, path, network or child-process imports at all, no I/O — the caller
 * (packaged-boot.mjs) injects kill/exit.
 */

/**
 * Ordered exit plan from the observed facts:
 * - `kill-tree` (taskkill /T /F on the launched pid) only on win32, only when
 *   the child still looks alive and only for a positive integer pid — the
 *   whole tree must die, not just the parent;
 * - `exit` ALWAYS last, with the verdict code; anything that is not an
 *   integer (undefined/null/NaN after an early throw) maps to 1 — never an
 *   accidental success.
 */
export function exitPlan({ platform, exitCode, pid, childAlive } = {}) {
  const plan = [];
  if (platform === "win32" && childAlive === true && Number.isInteger(pid) && pid > 0) {
    plan.push({ kind: "kill-tree", pid });
  }
  plan.push({ kind: "exit", code: Number.isInteger(exitCode) ? exitCode : 1 });
  return plan;
}

/** Execute the plan in order: kill is best-effort (a throwing kill never
 * changes the code), exit is the final step and is called exactly once. */
export function runExitPlan(plan, { kill, exit }) {
  for (const step of (Array.isArray(plan) ? plan : [])) {
    if (step?.kind !== "exit") {
      try {
        kill(step.pid);
      } catch {}
      continue;
    }
    exit(step.code);
  }
}
