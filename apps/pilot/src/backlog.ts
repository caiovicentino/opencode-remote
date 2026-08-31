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
  const doneHeader = "## Done";
  const updated = done.replace(
    doneHeader,
    `${doneHeader}\n- [x] (${id}) ${line.replace(/^- \[ \] \([^)]+\) /, "")} — ${note}`,
  );
  writeFileSync(p, updated);
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
