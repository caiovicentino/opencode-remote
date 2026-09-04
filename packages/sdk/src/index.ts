/**
 * opencode-remote SDK — drive a running daemon from code.
 *
 * Works against the daemon's local API (127.0.0.1:8792, Bearer token from
 * `~/.opencode-remote/daemon.json` → apiToken or `opencode-remote token`).
 *
 *   const ocr = createClient({ token: process.env.OCR_TOKEN });
 *   const { id } = await ocr.createSession("code review");
 *   const reply = await ocr.sendAndWait(id, "explain the auth module");
 *   console.log(reply);
 */

export interface OcrClientOptions {
  /** daemon base URL (default http://127.0.0.1:8792) */
  baseUrl?: string;
  /** API token — apiToken field of ~/.opencode-remote/daemon.json */
  token: string;
  /** fetch override (tests, proxies) */
  fetchImpl?: typeof fetch;
}

export interface SessionInfo {
  id: string;
  title?: string;
  directory?: string;
  [k: string]: unknown;
}

export interface HistoryRow {
  info: { id?: string; role?: string };
  parts: { type: string; text?: string; tool?: string; state?: { status?: string; title?: string; output?: string } }[];
}

export interface Health {
  healthy: boolean;
  version: string;
  machine: string;
  opencodeHealthy: boolean;
  /** P2-135: detail of the last agent-server probe; additive — older daemons omit it. */
  opencode?: {
    state: "unknown" | "ok" | "unauthorized" | "unreachable" | "timeout" | "unhealthy";
    reason: string;
    hint: string;
    checkedAt: string | null;
  };
  relayConnected: boolean;
  /** P2-129: present (non-null) only while the daemon is scheduling its next relay dial. */
  relayRetry?: { attempt: number; nextDelayMs: number } | null;
}

export interface Client {
  health(): Promise<Health>;
  listSessions(): Promise<SessionInfo[]>;
  createSession(title?: string): Promise<SessionInfo>;
  session(id: string): Promise<SessionInfo>;
  deleteSession(id: string): Promise<unknown>;
  messages(id: string, limit?: number): Promise<HistoryRow[]>;
  /** fire a prompt and return immediately (the agent works asynchronously) */
  send(id: string, text: string): Promise<{ accepted: boolean }>;
  /** fire a prompt and resolve with the assistant's reply once the session goes idle */
  sendAndWait(id: string, text: string, opts?: { timeoutMs?: number; pollMs?: number }): Promise<string>;
}

export function createClient(opts: OcrClientOptions): Client {
  const base = (opts.baseUrl ?? "http://127.0.0.1:8792").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as T) : ({} as T);
    if (!res.ok) throw new Error(`OCR ${method} ${path} -> ${res.status}: ${JSON.stringify(parsed).slice(0, 200)}`);
    return parsed;
  }

  return {
    async health() {
      return call<Health>("GET", "/api/health");
    },
    async listSessions() {
      return call<SessionInfo[]>("GET", "/api/session");
    },
    async createSession(title?: string) {
      return call<SessionInfo>("POST", "/api/session", title ? { title } : {});
    },
    async session(id) {
      return call<SessionInfo>("GET", `/api/session/${id}`);
    },
    async deleteSession(id) {
      return call<unknown>("DELETE", `/api/session/${id}`);
    },
    async messages(id, limit = 200) {
      return call<HistoryRow[]>("GET", `/api/session/${id}/messages?limit=${limit}`);
    },
    async send(id, text) {
      return call<{ accepted: boolean }>("POST", `/api/session/${id}/message`, { text });
    },
    async sendAndWait(id, text, { timeoutMs = 300_000, pollMs = 2_000 } = {}) {
      const before = (await this.messages(id)).length;
      await this.send(id, text);
      const deadline = Date.now() + timeoutMs;
      let lastLen = -1;
      let stable = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, pollMs));
        const rows = await this.messages(id);
        const last = rows[rows.length - 1];
        const grew = rows.length > before;
        const reply = last?.info?.role === "assistant"
          ? last.parts
              .filter((p) => p.type === "text" && p.text)
              .map((p) => p.text)
              .join("\n")
          : "";
        if (grew && reply) {
          // stable across two consecutive polls ⇒ the turn is (probably) over
          if (reply.length === lastLen) stable++;
          else stable = 0;
          lastLen = reply.length;
          if (stable >= 1) return reply;
        }
        if (Date.now() > deadline) throw new Error("sendAndWait: timeout waiting for agent reply");
      }
    },
  };
}
