// Approval card preview (P2-004): extract the first lines of the
// command/patch a permission ask refers to, straight from the event payload
// opencode already ships (metadata.command for shell, metadata.diff for
// edit/write, pattern(s) for everything else).

const PREVIEW_LINES = 3;
const PREVIEW_LINE_MAX = 120;

function previewLines(text: string): string {
  return text
    .split("\n")
    .slice(0, PREVIEW_LINES)
    .map((l) => {
      const t = l.replace(/\s+$/, "");
      return t.length > PREVIEW_LINE_MAX ? `${t.slice(0, PREVIEW_LINE_MAX - 1)}…` : t;
    })
    .join("\n");
}

/** First lines of the command/patch behind a permission ask, if the payload has one. */
export function permissionPreview(props: unknown): string | undefined {
  if (!props || typeof props !== "object") return undefined;
  const p = props as {
    metadata?: unknown;
    pattern?: unknown;
    patterns?: unknown;
  };
  const meta = (p.metadata ?? {}) as { command?: unknown; diff?: unknown };
  if (typeof meta.command === "string" && meta.command.trim()) return previewLines(meta.command);
  if (typeof meta.diff === "string" && meta.diff.trim()) return previewLines(meta.diff);
  const pat = p.patterns ?? p.pattern;
  if (typeof pat === "string" && pat.trim()) return previewLines(pat);
  if (Array.isArray(pat)) {
    const list = pat.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (list.length) return previewLines(list.join("\n"));
  }
  return undefined;
}
