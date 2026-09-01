import { contextBridge, ipcRenderer } from "electron";

/** Result shape of the /api/browse proxy in apps/desktop/src/main.ts. */
export interface DaemonBrowseResponse {
  status: number;
  contentType: string;
  /** Base64 of the raw response body (JSON text or PNG bytes). */
  body: string;
}

/** P1-061: loopback WS credentials for the direct local transport. */
export interface LocalLink {
  port: number;
  token: string;
}

/** First-run pairing state pushed/pulled from the main process (P2-007). */
export interface PairingState {
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
  // P2-007: first-run QR overlay — current snapshot plus change pushes.
  getPairingState: (): Promise<PairingState | null> => ipcRenderer.invoke("app:pairingState"),
  // P1-053: banner button — manual daemon restart (same path as the tray).
  reconnectDaemon: (): Promise<boolean> => ipcRenderer.invoke("app:reconnectDaemon"),
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
});
