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

/** P1-061: which wire the client is currently dialed on. */
export type Transport = "local" | "relay";

/** Shape returned by the desktop bridge's app:localLink IPC. */
export interface LocalLink {
  port: number;
  token: string;
}

/** Options for OcrClient.connect — absent in the browser (PWA stays relay-only). */
export interface ConnectOptions {
  /** Desktop shell bridge: fresh loopback WS credentials from the 0600 state file. */
  getLocalLink?: () => Promise<LocalLink | null>;
}

/** Local direct-mode URL builder: token rides the query, loopback only. */
export function localWsUrl(port: number, token: string): string {
  return `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
}

/**
 * P1-061 failover predicate (unit-pinned): one failed local dial stays sticky
 * on the direct transport; two consecutive failures hand the next dial to the
 * relay. A successful pairing resets the counter.
 */
export function shouldFailoverToRelay(localFailures: number): boolean {
  return localFailures >= 2;
}

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
  /** P1-061: transport of the current dial ("local" loopback or "relay"). */
  transport: Transport = "relay";

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
  private localLink?: () => Promise<LocalLink | null>;
  private localFailures = 0;

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
    localLink?: () => Promise<LocalLink | null>,
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
    if (localLink) this.localLink = localLink;

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
  private confirmTimer: number | null = null;

  private attach(ws: WebSocket) {
    const gen = ++this.gen;
    ws.onmessage = (e) => {
      if (gen !== this.gen) return;
      void this.onMessage(e.data as string);
    };
    ws.onclose = () => {
      if (gen !== this.gen || this.ws !== ws || this.intentionalClose) return;
      // P1-061: a local socket that died counts toward transport failover;
      // relay losses don't (relay is already the fallback transport).
      if (this.transport === "local") this.localFailures++;
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
    this.clearConfirmWatchdog();
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
      const target = await this.dialTarget();
      const ws = new WebSocket(target.url);
      this.ws = ws;
      this.transport = target.transport;
      this.attach(ws);
      ws.onopen = () => void this.sendHello(ws);
      this.armConfirmWatchdog(target.confirmTimeoutMs);
    } catch {
      this.scheduleReconnect();
    }
  }

  /**
   * P1-061: pick the wire for the next dial. Local is preferred whenever a
   * loopback link is available and hasn't failed twice in a row; otherwise the
   * relay of the pairing URI is used exactly as before.
   */
  private async dialTarget(): Promise<{
    url: string;
    transport: Transport;
    confirmTimeoutMs: number;
  }> {
    if (this.localLink && !shouldFailoverToRelay(this.localFailures)) {
      const link = await this.localLink().catch(() => null);
      if (link?.port && link.token) {
        return { url: localWsUrl(link.port, link.token), transport: "local", confirmTimeoutMs: 3_000 };
      }
    }
    return { url: this.pairing.relay, transport: "relay", confirmTimeoutMs: 15_000 };
  }

  /**
   * P1-061: a dial that never confirms (daemon mid-kickstart, silent relay)
   * must not strand the client in "connecting" forever — close and retry.
   */
  private armConfirmWatchdog(confirmTimeoutMs: number) {
    if (this.confirmTimer !== null) clearTimeout(this.confirmTimer);
    this.confirmTimer = window.setTimeout(() => {
      this.confirmTimer = null;
      if (this.status !== "paired" && !this.intentionalClose) this.forceReconnect();
    }, confirmTimeoutMs);
  }

  private clearConfirmWatchdog() {
    if (this.confirmTimer !== null) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
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
      // P1-061: a confirmed handshake proves the current transport works —
      // stay sticky on it and give local another chance after any outage.
      this.localFailures = 0;
      this.clearConfirmWatchdog();
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
    this.clearConfirmWatchdog();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws.close();
    this.setStatus("closed");
  }

  static async connect(pairing: Pairing, opts?: ConnectOptions): Promise<OcrClient> {
    const identity = await getOrCreateIdentity();
    const { hello, sessionKey } = await clientHello(pairing.k, identity);
    const from = Math.random().toString(36).slice(2, 10);
    const getLocalLink = opts?.getLocalLink;

    // P1-061: local-first. When the shell provides loopback credentials and
    // the daemon answers there, no relay hop is involved at all — deploy
    // kickstarts of the relay can't touch the session. Any local failure
    // (unreachable, timeout) falls back to the relay of the pairing URI.
    if (getLocalLink) {
      const link = await getLocalLink().catch(() => null);
      if (link?.port && link.token) {
        try {
          return await OcrClient.dialLocal(pairing, from, hello, sessionKey, identity, getLocalLink, link);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("rejected by daemon")) throw err;
          // otherwise: relay as always
        }
      }
    }
    return OcrClient.dialRelay(pairing, from, hello, sessionKey, identity, getLocalLink);
  }

  /** Dial the loopback WS. Rejects with "local daemon unreachable" on
   * timeout/close (caller falls back to relay), propagates daemon rejection. */
  private static dialLocal(
    pairing: Pairing,
    from: string,
    hello: Awaited<ReturnType<typeof clientHello>>["hello"],
    sessionKey: CryptoKey,
    identity: Identity,
    getLocalLink: () => Promise<LocalLink | null>,
    link: LocalLink,
  ): Promise<OcrClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(localWsUrl(link.port, link.token));
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
        getLocalLink,
      );
      client.transport = "local";
      // send the handshake on open — without this the local dial sits silent,
      // hits the 3s timeout and every connect falls back to the relay
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            room: pairing.room,
            from,
            payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
          }),
        );
      };
      const fail = (err: Error) => {
        clearTimeout(timeout);
        client.intentionalClose = true; // this socket's auto-reconnect is not wanted
        try {
          ws.close();
        } catch {}
        reject(err);
      };
      const timeout = setTimeout(() => fail(new Error("local daemon unreachable")), 3_000);
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
          fail(new Error("local daemon unreachable"));
        }
      };
    });
  }

  /** Relay dial — the pre-P1-061 connect() path, unchanged. */
  private static dialRelay(
    pairing: Pairing,
    from: string,
    hello: Awaited<ReturnType<typeof clientHello>>["hello"],
    sessionKey: CryptoKey,
    identity: Identity,
    getLocalLink?: () => Promise<LocalLink | null>,
  ): Promise<OcrClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(pairing.relay);

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
        getLocalLink,
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
