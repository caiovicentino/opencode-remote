/**
 * P3-333: the step-3 pairing ceremony waits on the shell to mint the QR
 * (daemon fetch + QRCode render, normally well under a second). A slow or
 * broken shell tick must not leave the user on a bare "Generating QR…" line
 * forever: past the timeout the wait resolves to an error the user can retry
 * (the retry re-fires the shell's remote-pairing request, which re-runs the
 * poll) or exit calmly via "do this later".
 */

/** How long the skeleton may hold the step before offering retry. Generous
 * because the wait includes the shell's poll cadence plus a cold daemon. */
export const QR_WAIT_TIMEOUT_MS = 20_000;

export type QrWaitVerdict = "waiting" | "ready" | "error";

/** Pure decision core: a truthy data URL is always ready; a falsy one is a
 * wait until the timeout elapses, then an error. Unknown inputs (null/
 * undefined QR, negative elapsed) fail toward the wait/error pair — never
 * toward a QR that does not exist. */
export function qrWaitVerdict(opts: { qrDataUrl: string | null | undefined; elapsedMs: number }): QrWaitVerdict {
  if (typeof opts.qrDataUrl === "string" && opts.qrDataUrl !== "") return "ready";
  return opts.elapsedMs >= QR_WAIT_TIMEOUT_MS ? "error" : "waiting";
}
