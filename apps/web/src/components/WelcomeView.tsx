import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import type { DegradedKind, UpstreamNotice } from "../lib/degraded";
import { qrWaitVerdict, QR_WAIT_TIMEOUT_MS } from "../lib/qrWait";
import ReconnectButton from "./ReconnectButton";
import UpstreamMissingActions from "./UpstreamMissingActions";

interface Props {
  kind: DegradedKind;
  /** The shell is mid-`connect()` (auto-pair attempt in flight). */
  busy: boolean;
  /** P2-138 upstream (opencode) notice, rendered inside the agent step. */
  upstream: UpstreamNotice | null;
  /** Shell bridge's app:reconnectDaemon — absent in the plain browser. */
  reconnect?: () => Promise<boolean>;
  /** P1-070 explicit "pair a remote phone" action (app:setRemotePairing). */
  onPairRemote?: () => void;
  /** P1-056: live pairing ceremony state — inline QR instead of dumping the
   * user out of the guided flow (the docs no longer carry the first pair). */
  qrDataUrl?: string | null;
  phonePaired?: boolean;
  /** P1-056 (fable #2): leave the ceremony — turns remote pairing OFF so
   * "do this later" never resurrects the QR overlay after onboarding. */
  onCancelPairRemote?: () => void;
  /** P3-329: labeled escape to the manual paste-code ceremony, offered on
   * the QR error branch — a stuck wait must never dead-end a first-time
   * user on a spinner whose only alternative hides one screen earlier. */
  onPairManually?: () => void;
  /** Finish (or skip) — App stamps the flag and unmounts the onboarding. */
  onDone: () => void;
  /** P3-392: re-runs the shell's pairing tick for the missing-binary
   * "check again" action (app:recheckWebApp). Absent in the plain browser. */
  onRecheck?: () => void;
}

/** P1-056: step-3 inline ceremony — opts into remote pairing on mount, shows
 * the live QR, and reflects the phone handshake the moment it lands. */
