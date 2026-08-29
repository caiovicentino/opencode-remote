import {
  b64,
  clientHello,
  seal,
  openSealed,
  seqAad,
  newIdentity,
  type Identity,
} from "@ocr/protocol";
import type { OpResponse, EventEnvelope, OpRequest } from "@ocr/protocol";

export interface Pairing {
  v: 2;
  relay: string;
  room: string;
  k: string;
  vapid?: string;
  name?: string;
}

export type Status = "connecting" | "paired" | "rejected" | "closed";

interface StoredState {
  pairing: Pairing;
}

const STATE_KEY = "ocr.pairing.v2";
const IDB_NAME = "ocr-identity";
const IDB_STORE = "keys";

// ---------------------------------------------------------------------------
// identity in IndexedDB: the private key is NON-EXTRACTABLE, so XSS can use it
// while the page lives but never exfiltrate it.
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOrCreateIdentity(): Promise<Identity> {
  const db = await openDb();
  const stored = await idbGet<{ spki: string; key: CryptoKey }>(db, "identity");
  if (stored) return { publicKey: stored.spki, privateKey: stored.key };
  const identity = await newIdentity(false); // extractable=false is the point
  await idbPut(db, "identity", { spki: identity.publicKey, key: identity.privateKey });
  return identity;
}

// WebAuthn credential id for the biometric gate
export async function getCredentialId(): Promise<ArrayBuffer | null> {
  const db = await openDb();
  const id = await idbGet<ArrayBuffer>(db, "credentialId");
  return id ?? null;
}

export async function setCredentialId(rawId: ArrayBuffer): Promise<void> {
  const db = await openDb();
  await idbPut(db, "credentialId", rawId);
}

// ---------------------------------------------------------------------------
// pairing state (localStorage holds no secrets since v2)
// ---------------------------------------------------------------------------

export function loadState(): StoredState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredState;
    if (parsed.pairing?.v !== 2) return null; // stale v1 pairing
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(pairing: Pairing) {
  localStorage.setItem(STATE_KEY, JSON.stringify({ pairing } satisfies StoredState));
}

export function clearState() {
  localStorage.removeItem(STATE_KEY);
}

export function parsePairingUri(uri: string): Pairing | null {
  try {
    const url = new URL(uri.trim());
    if (url.protocol !== "opencode-remote:") return null;
    // manual parse: URLSearchParams treats "+" as space, corrupting base64
    const q = new Map<string, string>();
    for (const part of url.search.replace(/^\?/, "").split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const key = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
      const val = decodeURIComponent(eq === -1 ? "" : part.slice(eq + 1));
      q.set(key, val);
    }
    const get = (key: string) => {
      const val = q.get(key);
      return val === undefined ? null : val;
    };
    const relay = get("relay");
    const room = get("room");
    const k = get("k");
    if (!relay || !room || !k) return null;
    const v = Number(get("v") ?? "2");
    if (v !== 2) throw new Error("unsupported protocol version; update the daemon");
    return {
      v: 2,
      relay,
      room,
      k,
      vapid: get("vapid") ?? undefined,
      name: get("name") ?? undefined,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("unsupported")) throw err;
    return null;
  }
}

type Handler = (evt: EventEnvelope) => void;
type OpRequestMethod = "GET" | "POST" | "DELETE" | "PATCH" | "PUT";

export class OcrClient {
  status: Status = "connecting";
  machineName: string;
  vapidKey?: string;
  caps: { transcribe?: boolean } = {};
  onStatus: ((s: Status) => void) | null = null;

  private ws: WebSocket;
  private key: CryptoKey;
  private room: string;
  private from: string;
  private sendSeq = 0;
  private daemonLastSeq = 0;
  private pending = new Map<
    string,
    {
      resolve: (r: OpResponse) => void;
      reject: (e: Error) => void;
      timer: number;
      args: {
        method: OpRequestMethod;
        path: string;
        body?: unknown;
        query?: Record<string, string>;
        timeoutMs: number;
      };
    }
  >();
  private listeners = new Set<Handler>();

  private constructor(
    ws: WebSocket,
    key: CryptoKey,
    room: string,
    machineName: string,
    from: string,
    vapid?: string,
    daemonSpki = "",
  ) {
    this.ws = ws;
    this.key = key;
    this.room = room;
    this.machineName = machineName;
    this.from = from;
    this.vapidKey = vapid;
    this.daemonSpki = daemonSpki;

    ws.onmessage = (e) => void this.onMessage(e.data as string);
    ws.onclose = () => this.setStatus("closed");
    ws.onerror = () => this.setStatus("closed");
  }

  private daemonSpki: string;
  private rehandshaking = false;

  /** Transparently re-run the handshake after a daemon restart and replay in-flight ops. */
  private async rehandshake() {
    if (this.rehandshaking) return;
    this.rehandshaking = true;
    try {
      const identity = await getOrCreateIdentity();
      const { hello, sessionKey } = await clientHello(this.daemonSpki, identity);
      const retrying = [...this.pending.values()];
      this.pending.clear();
      this.key = sessionKey;
      this.daemonLastSeq = 0;
      this.setStatus("connecting");
      this.ws.send(
        JSON.stringify({
          room: this.room,
          from: this.from,
          payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
        }),
      );
      // frames reach the daemon after the hello (same socket, FIFO), so replay is safe
      for (const p of retrying) this.replay(p);
    } catch (err) {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.pending.clear();
      this.setStatus("closed");
      throw err;
    } finally {
      this.rehandshaking = false;
    }
  }

