import { useEffect, useState } from "react";
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

/** P2-193: the combined pair link — the app address with the pairing
 * credential moved into the URL fragment (additive field, desktop shell). */
export interface PairLinkInfo {
  url: string;
  qrDataUrl: string | null;
  problems: string[];
}

/** P2-197: reach verdict for the app address, probed from the machine that
 * hosts the daemon (additive field, desktop shell). */
export interface ReachInfo {
  state: string;
  message: string;
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
  /** P2-193: the combined link — when its QR exists, the whole journey
   * collapses into ONE scannable code and the two labeled steps disappear. */
  pairLink?: PairLinkInfo | null;
  /** P2-197: last reach probe verdict (null/absent = unknown → no line). */
  reach?: ReachInfo | null;
  /** P2-197: re-run the reach probe now ("test again" action). */
  onReachRetry?: () => void;
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
export default function PairingOverlay({ qrDataUrl, onDismiss, deviceList, webApp, pairLink, reach, onReachRetry }: Props) {
  const t = useT();
  // P2-189: copy feedback — brief, quiet, and never steals the QR's spotlight.
  const [copied, setCopied] = useState(false);
  // P2-197: "test again" is in flight — the fresh verdict arrives with the
  // next pairing-state push, or the flag self-clears (an unchanged verdict is
  // deduplicated by the shell and never pushed).
  const [retesting, setRetesting] = useState(false);
  useEffect(() => {
    setRetesting(false);
  }, [reach?.state, reach?.message]);
  useEffect(() => {
    if (!retesting) return;
    const id = setTimeout(() => setRetesting(false), 6_000);
    return () => clearTimeout(id);
  }, [retesting]);
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

        {/* P2-193: a usable combined link collapses the journey to a single
            step — one QR carries the app address AND the credential (in the
            fragment), so the phone's camera alone finishes pairing. */}
        {pairLink?.qrDataUrl ? (
          <section className="pair-step pair-step-single" aria-label={t("pairLinkTitle")}>
            <h3 className="pair-step-title">{t("pairLinkTitle")}</h3>
            <img
              className="pair-overlay-qr"
              src={pairLink.qrDataUrl}
              alt={t("pairOverlayAlt")}
              width={240}
              height={240}
            />
            <p className="pair-link-hint">{t("pairLinkHint")}</p>
            {webApp?.url && (
              <div className="pair-webapp-address">
                <code className="pair-webapp-url">{webApp.url}</code>
                <button className="pair-webapp-copy" onClick={() => void copyAddress()}>
                  {copied ? t("pairWebAppCopied") : t("pairWebAppCopy")}
                </button>
              </div>
            )}
          </section>
        ) : (
          <>
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
          </>
        )}

        {/* P2-197: calm reach status below the QR, P2-112 vocabulary. The QR
            is NEVER hidden or dimmed when the probe fails on purpose: this
            Mac not reaching the relay does NOT prove the phone can't either
            (different network, different DNS) — burying the QR on a verdict
            from another machine's network would kill the journey. */}
        {reach && (
          <p className={reach.state === "ok" ? "pair-reach" : "pair-reach pair-reach-warn"}>
            {reach.state === "ok" ? t("pairReachOk") : reach.message}
            {reach.state !== "ok" && (
              <button
                className="pair-reach-retry"
                onClick={() => {
                  setRetesting(true);
                  onReachRetry?.();
                }}
              >
                {retesting ? t("pairReachTesting") : t("pairReachRetry")}
              </button>
            )}
          </p>
        )}

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
