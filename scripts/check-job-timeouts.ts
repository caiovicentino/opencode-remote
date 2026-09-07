#!/usr/bin/env node
/**
 * P2-322: job-timeout collector and CI gate.
 *
 * Reads the real workflow files, reuses the exported indentation reader of
 * scripts/bootsmokeparity.ts unchanged to enumerate the jobs, extracts each
 * job-level `timeout-minutes` declaration (a four-space key inside the job
 * body — step-level timeouts sit deeper and never match) and feeds the
 * normalized list to the pure verdict in scripts/jobtimeouts.ts. A missing
 * file, an unreadable file and text that does not match the expected
 * workflow shape become an explicit unreadable entry instead of a thrown
 * error or — worse — a silent approval; the pure verdict fails closed on it.
 *
 * Every problem is printed in a single run. Exit codes: 1 only when there is
 * at least one problem (a job without a declared timeout, one that is not a
 * positive integer, one above the documented ceiling, or a failed read);
 * zero problems exit 0. The ceiling lives in scripts/jobtimeouts.ts and is
 * registered in docs/security.md.
 *
 * Run: npx tsx scripts/check-job-timeouts.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseWorkflowJobs } from "./bootsmokeparity";
import {
  JOB_TIMEOUT_CEILING_MINUTES,
  jobTimeoutProblems,
  type JobTimeoutDeclaration,
  type JobTimeoutFacts,
} from "./jobtimeouts";

/** The real workflows the gate covers, repo-root relative. */
export const TIMEOUT_WORKFLOW_FILES: readonly string[] = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
];

/** Job keys sit at exactly two spaces under `jobs:` — same shape bootsmokeparity reads. */
const JOB_KEY = /^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/;

/**
 * Normalize one raw `timeout-minutes:` value into the normalized declaration:
 * a plain digit string becomes `minutes` (zero included — the pure verdict
 * owns the positive-integer rule), anything else becomes `invalid` with the
 * raw text bounded to a short single-line snippet.
 */
export function normalizeTimeoutDeclaration(raw: string): JobTimeoutDeclaration {
  const value = (raw ?? "").trim();
  if (/^\d+$/.test(value)) return { kind: "minutes", minutes: Number(value) };
  return { kind: "invalid", raw: value.slice(0, 40) };
}

/**
 * Extract the job-level timeout declaration of every job of one workflow
 * text. Jobs are enumerated with the unchanged exported reader from
 * scripts/bootsmokeparity.ts; text with no recognizable `jobs:` block (or
 * zero jobs) fails closed into a single unreadable entry instead of an
 * empty, silently-approving list.
 */
export function collectJobTimeouts(text: string, file: string): JobTimeoutFacts[] {
  const jobs = parseWorkflowJobs(text);
  if (jobs.length === 0) {
    return [
      { file, job: "(unreadable)", timeout: { kind: "unreadable", reason: "no jobs block recognizable" } },
    ];
  }
  const declared = new Map<string, JobTimeoutDeclaration>();
  let inJobs = false;
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^jobs:\s*(?:#.*)?$/.test(line)) {
      inJobs = true;
      current = null;
      continue;
    }
    if (!inJobs) continue;
    if (line.trim() === "") continue;
    const jobKey = JOB_KEY.exec(line);
    if (jobKey) {
      current = jobKey[1] ?? null;
      continue;
    }
    if (!line.startsWith(" ")) {
      current = null; // dedent to column 0 — the jobs block is over
      continue;
    }
    if (current === null) continue;
    const m = /^ {4}timeout-minutes:\s*(\S.*?)\s*(?:#.*)?$/.exec(line);
    if (m && m[1] && !declared.has(current)) declared.set(current, normalizeTimeoutDeclaration(m[1]));
  }
  return jobs.map((job) => ({ file, job: job.name, timeout: declared.get(job.name) ?? { kind: "absent" } }));
}

function main(): number {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const facts: JobTimeoutFacts[] = [];
  for (const path of TIMEOUT_WORKFLOW_FILES) {
    const file = path.replace(/^.*\//, "");
    let text: string;
    try {
      text = readFileSync(`${repoRoot}/${path}`, "utf8");
    } catch {
      facts.push({ file, job: "(unreadable)", timeout: { kind: "unreadable", reason: "file missing or unreadable" } });
      continue;
    }
    facts.push(...collectJobTimeouts(text, file));
  }
  const problems = jobTimeoutProblems(facts);
  for (const problem of problems) console.log(problem);
  console.log(
    problems.length === 0
      ? `job-timeouts: OK — every job declares a positive-integer timeout-minutes within the ${JOB_TIMEOUT_CEILING_MINUTES}-minute ceiling (${facts.length} job(s) checked)`
      : `job-timeouts: ${problems.length} problem(s) found`,
  );
  return problems.length > 0 ? 1 : 0;
}

// CLI guard: run the gate only when executed directly.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) process.exitCode = main();
