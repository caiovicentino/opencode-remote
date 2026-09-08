import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { IconRefresh } from "./icons";

/** EVAL4-F4: an outage escalates after this long — "reconnecting…" is honest
 * for a blip, a lie for a machine that was reinstalled, closed or rekeyed
 * into a room nobody joins (the phone cannot tell those apart by itself). */
export const CONN_STALE_AFTER_MS = 45_000;

type Props = {
  /** Machine name for the copy (falls back to the dict's generic word). */
  machineName: string;
  /** Real dials since the drop (OcrClient.attempts). */
  attempts: number;
  /** Date.now() of the drop (OcrClient.disconnectedSince); 0 = unknown. */
  since: number;
  /** "Try now": skip the pending backoff. */
  onRetry: () => void;
  /** "Pair again": forget this machine and re-enter the pairing flow. */
  onPairAgain: () => void;
};

/**
 * EVAL4-F4 (fable r4): the one connection surface of the mobile shell
 * OUTSIDE the chat. Before, the phone had none: the shell banners need the
 * desktop bridge, the drawer only had a colour dot, and a send from the home
 * hung 60 s before any word. Inside the chat ChatView's own .conn-banner
 * speaks (P2-108: never two banners) — App mounts this only when no chat is
 * on screen. The escalation timer lives here, not in App.tsx (P2-220 pins
 * App.tsx to zero timers).
 */
export default function ConnStrip({ machineName, attempts, since, onRetry, onPairAgain }: Props) {
  const t = useT();
  const startedAt = since || Date.now();
  const [stale, setStale] = useState(() => Date.now() - startedAt >= CONN_STALE_AFTER_MS);
  useEffect(() => {
    const left = Math.max(0, CONN_STALE_AFTER_MS - (Date.now() - startedAt));
    const timer = window.setTimeout(() => setStale(true), left);
    return () => clearTimeout(timer);
  }, [startedAt]);
  const name = machineName.trim() || t("machineFallbackName");
  const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
  return (
    <div className="conn-strip" role="status" aria-live="polite" data-stale={stale ? "1" : undefined}>
      <div className="conn-strip-line">
        <IconRefresh size={14} className={stale ? undefined : "conn-banner-spin"} aria-hidden />
        <span>
          {stale
            ? t("connStripStale", { name, m: minutes })
            : t("connStripTrying", { name, n: Math.max(1, attempts) })}
        </span>
      </div>
      {stale && (
        <>
          <p className="conn-strip-hint">{t("connStripStaleHint")}</p>
          <div className="conn-strip-actions">
            <button className="primary" onClick={onRetry}>
              {t("connRetryNow")}
            </button>
            <button onClick={onPairAgain}>{t("reauthAction")}</button>
          </div>
        </>
      )}
    </div>
  );
}
