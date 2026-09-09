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
import {
  classifyFrame,
  hintVerdict,
  readClearControl,
  RECONNECT_HINT_VERIFY_MS,
} from "./framegate";
import {
  IDENTITY_DB_NAME,
  REAUTH_CONFIRM_GRACE_MS,
  REAUTH_ERROR,
  REAUTH_RETRY_DELAY_MS,
  REJECTED_ERROR,
  identityStorageKeys,
  reauthFrameAction,
  reauthVerdict,
} from "./reauth";

export interface Pairing {
  v: 2;
  relay: string;
  room: string;
  k: string;
  vapid?: string;
  name?: string;
}

/** Bug 1: "expired" — the daemon refused our handshake twice in a row (stale
 * keys after a daemon restart/rekey). Terminal: the only way out is the
 * "pair again" wipe (wipeLocalIdentity) and a fresh pairing ceremony.
 * EVAL4-F2: "rejected" is terminal too — the daemon answered not-allowed
 * (device revoked / pairing window closed); the client stops dialing and the
 * shell shows the "device removed" card. Recovery is a user action. */
export type Status = "connecting" | "paired" | "rejected" | "closed" | "expired";

/** EVAL4-F3: how many times the initial dial's timeout re-arms while a
 * reauth exchange (refused hello → retry) is still in flight, so the
 * expired verdict — not "pairing timeout" — reaches the screen. */
const DIAL_TIMEOUT_REAUTH_EXTENSIONS = 2;

/** EVAL4-F3b: op-level liveness probe — see armAckWatchdog(). */
const ACK_PROBE_MS = 4_000;
const ACK_PONG_MS = 2_500;

/** P3-374: how long an op caught mid-rehandshake waits for the fresh
 * confirmation (and its replay) before rejecting like any timeout. Short
 * enough that a caller's retry lands inside a normal interaction, long
 * enough to ride out a single local re-dial. */
const PENDING_REHANDSHAKE_GRACE_MS = 8_000;

/** P1-061: which wire the client is currently dialed on. */
export type Transport = "local" | "relay";

/** Shape returned by the desktop bridge's app:localLink IPC. P1-070: room +
 * ecdhPub ride along (same 0600 state file) so the renderer can derive the
 * local pairing without any pairing-uri round-trip. */
