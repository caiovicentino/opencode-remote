import { contextBridge, ipcRenderer } from "electron";

/** Result shape of the /api/browse proxy in apps/desktop/src/main.ts. */
export interface DaemonBrowseResponse {
  status: number;
  contentType: string;
  /** Base64 of the raw response body (JSON text or PNG bytes). */
  body: string;
}

/** P1-061: loopback WS credentials for the direct local transport. P1-070:
 * room + ecdhPub ride along so the renderer can derive the local pairing
 * (they come from the same 0600 state file — no new trust domain). */
export interface LocalLink {
  port: number;
  token: string;
  room?: string;
  ecdhPub?: string;
  /** P2-143: why this port was picked ("reused" | "preferred" | "fallback" |
   * "none"); absent before the one-shot port resolution ran. */
  portReason?: string;
}

/** P2-138: upstream (agent server / opencode) health detail from the daemon's
 * /api/health — the P2-135 classifier verdict, passed through verbatim.
 * reason/hint are static daemon strings and are rendered as text only. */
export interface DaemonUpstreamDetail {
  state: string;
  reason: string;
  hint: string;
  checkedAt: string | null;
}

/** First-run pairing state pushed/pulled from the main process (P2-007). */
export interface PairingState {
  /** P1-070: "local" (auto-connected to the daemon on this machine, uri/qr
   * always null), "remote" (explicit QR ceremony) or undefined (legacy). */
  mode?: "local" | "remote";
  uri: string | null;
  qrDataUrl: string | null;
  devices: number;
  phonePaired: boolean;
  /** P2-017: sidecar gave up respawning — surfaced so the UI can warn. */
  daemonDown?: boolean;
  /** P1-053: adopted daemon lost, shell still probing (yellow banner). */
  reconnecting?: boolean;
  /** P1-053: failed probes since the loss was detected (banner counter). */
  reconnectAttempts?: number;
  /** P3-054: shell + live daemon versions and the mismatch verdict. */
  appVersion?: string | null;
  daemonVersion?: string | null;
  versionMismatch?: boolean;
  /** P2-138: upstream opencode health detail — optional and additive so a
   * legacy daemon (no field) still renders every existing surface. */
  opencode?: DaemonUpstreamDetail;
  /** P2-140: why the local daemon sidecar died — P2-140 classifier verdict
   * (kind port-busy | entry-missing | runtime-error | killed | unknown plus
   * static reason/hint), set only on the daemon-down states. Optional and
   * additive: absent before the first unintentional exit. */
  sidecarExit?: { kind: string; reason: string; hint: string };
}

contextBridge.exposeInMainWorld("ocrDesktop", {
  platform: process.platform,
  version: ipcRenderer.invoke("app:version"),
  // Boot pairing URI captured from the daemon sidecar's stdout (P0-003);
  // null when unavailable — the renderer then falls back to manual pairing.
  getPairUrl: (): Promise<string | null> => ipcRenderer.invoke("app:pairUrl"),
  approveClient: (pub: string): Promise<boolean> => ipcRenderer.invoke("app:approveClient", pub),
  // P2-011: browser pane — proxy GET/POST to the daemon's /api/browse routes.
  daemonBrowse: (req: { path: string; method?: string; body?: unknown }): Promise<DaemonBrowseResponse | null> =>
    ipcRenderer.invoke("app:daemonBrowse", req),
  // P2-048: Mission Control — narrow /api/pilot-* bridge (forensic reads +
  // takeover), same response shape as daemonBrowse.
  daemonApi: (req: { path: string; method?: string; body?: unknown }): Promise<DaemonBrowseResponse | null> =>
    ipcRenderer.invoke("app:daemonApi", req),
  // P2-007: first-run QR overlay — current snapshot plus change pushes.
  getPairingState: (): Promise<PairingState | null> => ipcRenderer.invoke("app:pairingState"),
  // P1-070: explicit remote-pairing opt-in/out (Settings action + overlay
  // dismiss). Main re-publishes the pairing state right away.
  setRemotePairing: (on: boolean): Promise<boolean> => ipcRenderer.invoke("app:setRemotePairing", on),
  // P1-053: banner button — manual daemon restart (same path as the tray).
  reconnectDaemon: (): Promise<boolean> => ipcRenderer.invoke("app:reconnectDaemon"),
  // P3-053: dock unread badge — the web UI derives the count (lib/unread.ts)
  // and pushes it on every change; main maps it to app.setBadgeCount. The
  // getter exists so tests can verify the IPC round-trip via the harness.
  sendUnread: (n: number): void => ipcRenderer.send("ocr:unread", n),
  getUnreadBadge: (): Promise<number> => ipcRenderer.invoke("app:unreadBadge"),
  // P1-050: Settings "Copy diagnostic" — support bundle (versions, daemon
  // state, desktop.log tail, crash-file names). Text only, no secrets.
  getDiagnostics: (): Promise<string> => ipcRenderer.invoke("app:diagnostics"),
  // P1-061: fresh loopback WS credentials (port + token) for the local direct
  // transport; null when the state file has no token yet (first health poll).
  getLocalLink: (): Promise<LocalLink | null> => ipcRenderer.invoke("app:localLink"),
  onPairingState: (cb: (state: PairingState | null) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: PairingState | null): void => cb(state);
    ipcRenderer.on("ocr:pairing-state", listener);
    return () => ipcRenderer.removeListener("ocr:pairing-state", listener);
  },
  // P3-014: opencode-remote:// pair link (already validated in main) — late
  // pull plus live push, mirroring the pairing-state channel above.
  getDeepLink: (): Promise<string | null> => ipcRenderer.invoke("app:deepLink"),
  onDeepLink: (cb: (uri: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, uri: string): void => cb(uri);
    ipcRenderer.on("ocr:deep-link", listener);
    return () => ipcRenderer.removeListener("ocr:deep-link", listener);
  },
  // P1-046: Go-menu accelerators (Cmd+T / Cmd+K / Cmd+1..5) — the main menu
  // pushes the action id; the renderer routes it through the view reducer.
  onMenuAction: (cb: (id: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string): void => cb(id);
    ipcRenderer.on("ocr:menu-action", listener);
    return () => ipcRenderer.removeListener("ocr:menu-action", listener);
  },
});
