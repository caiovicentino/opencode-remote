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

// P2-223: the same file now also hosts the unresponsive-window watch —
// onUnresponsive/onResponsive, structural siblings of onRendererGone — so
// both failure modes of a dead shell (frozen page, gone renderer) live in
// one place and one test file. The decision itself stays pure in
// src/hangwatch.ts; here it is only wired to the episode lifecycle: guard
// the episode start instant, cancel the pending warning when the window
// comes back, record the real duration at the end.

import {
  HANG_DIALOG_THRESHOLD_MS,
  HANG_WARN_THRESHOLD_MS,
  hangVerdict,
} from "./hangwatch";

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

  /** Read-only probe for the hang watcher (P2-223): true while the rolling
   * window holds RELOAD_BUDGET stamps. Consumes nothing and changes nothing
   * about the budget or the rolling window itself. */
  exhausted(now: number = Date.now()): boolean {
    const stamps = this.stamps.filter((t) => now - t < RELOAD_WINDOW_MS);
    return stamps.length >= RELOAD_BUDGET;
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
 * `onBudgetExhausted` (P2-223) runs when the budget is gone, so the
 * definitive white screen is never silent — it goes through the same
 * hang-watch verdict (log, tray tip and, outside a harness session, the
 * native box with the reload option).
 */
export function onRendererGone(
  win: ReloadableWindow,
  details: RenderProcessGoneDetails | undefined,
  guard: ReloadGuard,
  log: (line: string) => void = console.log,
  error: (line: string) => void = console.error,
  onBudgetExhausted?: () => void,
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
    onBudgetExhausted?.();
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

// --- P2-223: unresponsive-window watch ----------------------------------------
//
// Electron fires "unresponsive"/"responsive" on webContents. The episode
// state below is owned by the caller (main.ts creates one per window) and
// every timer is injected, so scripts/desktop-crash.test.ts can prove the
// cleanup guarantees with fake clocks: going responsive cancels the pending
// warning, two consecutive episodes leak no timer, and a harness session
// never opens a box (hangVerdict's first rule).

/** Outcome of the last unresponsive episode, for the diagnostics bundle. */
export interface HangEpisodeRecord {
  durationMs: number;
  outcome: "warn" | "dialog" | "responsive" | "budget-exhausted";
}

/** Caller-owned state of the ongoing (or latest) unresponsive episode. */
export interface HangEpisodeState {
  /** Start instant of the ongoing episode (null when the window responds). */
  startedAt: number | null;
  /** Whether a user-facing warning already fired for this same episode. */
  warned: boolean;
  /** The episode's single pending timer (null when nothing is armed). */
  timer: unknown;
  /** Set when the window is gone — no timer may ever fire again. */
  closed: boolean;
  /** The latest finished episode, for the diagnostics bundle (one line). */
  last: HangEpisodeRecord | null;
}

export function newHangEpisodeState(): HangEpisodeState {
  return { startedAt: null, warned: false, timer: null, closed: false, last: null };
}

/** Injected clock/timers so tests can drive the watch without real waits. */
export interface HangTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Output sinks; main.ts resolves them to the file logger, a native
 * notification and the native dialog. */
export interface HangSinks {
  log: (line: string) => void;
  notify: (body: string) => void;
  showDialog: () => void;
}

export interface HangContext {
  /** hangVerdict's FIRST rule: a harness session never sees a box. */
  harnessSession: boolean;
  /** Read-only reload-budget probe (ReloadGuard.exhausted). */
  budget: { exhausted(): boolean };
  sinks: HangSinks;
  timers: HangTimers;
  now: () => number;
}

/** "unresponsive" body: open the episode (idempotent — while the page stays
 * frozen Electron may re-emit) and arm the episode's single timer. */
export function onUnresponsive(episode: HangEpisodeState, ctx: HangContext): void {
  if (episode.closed || episode.startedAt !== null) return;
  episode.startedAt = ctx.now();
  episode.warned = false;
  armHangTimer(episode, ctx, HANG_WARN_THRESHOLD_MS);
}

/** "responsive" body: cancel the pending warning, log the real episode
 * duration and close the episode so the next freeze starts clean. */
export function onResponsive(episode: HangEpisodeState, ctx: HangContext): void {
  cancelHangTimer(episode, ctx);
  if (episode.startedAt !== null) {
    const durationMs = Math.max(0, ctx.now() - episode.startedAt);
    episode.last = { durationMs, outcome: "responsive" };
    ctx.sinks.log(`[desktop] hang watch: janela voltou a responder após ${Math.round(durationMs / 1000)}s`);
  }
  episode.startedAt = null;
  episode.warned = false;
}

/** Window closed: the episode can never recover — drop the pending timer
 * and freeze the state so nothing fires after death. */
export function onHangWindowClosed(episode: HangEpisodeState, ctx: HangContext): void {
  cancelHangTimer(episode, ctx);
  episode.closed = true;
  episode.startedAt = null;
  episode.warned = false;
}

/** ReloadGuard exhausted (definitive white screen): the recovery gave up, so
 * the same verdict speaks — log, tray tip and, outside a harness session, the
 * native box with the reload option. */
export function onReloadBudgetExhausted(episode: HangEpisodeState, ctx: HangContext): void {
  // A gone renderer never turns responsive — the pending warning is moot.
  cancelHangTimer(episode, ctx);
  const elapsed = episode.startedAt === null ? 0 : Math.max(0, ctx.now() - episode.startedAt);
  const verdict = hangVerdict({
    harnessSession: ctx.harnessSession,
    unresponsiveMs: elapsed,
    reloadBudgetExhausted: true,
    alreadyWarned: episode.warned,
  });
  ctx.sinks.log(`[desktop] hang watch: ${verdict.log}`);
  episode.last = { durationMs: elapsed, outcome: "budget-exhausted" };
  episode.startedAt = null;
  episode.warned = false;
  if (verdict.action === "dialog") {
    ctx.sinks.notify(verdict.tray);
    ctx.sinks.showDialog();
  }
}

function armHangTimer(episode: HangEpisodeState, ctx: HangContext, delayMs: number): void {
  cancelHangTimer(episode, ctx);
  episode.timer = ctx.timers.setTimeout(() => {
    episode.timer = null;
    fireHangVerdict(episode, ctx);
  }, delayMs);
}

function fireHangVerdict(episode: HangEpisodeState, ctx: HangContext): void {
  const elapsed = episode.startedAt === null ? 0 : Math.max(0, ctx.now() - episode.startedAt);
  const verdict = hangVerdict({
    harnessSession: ctx.harnessSession,
    unresponsiveMs: elapsed,
    reloadBudgetExhausted: ctx.budget.exhausted(),
    alreadyWarned: episode.warned,
  });
  ctx.sinks.log(`[desktop] hang watch: ${verdict.log}`);
  if (verdict.action === "log") return;
  episode.warned = true;
  episode.last = { durationMs: elapsed, outcome: verdict.action };
  ctx.sinks.notify(verdict.tray);
  if (verdict.action === "dialog") {
    ctx.sinks.showDialog();
    return;
  }
  // "warn" fired at the tip threshold: re-arm the episode's single timer
  // (one pending handle at any moment, canceled by responsive/close) for the
  // dialog beat if the freeze keeps going.
  armHangTimer(episode, ctx, Math.max(0, HANG_DIALOG_THRESHOLD_MS - elapsed));
}

function cancelHangTimer(episode: HangEpisodeState, ctx: HangContext): void {
  if (episode.timer !== null) {
    ctx.timers.clearTimeout(episode.timer);
    episode.timer = null;
  }
}
