import type { Task } from "./backlog";

/**
 * P1-006: scheduling key for parallel slots. Tagged tasks share their area key
 * (`area:ui` etc.) and the scheduler never runs two of the same area at once;
 * ALL untagged tasks share the `solo` key so untagged work always runs
 * serially — the conservative default until the strategist tags it.
 */
export function areaKey(t: Task): string {
  // Untagged tasks are independent work: each gets its own key so they run in
  // parallel across slots (the old shared "solo" bucket capped the fleet at 1
  // pick per cycle no matter how many slots the operator asked for). Explicit
  // (area: …) tags still dedupe — same-area tasks share files/caches, so the
  // P1-078 affinity rules keep them serialized.
  return t.area ? `area:${t.area}` : `id:${t.id}`;
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

/**
 * Batch pick for one scheduler cycle: never exceeds the remaining daily task
 * budget (in-flight pipelines included) and never schedules over `freeSlots`.
 */
export function pickBatch(queue: Task[], freeSlots: number, busy: Set<string>, remainingBudget: number): Task[] {
  const cap = Math.min(Math.max(0, freeSlots), Math.max(0, remainingBudget));
  return pickTasks(queue, cap, busy);
}

// ── P1-078: cache affinity + staggered starts between slots ──────────────────
//
// The provider prefix cache is per account/organization: parallel slots hit
// the SAME provider, so a slot that recently ran a same-shape task (same area
// key) can inherit the warm prefix instead of paying a fresh cache-write.

/** Affinity window — providers keep prefix caches warm for ~5-10 minutes. */
export const AFFINITY_TTL_MS = 10 * 60_000;

/** Stagger between simultaneous slot starts so the first builder's cache-write
 * completes before the second one sends its (near-identical) prefix. */
export const SLOT_START_STAGGER_MS = 20_000;

/** Slot `slot` last ran a task of area key `area` at epoch-ms `at`. */
export interface SlotAffinity {
  slot: number;
  area: string;
  at: number;
}

/** Staggered start delay for the i-th (0-based) pick of one batch. */
export function startDelayMs(index: number): number {
  return Math.max(0, index) * SLOT_START_STAGGER_MS;
}

/**
 * P1-078: assign each picked task a free slot. `picks` comes from pickBatch
 * (areas already distinct from each other and from `busy`), so this only
 * chooses BETWEEN free slots — the P1-006 rule is untouched. A task prefers
 * the free slot whose most recent task had the same area key within the TTL
 * (most recent wins), else the lowest-numbered free slot; `solo` keys never
 * gain affinity (serial by P1-006, and one warm slot is enough for them).
 * Never assigns a busy area and never reuses a slot within one batch.
 */
export function assignSlots(
  picks: Task[],
  freeSlots: number[],
  busy: Set<string>,
  affinity: SlotAffinity[],
  now: number,
  ttlMs: number = AFFINITY_TTL_MS,
): Map<string, number> {
  const out = new Map<string, number>();
  const free = [...freeSlots].sort((a, b) => a - b);
  for (const t of picks) {
    const key = areaKey(t);
    if (busy.has(key)) continue;
    let slot: number | undefined;
    if (key !== "solo") {
      let best: SlotAffinity | undefined;
      for (const a of affinity) {
        if (a.area === key && free.includes(a.slot) && now - a.at <= ttlMs) {
          if (!best || a.at > best.at) best = a;
        }
      }
      slot = best?.slot;
    }
    slot ??= free[0];
    if (slot === undefined) continue;
    out.set(t.id, slot);
    const i = free.indexOf(slot);
    if (i >= 0) free.splice(i, 1);
  }
  return out;
}

// ── P1-095: nightly pass trigger — idle window instead of a wall-clock hour ──
//
// The old gate (`hour === 3` AND `running.size === 0`) was effectively
// unreachable: pipelines routinely span the whole 03:00–03:59 window, so
// redteam/explorer/forensic never ran. The nightly pass now fires at the first
// moment the scheduler has been idle >= 2h since the last pipeline cycle.

/** Idle gap (ms since the last pipeline cycle) that arms the nightly pass. */
export const NIGHTLY_IDLE_MS = 2 * 60 * 60_000;

/**
 * True when the scheduler has been idle long enough to start the nightly pass.
 * An undefined `lastCycleAt` (fresh or legacy state) means idle since forever →
 * due immediately.
 */
export function nightlyIdleDue(lastCycleAt: number | undefined, now = Date.now()): boolean {
  return now - (lastCycleAt ?? 0) >= NIGHTLY_IDLE_MS;
}

/**
 * Which branch of the nightly layer the loop takes this tick. The nightly
 * agents (redteam, explorer, forensic, experience maintenance) are the
 * self-improvement layer of OUR repo: a foreign mission (the user's repo) gets
 * the mission pipeline only — never a red team attacking their code base, nor
 * a "nightly skipped" record for a pass that must not run there.
 */
export function nightlyLayer(foreignMission: boolean, slotsRunning: number): "run" | "busy" | "off" {
  if (foreignMission) return "off";
  return slotsRunning === 0 ? "run" : "busy";
}

/** The nightly skip record persisted in state.json (once per day, honest). */
export interface NightlySkip {
  date: string;
  reason: string;
}

/**
 * Reason string when the classic nightly window (03:xx) has passed with slots
 * still busy and the pass not run today — the "nightly skipped" signal for
 * state.json + Mission Control. Returns null (nothing to record) when the
 * slots are idle, the hour is still within the window, the pass already ran
 * today, or a skip was already recorded today (dedupe by date).
 */
export function nightlySkipDue(
  st: { redteamLast?: string; explorerLast?: string; nightlySkipped?: NightlySkip | null },
  today: string,
  hour: number,
  slotsBusy: boolean,
): string | null {
  if (!slotsBusy) return null;
  if (hour < 4) return null; // 03:xx window not over yet — reason must stay truthful
  if (st.redteamLast === today && st.explorerLast === today) return null;
  if (st.nightlySkipped?.date === today) return null;
  return "slots busy past the nightly window — pass not run today";
}
