// Pure decision logic for the desktop tray (P3-007). Kept free of electron
// imports so scripts/unit.test.ts can exercise it (same pattern as pairing.ts).

/** Tooltip shown by the tray: doubles as the sidecar health indicator, kept in
 * sync by the 3s pairing-watcher poll in main.ts. */
export function daemonTooltip(healthy: boolean): string {
  return healthy ? "OpenCode Remote — daemon ok" : "OpenCode Remote — daemon down";
}

/** app.setLoginItemSettings/getLoginItemSettings are no-ops outside macOS and
 * Windows (Electron docs), so the "Start at login" item is shown only there. */
export function loginItemSupported(platform: string): boolean {
  return platform === "darwin" || platform === "win32";
}
