import { useEffect, useRef } from "react";
import { useT } from "../lib/i18n";
import type { ScreenSourceInfo } from "../lib/screenresponder";

// P3-404: the shell's screen-peek indicator — a calm, bounded flash (the
// capture happened, the phone already has the frame) plus, on multi-display
// machines, the screen/window picker that recaptures from another source.
// Owns its own hide timer: App.tsx is pinned to zero timers (P2-220).

export interface ScreenFlashState {
  at: number;
  sources: ScreenSourceInfo[];
}

export default function ScreenFlash({
  flash,
  onClose,
  onRecapture,
}: {
  flash: ScreenFlashState;
  onClose: () => void;
  onRecapture: (sourceId: string) => void;
}) {
  const t = useT();
  // the flash is bounded by the CAPTURE time, not by App's render cadence:
  // onClose arrives through a ref so a re-render during active use can never
  // restart the 6s hide timer (review round 3)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const timer = setTimeout(() => closeRef.current(), 6000);
    return () => clearTimeout(timer);
  }, [flash.at]);
  return (
    <div className="screen-flash" role="status">
      <div className="screen-flash-head">
        <span className="screen-flash-text">
          {t("screenPeekIndicator", {
            time: new Date(flash.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          })}
        </span>
        <button className="screen-flash-x" onClick={onClose} aria-label={t("close")}>
          ×
        </button>
      </div>
      {flash.sources.length > 1 && (
        <div className="screen-flash-sources">
          <span className="screen-flash-sources-label">{t("screenPeekPickSource")}</span>
          {flash.sources.map((s) => (
            <button key={s.id} className="screen-flash-source" onClick={() => onRecapture(s.id)} title={s.name}>
              {s.name || s.id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
