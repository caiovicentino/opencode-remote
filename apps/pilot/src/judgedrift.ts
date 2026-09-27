/**
 * Vendored-protocol drift between the pinned judge and this repo.
 *
 * The judge carries its own copy of packages/protocol/src/crypto.ts
 * (judge/src/protocol.ts) so `invariants --live` can speak the daemon's
 * handshake without importing the code it audits. On 22/09 that copy predated
 * RT-390 (hello timestamp sealed in the token, merged 10/09): every live
 * invariants run was refused and every deploy quarantined for 12 days before
 * anyone re-vendored. This check makes the divergence loud on the first boot
 * after such a merge: both files are compared per top-level symbol after
 * esbuild (already loaded — the pilot runs under tsx) strips types and
 * comments, so comment/type-only edits are not drift, a changed or vanished
 * runtime symbol is. Validated on history: judge@5ff11e8 vs crypto.ts@59e2aca
 * → changed [clientHello, serverAccept]; judge@957106c vs d046075 → none.
 * Same algorithm as the judge's own `judge drift --repo` (src/drift.ts).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DriftReport {
  drift: boolean;
  /** Symbols in both copies whose runtime code differs. */
  changed: string[];
  /** Symbols the judge vendors that the repo no longer defines. */
  onlyInJudge: string[];
  /** New repo symbols the judge never vendored (informational, not drift). */
  onlyInRepo: string[];
  /** Why the comparison itself failed (fail closed: drift true). */
  reason?: string;
}

const DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

type TransformSync = (src: string, opts: Record<string, string>) => { code: string };

/** esbuild reaches the pilot hoisted (tsx/vite depend on it; the pilot
 * package declares nothing) — loaded lazily so a resolution change turns into
 * a failed-closed drift report, never a pilot that cannot boot. */
function esbuildTransform(): TransformSync {
  return (createRequire(import.meta.url)("esbuild") as { transformSync: TransformSync }).transformSync;
}

/** Top-level declarations of a module's runtime code, keyed by name. */
export function runtimeSymbols(src: string): Map<string, string> {
  const js = esbuildTransform()(src, { loader: "ts", format: "esm", target: "es2022", legalComments: "none" }).code;
  const map = new Map<string, string>();
  let cur: string | null = null;
  for (const line of js.split("\n")) {
    const m = line.match(DECL_RE);
    if (m?.[1]) {
      cur = m[1];
      map.set(cur, `${line}\n`);
      continue;
    }
    // esbuild hoists exports into one trailing `export { … };` list that
    // belongs to no symbol
    if (/^export\s*(?:\{|default\b)/.test(line)) {
      cur = null;
      continue;
    }
    if (cur && line.trim()) map.set(cur, `${map.get(cur) ?? ""}${line}\n`);
  }
  return map;
}

/** Pure comparison: judge copy vs repo copy. Never throws. */
export function protocolDrift(judgeSrc: string, repoSrc: string): DriftReport {
  let a: Map<string, string>;
  let b: Map<string, string>;
  try {
    a = runtimeSymbols(judgeSrc);
    b = runtimeSymbols(repoSrc);
  } catch (err) {
    return { drift: true, changed: [], onlyInJudge: [], onlyInRepo: [], reason: `comparison failed: ${String(err).slice(0, 200)}` };
  }
  const changed = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
  const onlyInJudge = [...a.keys()].filter((k) => !b.has(k));
  const onlyInRepo = [...b.keys()].filter((k) => !a.has(k));
  return { drift: changed.length > 0 || onlyInJudge.length > 0, changed, onlyInJudge, onlyInRepo };
}

/**
 * Doctor/preflight entry point: the pinned judge's protocol.ts vs `repo`'s
 * packages/protocol/src/crypto.ts. Read-only, never throws; an unreadable
 * file on either side is drift with a reason (fail closed).
 */
export function judgeProtocolDrift(opts: { repo: string; judgeDir?: string }): DriftReport {
  const judgeFile = join(opts.judgeDir ?? join(homedir(), ".opencode-remote", "judge"), "src", "protocol.ts");
  const repoFile = join(opts.repo, "packages", "protocol", "src", "crypto.ts");
  let judgeSrc: string;
  let repoSrc: string;
  try {
    judgeSrc = readFileSync(judgeFile, "utf8");
    repoSrc = readFileSync(repoFile, "utf8");
  } catch (err) {
    return { drift: true, changed: [], onlyInJudge: [], onlyInRepo: [], reason: `unreadable: ${String(err).slice(0, 200)}` };
  }
  return protocolDrift(judgeSrc, repoSrc);
}

/** One-line operator message for a drift report (alerts, doctor log). */
export function driftSummary(r: DriftReport): string {
  if (!r.drift) return "judge protocol in sync with packages/protocol";
  if (r.reason) return `judge protocol drift check failed closed: ${r.reason}`;
  const parts = [r.changed.length ? `changed ${r.changed.join(", ")}` : "", r.onlyInJudge.length ? `gone from repo ${r.onlyInJudge.join(", ")}` : ""].filter(Boolean);
  return `judge protocol drift: ${parts.join("; ")} — re-vendor judge/src/protocol.ts from packages/protocol/src/crypto.ts and re-pin (the 22/09 live-invariants outage)`;
}
