import { useEffect, useRef, useState } from "react";
import { useT, setLang, getLang, type Lang } from "../lib/i18n";
import { retryLineParts } from "../lib/degraded";
import type { DegradedKind, SidecarExitNotice, SidecarWedgeNotice, UpstreamNotice } from "../lib/degraded";
import ReconnectButton from "./ReconnectButton";
import PaneMap from "./PaneMap";
import { applyTheme } from "./SettingsView";

// P3-368: the offline card's copy promises "language and theme" — the theme
// control ships here too, persisting to the same ocr_theme key Settings reads
// and reapplying through the shared applyTheme().
type ThemeChoice = "dark" | "light" | "system";
const THEME_KEY = "ocr_theme";

function storedTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "dark" || stored === "light" ? stored : "system";
  } catch {
    return "system";
  }
}

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
  /** P2-324: the local daemon wedged alive (wedge probe verdict), rendered in
   * the SAME calm band as the exit notice below. Precedence is documented:
   * when both verdicts exist at once the exit notice wins — a daemon that
   * actually died is the stronger story than one being revived. */
  sidecarWedge?: SidecarWedgeNotice | null;
}

/** P3-372: the auto-retry line with live feedback — seconds tick since the
 * current attempt started and the shell's attempt counter rides along (the
 * counter the component docstring below promises; it used to appear only in
 * the reconnecting title). Elapsed resets when the shell bumps its counter,
 * so the number doubles as a quiet countdown to the next probe. P3-333's
 * lesson applied verbatim: a restart resets the started-at ref AND bumps a
 * state sitting in the interval effect's deps — zeroing the elapsed state
 * alone would leave the already-cleared interval and the ticker would never
 * re-arm. The live segment is aria-hidden: role="status" on the line would
 * otherwise re-announce it to screen readers every second. */
function RetryLine({ attempts }: { attempts?: number }) {
  const t = useT();
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef(Date.now());
  const [tickEpoch, setTickEpoch] = useState(0);

  useEffect(() => {
    startedAtRef.current = Date.now();
    setElapsed(0);
    setTickEpoch((e) => e + 1);
  }, [attempts]);

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [tickEpoch]);

  return (
    <>
      {t("degradedRetrying")}
      <span className="degraded-retry-meta" aria-hidden="true">
        {retryLineParts(elapsed, attempts, t)}
      </span>
    </>
  );
}

/** P2-112: first-boot degraded journey (desktop shell). With the local daemon
 * unreachable the old flow stranded a first-time user on the pairing screen —
 * four central surfaces inaccessible, zero feedback. This view never
 * dead-ends: one calm status ("connecting for the first time…", never a red
 * "daemon fell" for a daemon the machine never met), a visible auto-retry
 * line with the attempt counter, a reconnect action with real feedback, the
 * purely-local data that keeps working, and manual pairing one click away. */
export default function DegradedView({ kind, busy, reconnectAttempts, reconnect, onPairManually, upstream, onOpenHelp, sidecarExit, sidecarWedge }: Props) {
  const t = useT();
  const [lang, setLangState] = useState<Lang>(getLang());
  const [theme, setThemeState] = useState<ThemeChoice>(storedTheme);

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
  // P2-324: one calm band for both shell verdicts — the exit notice wins when
  // both exist (a dead daemon is the stronger story than a wedged one being
  // revived). Same classes, same tone, no new clickable target.
  const verdictBand = sidecarExit ?? sidecarWedge;

  return (
    <div className="screen degraded" data-degraded-kind={busy ? "connecting" : kind}>
      <header>
        {/* P3-373: same glyph language as the welcome wizard — the first
            three screens of the journey share one brand header. */}
        <div className="welcome-mark" aria-hidden="true">
          ✻
        </div>
        <h1 className="brand-wordmark">OpenCode Remote</h1>
      </header>
      <div className="degraded-status">
        <span className={`degraded-dot${kind === "down" ? " err" : ""}`} aria-hidden="true" />
        <div>
          <h2>{title}</h2>
          <p className="muted">{hint}</p>
        </div>
      </div>
      {verdictBand && (
        <div className="degraded-exit" role="note">
          <p className="degraded-exit-title">{t(verdictBand.titleKey)}</p>
          <p className="degraded-exit-action">{t(verdictBand.actionKey)}</p>
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
          <RetryLine attempts={reconnectAttempts} />
        </p>
      )}
      <div className="degraded-actions">
        <ReconnectButton className="degraded-reconnect-btn" reconnect={reconnect} />
      </div>
      <div className="degraded-local">
        <h3>{t("degradedLocalTitle")}</h3>
        <p className="muted">{t("degradedLocalHint")}</p>
        <div className="degraded-local-controls">
          <select
            aria-label={t("language")}
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
          <select
            aria-label={t("themeLabel")}
            value={theme}
            onChange={(e) => {
              const next = e.target.value as ThemeChoice;
              setThemeState(next);
              try {
                localStorage.setItem(THEME_KEY, next);
              } catch {}
              applyTheme();
            }}
          >
            <option value="system">{t("themeSystem")}</option>
            <option value="dark">{t("themeDark")}</option>
            <option value="light">{t("themeLight")}</option>
          </select>
        </div>
      </div>
      {/* P3-364: the offline card above is what works NOW; this is what
          pairing unlocks — the standing map the gate toast only flashes. */}
      <PaneMap />
      <button className="degraded-manual" onClick={onPairManually}>
        {t("degradedPairManually")}
      </button>
    </div>
  );
}
