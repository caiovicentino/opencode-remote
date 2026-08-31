import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ocrDesktop", {
  platform: process.platform,
  version: ipcRenderer.invoke("app:version"),
});
