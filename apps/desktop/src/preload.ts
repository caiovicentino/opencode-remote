import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ocrDesktop", {
  platform: process.platform,
  version: ipcRenderer.invoke("app:version"),
  // Boot pairing URI captured from the daemon sidecar's stdout (P0-003);
  // null when unavailable — the renderer then falls back to manual pairing.
  getPairUrl: (): Promise<string | null> => ipcRenderer.invoke("app:pairUrl"),
  approveClient: (pub: string): Promise<boolean> => ipcRenderer.invoke("app:approveClient", pub),
});
