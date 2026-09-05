// P2-165: durable persistence of the daemon state file (daemon.json). The file
// carries the machine identity — ECDH keys, VAPID keys, machine name, paired
// clients — and used to be persisted with writeFileSync + chmodSync: a crash,
// OOM or power loss mid-write left a truncated JSON that never boots again
// (forcing the stage-3 user to re-pair everything), and between the write and
// the chmod the file existed with default permissions, readable by others.
// Same tmp+rename contract as the pilot's own state file (P2-024): the payload
// lands in a sibling temp file created with mode 0600 and a rename moves it
// over the destination — rename is atomic within the same filesystem, so
// readers only ever see the old or the new full contents. Structural fs
// injection as in desktop-log.ts: scripts/unit.test.ts exercises the real
// logic against a fake fs, never touching disk.

import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Structural subset of node:fs writeStateAtomic touches (tests inject fakes). */
export interface StateFileFs {
  writeFileSync(file: string, data: string, opts: { mode: number }): void;
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
}

export const nodeStateFileFs: StateFileFs = {
  writeFileSync: (file, data, opts) => writeFileSync(file, data, opts),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (file) => unlinkSync(file),
};

/**
 * Write `data` over `file` atomically: a sibling `<file>.tmp` is created with
 * mode 0600 (rename preserves it), renamed over the destination, and removed
 * again on any failure — the error is rethrown for the caller to decide. The
 * destination is never observed half-written, and it is never readable by
 * group/other, not even for an instant.
 */
export function writeStateAtomic(file: string, data: string, fs: StateFileFs = nodeStateFileFs): void {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}
