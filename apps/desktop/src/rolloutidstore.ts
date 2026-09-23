// P2-342: persistence for the gradual-rollout installation id — a plain
// random UUID written once to userData with mode 0600. The id is the only
// seed of the rollout bucket (updaterollout.ts): it must be stable across
// boots (the machine keeps its seat in the rollout) and must never be
// derived from hardware, from keys or from pairing — it is generated fresh
// by the platform CSPRNG and regenerates (with a fresh write) whenever the
// stored file is missing or illegible.
//
// Thin I/O only — every decision lives in the pure updaterollout.ts, and
// this module follows the quitstore.ts / gpustore.ts precedent: the payload
// lands in a sibling .tmp file created with mode 0600 and a rename moves it
// over the destination, so a crash never leaves a half-written or
// world-readable file behind. Every failure degrades to null (the pure
// verdict fails open — holding a machine by doubt would freeze the fleet,
// the P2-291 lesson) instead of crashing the shell. The file carries ONLY
// the UUID — never a username, never a path, never a credential.

import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { renameSync } from "node:fs";
import { join } from "node:path";

export function rolloutIdFile(userDataDir: string): string {
  return join(userDataDir, "update-rollout-id");
}

/** A plausibly well-formed UUID: 8-4-4-4-12 hex digits. Anything else the
 * file may hold is "illegible" and regenerates. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Read the stored installation id, or mint and persist a fresh one when the
 * file is missing or illegible. The write happens only when no legible id
 * exists (the id is written once); a regenerable file is overwritten with
 * the fresh UUID so the seat stays stable from that boot on. Returns null
 * only when even the regeneration fails — the caller fails open.
 */
export function loadRolloutId(file: string): string | null {
  try {
    const raw = readFileSync(file, "utf8").trim();
    if (UUID_RE.test(raw)) return raw;
  } catch {
    // missing, unreadable or a directory → fall through to regeneration
  }
  const fresh = randomUUID();
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${fresh}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return fresh;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    console.error("[desktop] rollout id write failed:", err);
    return null;
  }
}
