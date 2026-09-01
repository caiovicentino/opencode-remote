import type { OcrRequest } from "./files";

/** client-side mirror of the daemon's ArtifactMeta (apps/daemon/src/artifacts.ts) */
export type ArtifactKind = "html" | "md" | "csv" | "pdf" | "image" | "text" | "binary";

export interface ArtifactMeta {
  sessionId: string;
  name: string;
  size: number;
  mtime: number;
  kind: ArtifactKind;
}

interface ArtifactContentRaw {
  name: string;
  sessionId: string;
  kind: ArtifactKind;
  mime: string;
  size: number;
  data: string; // base64
}

export type ArtifactContent = ArtifactContentRaw;

/** list artifacts, optionally scoped to one session (E2E tunnel, works everywhere) */
export async function listArtifacts(
  request: OcrRequest,
  sessionId?: string,
): Promise<ArtifactMeta[]> {
  const r = await request(
    "GET",
    "/__ocr/artifacts",
    undefined,
    sessionId ? { session: sessionId } : undefined,
  );
  if (r.status !== 200) return [];
  return (r.body as { artifacts?: ArtifactMeta[] }).artifacts ?? [];
}

/** fetch one artifact's content (base64) through the tunnel; null if missing */
export async function fetchArtifact(
  request: OcrRequest,
  sessionId: string,
  name: string,
): Promise<ArtifactContent | null> {
  const r = await request("GET", "/__ocr/artifact", undefined, { session: sessionId, name });
  if (r.status !== 200) return null;
  return r.body as ArtifactContent;
}

export function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** trigger a native save dialog / download for a blob */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function artifactIcon(kind: ArtifactKind): string {
  switch (kind) {
    case "html":
      return "🌐";
    case "md":
      return "📝";
    case "csv":
      return "📊";
    case "pdf":
      return "📕";
    case "image":
      return "🖼";
    case "text":
      return "📄";
    default:
      return "🗄";
  }
}

export function fmtBytes(n: number): string {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}
