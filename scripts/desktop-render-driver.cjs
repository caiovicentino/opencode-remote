/* eslint-disable @typescript-eslint/no-require-imports -- CJS driver: runs inside the Electron main process */
/**
 * Desktop render smoke driver (P0-002) — runs INSIDE Electron.
 *
 * Loads the built web UI (apps/web/dist/index.html) from file:// with the same
 * sandboxed webPreferences as the production shell, waits for did-finish-load,
 * captures renderer console errors and checks the UI actually mounted into
 * #root (a white window — e.g. an asset 404 on file:// — fails the gate).
 *
 * Configuration comes from the environment:
 *   OCR_SMOKE_HTML      absolute path to the index.html to load (required)
 *   OCR_SMOKE_PRELOAD   absolute path to dist-electron/preload.js (optional)
 *   OCR_SMOKE_SETTLE_MS ms to wait after did-finish-load before the DOM check
 *                       (default 1500 — lets async errors surface)
 *
 * Result is printed as a single stdout line:
 *   OCR_RENDER_SMOKE_RESULT {json}
 * and the process exits 0 (render OK) or 1 (render broken). The verdict also
 * requires a driver-injected capture canary, so an Electron API change can
 * never void console-error capture and pass vacuously.
 *
 * When required as a library (not run as main) it only exports the pure
 * helpers so scripts/unit.test.ts can cover them without booting Electron.
 */
"use strict";

/** Known-good console error injected by the driver to verify capture works. */
const CANARY = "ocr-render-smoke-canary";

const LEVEL_NAMES = ["verbose", "info", "warning", "error"];

function normalizeLevel(level) {
  // legacy listeners pass a numeric level (3 = error); the details object
  // carries a string ("error"). Normalize to the string scheme.
  if (typeof level === "number") return LEVEL_NAMES[level] ?? `level-${level}`;
  return String(level ?? "");
}

/**
 * Normalizes the console-message listener shapes Electron has shipped:
 *  - current (verified at runtime on 38.8.6): (details, ...deprecatedTail)
 *    where details is Event<WebContentsConsoleMessageEventParams> carrying
 *    { message, level: "error"…, lineNumber, sourceId } — the positional tail
 *    (level, message, line, sourceId) is deprecated and may be dropped.
 *  - legacy: (event, level, message, line, sourceId) with a numeric level.
 * Returns { level, message, sourceUrl, lineNumber } with level normalized to
 * the string scheme ("error" for errors) so callers compare against "error".
 */
function readConsoleMessage(first, second, third, fourth, fifth) {
  // Sniff on the payload, not on position: the first arg is an object in BOTH
  // shapes (plain Event in legacy, details-carrying Event in current), but
  // only the current shape owns .message.
  if (first && typeof first === "object" && typeof first.message === "string") {
    return {
      level: normalizeLevel(first.level),
      message: first.message,
      sourceUrl: first.sourceId,
      lineNumber: first.lineNumber,
    };
  }
  // legacy: (event, level, message, line, sourceId)
  return { level: normalizeLevel(second), message: third, sourceUrl: fifth, lineNumber: fourth };
}

