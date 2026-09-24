/**
 * P2-355: layout-shift gate — the pop-ins the explorer hunts by eye (brand
 * header sheared, sidebar lines arriving late, pane map jumping) become a
 * deterministic guard via the Layout Instability API, the technique from
 * https://claude.dev/blog/how-we-made-claude-ai-faster/: every `layout-shift`
 * entry's `sources` map to a named region and the gate goes red when a named
 * region moves after first paint.
 *
 * Pure module: no React, no DOM at import time. The desktop-flow beat reads
 * each buffered entry out of the page as a plain value — the region name is
 * attributed AT FIRE TIME in the page (data-region on the live node, else a
 * short selector), so only name and score ever cross the IPC boundary, never
 * a node — and then classifies every entry here.
 */

/**
 * Documented threshold: an entry scoring below this is imperceptible movement
 * and never blocks. Empirical scale on the hunted surfaces (1440x900): a
 * full-height sidebar moving ~5px scores ≈0.001, a visible card pushed down
 * by a late insert scores ≈0.005, the pane map jumping a column-height block
 * ≈0.005 — all fire. Anything smaller is sub-pixel jitter. (For comparison,
 * the whole-page CLS "good" ceiling is 0.1 — the blog's own sidebar rows
 * scored ~0.008 each.)
 */
export const SHIFT_THRESHOLD = 0.001;

/**
 * The regions the app names via `data-region="…"`: the containers whose
 * layout must be settled after first paint — exactly the surfaces the
 * explorer's journey shots flagged. scripts/unit.test.ts pins the parity
 * between this list and the real app sources, so a rename on either side
 * fails the unit battery instead of silently downgrading named shifts to
 * warnings.
 */
export const SHIFT_REGIONS = ["brand-header", "sidebar", "pane-map"] as const;

/** The closed verdict set the classifier may return — nothing else. */
export type ShiftVerdict =
  | { kind: "ignore" } // malformed / user-input / below threshold — never a pop-in
  | { kind: "unnamed" } // real move, but no assigned region — warn, never red
  | { kind: "shift"; region: string }; // a named region moved after first paint

/** One buffered entry as a plain value (name attributed at fire time). */
export interface ShiftEntryValue {
  /** Region attributed at fire time: a data-region name or a short live
   * selector. Missing/null/"" = no region could be attributed. */
  name?: unknown;
  /** Layout-shift score: impact fraction × distance fraction. */
  value?: unknown;
}

/**
 * Fixed-order classification, one cause per return:
 * 1. malformed entry (not an object, non-finite/negative/non-number score,
 *    or a name that is neither a string nor absent) → ignore — fail-closed:
 *    garbage never fabricates a red
 * 2. hadRecentInput → ignore — user input legitimately moves things (the
 *    API's own 500ms input window, passed through by the beat)
 * 3. score below the documented threshold → ignore
 * 4. region not in the assigned list → unnamed
 * 5. only then → named shift
 */
export function classifyShift(
  entry: unknown,
  hadRecentInput: boolean | undefined | null,
  assigned: readonly string[],
): ShiftVerdict {
  // 1. malformed → ignore (fail-closed: never throw, never fabricate)
  const v = entry as ShiftEntryValue | null;
  if (typeof v !== "object" || v === null) return { kind: "ignore" };
  const { name, value } = v;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { kind: "ignore" };
  if (name !== undefined && name !== null && typeof name !== "string") return { kind: "ignore" };
  // 2. user input legitimately moves things
  if (hadRecentInput) return { kind: "ignore" };
  // 3. below the documented threshold → imperceptible
  if (value < SHIFT_THRESHOLD) return { kind: "ignore" };
  // 4. region not in the assigned list → unnamed
  if (!Array.isArray(assigned)) return { kind: "unnamed" };
  const region = typeof name === "string" ? name : "";
  if (region === "" || !assigned.includes(region)) return { kind: "unnamed" };
  // 5. a named region moved after first paint
  return { kind: "shift", region };
}
