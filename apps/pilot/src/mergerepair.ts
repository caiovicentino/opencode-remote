/**
 * P3-341: pure conflict triage for the task-PR merge repair. No node builtins,
 * no fetch, no process — every I/O stays in pipeline.ts (purity is pinned by
 * the unit battery, P2-324 lesson). The rule: a conflict that is purely
 * additive text (docs, comment-only code hunks) resolves itself with a
 * deterministic union; anything semantic — or anything touching
 * constitution-protected paths — escalates to the operator, never pushed.
 */

/** Path classes for auto-resolution: `protected` covers constitution rule 3
 * (deploy/, scripts/invariants.ts), CI (.github/) and the pilot ledger
 * (BACKLOG.md) — never auto-resolved even when the path is `.md`. */
export type ConflictClass = "protected" | "docs" | "code";

export function classifyConflictPath(path: string): ConflictClass {
  const p = path.replace(/\\/g, "/");
  if (p === "BACKLOG.md" || p === "scripts/invariants.ts" || p.startsWith("deploy/") || p.startsWith(".github/")) {
    return "protected";
  }
  if (p.endsWith(".md")) return "docs";
  return "code";
}

/** One parsed region of a conflicted file: plain lines pass through as
 * strings; a `<<<<<<< … >>>>>>>` block becomes both sides (diff3 base is
 * parsed and discarded). */
export type Segment = string | { ours: string[]; theirs: string[] };

/**
 * Parse a file carrying git conflict markers into segments. Markers are
 * recognized at line start (`<<<<<<<`/`|||||||`/`>>>>>>>` possibly with a
 * label; the `=======` separator is matched exactly so setext-style
 * underlines in docs never masquerade as one). Nested markers, a missing or
 * out-of-order marker ⇒ null — the caller escalates, never throws.
 */
export function parseConflictedFile(content: string): Segment[] | null {
  const segments: Segment[] = [];
  let block: { ours: string[]; theirs: string[] } | null = null;
  // which side the cursor is on: "ours" (before |||||||/=======), "base"
  // (diff3 common ancestor, discarded), "theirs" (after =======)
  let side: "ours" | "base" | "theirs" = "ours";
  for (const line of content.split("\n")) {
    if (line.startsWith("<<<<<<<")) {
      if (block) return null; // nested marker
      block = { ours: [], theirs: [] };
      side = "ours";
      continue;
    }
    if (line.startsWith("|||||||")) {
      if (!block || side !== "ours") return null; // out of order
      side = "base";
      continue;
    }
    if (line === "=======") {
      if (!block || side === "theirs") return null; // orphan or repeated separator
      side = "theirs";
      continue;
    }
    if (line.startsWith(">>>>>>>")) {
      if (!block || side !== "theirs") return null; // unclosed ours / missing =======
      segments.push(block);
      block = null;
      side = "ours";
      continue;
    }
    if (block) {
      if (side === "ours") block.ours.push(line);
      else if (side === "theirs") block.theirs.push(line);
      // diff3 base lines are discarded
    } else {
      segments.push(line);
    }
  }
  if (block) return null; // unterminated conflict
  return segments;
}

const COMMENT_PREFIXES = ["//", "/*", "*", "*/", "#"];

/** True only when every line on BOTH sides is blank or a comment in the
 * languages this repo's hunks realistically carry (C-like, block-continuation,
 * shell/yaml/python). One real code line ⇒ false. */
export function isCommentOnlyHunk(h: { ours: string[]; theirs: string[] }): boolean {
  const side = (lines: string[]) =>
    lines.every((l) => {
      const t = l.trim();
      return t === "" || COMMENT_PREFIXES.some((p) => t.startsWith(p));
    });
  return side(h.ours) && side(h.theirs);
}

export type ResolveResult = { ok: true; content: string } | { ok: false; reason: string };

/**
 * Resolve one conflicted file: docs union every hunk (ours then theirs, no
 * separator, one copy when identical); code unions only comment-only hunks.
 * Protected paths, malformed markers and semantic code hunks refuse with a
 * reason.
 */
export function resolveConflictedFile(path: string, content: string): ResolveResult {
  const cls = classifyConflictPath(path);
  if (cls === "protected") return { ok: false, reason: "protected path" };
  const segments = parseConflictedFile(content);
  if (!segments) return { ok: false, reason: "malformed conflict markers" };
  const out: string[] = [];
  for (const seg of segments) {
    if (typeof seg === "string") {
      out.push(seg);
      continue;
    }
    const identical = seg.ours.join("\n") === seg.theirs.join("\n");
    if (!identical && cls === "code" && !isCommentOnlyHunk(seg)) {
      return { ok: false, reason: "code hunk changes semantics" };
    }
    if (identical) out.push(...seg.ours);
    else out.push(...seg.ours, ...seg.theirs);
  }
  return { ok: true, content: out.join("\n") };
}

export type RepairPlan =
  | { verdict: "resolve"; files: { path: string; content: string }[] }
  | { verdict: "escalate"; paths: string[]; reason: string };

/**
 * Evaluate every conflicted file (no short-circuit, input order is the
 * caller's `git diff --name-only` order — deterministic) and either resolve
 * all of them or escalate with every cause listed. An empty list escalates:
 * a conflict with no readable paths is never silently "resolved" away.
 */
export function repairPlan(files: { path: string; content: string }[]): RepairPlan {
  if (files.length === 0) {
    return { verdict: "escalate", paths: [], reason: "no conflicted paths reported" };
  }
  const resolved: { path: string; content: string }[] = [];
  const paths: string[] = [];
  const causes: string[] = [];
  for (const f of files) {
    const r = resolveConflictedFile(f.path, f.content);
    if (r.ok) resolved.push({ path: f.path, content: r.content });
    else {
      paths.push(f.path);
      const cause = `${f.path}: ${r.reason}`;
      if (!causes.includes(cause)) causes.push(cause);
    }
  }
  if (paths.length > 0) {
    return { verdict: "escalate", paths, reason: causes.join("; ") };
  }
  return { verdict: "resolve", files: resolved };
}
