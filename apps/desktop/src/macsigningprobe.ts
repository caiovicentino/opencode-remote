// eval-16: reads the RUNNING bundle's signature for update.ts — the one
// process execution of the update path, kept out of update.ts on purpose:
// P2-233 pins update.ts and main.ts free of child_process because the
// updater never executes anything it downloaded. This module runs exactly
// one fixed command — Apple's /usr/bin/codesign in display mode — against
// exactly one target, the bundle of process.execPath. It takes no path from
// its caller, so it can never be pointed at a downloaded file. The verdict
// itself is the pure macsigning.ts.
import { app } from "electron";
import { execFile } from "node:child_process";
import { bundlePathFromExec, macSigningFromCodesign, type MacSigning } from "./macsigning";

/** The only binary this module ever runs. */
export const CODESIGN_BIN = "/usr/bin/codesign";
/** Display mode only — codesign never signs or modifies anything with these. */
export const CODESIGN_ARGS: readonly string[] = ["-dv", "--verbose=2"];
/** A hung codesign must never stall an update check. */
export const CODESIGN_TIMEOUT_MS = 5_000;

let probed: Promise<MacSigning> | null = null;

/**
 * The running bundle's signature, probed at most once per process (the
 * bundle cannot change under a running app). Only a real packaged Electron
 * app on macOS is probed — tests, dev runs and plain Node resolve "unknown",
 * which keeps the Squirrel wiring in update.ts exactly as it was.
 */
export function runningMacSigning(): Promise<MacSigning> {
  if (!app?.isPackaged || process.platform !== "darwin") return Promise.resolve("unknown");
  probed ??= new Promise<MacSigning>((resolve) => {
    execFile(
      CODESIGN_BIN,
      [...CODESIGN_ARGS, bundlePathFromExec(process.execPath)],
      { timeout: CODESIGN_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout, stderr) => {
        // codesign -dv prints its report on stderr and exits 0; an unsigned
        // bundle exits 1 with "code object is not signed at all". A timeout
        // or a missing binary leaves no recognizable text → unknown.
        const text = `${stdout ?? ""}\n${stderr ?? ""}`;
        resolve(err && !/not signed at all/i.test(text) ? "unknown" : macSigningFromCodesign(text));
      },
    );
  });
  return probed;
}
