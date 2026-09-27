/**
 * Verdict signature verification (P1-056) — verify-only mirror of the judge's
 * verdict module. The pilot NEVER signs: the ed25519 private key lives only
 * in the judge dir, so a compromised pipeline cannot forge a green gate.
 *
 * Verdict v2 (judge package.json `ocrJudge.verdict >= 2`) binds a verdict to
 * ONE request and ONE judge: the pilot's random nonce is echoed inside the
 * signed payload (a verdict captured for another request cannot be replayed),
 * `judge` is the judge HEAD that produced it and `base` the merge base of the
 * judge's own diff. `checkVerdictBinding` is the single place those fields
 * are enforced.
 */
import { verify, createHash } from "node:crypto";

export interface Verdict {
  sha: string;
  task: string;
  ok: boolean;
  step: string;
  tail: string;
  flaky: string[];
  v?: number;
  nonce?: string;
  judge?: string;
  base?: string;
  /** P3-353: the diff touched protected gate machinery (authorized or not). */
  constitutionChange?: boolean;
  /** P3-353: protected changes NOT authorized for this task. */
  protected?: string[];
  /** P3-359: flaky passes counted against the judge's per-step budget. */
  flakes?: { step: string; count: number; budget: number; exhausted: boolean }[];
  /** eval-04: early-warning lines of green steps (e.g. desktop-flow above 80% of its budget). */
  warnings?: string[];
  /** Operator/runtime files changed outside the battery sandbox (verdict refused). */
  runtimeChanged?: string[];
  /** launchctl mutating verbs / pattern kills the battery tried (verdict refused). */
  blockedCommands?: string[];
}

export function hashVerdict(v: Verdict): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

export function verifyVerdict(pubPem: string, v: Verdict, sigB64: string): boolean {
  try {
    return verify(null, Buffer.from(hashVerdict(v), "hex"), pubPem, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

export interface VerdictExpectation {
  sha: string;
  task: string;
  nonce: string;
  /** Pinned judge commit (prefix accepted, like judge.json). */
  pin: string;
  /** Verdict version the pinned judge declares (1 = pre-binding judge). */
  version: number;
}

/**
 * Null when a signature-valid verdict belongs to THIS request, else the
 * reason. sha and task are always bound; a v2 judge must also echo the nonce
 * and name a HEAD matching the pin. A v1 judge (pinned before the binding
 * existed) is accepted on sha + task alone — the pin itself attests that the
 * operator chose that judge.
 */
export function checkVerdictBinding(v: Verdict, want: VerdictExpectation): string | null {
  if (v.sha !== want.sha) return `judge verdict is for ${String(v.sha).slice(0, 12)}, not ${want.sha.slice(0, 12)}`;
  if (v.task !== want.task) return `judge verdict is for task ${String(v.task)}, not ${want.task}`;
  if (want.version < 2) return null;
  if (v.nonce !== want.nonce) return "judge verdict nonce mismatch — replayed or cross-request verdict";
  if (typeof v.judge !== "string" || !want.pin || !v.judge.startsWith(want.pin)) {
    return `judge verdict signed by judge ${String(v.judge).slice(0, 8)}, pinned ${want.pin.slice(0, 8)}`;
  }
  return null;
}