function InlinePair({
  qrDataUrl,
  phonePaired,
  onPairRemote,
  onCancelPairRemote,
  onPairManually,
}: {
  qrDataUrl?: string | null;
  phonePaired?: boolean;
  onPairRemote: () => void;
  onCancelPairRemote?: () => void;
  onPairManually?: () => void;
}) {
  const t = useT();
  // fable #2/#3: mount-only ceremony — the App passes a NEW inline arrow per
  // render, so a dependency-triggered effect would spam the IPC. Callbacks
  // live in refs; the cleanup covers later/skip/done (after "paired" turning
  // it off is a no-op — the shell already reset the mode).
  const on = useRef(onPairRemote);
  on.current = onPairRemote;
  const off = useRef(onCancelPairRemote);
  off.current = onCancelPairRemote;
  useEffect(() => {
    on.current();
    return () => {
      off.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const anyPairRemote = true;
  // P3-333: the QR is minted by the shell's poll (normally well under a
  // second) — but a cold daemon or a failed tick used to leave this step on
  // a bare "generating" line forever. Track elapsed time since the wait
  // started; past the timeout the pure verdict resolves to a retryable
  // inline error instead of a frozen skeleton.
  const [elapsedMs, setElapsedMs] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const startedAt = useRef(Date.now());
  useEffect(() => {
    if (qrDataUrl) return;
    const id = window.setInterval(() => {
      const elapsed = Date.now() - startedAt.current;
      setElapsedMs(elapsed);
      if (elapsed >= QR_WAIT_TIMEOUT_MS) window.clearInterval(id);
    }, 500);
    return () => window.clearInterval(id);
  }, [qrDataUrl, attempt]);
  const verdict = qrWaitVerdict({ qrDataUrl, elapsedMs });
  // Retry re-fires the shell's remote-pairing request (app:setRemotePairing
  // re-runs its poll) and restarts the wait window. The calm exit stays the
  // step's "do this later" — this block only adds the way back in.
  const retry = () => {
    startedAt.current = Date.now();
    setElapsedMs(0);
    setAttempt((a) => a + 1);
    on.current();
  };
  if (phonePaired) {
    return (
      <div className="degraded-status" data-paired="ok">
        <span className="degraded-dot" aria-hidden="true" />
        <div>
          <h3>{t("welcomePairedTitle")}</h3>
          <p className="muted">{t("welcomePairedHint")}</p>
        </div>
      </div>
    );
  }
  // P3-337: the step-3 card heading above is the single pairing title — this
  // section carries only the live QR/status, no all-caps kicker repeating it.
  return (
    <section className="pair-section" data-pair-wait={!qrDataUrl}>
      {qrDataUrl ? (
        <img className="welcome-qr" src={qrDataUrl} alt={t("pairOverlayAlt")} />
      ) : verdict === "error" ? (
        <div className="welcome-qr-error" role="alert">
          <p className="welcome-qr-error-title">{t("welcomeQrError")}</p>
          {/* P3-329: name the dependency — the QR is minted from the local
              agent's pairing credential; with the agent down nothing loads. */}
          <p className="muted welcome-qr-hint">{t("welcomeQrErrorHint")}</p>
          <div className="welcome-qr-actions">
            <button className="welcome-qr-retry" onClick={retry}>
              {t("welcomeQrRetry")}
            </button>
            {onPairManually && (
              <button className="welcome-qr-manual" onClick={onPairManually}>
                {t("welcomeQrManual")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="welcome-qr-wait" role="status">
          <div className="skel welcome-qr-skel" aria-hidden="true" />
          <p className="muted">{t("welcomeQrWait")}</p>
          {/* P3-329: even the healthy wait says where the QR comes from — a
              first-time user with a dead agent is never left guessing. */}
          <p className="muted welcome-qr-hint">{t("welcomeQrWaitHint")}</p>
        </div>
      )}
    </section>
  );
}

/** P2-148: first-run welcome — three steps, shown once. Step 1 introduces the
 * app in one sentence, step 2 shows the local agent's live state (same calm
 * copy and upstream-notice block as the degraded journey, never a second
 * banner per P2-108), step 3 invites pairing a phone with an explicit "do
 * this later". Zero emoji (P2-107), P3-083 tokens only, 150–300ms motion
 * that dies under prefers-reduced-motion (P3-087). */
export default function WelcomeView({ kind, busy, upstream, reconnect, onPairRemote, onCancelPairRemote, qrDataUrl, phonePaired, onPairManually, onDone, onRecheck }: Props) {
  const t = useT();
  const [step, setStep] = useState(1);

  const agentOk = !busy && kind === "none" && !upstream;
  const agentState = busy ? "connecting" : kind === "none" ? "ok" : kind;
  const agentTitle = busy
    ? t("localConnecting")
    : kind === "reconnecting"
      ? t("reconnecting", { n: 0 })
      : kind === "down"
        ? t("daemonDown")
        : agentOk
          ? t("welcomeAgentOk")
          : t("firstContactTitle");
  const agentHint = kind === "down" && !busy ? t("degradedDownHint") : t("firstContactHint");

  return (
    <div className="welcome" data-welcome-step={step}>
      <div className="welcome-col">
        {/* P3-374: progress reads as part of the brand block — the step
            indicator sits centered under the wordmark instead of one end of a
            sparse space-between row detached from the card it governs. */}
        <header>
          <div className="welcome-mark" aria-hidden="true">
            ✻
          </div>
          <h1 className="brand-wordmark">OpenCode Remote</h1>
          <div className="welcome-meta">
            {/* P3-421: three quiet dots carry the progress — the brand block
                stays typography-first instead of a caps caption under the
                serif wordmark; the copy survives as the accessible label. */}
            <div className="welcome-steps" role="group" aria-label={t("welcomeStepOf", { n: step })}>
              {[1, 2, 3].map((n) => (
                <span
                  key={n}
                  className={`welcome-step-dot${n === step ? " on" : n < step ? " done" : ""}`}
                  aria-hidden="true"
                />
              ))}
            </div>
          </div>
        </header>
        {step === 1 && (
          <div className="welcome-step welcome-intro">
            <h2 className="welcome-step-title">{t("welcomeStep1Title")}</h2>
            <p className="muted">{t("welcomeStep1Body")}</p>
            {/* P3-374: escape and progress read as one unit — the quiet skip
                sits in the card's action row next to the primary action
                (P3-338: the final step keeps "do this later" as its single,
                in-context exit, so no global skip renders there). */}
            <div className="welcome-actions">
              <button className="primary welcome-next" onClick={() => setStep(2)}>
                {t("welcomeStart")}
              </button>
              <button className="welcome-skip" onClick={onDone}>
                {t("welcomeSkip")}
              </button>
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="welcome-step welcome-agent" data-agent-state={agentState}>
            <h2 className="welcome-step-title">{t("welcomeStep2Title")}</h2>
            <div className="degraded-status">
              <span className={`degraded-dot${kind === "down" ? " err" : ""}`} aria-hidden="true" />
              <div>
                <h3>{agentTitle}</h3>
                <p className="muted">{agentHint}</p>
              </div>
            </div>
            {upstream && (
              <div className={`degraded-upstream tone-${upstream.tone}`} role="note">
                <p className="degraded-upstream-title">{t(upstream.titleKey)}</p>
                <p className="degraded-upstream-action">{t(upstream.actionKey)}</p>
                {/* Daemon-provided detail: plain text interpolation only (React
                    escapes it) — the P2-138 spec forbids rendering it as HTML. */}
                {(upstream.reason || upstream.hint) && (
                  <p className="degraded-upstream-detail">
                    {[upstream.reason, upstream.hint].filter(Boolean).join(" — ")}
                  </p>
                )}
                {/* P3-392: the binary-missing verdict carries the whole
                    install journey on the desktop shell too — first boot is
                    exactly where the leigo meets it (P1-071). */}
                {upstream.missingBinary && <UpstreamMissingActions onRecheck={onRecheck} />}
              </div>
            )}
            <ReconnectButton className="welcome-retry" reconnect={reconnect} />
            <div className="welcome-actions">
              <button className="primary welcome-next" onClick={() => setStep(3)}>
                {t("welcomeNext")}
              </button>
              <button className="welcome-skip" onClick={onDone}>
                {t("welcomeSkip")}
              </button>
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="welcome-step welcome-pair">
            <h2 className="welcome-step-title">{t("welcomeStep3Title")}</h2>
            <p className="muted">{t("welcomeStep3Body")}</p>
            {/*
              P1-056: the ceremony stays INSIDE the guided flow — mounting the
              step opts into remote pairing (P1-070) and the live QR renders
              inline; a paired phone flips the step to a confirmation and the
              only way out is "done". No terminal, no docs.
            */}
            {onPairRemote && (
              <InlinePair
                qrDataUrl={qrDataUrl}
                phonePaired={phonePaired}
                onPairRemote={onPairRemote}
                onCancelPairRemote={onCancelPairRemote}
                onPairManually={onPairManually}
              />
            )}
            {!onPairRemote && (
              <section className="pair-section">
                <span className="muted">{t("pairRemoteHint")}</span>
              </section>
            )}
            {phonePaired && (
              <button className="primary welcome-next" onClick={onDone}>
                {t("welcomeDone")}
              </button>
            )}
            {!phonePaired && (
              <button className="welcome-later" onClick={onDone}>
                {t("welcomeLater")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