export interface LocalLink {
  port: number;
  token: string;
  room?: string;
  ecdhPub?: string;
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

const IDB_NAME = IDENTITY_DB_NAME;
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

/**
 * Bug 1: the "pair again" wipe behind the expired-session card. Removes the
 * identity (IndexedDB: private key + WebAuthn credential id) and every
 * pairing-bound localStorage key of THIS app (lib/reauth.ts decides which),
 * leaving personal preferences alone. Best effort: a blocked/failed database
 * delete still resolves so the user always lands on the pairing flow.
 */
export async function wipeLocalIdentity(): Promise<void> {
  try {
    for (const key of identityStorageKeys(Object.keys(localStorage))) localStorage.removeItem(key);
  } catch {
    // storage unavailable (private mode quota) — nothing to wipe there
  }
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(IDB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
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
      /** P3-374: the rehandshake grace was armed for this entry (arm once —
       * later hellos in the same churn must not push the deadline out). */
      graced?: boolean;
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
  private hintVerifyTimer: number | null = null;
  private verifyingHint = false;
  private lastRehandshakeAt = 0;
  // Bug 1: consecutive hellos the daemon refused (reset on every confirm) and
  // whether a hello went out on the current dial (a reauth before that is noise).
  private reauthStrikes = 0;
  private helloSent = false;
  // EVAL4-F5: a reauth frame arrived on the current dial — the strike is
  // decided when the (shortened) confirm watchdog closes unconfirmed.
  private reauthPending = false;
  // EVAL4-F4: when the current outage began (0 while paired) — the shell
  // escalates its copy after a while instead of spinning forever.
  private disconnectedAt = 0;

  /** EVAL4-F4: dials attempted since the session was last paired (0 while paired). */
  get attempts(): number {
    return this.reconnectAttempt;
  }

  /** EVAL4-F4: Date.now() of the moment the session dropped; 0 while paired. */
  get disconnectedSince(): number {
    return this.disconnectedAt;
  }

  /** EVAL4-F4: the "try now" button — skip the pending backoff and dial at once. */
  retryNow(): void {
    if (this.intentionalClose || this.status === "paired") return;
    // only while waiting out a backoff — a dial already in flight is left alone
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.reconnect();
  }

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
    this.clearHintVerify();
    this.clearAckWatchdog();
  }

  /** `minDelayMs` (EVAL4-F3): floor for the next dial's backoff. */
  private forceReconnect(minDelayMs = 0) {
    const dead = this.ws;
    this.awaitingPong = false;
    this.scheduleReconnect(minDelayMs);
    try {
      dead.close();
    } catch {}
  }

  private scheduleReconnect(minDelayMs = 0) {
    this.stopHeartbeat();
    this.clearConfirmWatchdog();
    this.clearHintVerify();
    if (this.reconnectTimer !== null || this.intentionalClose) return;
    this.setStatus("connecting");
    const delay = Math.max(minDelayMs, Math.min(15_000, 1000 * 2 ** this.reconnectAttempt++));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect() {
    if (this.intentionalClose || !this.pairing) return;
    this.helloSent = false; // Bug 1: only a reauth AFTER this dial's hello counts
    this.reauthPending = false; // EVAL4-F5: a fresh dial starts with no pending strike
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
      if (this.status === "paired" || this.intentionalClose) return;
      // EVAL4-F5: the window closed with no sealed confirmation after a
      // reauth frame — NOW the refusal counts (reauthVerdict decides).
      if (this.reauthPending) {
        this.reauthPending = false;
        const action = reauthVerdict(this.status, this.reauthStrikes, this.helloSent);
        if (action === "expired") {
          this.reauthStrikes++;
          this.expire();
          return;
        }
        if (action === "retry") {
          this.reauthStrikes++;
          this.helloSent = false;
          // EVAL4-F3: past the daemon's per-sender reauth throttle, so the
          // retry's refusal is answered instead of suppressed.
          this.forceReconnect(REAUTH_RETRY_DELAY_MS);
          return;
        }
      }
      this.forceReconnect();
    }, confirmTimeoutMs);
  }

  private clearConfirmWatchdog() {
    if (this.confirmTimer !== null) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
  }

  /** RT-341: liveness moves only on authenticated (sealed) frames. */
  private markAlive() {
    this.lastSeen = Date.now();
    this.awaitingPong = false;
    this.clearHintVerify();
    this.clearAckWatchdog();
  }

  // EVAL4-F3b: the op-level liveness probe. With the relay alive and the
  // daemon dead the socket stays open, so the client sat "paired" until the
  // 20 s heartbeat noticed (up to ~40-60 s): a message sent in that window
  // showed a pending bubble with no banner until the 60 s request timeout.
  // Every op arms this: no sealed frame within ACK_PROBE_MS → one ping; no
  // sealed pong within ACK_PONG_MS → the socket is dead, reconnect (the op
  // is replayed with the same id after the next handshake). Liveness itself
  // still moves only through markAlive() (RT-341 pin).
  private ackTimer: number | null = null;

  private armAckWatchdog() {
    if (this.ackTimer !== null || this.status !== "paired" || this.intentionalClose) return;
    const sentAt = Date.now();
    this.ackTimer = window.setTimeout(() => {
      this.ackTimer = null;
      if (this.status !== "paired" || this.intentionalClose || this.lastSeen >= sentAt) return;
      this.awaitingPong = true;
      this.sendControl({ type: "ping" });
      this.ackTimer = window.setTimeout(() => {
        this.ackTimer = null;
        if (this.status !== "paired" || this.intentionalClose || this.lastSeen >= sentAt) return;
        this.forceReconnect();
      }, ACK_PONG_MS);
    }, ACK_PROBE_MS);
  }

