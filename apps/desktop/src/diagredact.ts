// P3-407: the diagnostics redactor — one pure pass over the whole support
// bundle before it leaves the main process by ANY path (clipboard copy from
// Settings, the Help-menu copy item, the boot-health dialog button or the
// new save-to-file action). Before this module the bundle carried the
// desktop.log tail verbatim, and that log can hold the daemon's boot banner
// pairing URI plus absolute paths that name the owner's account.
//
// Same module hygiene as sidecar-redact.ts / updatenotes.ts: NO electron,
// NO node:fs, NO node:path, no I/O of any kind — pure text in, pure text
// out, so scripts/diagredact.test.ts (plain Node) can exercise every rule.
//
// The pass is deterministic by contract: the same report and the same home
// folder always produce byte-identical output (the support thread must not
// change between two copies of the same bundle). Rules, applied in order:
//   1. Control characters (C0 minus \n and \t, plus DEL) are removed — log
//      tails are third-party bytes and must never smuggle escape sequences
//      into a terminal or the clipboard.
//   2. The pairing credential is swapped with the same marker the sidecar
//      log already uses (redactPairingUris from sidecar-redact.ts).
//   3. `Bearer …` credentials and long token-like runs (40+ chars of the
//      base64/hex alphabet) are masked.
//   4. The home-folder prefix — received as a parameter, never discovered —
//      becomes a neutral `~` marker, so the bundle stops carrying the
//      account name in userData and log paths.

/** Reuses the exact pairing-URI swap the sidecar log gets (P2-160). */
import { redactPairingUris } from "./sidecar-redact";

/** What the home-folder prefix becomes in the redacted report. */
export const DIAG_HOME_MARKER = "~";

/** What a masked Bearer credential or long token becomes. */
export const DIAG_REDACTED_TOKEN = "[redacted]";

// C0 control characters except \n (\u000A) and \t (\u0009), plus DEL.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// `Bearer <credential>` — the header case matches, the credential is
// anything up to the next whitespace.
const BEARER_RE = /Bearer\s+\S+/gi;

// A long token-like run: 40+ chars of the base64/hex alphabet with no
// separator, dot, colon or slash. Paths and URLs break on those separators,
// so legitimate text (file names, ports, timestamps) never reaches 40 chars
// inside one run — only secrets do.
const LONG_SECRET_RE = /[A-Za-z0-9+_=~-]{40,}/g;

/**
 * Redact one diagnostics report. `homeDir` is the machine's home folder
 * prefix to neutralize (pass it with or without a trailing separator; the
 * function normalizes). Pure and deterministic — same inputs, same output,
 * always.
 */
export function redactDiagnosticReport(report: string, homeDir: string): string {
  let out = report.replace(CONTROL_CHARS_RE, "");
  out = redactPairingUris(out);
  out = out.replace(BEARER_RE, `Bearer ${DIAG_REDACTED_TOKEN}`);
  out = out.replace(LONG_SECRET_RE, DIAG_REDACTED_TOKEN);
  const home = typeof homeDir === "string" ? homeDir.replace(/[\\/]+$/, "") : "";
  if (home) {
    // Both separator flavors: the shell prints `/` paths, a pasted Windows
    // log tail carries `\`. Replacing the bare prefix keeps the rest of the
    // path readable ("~/Library/…" instead of an opaque blob).
    out = out.split(home).join(DIAG_HOME_MARKER);
    out = out.split(home.replace(/\\/g, "/")).join(DIAG_HOME_MARKER);
  }
  return out;
}
