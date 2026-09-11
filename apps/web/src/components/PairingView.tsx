import { useCallback, useState } from "react";
import QrScanner, { type CameraAccessVerdict } from "./QrScanner";
import PairRetry from "./PairRetry";
import PaneMap from "./PaneMap";
import { useT } from "../lib/i18n";

interface Props {
  phase: "unpaired" | "connecting" | "error" | "paired";
  error: string;
  /** EVAL4-F1: actionable next step under the error (App resolves it from
   * lib/pairerror.ts kinds); absent for errors that carry no hint. */
  hint?: string;
  /** EVAL4-F1b: a stored pairing that timed out re-runs onRetry after this
   * many ms (countdown line under the error); absent = manual retry only. */
  autoRetryMs?: number;
  /** P3-331: quiet return to the calm degraded card — the manual escape must
   * never be a one-way door. Absent in flows without a surface behind it. */
  onBack?: () => void;
  onPair: (uri: string) => void;
  onRetry: () => void;
  /** P1-070: desktop shell only — explicit "pair a remote phone" action that
   * turns the QR ceremony back on (app:setRemotePairing). */
  onPairRemote?: () => void;
  /** P1-070: the shell is auto-connecting to the daemon on this machine. */
  localMode?: boolean;
  /** P2-117: desktop shells lead with the paste form — pointing a camera at
   * another desktop's QR is a circular flow. Camera stays available as an
   * option; on the phone the scan button remains primary. */
  preferPaste?: boolean;
  /** P2-319: camera-permission verdict (desktop shell only) — the scanner's
   * permission refusal becomes an actionable system-panel call to action. */
  getCamAccess?: () => Promise<CameraAccessVerdict | null>;
  /** P3-413: the desktop shell has real offline panes (gate rail/Go menu),
   * so the map below the ceremony drops the four padlocks and reads "before
   * pairing". The phone passes nothing and keeps the fully locked map. */
  offlinePanes?: boolean;
}