  /** Re-issue a pending op on the fresh session, keeping the caller's promise. */
  private replay(p: {
    resolve: (r: OpResponse) => void;
    reject: (e: Error) => void;
    args: {
      method: OpRequestMethod;
      path: string;
      body?: unknown;
      query?: Record<string, string>;
      timeoutMs: number;
    };
  }) {
    const req: OpRequest = {
      id: crypto.randomUUID(),
      method: p.args.method,
      path: p.args.path,
      body: p.args.body,
      query: p.args.query,
    };
    const timer = window.setTimeout(() => {
      this.pending.delete(req.id);
      p.reject(new Error("request timeout"));
    }, p.args.timeoutMs);
    this.pending.set(req.id, { resolve: p.resolve, reject: p.reject, timer, args: p.args });
    const seq = ++this.sendSeq;
    void seal({ type: "op", req }, this.key, seqAad(this.from, seq)).then((payload) =>
      this.sendFrame({ from: this.from, seq, payload }),
    );
  }

  private setStatus(s: Status) {
    this.status = s;
    this.onStatus?.(s);
  }

  private async sendFrame(frame: { from: string; seq: number; payload: string }) {
    this.ws.send(JSON.stringify({ ...frame, room: this.room }));
  }

  private async onMessage(data: string) {
    let frame: { from?: string; seq?: number; payload?: string };
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame.from || frame.from === this.from || !frame.payload) return;

    // daemon asks for a fresh handshake (e.g. it restarted while we stayed up)
    if (this.status === "paired") {
      try {
        const ctl = JSON.parse(atob(frame.payload)) as { type?: string };
        if (ctl?.type === "reconnect") {
          void this.rehandshake();
          return;
        }
      } catch {
        // not a control frame; fall through to the sealed path
      }
    }

    // first message from the daemon is the handshake confirmation
    if (this.status !== "paired") {
      try {
        const confirm = JSON.parse(atob(frame.payload)) as {
          ok?: boolean;
          confirm?: string;
          reject?: string;
        };
        if (confirm.ok === false && confirm.reject) {
          const check = await openSealed<{ reason: string }>(
            confirm.reject,
            this.key,
            new TextEncoder().encode("ocr-reject"),
          );
          if (check?.reason === "not-allowed") this.setStatus("rejected");
        } else if (confirm.ok && confirm.confirm) {
          const check = await openSealed<{
            ok: boolean;
            caps?: { transcribe?: boolean };
          }>(confirm.confirm, this.key, new TextEncoder().encode("ocr-confirm"));
          if (check?.ok) {
            this.caps = check.caps ?? {};
            this.setStatus("paired");
          }
        }
      } catch {
        // not a confirmation; ignore until paired
      }
      return;
    }

    // replay guard: daemon frames must be fresh
    const seq = frame.seq ?? 0;
    if (seq <= this.daemonLastSeq) return;

    const env = await openSealed<
      { type: "res"; res: OpResponse } | { type: "event"; event: EventEnvelope }
    >(frame.payload, this.key, seqAad(frame.from, seq));
    if (!env) return;
    this.daemonLastSeq = seq;
    if (env.type === "res") {
      const p = this.pending.get(env.res.id);
      if (p) {
        this.pending.delete(env.res.id);
        clearTimeout(p.timer);
        p.resolve(env.res);
      }
    } else {
      for (const h of this.listeners) h(env.event);
    }
  }

  request(
    method: OpRequestMethod,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    timeoutMs = 60_000,
  ): Promise<OpResponse> {
    const req: OpRequest = { id: crypto.randomUUID(), method, path, body, query };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error("request timeout"));
      }, timeoutMs);
      this.pending.set(req.id, {
        resolve,
        reject,
        timer,
        args: { method, path, body, query, timeoutMs },
      });
      const seq = ++this.sendSeq;
      void seal({ type: "op", req }, this.key, seqAad(this.from, seq)).then((payload) =>
        this.sendFrame({ from: this.from, seq, payload }),
      );
    });
  }

  onEvent(h: Handler): () => void {
    this.listeners.add(h);
    return () => this.listeners.delete(h);
  }

  close() {
    this.ws.close();
    this.setStatus("closed");
  }

  static async connect(pairing: Pairing): Promise<OcrClient> {
    const identity = await getOrCreateIdentity();
    const { hello, sessionKey } = await clientHello(pairing.k, identity);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(pairing.relay);
      const from = Math.random().toString(36).slice(2, 10);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("pairing timeout — is the daemon running?"));
      }, 15_000);

      ws.onopen = () => {
        // presence + hello in one clear-JSON control frame
        ws.send(
          JSON.stringify({
            room: pairing.room,
            from,
            payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
          }),
        );
      };

      const client = new OcrClient(
        ws,
        sessionKey,
        pairing.room,
        pairing.name ?? "",
        from,
        pairing.vapid,
        pairing.k,
      );
      client.onStatus = (s) => {
        if (s === "paired") {
          clearTimeout(timeout);
          resolve(client);
        } else if (s === "rejected") {
          clearTimeout(timeout);
          reject(
            new Error(
              "rejected by daemon: this client is not in the allowlist — clear it with `manage.ts revoke-all` and pair again",
            ),
          );
        } else if (s === "closed") {
          clearTimeout(timeout);
          reject(new Error("connection closed before pairing"));
        }
      };
    });
  }
}
