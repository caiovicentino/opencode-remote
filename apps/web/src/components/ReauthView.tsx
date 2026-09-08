import { useState } from "react";
import { useT } from "../lib/i18n";
import { IconAlert } from "./icons";

type Props = {
  /** Wipes the local identity and drops the user into the fresh pairing flow. */
  onPairAgain: () => Promise<void>;
};

/**
 * Bug 1: the full-screen card that replaces the silent crypto death. Shown
 * whenever the client reaches the terminal "expired" status (the daemon
 * refused our handshake twice in a row: stale keys after a restart/rekey).
 * ONE action only — wipe this device's identity and pair again. Nothing is
 * wiped before the button is pressed. Tokens only, no emoji, i18n en+pt.
 */
export default function ReauthView({ onPairAgain }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <div className="reauth" role="alertdialog" aria-labelledby="reauth-title" aria-describedby="reauth-body">
      <div className="reauth-card">
        <div className="reauth-icon" aria-hidden>
          <IconAlert size={28} />
        </div>
        <h1 id="reauth-title" className="reauth-title">
          {t("reauthTitle")}
        </h1>
        <p id="reauth-body" className="reauth-body">
          {t("reauthBody")}
        </p>
        <button
          className="primary reauth-action"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onPairAgain().finally(() => setBusy(false));
          }}
        >
          {t("reauthAction")}
        </button>
      </div>
    </div>
  );
}
