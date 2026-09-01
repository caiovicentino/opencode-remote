/* eslint-disable @typescript-eslint/no-require-imports -- CJS driver: runs inside the Electron main process */
const { app } = require("electron");

// P2-012 driver: runs inside the real Electron main process and exercises the
// compiled apps/desktop/dist-electron/update.js exactly as the packaged shell
// would (same import path, same built-in autoUpdater). The test spawns it once
// per scenario with OCR_UPDATE_FEED pointing at the staged loopback feed
// (or unset) and asserts on stdout + the emitted status.
const appPath = process.env.OCR_UPDATE_MODULE;
if (!appPath) {
  console.error("OCR_UPDATE_MODULE not set");
  process.exit(2);
}

app.whenReady().then(() => {
  const update = require(appPath);
  update
    .checkForUpdatesOnBoot({
      currentVersion: "0.2.0", // packaged app version; dev Electron reports 44.x
      log: (line) => console.log("LOG " + line),
    })
    .then((status) => {
      // Settle long enough for Squirrel's background download attempt to fire
      // its events (update-available / error) before we exit cleanly.
      setTimeout(() => {
        console.log("OCR_UPDATE_SMOKE_RESULT " + JSON.stringify({ status }));
        app.exit(0);
      }, 2500);
    })
    .catch((err) => {
      console.error("driver failed:", err);
      app.exit(2);
    });
});
