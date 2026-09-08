/**
 * P3-352 (eval r4): collector for the `ci-gate` aggregate job.
 *
 * Reads the file the job wrote from `toJSON(needs)`, hands the parsed value to
 * the pure verdict (scripts/cigate.ts), prints every line and exits 1 on a
 * red verdict. A missing or unreadable file is a red verdict too — a failed
 * read must never turn into a green gate.
 *
 * Usage: npx tsx scripts/check-ci-gate.ts <needs.json>
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ciGateVerdict, type CiGateVerdict } from "./cigate";

/** Read + parse + decide; never throws — every failure is a red verdict. */
export function runCiGate(file: string | undefined): CiGateVerdict {
  if (!file) return { verdict: "red", lines: ["ci-gate: RED — no needs file given"] };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { verdict: "red", lines: [`ci-gate: RED — cannot read ${file}: ${String(err).slice(0, 120)}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { verdict: "red", lines: ["ci-gate: RED — needs file is not valid JSON"] };
  }
  return ciGateVerdict(parsed);
}

function main(): number {
  const r = runCiGate(process.argv[2]);
  for (const line of r.lines) console.log(line);
  console.log(r.verdict === "green" ? "ci-gate: GREEN — every job succeeded or was legitimately skipped" : "ci-gate: RED — at least one required job did not succeed");
  return r.verdict === "green" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
// keep fileURLToPath referenced for parity with the sibling collectors' import shape
void fileURLToPath;
