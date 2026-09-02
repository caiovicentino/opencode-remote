import type { Server } from "node:http";
import type { WebSocket } from "ws";

/** hard drain window: the process is gone ≤DRAIN_MS after the first signal */
export const DRAIN_MS = 3000;
/** brief settle so ws close(1001) frames reach the wire before process.exit */
const SETTLE_MS = 250;

/** log sink matching the relay's JSONL `ev()` */
export type RelayLog = (level: "info" | "warn", msg: string, data?: unknown) => void;

export interface ShutdownDeps {
  /** number of live ws clients at the moment the signal arrives */
  activeConnections: () => number;
  /** process uptime in ms (logged with the shutdown line) */
  uptimeMs: () => number;
  /** stop accepting new work: server.close + ws.close(1001) on every client */
  stopListeners: () => Promise<void>;
  /** injectable JSONL sink (the relay's ev()) so the module stays pure */
  log: RelayLog;
  /** injectable so tests can observe exit without killing the runner */
  exit: (code: number) => void;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Idempotent shutdown routine for SIGTERM/SIGINT (P2-023, mirrors the
 * daemon's P2-020):
 * 1. log state ("relay shutting down", active connections, uptime)
 * 2. stop listeners (http(s) close; every ws client closed with code 1001)
 * 3. short settle so close frames flush, log the final line, exit 0
 * A hard timer caps the drain at DRAIN_MS; a second signal exits immediately.
 */
export function createShutdown(deps: ShutdownDeps): {
  shutdown: (signal: string) => Promise<void>;
  isShuttingDown: () => boolean;
} {
  let started = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (started) {
      deps.log("warn", "shutdown already in progress; exiting immediately", { signal });
      deps.exit(0);
      return;
    }
    started = true;
    const closing = deps.activeConnections();
    deps.log("info", "relay shutting down", {
      signal,
      activeConnections: closing,
      uptimeS: Math.round(deps.uptimeMs() / 1000),
    });
    const hard = deps.setTimeout(() => deps.exit(0), DRAIN_MS);
    try {
      await deps.stopListeners();
      await new Promise<void>((r) => deps.setTimeout(r, SETTLE_MS));
    } catch (err) {
      deps.log("warn", "error during shutdown drain", { error: (err as Error).message });
    }
    deps.clearTimeout(hard);
    deps.log("info", "relay shut down", {
      closedConnections: closing,
      uptimeS: Math.round(deps.uptimeMs() / 1000),
    });
    deps.exit(0);
  };
  return { shutdown, isShuttingDown: () => started };
}

/**
 * Ask every ws client to leave with close code 1001 and stop the http(s)
 * server from accepting new connections. Unlike the daemon's version this
 * deliberately does NOT call server.closeAllConnections(): the relay's ws
 * clients ride on the same http server, so destroying those TCP sockets
 * first would eat the 1001 close frames. server.close() refuses new
 * connections immediately; lingering sockets are bounded by the DRAIN_MS
 * hard timer in createShutdown, not by the close callback.
 */
export function stopAccepting(
  server: Server | null,
  sockets: Iterable<WebSocket>,
  log: RelayLog = () => {},
): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      for (const ws of sockets) {
        try {
          ws.close(1001, "server shutting down");
        } catch {
          // already closed/closing — nothing to do for this socket
        }
      }
      if (!server) return resolve();
      if (!server.listening) return resolve();
      server.close(() => resolve());
      return;
    } catch (err) {
      log("warn", "shutdown: failed stopping listeners", { error: (err as Error).message });
      resolve();
    }
  });
}
