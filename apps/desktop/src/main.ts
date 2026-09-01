import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import {
  DAEMON_METRICS_PORT,
  getPairUrl,
  isDaemonDown,
  readApiToken,
  startDaemonSidecar,
  stopDaemonSidecar,
  waitForDaemonHealth,
} from "./daemon";
import { phonePaired, type PairingState } from "./pairing";
import { daemonTooltip, loginItemSupported } from "./tray";
import { checkForUpdatesOnBoot } from "./update";
import { loadWindowBounds, saveWindowBounds, WINDOW_MIN, windowStateFile } from "./window-state";

// Data-URL PNG keeps the repo free of binary assets; replace with a proper
// .png/.icns asset when the distribution stage lands (docs/VISION.md stage 5).
const TRAY_ICON_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPUlEQVR4nGNgoAWQkJD+jw2TrZEog5AVKB2Nw4rxGkJIM7ohZGnGacioAVQwgOJopEpCojgpE2MQQY3kAABalSlohfDTkQAAAABJRU5ErkJggg==";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let daemonStopped = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app
    .whenReady()
    .then(() => onReady())
    .catch((err) => {
      console.error("[desktop] startup failed:", err);
      app.quit();
    });
}

async function onReady(): Promise<void> {
  buildMenu();
  buildTray();

  // P2-012: staged update feed spike. Runs once at boot, fire-and-forget (a
  // slow or dead feed must never delay window creation) and only acts when
  // OCR_UPDATE_FEED is set — otherwise it is a silent no-op. All failures are
  // log-only (see src/update.ts).
  void checkForUpdatesOnBoot();

  ipcMain.handle("app:version", () => app.getVersion());
  // P2-011: narrow HTTP bridge to the local daemon's /api/browse surface so
  // the renderer can drive the host browser without ever seeing the api token
  // (the 0600 state file stays in this main process). Loopback only, browse
  // routes only — the token never leaves this process.
  ipcMain.handle("app:daemonBrowse", async (_e, req: { path?: string; method?: string; body?: unknown }) => {
    if (!req || typeof req.path !== "string") return null;
    const method = req.method === "POST" ? "POST" : "GET";
    // Anchored, URL-parsed allowlist: `new URL` normalizes ../ traversal into
    // the pathname, so only genuine /api/browse[/action] paths can pass. The
    // outbound URL is rebuilt from the parsed components — the raw renderer
    // string is never forwarded.
    const u = new URL(req.path, "http://127.0.0.1");
    if (!/^\/api\/browse(\/[a-z]+)?$/.test(u.pathname)) return null;
    try {
      const stateFile = join(homedir(), ".opencode-remote", "daemon.json");
      const token = (JSON.parse(readFileSync(stateFile, "utf8")) as { apiToken?: string }).apiToken;
      if (!token) return null;
      const res = await fetch(`http://127.0.0.1:${DAEMON_METRICS_PORT}${u.pathname}${u.search}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        body: method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(45_000),
      });
      // defense in depth: the daemon bounds its payloads, but never trust that
      // blindly — a screenshot is a few MB, so 32 MB is a generous ceiling
      const raw = await res.arrayBuffer();
      if (raw.byteLength > 32 * 1024 * 1024) return null;
      return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: Buffer.from(raw).toString("base64") };
    } catch (err) {
      console.error("[desktop] daemonBrowse failed:", err);
      return null;
    }
  });
  // Boot pairing URI captured from the daemon sidecar's stdout (null when the
  // daemon was reused or hasn't printed it yet) — lets the renderer auto-pair.
  ipcMain.handle("app:pairUrl", () => getPairUrl());
  // P2-007: first-run pairing state for the renderer's QR overlay. The main
  // process polls the daemon (see startPairingWatcher) and caches the result;
  // the sandboxed renderer only ever sees this derived state — never the
  // apiToken, allowlist file or raw HTTP responses.
  ipcMain.handle("app:pairingState", () => pairingState);
  // Host self-approval: the desktop shell runs on the same machine that owns
  // daemon.json, so it may add its own client identity to the allowlist. The
  // daemon re-reads the allowlist file on every handshake (fresh read), so
  // this takes effect on the next connect without a daemon restart.
  ipcMain.handle("app:approveClient", (_e, pub: string) => {
    if (typeof pub !== "string" || pub.length < 40 || !/^[A-Za-z0-9+/=]+$/.test(pub)) {
      return false;
    }
    try {
      const file = join(homedir(), ".opencode-remote", "daemon.json");
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        clients?: { pub: string; label?: string; addedAt: string }[];
      };
      raw.clients ??= [];
      if (raw.clients.some((c) => c.pub === pub)) return true;
      raw.clients.push({ pub, label: "desktop-host", addedAt: new Date().toISOString() });
      writeFileSync(file, JSON.stringify(raw, null, 2), { mode: 0o600 });
      return true;
    } catch (err) {
      console.error("[desktop] approveClient failed:", err);
      return false;
    }
  });

  // Sidecar: boot a local daemon (unless one is already healthy), wait for
  // /api/health before showing the UI. On timeout we still show the UI —
  // it renders its own disconnected state. waitForDaemonHealth reuses the
  // token captured by startDaemonSidecar and aborts early if the child died.
  const daemonReady = await startDaemonSidecar(
    app.getAppPath(),
    app.isPackaged ? process.resourcesPath : undefined,
  );
  if (!daemonReady || !(await waitForDaemonHealth())) {
    console.error(`[desktop] daemon health not confirmed on :${DAEMON_METRICS_PORT} — continuing`);
  }

  createWindow();
  startPairingWatcher();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
  app.on("window-all-closed", () => {
    // Keep the tray alive on macOS (convention); quit elsewhere.
    if (process.platform !== "darwin") app.quit();
  });
  app.on("will-quit", (event) => {
    // Encerra o daemon que subimos antes de sair (idempotente).
    if (daemonStopped) return;
    event.preventDefault();
    if (pairingTimer) clearInterval(pairingTimer);
    void stopDaemonSidecar().then(() => {
      daemonStopped = true;
      app.quit();
    });
  });
}

// --- first-run pairing watcher (P2-007) --------------------------------------
// After daemon health OK, poll the loopback API every 3s: while no phone is
// paired, fetch the boot pairing URI, render it as a PNG data-URL and hand the
// whole state to the renderer, which draws the QR overlay. As soon as the
// allowlist holds a non-host device (the phone scanned the QR), the overlay
// leaves and the chat shows. Read-only end to end: the allowlist itself is
// only ever read, never written here.

const PAIRING_POLL_MS = 3_000;
const PROBE_TIMEOUT_MS = 2_000;

let pairingState: PairingState | null = null;
let pairingTimer: NodeJS.Timeout | null = null;

/** Placeholder state while the sidecar is down for good (P2-017): no QR (the
 * old room/keys are dead with the daemon), just the "daemon down" flag. */
function daemonDownState(): PairingState {
  return { uri: null, qrDataUrl: null, devices: 0, phonePaired: false, daemonDown: true };
}

function setPairingState(next: PairingState | null): void {
  const changed = JSON.stringify(next) !== JSON.stringify(pairingState);
  pairingState = next;
  // Push so the overlay reacts within one poll; the renderer also pulls
  // (invoke) on mount — a fresh window never waits for a change. Broadcast to
  // every window: createWindow() doesn't track a single mainWindow handle.
  if (changed) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("ocr:pairing-state", pairingState);
    }
  }
}

// --- tray tooltip as sidecar health indicator (P3-007) -----------------------
// Fed by the pairing watcher's 3s poll below: the last authenticated request
// against the daemon decides ok/down. Deduplicated so the tooltip is only
// rewritten on actual transitions.

let trayHealthy: boolean | null = null;

function setTrayHealthy(healthy: boolean): void {
  if (trayHealthy === healthy) return;
  trayHealthy = healthy;
  tray?.setToolTip(daemonTooltip(healthy));
  console.log(`[desktop] tray tooltip: ${daemonTooltip(healthy)}`);
}

async function refreshPairingState(): Promise<void> {
  const token = readApiToken();
  if (!token) {
    // Cannot prove health without the token — report down until proven ok.
    setTrayHealthy(false);
    setPairingState(isDaemonDown() ? daemonDownState() : null);
    return;
  }
  const base = `http://127.0.0.1:${DAEMON_METRICS_PORT}`;
  const headers = { authorization: `Bearer ${token}` };
  try {
    const devRes = await fetch(`${base}/__ocr/devices`, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!devRes.ok) throw new Error(`devices ${devRes.status}`);
    const { devices } = (await devRes.json()) as { devices?: { pub: string; label?: string }[] };
    if (!Array.isArray(devices)) throw new Error("malformed devices payload");
    setTrayHealthy(true);

    const paired = phonePaired(devices);
    let uri = pairingState?.uri ?? null;
    let qrDataUrl = pairingState?.qrDataUrl ?? null;
    if (!paired && !uri) {
      // Only fetch/refresh while the overlay may still be needed; once a phone
      // is paired the QR is dead weight.
      const uriRes = await fetch(`${base}/__ocr/pairing-uri`, {
        headers,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!uriRes.ok) throw new Error(`pairing-uri ${uriRes.status}`);
      uri = ((await uriRes.json()) as { uri?: string }).uri ?? null;
      if (uri) qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 480 });
    }
    setPairingState({ uri, qrDataUrl, devices: devices.length, phonePaired: paired });
  } catch (err) {
    // Daemon down, token rotated or state file wiped: drop the cached state so
    // a stale QR (old room/keys) is never shown. The next healthy tick
    // rebuilds everything from scratch. When the sidecar exhausted its
    // respawn budget (P2-017), tell the renderer instead of staying silent.
    console.error(`[desktop] pairing poll failed: ${err instanceof Error ? err.message : err}`);
    setTrayHealthy(false);
    if (isDaemonDown()) {
      setPairingState(daemonDownState());
    } else {
      setPairingState(null);
    }
  }
}

function startPairingWatcher(): void {
  if (pairingTimer) return;
  void refreshPairingState();
  pairingTimer = setInterval(() => void refreshPairingState(), PAIRING_POLL_MS);
}

function createWindow(): BrowserWindow {
  // P3-008: restore the last window bounds. loadWindowBounds degrades to the
  // 1280x820 default on a missing/corrupted file, and sanitizeWindowBounds
  // drops bounds that don't intersect any currently attached display (window
  // parked on a since-disconnected screen). screen.* is safe here: this only
  // runs after app.whenReady().
  const stateFile = windowStateFile(app.getPath("userData"));
  const bounds = loadWindowBounds(stateFile, screen.getAllDisplays());
  const win = new BrowserWindow({
    ...bounds,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    title: "OpenCode Remote",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // P3-008: persist bounds on "close" — it fires both on quit (app.quit()
  // closes every window) and on a macOS red-button close (window-all-closed
  // doesn't quit there). Failures are log-only and must never block quitting.
  win.on("close", () => {
    saveWindowBounds(stateFile, win.getBounds());
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  // Open external links (docs, GitHub) in the browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  loadUi(win);
  return win;
}

function loadUi(win: BrowserWindow): void {
  // Dev override: OCR_WEB_URL=http://localhost:5173 npm start
  const devUrl = process.env.OCR_WEB_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    return;
  }
  const html = webDistIndex();
  if (html) {
    void win.loadFile(html);
  } else {
    void win.loadURL(
      "data:text/html," +
        encodeURIComponent(
          `<body style="font-family:-apple-system,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100dvh;margin:0"><div style="text-align:center"><p style="font-size:15px">OpenCode Remote — web UI not found.</p><p style="opacity:.7;font-size:13px">Run <code style="background:#333;padding:2px 6px;border-radius:4px">npm run build --workspace @ocr/web</code> first.</p></div></body>`,
        ),
    );
  }
}

function webDistIndex(): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath ?? "", "web-dist", "index.html");
    return existsSync(packaged) ? packaged : null;
  }
  // Unpackaged dev run: repo layout apps/desktop → apps/web/dist
  const candidate = join(app.getAppPath(), "..", "web", "dist", "index.html");
  return existsSync(candidate) ? candidate : null;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "quit" as const, label: "Quit OpenCode Remote" },
            ],
          },
        ]
      : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_PNG);
  tray = new Tray(icon);
  // P3-007: tooltip doubles as the sidecar health indicator; starts pessimistic
  // and is corrected by the first pairing-watcher poll (see setTrayHealthy).
  trayHealthy = false;
  tray.setToolTip(daemonTooltip(false));
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "Open OpenCode Remote", click: showMainWindow },
  ];
  // Login autostart is a no-op outside macOS/Windows — hide it elsewhere.
  if (loginItemSupported(process.platform)) {
    items.push({
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      // For checkbox items `item.checked` is the state after the user toggled,
      // which is exactly what setLoginItemSettings must persist (macOS launch
      // services / Windows registry) — so the choice survives app restarts.
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    });
  }
  items.push(
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        tray = null;
        app.quit();
      },
    },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.on("click", showMainWindow);
}