export default function PairingView({ phase, error, hint, autoRetryMs, onPair, onRetry, onPairRemote, localMode, preferPaste, getCamAccess, onBack, offlinePanes }: Props) {
  const t = useT();
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [emptyHint, setEmptyHint] = useState(false);
  const busy = phase === "connecting";

  // P3-361: an empty "Parear" click is a validation event, not a no-op — the
  // button stays live and the form answers with an inline hint + focus on the
  // paste box, the same recovery voice an invalid code already gets.
  const submit = useCallback(() => {
    if (!code.trim()) {
      setEmptyHint(true);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".pair-code")?.focus());
      return;
    }
    setEmptyHint(false);
    onPair(code);
  }, [code, onPair]);

  const handleScan = useCallback(
    (text: string) => {
      setScanning(false);
      onPair(text);
    },
    [onPair],
  );

  // P2-117: the scanner's paste CTA returns to the primary form, focused —
  // the camera being unavailable must never dead-end the pairing flow.
  const backToPaste = useCallback(() => {
    setScanning(false);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".pair-code")?.focus());
  }, []);

  if (scanning) {
    return <QrScanner onScan={handleScan} onCancel={() => setScanning(false)} onPaste={backToPaste} getCamAccess={getCamAccess} />;
  }

  // P2-112: in local mode the intro promises automatic pairing — showing the
  // full scan/paste ceremony right below contradicted it. The manual widgets
  // stay available for the explicit remote ceremony (pairRemote entry), not
  // as a first-contact dead weight.
  const ceremony = !localMode;

  // P2-106: the two pairing directions read as titled sections — "pair a phone
  // with this machine" (this device as host) and "connect to another machine"
  // (this device as client: scan/paste). The error keeps the
  // locale-independent .pair-error hook the desktop-flow gate asserts on.

  // P2-117: paste-first on the desktop (the camera path is the option);
  // scan-first on the phone.
  const pasteForm = (
    <>
      <textarea
        className="pair-code"
        rows={2}
        placeholder="opencode-remote://pair?v=2&relay=…"
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setEmptyHint(false);
        }}
        disabled={busy}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
      />
      <button
        className={preferPaste ? "pair-submit primary" : "pair-submit"}
        disabled={busy}
        onClick={submit}
      >
        {busy ? (localMode ? t("localConnecting") : t("connecting")) : t("pairBtn")}
      </button>
      {emptyHint && (
        <p className="pair-empty-hint" role="alert">
          {t("pairEmptyCode")}
        </p>
      )}
    </>
  );

  const scanButton = (
    <button
      className={preferPaste ? "pair-scan-entry" : "primary pair-scan-entry"}
      disabled={busy}
      onClick={() => setScanning(true)}
    >
      {t("scanQr")}
    </button>
  );

  const hostSection = onPairRemote && (
    <section className="pair-section">
      <h2 className="pair-section-title">{t("pairHostTitle")}</h2>
      <button className="pair-remote-entry" onClick={onPairRemote} disabled={busy}>
        <span className="pair-remote-copy">
          <b>{t("pairRemoteTitle")}</b>
          <span className="muted">{t("pairRemoteHint")}</span>
        </span>
        <svg
          className="pair-remote-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </section>
  );

  // P3-332: local mode lives or dies by its copy — the intro promises the
  // shell connects itself, so the screen shows the attempt: a live status card
  // (pulsing dot + phase + retry) instead of a silent idle page. The manual
  // ceremony stays hidden (P2-112); the error block below still carries its
  // own recovery affordance.
  const autoState = localMode && phase !== "error";

  // P3-334: on the desktop the host section leads — pairing a phone is the
  // primary story on this machine, so the client ceremony reads as the
  // secondary option. The phone never renders the host section (no
  // onPairRemote), so its scan/paste flow is untouched.
  return (
    <div className="screen pair-screen">
      <header>
        {/* P3-373: same glyph language as the welcome wizard — the first
            three screens of the journey share one brand header. */}
        <div className="welcome-mark" aria-hidden="true">
          ✻
        </div>
        <h1 className="brand-wordmark">OpenCode Remote</h1>
        {/* P3-411: the ceremony replaces the whole shell, so its exit rides the
            sticky brand header — top-left and always on screen. The old
            end-of-flow link rendered under the pane map (below the fold at
            1440x900) and left users who arrived via the manual escape without
            a visible way out. */}
        {onBack && (
          <button className="pair-back" onClick={onBack}>
            <svg
              className="pair-back-chevron"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            {t("pairBack")}
          </button>
        )}
      </header>
      {/* EVAL4-F1: the phone (no host section, scan-first) must not read the
          desktop's "pairs with the daemon on this machine" promise. */}
      <p className="muted pair-intro">{!preferPaste && !onPairRemote ? t("pairIntroPhone") : t("pairIntro")}</p>
      {autoState && (
        <div className="pair-auto" role="status" aria-live="polite">
          <span className="pair-auto-dot" aria-hidden="true" />
          <div className="pair-auto-copy">
            <h2 className="pair-auto-title">{busy ? t("localConnecting") : t("autoConnectLooking")}</h2>
            <p className="muted pair-auto-hint">
              {busy ? t("autoConnectBusyHint") : t("autoConnectIdleHint")}
            </p>
            {!busy && (
              <button className="pair-auto-retry" onClick={onRetry}>
                {t("retry")}
              </button>
            )}
          </div>
        </div>
      )}
      {hostSection}
      {ceremony && (
        <section className="pair-section">
          <h2 className="pair-section-title">{t("pairConnectTitle")}</h2>
          {preferPaste ? (
            <>
              {pasteForm}
              <p className="muted pair-or">{t("orScan")}</p>
              {scanButton}
            </>
          ) : (
            <>
              {scanButton}
              <p className="muted pair-or">{t("orPaste")}</p>
              {pasteForm}
            </>
          )}
        </section>
      )}
      {phase === "error" && (
        <div className="pair-error" role="alert" aria-live="assertive">
          <p className="pair-error-msg">{error}</p>
          {error === t("invalidCode") && (
            <p className="pair-error-hint">{t("invalidCodeHint")}</p>
          )}
          {hint && error !== t("invalidCode") && <p className="pair-error-hint">{hint}</p>}
          {autoRetryMs !== undefined && <PairRetry ms={autoRetryMs} onRetry={onRetry} />}
          <button className="pair-error-retry" onClick={onRetry}>{t("retry")}</button>
        </div>
      )}
      {/* P3-364: the standing answer to "why pair at all?" — the panes the
          gate hides, listed where the gate toast (P3-328) is only a flash.
          P3-413: inside the desktop shell only the chat carries the lock —
          the other four panes open pre-pairing from the gate rail. */}
      <PaneMap offlinePanes={offlinePanes} />
    </div>
  );
}
