// Crash resilience (P3-011): the two failure modes that used to leave the
// shell dead are handled here.
//
//   1. Renderer gone, window alive → white page forever. The
//      "render-process-gone" handler logs the reason and reloads the page,
//      bounded by a rolling budget (max 3 reloads / 60s) so a page that
//      crashes on boot cannot become an infinite reload loop.
//   2. Exception escaping the main process → Electron hard-crashes the shell
//      WITHOUT running will-quit, which used to kill the daemon sidecar with
//      no cleanup. "uncaughtException"/"unhandledRejection" log the stack and
//      call app.quit() — the graceful path that runs before-quit/will-quit →
//      stopDaemonSidecar.
//
// Everything is written against structural types (no electron import) so
// scripts/desktop-crash.test.ts can exercise the real logic under plain tsx,
// the same pattern as src/update.ts.

/** Max reloads per rolling window before crash recovery gives up. */
export const RELOAD_BUDGET = 3;
/** Width of the rolling reload window in ms. */
export const RELOAD_WINDOW_MS = 60_000;

/**
 * Rolling-window reload budget: at most RELOAD_BUDGET reloads are allowed per
 * RELOAD_WINDOW_MS, no matter how many windows/crashes ask. Old timestamps
 * fall out of the window as it slides, so a single isolated crash never
 * consumes the budget of the next.
 */
export class ReloadGuard {
  private stamps: number[] = [];

  /** Consume one slot; false when the budget is exhausted (nothing recorded). */
  allow(now: number = Date.now()): boolean {
    this.stamps = this.stamps.filter((t) => now - t < RELOAD_WINDOW_MS);
    if (this.stamps.length >= RELOAD_BUDGET) return false;
    this.stamps.push(now);
    return true;
  }
}

/** Structural subset of BrowserWindow the handler touches (tests fake it). */
export interface ReloadableWindow {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; reload(): void };
}

/** Structural subset of Electron's RenderProcessGoneDetails. */
export interface RenderProcessGoneDetails {
  reason: string;
  exitCode: number;
}

/**
 * "render-process-gone" body: log the crash, then reload within budget.
 * A "clean-exit" is not a crash (window close/quit tears the renderer down
 * deliberately) — reloading there would fight the shutdown path.
 */
export function onRendererGone(
  win: ReloadableWindow,
  details: RenderProcessGoneDetails | undefined,
  guard: ReloadGuard,
  log: (line: string) => void = console.log,
  error: (line: string) => void = console.error,
): void {
  const reason = details?.reason ?? "unknown";
  const exitCode = details?.exitCode ?? -1;
  if (reason === "clean-exit") {
    log("[desktop] renderer exited cleanly — no recovery needed");
    return;
  }
  error(`[desktop] renderer gone: reason=${reason} exitCode=${exitCode}`);
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    error("[desktop] window destroyed — not reloading");
    return;
  }
  if (!guard.allow()) {
    error(
      `[desktop] renderer reload budget exhausted (${RELOAD_BUDGET} in ${RELOAD_WINDOW_MS / 1000}s) — NOT reloading again`,
    );
    return;
  }
  win.webContents.reload();
  log("[desktop] renderer reloaded (crash recovery)");
}

/** Structural subset of Electron's app the fatal handlers need (tests fake it). */
export interface QuitCapableApp {
  quit(): void;
}

export interface FatalHandlerSinks {
  error?: (line: string) => void;
  quit?: () => void;
}

/**
 * Install process-level fatal error handlers that quit gracefully (will-quit
 * → stopDaemonSidecar) instead of letting Electron drop the shell dead.
 * The first fatal error wins: both signals funnel through one guard so a
 * cascade (exception + rejection) quits exactly once. Errors are logged with
 * stack — never swallowed silently.
 *
 * Returns a disposer so tests can remove the handlers again.
 */
export function installFatalErrorHandlers(
  app: QuitCapableApp,
  sinks: FatalHandlerSinks = {},
): { dispose(): void } {
  const error = sinks.error ?? ((line: string) => console.error(line));
  const quit = sinks.quit ?? (() => app.quit());
  let quitting = false;
  const fatal = (what: string, err: unknown): void => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    error(`[desktop] fatal: ${what}: ${detail}`);
    if (!quitting) {
      quitting = true;
      quit();
    }
  };
  const onUncaught = (err: unknown): void => fatal("uncaughtException", err);
  const onRejection = (reason: unknown): void => fatal("unhandledRejection", reason);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  return {
    dispose() {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onRejection);
    },
  };
}
