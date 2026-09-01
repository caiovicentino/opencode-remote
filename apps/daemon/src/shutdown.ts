import type { Server } from "node:http";
import type { WebSocket } from "ws";
import { log } from "./log.js";

/** hard drain window: the process is gone ≤DRAIN_MS after the first signal */
export const DRAIN_MS = 3000;
/** brief settle so ws close(1001) frames reach the wire before process.exit */
const SETTLE_MS = 250;

export interface ShutdownDeps {
  /** number of live client sessions at the moment the signal arrives */
  activeConnections: () => number;
  /** process uptime in ms (logged with the shutdown line) */
  uptimeMs: () => number;
  /** stop accepting new work: server.close + ws.close(1001) on every peer */
  stopListeners: () => Promise<void>;
  /** injectable so tests can observe exit without killing the runner */
  exit: (code: number) => void;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Idempotent shutdown routine for SIGTERM/SIGINT:
 * 1. log state ("daemon shutting down", active connections, uptime)
 * 2. stop listeners (http close; relay/client ws closed with code 1001)
 * 3. short settle so close frames flush, then exit 0
 * A hard timer caps the drain at DRAIN_MS; a second signal exits immediately.
 */
export function createShutdown(deps: ShutdownDeps): {
  shutdown: (signal: string) => Promise<void>;
  isShuttingDown: () => boolean;
} {
  let started = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (started) {
      log("warn", "shutdown already in progress; exiting immediately", { signal });
      deps.exit(0);
      return;
    }
    started = true;
    log("info", "daemon shutting down", {
      signal,
      activeConnections: deps.activeConnections(),
      uptimeS: Math.round(deps.uptimeMs() / 1000),
    });
    const hard = deps.setTimeout(() => deps.exit(0), DRAIN_MS);
    try {
      await deps.stopListeners();
      await new Promise<void>((r) => deps.setTimeout(r, SETTLE_MS));
    } catch (err) {
      log("warn", "error during shutdown drain", { error: (err as Error).message });
    }
    deps.clearTimeout(hard);
    deps.exit(0);
  };
  return { shutdown, isShuttingDown: () => started };
}

/**
 * Stop the loopback API/metrics server and close every relay websocket with
 * close code 1001 ("going away") so clients know the daemon is shutting down,
 * not crashing. Resolves when the http server finishes closing (keep-alive
 * sockets are destroyed first) — ws close handshakes are fire-and-forget, the
 * drain timer in createShutdown bounds the total wait.
 */
export function stopAccepting(server: Server | null, sockets: Iterable<WebSocket>): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      for (const ws of sockets) {
        try {
          ws.close(1001, "daemon shutting down");
        } catch {
          // already closed/closing — nothing to do for this socket
        }
      }
      if (!server) return resolve();
      server.closeAllConnections();
      if (!server.listening) return resolve();
      server.close(() => resolve());
      return;
    } catch (err) {
      log("warn", "shutdown: failed stopping listeners", { error: (err as Error).message });
      resolve();
    }
  });
}
