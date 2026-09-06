/**
 * Desktop crash-recovery tests (P3-011): the renderer-gone reload budget and
 * the process-level fatal error handlers that quit gracefully (running the
 * existing will-quit → stopDaemonSidecar cleanup) instead of dropping the
 * shell dead. Pure logic under structural fakes — no Electron needed.
 * Run: npx tsx scripts/desktop-crash.test.ts
 */
import {
  installFatalErrorHandlers,
  newHangEpisodeState,
  onHangWindowClosed,
  onRendererGone,
  onReloadBudgetExhausted,
  onResponsive,
  onUnresponsive,
  RELOAD_BUDGET,
  RELOAD_WINDOW_MS,
  ReloadGuard,
  type HangContext,
  type HangTimers,
  type ReloadableWindow,
} from "../apps/desktop/src/crash";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

function fakeWindow(): { win: ReloadableWindow; reloads: () => number; destroy(): void } {
  let destroyed = false;
  let reloads = 0;
  return {
    win: {
      isDestroyed: () => destroyed,
      webContents: {
        isDestroyed: () => destroyed,
        reload: () => {
          reloads++;
        },
      },
    },
    reloads: () => reloads,
    destroy: () => {
      destroyed = true;
    },
  };
}

// --- ReloadGuard: rolling window of RELOAD_BUDGET -----------------------------
{
  const guard = new ReloadGuard();
  const t0 = 1_000_000;
  for (let i = 0; i < RELOAD_BUDGET; i++) {
    check(`guard: allows reload ${i + 1}/${RELOAD_BUDGET}`, guard.allow(t0 + i));
  }
  check("guard: blocks after budget exhausted", !guard.allow(t0 + 1000));
  check("guard: still blocked inside the window", !guard.allow(t0 + RELOAD_WINDOW_MS - 1));
  check("guard: allows again after the window slides", guard.allow(t0 + RELOAD_WINDOW_MS + 1));
}

// --- onRendererGone ------------------------------------------------------------
{
  const { win, reloads } = fakeWindow();
  const guard = new ReloadGuard();
  const logs: string[] = [];
  const errors: string[] = [];
  onRendererGone(
    win,
    { reason: "crashed", exitCode: 11 },
    guard,
    (l) => logs.push(l),
    (l) => errors.push(l),
  );
  check("renderer gone: reloads once on crash", reloads() === 1);
  check("renderer gone: logs the reason", errors.some((l) => l.includes("reason=crashed") && l.includes("exitCode=11")));
  check("renderer gone: logs recovery on stdout", logs.some((l) => l.includes("renderer reloaded")));
}

{
  const { win, reloads } = fakeWindow();
  const errors: string[] = [];
  onRendererGone(win, { reason: "clean-exit", exitCode: 0 }, new ReloadGuard(), () => {}, (l) =>
    errors.push(l),
  );
  check("renderer gone: clean-exit does not reload", reloads() === 0);
  check("renderer gone: clean-exit is not an error", errors.length === 0);
}

{
  // Budget exhausted → 4th crash is logged loudly but NOT reloaded.
  const { win, reloads } = fakeWindow();
  const guard = new ReloadGuard();
  const errors: string[] = [];
  const log = () => {};
  const error = (l: string) => errors.push(l);
  for (let i = 0; i < RELOAD_BUDGET; i++) onRendererGone(win, { reason: "crashed", exitCode: 1 }, guard, log, error);
  const before = reloads();
  onRendererGone(win, { reason: "oom", exitCode: 2 }, guard, log, error);
  check("renderer gone: reload loop capped at budget", reloads() === before);
  check("renderer gone: budget exhaustion logged loudly", errors.some((l) => l.includes("NOT reloading again")));
}

{
  // Destroyed window: no reload attempt and the budget is not consumed.
  const { win, reloads, destroy } = fakeWindow();
  const guard = new ReloadGuard();
  destroy();
  onRendererGone(win, { reason: "crashed", exitCode: 1 }, guard, () => {}, () => {});
  check("renderer gone: destroyed window is not reloaded", reloads() === 0);
  check("renderer gone: destroyed window keeps budget intact", guard.allow());
}

