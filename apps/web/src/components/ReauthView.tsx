import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { IconAlert } from "./icons";

export type ReauthVariant = "expired" | "revoked";

type Props = {
  /** EVAL4-F2: "expired" (keys no longer match) or "revoked" (daemon said not-allowed). */
  variant?: ReauthVariant;
  /** Machine the card is about — the copy names it so the user knows WHERE to go. */
  machineName?: string;
  /** EVAL4-F6: primary — forget THIS machine's pairing and re-enter the pairing flow. */
  onPairAgain: () => Promise<void>;
  /** EVAL4-F6: secondary — wipe the device identity + every pairing (the old sole action). */
  onResetDevice?: () => Promise<void>;
};

/**
 * Bug 1: the full-screen card that replaces the silent crypto death. Shown
 * whenever the client reaches a terminal status: "expired" (the daemon
 * refused our handshake twice: stale keys after a restart/rekey) or, since
 * EVAL4-F2, "rejected" (the daemon answered not-allowed: this device was
 * revoked or the pairing was reset). Nothing is wiped before a button is
 * pressed. Tokens only, no emoji, i18n en+pt.
 *
 * EVAL4-F6: the primary action no longer destroys the identity and every
 * other machine's pairing — it forgets only this machine and lands on the
 * pairing flow (the daemon accepts the same identity again on the bootstrap
 * path, so a fresh key buys nothing). The full reset stays as an explained
 * secondary action.
 *
 * EVAL4-A11y: an alertdialog that replaces the whole screen must move focus,
 * or a screen-reader user on the chat never learns the screen changed.
 */
export default function ReauthView({ variant = "expired", machineName, onPairAgain, onResetDevice }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  const name = machineName?.trim() || t("machineFallbackName");
  const title = variant === "revoked" ? t("revokedTitle") : t("reauthTitle");
  const body = variant === "revoked" ? t("revokedBody", { name }) : t("reauthBodyMachine", { name });
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  return (
    <div
      className="reauth"
      role="alertdialog"
      aria-labelledby="reauth-title"
      aria-describedby="reauth-body"
      data-variant={variant}
    >
      <div className="reauth-card">
        <div className="reauth-icon" aria-hidden>
          <IconAlert size={28} />
        </div>
        <h1 id="reauth-title" className="reauth-title" ref={titleRef} tabIndex={-1}>
          {title}
        </h1>
        <p id="reauth-body" className="reauth-body">
          {body}
        </p>
        <button className="primary reauth-action" disabled={busy} onClick={() => run(onPairAgain)}>
          {t("reauthAction")}
        </button>
        <p className="reauth-note muted">{t("reauthKeepsOthers")}</p>
        {onResetDevice && (
          <div className="reauth-secondary">
            <button className="reauth-reset" disabled={busy} onClick={() => run(onResetDevice)}>
              {t("reauthReset")}
            </button>
            <p className="reauth-note muted">{t("reauthResetHint")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
