/**
 * eval-12: a failing stdout/stderr must never kill the daemon.
 *
 * The incident (prod, 2026-09-08T03:40Z, daemon.err.log): with the disk full,
 * one log line written while answering /api/health (a readiness re-probe)
 * made the file-backed stdout fail with ENOSPC. Node's SyncWriteStream — what
 * process.stdout is when launchd points StandardOutPath at a file — reports a
 * failed write by destroying itself and emitting 'error' on the NEXT tick,
 * after the console's temporary no-op listener is already gone: "Unhandled
 * 'error' event" → the process exits, launchd restarts it and the next boot
 * write hits the same full disk. A pipe-backed stdout (the desktop sidecar,
 * a `| head` in a terminal) dies the same way on EPIPE once its reader is
 * gone. Logging is diagnostics; it can never be the reason the phone loses
 * its daemon.
 *
 * installStdioGuard attaches ONE permanent 'error' listener per stdio stream:
 * the fatal event becomes a counted, silent drop. The listener never logs —
 * the only sink it could write to is the stream that just failed. Keeping the
 * log alive after the stream was destroyed is log.ts's job (it falls back to
 * the raw file descriptor, so a disk that frees up resumes the log without a
 * restart).
 *
 * No I/O here and no import: the unit battery drives it with fake streams and
 * child processes without booting a daemon (lesson P2-149).
 */

/** The slice of a stdio stream the guard needs (a real Writable satisfies it). */
export interface GuardedStream {
  on(event: "error", listener: (err: unknown) => void): unknown;
}

export type StdioName = "stdout" | "stderr";

/** What the guard saw — read by the caller's metrics, never by the listener. */
export interface StdioGuardState {
  /** write errors absorbed since install, both streams */
  errors: number;
  /** errno-style code of the latest absorbed error ("EPIPE", "ENOSPC"…) or null */
  lastCode: string | null;
  /** which stream failed last, or null */
  lastStream: StdioName | null;
}

/**
 * Attach the permanent error listeners. Idempotent per stream object: a second
 * install on the same stream returns the first state and adds nothing, so a
 * re-import can never stack listeners. `onError` runs after the state was
 * updated and must not write to either stream; its own throw is swallowed.
 */
export function installStdioGuard(
  streams: Record<StdioName, GuardedStream>,
  onError?: (stream: StdioName, code: string | null) => void,
): StdioGuardState {
  const existing = GUARDED.get(streams.stdout) ?? GUARDED.get(streams.stderr);
  if (existing) return existing;
  const state: StdioGuardState = { errors: 0, lastCode: null, lastStream: null };
  for (const name of ["stdout", "stderr"] as const) {
    const stream = streams[name];
    GUARDED.set(stream, state);
    stream.on("error", (err: unknown) => {
      state.errors++;
      state.lastCode = errorCode(err);
      state.lastStream = name;
      try {
        onError?.(name, state.lastCode);
      } catch {
        // the callback is observation only — it can never re-raise the event
      }
    });
  }
  return state;
}

const GUARDED = new WeakMap<object, StdioGuardState>();

/** errno-style code when the error carries one ("EPIPE"), else null. */
function errorCode(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  try {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}
