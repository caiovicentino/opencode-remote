/**
 * P2-133 — orphan-test reachability.
 *
 * A test file that no runner invokes is a lie the repo tells itself: it can
 * rot for months while `test:unit` stays green (the P2-107 recurrence). This
 * module is the deterministic guard: it computes which test files are
 * UNREACHABLE, i.e. not executed by any of the three real runners —
 *
 *   1. the gate battery commands (apps/pilot/src/gateprofile.ts steps),
 *   2. the `test:unit` chain, resolved through the package.json scripts map,
 *   3. the CI workflow (a file cited in its text, or via any npm script the
 *      workflow invokes),
 *
 * — and not explicitly declared in scripts/test-registry.json (live tests
 * that need a paired daemon/production RELAY_URL or a real Electron, listed
 * there with runner + reason). A script merely DECLARED in package.json but
 * never invoked by a runner counts as nothing: declaration is not coverage.
 *
 * Pure by construction: no fs, no network, no process — the caller reads the
 * real-world inputs (package.json, gate profile, workflow text, registry) and
 * injects them, so the unit battery can pin every branch with synthetic
 * fixtures and the real-repo assertion in scripts/unit.test.ts fails the gate
 * whenever a future test file goes orphan.
 */

export interface TestRegistryEntry {
  /** Test file path as it lives in the repo (e.g. "scripts/foo.test.ts"). */
  file: string;
  /** The runner that actually executes it (free text, e.g. an npm script). */
  runner: string;
  /** Why it is intentionally outside the gate battery. */
  reason: string;
}

/** The registry is a bare entry array on disk; accept the wrapped form too. */
export type DeclaredRegistry = readonly TestRegistryEntry[] | { entries?: readonly TestRegistryEntry[] };

/** npm script invocation inside a command body (`npm run <name> [-- args]`). */
const SCRIPT_NAME_RE = /\bnpm run ([A-Za-z0-9:._-]+)/g;

/** Characters that must not be part of a citation match around a basename. */
const WORDish = "[A-Za-z0-9_.-]";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** True when `text` cites the test file by basename on a path-like boundary. */
export function citesFile(text: string, file: string): boolean {
  const base = basename(file);
  if (!base) return false;
  const re = new RegExp(`(?<!${WORDish})${escapeRe(base)}(?!${WORDish})`);
  return re.test(text);
}

/**
 * Expand command seeds through the package.json scripts map: every
 * `npm run <name>` whose body is known gets that body treated as reachable
 * too (transitively, cycle-guarded). Scripts that exist but are never
 * referenced by a reachable command are never expanded — declared-but-never-
 * invoked scripts are not coverage.
 */
export function reachableCommands(
  seeds: readonly string[],
  scripts: Readonly<Record<string, string>>,
): string[] {
  const out = new Set<string>();
  const visitedScripts = new Set<string>();
  const queue: string[] = [...seeds];
  while (queue.length > 0) {
    const cmd = queue.shift()!;
    if (out.has(cmd)) continue;
    out.add(cmd);
    SCRIPT_NAME_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SCRIPT_NAME_RE.exec(cmd)) !== null) {
      const name = m[1];
      if (visitedScripts.has(name)) continue;
      visitedScripts.add(name);
      const body = scripts[name];
      if (typeof body === "string") queue.push(body);
    }
  }
  return [...out];
}

function registryFiles(registry: DeclaredRegistry): Set<string> {
  const list = Array.isArray(registry) ? registry : (registry.entries ?? []);
  return new Set(
    list.filter((e) => typeof e?.file === "string" && e.file.length > 0).map((e) => basename(e.file.toLowerCase())),
  );
}

/**
 * The names of npm scripts the CI workflow actually invokes, so their chains
 * count as coverage only when the workflow runs them.
 */
export function scriptsInvokedByCi(ciText: string): string[] {
  SCRIPT_NAME_RE.lastIndex = 0;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_NAME_RE.exec(ciText)) !== null) names.push(m[1]);
  return names;
}

/**
 * Return the test files that no runner reaches: absent from the gate battery,
 * from the (expanded) `test:unit` chain, from the CI workflow, and from the
 * declared registry. Input order is preserved.
 */
export function unreachableTests(
  testFiles: readonly string[],
  scripts: Readonly<Record<string, string>>,
  gateCommands: readonly string[],
  ciText: string,
  registry: DeclaredRegistry,
): string[] {
  const declared = registryFiles(registry);
  // Seed the reachable universe with the gate battery plus every npm script
  // the CI workflow invokes (the CI text itself is checked verbatim below).
  const ciScriptBodies = scriptsInvokedByCi(ciText)
    .map((name) => scripts[name])
    .filter((b): b is string => typeof b === "string");
  const commands = reachableCommands([...gateCommands, ...ciScriptBodies], scripts);
  const orphans: string[] = [];
  for (const file of testFiles) {
    const base = basename(file).toLowerCase();
    if (declared.has(base)) continue; // intentionally outside the gate, with a reason
    if (citesFile(ciText, file)) continue;
    if (commands.some((c) => citesFile(c, file))) continue;
    orphans.push(file);
  }
  return orphans;
}
