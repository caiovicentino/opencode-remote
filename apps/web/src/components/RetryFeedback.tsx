import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { escalationMinutes, escalateDetailKey, retryLineParts, ESCALATE_HATCH_KEY, RETRY_ESCALATE_AFTER_SEC } from "../lib/degraded";
import ReconnectButton from "./ReconnectButton";

/** P3-454: the live auto-retry feedback the first-boot journey promises — one
 * contract rendered by BOTH degraded surfaces: the gate's calm card (P2-112)
 * and the welcome wizard's agent step. The wizard's step-2 card carries the
 * same "keeps trying on its own" promise as the gate card, so it must show the
 * same feedback while it is on screen — the pulsing status dot, seconds since
 * the current attempt started and the shell's attempt counter riding along.
 * P3-372: seconds tick since the current attempt started and reset whenever
 * the shell bumps its counter, so the number doubles as a quiet countdown to
 * the next probe. P3-333's lesson applied verbatim: a restart resets the
 * started-at ref AND bumps a state sitting in the interval effect's deps —
 * zeroing the elapsed state alone would leave the already-cleared interval
 * and the ticker would never re-arm. The live segment is aria-hidden:
 * role="status" on the line would otherwise re-announce it to screen readers
 * every second. */
export function RetryLine({ attempts }: { attempts?: number }) {
  const t = useT();
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef(Date.now());
  const [tickEpoch, setTickEpoch] = useState(0);

  useEffect(() => {
    startedAtRef.current = Date.now();
    setElapsed(0);
    setTickEpoch((e) => e + 1);
  }, [attempts]);

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [tickEpoch]);

  return (
    <>
      {t("degradedRetrying")}
      <span className="degraded-retry-meta" aria-hidden="true">
        {retryLineParts(elapsed, attempts, t)}
      </span>
    </>
  );
}

/** P3-363/P3-454: the cumulative retry clock shared by the two degraded
 * surfaces — seconds spent auto-retrying on the current mount, pausing
 * whenever the auto-retry state is not active (busy connect in flight, "down"
 * already has its own copy). P3-333's lesson applied: the interval effect
 * arms on [active] itself and the tick increments functionally, so a re-arm
 * can never leave a stale cleared timer nor double-count. P3-394: the
 * documented test hatch (ESCALATE_HATCH_KEY + reload, desktop-flow gate)
 * seeds the mount already escalated — no 60s wait. Same policy as the other
 * test-only hatches: read once at mount, persists nothing. */
export function useRetryClock(active: boolean): number {
  const [total, setTotal] = useState(() => {
    try {
      return localStorage.getItem(ESCALATE_HATCH_KEY) === "1" ? RETRY_ESCALATE_AFTER_SEC : 0;
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTotal((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return total;
}

/** P3-363/P3-454: the escalation block a degraded surface earns after a
 * minute of silent retrying (shouldEscalateRetry) — the total keeps
 * accumulating across attempts while the auto-retry line is visible and
 * pauses when it is not. P3-385: the block is also where the manual reconnect
 * action lives once escalation fires — the standalone button is suppressed,
 * so the column keeps ONE calm recovery path; the retry returns demoted to a
 * quiet text link beside the diagnostics button (same feedback contract as
 * the old button: trying state, spinner, result toast). P3-394: the detail
 * follows the surface — desktop names the in-app diagnostics button right
 * below, the phone points back to the computer. No terminal command on
 * either. */
export function EscalationBlock({ totalSec, onOpenHelp, reconnect, desktopShell }: { totalSec: number; onOpenHelp?: () => void; reconnect?: () => Promise<boolean>; desktopShell?: boolean }) {
  const t = useT();
  return (
    <div className="degraded-escalate" role="note">
      <p className="degraded-escalate-title">
        {t("degradedEscalateTitle", { m: escalationMinutes(totalSec) })}
      </p>
      <p className="degraded-escalate-detail">{t(escalateDetailKey(!!desktopShell))}</p>
      {(onOpenHelp || reconnect) && (
        <div className="degraded-escalate-actions">
          {onOpenHelp && (
            <button className="degraded-upstream-help" onClick={onOpenHelp}>
              {t("degradedEscalateDiagnostics")}
            </button>
          )}
          {reconnect && <ReconnectButton className="degraded-reconnect-link" reconnect={reconnect} />}
        </div>
      )}
    </div>
  );
}
