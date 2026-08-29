export type OcrRequest = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

export function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    xls: "application/vnd.ms-excel",
    txt: "text/plain",
    md: "text/markdown",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    zip: "application/zip",
    json: "application/json",
    mp4: "video/mp4",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
  };
  return map[ext] ?? "application/octet-stream";
}

function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function downloadFile(request: OcrRequest, path: string): Promise<File> {
  const start = await request("POST", "/__ocr/download/start", { path });
  if (start.status !== 200) {
    throw new Error(String((start.body as { error?: string }).error ?? "download denied"));
  }
  const { id, chunks } = start.body as { id: string; chunks: number };
  const parts: BlobPart[] = [];
  for (let i = 0; i < chunks; i++) {
    const r = await request("GET", "/__ocr/download/chunk", undefined, { id, idx: String(i) });
    if (r.status !== 200) {
      throw new Error(String((r.body as { error?: string }).error ?? "download failed"));
    }
    parts.push(bytesFromB64((r.body as { data: string }).data) as unknown as BlobPart);
  }
  const name = path.split("/").pop() ?? "file";
  return new File([new Blob(parts)], name, { type: mimeFor(name) });
}

/** Save to the phone: native share sheet (iOS Files) or a download anchor. */
export async function saveFile(request: OcrRequest, path: string): Promise<void> {
  const file = await downloadFile(request, path);
  const nav = navigator as Navigator & {
    canShare?: (d: ShareData) => boolean;
    share?: (d: ShareData) => Promise<void>;
  };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    await nav.share({ files: [file], title: file.name });
  } else {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  }
}
