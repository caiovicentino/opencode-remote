import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";

/** P3-328: transient "pair first" toast — a Go-menu action pressed at the
 * pairing gate has no target, so the drop must at least explain itself (the
 * pane items stay enabled). Owns its 4s window here, NOT in App.tsx (p2-220:
 * no timers in App), same feedback pattern as the reconnect toast. Each new
 * trigger re-starts the window.
 *
 * P3-358 round 2: the window is derived from the bump's TIMESTAMP, not from
 * instance-local state. The gate's phase churn (health retries flip
 * unpaired↔connecting) remounts this component mid-window; a remount resets
 * `visible` and re-seeds the seen-ref with the current trigger, so the bump
 * was swallowed and the toast never showed (the desktop-flow P3-328 probes
 * failed 12× with "" on main). Visibility now survives remounts: any instance
 * mounting within 4s of the last bump shows the remaining window. */
const WINDOW_MS = 4_000;

/** P3-367: when App passes onPairNow, the toast carries its own labeled exit
 * (P3-329 lesson: the manual escape lives on the stuck screen itself) — an
 * inline "Parear agora" that jumps straight into the manual pairing
 * ceremony instead of leaving the user to find the small link above.
 * onDismiss zeroes the App-owned timestamp: closing must survive the
 * branch-switch remount (a local flag would be re-seeded and the toast
 * would resurrect over the ceremony it just left).
 *
 * P3-362: `what` is the label of the action that triggered this toast —
 * "Artifacts", "Command palette", … — so the sentence names the request
 * instead of flashing one generic pane-agnostic line for every Go item. */
export default function GateHint({
  trigger,
  at,
  what,
  onPairNow,
  onDismiss,
}: {
  trigger: number;
  at: number;
  what?: string | null;
  onPairNow?: () => void;
  onDismiss?: () => void;
}) {
  const t = useT();
  // `now` freezes while the window is open; the timeout only fires the
  // re-render that closes it. Bumps recompute it from the wall clock.
  const [now, setNow] = useState(() => Date.now());
  const visible = trigger > 0 && at > 0 && now - at < WINDOW_MS;
  useEffect(() => {
    if (trigger > 0) setNow(Date.now());
  }, [trigger, at]);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setNow(Date.now()), WINDOW_MS - (now - at));
    return () => clearTimeout(timer);
  }, [visible, now, at]);
  if (!visible) return null;
  return (
    <div className="ocr-toast pair-gate-hint" role="status">
      {what ? t("pairFirstHintFor", { pane: what }) : t("pairFirstHint")}
      {onPairNow && (
        <button
          type="button"
          className="pair-gate-hint-action"
          onClick={() => {
            // close the toast in App state (remount-proof), then route
            onDismiss?.();
            onPairNow();
          }}
        >
          {t("pairFirstAction")}
        </button>
      )}
    </div>
  );
}
