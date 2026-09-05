import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./runner";
import { landMetaCommit } from "./metapush";

// P1-076: the guard moved to metapush.ts (single home for the landing flow);
// re-exported here so existing importers keep working.
export { mayPush } from "./metapush";

export interface Task {
  id: string;
  priority: string;
  title: string;
  spec: string;
  /** P1-006 area tag `(area: ui|daemon|desktop|infra|relay)`; "" when untagged. */
  area: string;
  /** P1-060 size tag `(size: L)`; "S" when absent/unknown — scales budgets. */
  size?: TaskSize;
  line: string;
}

/** P1-060: task horizon. S/M keep the classic budgets; L unlocks long horizon. */
export type TaskSize = "S" | "M" | "L";

const BACKLOG = "BACKLOG.md";

/** Trailing area tag appended by the strategist: `... (area: ui)`. */
const AREA_RE = /\(area:\s*([A-Za-z][A-Za-z0-9_-]*)\)\s*$/;

/** P1-060 trailing size tag: `... (size: L)`. Unknown values never match. */
const SIZE_RE = /\(size:\s*([SML])\)\s*$/i;

/** P1-006: documented area vocabulary; unknown tags fall back to serial "". */
export const KNOWN_AREAS = new Set(["ui", "daemon", "desktop", "infra", "relay"]);

export function parseBacklog(md: string): Task[] {
  const ready = md.split(/^## /m).find((s) => s.startsWith("Ready")) ?? "";
  const tasks: Task[] = [];
  for (const line of ready.split("\n")) {
    const trimmed = line.trim();
    let body = trimmed;
    let area = "";
    let size: TaskSize | undefined;
    // P1-060: strip trailing tags right-to-left — (size:) and (area:) may
    // appear in either order and only a trailing occurrence counts, so a tag
    // mentioned mid-spec stays part of the spec text (parse never breaks).
    for (;;) {
      const am = AREA_RE.exec(body);
      if (am) {
        area = KNOWN_AREAS.has(am[1] ?? "") ? am[1]! : "";
        body = body.slice(0, am.index).trimEnd();
        continue;
      }
      const sm = SIZE_RE.exec(body);
      if (sm) {
        size = sm[1]!.toUpperCase() as TaskSize;
        body = body.slice(0, sm.index).trimEnd();
        continue;
      }
      break;
    }
    const m = /^- \[ \] \(([^)]+)\) \[(P\d)\] (.+?)(?: — spec: (.+))?$/.exec(body);
    if (m && m[1] && m[2] && m[3])
      tasks.push({ id: m[1], priority: m[2], title: m[3], spec: m[4] ?? "", area, size: size ?? "S", line: trimmed });
  }
  return tasks;
}

export function loadBacklog(repoDir: string): Task[] {
  return parseBacklog(readFileSync(join(repoDir, BACKLOG), "utf8"));
}

/** Mark a task as done: move its line from ## Ready to ## Done. */
export function markDone(repoDir: string, id: string, note: string) {
  const p = join(repoDir, BACKLOG);
  const md = readFileSync(p, "utf8");
  const re = new RegExp(`^(- \\[ \\] \\(${id}\\).*)$`, "m");
  const line = re.exec(md)?.[1];
  if (!line) return;
  const done = md.replace(re, "").replace(/\n{3,}/g, "\n\n");
  const updated = done.replace(
    /^## Done$/m,
    `## Done\n- [x] (${id}) ${line.replace(/^- \[ \] \([^)]+\) /, "")} — ${note}`,
  );
  writeFileSync(p, updated);
}

/**
 * P1-075: task ids recorded under `## Done` (`- [x] (ID) ...` lines). The
 * experience-memory nightly pass uses this set to archive harness lessons
 * whose bug already shipped. Pure: parses the md string.
 */
