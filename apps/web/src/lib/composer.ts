/**
 * P3-086: complete-composer pure helpers. The DOM-touching wiring lives in
 * ChatView (P1-072 pattern): these functions pin the semantics so unit tests
 * can hold the geometry contract without a renderer.
 */

/** The textarea grows with content up to this many visible lines; past that
 * it stops growing and scrolls internally (CSS overflow-y: auto). */
export const COMPOSER_MAX_LINES = 6;

/**
 * Height (px) the textarea should take for a given scrollHeight. Grows line
 * by line until the max-lines cap, then clamps hard so the CSS `overflow-y:
 * auto` takes over — the box never grows beyond ~6 lines, never shrinks
 * below a single line, and always lands on whole pixels.
 */
export function clampComposerHeight(
  scrollHeight: number,
  lineHeightPx: number,
  padY: number,
  maxLines: number = COMPOSER_MAX_LINES,
): number {
  const lh = Math.max(1, lineHeightPx);
  const min = Math.round(lh + padY);
  // floor the cap so a fractional computed line-height can never leave the
  // clamped box 0.2px short of the content and flicker a scrollbar at the cap
  const max = Math.floor(lh * maxLines + padY);
  const want = Math.round(scrollHeight);
  return Math.min(Math.max(want, min), max);
}

/** Human-facing label of the inline agent/model selector: "build · model",
 * collapsing to the single part that is set (never renders " · " edges). */
export function composerSelectorLabel(agent: string, model: string): string {
  return [agent.trim(), model.trim()].filter(Boolean).join(" · ");
}
