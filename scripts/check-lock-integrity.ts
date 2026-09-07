#!/usr/bin/env node
/**
 * P2-283: lockfile-integrity collector and CI gate.
 *
 * Reads the real package-lock.json, normalizes every entry of the `packages`
 * map (no YAML/lockfile library — the same hand-rolled approach the
 * workflow-reading tests and scripts/check-action-pins.ts already use), feeds
 * the normalized list to the pure verdict in scripts/lockintegrity.ts and
 * prints its report. A missing file, an unreadable file and content that
 * does not parse become a failed-read entry instead of a thrown error, so a
 * renamed lockfile can never crash the pipeline or — worse — silently
 * approve; the pure verdict turns a failed read into a warning (P2-283
 * rule 1).
 *
 * Exit codes: 1 only on a reject verdict (an origin outside the documented
 * public registries, or a registry origin without a declared integrity
 * hash). Warn and approve exit 0. The documented registries live in
 * scripts/lock-registries.json and the deadlined exemptions in
 * scripts/lock-exemptions.json; see docs/security.md.
 *
 * Run: npx tsx scripts/check-lock-integrity.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  lockIntegrityVerdict,
  type LockEntry,
  type LockExemption,
} from "./lockintegrity";

/** The real lockfile the gate covers, repo-root relative. */
export const LOCK_FILE = "package-lock.json";

/** Versioned lists: the accepted public registries and the deadlined exemptions. */
export const REGISTRIES_FILE = "scripts/lock-registries.json";
export const EXEMPTIONS_FILE = "scripts/lock-exemptions.json";

/**
 * Normalize one entry of the `packages` map. A package of this very
 * repository is the root key "", a workspace directory (any path outside
 * `node_modules/`) or a `node_modules/<name>` link whose origin is a
 * relative path into the repository — never a registry URL.
 */
function normalizeEntry(path: string, doc: unknown): LockEntry {
  const pkg = (doc ?? {}) as { resolved?: unknown; integrity?: unknown };
  const resolved = typeof pkg.resolved === "string" ? pkg.resolved : "";
  const integrity = typeof pkg.integrity === "string" ? pkg.integrity : "";
  const internal =
    path === "" ||
    // A workspace directory of this repository ("apps/daemon") — a path with
    // no node_modules segment at all. A nested path such as
    // "apps/desktop/node_modules/@esbuild/linux-arm" still contains one and
    // stays subject to the registry checks.
    !path.includes("node_modules/") ||
    // A node_modules link whose origin is a relative path into this very
    // repository (e.g. "apps/daemon"). An absent origin never counts as
    // internal — a package nobody can vouch for is not the repo's own.
    (resolved !== "" && !resolved.includes("://"));
  return { path, resolved, integrity, internal };
}

/**
 * Normalize the parsed lockfile document into the entry list the pure
 * verdict consumes. Throws only on shapes the gate refuses to guess (no
 * `packages` map) — the caller turns that into a failed read.
 */
export function normalizeLockEntries(doc: unknown): LockEntry[] {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("lockfile document is not an object");
  }
  const packages = (doc as { packages?: unknown }).packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("no `packages` map found");
  }
  return Object.entries(packages as Record<string, unknown>).map(([path, pkg]) =>
    normalizeEntry(path, pkg),
  );
}

/** Read the real lockfile; missing, unreadable and unparseable all fail the read. */
function readLockEntries(repoRoot: string): LockEntry[] {
  let text: string;
  try {
    text = readFileSync(`${repoRoot}/${LOCK_FILE}`, "utf8");
  } catch {
    return [{ path: LOCK_FILE, resolved: "", integrity: "", internal: false, readFailed: true }];
  }
  try {
    return normalizeLockEntries(JSON.parse(text));
  } catch {
    return [{ path: LOCK_FILE, resolved: "", integrity: "", internal: false, readFailed: true }];
  }
}

/** Read the versioned accepted registries; a broken file trusts nothing (fail closed). */
function loadRegistries(repoRoot: string): string[] {
  try {
    const data = JSON.parse(readFileSync(`${repoRoot}/${REGISTRIES_FILE}`, "utf8")) as {
      registries?: unknown;
    };
    return Array.isArray(data.registries)
      ? data.registries.filter((r): r is string => typeof r === "string")
      : [];
  } catch {
    return [];
  }
}

/** Read the versioned exemptions; a broken file exempts nothing (fail closed). */
function loadExemptions(repoRoot: string): LockExemption[] {
  try {
    const data = JSON.parse(readFileSync(`${repoRoot}/${EXEMPTIONS_FILE}`, "utf8")) as {
      exemptions?: unknown;
    };
    return Array.isArray(data.exemptions) ? (data.exemptions as LockExemption[]) : [];
  } catch {
    return [];
  }
}

function main(): number {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const entries = readLockEntries(repoRoot);
  const checked = entries.filter((e) => !e.internal && !e.readFailed).length;
  const report = lockIntegrityVerdict(
    entries,
    loadRegistries(repoRoot),
    loadExemptions(repoRoot),
    Date.now(),
  );
  for (const line of report.lines) console.log(line);
  console.log(`lock-integrity: verdict ${report.outcome} (${checked} third-party package(s) checked)`);
  return report.outcome === "reject" ? 1 : 0;
}

// CLI guard: run the gate only when executed directly.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) process.exitCode = main();
