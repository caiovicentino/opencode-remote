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
 *
 * Every failure is an `OcrError` with one `code` (http, timeout, network,
 * protocol, agent, aborted) — never a bare SyntaxError from a non-JSON body.
 */

export interface OcrClientOptions {
  /** daemon base URL (default http://127.0.0.1:8792) */
  baseUrl?: string;
  /** API token — apiToken field of ~/.opencode-remote/daemon.json */
  token: string;
  /** fetch override (tests, proxies) */
  fetchImpl?: typeof fetch;
  /** per-request timeout in ms for regular calls (default 30 000) */
  timeoutMs?: number;
}

/** Per-call knobs: a deadline and an optional caller-owned cancellation. */
export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type OcrErrorCode = "http" | "timeout" | "network" | "protocol" | "agent" | "aborted";

/** One cause per failure: `code` says which, `status`/`body` carry the HTTP answer when there was one. */
export class OcrError extends Error {
  readonly code: OcrErrorCode;
  readonly status?: number;
  readonly body?: unknown;
  readonly method?: string;
  readonly path?: string;

  constructor(
    code: OcrErrorCode,
    message: string,
    details: { method?: string; path?: string; status?: number; body?: unknown } = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OcrError";
    this.code = code;
    this.status = details.status;
    this.body = details.body;
    this.method = details.method;
    this.path = details.path;
  }
}

export interface SessionInfo {
  id: string;
  title?: string;
  directory?: string;
  [k: string]: unknown;
}

export interface HistoryRow {
  info: {
    id?: string;
    role?: string;
    parentID?: string;
    /** opencode stamps `completed` when an assistant step ends */
    time?: { created?: number; completed?: number };
    /** why the step ended — "tool-calls" means another step of the same turn follows */
    finish?: string;
    /** set when the turn failed (provider error, abort, …) */
    error?: { name?: string; data?: { message?: string } };
  };
  parts: { type: string; text?: string; tool?: string; state?: { status?: string; title?: string; output?: string } }[];
}