export function doneTaskIds(md: string): Set<string> {
  const start = md.search(/^## Done$/m);
  if (start < 0) return new Set();
  const rest = md.slice(start);
  const end = rest.search(/^## (?!Done)/m); // next section, if any
  const body = end >= 0 ? rest.slice(0, end) : rest;
  const out = new Set<string>();
  for (const m of body.matchAll(/^- \[x\] \(([^)]+)\)/gm)) out.add(m[1]!.trim());
  return out;
}

/**
 * P1-014 stop-loss: move a task line from ## Ready to a `## Blocked` section
 * (created before ## Done, or at the end of the file) with a one-line summary
 * of the last findings. Tri-state (R6): "applied" moves the line, "noop" means
 * the task is ALREADY under ## Blocked — the desired state is present, so a
 * meta-landing retry after a queued merge converges as success — and "missing"
 * means the line does not exist at all (a real failure).
 */
export type BacklogEditResult = "applied" | "noop" | "missing";

/** P2-142: outcome of the pure stop-loss edit — new markdown + result. */
export interface BlockTaskEditResult {
  /** Markdown after the edit; identical to the input for noop/missing. */
  text: string;
  result: BacklogEditResult;
}

/** A `## Name` header line and the span of its body inside the markdown. */
interface MdSection {
  name: string;
  start: number;
  bodyStart: number;
  end: number;
}

function sectionsOf(md: string): MdSection[] {
  const out: MdSection[] = [];
  const headers = [...md.matchAll(/^## (.+)$/gm)];
  for (let i = 0; i < headers.length; i++) {
    const m = headers[i]!;
    const start = m.index ?? 0;
    const afterHeader = start + m[0].length;
    const bodyStart = md[afterHeader] === "\n" ? afterHeader + 1 : afterHeader;
    const end = i + 1 < headers.length ? headers[i + 1]!.index ?? md.length : md.length;
    out.push({ name: (m[1] ?? "").trim(), start, bodyStart, end });
  }
  return out;
}

/**
 * P2-142: pure core of the stop-loss edit — markdown in, markdown out, no
 * disk access (blockTask only wires read/write around it). The task line
 * moves right below the FIRST existing `## Blocked` header; a header is
 * created only when none exists, before `## Done` or at the end of the file
 * (P1-014 behavior). In the same applied write, duplicate `## Blocked`
 * headers collapse into the first one — bodies stay in place, so task-line
 * order is preserved and no line is discarded — letting legacy multi-section
 * files self-normalize on the next real stop-loss write. "noop" now means
 * the line already lives under ANY `## Blocked` section, not just the first.
 */
export function blockTaskEdit(md: string, id: string, findings: string): BlockTaskEditResult {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(- \\[ \\] \\(${escaped}\\).*)$`, "m");
  const match = re.exec(md);
  if (!match) return { text: md, result: "missing" };
  const owner = sectionsOf(md).find((s) => s.start < match.index && match.index < s.end);
  if (owner?.name === "Blocked") return { text: md, result: "noop" }; // already blocked
  const summary = findings.replace(/\s+/g, " ").trim().slice(0, 200);
  const entry = `${match[1]} — ${summary}`;
  const removed = md.replace(re, "").replace(/\n{3,}/g, "\n\n");
  if (!/^## Blocked$/m.test(removed)) {
    // no section yet: create one before ## Done, or at the end of the file
    const updated = /^## Done$/m.test(removed)
      ? removed.replace(/^## Done$/m, () => `## Blocked\n${entry}\n\n## Done`)
      : `${removed.replace(/\s*$/, "")}\n\n## Blocked\n${entry}\n`;
    return { text: updated, result: "applied" };
  }
  // fold duplicate headers into the first: drop the extra `## Blocked` lines
  // while every body line stays in place (order preserved, nothing discarded)
  let seen = false;
  const collapsed = removed
    .split("\n")
    .filter((line) => {
      if (line !== "## Blocked") return true;
      if (seen) return false;
      seen = true;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { text: collapsed.replace(/^## Blocked$/m, () => `## Blocked\n${entry}`), result: "applied" };
}

export function blockTask(repoDir: string, id: string, findings: string): BacklogEditResult {
  const p = join(repoDir, BACKLOG);
  const out = blockTaskEdit(readFileSync(p, "utf8"), id, findings);
  if (out.result === "applied") writeFileSync(p, out.text);
  return out.result;
}

/** Add a task at the top of ## Ready (used by redteam findings). */
export function addTask(repoDir: string, id: string, priority: string, title: string, spec: string) {
  const p = join(repoDir, BACKLOG);
  const md = readFileSync(p, "utf8");
  const entry = `- [ ] (${id}) [${priority}] ${title} — spec: ${spec}`;
  const updated = md.replace(/^## Ready$/m, `## Ready\n${entry}`);
  writeFileSync(p, updated);
}

// ── Foreign mission: seed the pilot's BACKLOG.md format when absent ─────────

/** The sections every backlog edit in this module relies on. */
export const BACKLOG_SECTIONS = ["Ready", "Blocked", "Done"] as const;

/** Minimal BACKLOG.md in the pilot format (what a fresh target repo gets). */
export const BACKLOG_SKELETON = [
  "# BACKLOG",
  "",
  // NNN on purpose: a real id here would be scanned as "taken" by
  // appendReadyLines/nextId and block that id forever
  "Queue of the autonomous fleet for this repository. Task lines live under",
  "`## Ready` as `- [ ] (P2-NNN) [P2] Title — spec: ... (area: ui) (size: S)`;",
  "the pilot moves them to `## Blocked` / `## Done`.",
  "",
  ...BACKLOG_SECTIONS.flatMap((s) => [`## ${s}`, ""]),
].join("\n");

/** True when there is no file (null) or no `## Ready` section — the queue
 * reader, addTask and appendReadyLines all need that section. */
export function needsBacklogSkeleton(md: string | null | undefined): boolean {
  return typeof md !== "string" || !/^## Ready$/m.test(md);
}

/**
 * Pure: the skeleton for a missing file, or the existing content with the
 * missing pilot sections appended (a user's own BACKLOG.md is kept intact).
 * Returns null when nothing is needed.
 */
export function backlogSkeletonEdit(md: string | null): string | null {
  if (!needsBacklogSkeleton(md)) return null;
  if (md === null) return BACKLOG_SKELETON;
  const missing = BACKLOG_SECTIONS.filter((s) => !new RegExp(`^## ${s}$`, "m").test(md));
  return `${md.replace(/\s*$/, "")}\n\n${missing.flatMap((s) => [`## ${s}`, ""]).join("\n")}`;
}

/**
 * Seed the skeleton into a clone whose BACKLOG.md is absent or not in the
 * pilot format. Local to the working tree: this never commits or pushes by
 * itself — the file reaches the target repo only inside the strategist's
 * refill PR, like every other backlog landing. Without it the refill failed
 * ("missing") every 10 minutes forever on a fresh target repo.
 */
export function seedBacklogSkeleton(repoDir: string): "created" | "appended" | "kept" {
  const p = join(repoDir, BACKLOG);
  const current = existsSync(p) ? readFileSync(p, "utf8") : null;
  const next = backlogSkeletonEdit(current);
  if (next === null) return "kept";
  writeFileSync(p, next);
  return current === null ? "created" : "appended";
}

export function nextId(repoDir: string, prefix = "RT"): string {
  const md = existsSync(join(repoDir, BACKLOG)) ? readFileSync(join(repoDir, BACKLOG), "utf8") : "";
  const ids = md.matchAll(/\((?:P\d|RT)-(\d+)\)/g);
  let max = 0;
  for (const m of ids) max = Math.max(max, Number(m[1]));
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

// ── P1-057: aux agents are read-only — output becomes validated text ─────────
//
// researcher/strategist no longer touch files or run shell: they PRINT proposed
// backlog lines between markers and the runner validates, appends and commits.
// Injected instructions from fetched web pages die in a bash:"deny" sandbox and
// can no longer become commands, commits or pushes.

export const AUX_TASKS_OPEN = "AUX-TASKS:";
export const AUX_TASKS_CLOSE = "AUX-TASKS-EOF";

/** Aux proposals are P-scheduled backlog lines or redteam RT findings. */
const AUX_ID_RE = /^(?:P\d-\d{3}|RT-\d{3})$/;

/** Shell metacharacters and command verbs an injected backlog line must never carry. */
const AUX_LINE_BANNED_RE = /[;`&|<>$]|\bcurl\b|\bwget\b/i;

/**
 * Extract up to `max` valid backlog lines from an aux agent's output: each must
 * match the parseBacklog line format exactly, carry a well-formed P/RT id and a
 * trailing known-area tag. Invalid lines are dropped individually (spec edge
 * case: one bad proposal never poisons the valid ones); shell-ish content is
 * rejected outright.
 */
export function parseAuxTaskLines(output: string, max = 5): string[] {
  const start = output.indexOf(AUX_TASKS_OPEN);
  if (start < 0) return [];
  const body = (output
    .slice(start + AUX_TASKS_OPEN.length)
    .split(AUX_TASKS_CLOSE)[0] ?? "")
    .split(AUX_TASKS_OPEN)[0] ?? "";
  const lines: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (lines.length >= max) break;
    if (AUX_LINE_BANNED_RE.test(line)) continue;
    if (!AUX_ID_RE.test(/\(([^)]+)\)/.exec(line)?.[1] ?? "")) continue;
    const am = AREA_RE.exec(line);
    if (!am || !KNOWN_AREAS.has(am[1] ?? "")) continue;
    const withoutArea = line.slice(0, am.index).trimEnd();
    const sm = SIZE_RE.exec(withoutArea);
    const withoutSize = sm ? withoutArea.slice(0, sm.index).trimEnd() : withoutArea;
    if (!/^- \[ \] \(([^)]+)\) \[(P\d)\] (.+?)(?: — spec: (.+))?$/.exec(withoutSize)) continue;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

/**
 * Append validated lines to the END of ## Ready (before the next section).
 * Rejects ids already present anywhere in the current file. Tri-state (R6):
 * "noop" when every id is already present — the desired state is present, so
 * a meta-landing retry after a queued merge converges as success instead of
 * aborting; "missing" when there are no lines or no ## Ready section at all.
 */
export function appendReadyLines(repoDir: string, lines: string[]): BacklogEditResult {
  if (!lines.length) return "missing";
  const p = join(repoDir, BACKLOG);
  const md = readFileSync(p, "utf8");
  const readyAt = md.search(/^## Ready$/m);
  if (readyAt < 0) return "missing";
  const afterReady = md.slice(readyAt + 1);
  const nextAt = afterReady.search(/^## /m);
  const insertAt = nextAt < 0 ? md.length : readyAt + 1 + nextAt;
  const taken = new Set<string>();
  for (const m of md.matchAll(/\((?:P\d|RT)-\d{3}\)/g)) taken.add(m[0]);
  const fresh = lines.filter((line) => {
    const id = `(${/\(([^)]+)\)/.exec(line)?.[1] ?? ""})`;
    if (taken.has(id)) return false;
    taken.add(id);
    return true;
  });
  if (!fresh.length) return "noop";
  const updated =
    md.slice(0, insertAt).replace(/\s*$/, "\n") +
    fresh.join("\n") +
    "\n\n" +
    md.slice(insertAt).replace(/^\n+/, "");
  writeFileSync(p, updated);
  return "applied";
}

/** Injectable sinks for appendCommitAndPush (unit battery pins the semantics). */
export interface AuxPushIo {
  exec: (cmd: string) => { ok: boolean; output: string };
  sleep: (ms: number) => Promise<void>;
}

/** Real-filesystem IO for appendCommitAndPush (fakes are used in the unit battery). */
export function auxPushIo(cwd: string): AuxPushIo {
  return {
    exec: (cmd) => exec(cmd, { cwd, allowFail: true }),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

export type AuxPushResult = "pushed" | "refused" | "failed";

/**
 * Deterministic aux landing: the validated lines land via the `pilot/meta`
 * branch + auto-merge PR (P1-076) — fetch/reset → append → commit → push
 * guard → force-push → PR, retried up to `attempts` times because concurrent
 * scribes/explorers move origin/main (P3-052 lesson). The guard is re-read from
 * the actual branch diff on every attempt; a refused diff never gets pushed.
 * `opts.seedSkeleton` (foreign mission): a target repo without a pilot-format
 * BACKLOG.md gets the skeleton seeded inside the apply step — after the
 * rewind to origin/main, so no clean/reset can eat it — and the refill lands
 * skeleton + lines in the same guarded single-file commit.
 */
export async function appendCommitAndPush(
  repoDir: string,
  lines: string[],
  message: string,
  io: AuxPushIo,
  attempts = 3,
  opts: { seedSkeleton?: boolean } = {},
): Promise<AuxPushResult> {
  return landMetaCommit(
    repoDir,
    io,
    {
      files: [BACKLOG],
      message,
      guardFile: BACKLOG,
      // R6: all-duplicates is the desired state already present — a retry
      // after a queued auto-merge finally lands must converge as success
      // (clearing the P1-037 pending store), not abort forever.
      apply: () => {
        if (opts.seedSkeleton) seedBacklogSkeleton(repoDir);
        const r = appendReadyLines(repoDir, lines);
        return r === "applied" ? { action: "apply" } : r === "noop" ? { action: "noop" } : { action: "abort" };
      },
    },
    attempts,
  );
}
