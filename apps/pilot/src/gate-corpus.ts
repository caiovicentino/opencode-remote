/**
 * P3-033: golden corpus for the deterministic evidence gates.
 *
 * The evidence matcher (evidenceMatches/normalizeEvidenceLine) has
 * false-positive modes that only show up against real output variation —
 * e.g. P1-030 was rejected because two green runs of the same command print
 * different timestamps. This module owns the corpus of REAL, sanitized
 * outputs of the three evidence commands, captured from green gate rounds:
 *
 *   apps/pilot/src/__fixtures__/gate-corpus/<command-slug>/<seq>-<label>.txt
 *
 * The eval battery (scripts/unit.test.ts) loads every sample and asserts the
 * matcher still accepts it (self, truncated, noisy, same-commit cross-pairs)
 * and still rejects a fabricated line — so a false-positive regression fails
 * the battery before it can block honest merges.
 *
 * Growth: every `corpusEveryNMerges` successful merges the gatekeeper records
 * its own re-run outputs here (captureGateCorpus), commit `pilot(corpus): ...`.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, rerunKey } from "./runner";

export const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "gate-corpus");

/** The three commands the evidence gate re-executes (pipeline EVIDENCE_COMMANDS,
 * mirrored here without importing pipeline.ts — keeps this module cycle-free). */
export const CORPUS_COMMANDS: readonly string[] = [
  "npm run typecheck --silent",
  "npm run test:unit --silent",
  "npm run build --silent",
];

export function corpusSlug(cmd: string): string {
  return cmd.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
}

/**
 * Mask machine-specific text before a real output enters the repo: usernames
 * in absolute paths and any long hex blob (defensive secret guard). Matching
 * is done later by normalizeEvidenceLine; this only scrubs what must never be
 * committed and what would differ between two machines.
 */
export function sanitizeForCorpus(output: string, home = process.env.HOME ?? ""): string {
  return output
    .split("\n")
    .map((l) => {
      if (home) l = l.replaceAll(home + "/", "~/");
      return l
        .replace(/\/Users\/[A-Za-z0-9_.-]+/g, "/Users/USER")
        .replace(/\/home\/[A-Za-z0-9_.-]+/g, "/home/USER")
        .replace(/\b[0-9a-f]{32,}\b/g, "HEX");
    })
    .join("\n");
}

export interface CorpusSample {
  cmd: string;
  file: string;
  /** commit-ish label the output was captured at; cross-pairs are only
   * compared within the same label (different commits legitimately diverge). */
  label: string;
  output: string;
}

export function loadGateCorpus(dir = CORPUS_DIR): CorpusSample[] {
  const samples: CorpusSample[] = [];
  if (!readdirSafe(dir)) return samples;
  for (const cmd of CORPUS_COMMANDS) {
    const d = join(dir, corpusSlug(cmd));
    for (const f of readdirSafe(d) ?? []) {
      if (!/^\d+-[A-Za-z0-9.-]+\.txt$/.test(f)) continue;
      const label = f.replace(/^\d+-/, "").replace(/\.txt$/, "");
      samples.push({ cmd, file: `${corpusSlug(cmd)}/${f}`, label, output: readFileSync(join(d, f), "utf8") });
    }
  }
  return samples;
}

function readdirSafe(d: string): string[] | null {
  try {
    return readdirSync(d).sort();
  } catch {
    return null;
  }
}

/**
 * Append one real output as the newest sample of `cmd`. Skipped when the
 * sanitized output equals the most recent sample (e.g. silent typecheck) so
 * the corpus only grows when there is new variation. Returns the file written.
 */
export function appendCorpusSample(dir: string, cmd: string, sanitized: string, label: string): string | null {
  const d = join(dir, corpusSlug(cmd));
  mkdirSync(d, { recursive: true });
  const files = readdirSync(d).filter((f) => /^\d+-[A-Za-z0-9.-]+\.txt$/.test(f)).sort();
  const last = files.at(-1);
  if (last && readFileSync(join(d, last), "utf8") === sanitized) return null;
  const seq = files.length + 1;
  const file = `${seq}-${label}.txt`;
  writeFileSync(join(d, file), sanitized);
  return `${corpusSlug(cmd)}/${file}`;
}

/**
 * Post-merge corpus growth: record the gate's own re-run outputs (already
 * executed inside the evidence gate — no extra npm runs) as sanitized corpus
 * samples and push the commit to main (scribe-style retry loop: concurrent
 * slots can move main between reset and push). Called by the gatekeeper right
 * after a green merge, inside the gate lock, every `corpusEveryNMerges`
 * successful merges. Writes only inside the pilot workspace `ws`. Returns the
 * files written, for logging.
 */
export function captureGateCorpus(
  ws: string,
  taskId: string,
  reruns: Map<string, { ok: boolean; output: string }>,
): string[] {
  // interpolation guard: taskId reaches a shell command below
  const id = /^[A-Za-z0-9]+-[A-Za-z0-9-]+$/.test(taskId) ? taskId : "unknown-task";
  const label = exec("git rev-parse --short HEAD", { cwd: ws, allowFail: true }).output.trim() || "unknown";
  const dir = join(ws, "apps", "pilot", "src", "__fixtures__", "gate-corpus");
  const sanitized = new Map<string, string>();
  for (const cmd of CORPUS_COMMANDS) {
    // P2-040: the map is the round's shared cache keyed by command+workspace
    const r = reruns.get(rerunKey(cmd, ws));
    if (r?.ok) sanitized.set(cmd, sanitizeForCorpus(r.output).trimEnd() + "\n");
  }
  if (!sanitized.size) return [];
  for (let attempt = 0; attempt < 3; attempt++) {
    // git clean wipes the untracked samples on a retry — re-append every round;
    // the dedupe in appendCorpusSample compares against the committed corpus
    exec("git fetch -q origin", { cwd: ws, allowFail: true });
    exec("git checkout -q main", { cwd: ws, allowFail: true });
    exec("git reset -q --hard origin/main", { cwd: ws, allowFail: true });
    exec("git clean -qfd", { cwd: ws, allowFail: true });
    const written: string[] = [];
    for (const [cmd, out] of sanitized) {
      const f = appendCorpusSample(dir, cmd, out, label);
      if (f) written.push(f);
    }
    if (!written.length) return []; // nothing new vs the committed corpus
    const commit = exec(
      `git add apps/pilot/src/__fixtures__/gate-corpus && git commit -qm "pilot(corpus): ${written.length} gate sample(s) from ${id}"`,
      { cwd: ws, allowFail: true },
    );
    if (commit.ok && exec("git push -q origin main", { cwd: ws, allowFail: true }).ok) return written;
  }
  return [];
}
