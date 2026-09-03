// P2-090: artifact auto-open — client side of the daemon's synthetic
// `session.artifact` event. The daemon announces every agent write to
// ~/.opencode-remote/artifacts/<sessionId>/ (P1-068 layout); when the turn
// goes idle, ChatView opens the P2-062 split-pane on the newest artifact —
// unless the user is already viewing one manually or the browser pane (P1-072)
// is up. Pure helpers here so the pairing/deprioritisation rules stay testable
// (same pattern as lib/preview.ts).

import type { ArtifactKind } from "./artifacts";

export interface ArtifactAutoState {
  /** newest artifact name written since the last consumed idle */
  pending: string | null;
}

/**
 * Consume one batch of new event envelopes for `sessionId` (in order):
 * a `session.artifact` arms `state.pending` with its name; the next
 * `session.idle` for the same session consumes it and is returned as the
 * artifact to auto-open (null when no write preceded the idle). Events from
 * other sessions never interfere. Mutates `state` so callers can keep it in
 * a ref across effect runs; the last open wins when several idles arrive in
 * one batch.
 */
export function consumeArtifactEvents(
  evs: { type: string; properties?: unknown }[],
  sessionId: string,
  state: ArtifactAutoState,
): { open: string | null } {
  let open: string | null = null;
  for (const evt of evs) {
    const p = (evt.properties ?? {}) as { sessionID?: string; name?: string };
    if (p.sessionID !== sessionId) continue;
    if (evt.type === "session.artifact" && p.name) {
      state.pending = p.name;
    } else if (evt.type === "session.idle" && state.pending) {
      open = state.pending;
      state.pending = null;
    }
  }
  return { open };
}

/** Mirror of the daemon's kindFor (apps/daemon/src/artifacts.ts) — used when
 * an older daemon announces an artifact without a `kind` property. */
export function artifactKindFor(name: string): ArtifactKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "csv") return "csv";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext)) return "image";
  if (["txt", "json", "log", "xml", "yml", "yaml", "toml", "tsv"].includes(ext)) return "text";
  return "binary";
}
