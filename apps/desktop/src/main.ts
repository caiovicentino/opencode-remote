import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_METRICS_PORT,
  getPairUrl,
  startDaemonSidecar,
  stopDaemonSidecar,
  waitForDaemonHealth,
} from "./daemon";

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
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: buf.toString("base64") };
    } catch (err) {
      console.error("[desktop] daemonBrowse failed:", err);
      return null;
    }
  });
  // Boot pairing URI captured from the daemon sidecar's stdout (null when the
  // daemon was reused or hasn't printed it yet) — lets the renderer auto-pair.
  ipcMain.handle("app:pairUrl", () => getPairUrl());
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
    void stopDaemonSidecar().then(() => {
      daemonStopped = true;
      app.quit();
    });
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
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
  tray.setToolTip("OpenCode Remote");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open OpenCode Remote", click: showMainWindow },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          tray = null;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", showMainWindow);
}
