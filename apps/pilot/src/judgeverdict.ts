/**
 * Verdict signature verification (P1-056) — verify-only mirror of the judge's
 * verdict module. The pilot NEVER signs: the ed25519 private key lives only
 * in the judge dir, so a compromised pipeline cannot forge a green gate.
 */
import { verify, createHash } from "node:crypto";

export interface Verdict {
  sha: string;
  task: string;
  ok: boolean;
  step: string;
  tail: string;
  flaky: string[];
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
