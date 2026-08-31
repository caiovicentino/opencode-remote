// humanized error mapping: turn raw protocol/network errors into messages a
// human can act on. Falls back to the original string when nothing matches.

type TFn = (key: string, vars?: Record<string, string | number>) => string;

const FALLBACK: TFn = (k, v) => {
  const en: Record<string, string> = {
    errAgentCrashed: "The agent crashed mid-answer — it usually comes back on retry.",
    errAttachmentExpired: "Attachment expired — reattach it and send again.",
    errConversationGone: "This conversation no longer exists on the machine.",
    errRefused: "The agent refused the request (HTTP {status}).",
    errConnectionLost: "Connection lost — your message is queued and will go out automatically.",
    errNotPaired: "Not paired yet — reopen the app or pair again.",
    errCreateFailed: "Could not create the conversation — try again.",
  };
  let s = en[k] ?? k;
  if (v) for (const [k2, v2] of Object.entries(v)) s = s.replace(`{${k2}}`, String(v2));
  return s;
};

export function humanizeError(raw: string, t?: TFn): string {
  const tr = t ?? FALLBACK;
  const status = Number(/opencode responded (\d{3})/.exec(raw)?.[1] ?? 0);
  if (status) {
    if (status === 410) return tr("errAttachmentExpired");
    if (status === 404) return tr("errConversationGone");
    if (status >= 500) return tr("errAgentCrashed");
    return tr("errRefused", { status });
  }
  if (/offline|network|fetch failed|queued/i.test(raw)) return tr("errConnectionLost");
  if (/not connected/i.test(raw)) return tr("errNotPaired");
  if (/create failed/i.test(raw)) return tr("errCreateFailed");
  // agent-side errors arrive as JSON blobs — strip them to the message field
  if (raw.startsWith("agent error:")) {
    try {
      const parsed = JSON.parse(raw.slice("agent error:".length)) as { error?: string; message?: string };
      const inner = parsed.error ?? parsed.message;
      if (inner) return inner;
    } catch {
      return raw.replace("agent error:", "").slice(0, 200) || raw;
    }
  }
  return raw;
}
