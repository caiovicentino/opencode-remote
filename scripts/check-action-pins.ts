#!/usr/bin/env node
/**
 * P2-278: action-reference collector and CI gate.
 *
 * Reads the real workflow files, normalizes every `uses:` reference by
 * indentation (no YAML library — the same hand-rolled approach the
 * workflow-reading tests already use), feeds the normalized list to the
 * pure verdict in scripts/actionpins.ts and prints its report. A missing
 * file, an unreadable file and content that does not parse become a
 * failed-read entry instead of a thrown error, so a renamed workflow can
 * never crash the pipeline or — worse — silently approve; the pure verdict
 * turns a failed read into a warning (P2-278 rule 1).
 *
 * Exit codes: 1 only on a reject verdict (a third-party action not pinned
 * to a full commit SHA without a still-valid exemption). Warn and approve
 * exit 0. The documented first-party owners live in
 * scripts/action-owners.json and the deadlined exemptions in
 * scripts/action-exemptions.json; see docs/security.md.
 *
 * Run: npx tsx scripts/check-action-pins.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  actionPinsVerdict,
  type ActionExemption,
  type ActionRef,
} from "./actionpins";

/** The real workflows the gate covers, repo-root relative. */
export const WORKFLOW_FILES: readonly string[] = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
];

/** Versioned lists: the first-party owners and the deadlined exemptions. */
const OWNERS_FILE = "scripts/action-owners.json";
const EXEMPTIONS_FILE = "scripts/action-exemptions.json";

export interface ParsedWorkflowRefs {
  /** One entry per `uses:` line, in file order. */
  refs: Array<{ job: string; owner: string; action: string; ref: string }>;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Parse one workflow file's `uses:` surface by indentation. Throws only on
 * shapes the gate refuses to guess (no top-level `jobs:` key) — the caller
 * turns that into a failed read.
 */
export function parseWorkflowActionRefs(text: string): ParsedWorkflowRefs {
  const lines = text.split(/\r?\n/);
  const parsed: ParsedWorkflowRefs = { refs: [] };
  let jobsAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i] ?? "") === 0 && /^jobs:\s*(#.*)?$/.test((lines[i] ?? "").trim())) {
      jobsAt = i;
      break;
    }
  }
  if (jobsAt < 0) throw new Error("no top-level `jobs:` key found");
  let job = "";
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const ind = indentOf(line);
    if (ind === 0) break;
    if (ind === 2) {
      const header = /^([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line.trim());
      if (header) job = header[1] ?? "";
      continue;
    }
    if (ind <= 2 || job === "") continue;
    const uses = /^(?:-\s+)?uses:\s*([^\s#]+)(?:\s*#\s*(\S+)\s*)?$/.exec(line.trim());
    if (!uses) continue;
    const value = uses[1] ?? "";
    // Container images are a different supply chain, not an action.
    if (value.startsWith("docker://")) continue;
    // Local actions of this very repository carry no owner/action split.
    if (value.startsWith("./") || value.startsWith("../")) {
      parsed.refs.push({ job, owner: "", action: value, ref: "" });
      continue;
    }
    const at = value.indexOf("@");
    const base = at >= 0 ? value.slice(0, at) : value;
    const ref = at >= 0 ? value.slice(at + 1) : "";
    const slash = base.indexOf("/");
    const owner = slash >= 0 ? base.slice(0, slash) : base;
    const action = slash >= 0 ? base.slice(slash + 1) : "";
    parsed.refs.push({ job, owner, action, ref });
  }
  return parsed;
}

/** Read one workflow; missing, unreadable and unparseable all fail the read. */
function readWorkflowRefs(path: string, repoRoot: string): ActionRef[] {
  const file = path.replace(/^.*\//, "");
  let text: string;
  try {
    text = readFileSync(`${repoRoot}/${path}`, "utf8");
  } catch {
    return [{ file, job: "(unreadable)", owner: "", action: "", ref: "", readFailed: true }];
  }
  try {
    const parsed = parseWorkflowActionRefs(text);
    return parsed.refs.map((r) => ({ file, job: r.job, owner: r.owner, action: r.action, ref: r.ref }));
  } catch {
    return [{ file, job: "(unreadable)", owner: "", action: "", ref: "", readFailed: true }];
  }
}

/** Read the versioned first-party owners; a broken file trusts nobody. */
function loadOwners(repoRoot: string): string[] {
  try {
    const data = JSON.parse(readFileSync(`${repoRoot}/${OWNERS_FILE}`, "utf8")) as {
      owners?: unknown;
    };
    return Array.isArray(data.owners) ? data.owners.filter((o): o is string => typeof o === "string") : [];
  } catch {
    return [];
  }
}

/** Read the versioned exemptions; a broken file exempts nothing (fail closed). */
function loadExemptions(repoRoot: string): ActionExemption[] {
  try {
    const data = JSON.parse(readFileSync(`${repoRoot}/${EXEMPTIONS_FILE}`, "utf8")) as {
      exemptions?: unknown;
    };
    return Array.isArray(data.exemptions) ? (data.exemptions as ActionExemption[]) : [];
  } catch {
    return [];
  }
}

function main(): number {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const refs = WORKFLOW_FILES.flatMap((path) => readWorkflowRefs(path, repoRoot));
  const report = actionPinsVerdict(refs, loadOwners(repoRoot), loadExemptions(repoRoot), Date.now());
  for (const line of report.lines) console.log(line);
  console.log(`action-pins: verdict ${report.outcome} (${refs.length} reference(s) checked)`);
  return report.outcome === "reject" ? 1 : 0;
}

// CLI guard: run the gate only when executed directly.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) process.exitCode = main();
