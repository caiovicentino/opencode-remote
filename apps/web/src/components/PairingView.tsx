import { useCallback, useState } from "react";
import QrScanner, { type CameraAccessVerdict } from "./QrScanner";
import PairRetry from "./PairRetry";
import PaneMap from "./PaneMap";
import ReconnectButton from "./ReconnectButton";
import { parsePairingUri } from "../lib/client";
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
  /** P3-427: the settled non-healthy verdict of this machine's local agent —
   * the SAME kind/busy signal the gate card renders (P3-412 lesson), passed
   * only where the user escaped INTO this ceremony with the agent already
   * known down (wizard's agent-down QR error, degraded card's escape). The
   * QR both entries would promise is minted by that down agent, so the scan
   * entry, the host entry and the daemon-assuming intro cannot render here;
   * the paste path stays (it is the only one that can work — with a second
   * machine already running the app). Absent everywhere else: the full
   * ceremony renders byte-for-byte as before (P3-422: one branch per state,
   * never a deletion). */
  agentDown?: boolean;
  /** P3-443: the shell restart bridge (app:reconnectDaemon) — when present the
   * agent-down verdict carries the action that fixes its own cause in the
   * same block, instead of leaving recovery behind the header's quiet Voltar. */
  reconnect?: () => Promise<boolean>;
}

