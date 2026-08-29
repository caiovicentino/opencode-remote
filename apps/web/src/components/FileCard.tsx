import { useState, type ReactElement } from "react";
import { saveFile, type OcrRequest } from "../lib/files";

export default function FileCard({
  path,
  request,
  onError,
}: {
  path: string;
  request: OcrRequest;
  onError?: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const name = path.split("/").pop() ?? path;

  return (
    <div
      className="card"
      style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 10px", margin: "4px 0" }}
    >
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: "0.85rem",
        }}
      >
        {name}
      </span>
      <button
        className="primary"
        disabled={busy}
        style={{ padding: "6px 12px" }}
        onClick={() =>
          void (async () => {
            setBusy(true);
            try {
              await saveFile(request, path);
            } catch (err) {
              onError?.(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          })()
        }
      >
        {busy ? "…" : "Save"}
      </button>
    </div>
  );
}

const FILE_MARKER = /^\[file: (.+)\]$/;

/** Renders a bubble's text, turning [file: path] lines into download cards. */
export function renderBubbleText(
  text: string,
  request: OcrRequest,
  onError?: (msg: string) => void,
): (string | ReactElement)[] {
  return text.split("\n").map((line, i) => {
    const m = FILE_MARKER.exec(line.trim());
    const p = m?.[1];
    return p ? <FileCard key={i} path={p} request={request} onError={onError} /> : line;
  });
}
