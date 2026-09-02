// Pure decision logic for the desktop first-run pairing overlay (P2-007).
// Kept free of electron imports so scripts/unit.test.ts can exercise it.

/** Label the shell writes for its own self-approved identity (main.ts). */
export const HOST_LABEL = "desktop-host";

export interface AllowlistEntry {
  pub: string;
  label?: string;
  addedAt?: string;
}

/** Cached by the main-process watcher and handed to the renderer via IPC. */
export interface PairingState {
  /** Boot pairing URI (`opencode-remote://pair?v=2&…`), null when unknown. */
  uri: string | null;
  /** PNG data-URL rendering of `uri`, null when not generated yet. */
  qrDataUrl: string | null;
  /** Total allowlist size (fresh read from the daemon). */
  devices: number;
  /** True when at least one non-host device is paired (typically the phone). */
  phonePaired: boolean;
  /** P2-017: sidecar respawn budget exhausted — the daemon is not coming
   * back until the app restarts (set only while no healthy daemon answers). */
  daemonDown?: boolean;
  /** P1-053: adopted daemon lost, shell probing forever (yellow banner).
   * Mutually exclusive with daemonDown by construction. */
  reconnecting?: boolean;
  /** P1-053: failed reconnect probes since the loss was detected. */
  reconnectAttempts?: number;
  /** P3-054: shell version, echoed back so the banner can name both sides. */
  appVersion?: string | null;
  /** P3-054: version reported by the live daemon's /api/health (null unknown). */
  daemonVersion?: string | null;
  /** P3-054: versionMismatch(appVersion, daemonVersion) — computed in the
   * main process (pure comparator in versions.ts); the renderer only renders. */
  versionMismatch?: boolean;
}

/**
 * The desktop shell self-approves its own identity (P0-003), so a virgin
 * daemon briefly reports 1 device (the host) even before any phone paired.
 * Counting the host would blink the first-run QR away seconds after boot —
 * so only non-host entries (i.e. phones) close the overlay.
 */
export function phonePaired(devices: AllowlistEntry[]): boolean {
  return devices.some((d) => d.label !== HOST_LABEL);
}

/** Overlay is shown only when there is something to scan and no phone yet. */
export function overlayVisible(state: PairingState | null): boolean {
  return !!state && !state.phonePaired && !!state.uri && !!state.qrDataUrl;
}
