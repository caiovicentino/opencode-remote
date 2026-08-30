import {
  b64,
  clientHello,
  seal,
  openSealed,
  seqAad,
  newIdentity,
  type Identity,
} from "@ocr/protocol";
import type { OpResponse, EventEnvelope, OpRequest, ResChunk } from "@ocr/protocol";

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

const STATE_KEY = "ocr.pairing.v2";
const PAIRINGS_KEY = "ocr.pairings.v2";
const ACTIVE_KEY = "ocr.active.room";

export function loadPairings(): Pairing[] {
  try {
    const list = JSON.parse(localStorage.getItem(PAIRINGS_KEY) ?? "[]") as Pairing[];
    if (Array.isArray(list)) return list;
  } catch {}
  return [];
}

export function upsertPairing(p: Pairing): Pairing[] {
  const list = loadPairings().filter((x) => x.room !== p.room);
  list.push(p);
  localStorage.setItem(PAIRINGS_KEY, JSON.stringify(list));
  return list;
}

export function removePairing(room: string): Pairing[] {
  const list = loadPairings().filter((x) => x.room !== room);
  localStorage.setItem(PAIRINGS_KEY, JSON.stringify(list));
  return list;
}

export function getActiveRoom(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveRoom(room: string | null) {
  if (room) localStorage.setItem(ACTIVE_KEY, room);
  else localStorage.removeItem(ACTIVE_KEY);
}

export function loadState(): StoredState | null {
  const list = loadPairings();
  const active = getActiveRoom();
  const found = active ? list.find((p) => p.room === active) : list.length === 1 ? list[0] : null;
  if (found) return { pairing: found };
  // legacy single-pairing storage (pre multi-machine)
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredState;
    if (parsed.pairing?.v !== 2) return null;
    upsertPairing(parsed.pairing);
    setActiveRoom(parsed.pairing.room);
    localStorage.removeItem(STATE_KEY);
    return parsed;
  } catch {
    return null;
  }
}

export function saveState(pairing: Pairing) {
  upsertPairing(pairing);
  setActiveRoom(pairing.room);
}

/** Disconnects the active machine but keeps every pairing for later switching. */
export function clearState() {
  setActiveRoom(null);
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
    pairing?: Pairing,
    identity?: Identity,
  ) {
    this.ws = ws;
    this.key = key;
    this.room = room;
    this.machineName = machineName;
    this.from = from;
    this.vapidKey = vapid;
    this.daemonSpki = daemonSpki;
    if (pairing) this.pairing = pairing;
    if (identity) this.identity = identity;

    this.attach(ws);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible" || this.status !== "paired") return;
        if (Date.now() - this.lastSeen > 30_000) this.forceReconnect();
        else {
          this.awaitingPong = true;
          this.sendControl({ type: "ping" });
        }
      });
    }
  }

  private pairing!: Pairing;
  private identity!: Identity;
  private daemonSpki!: string;
  private rehandshaking = false;
  private gen = 0;
  private intentionalClose = false;
  private lastSeen = Date.now();
  private awaitingPong = false;
  private hbTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;

  private attach(ws: WebSocket) {
    const gen = ++this.gen;
    ws.onmessage = (e) => {
      if (gen !== this.gen) return;
      void this.onMessage(e.data as string);
    };
    ws.onclose = () => {
      if (gen !== this.gen || this.ws !== ws || this.intentionalClose) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  private sendControl(ctl: { type: string }) {
    try {
      this.ws.send(
        JSON.stringify({
          room: this.room,
          from: this.from,
          payload: b64(new TextEncoder().encode(JSON.stringify(ctl))),
        }),
      );
    } catch {
      // socket wedged — the heartbeat/reconnect path will replace it
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastSeen = Date.now();
    this.awaitingPong = false;
    this.hbTimer = window.setInterval(() => {
      if (this.status !== "paired" || this.intentionalClose) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (this.awaitingPong || Date.now() - this.lastSeen > 60_000) {
        this.forceReconnect();
        return;
      }
      this.awaitingPong = true;
      this.sendControl({ type: "ping" });
    }, 20_000);
  }

  private stopHeartbeat() {
    if (this.hbTimer !== null) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  private forceReconnect() {
    const dead = this.ws;
    this.awaitingPong = false;
    this.scheduleReconnect();
    try {
      dead.close();
    } catch {}
  }

  private scheduleReconnect() {
    this.stopHeartbeat();
    if (this.reconnectTimer !== null || this.intentionalClose) return;
    this.setStatus("connecting");
    const delay = Math.min(15_000, 1000 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect() {
    if (this.intentionalClose || !this.pairing) return;
    try {
      const ws = new WebSocket(this.pairing.relay);
      this.ws = ws;
      this.attach(ws);
      ws.onopen = () => void this.sendHello(ws);
    } catch {
      this.scheduleReconnect();
    }
  }

  /** Fresh handshake on the given socket, then replay ops that never got a response. */
  private async sendHello(ws: WebSocket) {
    const identity = this.identity ?? (await getOrCreateIdentity());
    const { hello, sessionKey } = await clientHello(this.daemonSpki, identity);
    this.key = sessionKey;
    this.daemonLastSeq = 0;
    const retrying = [...this.pending.values()];
    this.pending.clear();
    for (const p of retrying) clearTimeout(p.timer);
    ws.send(
      JSON.stringify({
        room: this.room,
        from: this.from,
        payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
      }),
    );
    for (const p of retrying) this.replay(p);
  }

  /** Re-run the handshake after a daemon restart and replay in-flight ops. */
  private async rehandshake() {
    if (this.rehandshaking) return;
    this.rehandshaking = true;
    try {
      this.setStatus("connecting");
      await this.sendHello(this.ws);
    } catch (err) {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.pending.clear();
      this.scheduleReconnect();
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
    if (s === "paired") {
      this.reconnectAttempt = 0;
      this.startHeartbeat();
    } else if (s !== "connecting") {
      this.stopHeartbeat();
    }
    this.onStatus?.(s);
  }

  private async sendFrame(frame: { from: string; seq: number; payload: string }) {
    this.ws.send(JSON.stringify({ ...frame, room: this.room }));
  }

  private async onMessage(data: string) {
    this.lastSeen = Date.now();
    this.awaitingPong = false;
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
        if (ctl?.type === "pong") return;
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
      { type: "res"; res: OpResponse } | { type: "res-chunk"; chunk: ResChunk } | { type: "event"; event: EventEnvelope }
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
    } else if (env.type === "res-chunk") {
      this.onChunk(env.chunk);
    } else {
      for (const h of this.listeners) h(env.event);
    }
  }

  private chunkBuf = new Map<string, { of: number; got: number; status: number; parts: string[] }>();

  /** Reassemble chunked oversized responses and resolve the pending op. */
  private onChunk(c: ResChunk) {
    if (this.chunkBuf.size > 20) this.chunkBuf.clear();
    let e = this.chunkBuf.get(c.id);
    if (!e) {
      e = { of: c.of, got: 0, status: c.status, parts: [] };
      this.chunkBuf.set(c.id, e);
    }
    if (e.parts[c.i] === undefined) e.got++;
    e.parts[c.i] = c.part;
    if (e.got < e.of) return;
    this.chunkBuf.delete(c.id);
    let body: unknown;
    try {
      body = JSON.parse(e.parts.join(""));
    } catch {
      return;
    }
    const p = this.pending.get(c.id);
    if (p) {
      this.pending.delete(c.id);
      clearTimeout(p.timer);
      p.resolve({ id: c.id, status: e.status, body });
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
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
        pairing,
        identity,
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
