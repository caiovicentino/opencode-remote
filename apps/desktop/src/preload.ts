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
  /** P2-189: step one of the pairing journey — the address the phone opens,
   * derived from the relay address unless stored. Optional and additive so a
   * legacy shell payload still renders every existing surface. qrDataUrl is
   * null whenever reason is non-empty (no QR for a problem-bearing address). */
  webApp?: { url: string; origin: "stored" | "derived" | "unavailable"; reason: string; qrDataUrl: string | null };
  /** P2-193: the combined pair link — the app address with the pairing
   * credential moved into the URL fragment (never sent to any server).
   * Optional and additive; qrDataUrl is null whenever problems is non-empty
   * (no QR for a problem-bearing link — the two-QR fallback stays). */
  pairLink?: { url: string; qrDataUrl: string | null; problems: string[] };
  /** P2-197: how the last reach probe of the app address went (state ok |
   * unreachable | timeout | tls-error | dns-error | http-error | not-our-app
   * plus a static pt-BR message). Optional and additive: absent means the
   * probe has not run (or the shell is legacy) — an unknown state renders
   * nothing and never blocks pairing. */
  reach?: { state: string; message: string };
  /** P2-199: how the daemon↔relay link is doing (state connected | local |
   * dialing | refused | misconfigured | unknown plus a static pt-BR message).
   * Optional and additive: absent means the health answer carried no relay
   * facts — an unknown state renders nothing and never blocks pairing. */
  relayLink?: { state: string; message: string };
}

/** P2-187: the phone relay address resolution (Settings → "Relay do celular").
 * origin says where the effective address comes from; problems is empty for a
 * valid address and non-empty when the UI must show the error instead of a
 * pairing QR. Mirrors apps/desktop/src/relaysetting.ts. */
export interface RelaySetting {
  url: string;
  origin: "env" | "stored" | "default" | "stored-invalid";
  problems: string[];
}

/** Result of a write: ok=false carries the validation problems and nothing
 * was persisted; ok=true carries the new resolution (env still wins over a
 * saved value). */
export interface RelaySettingWriteResult extends RelaySetting {
  ok: boolean;
}

/** P2-189: the app address the phone opens (Settings → "Endereço do app").
 * origin says how the address was reached — "stored" (operator saved it),
 * "derived" (mapped from the relay address) or "unavailable" (no usable
 * address: show the reason, never a QR). Mirrors
 * apps/desktop/src/webappurl.ts. */
export interface WebAppSetting {
  url: string;
  origin: "stored" | "derived" | "unavailable";
  problems: string[];
}

/** Result of a write: ok=false carries the validation problems and nothing
 * was persisted; ok=true carries the new resolution. */
export interface WebAppSettingWriteResult extends WebAppSetting {
  ok: boolean;
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
  // P2-197: pairing overlay "test again" — re-runs the pairing tick, which
  // re-probes the app address; the next ocr:pairing-state push carries it.
  recheckWebApp: (): Promise<void> => ipcRenderer.invoke("app:recheckWebApp"),
  // P2-187: phone relay address — current resolution and the validated write
  // (null clears the stored setting; validation happens in the main process).
  getRelaySetting: (): Promise<RelaySetting> => ipcRenderer.invoke("app:relaySetting"),
  setRelayUrl: (url: string | null): Promise<RelaySettingWriteResult> =>
    ipcRenderer.invoke("app:setRelayUrl", url),
  // P2-189: the app address the phone opens — same read + validated write
  // shape as the relay setting (null clears the stored override; validation
  // happens in the main process).
  getWebAppUrl: (): Promise<WebAppSetting> => ipcRenderer.invoke("app:webAppUrl"),
  setWebAppUrl: (url: string | null): Promise<WebAppSettingWriteResult> =>
    ipcRenderer.invoke("app:setWebAppUrl", url),
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
