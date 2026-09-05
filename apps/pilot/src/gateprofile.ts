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
 *   - "pilot":  the workspace IS the operator's production checkout or one of
 *     its slot clones (pilot/repo-N) — the full, unchanged battery runs,
 *     invariants and golden-corpus checks included.
 *   - "generic": any other path — a foreign repo (self-serve mission,
 *     mission.json repoUrl, cloned under pilot/mission/<key>/) — ONLY the
 *     conventional script names typecheck|build|test|lint that actually exist
 *     in its package.json run, from the target repo, each capped at
 *     GENERIC_STEP_TIMEOUT_MIN. Nothing else from the foreign package.json is
 *     ever executed; constitution invariants never run there.
 *   - "unknown": no detectable battery — the gate fails closed.
 *
 * Mission v2 (hardening a): the "pilot" profile is pinned to the PRODUCTION
 * CHECKOUT PATH, never to a package.json field. The previous detection keyed
 * off `name: "opencode-remote"` (or the presence of apps/pilot/src/pipeline.ts)
 * — a foreign repo carrying that name got the FULL pilot battery, i.e. its own
 * scripts/*.ts ran as our invariants (arbitrary code). Repo CONTENT is
 * attacker-controlled; the workspace PATH is chosen by the scheduler and is
 * not.
 *
 * Every step runs with cwd = the repo's own worktree sandbox (the slot
 * workspace), so a foreign target is exercised in its own checkout, never in
 * the production tree. Pure: all fs access is injectable, so the unit battery
 * pins every branch without touching a real repo.
 *
 * NOTE: this is the in-repo mirror of the judge's gateprofile.ts
 * (~/.opencode-remote/judge/src) — the judge decides the gate; this copy only
 * feeds the pilot's preflight typecheck decision and the unit battery. The
 * judge copy is pinned by the operator; see docs/PILOT.md for the re-pin.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type GateProfileKind = "pilot" | "generic" | "unknown";

export interface GateProfile {
  kind: GateProfileKind;
  /** Battery steps as [name, command]; each command runs with cwd = the
   * repo's own worktree sandbox. Empty only for kind "unknown" (fail closed)
   * or a "generic" repo with no allowlisted script (also fails closed). */
  steps: Array<[string, string]>;
  /** Per-step wall-clock cap (minutes); absent = the gate's default. */
  stepTimeoutMin?: number;
}

/**
 * The only npm script names the gate may run in a foreign repo. The foreign
 * package.json is untrusted input (P1-056): scripts outside this allowlist —
 * however tempting (`prepare`, `preinstall`, `postinstall`) — are never
 * executed. The step name IS the script name.
 */
export const GENERIC_GATE_SCRIPTS: readonly string[] = ["typecheck", "build", "test", "lint"];

/** Wall-clock cap per generic step — a foreign test suite cannot hold a slot. */
export const GENERIC_STEP_TIMEOUT_MIN = 10;

/**
 * npm script names reach `npm run <name> --silent` unquoted — restrict them
 * to npm's documented name charset so no shell metacharacter survives into
 * the spawn. Anything else is dropped (fail closed to the name being absent).
 */
export function isSafeScriptName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9:._-]+$/.test(name);
}

/**
 * Generic battery for a foreign repo, derived from its own package.json
 * `scripts` table: one step per allowlisted name that exists with a non-empty
 * command, in allowlist order. The KEY is what reaches the shell (always one
 * of GENERIC_GATE_SCRIPTS, charset-checked); the VALUE is the repo's own
 * command, run by npm inside the sandbox — never parsed, never trusted.
 */
export function buildGenericProfile(scripts: unknown): GateProfile {
  const table = (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts) ? scripts : {}) as Record<
    string,
    unknown
  >;
  const steps: Array<[string, string]> = [];
  for (const name of GENERIC_GATE_SCRIPTS) {
    if (!isSafeScriptName(name)) continue;
    const cmd = table[name];
    if (typeof cmd === "string" && cmd.trim()) steps.push([name, `npm run ${name} --silent`]);
  }
  return { kind: "generic", steps, stepTimeoutMin: GENERIC_STEP_TIMEOUT_MIN };
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

