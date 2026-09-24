import { useEffect, useRef, useState } from "react";
import { useT, setLang, getLang, type Lang } from "../lib/i18n";
// P3-368: the offline card's copy promises "language and theme" — the theme
// control ships here too, reading and persisting through the shared lib/theme
// helpers (same ocr_theme key + applyTheme() path as the Settings card).
import { applyTheme, readTheme, THEME_KEY, type ThemeChoice } from "../lib/theme";
import { shouldEscalateRetry } from "../lib/degraded";
import type { DegradedKind, SidecarExitNotice, SidecarWedgeNotice, StorageVerdictNotice, UpstreamNotice } from "../lib/degraded";
// P3-454: the live retry feedback (line + cumulative clock + escalation
// block) is one contract shared with the welcome wizard's agent step —
// extracted here so the same shell state never renders two retry dialects
// one screen apart.
import { EscalationBlock, RetryLine, useRetryClock } from "./RetryFeedback";
// P3-360: the offline first-message queue — text typed here is saved on this
// machine (localStorage via lib/gatequeue) and becomes the first message of
// the first conversation once the daemon answers (App consumes the queue on
// "paired", reusing the home composer's send-on-open flow).
import { readGateQueue, writeGateQueue } from "../lib/gatequeue";
import { clampComposerHeight } from "../lib/composer";
import ReconnectButton from "./ReconnectButton";
import UpstreamMissingActions from "./UpstreamMissingActions";
import PaneMap from "./PaneMap";
// P3-445: the prefs selects lose the OS chrome (appearance:none) and gain the
// card's control skin; the chevron is drawn by the shared icon set, sitting on
// a wrapper because a <select> is a replaced element (::after never renders).
// P3-429: each select also gains a visible micro-label — the aria-labels alone
// left a first-boot user guessing which field was which.
import { IconChevronDown } from "./icons";

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
  /** P2-346: the app's data folder refused the boot write probe (storage
   * verdict, sanitized to the closed set by lib/degraded). When the state is
   * non-ok the verdict's phrase replaces the patient auto-retry line — a
   * folder that cannot take a write dooms the daemon's own identity, so
   * promising "retrying automatically" there would be a lie. Absent or "ok"
   * keeps today's retry line byte for byte. */
  storage?: StorageVerdictNotice | null;
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
  /** P3-406 r3: called with the consumed tick so App can reset it — a later
   * remount then sees 0 and never steals the caret on plain navigation. */
  onQueueFocusConsumed?: (tick: number) => void;
}

/** P2-112: first-boot degraded journey (desktop shell). With the local daemon
 * unreachable the old flow stranded a first-time user on the pairing screen —
 * four central surfaces inaccessible, zero feedback. This view never
 * dead-ends: one calm status ("connecting for the first time…", never a red
 * "daemon fell" for a daemon the machine never met), a visible auto-retry
 * line with the attempt counter, a reconnect action with real feedback, the
 * purely-local data that keeps working, and manual pairing one click away. */
export default function DegradedView({ kind, busy, reconnectAttempts, reconnect, onPairManually, upstream, onOpenHelp, sidecarExit, sidecarWedge, storage, panesReachable, desktopShell, onRecheck, focusQueueTick, onQueueFocusConsumed }: Props) {
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
  // r3: the consumed tick is reported back and App RESETS it to 0, so a
  // remount never replays an old bump as a focus steal.
  const lastQueueFocusTick = useRef(0);
  useEffect(() => {
    if (!focusQueueTick || focusQueueTick === lastQueueFocusTick.current) return;
    lastQueueFocusTick.current = focusQueueTick;
    queueRef.current?.focus();
    onQueueFocusConsumed?.(focusQueueTick);
  }, [focusQueueTick, onQueueFocusConsumed]);
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
  // P3-454: the clock is the shared useRetryClock contract (same hatch, same
  // arm-on-active interval) the wizard's agent step rides.
  const retryTotal = useRetryClock(autoRetry);
  const escalated = autoRetry && shouldEscalateRetry(retryTotal);
  // P2-324: one calm band for both shell verdicts — the exit notice wins when
  // both exist (a dead daemon is the stronger story than a wedged one being
  // revived). Same classes, same tone, no new clickable target.
  const verdictBand = sidecarExit ?? sidecarWedge;

  return (
    <div className="screen degraded" data-degraded-kind={busy ? "connecting" : kind}>
      <header data-region="brand-header">
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
      {/* P2-346: the verdict's phrase owns the retry slot while the data
          folder refuses writes — only when the auto-retry line would render
          (busy and incident kinds keep their own copy; "ok" and absent keep
          the retry line byte for byte). The phrase is the shell's static
          pt-BR sentence, sanitized to the closed set before it renders. */}
      {autoRetry && storage && storage.state !== "ok" ? (
        <p className="degraded-storage" role="status">
          {storage.message}
        </p>
      ) : autoRetry ? (
        <p className="degraded-retry" role="status">
          <RetryLine attempts={reconnectAttempts} />
        </p>
      ) : null}
      {/* P3-385: once escalated the escalation block owns the recovery path —
          the standalone orange reconnect button folds into it (demoted to a
          text link) so two same-weight CTAs never stack in one column. */}
      {escalated ? (
        <EscalationBlock totalSec={retryTotal} onOpenHelp={onOpenHelp} reconnect={reconnect} desktopShell={desktopShell} />
      ) : (
        <div className="degraded-actions">
          {/* P3-450: the card's one main action wears the shared accent
              primary (`button.primary`) — the same identity the wizard's
              "Começar" wears minutes earlier — instead of a third, one-off
              inverted-fg dialect. P3-371's separation survives: the warn
              tone stays on the dot + retry label, never on the CTA. */}
          <ReconnectButton className="primary degraded-reconnect-btn" reconnect={reconnect} />
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
          {/* P3-429: each control carries a visible micro-label — the
              aria-labels alone left a first-boot user guessing which select
              was Idioma and which was Tema. The label wraps its select (same
              association pattern as the Settings appearance card) and rides
              the same quiet-caps grammar as the pane map below. P3-445: the
              selects wear the same control skin as the card's buttons
              (surface fill, firm resting border, shared radius via the
              global select rule) — appearance:none drops the native macOS
              chrome that leaked system styling into the flat card. The field
              wrapper owns the drawn chevron and the select sizing. */}
          <label className="degraded-select">
            <span className="degraded-select-label">{t("language")}</span>
            <span className="degraded-select-field">
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
              <IconChevronDown size={12} />
            </span>
          </label>
          <label className="degraded-select">
            <span className="degraded-select-label">{t("themeLabel")}</span>
            <span className="degraded-select-field">
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
              <IconChevronDown size={12} />
            </span>
          </label>
        </div>
      </div>
      {/* P3-364: the offline card above is what works NOW; this is what
          pairing unlocks — the standing map the gate toast only flashes.
          P3-365: inside the shell skeleton three of those panes are already
          one rail-click away, so the map drops their locks.
          P3-413: the desktop shell never shows the four padlocks — offline
          panes are real here (rail/Go menu), so only the chat stays locked
          even on the classic centered screen. */}
      <PaneMap reachable={panesReachable} offlinePanes={desktopShell} />
      <button className="degraded-manual" onClick={onPairManually}>
        {t("degradedPairManually")}
      </button>
    </div>
  );
}
