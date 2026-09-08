import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";

/** P3-328: transient "pair first" toast — a Go-menu action pressed at the
 * pairing gate has no target, so the drop must at least explain itself (the
 * pane items stay enabled). Owns its 4s window here, NOT in App.tsx (p2-220:
 * no timers in App), same feedback pattern as the reconnect toast. Each new
 * trigger re-starts the window; a stale trigger never re-shows on remount. */
export default function GateHint({ trigger }: { trigger: number }) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seen = useRef(trigger);
  useEffect(() => {
    if (trigger === seen.current) return;
    seen.current = trigger;
    setVisible(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 4_000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [trigger]);
  if (!visible) return null;
  return (
    <div className="ocr-toast pair-gate-hint" role="status">
      {t("pairFirstHint")}
    </div>
  );
}