/**
 * The operator's production checkout — the ONLY tree (plus its slot clones)
 * that earns the pilot battery. Same source of truth as PilotConfig.repo
 * (state.ts DEFAULTS): OCR_PILOT_REPO or the hardcoded operator path.
 */
export const PILOT_PROD_CHECKOUT = process.env.OCR_PILOT_REPO ?? "/Volumes/SSD Major/Major/opencode-remote";

/** Where the scheduler creates slot clones of the production checkout
 * (`<root>/repo-<n>`). Foreign missions clone under `<root>/mission/<key>/`,
 * which is a different parent — never a pilot path. */
export const PILOT_SLOT_ROOT = join(homedir(), ".opencode-remote", "pilot");

export const PILOT_SLOT_DIR_RE = /^repo-\d+$/;

export interface GateProfileDeps {
  readPackageJson?: (ws: string) => { name?: unknown; scripts?: unknown } | null;
  /** Production checkout path (default PILOT_PROD_CHECKOUT). */
  prodCheckout?: string;
  /** Slot-clone root of the production checkout (default PILOT_SLOT_ROOT). */
  slotRoot?: string;
}

/**
 * Mission v2 (hardening a): is `ws` the production checkout or one of its
 * direct slot clones (`<slotRoot>/repo-<n>`)? Pure path comparison after
 * normalization (trailing slashes, `..` segments) — no fs, no repo content.
 * `<slotRoot>/mission/<key>/repo-1` is NOT a pilot path: its parent is the
 * mission directory, not the slot root.
 */
export function isPilotCheckoutPath(ws: string, deps: Pick<GateProfileDeps, "prodCheckout" | "slotRoot"> = {}): boolean {
  if (typeof ws !== "string" || !ws) return false;
  const target = resolve(ws);
  if (target === resolve(deps.prodCheckout ?? PILOT_PROD_CHECKOUT)) return true;
  return dirname(target) === resolve(deps.slotRoot ?? PILOT_SLOT_ROOT) && PILOT_SLOT_DIR_RE.test(basename(target));
}

function defaultReadPackageJson(ws: string): { name?: unknown; scripts?: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(ws, "package.json"), "utf8")) as { name?: unknown; scripts?: unknown };
  } catch {
    return null;
  }
}

/**
 * Resolve the gate profile for the repo at `ws`. The pilot profile is decided
 * by PATH alone (isPilotCheckoutPath); everything else reads only package.json
 * `scripts` — it never executes anything from the target repo and never
 * trusts a package.json field to promote a workspace to the pilot battery.
 */
export function detectGateProfile(ws: string, deps: GateProfileDeps = {}): GateProfile {
  // the production checkout / its slot clones get the full battery — by
  // path, never by package.json content (a foreign repo can name itself
  // "opencode-remote" and ship an apps/pilot/src/pipeline.ts; it cannot move
  // its clone out of pilot/mission/<key>/)
  if (isPilotCheckoutPath(ws, deps)) {
    return { kind: "pilot", steps: PILOT_GATE_STEPS.map(([n, c]) => [n, c]) };
  }
  let pkg: { name?: unknown; scripts?: unknown } | null = null;
  try {
    pkg = (deps.readPackageJson ?? defaultReadPackageJson)(ws);
  } catch {
    pkg = null; // unreadable/unparseable manifest → fail closed
  }
  if (!pkg) return { kind: "unknown", steps: [] };
  // foreign repo (self-serve mission): the generic battery from its own
  // package.json scripts — nothing outside GENERIC_GATE_SCRIPTS ever runs
  return buildGenericProfile(pkg.scripts);
}
