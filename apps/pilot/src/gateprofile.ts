/**
 * P2-116 — per-repo gate profile.
 *
 * The pilot is single-repo by construction: the deterministic gate hardcoded
 * THIS repo's battery (typecheck/build/unit + `scripts/*.ts` steps). Pointed
 * at a foreign repo the battery either breaks (the script files do not exist)
 * or — worse — executes whatever the foreign package.json defines, an
 * untrusted execution surface (P1-056). This module resolves the gate battery
 * per workspace instead:
 *
 *   - "pilot":  the workspace IS a pilot checkout (package name or the
 *     pipeline source tree) — the full, unchanged battery runs, invariants
 *     and golden-corpus checks included.
 *   - "node":   a foreign Node/TS repo — ONLY the conventional script names
 *     (typecheck, build, test:unit) that actually exist in its package.json
 *     run, plus lock-sync when a package-lock.json is present. Nothing else
 *     from the foreign package.json is ever executed.
 *   - "unknown": no detectable battery — the gate fails closed.
 *
 * Every step runs with cwd = the repo's own worktree sandbox (the slot
 * workspace), so a foreign target is exercised in its own checkout, never in
 * the production tree. Pure: all fs access is injectable, so the unit battery
 * pins every branch without touching a real repo.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type GateProfileKind = "pilot" | "node" | "unknown";

export interface GateProfile {
  kind: GateProfileKind;
  /** Battery steps as [name, command]; each command runs with cwd = the
   * repo's own worktree sandbox. Empty only for kind "unknown" (fail closed)
   * or a "node" repo with no allowlisted script. */
  steps: Array<[string, string]>;
}

/**
 * The only npm script names the gate may run in a foreign repo. The foreign
 * package.json is untrusted input (P1-056): scripts outside this allowlist —
 * however tempting (`prepare`, `preinstall`, `lint`) — are never executed.
 */
export const GATE_SCRIPT_ALLOWLIST: readonly string[] = ["typecheck", "build", "test:unit"];

/** Step name for an allowlisted script (`test:unit` → the "unit" step). */
function stepName(script: string): string {
  return script === "test:unit" ? "unit" : script;
}

/**
 * npm script names reach `npm run <name> --silent` unquoted — restrict them
 * to npm's documented name charset so no shell metacharacter survives into
 * the spawn. Anything else is dropped (fail closed to the name being absent).
 */
export function isSafeScriptName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9:._-]+$/.test(name);
}

/** The pilot repo's own battery — pinned here so the gate's baseline is one
 * reviewed constant instead of an inline literal in the pipeline. */
export const PILOT_GATE_STEPS: ReadonlyArray<readonly [string, string]> = [
  ["typecheck", "npm run typecheck --silent"],
  ["build", "npm run build --silent"],
  ["unit", "npm run test:unit --silent"],
  ["lock-sync", "npm ci --dry-run --no-audit --no-fund --loglevel=error"],
  ["reconnect", "npx tsx scripts/reconnect.test.ts"],
  ["integration", "npx tsx scripts/integration.ts"],
  ["desktop-sidecar", "npx tsx scripts/desktop-sidecar.test.ts"],
  // NOTE (P1-056): the invariants step lives ONLY in the pinned judge copy
  // (~/.opencode-remote/judge) — never re-add it here; the pilot does not
  // decide the gate. This table now feeds the preflight typecheck decision.
  // NOTE: live tests (download/push/smoke/live-eval) run post-deploy via
  // `invariants --live` + health checks — they need RELAY_URL + prod pairing.
];

export const PILOT_PACKAGE_NAME = "opencode-remote";
export const PILOT_PIPELINE_FILE = "apps/pilot/src/pipeline.ts";

export interface GateProfileDeps {
  exists?: (path: string) => boolean;
  readPackageJson?: (ws: string) => { name?: unknown; scripts?: unknown } | null;
}

function defaultReadPackageJson(ws: string): { name?: unknown; scripts?: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(ws, "package.json"), "utf8")) as { name?: unknown; scripts?: unknown };
  } catch {
    return null;
  }
}

/**
 * Resolve the gate profile for the repo at `ws`. Detection reads only
 * package.json (name + scripts) and checks for two marker paths — it never
 * executes anything from the target repo.
 */
export function detectGateProfile(ws: string, deps: GateProfileDeps = {}): GateProfile {
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  let pkg: { name?: unknown; scripts?: unknown } | null = null;
  try {
    pkg = (deps.readPackageJson ?? defaultReadPackageJson)(ws);
  } catch {
    pkg = null; // unreadable/unparseable manifest → fail closed
  }
  if (!pkg) return { kind: "unknown", steps: [] };  // The pilot checkout gets the full battery — detected by its package name
  // or (belt and braces) by the pipeline source tree itself.
  if (pkg.name === PILOT_PACKAGE_NAME || exists(join(ws, PILOT_PIPELINE_FILE))) {
    return { kind: "pilot", steps: PILOT_GATE_STEPS.map(([n, c]) => [n, c]) };
  }
  const scripts = (typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {}) as Record<
    string,
    unknown
  >;
  const steps: Array<[string, string]> = [];
  // The KEY is the allowlisted name (never shell-interpreted, always one of
  // GATE_SCRIPT_ALLOWLIST); the VALUE is the repo's own command — npm runs it
  // inside the sandbox, so it is only sanity-checked, never parsed.
  for (const script of GATE_SCRIPT_ALLOWLIST) {
    if (typeof scripts[script] === "string") steps.push([stepName(script), `npm run ${script} --silent`]);
  }
  if (exists(join(ws, "package-lock.json"))) {
    steps.push(["lock-sync", "npm ci --dry-run --no-audit --no-fund --loglevel=error"]);
  }
  return { kind: "node", steps };
}