// --- installFatalErrorHandlers -------------------------------------------------
{
  const errors: string[] = [];
  let quits = 0;
  const handlers = installFatalErrorHandlers(
    { quit: () => quits++ },
    { error: (l) => errors.push(l), quit: () => quits++ },
  );
  const boom = new Error("boom");
  process.emit("uncaughtException", boom);
  check("fatal: uncaughtException quits the app", quits === 1);
  check("fatal: uncaughtException logged with stack", errors.some((l) => l.includes("uncaughtException") && l.includes("boom") && l.includes("at ")));

  process.emit("unhandledRejection", new Error("rejection"));
  check("fatal: unhandledRejection logged", errors.some((l) => l.includes("unhandledRejection") && l.includes("rejection")));
  check("fatal: cascade quits exactly once", quits === 1);

  handlers.dispose();
  process.emit("uncaughtException", new Error("after-dispose"));
  check("fatal: dispose removes handlers", quits === 1);
}

// --- P2-223: unresponsive-window watch (onUnresponsive/onResponsive) ----------
{
  // Injectable fake clock + timers: the cleanup guarantees are proven by
  // counting pending handles, with no real waits.
  function fakeTimers(): HangTimers & { pendingCount(): number; fireAll(): void } {
    const pending = new Map<number, () => void>();
    let nextId = 1;
    return {
      setTimeout(fn: () => void, _ms: number): unknown {
        const id = nextId++;
        pending.set(id, fn);
        return id;
      },
      clearTimeout(handle: unknown): void {
        pending.delete(handle as number);
      },
      pendingCount: () => pending.size,
      fireAll(): void {
        const fns = [...pending.values()];
        pending.clear();
        for (const fn of fns) fn();
      },
    };
  }

  function hangCtx(opts: {
    harness: boolean;
    clock: () => number;
    timers: ReturnType<typeof fakeTimers>;
    budgetExhausted?: boolean;
  }): HangContext & { logs: string[]; notes: string[]; boxes: number } {
    const state = { logs: [] as string[], notes: [] as string[], boxes: 0 };
    const ctx = {
      harnessSession: opts.harness,
      budget: { exhausted: () => opts.budgetExhausted ?? false },
      sinks: {
        log: (line: string) => state.logs.push(line),
        notify: (body: string) => state.notes.push(body),
        showDialog: () => {
          state.boxes++;
        },
      },
      timers: opts.timers,
      now: opts.clock,
      logs: state.logs,
      notes: state.notes,
      get boxes() {
        return state.boxes;
      },
    } as HangContext & { logs: string[]; notes: string[]; boxes: number };
    return ctx;
  }

  let clock = 0;
  const timers = fakeTimers();

  // Harness session: the timer may fire, but NOTHING user-facing happens —
  // no dialog, no notification (the verdict's first rule).
  {
    const episode = newHangEpisodeState();
    const ctx = hangCtx({ harness: true, clock: () => clock, timers });
    onUnresponsive(episode, ctx);
    clock = 60_000;
    timers.fireAll();
    check("hang: harness session opens no dialog", ctx.boxes === 0);
    check("hang: harness session shows no notification", ctx.notes.length === 0);
    check("hang: harness session still logs the freeze", ctx.logs.length > 0);
  }

  // Real session: fresh freeze → warn (tip, no box) at the tip threshold,
  // then the box if the freeze keeps going — and no pending timer after.
  {
    const episode = newHangEpisodeState();
    const ctx = hangCtx({ harness: false, clock: () => clock, timers });
    clock = 0;
    onUnresponsive(episode, ctx);
    check("hang: one timer armed for the episode", timers.pendingCount() === 1);
    clock = 5_000;
    timers.fireAll();
    check("hang: fresh freeze warns without a box", ctx.boxes === 0 && ctx.notes.length === 1);
    check("hang: the episode's timer is re-armed once for the dialog beat", timers.pendingCount() === 1);
    clock = 30_000;
    timers.fireAll();
    check("hang: a freeze past the dialog beat offers the box", ctx.boxes === 1);
    check("hang: no timer pending after the box", timers.pendingCount() === 0);
  }

  // Going responsive cancels the pending warning and logs the real duration.
  {
    const episode = newHangEpisodeState();
    const ctx = hangCtx({ harness: false, clock: () => clock, timers });
    clock = 0;
    onUnresponsive(episode, ctx);
    clock = 2_000;
    onResponsive(episode, ctx);
    check("hang: responsive cancels the pending warning", timers.pendingCount() === 0);
    check("hang: responsive logs the real episode duration", ctx.logs.some((l) => l.includes("2s")));
    timers.fireAll();
    check("hang: nothing fires after responsive", ctx.boxes === 0 && ctx.notes.length === 0);
    check("hang: diagnostics record the resolved episode", episode.last?.outcome === "responsive");
  }

  // Two consecutive episodes leak no timer.
  {
    const episode = newHangEpisodeState();
    const ctx = hangCtx({ harness: false, clock: () => clock, timers });
    clock = 0;
    onUnresponsive(episode, ctx);
    clock = 5_000;
    timers.fireAll(); // warn beat, timer re-armed
    onResponsive(episode, ctx);
    check("hang: first episode ends with zero pending timers", timers.pendingCount() === 0);
    clock = 10_000;
    onUnresponsive(episode, ctx); // second episode starts clean
    check("hang: second episode arms exactly one timer", timers.pendingCount() === 1);
    clock = 15_000;
    onResponsive(episode, ctx);
    check("hang: second episode also ends with zero pending timers", timers.pendingCount() === 0);
  }

  // Reload budget exhausted (definitive white screen): the same verdict
  // speaks — log, tray tip and, outside a harness session, the box.
  {
    const episode = newHangEpisodeState();
    const harness = hangCtx({ harness: true, clock: () => clock, timers, budgetExhausted: true });
    onReloadBudgetExhausted(episode, harness);
    check("hang: exhausted budget in a harness session opens no box", harness.boxes === 0);
    check("hang: exhausted budget in a harness session still logs", harness.logs.length === 1);

    const real = hangCtx({ harness: false, clock: () => clock, timers, budgetExhausted: true });
    onReloadBudgetExhausted(episode, real);
    check("hang: exhausted budget outside harness offers the box", real.boxes === 1);
    check("hang: exhausted budget shows the tray tip", real.notes.length === 1);
    check("hang: exhausted budget logs and records the outcome", real.logs.length === 1 && episode.last?.outcome === "budget-exhausted");
    check("hang: exhausted budget leaves no timer behind", timers.pendingCount() === 0);
  }

  // Window closed: the pending timer dies with it and nothing fires after.
  {
    const episode = newHangEpisodeState();
    const ctx = hangCtx({ harness: false, clock: () => clock, timers });
    clock = 0;
    onUnresponsive(episode, ctx);
    onHangWindowClosed(episode, ctx);
    check("hang: window close cancels the episode timer", timers.pendingCount() === 0);
    clock = 60_000;
    timers.fireAll();
    check("hang: nothing fires after the window is gone", ctx.boxes === 0 && ctx.notes.length === 0);
  }

  // onRendererGone calls the budget hook only when the budget is exhausted.
  {
    const { win, reloads } = fakeWindow();
    const guard = new ReloadGuard();
    let exhaustedCalls = 0;
    for (let i = 0; i < RELOAD_BUDGET; i++) onRendererGone(win, { reason: "crashed", exitCode: 1 }, guard);
    onRendererGone(win, { reason: "oom", exitCode: 2 }, guard, () => {}, () => {}, () => exhaustedCalls++);
    check("hang: the budget-exhausted hook fires on the white screen", exhaustedCalls === 1);
    check("hang: the white screen does not reload", reloads() === RELOAD_BUDGET);
    const guard2 = new ReloadGuard();
    onRendererGone(win, { reason: "crashed", exitCode: 1 }, guard2, () => {}, () => {}, () => exhaustedCalls++);
    check("hang: the hook stays silent while the budget lasts", exhaustedCalls === 1 && reloads() > RELOAD_BUDGET);
  }

  // ReloadGuard.exhausted: read-only probe, budget semantics untouched.
  {
    const guard = new ReloadGuard();
    const t0 = 2_000_000;
    guard.allow(t0);
    guard.allow(t0 + 1);
    check("hang: exhausted() is false under the budget", !guard.exhausted(t0 + 2));
    guard.allow(t0 + 2);
    check("hang: exhausted() is true at the budget ceiling", guard.exhausted(t0 + 3));
    check("hang: exhausted() consumes nothing (still true, allow still false)", guard.exhausted(t0 + 3) && !guard.allow(t0 + 3));
    check("hang: exhausted() follows the rolling window down", !guard.exhausted(t0 + RELOAD_WINDOW_MS + 1));
  }
}

console.log(failures === 0 ? "\ndesktop crash tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
process.exit(failures === 0 ? 0 : 1);
