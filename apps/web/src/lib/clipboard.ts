// clipboard copy with a legacy fallback — used by FileCard's "copy path" button.

type ClipboardLike = { writeText?: unknown };
type NavLike = { clipboard?: ClipboardLike } | undefined;

/** true when the async Clipboard API is usable in this context. */
export function hasClipboardApi(nav: NavLike): boolean {
  return typeof nav?.clipboard?.writeText === "function";
}

/** minimal DOM surface legacyCopy needs (lets unit tests run without a real document) */
export interface LegacyDoc {
  createElement(tag: string): {
    value: string;
    setAttribute(name: string, val: string): void;
    style: Record<string, string>;
    select(): void;
  };
  body: { appendChild(node: unknown): void; removeChild(node: unknown): void };
  execCommand(cmd: string): boolean;
}

/** copy via the async Clipboard API, falling back to execCommand on http:// or old WebViews */
export async function copyText(text: string, nav: NavLike = navigator): Promise<boolean> {
  if (hasClipboardApi(nav)) {
    try {
      await (nav!.clipboard!.writeText as (t: string) => Promise<void>)(text);
      return true;
    } catch {
      // permission denied / unsupported — try the legacy path below
    }
  }
  const doc: LegacyDoc | undefined =
    typeof document === "undefined" ? undefined : (document as unknown as LegacyDoc);
  return legacyCopy(text, doc);
}

/** hidden textarea + execCommand("copy") — the fallback for non-secure contexts */
export function legacyCopy(text: string, doc: LegacyDoc | undefined): boolean {
  if (!doc) return false;
  try {
    const ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand("copy");
    doc.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
