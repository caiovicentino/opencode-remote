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
 * P3-422: on the first-boot shell skeleton the rail already lists these five
 * items verbatim, so the reachable variant condenses to a single quiet note
 * ("Conversas pede pareamento; o resto já abre ao lado") — the full card
 * beside the rail read as double navigation on one screen. The manual
 * ceremony (PairingView) keeps the full map.
 *
 * P3-413: the padlock is the chat's alone, everywhere. The explorer's journey
 * shot caught the ceremony's full map locking Artifacts/Browser/Mission
 * Control/Settings one click after the skeleton had opened them unpaired —
 * the lock metaphor understated real offline capability and nudged users to
 * pair before it was needed. Inside the desktop shell (`offlinePanes`) those
 * four panes drop the glyph and the card retitles to "before pairing"; only
 * Conversations keeps its lock (the chat genuinely needs the daemon). The
 * phone — no shell, no offline panes — passes nothing and keeps the fully
 * locked "after pairing" map it always showed.
 *
 * Own class names on purpose: the desktop-flow battery pins the ceremony's
 * `.pair-section` count and `.pair-section-title` order (P2-106/P3-334) —
 * reusing them here would read as a third pairing section (P3-334 lesson). */
export default function PaneMap({ reachable = false, offlinePanes = false }: { reachable?: boolean; offlinePanes?: boolean }) {
  const t = useT();
  const titleKey = offlinePanes ? "paneMapTitleBefore" : "paneMapTitle";
  const panes = [
    { icon: <IconChat size={14} />, label: t("navConversations"), desc: t("paneMapChat"), locked: true },
    { icon: <IconLayers size={14} />, label: t("navArtifacts"), desc: t("paneMapArtifacts"), locked: !offlinePanes },
    { icon: <IconGlobe size={14} />, label: t("navBrowser"), desc: t("paneMapBrowser"), locked: !offlinePanes },
    { icon: <IconRadar size={14} />, label: t("navMission"), desc: t("paneMapMission"), locked: !offlinePanes },
    { icon: <IconSettings size={14} />, label: t("navSettings"), desc: t("paneMapSettings"), locked: !offlinePanes },
  ];
  return (
    <section className="pane-map" aria-label={t(titleKey)}>
      {reachable ? (
        <p className="pane-map-note">{t("paneMapRailNote")}</p>
      ) : (
        <>
          <h2 className="pane-map-title">{t(titleKey)}</h2>
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
        </>
      )}
    </section>
  );
}