  private clearAckWatchdog() {
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }

  /** Disarm a pending reconnect-hint verification. */
  private clearHintVerify() {
    this.verifyingHint = false;
    if (this.hintVerifyTimer !== null) {
      clearTimeout(this.hintVerifyTimer);
      this.hintVerifyTimer = null;
    }
  }

  /** Fresh handshake on the given socket, then replay ops that never got a response. */
  private async sendHello(ws: WebSocket) {
    const identity = this.identity ?? (await getOrCreateIdentity());
    const { hello, sessionKey } = await clientHello(this.daemonSpki, identity);
    this.key = sessionKey;
    this.daemonLastSeq = 0;
    // EVAL4-F3c: in-flight ops are NOT replayed here anymore. The daemon
    // handles frames unserialized and yields inside serverAccept before it
    // inserts the session, so a replay sent right behind the hello could land
    // first, find no session and be dropped — the message sent during an
    // outage then "vanished" and timed out after 60 s (pwa-live j4a). Their
    // timers are paused; replayPending() re-issues them (same ids) once the
    // sealed confirmation proves the session exists.
    // P3-374: "paused" used to mean timer-less — an op caught mid-rehandshake
    // (its response lost under the old session key) had NO deadline while the
    // handshake churned through backoffs, and a listing op sat on the board's
    // skeletons for the whole window (desktop-flow P1-089 evidence: the
    // backend saw the request, the client never answered). Arm a bounded
    // grace ONCE per limbo epoch — re-arming on every hello would push the
    // deadline out as long as the churn lasts. If the confirm+replay doesn't
    // resolve the op in time, it rejects like any timeout and the caller's
    // error/retry path takes over.
    for (const [id, p] of this.pending.entries()) {
      if (p.graced) continue;
      clearTimeout(p.timer);
      p.graced = true;
      p.timer = window.setTimeout(() => {
        // identity guard: replay() replaces the map entry for the same id —
        // only the stale grace timer must die with it
        if (this.pending.get(id) !== p) return;
        this.pending.delete(id);
        p.reject(new Error("request timeout"));
      }, PENDING_REHANDSHAKE_GRACE_MS);
    }
    ws.send(
      JSON.stringify({
        room: this.room,
        from: this.from,
        payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
      }),
    );
    this.helloSent = true;
  }

