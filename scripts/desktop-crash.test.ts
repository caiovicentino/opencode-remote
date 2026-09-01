/**
 * Desktop crash-recovery tests (P3-011): the renderer-gone reload budget and
 * the process-level fatal error handlers that quit gracefully (running the
 * existing will-quit → stopDaemonSidecar cleanup) instead of dropping the
 * shell dead. Pure logic under structural fakes — no Electron needed.
 * Run: npx tsx scripts/desktop-crash.test.ts
 */
import {
  installFatalErrorHandlers,
  onRendererGone,
  RELOAD_BUDGET,
  RELOAD_WINDOW_MS,
  ReloadGuard,
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

console.log(failures === 0 ? "\ndesktop crash tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