/** Answer of POST /api/session/:id/message. */
export interface SendResult {
  accepted: boolean;
  /** what opencode answered — today the turn's final assistant message */
  opencode?: unknown;
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
  /**
   * Fire a prompt. The daemon relays opencode's streaming
   * POST /session/:id/message, which completes when the agent's turn ends —
   * so this resolves then (202 { accepted }), bounded by `timeoutMs`
   * (default 5 min).
   */
  send(id: string, text: string, opts?: CallOptions): Promise<SendResult>;
  /** fire a prompt and resolve with the text of the turn's final assistant message */
  sendAndWait(id: string, text: string, opts?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** A prompt's answer only arrives when the agent's turn ends (see Client.send). */
const SEND_TIMEOUT_MS = 300_000;
/** Rows read per poll; the anchor is matched by id inside this window. */
const HISTORY_WINDOW = 200;

interface TurnVerdict {
  kind: "final" | "failed" | "pending" | "legacy";
  row?: HistoryRow;
}

/**
 * Is this the end of the turn? opencode writes one assistant message per
 * step: "tool-calls" steps are followed by more, the last step carries
 * `time.completed` and any other finish reason. Rows without `time` come from
 * an agent server that predates the stamps (legacy → text-stability fallback).
 */
function turnVerdict(row: HistoryRow | undefined): TurnVerdict {
  if (!row || row.info?.role !== "assistant") return { kind: "pending" };
  if (row.info.error) return { kind: "failed", row };
  if (!row.info.time) return { kind: "legacy", row };
  if (typeof row.info.time.completed !== "number" || row.info.finish === "tool-calls") return { kind: "pending" };
  return { kind: "final", row };
}

function replyText(row: HistoryRow): string {
  return (row.parts ?? [])
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n");
}

function isHistoryRow(v: unknown): v is HistoryRow {
  return typeof v === "object" && v !== null && typeof (v as HistoryRow).info === "object" && Array.isArray((v as HistoryRow).parts);
}

/**
 * The rows of THIS prompt's turn: when our own user message is identifiable
 * (a text part equal to the prompt — the daemon may append parts of its own),
 * only the steps answering it count, so a turn another client runs in the
 * same session is never mistaken for ours.
 */
function turnRows(fresh: HistoryRow[], text: string): HistoryRow[] {
  for (let i = fresh.length - 1; i >= 0; i--) {
    const r = fresh[i]!;
    if (r.info?.role === "user" && r.info.id && (r.parts ?? []).some((p) => p.type === "text" && p.text === text)) {
      const mine = r.info.id;
      return fresh.slice(i + 1).filter((x) => x.info?.parentID === undefined || x.info.parentID === mine);
    }
  }
  return fresh;
}

export function createClient(opts: OcrClientOptions): Client {
  const base = (opts.baseUrl ?? "http://127.0.0.1:8792").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sid = (id: string) => encodeURIComponent(id);

  function transportError(err: unknown, method: string, path: string, timeoutMs: number, signal?: AbortSignal): OcrError {
    const where = { method, path };
    if (signal?.aborted) return new OcrError("aborted", `OCR ${method} ${path}: aborted by the caller`, where, { cause: err });
    if ((err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError") {
      return new OcrError("timeout", `OCR ${method} ${path}: no answer within ${timeoutMs} ms`, where, { cause: err });
    }
    return new OcrError("network", `OCR ${method} ${path}: ${(err as Error)?.message ?? String(err)}`, where, { cause: err });
  }

  async function call<T>(method: string, path: string, body?: unknown, o: CallOptions = {}): Promise<T> {
    const timeoutMs = o.timeoutMs ?? defaultTimeout;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;
    let text: string;
    let status: number;
    let ok: boolean;
    try {
      const res = await f(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
      status = res.status;
      ok = res.ok;
      text = await res.text();
    } catch (err) {
      throw transportError(err, method, path, timeoutMs, o.signal);
    }
    let parsed: unknown;
    let json = false;
    if (text) {
      try {
        parsed = JSON.parse(text);
        json = true;
      } catch {
        // proxies and crashes answer text/html — reported below, never thrown raw
      }
    }
    if (!ok) {
      const shown = json ? JSON.stringify(parsed) : text;
      throw new OcrError("http", `OCR ${method} ${path} -> ${status}: ${shown.slice(0, 200)}`, {
        method,
        path,
        status,
        body: json ? parsed : text,
      });
    }
    if (text && !json) {
      throw new OcrError("protocol", `OCR ${method} ${path} -> ${status}: answer is not JSON`, { method, path, status, body: text });
    }
    return (text ? parsed : {}) as T;
  }

  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new OcrError("aborted", "sendAndWait: aborted by the caller"));
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new OcrError("aborted", "sendAndWait: aborted by the caller"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  return {
    async health() {
      return call<Health>("GET", "/api/health");
    },
    async listSessions() {
      return call<SessionInfo[]>("GET", "/api/session");
    },
    async createSession(title?: string) {
      // POST /api/session is the Bearer→cookie exchange since P1-057; the
      // opencode session is created by POST /api/session/new.
      const created = await call<Partial<SessionInfo>>("POST", "/api/session/new", title ? { title } : {});
      if (typeof created?.id !== "string" || !created.id) {
        throw new OcrError("protocol", "createSession: the daemon answered without a session id", {
          method: "POST",
          path: "/api/session/new",
          body: created,
        });
      }
      return created as SessionInfo;
    },
    async session(id) {
      return call<SessionInfo>("GET", `/api/session/${sid(id)}`);
    },
    async deleteSession(id) {
      return call<unknown>("DELETE", `/api/session/${sid(id)}`);
    },
    async messages(id, limit = HISTORY_WINDOW) {
      return call<HistoryRow[]>("GET", `/api/session/${sid(id)}/messages?limit=${limit}`);
    },
    async send(id, text, o = {}) {
      return call<SendResult>("POST", `/api/session/${sid(id)}/message`, { text }, {
        timeoutMs: o.timeoutMs ?? SEND_TIMEOUT_MS,
        signal: o.signal,
      });
    },
    async sendAndWait(id, text, { timeoutMs = SEND_TIMEOUT_MS, pollMs = 2_000, signal } = {}) {
      const deadline = Date.now() + timeoutMs;
      const left = () => Math.max(1, deadline - Date.now());
      const history = (limit: number) =>
        call<HistoryRow[]>("GET", `/api/session/${sid(id)}/messages?limit=${limit}`, undefined, {
          timeoutMs: Math.min(defaultTimeout, left()),
          signal,
        });
      // Anchor on the last message BEFORE the prompt — by id, never by count:
      // the history route returns at most `limit` rows, so a count stops
      // growing once the session holds that many messages.
      const anchor = (await history(1))[0]?.info?.id ?? null;
      const sent = await call<SendResult>("POST", `/api/session/${sid(id)}/message`, { text }, { timeoutMs: left(), signal });
      if (sent?.accepted === false) {
        throw new OcrError("protocol", "sendAndWait: the daemon did not accept the prompt", { body: sent });
      }
      // The daemon relays opencode's streaming answer, which only completes
      // when the turn is over: a completed assistant message in it IS the
      // reply to this prompt — no polling, no guessing.
      const direct = sent?.opencode;
      if (isHistoryRow(direct) && direct.info.role === "assistant") {
        if (direct.info.error) throw agentError(direct);
        if (typeof direct.info.time?.completed === "number") return replyText(direct);
      }
      let lastLegacy = "";
      let stable = 0;
      for (;;) {
        const rows = await history(HISTORY_WINDOW);
        const at = anchor === null ? -1 : rows.findIndex((r) => r.info?.id === anchor);
        const turn = turnRows(rows.slice(at + 1), text);
        const verdict = turnVerdict(turn[turn.length - 1]);
        if (verdict.kind === "final") return replyText(verdict.row!);
        if (verdict.kind === "failed") throw agentError(verdict.row!);
        if (verdict.kind === "legacy") {
          // agent server without time/finish stamps: same text across two
          // consecutive polls ⇒ the turn is (probably) over
          const reply = replyText(verdict.row!);
          stable = reply && reply === lastLegacy ? stable + 1 : 0;
          lastLegacy = reply;
          if (stable >= 1) return reply;
        }
        if (Date.now() >= deadline) {
          throw new OcrError("timeout", `sendAndWait: no final reply within ${timeoutMs} ms`);
        }
        await sleep(Math.min(pollMs, left()), signal);
      }
    },
  };
}

function agentError(row: HistoryRow): OcrError {
  const e = row.info.error;
  const why = e?.data?.message ?? e?.name ?? "unknown error";
  return new OcrError("agent", `the agent turn failed: ${why}`, { body: e });
}