  /** EVAL4-F3c: re-issue every op that never got a response on the fresh
   * session. Same op id across replays: the daemon dedupes prompt sends by
   * id, so a replayed prompt can never reach the agent twice. */
  private replayPending() {
    const retrying = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, p] of retrying) this.replay(p, id);
  }

  /**
   * Bug 1: terminal expiry — stop every timer and reconnect attempt and
   * surface "expired" so the shell can show the pair-again card. Nothing is
   * wiped here; wipeLocalIdentity() runs only on the user's button.
   * EVAL4-F2: "rejected" takes the same exit. Before, a not-allowed answer
   * left the confirm watchdog armed, so a revoked tab re-dialed every ~16-30 s
   * for as long as it lived (the client half of today's pairing loop).
   */
  private expire() {
    this.intentionalClose = true;
    this.stopAllTimers();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(REAUTH_ERROR));
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {}
    this.setStatus("expired");
  }

  /** EVAL4-F2: same exit as expire() for a sealed not-allowed answer. */
  private rejectSession() {
    this.intentionalClose = true;
    this.stopAllTimers();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(REJECTED_ERROR));
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {}
    this.setStatus("rejected");
  }

  /** Every timer that could dial again: heartbeat, confirm watchdog, hint verify, backoff. */
  private stopAllTimers() {
    this.reauthPending = false;
    this.stopHeartbeat();
    this.clearConfirmWatchdog();
    this.clearHintVerify();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * EVAL4-F3: the initial dial gave up (timeout / closed) — this client must
   * not keep dialing behind the error screen. Before, the relay dial's 15 s
   * timeout closed the socket and the close handler scheduled a reconnect:
   * an orphan client kept dialing forever, and could even pair silently
   * (eating the daemon's bootstrap window) while the screen showed an error.
   */
  private abandon() {
    this.intentionalClose = true;
    this.stopAllTimers();
    try {
      this.ws.close();
    } catch {}
  }

  /**
   * RT-341 hint verification, shared by the clear `reconnect` hint and the
   * Bug 1 reauth hint while paired: ping over the current session and only
   * rehandshake when no sealed frame answers in time. This is the ONLY place
   * that may call rehandshake() (pinned by scripts/unit.test.ts).
   */
  private verifyHint() {
    const v = hintVerdict(
      {
        verifying: this.verifyingHint,
        rehandshaking: this.rehandshaking,
        lastRehandshakeAt: this.lastRehandshakeAt,
      },
      Date.now(),
    );
    if (v !== "verify") return;
    this.verifyingHint = true;
    this.sendControl({ type: "ping" });
    this.hintVerifyTimer = window.setTimeout(() => {
      this.hintVerifyTimer = null;
      this.verifyingHint = false;
      this.lastRehandshakeAt = Date.now();
      void this.rehandshake();
    }, RECONNECT_HINT_VERIFY_MS);
  }

  /** Re-run the handshake after a daemon restart and replay in-flight ops. */
  private async rehandshake() {
    if (this.rehandshaking) return;
    this.rehandshaking = true;
    try {
      this.setStatus("connecting");
      await this.sendHello(this.ws);
      // EVAL4-F3: a rehandshake whose hello is lost (daemon mid-restart,
      // relay drop) used to sit in "connecting" forever — heartbeat and the
      // visibility handler both bail while not paired. Same watchdog as a dial.
      this.armConfirmWatchdog(this.transport === "local" ? 3_000 : 15_000);
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

  /** Re-issue a pending op on the fresh session, keeping the caller's promise.
   * `reuseId` keeps the original op id so the daemon can dedupe replays. */
  private replay(
    p: {
      resolve: (r: OpResponse) => void;
      reject: (e: Error) => void;
      args: {
        method: OpRequestMethod;
        path: string;
        body?: unknown;
        query?: Record<string, string>;
        timeoutMs: number;
      };
    },
    reuseId?: string,
  ) {
    const req: OpRequest = {
      id: reuseId ?? crypto.randomUUID(),
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
    this.armAckWatchdog(); // EVAL4-F3b
  }

  private setStatus(s: Status) {
    // EVAL4-F4: stamp the start of an outage once; cleared on the next confirm.
    if (s === "paired") this.disconnectedAt = 0;
    else if (this.disconnectedAt === 0) this.disconnectedAt = Date.now();
    this.status = s;
    if (s === "paired") {
      this.reconnectAttempt = 0;
      this.reauthPending = false;
      // Bug 1: a confirmed handshake clears every refused-hello strike.
      this.reauthStrikes = 0;
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
    let frame: { from?: string; seq?: number; payload?: string };
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame.from || frame.from === this.from || !frame.payload) return;

    let clearType: ReturnType<typeof readClearControl> = null;
    try {
      clearType = readClearControl(JSON.parse(atob(frame.payload)));
    } catch {
      // not a clear control frame; falls through to the sealed path
    }
    const verdict = classifyFrame({
      from: frame.from,
      self: this.from,
      room: this.room,
      clearType,
      status: this.status,
    });
    if (verdict === "ignore" || verdict === "pong-clear") return;

    // RT-341: a clear `reconnect` is an unauthenticated hint (the room id
    // leaks, `from` is forgeable) — verify with a ping over the current
    // session and only rehandshake when no sealed frame answers in time.
    if (verdict === "hint") {
      this.verifyHint();
      return;
    }

    // Bug 1: the daemon could not authenticate us. Paired → same verify path
    // as the hint (a forged frame costs one ping). Connecting after our hello
    // → the hello was refused: one fresh dial, then the expired verdict.
    if (verdict === "reauth") {
      const action = reauthFrameAction(this.status, this.helloSent);
      if (action === "verify") {
        this.verifyHint();
      } else if (action === "grace") {
        // EVAL4-F5: never a strike on the frame alone (forgeable). Shorten
        // the confirm watchdog; the strike lands only if nothing sealed
        // confirms inside the grace window (armConfirmWatchdog decides).
        this.reauthPending = true;
        this.armConfirmWatchdog(REAUTH_CONFIRM_GRACE_MS);
      }
      return;
    }

    // first message from the daemon is the handshake confirmation
    if (verdict === "confirm") {
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
          if (check) this.markAlive();
          // EVAL4-F2: sealed not-allowed (proves the daemon) → terminal, no
          // more dials; the shell shows the "device removed" card.
          if (check?.reason === "not-allowed") this.rejectSession();
        } else if (confirm.ok && confirm.confirm) {
          const check = await openSealed<{
            ok: boolean;
            caps?: { transcribe?: boolean };
          }>(confirm.confirm, this.key, new TextEncoder().encode("ocr-confirm"));
          if (check?.ok) {
            this.markAlive();
            this.caps = check.caps ?? {};
            this.setStatus("paired");
            this.replayPending(); // EVAL4-F3c: the session provably exists now
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
      { type: "res"; res: OpResponse } | { type: "res-chunk"; chunk: ResChunk } | { type: "event"; event: EventEnvelope } | { type: "pong" }
    >(frame.payload, this.key, seqAad(frame.from, seq));
    if (!env) return;
    this.daemonLastSeq = seq;
    this.markAlive();
    if (env.type === "pong") return;
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
      this.armAckWatchdog(); // EVAL4-F3b
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
    this.clearHintVerify();
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
          if (err instanceof Error && err.message === REJECTED_ERROR) throw err;
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
        client.helloSent = true;
      };
      const fail = (err: Error) => {
        clearTimeout(timeout);
        client.abandon(); // this socket's auto-reconnect is not wanted
        reject(err);
      };
      const timeout = setTimeout(() => fail(new Error("local daemon unreachable")), 3_000);
      client.onStatus = (s) => {
        if (s === "paired") {
          clearTimeout(timeout);
          resolve(client);
        } else if (s === "rejected") {
          clearTimeout(timeout);
          reject(new Error(REJECTED_ERROR)); // EVAL4-F2: localized by the shell
        } else if (s === "expired") {
          clearTimeout(timeout);
          reject(new Error(REAUTH_ERROR));
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

      // EVAL4-F3: the dial timeout re-arms (bounded) while a reauth exchange
      // is in flight — a refused hello is answered within seconds and must
      // end in the expired verdict, not in "pairing timeout". On a genuine
      // timeout the client is abandoned so no orphan keeps dialing behind
      // the error screen.
      let extensions = 0;
      let timeout: ReturnType<typeof setTimeout>;
      const armTimeout = () => {
        timeout = setTimeout(() => {
          if (
            (client.reauthPending || client.reauthStrikes > 0) &&
            !client.intentionalClose &&
            extensions++ < DIAL_TIMEOUT_REAUTH_EXTENSIONS
          ) {
            armTimeout();
            return;
          }
          client.abandon();
          reject(new Error("pairing timeout — is the daemon running?"));
        }, 15_000);
      };
      armTimeout();

      ws.onopen = () => {
        // presence + hello in one clear-JSON control frame
        ws.send(
          JSON.stringify({
            room: pairing.room,
            from,
            payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))),
          }),
        );
        client.helloSent = true;
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
          reject(new Error(REJECTED_ERROR)); // EVAL4-F2: localized by the shell
        } else if (s === "expired") {
          clearTimeout(timeout);
          reject(new Error(REAUTH_ERROR));
        } else if (s === "closed") {
          clearTimeout(timeout);
          reject(new Error("connection closed before pairing"));
        }
      };
    });
  }
}
