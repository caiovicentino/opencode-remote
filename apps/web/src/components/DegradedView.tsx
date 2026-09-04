import { useState } from "react";
import { useT, setLang, getLang, type Lang } from "../lib/i18n";
import type { DegradedKind, SidecarExitNotice, UpstreamNotice } from "../lib/degraded";
import ReconnectButton from "./ReconnectButton";

interface Props {
  kind: DegradedKind;
  /** The renderer is mid-`connect()` (auto-pair attempt in flight). */
  busy: boolean;
  reconnectAttempts?: number;
  /** Shell bridge's app:reconnectDaemon — absent in the plain browser. */
  reconnect?: () => Promise<boolean>;
  onPairManually: () => void;
  /** P2-138: upstream (opencode) notice rendered INSIDE this calm card —
   * never a second banner (P2-108 single-surface rule). */
  upstream?: UpstreamNotice | null;
  /** P2-138: secondary action — opens the Settings help section. */
  onOpenHelp?: () => void;
  /** P2-140: why the local daemon died (exit classifier verdict), rendered
   * INSIDE this calm card — never a second banner (P2-108 rule). */
  sidecarExit?: SidecarExitNotice | null;
}

/** P2-112: first-boot degraded journey (desktop shell). With the local daemon
 * unreachable the old flow stranded a first-time user on the pairing screen —
 * four central surfaces inaccessible, zero feedback. This view never
 * dead-ends: one calm status ("connecting for the first time…", never a red
 * "daemon fell" for a daemon the machine never met), a visible auto-retry
 * line with the attempt counter, a reconnect action with real feedback, the
 * purely-local data that keeps working, and manual pairing one click away. */
export default function DegradedView({ kind, busy, reconnectAttempts, reconnect, onPairManually, upstream, onOpenHelp, sidecarExit }: Props) {
  const t = useT();
  const [lang, setLangState] = useState<Lang>(getLang());

  const title = busy
    ? t("localConnecting")
    : kind === "reconnecting"
      ? t("reconnecting", { n: reconnectAttempts ?? 0 })
      : kind === "down"
        ? t("daemonDown")
        : t("firstContactTitle");
  const hint =
    kind === "down" && !busy ? t("degradedDownHint") : t("firstContactHint");
  // The visible auto-retry line: honest per state — the shell keeps probing
  // every few seconds unless the respawn budget is exhausted (kind "down").
  const autoRetry = !busy && kind !== "down";

  return (
    <div className="screen degraded" data-degraded-kind={busy ? "connecting" : kind}>
      <header>
        <h1 style={{ fontSize: "1rem", margin: 0 }}>OpenCode Remote</h1>
      </header>
      <div className="degraded-status">
        <span className={`degraded-dot${kind === "down" ? " err" : ""}`} aria-hidden="true" />
        <div>
          <h2>{title}</h2>
          <p className="muted">{hint}</p>
        </div>
      </div>
      {sidecarExit && (
        <div className="degraded-exit" role="note">
          <p className="degraded-exit-title">{t(sidecarExit.titleKey)}</p>
          <p className="degraded-exit-action">{t(sidecarExit.actionKey)}</p>
        </div>
      )}
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
          {onOpenHelp && (
            <button className="degraded-upstream-help" onClick={onOpenHelp}>
              {t("upstreamHelpAction")}
            </button>
          )}
        </div>
      )}
      {autoRetry && (
        <p className="degraded-retry" role="status">
          {t("degradedRetrying")}
        </p>
      )}
      <div className="degraded-actions">
        <ReconnectButton className="degraded-reconnect-btn" reconnect={reconnect} />
      </div>
      <div className="degraded-local">
        <h3>{t("degradedLocalTitle")}</h3>
        <p className="muted">{t("degradedLocalHint")}</p>
        <select
          aria-label={t("degradedLocalTitle")}
          value={lang}
          onChange={(e) => {
            const next = e.target.value as Lang;
            setLang(next);
            setLangState(next);
          }}
        >
          <option value="en">English</option>
          <option value="pt">Português</option>
        </select>
      </div>
      <button className="degraded-manual" onClick={onPairManually}>
        {t("degradedPairManually")}
      </button>
    </div>
  );
}
