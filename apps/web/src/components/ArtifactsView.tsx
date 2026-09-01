import { useEffect, useState } from "react";
import { fmtBytes, listArtifacts, type ArtifactMeta } from "../lib/artifacts";
import type { OcrRequest } from "../lib/files";
import ArtifactViewer from "./ArtifactViewer";
import { ArtifactIcon } from "./icons";

/**
 * Artifacts pane (P1-010): agent-produced documents written to
 * ~/.opencode-remote/artifacts/<sessionId>/, listed via the daemon.
 */
export default function ArtifactsView({
  request,
  onBack,
}: {
  request: OcrRequest;
  onBack: () => void;
}) {
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [error, setError] = useState("");
  const [viewer, setViewer] = useState<ArtifactMeta | null>(null);

  function load() {
    setError("");
    void (async () => {
      try {
        setArtifacts(await listArtifacts(request));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  useEffect(load, []);

  // group by session (newest first), sessions sorted by their newest artifact
  const groups = new Map<string, ArtifactMeta[]>();
  for (const a of artifacts) {
    const g = groups.get(a.sessionId) ?? [];
    g.push(a);
    groups.set(a.sessionId, g);
  }

  return (
    <div className="screen">
      <header>
        <button onClick={onBack}>←</button>
        <h1 style={{ fontSize: "1rem", margin: 0, flex: 1 }}>Artifacts</h1>
        <button onClick={load} aria-label="Refresh">
          ↻
        </button>
      </header>
      <div className="list">
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {artifacts.length === 0 && !error && (
          <p className="muted">
            No artifacts yet. Ask the agent to produce a document (html, md, csv, pdf) and it will
            show up here.
          </p>
        )}
        {[...groups.entries()].map(([sid, items]) => (
          <div key={sid}>
            <div className="muted" style={{ fontSize: "0.72rem", margin: "10px 4px 4px" }}>
              {sid}
            </div>
            {items.map((a) => (
              <div
                key={`${a.sessionId}/${a.name}`}
                className="card"
                role="button"
                style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", cursor: "pointer" }}
                onClick={() => setViewer(a)}
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
      {viewer && (
        <ArtifactViewer
          meta={viewer}
          request={request}
          onClose={() => {
            setViewer(null);
            load();
          }}
        />
      )}
    </div>
  );
}
