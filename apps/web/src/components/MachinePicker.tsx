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
 * so the mobile header and the sidebar account footer share one markup.
 * EVAL4-F1 (fable r4): the three visible phrases were hardcoded English on
 * a pt-BR phone ("· active", "+ Pair new machine") — they ride the dict now;
 * the machine row is a real button (it was a clickable div: unreachable by
 * keyboard/switch control, unnamed for screen readers). The close button's
 * aria-label stays the literal the desktop-flow gate clicks
 * (scripts/desktop-flow.test.ts:2618) — flip it to the dict once that
 * selector moves to the `.machine-picker-close` hook added here. */
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
      role="dialog"
      aria-label={t("machines")}
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
        <button className="machine-picker-close" onClick={onClose} aria-label="Close machine picker">
          <IconX size={16} />
        </button>
        <div style={{ flex: 1, fontWeight: 600, fontSize: "0.9rem" }}>{t("machines")}</div>
      </div>
      <div className="list" style={{ overflow: "auto" }}>
        {machines.map((m) => {
          const name = m.name ?? m.room.slice(0, 8);
          const active = m.room === activeRoom;
          return (
            <div key={m.room} className="card" style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px" }}>
              <button
                className="machine-picker-row"
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onClose();
                  if (!active) onSwitch(m);
                }}
              >
                <span className="machine-picker-name">
                  {name}
                  {active && <b> · {t("machineActive")}</b>}
                </span>
                <span className="muted machine-picker-relay">{m.relay}</span>
              </button>
              <button className="danger" onClick={() => onForget(m)}>
                {t("forget")}
              </button>
            </div>
          );
        })}
        <button className="primary" onClick={() => { onClose(); onAddMachine(); }}>
          {t("pairNewMachine")}
        </button>
      </div>
    </div>
  );
}
