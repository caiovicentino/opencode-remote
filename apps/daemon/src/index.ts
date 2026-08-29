import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import WebSocket from "ws";
import webpush from "web-push";
import {
  b64,
  fromB64,
  newIdentity,
  importPrivateIdentity,
  exportPkcs8,
  serverAccept,
  acceptPayload,
  seal,
  openSealed,
  seqAad,
  type Identity,
} from "@ocr/protocol";
import type {
  ClientEnvelope,
  DaemonEnvelope,
  OpRequest,
  OpResponse,
  RelayFrame,
} from "@ocr/protocol";
import { log } from "./log.js";

const RELAY_URL = process.env.RELAY_URL ?? "ws://127.0.0.1:8787";
const OPENCODE_URL = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const OPENCODE_USER = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const OPENCODE_PASS = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const MACHINE_NAME = process.env.OCR_MACHINE_NAME ?? "my-machine";

// ---------------------------------------------------------------------------
// identity + client allowlist, persisted with restrictive permissions
// ---------------------------------------------------------------------------

export interface PairedClient {
  pub: string; // client ECDH SPKI base64
  label?: string;
  addedAt: string;
}

interface DaemonIdentity {
  room: string;
  identity: Identity;
  vapid: { publicKey: string; privateKey: string };
}

interface IdentityFile {
  room: string;
  publicKey?: string; // v1 X25519, unused since v2
  secretKey?: string;
  ecdhPub: string;
  ecdhPriv: string; // PKCS8 base64
  vapid: { publicKey: string; privateKey: string };
  clients?: PairedClient[];
}

const STATE_DIR = join(homedir(), ".opencode-remote");
const STATE_FILE = join(STATE_DIR, "daemon.json");

/** Fresh read per handshake: `manage.ts revoke` takes effect instantly. */
function readAllowlist(): PairedClient[] {
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as IdentityFile;
  return raw.clients ?? [];
}

function saveAllowlist(clients: PairedClient[]) {
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as IdentityFile;
  raw.clients = clients;
  writeFileSync(STATE_FILE, JSON.stringify(raw, null, 2));
  chmodSync(STATE_FILE, 0o600);
}

function assertPrivateMode(file: string) {
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) {
    chmodSync(file, 0o600);
    log("warn", "state file permissions tightened to 0600", { file, previousMode: mode.toString(8) });
  }
}

async function loadIdentity(): Promise<DaemonIdentity> {
  const dir = STATE_DIR;
  mkdirSync(dir, { recursive: true });
  let raw: Partial<IdentityFile> = existsSync(STATE_FILE)
    ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<IdentityFile>)
    : {};

  if (!raw.ecdhPub || !raw.ecdhPriv) {
    // v1 -> v2 migration (or first run)
    const generated = await newIdentity(true);
    const pkcs8 = await exportPkcs8(generated);
    raw = {
      ...raw,
      room: raw.room ?? randomUUID().replaceAll("-", ""),
      ecdhPub: generated.publicKey,
      ecdhPriv: b64(pkcs8),
      vapid: raw.vapid ?? webpush.generateVAPIDKeys(),
    };
  }

  writeFileSync(STATE_FILE, JSON.stringify(raw, null, 2));
  chmodSync(STATE_FILE, 0o600);
  assertPrivateMode(STATE_FILE);

  const identity = await importPrivateIdentity(raw.ecdhPub!, fromB64(raw.ecdhPriv!));
  return {
    room: raw.room ?? randomUUID().replaceAll("-", ""),
    identity,
    vapid: raw.vapid ?? webpush.generateVAPIDKeys(),
  };
}

const daemon = await loadIdentity();

// ---------------------------------------------------------------------------
// tunnel to the local opencode server
// ---------------------------------------------------------------------------

const authHeader = OPENCODE_PASS
  ? `Basic ${Buffer.from(`${OPENCODE_USER}:${OPENCODE_PASS}`).toString("base64")}`
  : undefined;

async function proxy(req: OpRequest): Promise<OpResponse> {
  // daemon-local endpoints never reach opencode
  if (req.path === "/__ocr/push-subscription" && req.method === "POST") {
    const sub = req.body as PushSub;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return { id: req.id, status: 400, body: { error: "invalid subscription" } };
    }
    const subs = loadSubscriptions();
    const existing = subs.findIndex((s) => s.endpoint === sub.endpoint);
    if (existing >= 0) subs[existing] = sub;
    else subs.push(sub);
    saveSubscriptions(subs);
    return { id: req.id, status: 200, body: { ok: true } };
  }
  if (req.path === "/__ocr/push-subscription" && req.method === "DELETE") {
    const endpoint = (req.body as { endpoint?: string })?.endpoint;
    saveSubscriptions(loadSubscriptions().filter((s) => s.endpoint !== endpoint));
    return { id: req.id, status: 200, body: { ok: true } };
  }

  const url = new URL(req.path, OPENCODE_URL);
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
  }
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: {
        "content-type": "application/json",
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }
    return { id: req.id, status: res.status, body };
  } catch (err) {
    return {
      id: req.id,
      status: 502,
      body: { error: String(err instanceof Error ? err.message : err) },
    };
  }
}

