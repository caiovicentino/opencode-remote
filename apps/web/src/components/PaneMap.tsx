import { useT } from "../lib/i18n";
import { IconChat, IconGlobe, IconLayers, IconLock, IconRadar, IconSettings } from "./icons";

/** P3-364: the persistent counterpart to the transient gate toast. The Go
 * menu stays enabled at the pairing gate (P3-328), but Artifacts, Browser and
 * Mission Control were invisible until connection — a first-time user had no
 * map of what the product offers after pairing. This quiet card lists the
 * locked panes on the gate screens themselves (manual ceremony + degraded
 * first boot), so "why pair at all?" has a standing answer.
 *
 * P3-365: on the first-boot shell skeleton the rail right next to the hero
 * card already opens Artifacts, Browser and Mission Control — a lock glyph
 * there would contradict the rail (P3-332: a screen contradicting itself is
 * a product bug). With `reachable` the map retitles to "before pairing" and
 * keeps the lock only on Conversations, whose destination genuinely needs
 * the daemon. Default (unreachable) stays the full locked map the manual
 * ceremony shows.
 *
 * P3-389: Settings joins the map — the same gate rail also opens it offline
 * (App's gateSettingsNode, P3-362's GATE_SHELL_PANES), so omitting it
 * under-reported what a first-boot user can actually do. Same rule as the
 * other rail panes: unlocked when reachable, locked in the ceremony.
 *
 * Own class names on purpose: the desktop-flow battery pins the ceremony's
 * `.pair-section` count and `.pair-section-title` order (P2-106/P3-334) —
 * reusing them here would read as a third pairing section (P3-334 lesson). */
export default function PaneMap({ reachable = false }: { reachable?: boolean }) {
  const t = useT();
  const panes = [
    { icon: <IconChat size={14} />, label: t("navConversations"), desc: t("paneMapChat"), locked: true },
    { icon: <IconLayers size={14} />, label: t("navArtifacts"), desc: t("paneMapArtifacts"), locked: !reachable },
    { icon: <IconGlobe size={14} />, label: t("navBrowser"), desc: t("paneMapBrowser"), locked: !reachable },
    { icon: <IconRadar size={14} />, label: t("navMission"), desc: t("paneMapMission"), locked: !reachable },
    { icon: <IconSettings size={14} />, label: t("navSettings"), desc: t("paneMapSettings"), locked: !reachable },
  ];
  return (
    <section className="pane-map" aria-label={t(reachable ? "paneMapTitleBefore" : "paneMapTitle")}>
      <h2 className="pane-map-title">{t(reachable ? "paneMapTitleBefore" : "paneMapTitle")}</h2>
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
            {p.locked && <IconLock size={12} className="pane-map-lock" aria-hidden="true" />}
          </li>
        ))}
      </ul>
    </section>
  );
}
