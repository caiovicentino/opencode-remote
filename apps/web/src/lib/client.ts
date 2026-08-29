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

export type Status = "connecting" | "paired" | "closed";

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
    const relay = url.searchParams.get("relay");
    const room = url.searchParams.get("room");
    const k = url.searchParams.get("k");
    if (!relay || !room || !k) return null;
    const v = Number(url.searchParams.get("v") ?? "2");
    if (v !== 2) throw new Error("unsupported protocol version; update the daemon");
    return {
      v: 2,
      relay,
      room,
      k,
      vapid: url.searchParams.get("vapid") ?? undefined,
      name: url.searchParams.get("name") ?? undefined,
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
  onStatus: ((s: Status) => void) | null = null;

  private ws: WebSocket;
  private key: CryptoKey;
  private room: string;
  private from: string;
  private sendSeq = 0;
  private daemonLastSeq = 0;
  private pending = new Map<string, { resolve: (r: OpResponse) => void; timer: number }>();
  private listeners = new Set<Handler>();

  private constructor(
    ws: WebSocket,
    key: CryptoKey,
    room: string,
    machineName: string,
    from: string,
    vapid?: string,
  ) {
    this.ws = ws;
    this.key = key;
    this.room = room;
    this.machineName = machineName;
    this.from = from;
    this.vapidKey = vapid;

    ws.onmessage = (e) => void this.onMessage(e.data as string);
    ws.onclose = () => this.setStatus("closed");
    ws.onerror = () => this.setStatus("closed");
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

    // first message from the daemon is the handshake confirmation
    if (this.status !== "paired") {
      try {
        const confirm = JSON.parse(atob(frame.payload)) as {
          ok?: boolean;
          confirm?: string;
        };
        if (confirm.ok && confirm.confirm) {
          const check = await openSealed<{ ok: boolean }>(
            confirm.confirm,
            this.key,
            new TextEncoder().encode("ocr-confirm"),
          );
          if (check?.ok) this.setStatus("paired");
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
  ): Promise<OpResponse> {
    const req: OpRequest = { id: crypto.randomUUID(), method, path, body, query };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error("request timeout"));
      }, 60_000);
      this.pending.set(req.id, { resolve, timer });
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
      );
      client.onStatus = (s) => {
        if (s === "paired") {
          clearTimeout(timeout);
          resolve(client);
        } else if (s === "closed") {
          clearTimeout(timeout);
          reject(new Error("connection closed before pairing"));
        }
      };
    });
  }
}