// ---------------------------------------------------------------------------
// web push: subscriptions arrive through the E2E tunnel (never plaintext)
// ---------------------------------------------------------------------------

interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function subscriptionsFile(): string {
  return join(STATE_DIR, "subscriptions.json");
}

function loadSubscriptions(): PushSub[] {
  const file = subscriptionsFile();
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PushSub[];
  } catch {
    return [];
  }
}

function saveSubscriptions(subs: PushSub[]) {
  writeFileSync(subscriptionsFile(), JSON.stringify(subs, null, 2));
  chmodSync(subscriptionsFile(), 0o600);
}

webpush.setVapidDetails(
  process.env.OCR_VAPID_SUBJECT ?? "mailto:hello@opencode-remote.local",
  daemon.vapid.publicKey,
  daemon.vapid.privateKey,
);

async function pushToSubscribers(title: string, body: string, data?: unknown) {
  const subs = loadSubscriptions();
  const dead: string[] = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title, body, data }), {
        TTL: 3600,
        urgency: "high",
      });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) dead.push(sub.endpoint);
      else log("warn", "push delivery failed", { error: (err as Error).message });
    }
  }
  if (dead.length) saveSubscriptions(subs.filter((s) => !dead.includes(s.endpoint)));
}

// ---------------------------------------------------------------------------
// connected client sessions (multi-device: every paired client gets events)
// ---------------------------------------------------------------------------

interface ClientSession {
  from: string;
  pub: string;
  key: CryptoKey;
  socket: WebSocket;
  lastSeq: number; // highest seq accepted from this client (replay guard)
  sendSeq: number; // monotonically increasing per daemon->client frame
}

const sessions = new Map<string, ClientSession>();

function sendToSession(session: ClientSession, env: DaemonEnvelope) {
  const seq = ++session.sendSeq;
  void seal(env, session.key, seqAad(daemon.room, seq))
    .then((payload) => {
      if (session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(
          JSON.stringify({ room: daemon.room, from: daemon.room, seq, payload } satisfies RelayFrame),
        );
      }
    })
    .catch((err) => log("error", "seal failed", { error: (err as Error).message }));
}

function broadcast(env: DaemonEnvelope) {
  for (const session of sessions.values()) sendToSession(session, env);
}

async function forwardEvents() {
  let attempt = 0;
  for (;;) {
    try {
      const url = new URL("/event", OPENCODE_URL);
      const res = await fetch(url, {
        headers: authHeader ? { authorization: authHeader } : {},
      });
      if (!res.body) throw new Error("no body");
      attempt = 0;
      log("info", "opencode event stream attached");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          try {
            const evt = JSON.parse(json) as { type?: string; properties?: unknown };
            if (!evt.type || evt.type === "server.connected") continue;

            // notable events become push notifications
            const t = evt.type.toLowerCase();
            if (t.includes("permission")) {
              const p = (evt.properties ?? {}) as { type?: string };
              void pushToSubscribers(
                "Approve needed",
                `opencode wants to ${p.type ?? "perform an action"} on ${MACHINE_NAME}`,
                evt.properties,
              );
            } else if (evt.type === "session.idle") {
              void pushToSubscribers("Agent finished", `Session idle on ${MACHINE_NAME}`);
            }
            broadcast({
              type: "event",
              event: { id: randomUUID(), type: evt.type, properties: evt.properties },
            });
          } catch {
            // ignore malformed lines
          }
        }
      }
    } catch (err) {
      log("warn", "event stream error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // exponential backoff with jitter: 2s, 4s, 8s, ... capped at 30s
    const delay = Math.min(30_000, 2000 * 2 ** attempt++) + Math.floor(Math.random() * 1000);
    await new Promise((r) => setTimeout(r, delay));
  }
}

// ---------------------------------------------------------------------------
// relay websocket: blind pipe; payloads are opaque ciphertext to the relay
// ---------------------------------------------------------------------------

async function handleSealedFrame(frame: RelayFrame, ws: WebSocket) {
  const session = sessions.get(frame.from);
  if (!session) {
    log("warn", "sealed frame from unknown session", { from: frame.from });
    return;
  }
  const seq = frame.seq ?? 0;
  if (seq <= session.lastSeq) {
    log("warn", "replay rejected", { from: frame.from, seq, lastSeq: session.lastSeq });
    return;
  }
  const envelope = await openSealed<ClientEnvelope>(
    frame.payload,
    session.key,
    seqAad(frame.from, seq),
  );
  if (!envelope || envelope.type !== "op") {
    log("warn", "undecryptable frame (auth failure)", { from: frame.from });
    return;
  }
  session.lastSeq = seq;
  await proxy(envelope.req).then((res) => sendToSession(session, { type: "res", res }));
}

