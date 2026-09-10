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

// ── P1-095/P3-356: nightly pass trigger ─────────────────────────────────────
//
// P1-095 replaced the old `hour === 3` gate with a >= 2h idle gap. That fixed
// the single-slot fleet but a busy 4-slot fleet NEVER produces 2 idle hours
// (09-04..09-07 logged "nightly pass skipped" every day; it only ran when the
// fever audit mode happened to empty the slots). P3-356 adds a RESERVED
// window: one hour before the classic nightly hour the loop holds new picks
// (the P1-104 drain mechanism) so the slots drain, and the pass fires as soon
// as `running.size === 0` — with a wait cap after which it runs even with a
// single slot still busy (the aux agents only need slot 1's worktree).

/** Idle gap (ms since the last pipeline cycle) that arms the nightly pass. */
export const NIGHTLY_IDLE_MS = 2 * 60 * 60_000;

/**
 * True when the scheduler has been idle long enough to start the nightly pass.
 * An undefined `lastCycleAt` (fresh or legacy state) means idle since forever →
 * due immediately. P3-356: this is now the OR-path for an already-idle fleet —
 * the reserved window below is the trigger a busy fleet can always hit.
 */
export function nightlyIdleDue(lastCycleAt: number | undefined, now = Date.now()): boolean {
  return now - (lastCycleAt ?? 0) >= NIGHTLY_IDLE_MS;
}

/** Local hour the nightly pass targets (the classic 03:xx window). */
export const NIGHTLY_START_HOUR = 3;

/** Wait cap inside the reserved window: after this long with slots still busy
 * the pass runs anyway (at most 1 slot occupied, aux slot free). */
export const NIGHTLY_DRAIN_CAP_MS = 90 * 60_000;

/** Input for the per-tick nightly window decision (all injectable for tests). */
export interface NightlyWindowInput {
  /** Current local hour. */
  hour: number;
  /** Slots currently running pipelines. */
  running: number;
  /** True when slot 1 (the aux/nightly worktree) is among the busy slots. */
  auxSlotBusy: boolean;
  /** Epoch-ms the current window opened (undefined → opens on this tick). */
  windowSince: number | undefined;
  /** Epoch-ms now. */
  now: number;
  /** Foreign mission → the whole nightly layer is off. */
  foreignMission: boolean;
  /** Redteam+explorer already stamped today (and no forensic overdue). */
  doneToday: boolean;
}

/** Per-tick decision for the reserved nightly window. */
export interface NightlyWindowDecision {
  /** Hold new picks this tick (drain the fleet into the pass). */
  drain: boolean;
  /** Run the nightly pass this tick. */
  run: boolean;
  /** The pass runs despite busy slots — the wait cap expired. */
  forced: boolean;
  /** Window anchor to carry into the next tick (undefined → window closed). */
  since: number | undefined;
}

const NIGHTLY_WINDOW_CLOSED: NightlyWindowDecision = { drain: false, run: false, forced: false, since: undefined };

/**
 * P3-356: the reserved nightly window. From `NIGHTLY_START_HOUR - 1` (02:00
 * local) to `NIGHTLY_START_HOUR + 1` (04:00) the fleet stops picking new tasks
 * and the pass runs at the first tick with every slot idle. After
 * `NIGHTLY_DRAIN_CAP_MS` inside the window it runs even with ONE slot busy —
 * never while slot 1 (the worktree the nightly agents share) is itself busy,
 * and never with 2+ slots still occupied (that is what the honest skip record
 * in `nightlySkipDue` is for). A foreign mission or an already-done day keeps
 * the window closed: no drain, no run.
 */
export function nightlyWindow(i: NightlyWindowInput): NightlyWindowDecision {
  if (i.foreignMission || i.doneToday) return NIGHTLY_WINDOW_CLOSED;
  const inWindow = i.hour >= NIGHTLY_START_HOUR - 1 && i.hour < NIGHTLY_START_HOUR + 1;
  if (!inWindow) return NIGHTLY_WINDOW_CLOSED;
  const since = i.windowSince ?? i.now;
  const capHit = i.now - since >= NIGHTLY_DRAIN_CAP_MS;
  const forced = i.running > 0 && capHit && !i.auxSlotBusy && i.running <= 1;
  return { drain: true, run: i.running === 0 || forced, forced, since };
}

/** The nightly skip record persisted in state.json (once per day, honest). */
export interface NightlySkip {
  date: string;
  reason: string;
}

/**
 * Snapshot of WHO held the slots when the reserved nightly window passed —
 * feeds the honest skip record (P3-356: how many slots and since when).
 */
export interface NightlyHold {
  /** Slots busy at skip time. */
  running: number;
  /** Fleet size (slot count). */
  slots: number;
  /** Epoch-ms the reserved window opened (undefined → process booted mid-window). */
  since?: number;
  /** Epoch-ms now. */
  now: number;
}

/**
 * Reason string when the reserved nightly window (02:00–04:00 local) has
 * passed with slots still busy and the pass not run today — the "nightly
 * skipped" signal for state.json + Mission Control. With a `hold` snapshot the
 * reason names the slots that held and since when (P3-356). Returns null
 * (nothing to record) when the slots are idle, the hour is still within the
 * window, the pass already ran today, or a skip was already recorded today
 * (dedupe by date).
 */
export function nightlySkipDue(
  st: { redteamLast?: string; explorerLast?: string; nightlySkipped?: NightlySkip | null },
  today: string,
  hour: number,
  slotsBusy: boolean,
  hold?: NightlyHold,
): string | null {
  if (!slotsBusy) return null;
  if (hour < NIGHTLY_START_HOUR + 1) return null; // window not over yet — reason must stay truthful
  if (st.redteamLast === today && st.explorerLast === today) return null;
  if (st.nightlySkipped?.date === today) return null;
  if (!hold) return "slots busy past the nightly window — pass not run today";
  const since = hold.since
    ? ` since ${new Date(hold.since).toTimeString().slice(0, 5)}`
    : "";
  return `reserved window passed with ${hold.running}/${hold.slots} slots busy${since} — pass not run today`;
}
