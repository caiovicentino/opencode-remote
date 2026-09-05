import { useState } from "react";
import { copyText } from "../lib/clipboard";
import { useT } from "../lib/i18n";

/** P2-189: step one of the pairing journey — the address the phone opens to
 * reach the app (additive field from the desktop shell's pairing state). */
export interface WebAppInfo {
  url: string;
  origin: "stored" | "derived" | "unavailable";
  reason: string;
  qrDataUrl: string | null;
}

interface Props {
  /** PNG data-URL rendered by the desktop main process (P2-007). */
  qrDataUrl: string;
  onDismiss: () => void;
  /** P1-056: paired devices — present when the user opened "Celular" with a
   * phone already paired (pair-another-device ceremony). */
  deviceList?: { label: string; addedAt?: string }[];
  /** P2-189: the app address + its QR (null QR when the address is
   * unavailable — the calm explanation renders instead). */
  webApp?: WebAppInfo | null;
}

/**
 * First-run splash (P1-050): the desktop shell's very first screen. Leads with
 * the product value in the user's language (pt/en), shows the pairing QR and
 * promises the first real value in under a minute — the pairing flow itself
 * already existed (P2-007); this frames it as an onboarding, not an error
 * state. Desktop-only — App.tsx renders it when the electron bridge reports an
 * unpaired daemon.
 *
 * P2-189: the journey now starts at step one — how the phone reaches the app
 * (open this address) — with the pairing QR demoted to step two. The two
 * steps carry visible labels so two QR codes never appear unlabeled.
 */
export default function PairingOverlay({ qrDataUrl, onDismiss, deviceList, webApp }: Props) {
  const t = useT();
  // P2-189: copy feedback — brief, quiet, and never steals the QR's spotlight.
  const [copied, setCopied] = useState(false);
  async function copyAddress() {
    if (!webApp?.url) return;
    try {
      setCopied(await copyText(webApp.url));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
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

        {/* P2-189 step one: get the app open on the phone. The QR carries the
            app address; when no usable address exists (local relay only), a
            calm explanation takes its place — never a QR that lies. */}
        <section className="pair-step" aria-label={t("pairWebAppTitle")}>
          <span className="pair-step-label">{t("pairStepOne")}</span>
          <h3 className="pair-step-title">{t("pairWebAppTitle")}</h3>
          {webApp?.qrDataUrl ? (
            <>
              <img
                className="pair-overlay-qr"
                src={webApp.qrDataUrl}
                alt={t("pairWebAppAlt")}
                width={180}
                height={180}
              />
              <div className="pair-webapp-address">
                <code className="pair-webapp-url">{webApp.url}</code>
                <button className="pair-webapp-copy" onClick={() => void copyAddress()}>
                  {copied ? t("pairWebAppCopied") : t("pairWebAppCopy")}
                </button>
              </div>
            </>
          ) : (
            <p className="pair-webapp-unavailable">{t("pairWebAppUnavailable")}</p>
          )}
        </section>

        {/* P2-189 step two: the pairing QR, now labeled — both QRs on this
            screen always say which is which. The QR is the hero of the card
            and the only primary action; keep it visibly larger than the
            step-one address QR. */}
        <section className="pair-step" aria-label={t("pairOverlayTitle")}>
          <span className="pair-step-label">{t("pairStepTwo")}</span>
          <h3 className="pair-step-title">{t("pairOverlayTitle")}</h3>
          <img className="pair-overlay-qr" src={qrDataUrl} alt={t("pairOverlayAlt")} width={240} height={240} />
        </section>

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
