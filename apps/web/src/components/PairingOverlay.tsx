import { useT } from "../lib/i18n";

interface Props {
  /** PNG data-URL rendered by the desktop main process (P2-007). */
  qrDataUrl: string;
  onDismiss: () => void;
}

/**
 * First-run pairing overlay for the desktop shell: shows the daemon's boot
 * pairing URI as a scannable QR until a phone pairs (or the user defers).
 * Desktop-only — App.tsx renders it when the electron bridge reports an
 * unpaired daemon.
 */
export default function PairingOverlay({ qrDataUrl, onDismiss }: Props) {
  const t = useT();
  return (
    <div className="pair-overlay" role="dialog" aria-modal="true" aria-label={t("pairOverlayTitle")}>
      <div className="pair-overlay-card">
        <h2>{t("pairOverlayTitle")}</h2>
        <p className="muted">{t("pairOverlayHint")}</p>
        <img className="pair-overlay-qr" src={qrDataUrl} alt={t("pairOverlayAlt")} width={280} height={280} />
        <button className="primary" onClick={onDismiss}>
          {t("pairOverlayLater")}
        </button>
      </div>
    </div>
  );
}
