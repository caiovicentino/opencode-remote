// Diagnostics bundle (P1-050): the "Copy diagnostic" button in Settings
// copies a single text block with everything support needs to triage a
// report — versions, daemon state, the last desktop.log lines, the last
// daemon-sidecar.log lines (P2-163) and the crash files on disk. Pure
// text-in/text-out: the electron-free builder lives here
// so scripts/client-ready.test.ts can assert on the exact shape, and main.ts
// only gathers the inputs.
//
// Privacy contract: the bundle carries file NAMES and statuses only — never
// the apiToken, allowlist contents or pairing URI (see the redaction notes
// inline). The log tail itself is user-generated content on the user's own
// clipboard, which is exactly where it already lives.

/** Last desktop.log lines embedded in the bundle. */
export const DIAG_LOG_TAIL = 40;

/** Last daemon-sidecar.log lines embedded in the bundle (P2-163). */
export const DIAG_SIDECAR_TAIL = 20;

export interface DiagnosticsInput {
  appVersion: string;
  electronVersion: string;
  platform: string;
  locale: string;
  packaged: boolean;
  /** Absolute userData path (identifies the logs folder; contains no secrets). */
  userData: string;
  /** Daemon sidecar state. */
  daemon: {
    healthy: boolean;
    down: boolean;
    reconnecting: boolean;
    attempts: number;
    /** P2-143: the resolved daemon API port + why it was chosen. */
    port: number;
    portReason: string | null;
  };
  /** Last lines of desktop.log (oldest first). The caller bounds it via
   * DIAG_LOG_TAIL and the builder re-bounds defensively. */
  logTail: string[];
  /** P2-163: last lines of daemon-sidecar.log (oldest first). Same contract
   * as logTail — caller bounds it via DIAG_SIDECAR_TAIL, the builder re-bounds
   * defensively; empty when the file is missing or unreadable. */
  sidecarLogTail: string[];
  /** Crash file NAMES in ~/.opencode-remote/pilot/client-logs (newest last). */
  crashFiles: string[];
  /** Last update-check decision, when one resolved. */
  updateStatus: string | null;
  /** P2-211: install-location verdict STATE only ("ok" | "dmg-volume" |
   * "translocated" | "downloads" | "unknown") — never the bundle path, per
   * the privacy contract in this header. Optional/additive. */
  installLocation?: string | null;
  /** P2-214: clock-skew verdict of the last guarded reach probe — the state
   * and the rounded signed offset in seconds only, NEVER the machine's time
   * (privacy contract in this header). Optional/additive. */
  clockSkew?: { state: string; skewSeconds: number | null } | null;
}

/** Lines of the diagnostic bundle, in display order. */
export function buildDiagnosticReport(d: DiagnosticsInput): string {
  const lines: string[] = [
    "OpenCode Remote — diagnostic report",
    `app: ${d.appVersion} (electron ${d.electronVersion})`,
    `platform: ${d.platform} / ${d.locale} / ${d.packaged ? "packaged" : "dev"}`,
    `userData: ${d.userData}`,
    `daemon: ${d.daemon.healthy ? "healthy" : d.daemon.down ? "down (sidecar gave up)" : d.daemon.reconnecting ? `reconnecting (attempt ${d.daemon.attempts})` : "unhealthy"} — porta ${d.daemon.port}${d.daemon.portReason ? ` (${d.daemon.portReason})` : ""}`,
    `last update check: ${d.updateStatus ?? "none"}`,
    // P2-211: one additive line, state only — the bundle path never enters
    // the bundle (header privacy contract).
    `install location: ${d.installLocation ?? "unknown"}`,
    // P2-214: one additive line — state + rounded signed offset in seconds,
    // never the machine's time (header privacy contract).
    `clock skew: ${d.clockSkew?.state ?? "unknown"}${
      d.clockSkew?.skewSeconds == null ? "" : ` (${d.clockSkew.skewSeconds > 0 ? "+" : ""}${d.clockSkew.skewSeconds}s)`
    }`,
    `crash files: ${d.crashFiles.length === 0 ? "none" : d.crashFiles.join(", ")}`,
    "--- desktop.log (last lines) ---",
    ...d.logTail.slice(-DIAG_LOG_TAIL),
    // P2-163: the sidecar log is the only daemon JSONL record in the packaged
    // app (P3-018) and is already redacted on disk (P2-160) — no pairing URI
    // or QR block can ride along here. A missing/unreadable file renders as a
    // placeholder line instead of an exception.
    "--- daemon-sidecar.log (last lines) ---",
    ...(d.sidecarLogTail.length > 0
      ? d.sidecarLogTail.slice(-DIAG_SIDECAR_TAIL)
      : ["(sem log do sidecar)"]),
  ];
  return lines.join("\n");
}
