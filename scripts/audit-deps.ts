#!/usr/bin/env node
/**
 * P2-269: dependency advisory collector and CI gate.
 *
 * Runs npm audit over the whole workspace tree (full tree plus the
 * production-only pass, so an advisory that reaches only development
 * dependencies can be classified), normalizes the result into the shape
 * scripts/auditverdict.ts expects and prints its report. Any collection
 * failure — execution failure, empty output, output that is not valid JSON —
 * becomes a failed collection instead of a thrown error, so an advisory
 * registry outage can never crash the pipeline: the pure verdict turns it
 * into a warning and the job stays green (P2-269 rule 1).
 *
 * Exit codes: 1 only on a reject verdict (a high or critical advisory in a
 * runtime dependency without a still-valid exemption). Warn and approve
 * exit 0. Exemptions with a documented deadline live in
 * scripts/audit-exemptions.json; see docs/security.md.
 *
 * Run: npx tsx scripts/audit-deps.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  auditVerdict,
  AUDIT_SEVERITY_FLOOR,
  type AuditAdvisory,
  type AuditCollection,
  type AuditSeverity,
  type AuditExemption,
} from "./auditverdict";

/** Versioned exemption list, one entry per exempted advisory id. */
const EXEMPTIONS_FILE = "scripts/audit-exemptions.json";

interface RawViaObject {
  source?: number;
  url?: string;
  severity?: string;
}

interface RawVulnerability {
  severity?: string;
  via?: Array<string | RawViaObject>;
}

interface RawAudit {
  vulnerabilities?: Record<string, RawVulnerability>;
}

/**
 * One npm audit invocation, parsed. npm audit exits non-zero both when
 * advisories exist and when it fails, so the exit code is ignored on
 * purpose: the collection is good exactly when stdout carries valid JSON
 * with a vulnerabilities object.
 */
function runAuditJson(extra: readonly string[]): RawAudit | null {
  let out = "";
  try {
    out = execFileSync("npm", ["audit", "--json", ...extra], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    if (typeof stdout !== "string") return null;
    out = stdout;
  }
  if (out.trim() === "") return null;
  try {
    const data = JSON.parse(out) as RawAudit;
    if (
      data === null ||
      typeof data !== "object" ||
      data.vulnerabilities === null ||
      typeof data.vulnerabilities !== "object"
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/** GHSA identifier from an advisory URL, or "" when the shape is unexpected. */
function ghsaFromUrl(url: string): string {
  const tail = url.split("/").filter(Boolean).pop() ?? "";
  return tail.startsWith("GHSA-") ? tail : "";
}

/** npm severity string → the closed AuditSeverity set, unknown fails closed. */
function normalizeSeverity(raw: string | undefined): AuditSeverity {
  const value = (raw ?? "").toLowerCase();
  if (value === "low") return "low";
  if (value === "moderate" || value === "medium") return "moderate";
  if (value === "high") return "high";
  return "critical";
}

/**
 * Flatten the npm audit vulnerability graph into the normalized advisory
 * list. String `via` entries are references to another entry in the same
 * report (the dependency chain) and are skipped — each real advisory object
 * is emitted exactly once, marked dev-only when the package is absent from
 * the production-only pass.
 */
function normalizeAdvisories(
  full: RawAudit | null,
  prod: RawAudit | null,
): AuditAdvisory[] {
  const prodNames = new Set(Object.keys(prod?.vulnerabilities ?? {}));
  const out: AuditAdvisory[] = [];
  for (const [name, vuln] of Object.entries(full?.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === "string") continue;
      const id = (via.url ? ghsaFromUrl(via.url) : "") || String(via.source ?? name);
      out.push({
        id,
        package: name,
        severity: normalizeSeverity(via.severity ?? vuln.severity),
        devOnly: !prodNames.has(name),
      });
    }
  }
  return out;
}

/** Read the versioned exemption list; a broken file exempts nothing. */
function loadExemptions(): AuditExemption[] {
  try {
    const raw = readFileSync(
      fileURLToPath(new URL(EXEMPTIONS_FILE, import.meta.url)),
      "utf8",
    );
    const data = JSON.parse(raw) as { exemptions?: unknown };
    if (!data || !Array.isArray(data.exemptions)) return [];
    return data.exemptions
      .filter((e): e is AuditExemption =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as AuditExemption).id === "string" &&
        typeof (e as AuditExemption).reason === "string" &&
        typeof (e as AuditExemption).expiresAt === "string",
      );
  } catch {
    return [];
  }
}

function main(): number {
  const full = runAuditJson([]);
  const prod = runAuditJson(["--omit=dev"]);
  const collection: AuditCollection = {
    ok: full !== null && prod !== null,
    advisories: full !== null && prod !== null ? normalizeAdvisories(full, prod) : [],
  };
  const report = auditVerdict(
    collection,
    loadExemptions(),
    Date.now(),
    AUDIT_SEVERITY_FLOOR,
  );
  for (const line of report.lines) console.log(line);
  console.log(`audit-deps: verdict ${report.outcome}`);
  return report.outcome === "reject" ? 1 : 0;
}

// CLI guard: run the gate only when executed directly.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) process.exitCode = main();