interface HelloMsg {
  type: "hello";
  hello: Parameters<typeof serverAccept>[0];
}

async function handleMessage(data: WebSocket.RawData, ws: WebSocket) {
  let frame: RelayFrame;
  try {
    frame = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (frame.from === daemon.room) return;
  log("debug", "frame received", { from: frame.from, bytes: frame.payload?.length ?? 0 });

  // control frames carry clear JSON (b64-encoded) with a `type` field
  let isControl = false;
  try {
    const maybeControl = JSON.parse(
      Buffer.from(frame.payload, "base64").toString("utf8"),
    ) as Partial<HelloMsg>;
    if (maybeControl?.type === "hello" && maybeControl.hello) {
      isControl = true;
      const accepted = await serverAccept(maybeControl.hello, daemon.identity);
      if (!accepted) {
        log("warn", "handshake failed", { from: frame.from });
        return;
      }

      // ---- client authorization ------------------------------------------
      // fresh read per handshake: `manage.ts revoke` takes effect instantly.
      // bootstrap: the first QR pairing on a virgin daemon auto-persists;
      // afterwards only clients in the allowlist may connect.
      const allowlist = readAllowlist();
      let client = allowlist.find((c) => c.pub === accepted.clientPub);
      if (!client && allowlist.length === 0) {
        client = { pub: accepted.clientPub, addedAt: new Date().toISOString(), label: "first" };
        allowlist.push(client);
        saveAllowlist(allowlist);
        log("info", "bootstrap client persisted", { pub: accepted.clientPub.slice(0, 16) });
      }
      if (!client) {
        log("warn", "client rejected: not in allowlist", {
          pub: accepted.clientPub.slice(0, 16),
        });
        return;
      }

      sessions.set(frame.from, {
        from: frame.from,
        pub: accepted.clientPub,
        key: accepted.sessionKey,
        socket: ws,
        lastSeq: 0,
        sendSeq: 0,
      });
      log("info", "client paired", {
        pub: accepted.clientPub.slice(0, 16),
        activeSessions: sessions.size,
      });
      const confirm = await acceptPayload(accepted.sessionKey);
      ws.send(
        JSON.stringify({
          room: daemon.room,
          from: daemon.room,
          payload: b64(Buffer.from(JSON.stringify(confirm))),
        } satisfies RelayFrame),
      );
      return;
    }
  } catch (err) {
    if (isControl) {
      log("error", "handshake error", { error: (err as Error).message });
      return;
    }
    // not control JSON -> sealed envelope
  }
  await handleSealedFrame(frame, ws);
}

function connectRelay() {
  const ws = new WebSocket(RELAY_URL);

  ws.on("open", () => {
    log("info", "connected to relay", { relay: RELAY_URL, room: daemon.room });
    ws.send(JSON.stringify({ room: daemon.room, from: daemon.room, payload: "" }));
  });

  ws.on("message", (data) => void handleMessage(data, ws));

  ws.on("close", () => {
    log("warn", "relay connection lost; retrying in 2s");
    sessions.clear();
    setTimeout(connectRelay, 2000);
  });

  ws.on("error", (err) => log("error", "relay error", { error: err.message }));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  log("info", "daemon starting (protocol v2)", {
    machine: MACHINE_NAME,
    opencode: OPENCODE_URL,
    relay: RELAY_URL,
    pairedClients: readAllowlist().length,
  });

  // boot healthcheck: fail loudly early if opencode is unreachable
  try {
    const res = await fetch(new URL("/global/health", OPENCODE_URL), {
      headers: authHeader ? { authorization: authHeader } : {},
    });
    const body = (await res.json()) as { healthy?: boolean; version?: string };
    log("info", "opencode healthcheck", { status: res.status, ...body });
  } catch (err) {
    log("warn", "opencode unreachable at boot (will keep retrying events)", {
      opencode: OPENCODE_URL,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const pairingUri =
    `opencode-remote://pair?v=2` +
    `&relay=${encodeURIComponent(RELAY_URL)}` +
    `&room=${daemon.room}` +
    `&k=${daemon.identity.publicKey}` +
    `&vapid=${daemon.vapid.publicKey}` +
    `&name=${encodeURIComponent(MACHINE_NAME)}`;

  console.log(`\n  opencode remote daemon (protocol v2)`);
  console.log(`  machine:  ${MACHINE_NAME}`);
  console.log(`  opencode: ${OPENCODE_URL}`);
  console.log(`  relay:    ${RELAY_URL}`);
  console.log(`  clients:  ${readAllowlist().length} paired`);
  console.log(`\n  Pair with the PWA by scanning this QR code:\n`);
  console.log(await QRCode.toString(pairingUri, { type: "terminal", small: true }));
  console.log(`  or paste: ${pairingUri}\n`);

  connectRelay();
  void forwardEvents();
}

main().catch((err) => {
  log("error", "fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