export default function PairingView({ phase, error, hint, autoRetryMs, onPair, onRetry, onPairRemote, localMode, preferPaste, getCamAccess, onBack, offlinePanes, agentDown, reconnect }: Props) {
  const t = useT();
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [emptyHint, setEmptyHint] = useState(false);
  // P3-410: an unusable code answers AT the form, on every surface that
  // hosts it — the App-level error block only renders when the parent's
  // phase flows down (the add-machine screen pins phase="unpaired"), so a
  // garbled paste used to die there in silence. Kind, not message (P3-375):
  // "invalid" is the garbled-text case, "version" the parse's
  // unsupported-protocol throw — each with its own localized copy.
  const [codeError, setCodeError] = useState<"invalid" | "version" | null>(null);
  // P3-428: the App-level verdict for a garbled #/pair?… deep link renders
  // the same red invalid-code block (error === t("invalidCode")) but never
  // touched codeError — the field stayed unflagged and a focused paste box
  // kept the accent-green focus ring directly above the rejection. The flag
  // rides the same condition the block reads (P3-431 pattern: one attribute
  // drives both the danger border and the danger focus ring).
  const appInvalidCode = phase === "error" && error === t("invalidCode");
  const busy = phase === "connecting";

  // P3-410: shared gate for every onPair entry (paste submit + QR scan).
  // Returns false — with the inline error block rendered — when the code
  // can never start a handshake, so the parent's onPair only ever receives
  // a parseable URI and feedback never depends on the parent's phase.
  const acceptCode = useCallback(
    (raw: string): boolean => {
      try {
        if (!parsePairingUri(raw)) {
          setCodeError("invalid");
          requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".pair-code")?.focus());
          return false;
        }
      } catch {
        setCodeError("version");
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".pair-code")?.focus());
        return false;
      }
      setCodeError(null);
      return true;
    },
    [],
  );

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
    if (acceptCode(code)) onPair(code);
  }, [code, onPair, acceptCode]);

  const handleScan = useCallback(
    (text: string) => {
      setScanning(false);
      if (acceptCode(text)) onPair(text);
    },
    [onPair, acceptCode],
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
        /* P3-440: the field flags itself on BOTH failing paths — a rejected
           submit must not read as valid (P3-431: aria-invalid rides the same
           state that renders the inline message, so the empty path gets the
           same visual verdict the garbled-code path has had since P3-410).
           P3-428: the App-level invalid-code verdict (garbled deep link)
           flags the field too. */
        aria-invalid={codeError || emptyHint || appInvalidCode ? true : undefined}
        placeholder="opencode-remote://pair?v=2&relay=…"
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setEmptyHint(false);
          setCodeError(null);
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
      {codeError && (
        <div className="pair-error" role="alert" aria-live="assertive">
          <p className="pair-error-msg">{t(codeError === "version" ? "pairErrVersion" : "invalidCode")}</p>
          <p className="pair-error-hint">{t(codeError === "version" ? "pairErrVersionHint" : "invalidCodeHint")}</p>
        </div>
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

  // P3-334: on the desktop the host section leads — pairing a phone is the
  // primary story on this machine, so the client ceremony reads as the
  // secondary option. The phone never renders the host section (no
  // onPairRemote), so its scan/paste flow is untouched.
  // P3-427: with the local agent down the entry is suppressed too — the QR
  // it promises is minted by that down agent (the wizard's own error block
  // just said so), and clicking it while the daemon is out is a silent
  // no-op: no state changes, no QR ever mints, the overlay never opens.
  // The entry returns the moment the agent answers (agentDown recomputes
  // from the same kind signal the gate card renders).
  const hostSection = onPairRemote && !agentDown && (
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
      {/* P3-441: the ceremony composes — from the shell breakpoint the
          action column (intro, pairing directions, error) sits beside the
          pane map instead of stacking above it, so a 1440px window stops
          rendering the phone column with ~70% of the viewport empty and the
          map stops clipping at the fold. Below 1024px the wrappers are
          transparent blocks and the single-column flow is byte-identical.
          The header stays a direct child of .pair-screen so the sticky
          brand block (P3-423) keeps the scroll container as its containing
          block. */}
      <div className="pair-columns">
        <div className="pair-main">
          {/* EVAL4-F1: the phone (no host section, scan-first) must not read the
              desktop's "pairs with the daemon on this machine" promise.
              P3-427: with the local agent down the intro is dropped entirely —
              it promised the daemon's QR and the auto-connect; the agent-down
              card below IS the honest framing now (same vocabulary the gate
              card renders), so the screen never repeats itself. */}
          {!agentDown && (
            <p className="muted pair-intro">{!preferPaste && !onPairRemote ? t("pairIntroPhone") : t("pairIntro")}</p>
          )}
          {agentDown && phase !== "error" && (
            <div className="degraded-status pair-agent-down" role="status" aria-live="polite">
              {/* P3-412: the settled non-healthy verdict the gate card renders —
                  same dot language, so the verdict can never contradict the
                  card one screen back. */}
              <span className="degraded-dot err" aria-hidden="true" />
              <div>
                <h2>{t("pairAgentDownTitle")}</h2>
                <p className="muted">{t("pairAgentDownHint")}</p>
                {/* P3-443: the recovery that actually recovers lives in the same
                    block as the verdict — the header's quiet Voltar (to the gate
                    card's own reconnect) stops being the only way out. The CTA
                    wears the shared accent primary (P3-450: one dialect). */}
                {reconnect && <ReconnectButton className="primary pair-agent-down-reconnect" reconnect={reconnect} />}
              </div>
            </div>
          )}
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
              {/* P3-427: with the local agent down the scan entry is gone from
                  this section — the QR a camera would scan is minted by the
                  down agent, so the offer can never be honored on this first
                  boot. The paste stays: it is the only path that can work (a
                  code from another machine already running the app). The
                  divider dies with its only branch — a lone "or" under a
                  single option is nonsense. */}
              {preferPaste ? (
                <>
                  {pasteForm}
                  {!agentDown && (
                    <>
                      <p className="muted pair-or">{t("orScan")}</p>
                      {scanButton}
                    </>
                  )}
                </>
              ) : (
                <>
                  {!agentDown && scanButton}
                  {!agentDown && <p className="muted pair-or">{t("orPaste")}</p>}
                  {pasteForm}
                </>
              )}
            </section>
          )}
          {/* P3-410: the form's own invalid-code verdict wins over the App-level
              block — the freshest submit is the relevant feedback, and one error
              per screen (P2-108). Editing the field dissolves it and the parent
              block (timeout, rejection…) shows again. */}
          {phase === "error" && !codeError && (
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
        </div>
        <aside className="pair-side">
          {/* P3-364: the standing answer to "why pair at all?" — the panes the
              gate hides, listed where the gate toast (P3-328) is only a flash.
              P3-413: inside the desktop shell only the chat carries the lock —
              the other four panes open pre-pairing from the gate rail. */}
          <PaneMap offlinePanes={offlinePanes} />
        </aside>
      </div>
    </div>
  );
}
