import { useEffect, useRef, useState } from "react";
import {
  fmtBytes,
  listArtifactsDetailed,
  type ArtifactListing,
  type ArtifactMeta,
} from "../lib/artifacts";
import { isSplitViewport } from "../lib/split";
import { useExitAnimation } from "../lib/motion";
import { humanizeError } from "../lib/errors";
import type { OcrRequest } from "../lib/files";
import ArtifactViewer from "./ArtifactViewer";
import { ArtifactIcon } from "./icons";
import { useT } from "../lib/i18n";

/**
 * Artifacts pane (P1-010): agent-produced documents written to
 * ~/.opencode-remote/artifacts/<sessionId>/, listed via the daemon.
 * P2-091: groups carry the conversation title (daemon-resolved) and, on wide
 * viewports, clicking an item jumps back to Conversas with the artifact in
 * the side-by-side pane — the full-screen overlay stays narrow-only.
 */
export default function ArtifactsView({
  request,
  onBack,
  onOpenInChat,
}: {
  request: OcrRequest;
  onBack: () => void;
  /** P2-091: open the artifact beside the chat (wide viewports only). */
  onOpenInChat?: (a: ArtifactMeta) => void;
}) {
  // EVAL4-B: every string here was hardcoded English — the pt phone showed
  // "Artifacts / Refresh / No artifacts yet…" (shot 04-b1-artifacts-empty).
  const t = useT();
  const [listing, setListing] = useState<ArtifactListing>({ artifacts: [], titles: {} });
  const [error, setError] = useState("");
  const [viewer, setViewer] = useState<ArtifactMeta | null>(null);
  // P3-087: the overlay slides out before unmounting — keep the last meta
  // so the exit animation has content to render
  const lastViewerRef = useRef<ArtifactMeta | null>(null);
  if (viewer) lastViewerRef.current = viewer;
  const viewerPhase = useExitAnimation(!!viewer);
  const shownViewer = viewer ?? (viewerPhase !== "closed" ? lastViewerRef.current : null);

  function load() {
    setError("");
    void (async () => {
      try {
        setListing(await listArtifactsDetailed(request));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  useEffect(load, []);

  const { artifacts, titles } = listing;

  // group by session (newest first), sessions sorted by their newest artifact
  const groups = new Map<string, ArtifactMeta[]>();
  for (const a of artifacts) {
    const g = groups.get(a.sessionId) ?? [];
    g.push(a);
    groups.set(a.sessionId, g);
  }

  function open(a: ArtifactMeta) {
    // wide: straight into the chat's side-by-side pane — no full-screen detour
    if (onOpenInChat && isSplitViewport(window.innerWidth)) onOpenInChat(a);
    else setViewer(a);
  }

  return (
    <div className="screen">
      <header>
        <button onClick={onBack} aria-label={t("back")}>←</button>
        <h1 style={{ fontSize: "1rem", margin: 0, flex: 1, minWidth: 0 }}>{t("artifactsTitle")}</h1>
        <button onClick={load} aria-label={t("artifactsRefresh")} title={t("artifactsRefresh")}>
          ↻
        </button>
      </header>
      <div className="list">
        {/* P3-365: the pane is reachable from the unpaired gate shell — a
            "not connected" raw throw becomes the humanized not-paired copy. */}
        {error && <p className="artifacts-error" style={{ color: "var(--danger)" }}>{humanizeError(error, t)}</p>}
        {artifacts.length === 0 && !error && (
          <p className="muted">{t("artifactsEmpty")}</p>
        )}
        {[...groups.entries()].map(([sid, items]) => (
          <div key={sid}>
            <div className="muted artifact-group" style={{ fontSize: "0.72rem", margin: "10px 4px 4px" }}>
              {titles[sid] ?? sid}
            </div>
            {items.map((a) => (
              <div
                key={`${a.sessionId}/${a.name}`}
                className="card artifact-row"
                role="button"
                style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", cursor: "pointer" }}
                onClick={() => open(a)}
              >
                <span aria-hidden className="artifact-icon">
                  <ArtifactIcon kind={a.kind} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.name}
                  </div>
                  <div className="muted" style={{ fontSize: "0.72rem" }}>
                    {a.kind} · {fmtBytes(a.size)} · {new Date(a.mtime).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {shownViewer && viewerPhase !== "closed" && (
        <ArtifactViewer
          meta={shownViewer}
          request={request}
          closing={viewerPhase === "closing"}
          onClose={() => {
            setViewer(null);
            load();
          }}
        />
      )}
    </div>
  );
}
