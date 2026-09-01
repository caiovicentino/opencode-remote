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
  // the click only starts the download — revoke later so it never breaks mid-flight
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/** artifacts whose file name appears in the message text (ChatView cards) */
export function artifactMentions(text: string, list: ArtifactMeta[]): ArtifactMeta[] {
  if (!text || list.length === 0) return [];
  return list.filter((a) => text.includes(a.name));
}
