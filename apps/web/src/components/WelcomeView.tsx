import { useState } from "react";
import { useT } from "../lib/i18n";
import type { DegradedKind, UpstreamNotice } from "../lib/degraded";
import ReconnectButton from "./ReconnectButton";

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
  /** Finish (or skip) — App stamps the flag and unmounts the onboarding. */
  onDone: () => void;
}

/** P2-148: first-run welcome — three steps, shown once. Step 1 introduces the
 * app in one sentence, step 2 shows the local agent's live state (same calm
 * copy and upstream-notice block as the degraded journey, never a second
 * banner per P2-108), step 3 invites pairing a phone with an explicit "do
 * this later". Zero emoji (P2-107), P3-083 tokens only, 150–300ms motion
 * that dies under prefers-reduced-motion (P3-087). */
export default function WelcomeView({ kind, busy, upstream, reconnect, onPairRemote, onDone }: Props) {
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
        <header>
          <h1 style={{ fontSize: "1rem", margin: 0 }}>OpenCode Remote</h1>
        </header>
        <div className="welcome-meta">
          <span className="welcome-step-of">{t("welcomeStepOf", { n: step })}</span>
          <button className="welcome-skip" onClick={onDone}>
            {t("welcomeSkip")}
          </button>
        </div>
        {step === 1 && (
          <div className="welcome-step welcome-intro">
            <h2 className="welcome-step-title">{t("welcomeStep1Title")}</h2>
            <p className="muted">{t("welcomeStep1Body")}</p>
            <button className="primary welcome-next" onClick={() => setStep(2)}>
              {t("welcomeStart")}
            </button>
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
              </div>
            )}
            <ReconnectButton className="welcome-retry" reconnect={reconnect} />
            <button className="primary welcome-next" onClick={() => setStep(3)}>
              {t("welcomeNext")}
            </button>
          </div>
        )}
        {step === 3 && (
          <div className="welcome-step welcome-pair">
            <h2 className="welcome-step-title">{t("welcomeStep3Title")}</h2>
            <p className="muted">{t("welcomeStep3Body")}</p>
            {/* Host section of PairingView, verbatim markup so the styles and
                the gate's locale-independent hooks carry over. */}
            <section className="pair-section">
              <h2 className="pair-section-title">{t("pairHostTitle")}</h2>
              <button
                className="pair-remote-entry"
                onClick={() => {
                  onPairRemote?.();
                  onDone();
                }}
              >
                <b>{t("pairRemoteTitle")}</b>
                <span className="muted">{t("pairRemoteHint")}</span>
              </button>
            </section>
            <button className="welcome-later" onClick={onDone}>
              {t("welcomeLater")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
