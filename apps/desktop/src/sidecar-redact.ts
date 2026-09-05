// P2-160: pure line redactor for the desktop sidecar's stdout/stderr tee —
// the daemon's boot banner prints the full pairing credential (ASCII QR plus
// the `or paste: opencode-remote://pair?…` URI), and that credential is enough
// to pair a virgin daemon (empty allowlist → first client is persisted), so it
// must never reach userData/logs/daemon-sidecar.log in clear text: the log is
// exactly the file a support request attaches. Same spirit as sidecarexit.ts /
// closehint.ts: no `electron`, no `node:fs` imports on purpose — the tee feeds
// chunk strings in and gets redacted chunk strings out, and
// scripts/unit.test.ts evaluates this module in plain Node.

/** URI scheme of the pairing credential the daemon prints at boot. */
export const PAIRING_SCHEME = "opencode-remote://";

/** What a redacted pairing URI becomes in the sidecar log. */
export const REDACTED_MARKER = "[pairing-uri redacted]";

/** Default cap for the partial (lineless) buffer held between chunks. */
export const SIDECAR_PARTIAL_MAX_BYTES = 4096;

/** The daemon's boot line that announces the QR block (apps/daemon/src/index.ts). */
const QR_ANNOUNCE = "Pair with the PWA by scanning this QR code:";

/** ANSI SGR escapes the `terminal` renderer of `qrcode` wraps the blocks in. */
const ANSI_RE = new RegExp("\\x1b\\[[0-9;]*m", "g");

/** After ANSI stripping, a QR-only line is just half-block glyphs and space. */
const QR_ONLY_RE = /^[\u2580\u2584\u2588\s]*$/u;

/** Every occurrence of the pairing scheme, up to the next whitespace. */
const PAIRING_URI_RE = new RegExp(`${PAIRING_SCHEME.replace(/[.*+?^{}()|[\]\\/]/g, "\\$&")}\\S*`, "g");

export interface SidecarRedactorOptions {
  /** Cap for the partial (lineless) buffer held between chunks. */
  maxPartialBytes?: number;
}

/**
 * Build a chunk→chunk redactor. Complete lines are redacted and echoed with
 * their `\n` preserved byte-for-byte (`\r\n` survives — only the redacted
 * content changes); a trailing lineless fragment is buffered until the next
 * chunk closes the line, and force-flushed (already redacted) once it grows
 * past `maxPartialBytes` so it can never grow without bound. While in QR mode
 * (armed by the announce line) lines made only of QR blocks, ANSI escapes and
 * whitespace — including empty lines — are dropped entirely; the first normal
 * line leaves the mode and is emitted (redacted).
 */
export function createSidecarRedactor(opts: SidecarRedactorOptions = {}): (chunk: string) => string {
  const maxPartial = Math.max(1, opts.maxPartialBytes ?? SIDECAR_PARTIAL_MAX_BYTES);
  let partial = "";
  let inQr = false;

  const redactLine = (line: string): string => line.replace(PAIRING_URI_RE, REDACTED_MARKER);

  const isQrNoise = (line: string): boolean => QR_ONLY_RE.test(line.replace(ANSI_RE, ""));

  const emitLine = (line: string): string => {
    if (inQr) {
      if (isQrNoise(line)) return ""; // QR block/blank line: dropped whole
      inQr = false; // first normal line after the QR: emitted, redacted
    } else if (line.includes(QR_ANNOUNCE)) {
      inQr = true; // announce line itself is normal text — kept
    }
    return `${redactLine(line)}\n`;
  };

  return (chunk: string): string => {
    let buf = partial + chunk;
    let out = "";
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      out += emitLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
    if (buf.length > maxPartial) {
      // Forced flush of an over-long lineless fragment — already redacted, and
      // still subject to QR suppression. The buffer resets: no unbounded growth
      // even when stdout/stderr interleave and slice a line mid-way.
      if (inQr) {
        if (!isQrNoise(buf)) {
          inQr = false;
          out += redactLine(buf);
        }
      } else {
        out += redactLine(buf);
      }
      buf = "";
    }
    partial = buf;
    return out;
  };
}
