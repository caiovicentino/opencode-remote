import type { Task } from "./backlog";

/**
 * P1-006: scheduling key for parallel slots. Tagged tasks share their area key
 * (`area:ui` etc.) and the scheduler never runs two of the same area at once;
 * ALL untagged tasks share the `solo` key so untagged work always runs
 * serially — the conservative default until the strategist tags it.
 */
export function areaKey(t: Task): string {
  return t.area ? `area:${t.area}` : "solo";
}

/**
 * Pick up to `freeSlots` tasks from the queue (in BACKLOG order, so priority
 * is respected) whose area keys are distinct from each other and from the
 * `busy` set of the slots already running.
 */
export function pickTasks(queue: Task[], freeSlots: number, busy: Set<string>): Task[] {
  const picked: Task[] = [];
  const used = new Set(busy);
  for (const t of queue) {
    if (picked.length >= freeSlots) break;
    const key = areaKey(t);
    if (used.has(key)) continue;
    picked.push(t);
    used.add(key);
  }
  return picked;
}
