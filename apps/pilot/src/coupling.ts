/**
 * Coupled-assertion scan (forensic 2026-09-24, recommendation 5). Six lessons
 * (P3-389, P3-413, P3-414, P3-435, P3-449, P3-450) describe the same death at
 * the gate: the diff renames or removes copy, a CSS class or a selector in the
 * product, and a literal assertion in scripts/*.test.ts (desktop-flow, unit)
 * still expects the old text. The prompts ask the agents to grep for it; this
 * is the deterministic backstop computed from the ACTUAL branch diff.
 *
 * A literal is reported only when all of these hold: it sits on a removed
 * line of a product source file (apps/web/src, apps/desktop/src); it is not
 * re-added anywhere in the diff; it no longer occurs in ANY product source
 * file after the change (so it truly vanished from the product); and a test
 * script still contains it. Measured on the 60 most recent UI merges of main
 * (2026-09-27): zero hints on the merged diffs, and with each commit's test
 * hunks removed ("the builder forgot the test") it flagged the 6 commits
 * whose tests really had to change — P3-413 and P3-435 among them. Pure over
 * injected readers, so the battery pins every rule and the pipeline supplies
 * the workspace.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Product sources whose literals the e2e/unit batteries pin. */
export const COUPLING_PRODUCT_PREFIXES: readonly string[] = ["apps/web/src/", "apps/desktop/src/"];

/** The most hints one round receives (each is one line). */
export const COUPLING_MAX_HINTS = 8;

const PRODUCT_EXT_RE = /\.(?:tsx?|css)$/;
const TEST_FILE_RE = /^scripts\/[^/]+\.test\.ts$/;

interface FileHunks {
  removed: string[];
  added: string[];
}

/** Removed/added lines per file of a unified diff (`git diff` output). */
export function parseUnifiedDiff(diff: string): Map<string, FileHunks> {
  const files = new Map<string, FileHunks>();
  let current: FileHunks | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      const path = header[2] ?? "";
      current = files.get(path) ?? { removed: [], added: [] };
      files.set(path, current);
      continue;
    }
    if (!current || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("-")) current.removed.push(line.slice(1));
    else if (line.startsWith("+")) current.added.push(line.slice(1));
  }
  return files;
}

/**
 * Candidate literals of one removed line: user-visible copy (quoted strings
 * or JSX text with a space, >= 8 chars) and kebab-case class/selector/data-
 * attribute tokens (>= 2 segments, >= 6 chars). Import specifiers, paths and
 * URLs are skipped — they are wiring, not asserted copy.
 */
export function couplingLiterals(line: string): string[] {
  const out = new Set<string>();
  const trimmed = line.trim();
  if (/^(?:import|export \* from|\/\/|\*|\/\*)/.test(trimmed)) return [];
  const quoted = [...line.matchAll(/"((?:[^"\\]|\\.){6,160})"|'((?:[^'\\]|\\.){6,160})'|`([^`$\\]{6,160})`/g)];
  for (const m of quoted) {
    const s = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!s || /^(?:\.{1,2}\/|\/|node:|https?:|@)/.test(s)) continue;
    if (s.length >= 8 && /\s/.test(s) && /\p{L}{3}/u.test(s)) out.add(s);
    for (const tok of s.match(/(?<![\w-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![\w-])/g) ?? []) if (tok.length >= 6) out.add(tok);
  }
  for (const m of line.matchAll(/>([^<>{}]{8,160})</g)) {
    const s = (m[1] ?? "").trim();
    if (s.length >= 8 && /\s/.test(s) && /\p{L}{3}/u.test(s)) out.add(s);
  }
  for (const m of line.matchAll(/(?:^|[\s,{(])\.([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g)) {
    const tok = m[1] ?? "";
    if (tok.length >= 6) out.add(tok);
  }
  return [...out];
}

export interface CouplingIo {
  /** Current (post-diff) content of every product source file. */
  productFiles: () => Array<{ path: string; text: string }>;
  /** Current content of every scripts/*.test.ts file. */
  testFiles: () => Array<{ path: string; text: string }>;
}

/** String literals of one test line (source-shape pins, expected copy). */
function testLiterals(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.){8,200})"|'((?:[^'\\]|\\.){8,200})'|`([^`$\\]{8,200})`/g)) {
    const s = m[1] ?? m[2] ?? m[3] ?? "";
    if (s.trim().length >= 8 && !/^(?:\.{1,2}\/|\/|node:|https?:|@)/.test(s)) out.push(s);
  }
  return out;
}

