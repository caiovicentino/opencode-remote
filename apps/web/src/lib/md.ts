/**
 * Lightweight, dependency-free markdown model for the Artifacts pane (P1-010).
 * Pure data — components map blocks to React nodes without HTML injection.
 */
export type Inline =
  | string
  | { kind: "bold" | "italic" | "code" | "link"; text: string; href?: string };

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3; inline: Inline[] }
  | { type: "para"; inline: Inline[] }
  | { type: "li"; inline: Inline[] }
  | { type: "code"; text: string }
  | { type: "table"; header: string[]; rows: string[][] };

/** only http(s)/mailto — blocks javascript:, data:, vbscript: etc. */
export function safeUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

/** inline spans: **bold**, *italic*, `code`, [label](url), bare URLs */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const regex =
    /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>"]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push({ kind: "bold", text: tok.slice(2, -2) });
    else if (tok.startsWith("`")) out.push({ kind: "code", text: tok.slice(1, -1) });
    else if (tok.startsWith("*")) out.push({ kind: "italic", text: tok.slice(1, -1) });
    else if (tok.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (link && safeUrl(link[2] ?? "")) {
        out.push({ kind: "link", text: link[1] ?? tok, href: link[2] });
      } else {
        out.push(tok); // unsafe scheme — keep as plain text
      }
    } else {
      // bare URL: don't swallow trailing sentence punctuation
      const url = tok.replace(/[.,;:!?)\]]+$/, "");
      out.push({ kind: "link", text: url, href: url });
      if (url.length < tok.length) out.push(tok.slice(url.length));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const FENCE = /^```\w*\s*$/;
const LI = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_SEP = /^\s*\|?[\s:|-]+\|?$/;

/** headings, lists, fenced code, pipe tables and paragraphs */
export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: "para", inline: parseInline(para.join(" ")) });
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (FENCE.test(line.trim())) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test((lines[i] ?? "").trim())) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      blocks.push({ type: "code", text: buf.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = Math.min(3, (h[1] ?? "#").length) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, inline: parseInline(h[2] ?? "") });
      i++;
      continue;
    }
    // pipe table: current line has a | and the next one is a ---|--- separator
    const next = lines[i + 1] ?? "";
    if (line.includes("|") && next.includes("-") && TABLE_SEP.test(next) && next.includes("|")) {
      flush();
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|")) {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const li = LI.exec(line);
    if (li) {
      flush();
      blocks.push({ type: "li", inline: parseInline(li[1] ?? "") });
      i++;
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return blocks;
}
