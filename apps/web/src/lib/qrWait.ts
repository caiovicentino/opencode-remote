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
 * wait until the timeout elapses, then an error. P3-412: when the caller
 * already knows the local agent is not healthy (the same `kind`/`busy`
 * signal the step-2 connection card renders), the wait is pointless — the
 * QR is minted from the daemon's pairing credential, so a settled
 * non-healthy state fails fast to the error instead of holding the
 * skeleton for the full window. Unknown inputs (null/undefined QR,
 * negative elapsed, absent agentDown) fail toward the wait/error pair —
 * never toward a QR that does not exist. */
export function qrWaitVerdict(opts: { qrDataUrl: string | null | undefined; elapsedMs: number; agentDown?: boolean }): QrWaitVerdict {
  if (typeof opts.qrDataUrl === "string" && opts.qrDataUrl !== "") return "ready";
  if (opts.agentDown === true) return "error";
  return opts.elapsedMs >= QR_WAIT_TIMEOUT_MS ? "error" : "waiting";
}
