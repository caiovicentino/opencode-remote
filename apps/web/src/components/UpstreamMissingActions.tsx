import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { INSTALL_DOCS_URL, installCommandFor, UPSTREAM_RECHECK_TIMEOUT_MS } from "../lib/degraded";
import { copyText } from "../lib/clipboard";

interface Props {
  /** Re-runs the shell's pairing tick (app:recheckWebApp) — the next
   * ocr:pairing-state push carries a fresh opencode verdict. Absent in the
   * plain browser (the whole block only renders inside the desktop shell). */
  onRecheck?: () => void;
}

/** P3-392: the install journey for the binary-missing verdict (P2-149 split),
 * rendered ONLY inside the desktop shell — the phone keeps today's copy with
 * no actions. Three real actions, one calm contract:
 *   (a) "copy install command" — the official per-platform one-liner lands on
 *       the clipboard (copyText, the exact path FileCard/SettingsView use);
 *       feedback is a terminal "copied" line, never a spinner;
 *   (b) "open install instructions" — window.open through the shell's
 *       external-open gate (apps/desktop/src/extlink.ts, https passes);
 *   (c) "check again" — re-runs the shell's pairing tick and lands in a
 *       terminal state either way: the block disappears by itself when the
 *       verdict clears (the parent re-renders with a healthy upstream), or
 *       the bounded wait resolves into the "still missing" line (P3-327:
 *       never a permanent spinner). */
export default function UpstreamMissingActions({ onRecheck }: Props) {
  const t = useT();
  // Platform comes from the shell bridge (apps/desktop/src/preload.ts exposes
  // process.platform). The block only mounts inside the desktop shell, so the
  // bridge is present; an empty string falls back to the curl variant.
  const platform = (window as unknown as { ocrDesktop?: { platform?: string } }).ocrDesktop?.platform ?? "";
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [stillMissing, setStillMissing] = useState(false);
  // P3-333's lesson applied verbatim: the wait timer lands in a TERMINAL
  // state via a state bump, and the interval-free timeout re-arms through the
  // tick epoch so a re-check can never leave a stale timer behind.
  const [tickEpoch, setTickEpoch] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!checking) return;
    const id = setTimeout(() => {
      if (mounted.current) {
        setChecking(false);
        setStillMissing(true);
        setTickEpoch((e) => e + 1);
      }
    }, UPSTREAM_RECHECK_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [checking, tickEpoch]);

  return (
    <div className="degraded-upstream-actions">
      <div className="degraded-upstream-actions-row">
        <button
          className="degraded-upstream-help degraded-missing-copy"
          onClick={() => {
            void copyText(installCommandFor(platform)).then((ok) => {
              if (ok) setCopied(true);
            });
          }}
        >
          {t("upstreamMissingCopyCmd")}
        </button>
        <button
          className="degraded-upstream-help degraded-missing-docs"
          onClick={() => {
            // The shell routes window.open through the P2-178 extlink gate
            // (https passes) — the same path chat links already use.
            window.open(INSTALL_DOCS_URL, "_blank", "noopener");
          }}
        >
          {t("upstreamMissingOpenDocs")}
        </button>
        {onRecheck && (
          <button
            className="degraded-upstream-help degraded-missing-recheck"
            disabled={checking}
            onClick={() => {
              setStillMissing(false);
              setChecking(true);
              onRecheck();
            }}
          >
            {checking ? t("upstreamMissingChecking") : t("upstreamMissingRecheck")}
          </button>
        )}
      </div>
      {copied && (
        <p className="degraded-upstream-copied" role="status">
          {t("upstreamMissingCopied")}
        </p>
      )}
      {stillMissing && !checking && (
        <p className="degraded-upstream-still" role="status">
          {t("upstreamMissingStill")}
        </p>
      )}
    </div>
  );
}
