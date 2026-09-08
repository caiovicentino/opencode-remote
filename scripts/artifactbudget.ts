/**
 * P2-325: size budget gate for the packaged distributable artifacts.
 *
 * scripts/bundle-budget.ts (P2-162) caps the build output that goes INTO the
 * installers, but nothing in the repo looked at the installers that come OUT:
 * the DMG, the Squirrel.Mac update zip and the NSIS installer could double in
 * size and ship with a green pipeline — docs/VISION.md stage 5 cares about
 * distribution, and only users on bad connections would ever find out. The
 * packaging jobs already produce these files on every PR and release.yml
 * publishes them; this module turns their size budget into a pure, testable
 * contract in the same shape as scripts/bundle-budget.ts and the hygiene of
 * scripts/jobtimeouts.ts / scripts/auditverdict.ts:
 *
 *   - ARTIFACT_BUDGETS    → the ceilings (bytes), keyed by artifact type.
 *   - artifactProblems(...) → every problem at once, in a fixed order and
 *     with no short-circuit: a known-type artifact above its type's ceiling,
 *     a size that is missing, zero, negative or not a number, and an
 *     expected artifact type that never appeared in the measured list.
 *
 * Pure logic: no node:fs, no network, no node:process. The caller (the
 * scripts/check-artifact-size.ts collector) reads the real packaging output,
 * classifies each file by suffix and hands over the already-normalized
 * artifact list, so the unit battery can pin every branch with synthetic
 * fixtures. A file whose suffix is not a known type is ignored here without
 * becoming a problem — the collector alone decides what enters the list.
 *
 * The verdict is deterministic: the same input produces the same problems in
 * the same order on every call.
 */

/**
 * The distributable-artifact ceilings in bytes, keyed by artifact type (the
 * lowercased file suffix, without the dot). Measured 2026-09-08 on
 * darwin/arm64 with a real unsigned `npm run dist --workspace @ocr/desktop
 * -- --mac` (electron-builder 26): the heaviest DMG
 * (OpenCode-Remote-0.2.0-x64.dmg) is 132,384,904 bytes and the heaviest
 * Squirrel zip 132,472,062 bytes — the same Electron payload compressed two
 * ways. The NSIS installer is that same payload compressed by a third engine
 * on a platform this repo's mac tooling cannot build, so its ceiling is
 * derived from those same measurements instead of a Windows run. The ceilings
 * leave ~40% slack over the measured maxima to absorb signing/notarization,
 * version and toolchain drift plus ordinary growth; raising one on purpose is
 * fine — bump ARTIFACT_BUDGETS and justify it in the commit message.
 */
export const ARTIFACT_BUDGETS: Readonly<Record<string, number>> = {
  dmg: 180_000_000, // macOS installer (measured max 132,384,904 B + slack)
  zip: 180_000_000, // Squirrel.Mac update zip per arch (measured max 132,472,062 B + slack)
  exe: 180_000_000, // NSIS installer (derived from the same payload; no local win build)
};

/** The types the table knows, in the fixed order of the table itself. */
export function knownArtifactTypes(budgets: Readonly<Record<string, number>> = ARTIFACT_BUDGETS): string[] {
  return Object.keys(budgets);
}

/**
 * The type of one artifact file name: its lowercased suffix without the dot,
 * or null when the name carries no suffix a budget could key on (dotfiles
 * like ".yml" count as suffix "yml" — unknown — and are ignored downstream).
 */
export function artifactTypeOf(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/** One normalized artifact handed over by the collector. */
export interface ArtifactEntry {
  /** File name (collector sends the path relative to the packaging dir). */
  name: string;
  /** Measured size in bytes; anything else is a fail-closed size problem. */
  bytes?: number;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * All budget problems with the measured artifacts, in a fixed order with no
 * short-circuit: one problem per offending artifact in input order, then one
 * problem per expected type that never appeared (in the caller's order).
 * Unknown-suffix artifacts are ignored — they are not distributables this
 * table budgets. Empty (or absent) artifact list: only the expected-type
 * problems can fire, so an absent directory stays the collector's own
 * fail-closed problem instead of a vacuous approval here.
 */
export function artifactProblems(
  artifacts: readonly ArtifactEntry[] | null | undefined,
  expectedTypes: readonly string[] = [],
  budgets: Readonly<Record<string, number>> = ARTIFACT_BUDGETS,
): string[] {
  const problems: string[] = [];
  const seenTypes = new Set<string>();
  for (const artifact of artifacts ?? []) {
    const type = artifactTypeOf(artifact?.name ?? "");
    if (type === null || !(type in budgets)) continue; // unknown suffix: ignored
    seenTypes.add(type);
    const ceiling = budgets[type];
    const bytes = artifact.bytes;
    if (bytes === undefined || bytes === null) {
      problems.push(
        `${artifact.name}: size missing for a ${type} artifact — measure the real file instead of approving silently`,
      );
      continue;
    }
    if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
      problems.push(
        `${artifact.name}: size ${String(bytes)} is not a number for a ${type} artifact — measure the real file instead of approving silently`,
      );
      continue;
    }
    if (bytes === 0) {
      problems.push(
        `${artifact.name}: measured 0 bytes for a ${type} artifact — a zero-byte distributable is a broken package, not a small one`,
      );
      continue;
    }
    if (bytes < 0) {
      problems.push(
        `${artifact.name}: measured a negative size (${bytes} bytes) for a ${type} artifact — the measurement is broken, not the package small`,
      );
      continue;
    }
    if (bytes > ceiling) {
      problems.push(
        `${artifact.name}: measured ${mb(bytes)} exceeds the ${mb(ceiling)} ${type} ceiling — slack ${mb(ceiling - bytes)}`,
      );
    }
  }
  for (const expected of expectedTypes) {
    if (!(expected in budgets)) {
      problems.push(
        `expected artifact type "${expected}" is not a known type (${knownArtifactTypes(budgets).join(", ")}) — fail closed instead of ignoring an unmeasurable expectation`,
      );
      continue;
    }
    if (!seenTypes.has(expected)) {
      problems.push(
        `expected artifact type "${expected}" (${mb(budgets[expected])} ceiling) not found in the measured artifacts — the packaging run produced no .${expected} distributable`,
      );
    }
  }
  return problems;
}
