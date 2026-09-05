import { useT } from "../lib/i18n";

interface Props {
  /** PNG data-URL rendered by the desktop main process (P2-007). */
  qrDataUrl: string;
  onDismiss: () => void;
  /** P1-056: paired devices — present when the user opened "Celular" with a
   * phone already paired (pair-another-device ceremony). */
  deviceList?: { label: string; addedAt?: string }[];
}

/**
 * First-run splash (P1-050): the desktop shell's very first screen. Leads with
 * the product value in the user's language (pt/en), shows the pairing QR and
 * promises the first real value in under a minute — the pairing flow itself
 * already existed (P2-007); this frames it as an onboarding, not an error
 * state. Desktop-only — App.tsx renders it when the electron bridge reports an
 * unpaired daemon.
 */
export default function PairingOverlay({ qrDataUrl, onDismiss, deviceList }: Props) {
  const t = useT();
  return (
    <div className="pair-overlay" role="dialog" aria-modal="true" aria-label={t("pairOverlayTitle")}>
      <div className="pair-overlay-card">
        <img
          className="splash-logo"
          src="icon.svg"
          alt=""
          width={44}
          height={44}
          onError={(e) => {
            // Asset missing (some dev layouts): degrade to the wordmark only.
            e.currentTarget.style.display = "none";
          }}
        />
        <h2 className="splash-wordmark">OpenCode Remote</h2>
        <p className="splash-value">{t("splashValue")}</p>
        <img className="pair-overlay-qr" src={qrDataUrl} alt={t("pairOverlayAlt")} width={280} height={280} />
        <ol className="splash-steps">
          <li>{t("splashStep1")}</li>
          <li>{t("splashStep2")}</li>
          <li>{t("splashStep3")}</li>
        </ol>
        {deviceList && deviceList.length > 0 && (
          <p className="splash-under muted">
            {t("pairDevicesCount", { n: String(deviceList.length) })}
            {deviceList.map((d) => d.label).join(", ")}
          </p>
        )}
        <p className="splash-under">{t("splashUnder")}</p>
        {/* P2-106: the QR is the hero — "pair later" demotes to a quiet text
            link so the only primary action on this screen is scanning it. */}
        <button className="pair-overlay-later" onClick={onDismiss}>
          {t("pairOverlayLater")}
        </button>
      </div>
    </div>
  );
}
