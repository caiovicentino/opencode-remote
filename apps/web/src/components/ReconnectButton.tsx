import { useRef, useState } from "react";
import { useT } from "../lib/i18n";

/** P2-112: "Reconnect now" with real feedback. The old button fired an IPC
 * round-trip with zero visible effect (explorer nightly 2026-09-03); this
 * version holds a perceivable trying state (spinner, ≥2s) and then toasts the
 * actual outcome reported by the shell's restart path. */
export default function ReconnectButton({
  reconnect,
  className = "daemon-reconnect-btn",
}: {
  reconnect?: () => Promise<boolean>;
  /** Override only where the banner pill styling does not apply. */
  className?: string;
}) {
  const t = useT();
  const [trying, setTrying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function click(): Promise<void> {
    if (trying) return;
    setTrying(true);
    const startedAt = Date.now();
    let ok = false;
    try {
      ok = (await reconnect?.()) ?? false;
    } catch {
      ok = false;
    }
    // A failed restart resolves fast — the trying state must be perceivable,
    // otherwise the click still reads as "nothing happened".
    const elapsed = Date.now() - startedAt;
    if (elapsed < 2_000) await new Promise((r) => setTimeout(r, 2_000 - elapsed));
    setTrying(false);
    setToast(ok ? t("reconnectStarted") : t("reconnectFailed"));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4_000);
  }

  return (
    <>
      <button
        className={className}
        onClick={() => void click()}
        disabled={trying}
        aria-busy={trying}
      >
        {trying && <span className="reconnect-spin" aria-hidden="true" />}
        {trying ? t("reconnectTrying") : t("reconnectNow")}
      </button>
      {toast && (
        <div className="ocr-toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
