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
// inline). Since P3-407 the whole report passes through diagredact.ts
// (applied in main.ts's buildDiagnostics, the single exit point) before it
// reaches the clipboard or a file: the log tail — user-generated content the
// builder cannot fully control — is scrubbed of pairing URIs, Bearer
// credentials, long token-like runs, control characters and the home-folder
// prefix, so a support attachment never carries the account name either.

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
  /** P2-218: login-item verdict — the action and its short reason only,
   * NEVER the decision-file location (privacy contract in this header).
   * Optional/additive. */
  startup?: { state: string; reason: string } | null;
  /** P2-221: quit-confirmation verdict of the last explicit quit — the action
   * and its short reason only, NEVER the decision-file location (privacy
   * contract in this header). Optional/additive. */
  quitConfirm?: { state: string; reason: string } | null;
  /** P2-223: the last unresponsive-window episode — duration in ms and the
   * outcome only ("responsive" | "warn" | "dialog" | "budget-exhausted"),
   * one line, never any path or token. Optional/additive. */
  lastHang?: { durationMs: number; outcome: string } | null;
  /** P2-285/P2-289: the boot proxy verdict — mode, static reason and the
   * mode ORIGIN (owner choice | machine environment) only, NEVER the proxy
   * address, a credential or the raw environment (privacy contract in this
   * header). Optional/additive. */
  proxy?: { mode: string; reason: string; origin?: string } | null;
  /** P2-291: the update guard's last verdict ("seguir" | "recusar-oferta")
   * and its short reason only — never a path, an address or a secret
   * (privacy contract in this header). Optional/additive. */
  updateGuard?: { state: string; reason: string } | null;
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
    // P2-218: one additive line — action + short reason only, never the
    // decision-file location (header privacy contract).
    `login item: ${d.startup?.state ?? "unknown"}${d.startup?.reason ? ` (${d.startup.reason})` : ""}`,
    // P2-221: one additive line — action + short reason of the last explicit
    // quit, never the decision-file location (header privacy contract).
    `quit confirm: ${d.quitConfirm?.state ?? "unknown"}${d.quitConfirm?.reason ? ` (${d.quitConfirm.reason})` : ""}`,
    // P2-223: one additive line — the last frozen-window episode with its
    // duration and outcome, nothing else (header privacy contract).
    `last hang: ${d.lastHang ? `${d.lastHang.outcome} after ${Math.round(d.lastHang.durationMs / 1000)}s` : "none"}`,
    // P2-285/P2-289: one additive line — mode + origin + static reason only,
    // never the proxy address or the raw environment (header privacy
    // contract).
    `proxy: ${d.proxy?.mode ?? "unknown"}${d.proxy?.origin ? ` — origem ${d.proxy.origin}` : ""}${
      d.proxy?.reason ? ` (${d.proxy.reason})` : ""
    }`,
    // P2-291: one additive line — the guard's last verdict + short reason
    // only, never a path or an address (header privacy contract).
    `update guard: ${d.updateGuard?.state ?? "unknown"}${d.updateGuard?.reason ? ` (${d.updateGuard.reason})` : ""}`,
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
