import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";

/**
 * EVAL4-F1b (fable r4): a phone that already holds a pairing and cold-starts
 * while the machine is unreachable used to be dropped on the pairing wall and
 * left there — even after the daemon came back (pwa-live j1: 92/93/94). For a
 * STORED pairing a timeout is an outage, not a pairing problem: this line
 * counts down and re-runs the same auto-pair the app boots with. The timer
 * lives here (P2-220 pins App.tsx to zero timers); it is unmounted the moment
 * the error phase ends.
 */
export default function PairRetry({ ms, onRetry }: { ms: number; onRetry: () => void }) {
  const t = useT();
  const [left, setLeft] = useState(Math.ceil(ms / 1000));
  useEffect(() => {
    const started = Date.now();
    const tick = window.setInterval(() => {
      const remaining = Math.ceil((ms - (Date.now() - started)) / 1000);
      if (remaining <= 0) {
        clearInterval(tick);
        onRetry();
        return;
      }
      setLeft(remaining);
    }, 1000);
    return () => clearInterval(tick);
    // one countdown per mount: the parent remounts on every new error
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <p className="pair-error-hint pair-retry" aria-live="off">
      {t("pairAutoRetry", { s: left })}
    </p>
  );
}
