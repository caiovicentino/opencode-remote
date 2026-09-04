import { useState } from "react";
import type { Pairing } from "../lib/client";
import { useT } from "../lib/i18n";
import { accountInitial, accountPlanKey } from "../lib/account";
import { IconChevronDown, IconLaptop } from "./icons";
import MachinePicker from "./MachinePicker";

interface Props {
  /** P2-124: local daemon proven (not just assumed) → "Local · this machine". */
  localMode: boolean;
  machineName: string;
  connStatus: string;
  machines: Pairing[];
  activeRoom?: string | null;
  onSwitch: (p: Pairing) => void;
  onForget: (p: Pairing) => void;
  onAddMachine: () => void;
}

/** P2-124: fixed account footer of the desktop sidebar — avatar/initial +
 * machine name + connection-mode plan line, opening the machine picker. */
export default function SidebarAccount({
  localMode,
  machineName,
  connStatus,
  machines,
  activeRoom,
  onSwitch,
  onForget,
  onAddMachine,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // first boot: machineName is still "" — fall back to the room id prefix so
  // the row keeps a label (and its height) without layout shift
  const name = machineName || (activeRoom ? activeRoom.slice(0, 8) : "");
  const initial = accountInitial(machineName);
  return (
    <footer className="desk-account">
      <button
        className="desk-account-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("accountSwitch")}
        onClick={() => setOpen(true)}
      >
        <span className="desk-account-avatar">
          {initial || <IconLaptop size={14} />}
        </span>
        <span className="desk-account-name">{name}</span>
        <span className="desk-account-plan">{t(accountPlanKey(localMode))}</span>
        <span
          className={`status-dot${
            connStatus === "paired" ? " ok" : connStatus === "connecting" ? " wait" : " err"
          }`}
        />
        <IconChevronDown size={14} />
      </button>
      {open && (
        <MachinePicker
          machines={machines}
          activeRoom={activeRoom}
          onSwitch={onSwitch}
          onForget={onForget}
          onAddMachine={onAddMachine}
          onClose={() => setOpen(false)}
        />
      )}
    </footer>
  );
}
