import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

const RELAY_URL = process.env.RELAY_URL ?? "ws://127.0.0.1:8787";
const OPENCODE_URL = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const OPENCODE_USER = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const OPENCODE_PASS = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const MACHINE_NAME = process.env.OCR_MACHINE_NAME ?? "my-machine";

// ---------------------------------------------------------------------------
// identity (protocol v2: ECDH P-256), persisted across restarts
// ---------------------------------------------------------------------------

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
}

async function loadIdentity(): Promise<DaemonIdentity> {
  const dir = join(homedir(), ".opencode-remote");
  const file = join(dir, "daemon.json");
  mkdirSync(dir, { recursive: true });
  let raw: Partial<IdentityFile> = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Partial<IdentityFile>)
    : {};

  if (!raw.ecdhPub || !raw.ecdhPriv) {
    // v1 -> v2 migration (or first run)
    const generated = await newIdentity(true);
    const pkcs8 = await exportPkcs8(generated);
    raw = {
      ...raw,
      ecdhPub: generated.publicKey,
      ecdhPriv: b64(pkcs8),
      vapid: raw.vapid ?? webpush.generateVAPIDKeys(),
    };
    writeFileSync(file, JSON.stringify(raw, null, 2));
  }

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
  return join(homedir(), ".opencode-remote", "subscriptions.json");
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
      else console.warn("[daemon] push failed:", (err as Error).message);
    }
  }
  if (dead.length) saveSubscriptions(subs.filter((s) => !dead.includes(s.endpoint)));
}

// ---------------------------------------------------------------------------
// event forwarding: SSE from opencode -> sealed frames to the client
// ---------------------------------------------------------------------------

let clientSocket: WebSocket | null = null;
let sessionKey: CryptoKey | null = null;
let clientLastSeq = 0; // highest seq accepted from the client (replay guard)
let sendSeq = 0; // monotonically increasing per daemon frame

function sendToClient(env: DaemonEnvelope) {
  if (!clientSocket || !sessionKey || clientSocket.readyState !== WebSocket.OPEN) return;
  const seq = ++sendSeq;
  void seal(env, sessionKey, seqAad(daemon.room, seq)).then((payload) => {
    clientSocket?.send(
      JSON.stringify({
        room: daemon.room,
        from: daemon.room,
        seq,
        payload,
      } satisfies RelayFrame),
    );
  });
}

async function forwardEvents() {
  for (;;) {
    try {
      const url = new URL("/event", OPENCODE_URL);
      const res = await fetch(url, {
        headers: authHeader ? { authorization: authHeader } : {},
      });
      if (!res.body) throw new Error("no body");
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
            sendToClient({
              type: "event",
              event: { id: randomUUID(), type: evt.type, properties: evt.properties },
            });
          } catch {
            // ignore malformed lines
          }
        }
      }
    } catch (err) {
      console.warn(
        "[daemon] event stream error:",
        err instanceof Error ? err.message : err,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------------------------------------------------------------------------
// relay websocket: blind pipe; payloads are opaque ciphertext to the relay
// ---------------------------------------------------------------------------

async function handleSealedFrame(frame: RelayFrame, ws: WebSocket) {
  if (!sessionKey) return;
  const seq = frame.seq ?? 0;
  if (seq <= clientLastSeq) {
    console.warn(`[daemon] replay rejected: seq ${seq} <= ${clientLastSeq}`);
    return;
  }
  const envelope = await openSealed<ClientEnvelope>(
    frame.payload,
    sessionKey,
    seqAad(frame.from, seq),
  );
  if (!envelope || envelope.type !== "op") {
    console.warn(`[daemon] undecryptable frame from ${frame.from} (auth failure)`);
    return;
  }
  clientLastSeq = seq;
  await proxy(envelope.req).then((res) => sendToClient({ type: "res", res }));
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
  console.log(`[daemon] frame from ${frame.from} (${frame.payload?.slice(0, 12)}…)`);

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
        console.warn("[daemon] handshake failed for", frame.from);
        return;
      }
      sessionKey = accepted.sessionKey;
      clientLastSeq = 0;
      sendSeq = 0;
      clientSocket = ws;
      console.log(`[daemon] client paired: ${accepted.clientPub.slice(0, 12)}…`);
      const confirm = await acceptPayload(sessionKey);
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
      console.error("[daemon] handshake error:", err);
      return;
    }
    // not control JSON -> sealed envelope
  }
  await handleSealedFrame(frame, ws);
}

function connectRelay() {
  const ws = new WebSocket(RELAY_URL);

  ws.on("open", () => {
    console.log(`[daemon] connected to relay ${RELAY_URL} (room ${daemon.room})`);
    ws.send(JSON.stringify({ room: daemon.room, from: daemon.room, payload: "" }));
  });

  ws.on("message", (data) => void handleMessage(data, ws));

  ws.on("close", () => {
    console.log("[daemon] relay connection lost; retrying in 2s");
    clientSocket = null;
    sessionKey = null;
    setTimeout(connectRelay, 2000);
  });

  ws.on("error", (err) => console.error("[daemon] relay error:", err.message));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
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
  console.log(`\n  Pair with the PWA by scanning this QR code:\n`);
  console.log(await QRCode.toString(pairingUri, { type: "terminal", small: true }));
  console.log(`  or paste: ${pairingUri}\n`);

  connectRelay();
  void forwardEvents();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
