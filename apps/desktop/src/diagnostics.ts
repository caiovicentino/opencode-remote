// Diagnostics bundle (P1-050): the "Copy diagnostic" button in Settings
// copies a single text block with everything support needs to triage a
// report — versions, daemon state, the last desktop.log lines and the crash
// files on disk. Pure text-in/text-out: the electron-free builder lives here
// so scripts/client-ready.test.ts can assert on the exact shape, and main.ts
// only gathers the inputs.
//
// Privacy contract: the bundle carries file NAMES and statuses only — never
// the apiToken, allowlist contents or pairing URI (see the redaction notes
// inline). The log tail itself is user-generated content on the user's own
// clipboard, which is exactly where it already lives.

/** Last desktop.log lines embedded in the bundle. */
export const DIAG_LOG_TAIL = 40;

export interface DiagnosticsInput {
  appVersion: string;
  electronVersion: string;
  platform: string;
  locale: string;
  packaged: boolean;
  /** Absolute userData path (identifies the logs folder; contains no secrets). */
  userData: string;
  /** Daemon sidecar state. */
  daemon: { healthy: boolean; down: boolean; reconnecting: boolean; attempts: number };
  /** Last lines of desktop.log (oldest first), already bounded by the caller. */
  logTail: string[];
  /** Crash file NAMES in ~/.opencode-remote/pilot/client-logs (newest last). */
  crashFiles: string[];
  /** Last update-check decision, when one resolved. */
  updateStatus: string | null;
}

/** Lines of the diagnostic bundle, in display order. */
export function buildDiagnosticReport(d: DiagnosticsInput): string {
  const lines: string[] = [
    "OpenCode Remote — diagnostic report",
    `app: ${d.appVersion} (electron ${d.electronVersion})`,
    `platform: ${d.platform} / ${d.locale} / ${d.packaged ? "packaged" : "dev"}`,
    `userData: ${d.userData}`,
    `daemon: ${d.daemon.healthy ? "healthy" : d.daemon.down ? "down (sidecar gave up)" : d.daemon.reconnecting ? `reconnecting (attempt ${d.daemon.attempts})` : "unhealthy"}`,
    `last update check: ${d.updateStatus ?? "none"}`,
    `crash files: ${d.crashFiles.length === 0 ? "none" : d.crashFiles.join(", ")}`,
    "--- desktop.log (last lines) ---",
    ...d.logTail,
  ];
  return lines.join("\n");
}
