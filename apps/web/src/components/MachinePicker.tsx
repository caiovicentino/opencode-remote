import type { Pairing } from "../lib/client";
import { useT } from "../lib/i18n";
import { IconX } from "./icons";

interface Props {
  machines: Pairing[];
  activeRoom?: string | null;
  onSwitch: (p: Pairing) => void;
  onForget: (p: Pairing) => void;
  onAddMachine: () => void;
  onClose: () => void;
}

/** P2-124: the machine-switch overlay, extracted verbatim from SessionsView
 * so the mobile header and the sidebar account footer share one markup. */
export default function MachinePicker({
  machines,
  activeRoom,
  onSwitch,
  onForget,
  onAddMachine,
  onClose,
}: Props) {
  const t = useT();
  return (
    <div
      className="machine-picker"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--scrim)",
        zIndex: 70,
        display: "flex",
        flexDirection: "column",
        padding: 12,
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={onClose} aria-label="Close machine picker">
          <IconX size={16} />
        </button>
        <div style={{ flex: 1, fontWeight: 600, fontSize: "0.9rem" }}>{t("machines")}</div>
      </div>
      <div className="list" style={{ overflow: "auto" }}>
        {machines.map((m) => (
          <div key={m.room} className="card" style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px" }}>
            <div
              style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
              onClick={() => {
                onClose();
                if (m.room !== activeRoom) onSwitch(m);
              }}
            >
              <div>
                {m.name ?? m.room.slice(0, 8)}
                {m.room === activeRoom && <b> · active</b>}
              </div>
              <div className="muted" style={{ fontSize: "0.72rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.relay}
              </div>
            </div>
            <button className="danger" onClick={() => onForget(m)}>
              {t("forget")}
            </button>
          </div>
        ))}
        <button className="primary" onClick={() => { onClose(); onAddMachine(); }}>
          + Pair new machine
        </button>
      </div>
    </div>
  );
}
