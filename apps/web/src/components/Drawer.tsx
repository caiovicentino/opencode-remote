import { useEffect, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { useExitAnimation } from "../lib/motion";
import { DRAWER_ROWS, type DrawerDest, type RecentRow } from "../lib/drawer";
import {
  IconChat,
  IconChevronDown,
  IconFolder,
  IconLayers,
  IconPin,
  IconPlus,
  IconRadar,
  IconSettings,
  IconX,
} from "./icons";

const ROW_ICONS: Record<DrawerDest, ReactNode> = {
  chats: <IconChat size={22} />,
  artifacts: <IconLayers size={22} />,
  mission: <IconRadar size={22} />,
  settings: <IconSettings size={22} />,
  files: <IconFolder size={22} />,
};

type Props = {
  open: boolean;
  onClose: () => void;
  active: DrawerDest | null;
  onNavigate: (dest: DrawerDest) => void;
  recents: RecentRow[];
  onOpenSession: (id: string) => void;
  /** P3-357b: toggle a recent row's pin (next state already computed). */
  onPinToggle: (id: string, pinned: boolean) => void;
  onNewChat: () => void;
  creating: boolean;
  machineName: string;
  connStatus: string;
  onSwitchMachine: () => void;
  onDisconnect: () => void;
};

/**
 * PWA shell (Bug 2): the slide-in navigation drawer that replaces the bottom
 * tab bar. Large icon+label rows (56px), a Recents section (dot + one-line
 * title, ellipsis), the machine footer. Motion: 300ms ease-out slide that
 * the exit hook and the global reduced-motion block both zero out.
 */
export default function Drawer({
  open,
  onClose,
  active,
  onNavigate,
  recents,
  onOpenSession,
  onPinToggle,
  onNewChat,
  creating,
  machineName,
  connStatus,
  onSwitchMachine,
  onDisconnect,
}: Props) {
  const t = useT();
  const phase = useExitAnimation(open, 300);

  // Escape closes; the scrim click too. Body scroll is left alone: the
  // drawer is position:fixed and the page beneath stays inert via the scrim.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (phase === "closed") return null;

  return (
    <div className={`drawer-root${phase === "closing" ? " closing" : ""}`} data-drawer>
      <div className="drawer-scrim" onClick={onClose} aria-hidden />
      <nav className="drawer" role="dialog" aria-modal="true" aria-label={t("drawerOpen")}>
        <div className="drawer-head">
          <button className="drawer-close" onClick={onClose} aria-label={t("drawerClose")}>
            <IconX size={20} />
          </button>
        </div>
        <button
          className="drawer-new"
          disabled={creating}
          onClick={() => {
            onClose();
            onNewChat();
          }}
        >
          <IconPlus size={20} />
          <span>{creating ? t("creating") : t("newConversation").replace(/^\+\s*/, "")}</span>
        </button>
        <ul className="drawer-rows">
          {DRAWER_ROWS.map((row) => (
            <li key={row.id}>
              <button
                className={`drawer-row${active === row.id ? " active" : ""}`}
                data-dest={row.id}
                aria-current={active === row.id ? "page" : undefined}
                onClick={() => {
                  onClose();
                  onNavigate(row.id);
                }}
              >
                <span className="drawer-row-icon" aria-hidden>
                  {ROW_ICONS[row.id]}
                </span>
                <span className="drawer-row-label">{t(row.labelKey)}</span>
              </button>
            </li>
          ))}
        </ul>
        {recents.length > 0 && (
          <div className="drawer-recents">
            <div className="drawer-section">{t("drawerRecents")}</div>
            <ul>
              {recents.map((r) => (
                <li key={r.id} className={r.pinned ? "drawer-recent-item pinned" : "drawer-recent-item"}>
                  <button
                    className={`drawer-recent${r.active ? " active" : ""}`}
                    data-session={r.id}
                    aria-current={r.active ? "true" : undefined}
                    title={r.title}
                    onClick={() => {
                      onClose();
                      onOpenSession(r.id);
                    }}
                  >
                    <span className={`drawer-dot${r.unread ? " unread" : ""}`} aria-hidden />
                    {r.pinned && <IconPin size={12} aria-hidden />}
                    <span className="drawer-recent-title">{r.title}</span>
                  </button>
                  <button
                    className="drawer-recent-pin"
                    aria-label={r.pinned ? t("unpin") : t("pin")}
                    aria-pressed={r.pinned}
                    title={r.pinned ? t("unpin") : t("pin")}
                    onClick={() => onPinToggle(r.id, !r.pinned)}
                  >
                    <IconPin size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="drawer-foot">
          <button className="drawer-machine" onClick={onSwitchMachine} title={t("accountSwitch")}>
            <span
              className={`status-dot${
                connStatus === "paired" ? " ok" : connStatus === "connecting" ? " wait" : " err"
              }`}
              aria-hidden
            />
            <span className="drawer-machine-name">{machineName}</span>
            <IconChevronDown size={12} aria-hidden />
          </button>
          <button className="drawer-disconnect" onClick={onDisconnect}>
            {t("unpair")}
          </button>
        </div>
      </nav>
    </div>
  );
}
