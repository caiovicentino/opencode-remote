/**
 * Artifacts (P1-010): agent-produced documents (html, md, csv, pdf, …) written
 * to ~/.opencode-remote/artifacts/<sessionId>/. The daemon lists them over the
 * E2E tunnel (/__ocr/artifacts) for the PWA/desktop panes and over the local
 * HTTP API (/api/artifacts) for the SDK. Read paths are strictly validated:
 * session ids and file names are single safe path segments, and the resolved
 * absolute path must stay inside ARTIFACTS_ROOT.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ARTIFACTS_ROOT = resolve(homedir(), ".opencode-remote", "artifacts");

export type ArtifactKind = "html" | "md" | "csv" | "pdf" | "image" | "text" | "binary";

export interface ArtifactMeta {
  sessionId: string;
  name: string;
  size: number;
  mtime: number;
  kind: ArtifactKind;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);
const TEXT_EXTS = new Set(["txt", "json", "log", "xml", "yml", "yaml", "toml", "tsv"]);

export function kindFor(name: string): ArtifactKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "csv") return "csv";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  log: "text/plain; charset=utf-8",
  xml: "application/xml",
  yml: "text/yaml",
  yaml: "text/yaml",
};

export function artifactMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/** session ids and file names must be single safe path segments */
export function validSegment(seg: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(seg) && !seg.includes("..");
}

export function listArtifacts(sessionId?: string, root: string = ARTIFACTS_ROOT): ArtifactMeta[] {
  const out: ArtifactMeta[] = [];
  let sessions: string[];
  try {
    sessions = readdirSync(root);
  } catch {
    return out;
  }
  for (const sid of sessions) {
    if (!validSegment(sid)) continue;
    if (sessionId && sid !== sessionId) continue;
    let files: string[] = [];
    try {
      files = readdirSync(join(root, sid));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!validSegment(name)) continue;
      try {
        const st = statSync(join(root, sid, name));
        if (!st.isFile()) continue;
        out.push({ sessionId: sid, name, size: st.size, mtime: st.mtimeMs, kind: kindFor(name) });
      } catch {}
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Returns the artifact bytes, or null when ids are invalid / file is missing. */
export function readArtifact(
  sessionId: string,
  name: string,
  root: string = ARTIFACTS_ROOT,
): Buffer | null {
  if (!validSegment(sessionId) || !validSegment(name)) return null;
  const base = resolve(root);
  const abs = resolve(base, sessionId, name);
  if (!abs.startsWith(base + "/")) return null; // defense in depth
  try {
    return readFileSync(abs);
  } catch {
    return null;
  }
}
