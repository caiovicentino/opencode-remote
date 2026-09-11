import { useEffect, useRef, useState } from "react";
import { useT, setLang, getLang, type Lang } from "../lib/i18n";
// P3-368: the offline card's copy promises "language and theme" — the theme
// control ships here too, reading and persisting through the shared lib/theme
// helpers (same ocr_theme key + applyTheme() path as the Settings card).
import { applyTheme, readTheme, THEME_KEY, type ThemeChoice } from "../lib/theme";
import { escalationMinutes, escalateDetailKey, retryLineParts, shouldEscalateRetry, ESCALATE_HATCH_KEY, RETRY_ESCALATE_AFTER_SEC } from "../lib/degraded";
import type { DegradedKind, SidecarExitNotice, SidecarWedgeNotice, UpstreamNotice } from "../lib/degraded";
// P3-360: the offline first-message queue — text typed here is saved on this
// machine (localStorage via lib/gatequeue) and becomes the first message of
// the first conversation once the daemon answers (App consumes the queue on
// "paired", reusing the home composer's send-on-open flow).
import { readGateQueue, writeGateQueue } from "../lib/gatequeue";
import { clampComposerHeight } from "../lib/composer";
import ReconnectButton from "./ReconnectButton";
import UpstreamMissingActions from "./UpstreamMissingActions";
import PaneMap from "./PaneMap";

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
  /** P2-138: secondary action — opens the Settings help section. P3-363: the
   * shell passes it unconditionally now so the escalation block can offer the
   * real diagnostics path too (the upstream block still gates its own button
   * on an existing notice). */
  onOpenHelp?: () => void;
  /** P2-140: why the local daemon died (exit classifier verdict), rendered
   * INSIDE this calm card — never a second banner (P2-108 rule). */
  sidecarExit?: SidecarExitNotice | null;
  /** P2-324: the local daemon wedged alive (wedge probe verdict), rendered in
   * the SAME calm band as the exit notice below. Precedence is documented:
   * when both verdicts exist at once the exit notice wins — a daemon that
   * actually died is the stronger story than one being revived. */
  sidecarWedge?: SidecarWedgeNotice | null;
  /** P3-365: the hero sits inside the first-boot shell skeleton whose rail
   * already opens Artifacts/Browser/Mission — the pane map then retitles to
   * "before pairing" and keeps the lock glyph only on Conversations. The
   * classic centered screen (narrow window, stored-pairing errors) keeps the
   * fully locked map. */
  panesReachable?: boolean;
  /** P3-394: which surface renders the card — the App passes the same verdict
   * it already computes for the install hint (desktopBridge() !== null). It
   * picks the escalation detail: the desktop points at the adjacent in-app
   * diagnostics button; the phone points back to the computer itself. */
  desktopShell?: boolean;
  /** P3-392: re-runs the shell's pairing tick for the missing-binary
   * "check again" action (app:recheckWebApp). Absent in the plain browser. */
  onRecheck?: () => void;
  /** P3-406: the quick entry's focus request — App bumps the counter, the
   * offline first-message queue box takes the focus (never a focus steal on
   * the pairing ceremony: the gate is the only surface that answers). */
  focusQueueTick?: number;
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

/** P3-363: the escalation block the card earns after a minute of silent
 * retrying (shouldEscalateRetry) — the counter keeps accumulating across
 * attempts while the auto-retry line is visible and pauses when it is not
 * (busy connect in flight, "down" already has its own copy). P3-333's lesson
 * applied: the interval effect arms on [autoRetry] itself and the tick
 * increments functionally, so a re-arm can never leave a stale cleared timer
 * nor double-count; the total is deliberately never zeroed — sustained
 * failure stays escalated for the life of the mount. P3-385: the block is
 * also where the manual reconnect action lives once escalation fires — the
 * standalone orange button that used to stack right below is suppressed, so
 * the column keeps ONE calm recovery path; the retry returns demoted to a
 * quiet text link beside the diagnostics button (same feedback contract as
 * the old button: trying state, spinner, result toast). */
function EscalationBlock({ totalSec, onOpenHelp, reconnect, desktopShell }: { totalSec: number; onOpenHelp?: () => void; reconnect?: () => Promise<boolean>; desktopShell?: boolean }) {
  const t = useT();
  return (
    <div className="degraded-escalate" role="note">
      <p className="degraded-escalate-title">
        {t("degradedEscalateTitle", { m: escalationMinutes(totalSec) })}
      </p>
      {/* P3-394: the detail follows the surface — desktop names the in-app
          diagnostics button right below, the phone points back to the
          computer. No terminal command on either. */}
      <p className="degraded-escalate-detail">{t(escalateDetailKey(!!desktopShell))}</p>
      {(onOpenHelp || reconnect) && (
        <div className="degraded-escalate-actions">
          {onOpenHelp && (
            <button className="degraded-upstream-help" onClick={onOpenHelp}>
              {t("degradedEscalateDiagnostics")}
            </button>
          )}
          {reconnect && <ReconnectButton className="degraded-reconnect-link" reconnect={reconnect} />}
        </div>
      )}
    </div>
  );
}

/** P2-112: first-boot degraded journey (desktop shell). With the local daemon
 * unreachable the old flow stranded a first-time user on the pairing screen —
 * four central surfaces inaccessible, zero feedback. This view never
 * dead-ends: one calm status ("connecting for the first time…", never a red
 * "daemon fell" for a daemon the machine never met), a visible auto-retry
 * line with the attempt counter, a reconnect action with real feedback, the
 * purely-local data that keeps working, and manual pairing one click away. */
