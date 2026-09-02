/**
 * Side-by-side artifact preview (P2-062): at SPLIT_MIN_PX viewport width the
 * chat shows the artifact preview in a right-hand pane instead of the
 * full-screen overlay. Pure helpers here so the thresholds stay testable.
 */

/** viewport width (px) at which the chat gains the side preview pane */
export const SPLIT_MIN_PX = 900;

/** true when a viewport of `width` px should use the split pane */
export function isSplitViewport(width: number): boolean {
  return width >= SPLIT_MIN_PX;
}

/**
 * Divider drag clamp: the preview pane keeps between a quarter and three
 * quarters of the row, so neither column ever collapses.
 */
export function clampSplitPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0.5;
  return Math.min(0.75, Math.max(0.25, pct));
}
