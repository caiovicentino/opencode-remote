import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import {
  authCommandFor,
  MODEL_DOCS_URL,
  MODEL_RECHECK_TIMEOUT_MS,
  type ModelStatus,
} from "../lib/modelstatus";
import { copyText } from "../lib/clipboard";

interface Props {
  /** The verdict this block belongs to — a fresh object identity after each
   * re-probe is what moves the "check again" wait into a terminal state. */
  status: ModelStatus;
  /** Bumps the composer's probe epoch (useModelStatus re-probes and, when the
   * credential shows up, the whole hint block disappears by itself). */
  onRecheck: () => void;
}

/** P3-396: the credential journey for the model-missing verdicts (no-provider
 * / no-model), rendered ONLY inside the desktop shell — the phone keeps
 * today's daemon sentence with no actions. Three real actions, one calm
 * contract (same shape the P3-392 install journey approved):
 *   (a) "copy login command" — the official `opencode auth login` lands on
 *       the clipboard (copyText, the exact path FileCard/SettingsView use);
 *       feedback is a terminal "copied" line, never a spinner;
 *   (b) "open setup instructions" — window.open through the shell's
 *       external-open gate (apps/desktop/src/extlink.ts, https passes);
 *   (c) "check again" — re-probes the verdict and lands in a terminal state
 *       either way: the block disappears by itself when the verdict clears
 *       (the composer re-renders with a ready machine), or the bounded wait
 *       resolves into the "still not ready" line (P3-327: never a permanent
 *       spinner). */
export default function ModelMissingActions({ status, onRecheck }: Props) {
  const t = useT();
  // Platform comes from the shell bridge (apps/desktop/src/preload.ts exposes
  // process.platform). The block only mounts inside the desktop shell, so the
  // bridge is present; an empty string falls back to the unix variant.
  const platform = (window as unknown as { ocrDesktop?: { platform?: string } }).ocrDesktop?.platform ?? "";
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [still, setStill] = useState(false);
  // P3-333's lesson applied verbatim: the wait timer lands in a TERMINAL
  // state via a state bump, and the interval-free timeout re-arms through the
  // tick epoch so a re-check can never leave a stale timer behind.
  const [tickEpoch, setTickEpoch] = useState(0);
  const mounted = useRef(true);
  // Identity of the last verdict this block observed — a new object while
  // checking means the re-probe answered (any state is terminal: ready
  // unmounts the whole hint via the parent, anything else shows the line).
  const seen = useRef<ModelStatus | null>(null);
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
        setStill(true);
        setTickEpoch((e) => e + 1);
      }
    }, MODEL_RECHECK_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [checking, tickEpoch]);
  useEffect(() => {
    // Record every observed verdict (mount probe included) — only a CHANGE
    // while checking counts as an answered re-probe.
    if (seen.current === status) return;
    seen.current = status;
    if (!checking) return;
    setChecking(false);
    // ready never gets here visibly — the parent unmounts the whole hint —
    // but stay terminal either way: no spinner survives an answered probe.
    if (status.state !== "ready") setStill(true);
  }, [status, checking]);

  return (
    <div className="model-hint-actions">
      <div className="model-hint-actions-row">
        <button
          className="degraded-upstream-help model-missing-copy"
          onClick={() => {
            void copyText(authCommandFor(platform)).then((ok) => {
              if (ok) setCopied(true);
            });
          }}
        >
          {t("modelMissingCopyCmd")}
        </button>
        <button
          className="degraded-upstream-help model-missing-docs"
          onClick={() => {
            // The shell routes window.open through the P2-178 extlink gate
            // (https passes) — the same path chat links already use.
            window.open(MODEL_DOCS_URL, "_blank", "noopener");
          }}
        >
          {t("modelMissingOpenDocs")}
        </button>
        <button
          className="degraded-upstream-help model-missing-recheck"
          disabled={checking}
          onClick={() => {
            setStill(false);
            setChecking(true);
            onRecheck();
          }}
        >
          {checking ? t("modelMissingChecking") : t("modelMissingRecheck")}
        </button>
      </div>
      {copied && (
        <p className="model-hint-copied" role="status">
          {t("modelMissingCopied")}
        </p>
      )}
      {still && !checking && (
        <p className="model-hint-still" role="status">
          {t("modelMissingStill")}
        </p>
      )}
    </div>
  );
}
