#!/usr/bin/env node
/**
 * P2-325: artifact-size collector and CI gate.
 *
 * Reads the real packaging output (apps/desktop/dist, the dir every
 * electron-builder run in ci.yml and release.yml writes), classifies each
 * file by suffix and feeds the normalized list to the pure verdict in
 * scripts/artifactbudget.ts — the same split as
 * scripts/check-job-timeouts.ts → scripts/jobtimeouts.ts. The DMG, the
 * Squirrel.Mac update zip and the NSIS installer therefore get the same
 * fail-closed size gate the build output already had since P2-162.
 *
 * Fail-closed rules: a missing or unreadable packaging dir and a dir with no
 * files at all are explicit problems, never a silent approval. The unpacked
 * payloads (`.app` bundles, `*-unpacked` dirs) are skipped — they are the
 * packaging INPUT that dist:smoke validates, not distributables; their .exe
 * app binary must never be mistaken for the NSIS installer. Files with an
 * unknown suffix are ignored by the pure verdict.
 *
 * The `--expect <types>` flag turns a known type that never appeared into
 * its own problem — that is how the release.yml packaging jobs enforce the
 * ceilings on the real installers (`--expect dmg,zip` on desktop-dmg,
 * `--expect exe` on desktop-win, after packaging and before upload). The
 * ci.yml jobs package dir targets only — no installers — so they run
 * without --expect as a standing fail-closed guard on the packaging output.
 *
 * Every problem is printed in a single run. Exit codes: 1 only when there is
 * at least one problem; zero problems exit 0. Ceilings live in
 * scripts/artifactbudget.ts and are registered in docs/security.md.
 *
 * Run: npx tsx scripts/check-artifact-size.ts [--dir <path>] [--expect dmg,zip]
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { artifactProblems, knownArtifactTypes, type ArtifactEntry } from "./artifactbudget";

/** The real packaging output dir, repo-root relative. */
export const PACKAGING_DIR = "apps/desktop/dist";

/**
 * Walk `dir` recursively and normalize every distributable candidate: files
 * only, each with its size in bytes and its path relative to `dir`. The
 * unpacked payloads (`.app` bundles, `*-unpacked` dirs) are skipped — see the
 * module header. A file whose stat fails travels as an entry with no size, so
 * the pure verdict fails closed on it instead of this walk throwing.
 */
export function collectArtifactEntries(dir: string): ArtifactEntry[] {
  const entries: ArtifactEntry[] = [];
  const walk = (current: string, relative: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const rel = relative ? `${relative}/${name}` : name;
      const stats = statSync(path, { throwIfNoEntry: false });
      if (!stats) {
        entries.push({ name: rel });
        continue;
      }
      if (stats.isDirectory()) {
        if (name.endsWith(".app") || name.endsWith("-unpacked")) continue;
        walk(path, rel);
        continue;
      }
      entries.push({ name: rel, bytes: stats.size });
    }
  };
  walk(dir, "");
  return entries;
}

/**
 * The whole gate for one packaging dir: collect, then the pure verdict.
 * Exported for the unit battery, which runs it against a temp dir it mounts
 * itself. A missing/unreadable dir returns the explicit fail-closed problem
 * instead of throwing; an empty one (no files at all) fails closed too.
 */
export function collectProblems(dir: string, expectedTypes: readonly string[] = []): string[] {
  let entries: ArtifactEntry[];
  try {
    entries = collectArtifactEntries(dir);
  } catch (err) {
    return [
      `${dir}: packaging output missing or unreadable (${err instanceof Error ? err.message : String(err)}) — fail closed instead of silently approving`,
    ];
  }
  if (entries.length === 0) {
    return [
      `${dir}: packaging output is empty — nothing was packaged, so there is nothing to approve`,
    ];
  }
  return artifactProblems(entries, expectedTypes);
}

function parseArgs(argv: string[]): { dir: string | null; expect: string[] } {
  const dir: string[] = [];
  const expect: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") dir.push(argv[++i] ?? "");
    else if (argv[i] === "--expect") expect.push(...(argv[++i] ?? "").split(",").map((t) => t.trim()).filter(Boolean));
  }
  return { dir: dir[0] ?? null, expect };
}

function main(): number {
  const { dir, expect } = parseArgs(process.argv.slice(2));
  const target = dir ?? join(fileURLToPath(new URL("..", import.meta.url)), PACKAGING_DIR);
  const problems = collectProblems(target, expect);
  for (const problem of problems) console.log(`artifact-size: ${problem}`);
  console.log(
    problems.length === 0
      ? `artifact-size: OK — distributables under ${target} within the ${knownArtifactTypes().join("/")} ceilings`
      : `artifact-size: ${problems.length} problem(s) found`,
  );
  if (problems.length > 0) {
    console.error(
      "artifact-size: raise a ceiling only on purpose — bump ARTIFACT_BUDGETS in scripts/artifactbudget.ts and justify it in the commit message",
    );
  }
  return problems.length > 0 ? 1 : 0;
}

// CLI guard: run the gate only when executed directly.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) process.exitCode = main();
