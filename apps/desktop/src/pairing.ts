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
  /** P1-070: which pairing surface the shell is serving — "local" (the daemon
   * on this machine is auto-connected; uri/qrDataUrl are always null),
   * "remote" (the user explicitly asked for the QR ceremony) or undefined
   * (legacy: no local daemon was reachable at boot). */
  mode?: "local" | "remote";
  /** PNG data-URL rendering of `uri`, null when not generated yet. */
  qrDataUrl: string | null;
  /** Total allowlist size (fresh read from the daemon). */
  devices: number;
  /** P1-056: labels of the paired clients — the "Celular" pane lists them. */
  deviceList?: { label: string; addedAt?: string }[];
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
  /** P2-138: upstream (agent server / opencode) health detail from the
   * daemon's /api/health — additive; absent on legacy daemons. reason/hint
   * are static daemon strings the renderer only ever shows as text. */
  opencode?: { state: string; reason: string; hint: string; checkedAt: string | null };
  /** P2-140: why the local daemon sidecar died (P2-140 classifier verdict),
   * set only on the daemon-down states. Additive; reason/hint are static
   * shell strings the renderer only ever shows as text. */
  sidecarExit?: { kind: string; reason: string; hint: string };
  /**
   * P2-189: step one of the pairing journey — the address the phone opens to
   * reach the app, derived from the relay address (wss→https, ws→http) unless
   * the operator stored one. Additive; absent on the daemon-down states.
   * reason is the first problem ("" when the address is fine) and qrDataUrl
   * is only ever generated when reason is empty — a QR is NEVER minted for a
   * problem-bearing address.
   */
  webApp?: { url: string; origin: "stored" | "derived" | "unavailable"; reason: string; qrDataUrl: string | null };
  /**
   * P2-193: the combined pair link — the app address with the pairing
   * credential moved into the URL fragment (never sent to any server).
   * Additive; qrDataUrl is only ever generated when problems is empty — a QR
   * is NEVER minted for a problem-bearing link (the two labeled QRs stay).
   */
  pairLink?: { url: string; qrDataUrl: string | null; problems: string[] };
  /**
   * P2-197: reach verdict of the app address (webreach.ts classifier),
   * probed once per pairing tick from the machine hosting the daemon.
   * Additive; absent = the probe has not run (unknown — renders nothing).
   * A failed probe never blocks pairing and never hides the QR.
   */
  reach?: { state: string; message: string };
  /**
   * P2-199: verdict of the daemon↔relay link (relaylink.ts classifier),
   * computed from the same /api/health answer the tick already fetches and
   * only while the overlay may still be needed. Additive; absent only when
   * the health call itself failed or the overlay cannot be needed — a 200
   * answer without relay fields (legacy daemon) travels as the discreet
   * unknown state instead. A down link never blocks pairing and never hides
   * the QR.
   */
  relayLink?: { state: string; message: string };
  /**
   * P2-211: verdict of the app's install location (installloc.ts classifier),
   * computed ONCE at boot in the main process. Additive; absent = unknown to
   * the renderer (ok/unknown render nothing). A wrong location (DMG volume,
   * translocated copy, downloads folder) explains the drag-to-Applications
   * action but NEVER blocks pairing and NEVER hides the QR.
   */
  installLocation?: { state: string; message: string };
  /**
   * P2-214: verdict of the machine's clock compared against the Date response
   * header of the SAME answer the reach probe already obtained (clockskew.ts
   * classifier), under the same overlay guard. Additive; absent = unknown to
   * the renderer (ok/unknown render nothing). A wrong clock explains the
   * automatic date/time action but NEVER blocks pairing and NEVER hides the
   * QR — pairing itself still works right now.
   */
  clock?: { state: string; message: string };
  /**
   * P2-218: verdict of the login-item boot decision (loginitem.ts planner),
   * computed ONCE at boot in the main process. Additive; absent = unknown to
   * the renderer (any state but "enable" renders nothing — and even "enable"
   * is a one-boot announce). The announce NEVER hides the QR and NEVER blocks
   * pairing — it is information, not an error.
   */
  startup?: { state: string; message: string };
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

/** Loopback credentials the shell's app:localLink IPC hands to the renderer
 * (read from the 0600 daemon.json — same trust domain, docs/security.md 9).
 * Every field is optional at the boundary: the helper rejects partial links. */
export interface LocalPairingLink {
  port?: number;
  token?: string;
  room?: string;
  ecdhPub?: string;
  /** P2-143: why the daemon port was picked (diagnostic-only; optional). */
  portReason?: string;
}

/** The Pairing shape the renderer's OcrClient.connect expects. Kept structural
 * here so apps/desktop stays decoupled from apps/web sources. */
export interface LocalPairing {
  v: 2;
  relay: string;
  room: string;
  k: string;
  name: string;
}

/**
 * P1-070: derive a Pairing that connects the desktop UI straight to the daemon
 * on this same machine — the exact recipe scripts/localws.test.ts proves:
 * room + k come from the 0600 state file (k is the daemon's ECDH public key)
 * and "relay" is the daemon's own loopback WS. The E2E handshake is identical
 * to a relay pairing; only the transport differs. Returns null when any field
 * is missing (malformed/partial state file) so the caller falls back to the
 * legacy pairing flow instead of dialing a broken object.
 */
export function localPairing(link: LocalPairingLink | null | undefined): LocalPairing | null {
  if (!link) return null;
  const { port, token, room, ecdhPub } = link;
  if (
    typeof port !== "number" ||
    !Number.isFinite(port) ||
    port <= 0 ||
    typeof token !== "string" ||
    !token ||
    typeof room !== "string" ||
    !room ||
    typeof ecdhPub !== "string" ||
    !ecdhPub
  ) {
    return null;
  }
  return {
    v: 2,
    relay: `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    room,
    k: ecdhPub,
    name: "local",
  };
}