/**
 * The dangling assertions this diff leaves behind, as one-line hints:
 * `scripts/x.test.ts:L still asserts "<literal>" — removed from <file> by
 * this diff and gone from every product source`. Two directions, one rule:
 *  - forward: copy / class tokens on removed product lines, grepped in the
 *    tests (P3-435: the renamed i18n caps label still asserted by desktop-flow);
 *  - reverse: string literals of the tests that sat on a removed product line
 *    (the unit battery's source-shape pins — P3-413 `<PaneMap />`, P2-340/
 *    P3-463 Props signatures, P2-355 `<p className="pane-map-note">`).
 * Either way the literal must be re-added nowhere in the diff and occur in no
 * product source file after it. Empty when nothing dangles.
 */
export function couplingHints(diff: string, io: CouplingIo, max = COUPLING_MAX_HINTS): string[] {
  const files = parseUnifiedDiff(diff);
  const addedEverywhere = [...files.values()].flatMap((f) => f.added).join("\n");
  const removedProduct: Array<{ path: string; line: string }> = [];
  const candidates = new Map<string, string>(); // literal → product file it left
  for (const [path, hunks] of files) {
    if (!COUPLING_PRODUCT_PREFIXES.some((p) => path.startsWith(p)) || !PRODUCT_EXT_RE.test(path)) continue;
    for (const line of hunks.removed) {
      removedProduct.push({ path, line });
      for (const lit of couplingLiterals(line)) {
        if (!candidates.has(lit) && !addedEverywhere.includes(lit)) candidates.set(lit, path);
      }
    }
  }
  if (removedProduct.length === 0) return [];
  const removedJoined = removedProduct.map((r) => r.line).join("\n");
  let product: Array<{ path: string; text: string }> | null = null;
  const inProduct = (lit: string) => (product ??= io.productFiles()).some((f) => f.text.includes(lit));
  const vanished = new Map<string, boolean>();
  const gone = (lit: string) => {
    let v = vanished.get(lit);
    if (v === undefined) {
      v = !addedEverywhere.includes(lit) && !inProduct(lit);
      vanished.set(lit, v);
    }
    return v;
  };
  const hints: string[] = [];
  const seen = new Set<string>();
  const hint = (test: string, lineNo: number, lit: string, from: string): boolean => {
    const key = `${test}\u0000${lit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    hints.push(`${test}:${lineNo} still asserts "${lit.length > 80 ? `${lit.slice(0, 79)}…` : lit}" — removed from ${from} by this diff and gone from every product source`);
    return hints.length >= max;
  };
  for (const test of io.testFiles()) {
    if (!TEST_FILE_RE.test(test.path)) continue;
    const lines = test.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? "";
      for (const [lit, from] of candidates) {
        if (l.includes(lit) && gone(lit) && hint(test.path, i + 1, lit, from)) return hints;
      }
      for (const lit of testLiterals(l)) {
        if (!removedJoined.includes(lit)) continue;
        const src = removedProduct.find((r) => r.line.includes(lit));
        if (src && gone(lit) && hint(test.path, i + 1, lit, src.path)) return hints;
      }
    }
  }
  return hints;
}

/** Prompt block for the hints ("" when there are none). */
export function couplingBlock(hints: string[]): string {
  if (!hints.length) return "";
  return `COUPLED ASSERTIONS (deterministic scan of this branch's diff): these test literals no longer exist anywhere in the product — update each assertion in the same commit (or restore the literal if the rename was unintended); a negative assertion that should keep the old text may stay, say so in the commit body:\n${hints.map((h) => `- ${h}`).join("\n")}`;
}

/** Gate steps whose failure a dangling literal explains (the unit battery's
 * source-shape pins, the e2e flows' expected copy/selectors). */
export const COUPLING_GATE_STEPS: readonly string[] = ["unit", "desktop-flow", "desktop-render"];

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Production reader over a workspace checkout (node_modules / dotfiles /
 * build output skipped). */
export function workspaceCouplingIo(ws: string): CouplingIo {
  const walk = (dir: string, out: string[]) => {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "dist" || e.name === "dist-electron") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (PRODUCT_EXT_RE.test(e.name)) out.push(p);
    }
  };
  const rel = (p: string) => relative(ws, p).split(sep).join("/");
  return {
    productFiles: () => {
      const files: string[] = [];
      for (const prefix of COUPLING_PRODUCT_PREFIXES) walk(join(ws, prefix), files);
      return files.map((f) => ({ path: rel(f), text: readText(f) }));
    },
    testFiles: () => {
      let names: string[] = [];
      try {
        names = readdirSync(join(ws, "scripts")).filter((n) => n.endsWith(".test.ts"));
      } catch {}
      return names.map((n) => ({ path: `scripts/${n}`, text: readText(join(ws, "scripts", n)) }));
    },
  };
}
