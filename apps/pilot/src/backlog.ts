import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./runner";

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
 * P1-014 stop-loss: move a task line from ## Ready to a `## Blocked` section
 * (created before ## Done, or at the end of the file) with a one-line summary
 * of the last findings. Idempotent: returns false when the line is missing or
 * already under ## Blocked.
 */
export function blockTask(repoDir: string, id: string, findings: string): boolean {
  const p = join(repoDir, BACKLOG);
  const md = readFileSync(p, "utf8");
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(- \\[ \\] \\(${escaped}\\).*)$`, "m");
  const match = re.exec(md);
  if (!match) return false;
  const blockedAt = md.search(/^## Blocked$/m);
  if (blockedAt >= 0 && match.index > blockedAt) return false; // already blocked
  const summary = findings.replace(/\s+/g, " ").trim().slice(0, 200);
  const entry = `${match[1]} — ${summary}`;
  const removed = md.replace(re, "").replace(/\n{3,}/g, "\n\n");
  const updated = /^## Done$/m.test(removed)
    ? removed.replace(/^## Done$/m, `## Blocked\n${entry}\n\n## Done`)
    : `${removed.replace(/\s*$/, "")}\n\n## Blocked\n${entry}\n`;
  writeFileSync(p, updated);
  return true;
}

/** Add a task at the top of ## Ready (used by redteam findings). */
export function addTask(repoDir: string, id: string, priority: string, title: string, spec: string) {
  const p = join(repoDir, BACKLOG);
  const md = readFileSync(p, "utf8");
  const entry = `- [ ] (${id}) [${priority}] ${title} — spec: ${spec}`;
  const updated = md.replace(/^## Ready$/m, `## Ready\n${entry}`);
  writeFileSync(p, updated);
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
 * Rejects ids already present anywhere in the current file. Returns false when
 * nothing was appended — the git state stays untouched (no empty commits).
 */
export function appendReadyLines(repoDir: string, lines: string[]): boolean {
  if (!lines.length) return false;
  const p = join(repoDir, BACKLOG);
  const md = readFileSync(p, "utf8");
  const readyAt = md.search(/^## Ready$/m);
  if (readyAt < 0) return false;
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
  if (!fresh.length) return false;
  const updated =
    md.slice(0, insertAt).replace(/\s*$/, "\n") +
    fresh.join("\n") +
    "\n\n" +
    md.slice(insertAt).replace(/^\n+/, "");
  writeFileSync(p, updated);
  return true;
}

/**
 * Push guard (P1-057): an aux flow may only ever push a diff whose name-only
 * file list is EXACTLY the one allowed path (BACKLOG.md for task lines,
 * docs/EXPERIENCE.md for lessons). Anything else — leftover artifacts, agent
 * tampering — refuses the push.
 */
export function mayPush(nameOnlyOutput: string, allowed: string): boolean {
  const files = nameOnlyOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return files.length === 1 && files[0] === allowed;
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
 * Deterministic aux landing: fetch/reset main → append validated lines →
 * commit → push guard → push, retried up to `attempts` times because concurrent
 * scribes/explorers move origin/main (P3-052 lesson). The guard is re-read from
 * the actual branch diff on every attempt; a refused diff never gets pushed.
 */
export async function appendCommitAndPush(
  repoDir: string,
  lines: string[],
  message: string,
  io: AuxPushIo,
  attempts = 3,
): Promise<AuxPushResult> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    io.exec("git fetch -q origin");
    if (!io.exec("git reset -q --hard origin/main").ok || !io.exec("git clean -qfd").ok) {
      await io.sleep(3_000);
      continue;
    }
    if (!appendReadyLines(repoDir, lines)) return "failed"; // all duplicates/invalid — no commit
    if (!io.exec(`git add ${BACKLOG} && git commit -qm ${shq(message)}`).ok) {
      await io.sleep(3_000);
      continue;
    }
    const names = io.exec("git diff --name-only origin/main...HEAD");
    if (!mayPush(names.output, BACKLOG)) return "refused";
    if (io.exec("git push -q origin main").ok) return "pushed";
    await io.sleep(3_000);
  }
  return "failed";
}

/** POSIX single-quote shell escape (JSON.stringify is NOT shell quoting). */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
