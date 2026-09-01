import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Task {
  id: string;
  priority: string;
  title: string;
  spec: string;
  line: string;
}

const BACKLOG = "BACKLOG.md";

export function loadBacklog(repoDir: string): Task[] {
  const md = readFileSync(join(repoDir, BACKLOG), "utf8");
  const ready = md.split(/^## /m).find((s) => s.startsWith("Ready")) ?? "";
  const tasks: Task[] = [];
  for (const line of ready.split("\n")) {
    const m = /^- \[ \] \(([^)]+)\) \[(P\d)\] (.+?)(?: — spec: (.+))?$/.exec(line.trim());
    if (m && m[1] && m[2] && m[3]) tasks.push({ id: m[1], priority: m[2], title: m[3], spec: m[4] ?? "", line: line.trim() });
  }
  return tasks;
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
