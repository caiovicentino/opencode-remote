// humanized error mapping: turn raw protocol/network errors into messages a
// human can act on. Falls back to the original string when nothing matches.

type TFn = (key: string, vars?: Record<string, string | number>) => string;

/**
 * P3-375: thrown by the shell's request() while no client is live (first
 * boot, machine switch) — an EXPECTED state, not a failure. Surfaces branch
 * on the class identity via isNotConnected(), never on the message prose: if
 * the wording ever changes, the calm offline states must not silently revert
 * to red error lines.
 */
export class NotConnected extends Error {
  constructor() {
    super("not connected");
    this.name = "NotConnected";
  }
}

export function isNotConnected(err: unknown): boolean {
  return err instanceof NotConnected;
}

const FALLBACK: TFn = (k, v) => {
  const en: Record<string, string> = {
    errAgentCrashed: "The agent crashed mid-answer — it usually comes back on retry.",
    errAttachmentExpired: "Attachment expired — reattach it and send again.",
    errConversationGone: "This conversation no longer exists on the machine.",
    errRefused: "The agent refused the request (HTTP {status}).",
    errConnectionLost: "Connection lost — your message is queued and will go out automatically.",
    errNotPaired: "Not paired yet — reopen the app or pair again.",
    errCreateFailed: "Could not create the conversation — try again.",
    errAgentFailed: "The agent stopped with an error: {message}",
    errAgentFailedGeneric: "The agent stopped with an error — try again.",
  };
  let s = en[k] ?? k;
  if (v) for (const [k2, v2] of Object.entries(v)) s = s.replace(`{${k2}}`, String(v2));
  return s;
};

/**
 * eval-10: readable message of an opencode `session.error` payload. The
 * provider error arrives as `{ error: { name, data: { message } } }` — an
 * OBJECT. The old path stringified the whole payload, cut it at 200 chars and
 * returned the parsed `error` object as the "message": React threw minified
 * error #31 and the whole app fell into "Something broke" (short payloads),
 * or the chat painted a raw JSON fragment in red (long ones). Always a plain
 * one-line string, "" when nothing readable exists, capped at `max` chars.
 */
export function agentErrorMessage(props: unknown, max = 300): string {
  const e = (props && typeof props === "object" ? (props as { error?: unknown }).error : undefined) as
    | string
    | { name?: unknown; message?: unknown; data?: unknown }
    | undefined;
  let msg = "";
  if (typeof e === "string") {
    msg = e;
  } else if (e && typeof e === "object") {
    const data = e.data as { message?: unknown } | undefined;
    if (data && typeof data === "object" && typeof data.message === "string") msg = data.message;
    else if (typeof e.message === "string") msg = e.message;
    else if (typeof e.name === "string") msg = e.name;
  }
  msg = msg.replace(/\s+/g, " ").trim();
  return msg.length > max ? `${msg.slice(0, max - 1)}…` : msg;
}

/** eval-10: the `agent error:` payload → localized copy, never a non-string. */
function agentErrorCopy(payload: string, tr: TFn): string {
  let msg = "";
  try {
    const parsed = JSON.parse(payload) as { message?: unknown } | null;
    msg = agentErrorMessage(parsed) || agentErrorMessage({ error: parsed?.message });
  } catch {
    // legacy producers cut the JSON mid-way — salvage the message field,
    // never paint the fragment itself
    const quoted = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(payload)?.[1];
    const plain = payload.trim();
    msg = quoted ?? (plain.startsWith("{") ? "" : plain);
    msg = msg.replace(/\s+/g, " ").trim().slice(0, 300);
  }
  return msg ? tr("errAgentFailed", { message: msg }) : tr("errAgentFailedGeneric");
}

export function humanizeError(raw: string, t?: TFn): string {
  const tr = t ?? FALLBACK;
  // eval-10: agent-side errors first — the provider's own message may carry
  // words ("network", "offline") the transport patterns below would misread
  // as a queued message
  if (raw.startsWith("agent error:")) return agentErrorCopy(raw.slice("agent error:".length), tr);
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
  return raw;
}
