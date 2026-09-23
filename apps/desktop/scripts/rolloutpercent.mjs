/**
 * P3-458: the ONE validity contract for the gradual-rollout percentage every
 * release writer shares — the P2-336 lesson (a single exported validator so
 * the call sites can never drift) applied to the writer side of the P2-342
 * rollout verdict.
 *
 * The client reader is apps/desktop/src/updaterollout.ts: it tolerates an
 * integer in 0..100 carried raw in the feed (as a real number in the
 * Squirrel.Mac JSON, as a digit-only token in an electron-builder yml) and
 * fails OPEN on everything else (an illegible percentage offers the update to
 * everyone — holding by doubt would freeze the fleet). The writers must not
 * rely on that tolerance: anything they publish is what every installed
 * machine will consult, so a writer-side garbage value could silently hold or
 * release the whole fleet. This module is the writer's gate: ONLY an integer
 * in 0..100 arrives as a valid result, everything else is an explicit
 * problem list the caller must fail closed on (exit 1, nothing written).
 *
 * Pure by construction — the P2-335/P2-342 module hygiene: NO imports at all
 * (no node:fs, no node:path, no network, no timers, no randomness). The unit
 * battery imports this file and any dependency would boot something.
 *
 * Parity is pinned by scripts/unit.test.ts (P3-458 block), which reads the
 * real source of updaterollout.ts (and update.ts, the actual feed parser) and
 * fails the moment the field names or the 0..100 limits diverge — the P2-338
 * lesson: duplicated constants between modules that cannot import each other
 * stay honest only through a source-reading test.
 */

/** Field the Squirrel.Mac JSON feeds (update-mac*.json) carry. The macOS
 * client (update.ts parseFeed, format "json") reads exactly this name. */
export const ROLLOUT_JSON_FIELD = "rolloutPercent";

/** Field the electron-builder update yml feeds (latest-mac.yml / latest.yml)
 * carry — deliberately the same top-level key electron-updater's own staged
 * rollout uses, so the percentage means the same thing to every consumer. */
export const ROLLOUT_YML_FIELD = "stagingPercentage";

/**
 * The one validity rule: `raw` must name an integer in 0..100.
 *
 * @param {unknown} raw the value as it arrives (an environment/CLI string).
 *        `undefined`/`null` and any non-string are problems — the writers
 *        that may legitimately run WITHOUT a percentage (update-feed.mjs)
 *        pre-check absence and never call this with one, so a problem here
 *        is always fail-closed information, never a silent skip.
 * @returns {{ value: number } | { problems: string[] }} exactly one of the
 *        two shapes: `value` when the integer is accepted (the caller writes
 *        it verbatim), `problems` (one self-contained string per defect, ALL
 *        of them at once — the update-feed problem-reporting style) when it
 *        is not. Never throws, never returns both.
 */
export function parseRolloutPercent(raw) {
  if (typeof raw !== "string") {
    return { problems: ["rollout percentage is not set — pass an integer from 0 to 100"] };
  }
  const text = raw.trim();
  if (text.length === 0) {
    return {
      problems: [
        `rollout percentage ${JSON.stringify(raw)} is empty — pass an integer from 0 to 100, or leave the value unset`,
      ],
    };
  }
  if (!/^\d+$/.test(text)) {
    return {
      problems: [
        `rollout percentage ${JSON.stringify(raw)} is not an integer in 0..100 (digits only — no sign, no fraction, no text)`,
      ],
    };
  }
  const value = Number.parseInt(text, 10);
  if (value < 0 || value > 100) {
    return { problems: [`rollout percentage ${value} is outside 0..100`] };
  }
  return { value };
}
