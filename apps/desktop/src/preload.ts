import { contextBridge, ipcRenderer } from "electron";

/** Result shape of the /api/browse proxy in apps/desktop/src/main.ts. */
export interface DaemonBrowseResponse {
  status: number;
  contentType: string;
  /** Base64 of the raw response body (JSON text or PNG bytes). */
  body: string;
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
});
