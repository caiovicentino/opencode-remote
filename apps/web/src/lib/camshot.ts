/** P3-402: pure decision core of the camera-ask sheet ("Olho"), same
 * framework-free pattern as lib/qrfeed.ts — the unit battery holds the
 * contract without a renderer. */

export interface TorchConstraint {
  advanced: { torch: boolean }[];
}

/** A track supports the torch only when its advertised capabilities carry the
 * field at all — `torch: false` on a desktop webcam is not a flash, it is the
 * absence of one. Everything unusual (null capabilities, old browsers without
 * getCapabilities) fails closed to "not supported". Never throws. */
export function torchSupported(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  return "torch" in (capabilities as Record<string, unknown>);
}

/** P3-402: the MediaTrackConstraints shape for toggling the torch. Chromium
 * only accepts torch inside `advanced`, and the DOM lib does not type the
 * non-standard key — the cast lives here, at the single point of assembly. */
export function torchConstraint(on: boolean): TorchConstraint {
  return { advanced: [{ torch: on }] };
}