function runDriver() {
  const { app, BrowserWindow } = require("electron");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");

  const html = process.env.OCR_SMOKE_HTML;
  const preload = process.env.OCR_SMOKE_PRELOAD || "";
  const settleMs = Number(process.env.OCR_SMOKE_SETTLE_MS || 1500);

  function finish(result) {
    // Verdict: page loaded, console capture verified by the canary, and
    // zero renderer console errors — any console error fails (P3-005).
    // (For early/timeout finishes loadOk/canarySeen stay false → not ok.)
    result.ok =
      result.loadOk === true &&
      result.canarySeen === true &&
      result.rootChildren > 0 &&
      result.bodyTextLength > 0 &&
      result.consoleErrors.length === 0;
    // Synchronous write: app.exit() would drop buffered pipe output.
    const { writeSync } = require("node:fs");
    writeSync(1, `OCR_RENDER_SMOKE_RESULT ${JSON.stringify(result)}\n`);
    app.exit(result.ok ? 0 : 1);
  }

  if (!html) {
    finish({ ok: false, loadOk: false, canarySeen: false, rootChildren: 0, bodyTextLength: 0, consoleErrors: ["OCR_SMOKE_HTML not set"] });
    return;
  }

  // Global safety net: never hang the gate.
  setTimeout(() => {
    finish({ ok: false, loadOk: false, canarySeen: false, rootChildren: 0, bodyTextLength: 0, consoleErrors: ["driver timeout"] });
  }, 60_000).unref();

  // Traceless run: throwaway userData dir so the smoke never reads nor writes
  // real pairing state, and no Dock icon flicker on macOS.
  app.setPath("userData", mkdtempSync(join(tmpdir(), "ocr-render-smoke-")));
  if (process.platform === "darwin" && app.dock) app.dock.hide();
  app.disableHardwareAcceleration();

  const consoleErrors = [];
  const result = { ok: false, loadOk: false, canarySeen: false, rootChildren: 0, bodyTextLength: 0, consoleErrors };

  app.whenReady().then(() => {
    // The production preload (apps/desktop/src/preload.ts) invokes these
    // handlers as soon as it loads; mirror the shell's IPC contract so the
    // bridge behaves exactly like the real app (pairUrl: null → manual
    // pairing UI, which is what a fresh install shows).
    if (preload) {
      const { ipcMain } = require("electron");
      ipcMain.handle("app:version", () => "0.0.0-smoke");
      ipcMain.handle("app:pairUrl", () => null);
    }
    const win = new BrowserWindow({
      width: 430,
      height: 900,
      show: false,
      webPreferences: {
        // Same sandbox shape as the production shell (apps/desktop/src/main.ts)
        preload: preload || undefined,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const wc = win.webContents;

    wc.on("console-message", (...args) => {
      const m = readConsoleMessage(...args);
      if (m.message && m.message.includes(CANARY)) {
        // Driver-injected canary (see did-finish-load): proof that console
        // capture works with this Electron's listener shape, not app noise.
        result.canarySeen = true;
        return;
      }
      if (m.level === "error") {
        consoleErrors.push(`${m.message} (${m.sourceUrl || "?"}:${m.lineNumber ?? "?"})`);
      }
    });
    wc.on("preload-error", (_e, path, err) => consoleErrors.push(`preload-error: ${path}: ${err}`));
    wc.on("render-process-gone", (_e, details) => consoleErrors.push(`render-process-gone: ${details?.reason}`));
    wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
      if (isMain) consoleErrors.push(`did-fail-load: ${code} ${desc} ${url}`);
    });
    wc.on("did-finish-load", () => {
      result.loadOk = true;
      // Capture canary: inject one known console error right after load. The
      // settle window below proves the console-message listener actually saw
      // it — without this, an Electron API change could void error capture
      // and the smoke would pass vacuously (no captured errors ≠ clean run).
      wc.executeJavaScript(`console.error('${CANARY}')`).catch((err) => {
        consoleErrors.push(`canary injection failed: ${err}`);
      });
      // Settle so async failures (SW registration, unhandled rejections,
      // late asset 404s) land in the console before we judge.
      setTimeout(
        () => {
          wc.executeJavaScript(
            `(() => { const r = document.getElementById("root") || document.body;
               return { children: r ? r.children.length : -1,
                        text: (document.body.innerText || "").trim().length }; })()`,
          )
            .then((res) => {
              result.rootChildren = res?.children ?? 0;
              result.bodyTextLength = res?.text ?? 0;
              finish(result);
            })
            .catch((err) => {
              consoleErrors.push(`executeJavaScript failed: ${err}`);
              finish(result);
            });
        },
        settleMs,
      ).unref();
    });

    win.loadFile(html).catch((err) => {
      consoleErrors.push(`loadFile failed: ${err}`);
      finish(result);
    });
  });
}

module.exports = { readConsoleMessage };

// Electron does not set require.main for the entry script — detect the
// Electron runtime instead (absent when required from node/tsx unit tests).
if (process.versions.electron) runDriver();
