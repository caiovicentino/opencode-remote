#!/usr/bin/env node
/**
 * P2-271: workflow permissions collector and CI gate.
 *
 * Reads the real workflow files, normalizes every job by indentation (no
 * YAML library — the same hand-rolled approach the workflow-reading tests
 * already use), feeds the normalized list to the pure verdict in
 * scripts/workflowperms.ts and prints its report. A missing file, an
 * unreadable file and content that does not parse become a failed-read
 * entry instead of a thrown error, so a renamed workflow can never crash
 * the pipeline or — worse — silently approve; the pure verdict turns a
 * failed read into a warning (P2-271 rule 1).
 *
 * Exit codes: 1 only on a reject verdict (a broad write, a job without any
 * permissions declaration, or a scope outside the documented allowlist).
 * Warn and approve exit 0. The documented per-job allowlist lives in
 * scripts/workflow-scopes.json; see docs/security.md.
 *
 * Run: npx tsx scripts/check-workflow-perms.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  workflowPermsVerdict,
  type WorkflowJobPerms,
  type WorkflowScopeAllowlist,
} from "./workflowperms";

/** The real workflows the gate covers, repo-root relative. */
export const WORKFLOW_FILES: readonly string[] = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
];

/** Versioned per-job allowlist, one entry per workflow job. */
const ALLOWLIST_FILE = "scripts/workflow-scopes.json";

export interface ParsedWorkflow {
  /** Scopes declared in the top-level permissions block, if any. */
  fileScopes: string[];
  /** One entry per job under `jobs:`, in file order. */
  jobs: Array<{ job: string; scopes: string[] }>;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** A permissions scope line: `contents: read`, `packages: write`, ... */
function isScopeLine(line: string): boolean {
  return /^([a-z0-9-]+):\s*(read|write|none)\s*(#.*)?$/.test(line.trim());
}

/** Normalize a `key: value` permissions line into "key:value". */
function normalizeScope(line: string): string {
  const [key, value] = line.trim().split(/\s*:\s*/);
  return `${(key ?? "").trim()}:${(value ?? "").trim()}`;
}

/** Collect the scope lines of a nested block starting just after `lineNo`. */
function collectBlock(lines: readonly string[], lineNo: number, indent: number): string[] {
  const scopes: string[] = [];
  for (let i = lineNo + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (indentOf(line) <= indent) break;
    if (isScopeLine(line)) scopes.push(normalizeScope(line));
  }
  return scopes;
}

/**
 * Parse one workflow file's permission surface by indentation: the
 * top-level permissions block (if any) and every job's own block. Throws
 * only on shapes the gate refuses to guess — the caller turns that into a
 * failed read.
 */
export function parseWorkflowPermissions(text: string): ParsedWorkflow {
  const lines = text.split(/\r?\n/);
  const parsed: ParsedWorkflow = { fileScopes: [], jobs: [] };
  let jobsAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (indentOf(line) !== 0) continue;
    if (/^jobs:\s*(#.*)?$/.test(line.trim())) {
      jobsAt = i;
      break;
    }
    const inline = /^permissions:\s*(\S.*?)\s*$/.exec(line.trim());
    if (inline && inline[1]) {
      parsed.fileScopes = [inline[1].trim()];
      continue;
    }
    if (/^permissions:\s*(#.*)?$/.test(line.trim())) {
      parsed.fileScopes = collectBlock(lines, i, 0);
    }
  }
  if (jobsAt < 0) throw new Error("no top-level `jobs:` key found");
  // Job headers sit at exactly two spaces under `jobs:`; job-level keys at
  // four. Anything nested deeper (run blocks, env) never matches these.
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const ind = indentOf(line);
    if (ind === 0) break;
    if (ind !== 2) continue;
    const header = /^([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line.trim());
    if (!header) continue;
    const name = header[1] ?? "";
    let scopes: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const inner = lines[j] ?? "";
      if (inner.trim() === "") continue;
      const iind = indentOf(inner);
      if (iind <= 2) break;
      if (iind !== 4) continue;
      const inline = /^permissions:\s*(\S.*?)\s*$/.exec(inner.trim());
      if (inline && inline[1]) {
        const value = inline[1].trim();
        scopes = value === "{}" ? [] : [value];
        break;
      }
      if (/^permissions:\s*(#.*)?$/.test(inner.trim())) {
        scopes = collectBlock(lines, j, 4);
        break;
      }
    }
    parsed.jobs.push({ job: name, scopes });
  }
  return parsed;
}

/** Read one workflow; missing, unreadable and unparseable all fail the read. */
function readWorkflowJobs(path: string, repoRoot: string): WorkflowJobPerms[] {
  const file = path.replace(/^.*\//, "");
  let text: string;
  try {
    text = readFileSync(`${repoRoot}/${path}`, "utf8");
  } catch {
    return [{ file, job: "(unreadable)", jobScopes: [], fileScopes: [], readFailed: true }];
  }
  try {
    const parsed = parseWorkflowPermissions(text);
    return parsed.jobs.map((j) => ({
      file,
      job: j.job,
      jobScopes: j.scopes,
      fileScopes: parsed.fileScopes,
    }));
  } catch {
    return [{ file, job: "(unreadable)", jobScopes: [], fileScopes: [], readFailed: true }];
  }
}

/** Read the versioned allowlist; a broken file allows nothing (fail closed). */
function loadAllowlist(repoRoot: string): WorkflowScopeAllowlist {
  try {
    const raw = readFileSync(`${repoRoot}/${ALLOWLIST_FILE}`, "utf8");
    const data = JSON.parse(raw) as { jobs?: WorkflowScopeAllowlist };
    return data.jobs && typeof data.jobs === "object" ? data.jobs : {};
  } catch {
    return {};
  }
}

function main(): number {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const jobs = WORKFLOW_FILES.flatMap((path) => readWorkflowJobs(path, repoRoot));
  const report = workflowPermsVerdict(jobs, loadAllowlist(repoRoot));
  for (const line of report.lines) console.log(line);
  console.log(`workflow-perms: verdict ${report.outcome} (${jobs.length} job(s) checked)`);
  return report.outcome === "reject" ? 1 : 0;
}

// CLI guard: run the gate only when executed directly.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) process.exitCode = main();