export default function DegradedView({ kind, busy, reconnectAttempts, reconnect, onPairManually, upstream, onOpenHelp, sidecarExit, sidecarWedge, panesReachable, desktopShell, onRecheck, focusQueueTick }: Props) {
  const t = useT();
  const [lang, setLangState] = useState<Lang>(getLang());
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme);

  // P3-360: the offline first-message queue. Seeded from what is already
  // saved (a restart while the daemon is still down must show the queued
  // text, not swallow it) — editing again re-arms Save and hides the
  // confirmation until the new text is persisted.
  const [queueText, setQueueText] = useState(() => readGateQueue(localStorage));
  const [queueSaved, setQueueSaved] = useState(() => !!readGateQueue(localStorage));
  const queueRef = useRef<HTMLTextAreaElement>(null);
  // P3-406: quick-entry focus — fires on the bump, and on a mount that
  // already carries a pending bump (same contract as ChatView's composer).
  const lastQueueFocusTick = useRef(0);
  useEffect(() => {
    if (!focusQueueTick || focusQueueTick === lastQueueFocusTick.current) return;
    lastQueueFocusTick.current = focusQueueTick;
    queueRef.current?.focus();
  }, [focusQueueTick]);
  // Same auto-grow contract as the home composer: grows with content up to
  // the shared 6-line cap, then scrolls internally.
  useEffect(() => {
    const el = queueRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 20;
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    el.style.height = "auto";
    el.style.height = `${clampComposerHeight(el.scrollHeight, lh, padY)}px`;
  }, [queueText]);

  function saveQueue() {
    const clean = writeGateQueue(queueText, localStorage);
    setQueueText(clean);
    setQueueSaved(!!clean);
  }


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
  // P3-363: cumulative seconds spent auto-retrying on this mount, and the
  // escalation it unlocks — the "silent forever loop" gets a diagnostic path.
  // P3-394: documented test hatch (ESCALATE_HATCH_KEY + reload, desktop-flow
  // gate) — mounts the card already escalated, no 60s wait. Same policy as
  // the other test-only hatches: read once at mount, persists nothing.
  const [retryTotal, setRetryTotal] = useState(() => {
    try {
      return localStorage.getItem(ESCALATE_HATCH_KEY) === "1" ? RETRY_ESCALATE_AFTER_SEC : 0;
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    if (!autoRetry) return;
    const id = setInterval(() => setRetryTotal((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [autoRetry]);
  const escalated = autoRetry && shouldEscalateRetry(retryTotal);
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
          {/* P3-392: the binary-missing verdict carries the whole install
              journey — copy the official command, open the official steps,
              re-check. Only rendered for the desktop-shell notice (the
              upstreamNotice resolution already guarantees it: on the phone
              missingBinary stays false and today's copy is unchanged). */}
          {upstream.missingBinary && <UpstreamMissingActions onRecheck={onRecheck} />}
        </div>
      )}
      {autoRetry && (
        <p className="degraded-retry" role="status">
          <RetryLine attempts={reconnectAttempts} />
        </p>
      )}
      {/* P3-385: once escalated the escalation block owns the recovery path —
          the standalone orange reconnect button folds into it (demoted to a
          text link) so two same-weight CTAs never stack in one column. */}
      {escalated ? (
        <EscalationBlock totalSec={retryTotal} onOpenHelp={onOpenHelp} reconnect={reconnect} desktopShell={desktopShell} />
      ) : (
        <div className="degraded-actions">
          <ReconnectButton className="degraded-reconnect-btn" reconnect={reconnect} />
        </div>
      )}
      {/* P3-360: the offline first-message queue — the core chat surface,
          reachable on the very first boot. Enter submits (Shift+Enter is a
          newline), same composer grammar as the home. */}
      <div className="degraded-queue">
        <h3>{t("degradedQueueTitle")}</h3>
        <p className="muted">{t("degradedQueueHint")}</p>
        <textarea
          ref={queueRef}
          className="degraded-queue-input"
          rows={2}
          aria-label={t("degradedQueueTitle")}
          placeholder={t("degradedQueuePlaceholder")}
          value={queueText}
          onChange={(e) => {
            setQueueText(e.target.value);
            setQueueSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              saveQueue();
            }
          }}
        />
        <div className="degraded-queue-row">
          {queueSaved && (
            <span className="degraded-queue-saved" role="status">
              {t("degradedQueueSaved")}
            </span>
          )}
          <button className="degraded-queue-save" onClick={saveQueue} disabled={!queueText.trim()}>
            {t("degradedQueueSave")}
          </button>
        </div>
      </div>
      <div className="degraded-local">
        <h3>{t("degradedLocalTitle")}</h3>
        <p className="muted">{t("degradedLocalHint")}</p>
        <div className="degraded-local-prefs">
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
          pairing unlocks — the standing map the gate toast only flashes.
          P3-365: inside the shell skeleton three of those panes are already
          one rail-click away, so the map drops their locks. */}
      <PaneMap reachable={panesReachable} />
      <button className="degraded-manual" onClick={onPairManually}>
        {t("degradedPairManually")}
      </button>
    </div>
  );
}
