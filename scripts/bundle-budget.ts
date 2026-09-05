#!/usr/bin/env node
/**
 * P2-162: bundle size budget gate for the desktop-package CI job.
 *
 * Nothing looked at how big the shipped bundles are, so a fat dependency
 * could double the payload silently and only show up as a slow download on
 * the user's machine. This module turns the size budget into a pure,
 * testable contract in the same shape as scripts/release-preflight.ts and
 * scripts/release-assets.ts:
 *
 *   - BUNDLE_BUDGETS      → the ceilings (bytes) keyed by expected entry name.
 *   - budgetProblems(...) → every problem at once: entry above its ceiling,
 *                           expected entry missing from the measured list,
 *                           budget non-numeric or negative.
 *
 * Pure logic never touches disk; the CLI measures the real build output
 * (sum of apps/web/dist and the sidecar bundle
 * apps/desktop/dist-daemon/index.js), prints every problem at once and
 * exits 1 — the fail-closed dist-smoke pattern.
 *
 * Run: npx tsx scripts/bundle-budget.ts   (after `npm run build`)
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface BundleEntry {
  /** Entry name as cited in BUNDLE_BUDGETS (and printed verbatim). */
  name: string;
  /** Measured size in bytes. */
  bytes: number;
}

/**
 * Ceilings in bytes, keyed by expected entry name. Measured 2026-09-04 on
 * darwin/arm64 after `npm run build`: apps/web/dist summed 571,256 B and
 * apps/desktop/dist-daemon/index.js 734,536 B. The ceilings leave ~40%
 * slack to absorb platform/toolchain drift (CI builds on macos-14) plus
 * ordinary growth; raising one on purpose is fine — justify it in the
 * commit message.
 */
export const BUNDLE_BUDGETS: Readonly<Record<string, number>> = {
  "apps/web/dist": 800_000,
  "apps/desktop/dist-daemon/index.js": 1_000_000,
};

function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

/**
 * All budget problems with the measured entries, in the release-preflight
 * format (one string per problem; empty list means green). Every budget key
 * is checked — problems are reported together, not just the first.
 */
export function budgetProblems(
  entries: readonly BundleEntry[],
  budgets: Readonly<Record<string, number>> = BUNDLE_BUDGETS,
): string[] {
  const problems: string[] = [];
  const measured = new Map(entries.map((entry) => [entry.name, entry.bytes]));
  for (const [name, ceiling] of Object.entries(budgets)) {
    if (typeof ceiling !== "number" || !Number.isFinite(ceiling)) {
      problems.push(`${name}: budget is not a number (${String(ceiling)})`);
      continue;
    }
    if (ceiling < 0) {
      problems.push(`${name}: budget is negative (${ceiling} bytes)`);
      continue;
    }
    const bytes = measured.get(name);
    if (bytes === undefined) {
      problems.push(`${name}: expected entry missing from the measured list`);
      continue;
    }
    if (bytes > ceiling) {
      problems.push(
        `${name}: measured ${kb(bytes)} KB exceeds the ${kb(ceiling)} KB budget — slack ${kb(ceiling - bytes)} KB`,
      );
    }
  }
  return problems;
}

/** Total bytes of every file under `dir` (recursively). */
function treeBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats) continue;
    if (stats.isDirectory()) total += treeBytes(path);
    else total += stats.size;
  }
  return total;
}

/**
 * Real build output measured from disk. A missing/unreadable path is simply
 * not reported here — budgetProblems then flags it as an expected entry
 * missing from the list (fail-closed on a broken build).
 */
export function measureRepoEntries(repoRoot: string): BundleEntry[] {
  const entries: BundleEntry[] = [];
  try {
    entries.push({ name: "apps/web/dist", bytes: treeBytes(join(repoRoot, "apps", "web", "dist")) });
  } catch {
    // not built — the missing-entry problem fires below
  }
  try {
    entries.push({
      name: "apps/desktop/dist-daemon/index.js",
      bytes: statSync(join(repoRoot, "apps", "desktop", "dist-daemon", "index.js")).size,
    });
  } catch {
    // not built — the missing-entry problem fires below
  }
  return entries;
}

function main() {
  const repoRoot = join(dirnameOf(import.meta.url), "..");
  const entries = measureRepoEntries(repoRoot);
  for (const entry of entries) {
    console.log(`bundle-budget: ${entry.name} — ${kb(entry.bytes)} KB (${entry.bytes} bytes)`);
  }
  const problems = budgetProblems(entries, BUNDLE_BUDGETS);
  if (problems.length > 0) {
    console.error("bundle-budget: FAIL");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`bundle-budget: ${problems.length} problem(s) found`);
    console.error(
      "bundle-budget: raise a ceiling only on purpose — bump BUNDLE_BUDGETS in scripts/bundle-budget.ts and justify it in the commit message",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`bundle-budget: OK — all ${Object.keys(BUNDLE_BUDGETS).length} entry(ies) within budget`);
}

function dirnameOf(moduleUrl: string): string {
  return fileURLToPath(new URL(".", moduleUrl));
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
