import { useT } from "../lib/i18n";
import { IconChat, IconGlobe, IconLayers, IconLock, IconRadar } from "./icons";

/** P3-364: the persistent counterpart to the transient gate toast. The Go
 * menu stays enabled at the pairing gate (P3-328), but Artifacts, Browser and
 * Mission Control are invisible until connection — a first-time user had no
 * map of what the product offers after pairing. This quiet card lists the
 * locked panes on the gate screens themselves (manual ceremony + degraded
 * first boot), so "why pair at all?" has a standing answer.
 *
 * Own class names on purpose: the desktop-flow battery pins the ceremony's
 * `.pair-section` count and `.pair-section-title` order (P2-106/P3-334) —
 * reusing them here would read as a third pairing section (P3-334 lesson). */
export default function PaneMap() {
  const t = useT();
  const panes = [
    { icon: <IconChat size={14} />, label: t("navConversations"), desc: t("paneMapChat") },
    { icon: <IconLayers size={14} />, label: t("navArtifacts"), desc: t("paneMapArtifacts") },
    { icon: <IconGlobe size={14} />, label: t("navBrowser"), desc: t("paneMapBrowser") },
    { icon: <IconRadar size={14} />, label: t("navMission"), desc: t("paneMapMission") },
  ];
  return (
    <section className="pane-map" aria-label={t("paneMapTitle")}>
      <h2 className="pane-map-title">{t("paneMapTitle")}</h2>
      <ul className="pane-map-list">
        {panes.map((p) => (
          <li key={p.label} className="pane-map-row">
            <span className="pane-map-icon" aria-hidden="true">
              {p.icon}
            </span>
            <span className="pane-map-copy">
              <b>{p.label}</b>
              <span className="muted">{p.desc}</span>
            </span>
            <IconLock size={12} className="pane-map-lock" aria-hidden="true" />
          </li>
        ))}
      </ul>
    </section>
  );
}
