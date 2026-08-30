import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  rejectPayload,
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
import { detectWhisper, transcribeAudio, type WhisperTool } from "./whisper.js";
import { metrics, startMetricsServer } from "./metrics.js";
import { loadRoutines, saveRoutines, type Routine } from "./routines.js";

const RELAY_URL = process.env.RELAY_URL ?? "ws://127.0.0.1:8787";
const OPENCODE_URL = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const OPENCODE_USER = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const OPENCODE_PASS = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const MACHINE_NAME = process.env.OCR_MACHINE_NAME ?? "my-machine";
let machineName = MACHINE_NAME;

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
  name?: string;
  notify?: { permission?: boolean; idle?: boolean };
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

// user-editable settings (name, notifications) persisted in the state file
let appSettings = readSettings();
machineName = appSettings.name || MACHINE_NAME;

// local whisper transcription (optional; scripts/setup-whisper.sh installs it)
const whisperTool: WhisperTool | null = await detectWhisper();
if (whisperTool) log("info", "voice transcription available", { kind: whisperTool.kind });
else log("info", "voice transcription unavailable (optional feature)");

interface UploadEntry {
  parts: string[];
  at: number;
}
const uploadChunks = new Map<string, UploadEntry>();
const uploads = new Map<string, { buf: Buffer; mime: string; filename: string; at: number }>();

// ---------------------------------------------------------------------------
// tunnel to the local opencode server
// ---------------------------------------------------------------------------

const authHeader = OPENCODE_PASS
  ? `Basic ${Buffer.from(`${OPENCODE_USER}:${OPENCODE_PASS}`).toString("base64")}`
  : undefined;

interface NotifySettings {
  permission: boolean;
  idle: boolean;
}
interface AppSettings {
  name?: string;
  notify: NotifySettings;
}

function readSettings(): AppSettings {
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<IdentityFile>;
  return { name: raw.name, notify: { permission: true, idle: true, ...(raw.notify ?? {}) } };
}

function writeSettings(s: AppSettings) {
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<IdentityFile>;
  raw.name = s.name;
  raw.notify = s.notify;
  writeFileSync(STATE_FILE, JSON.stringify(raw, null, 2));
  chmodSync(STATE_FILE, 0o600);
}

// --- file delivery: which paths the phone may download ----------------------
const DOWNLOAD_ROOTS = [
  join(STATE_DIR, "uploads"),
  join(homedir(), "Desktop"),
  join(homedir(), "Downloads"),
  join(homedir(), "Documents"),
  resolve("."),
].map((r) => resolve(r));
const downloads = new Map<string, { path: string; size: number; at: number }>();

function accessibleDownload(p: string): string | null {
  const abs = resolve(p);
  return DOWNLOAD_ROOTS.some((r) => abs === r || abs.startsWith(r + "/")) ? abs : null;
}

async function proxy(req: OpRequest): Promise<OpResponse> {
  // daemon-local endpoints never reach opencode
  if (req.path === "/__ocr/clip-style" && req.method === "GET") {
    const p = join(STATE_DIR, "clip-style.json");
    return {
      id: req.id,
      status: 200,
      body: existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {},
    };
  }
  if (req.path === "/__ocr/clip-style" && req.method === "PUT") {
    writeFileSync(join(STATE_DIR, "clip-style.json"), JSON.stringify(req.body ?? {}, null, 2));
    return { id: req.id, status: 200, body: { ok: true } };
  }

  // --- push diagnostics: the user fixes delivery from the app itself ---------
  if (req.path === "/__ocr/push/status" && req.method === "GET") {
    return {
      id: req.id,
      status: 200,
      body: { subscribers: loadSubscriptions().length, last: lastPushResult },
    };
  }
  if (req.path === "/__ocr/push/test" && req.method === "POST") {
    const results = await pushDiagnostics();
    return { id: req.id, status: 200, body: { results } };
  }

  // --- one-tap skills: saved prompts rendered as chips in the composer -------
  if (req.path === "/__ocr/skills" && req.method === "GET") {
    return { id: req.id, status: 200, body: { skills: loadSkills() } };
  }
  if (req.path === "/__ocr/skills" && req.method === "POST") {
    const b = (req.body ?? {}) as { label?: string; prompt?: string };
    const label = (b.label ?? "").trim().slice(0, 40);
    const prompt = (b.prompt ?? "").trim().slice(0, 4000);
    if (!label || !prompt) {
      return { id: req.id, status: 400, body: { error: "label and prompt required" } };
    }
    const skill: Skill = { id: randomUUID(), label, prompt };
    const skills = loadSkills();
    skills.push(skill);
    saveSkills(skills);
    return { id: req.id, status: 200, body: { skill } };
  }
  if (req.path === "/__ocr/skills" && req.method === "DELETE") {
    const { id } = (req.body ?? {}) as { id?: string };
    saveSkills(loadSkills().filter((s) => s.id !== id));
    return { id: req.id, status: 200, body: { ok: true } };
  }

  // --- scheduled routines -----------------------------------------------------
  if (req.path === "/__ocr/routines" && req.method === "GET") {
    return { id: req.id, status: 200, body: { routines } };
  }  if (req.path === "/__ocr/routines" && req.method === "POST") {
    const b = (req.body ?? {}) as { name?: string; prompt?: string; hour?: number; minute?: number };
    const name = (b.name ?? "").trim().slice(0, 40);
    const prompt = (b.prompt ?? "").trim();
    const hour = Number(b.hour);
    const minute = Number(b.minute);
    if (!name || !prompt || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      return { id: req.id, status: 400, body: { error: "name, prompt and valid hour/minute required" } };
    }
    const routine: Routine = { id: randomUUID(), name, prompt, hour, minute };
    routines.push(routine);
    saveRoutines(routines);
    return { id: req.id, status: 200, body: { routine } };
  }
  if (req.path === "/__ocr/routines" && req.method === "DELETE") {
    const { id } = (req.body ?? {}) as { id?: string };
    routines = routines.filter((r) => r.id !== id);
    saveRoutines(routines);
    return { id: req.id, status: 200, body: { ok: true } };
  }

  // --- file delivery: the agent hands artifacts back to the phone ------------
  if (req.path === "/__ocr/files" && req.method === "GET") {
    const files: { path: string; name: string; size: number; mtime: number }[] = [];
    for (const root of DOWNLOAD_ROOTS) {
      let entries: string[] = [];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const name of entries) {
        const full = join(root, name);
        try {
          const st = statSync(full);
          if (st.isFile()) files.push({ path: full, name, size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return { id: req.id, status: 200, body: { files: files.slice(0, 30) } };
  }
  if (req.path === "/__ocr/download/start" && req.method === "POST") {
    const { path: p } = (req.body ?? {}) as { path?: string };
    const abs = p ? accessibleDownload(p) : null;
    if (!abs) return { id: req.id, status: 403, body: { error: "path not allowed" } };
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      return { id: req.id, status: 404, body: { error: "file not found" } };
    }
    const id = randomUUID();
    downloads.set(id, { path: abs, size, at: Date.now() });
    for (const [k, v] of downloads) {
      if (Date.now() - v.at > 30 * 60_000) downloads.delete(k);
    }
    metrics.inc("ocr_downloads_total");
    return { id: req.id, status: 200, body: { id, size, chunks: Math.max(1, Math.ceil(size / 500_000)) } };
  }
  if (req.path === "/__ocr/download/chunk" && req.method === "GET" && req.query) {
    log("debug", "chunk request", { query: req.query, mapSize: downloads.size });
    const d = downloads.get(req.query.id ?? "");
    if (!d) return { id: req.id, status: 404, body: { error: "download expired; start a new one" } };
    let fd: number;
    try {
      fd = openSync(d.path, "r");
    } catch {
      return { id: req.id, status: 404, body: { error: "file gone" } };
    }
    const buf = Buffer.alloc(500_000);
    const read = readSync(fd, buf, 0, 500_000, Number(req.query.idx ?? 0) * 500_000);
    closeSync(fd);
    return { id: req.id, status: 200, body: { data: buf.subarray(0, read).toString("base64") } };
  }
  if (req.path === "/__ocr/devices" && req.method === "GET") {
    return { id: req.id, status: 200, body: { devices: readAllowlist() } };
  }
  if (req.path === "/__ocr/devices" && req.method === "DELETE") {
    const { pub } = req.body as { pub?: string };
    if (!pub) return { id: req.id, status: 400, body: { error: "pub required" } };
    saveAllowlist(readAllowlist().filter((c) => c.pub !== pub));
    for (const [from, s] of sessions) {
      if (s.pub === pub) {
        sessions.delete(from);
        s.socket.close();
      }
    }
    log("info", "device revoked via app", { pub: pub.slice(0, 16) });
    return { id: req.id, status: 200, body: { ok: true } };
  }
  if (req.path === "/__ocr/settings" && req.method === "GET") {
    return { id: req.id, status: 200, body: readSettings() };
  }
  if (req.path === "/__ocr/settings" && req.method === "PATCH") {
    const b = req.body as { name?: string; notify?: Partial<NotifySettings> };
    const s = readSettings();
    if (typeof b.name === "string" && b.name.trim()) s.name = b.name.trim().slice(0, 40);
    if (b.notify) s.notify = { ...s.notify, ...b.notify };
    writeSettings(s);
    appSettings = s;
    machineName = s.name || MACHINE_NAME;
    return { id: req.id, status: 200, body: s };
  }
  if (req.path === "/__ocr/transcribe/chunk" && req.method === "POST") {
    const { id, idx, data } = req.body as { id?: string; idx?: number; data?: string };
    if (!id || idx === undefined || typeof data !== "string") {
      return { id: req.id, status: 400, body: { error: "invalid chunk" } };
    }
    const entry = uploadChunks.get(id) ?? { parts: [], at: 0 };
    entry.parts[idx] = data;
    entry.at = Date.now();
    uploadChunks.set(id, entry);
    for (const [k, v] of uploadChunks) {
      if (Date.now() - v.at > 5 * 60_000) uploadChunks.delete(k);
    }    return { id: req.id, status: 200, body: { ok: true } };
  }
  if (req.path === "/__ocr/transcribe" && req.method === "POST") {
    const { id } = req.body as { id?: string };
    const entry = id ? uploadChunks.get(id) : undefined;
    uploadChunks.delete(id ?? "");
    if (!entry || !whisperTool) {
      return {
        id: req.id,
        status: 501,
        body: { error: "transcription unavailable; run scripts/setup-whisper.sh on the host" },
      };
    }
    try {
      const parts = entry.parts.filter(Boolean);
      const wav = Buffer.concat(parts.map((b) => Buffer.from(b, "base64")));
      const t0 = Date.now();
      const text = await transcribeAudio(whisperTool, wav, req.body as { lang?: string });
      metrics.inc("ocr_transcriptions_total");
      metrics.inc("ocr_transcribe_ms_total", Date.now() - t0);
      return { id: req.id, status: 200, body: { text } };
    } catch (err) {
      metrics.inc("ocr_transcription_failures_total");
      return { id: req.id, status: 500, body: { error: String(err instanceof Error ? err.message : err) } };
    }
  }
  if (req.path === "/__ocr/upload/chunk" && req.method === "POST") {
    const { id, idx, data } = req.body as { id?: string; idx?: number; data?: string };
    if (!id || idx === undefined || typeof data !== "string") {
      return { id: req.id, status: 400, body: { error: "invalid chunk" } };
    }
    const entry = uploadChunks.get(id) ?? { parts: [], at: 0 };
    entry.parts[idx] = data;
    entry.at = Date.now();
    uploadChunks.set(id, entry);
    return { id: req.id, status: 200, body: { ok: true } };
  }
  if (req.path === "/__ocr/upload/complete" && req.method === "POST") {
    const { id, mime, filename, kind } = req.body as {
      id?: string;
      mime?: string;
      filename?: string;
      kind?: "inline" | "file";
    };
    const entry = id ? uploadChunks.get(id) : undefined;
    uploadChunks.delete(id ?? "");
    if (!entry) return { id: req.id, status: 404, body: { error: "upload not found" } };
    const buf = Buffer.concat(entry.parts.filter(Boolean).map((b) => Buffer.from(b, "base64")));
    const maxBytes = (Number(process.env.OCR_UPLOAD_MAX_MB) || 20) * 1_000_000;
    if (buf.length > maxBytes) {
      return { id: req.id, status: 413, body: { error: `file too large (${maxBytes / 1e6}MB limit)` } };
    }
    if (kind === "file") {
      // full artifact (e.g. video): persist for the agent to inspect with tools
      const dir = join(STATE_DIR, "uploads");
      mkdirSync(dir, { recursive: true });
      const safe = (filename ?? "upload.bin").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
      const path = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
      writeFileSync(path, buf);
      metrics.inc("ocr_files_persisted_total");
      log("info", "file attachment persisted", { path, bytes: buf.length });
      return { id: req.id, status: 200, body: { path } };
    }
    uploads.set(id!, { buf, mime: mime ?? "image/jpeg", filename: filename ?? "image.jpg", at: Date.now() });
    metrics.inc("ocr_uploads_completed_total");
    log("info", "attachment registered", { id: id!.slice(0, 8), bytes: buf.length, kind: kind ?? "inline" });
    for (const [k, v] of uploads) {
      if (Date.now() - v.at > 30 * 60_000) uploads.delete(k);
    }
    return { id: req.id, status: 200, body: { url: `ocr-upload://${id}` } };
  }

  // resolve image attachments into data URLs before opencode sees them
  if (req.method === "POST" && /^\/session\/[^/]+\/message$/.test(req.path)) {
    const body = req.body as { parts?: { url?: string; mime?: string; filename?: string }[] };
    if (Array.isArray(body?.parts)) {
      for (const p of body.parts) {
          const m = typeof p?.url === "string" ? /^(?:ocr-upload:\/\/)+(.+)$/.exec(p.url) : null;
        if (!m) continue;
        const up = uploads.get(m[1]!);
        if (!up) {
          log("warn", "attachment expired on send", { uploadId: m[1]!.slice(0, 8) });
          return { id: req.id, status: 410, body: { error: "attachment expired; attach again" } };
        }
        p.url = `data:${up.mime};base64,${up.buf.toString("base64")}`;
        p.mime = p.mime || up.mime;
        p.filename = p.filename || up.filename;
        uploads.delete(m[1]!);
      }
    }
  }
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
    // /provider ships ~6MB of model metadata (208 providers) — far beyond the
    // relay's 1MB frame limit. Slim it to what the PWA needs before sealing.
    if (res.ok && req.method === "GET" && req.path === "/provider") {
      const j = body as {
        all?: {
          id: string;
          name?: string;
          models?: Record<string, { id?: string; name?: string }>;
        }[];
      };
      if (j?.all) {
        body = {
          all: j.all.map((p) => ({
            id: p.id,
            name: p.name,
            models: Object.fromEntries(
              Object.entries(p.models ?? {}).map(([k, m]) => [k, { id: m.id ?? k, name: m.name }]),
            ),
          })),
        };
      }
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

// --- one-tap skills: saved prompts rendered as chips in the composer --------
interface Skill {
  id: string;
  label: string;
  prompt: string;
}

function skillsFile(): string {
  return join(STATE_DIR, "skills.json");
}

function loadSkills(): Skill[] {
  try {
    return JSON.parse(readFileSync(skillsFile(), "utf8")) as Skill[];
  } catch {
    return [];
  }
}

function saveSkills(s: Skill[]) {
  writeFileSync(skillsFile(), JSON.stringify(s, null, 2));
  chmodSync(skillsFile(), 0o600);
}

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
  process.env.OCR_VAPID_SUBJECT ?? "https://github.com/caiovicentino/opencode-remote",
  daemon.vapid.publicKey,
  daemon.vapid.privateKey,
);

interface PushAttempt {
  endpoint: string;
  ok: boolean;
  status?: number;
  error?: string;
}
let lastPushResult: { at: number; results: PushAttempt[] } | null = null;

async function pushToSubscribers(title: string, body: string, data?: unknown) {
  const subs = loadSubscriptions();
  const dead: string[] = [];
  const results: PushAttempt[] = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title, body, data }), {
        TTL: 3600,
        urgency: "high",
      });
      results.push({ endpoint: sub.endpoint, ok: true });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const message = (err as Error).message;
      results.push({ endpoint: sub.endpoint, ok: false, status, error: message });
      if (status === 404 || status === 410) dead.push(sub.endpoint);
      else log("warn", "push delivery failed", { error: message });
    }
  }
  if (dead.length) saveSubscriptions(subs.filter((s) => !dead.includes(s.endpoint)));
  lastPushResult = { at: Date.now(), results };
}

// in-app push diagnostics: the user must be able to see WHY it fails
async function pushDiagnostics() {
  const subs = loadSubscriptions();
  const res: PushAttempt[] = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title: "opencode-remote", body: "Test notification — push works 🎉" }), { TTL: 300 });
      res.push({ endpoint: sub.endpoint, ok: true });
    } catch (err) {
      res.push({
        endpoint: sub.endpoint,
        ok: false,
        status: (err as { statusCode?: number }).statusCode,
        error: (err as Error).message,
      });
    }
  }
  lastPushResult = { at: Date.now(), results: res };
  return res;
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

// --- scheduled routines: daemon fires prompts and ships results to the phone -
let routines = loadRoutines();
const pendingRuns = new Map<string, string>(); // sessionID -> routineID

async function fireRoutine(r: Routine, today: string) {
  try {
    const headers = { "content-type": "application/json", ...(authHeader ? { authorization: authHeader } : {}) };
    const created = (await (
      await fetch(new URL("/session", OPENCODE_URL), {
        method: "POST",
        headers,
        body: JSON.stringify({ title: `⏰ ${r.name}` }),
      })
    ).json()) as { id?: string };
    if (!created.id) throw new Error("session create failed");
    r.lastRun = today;
    r.lastSessionID = created.id;
    saveRoutines(routines);
    pendingRuns.set(created.id, r.id);
    await fetch(new URL(`/session/${created.id}/message`, OPENCODE_URL), {
      method: "POST",
      headers,
      body: JSON.stringify({ parts: [{ type: "text", text: r.prompt }] }),
    });
    log("info", "routine fired", { routine: r.name, session: created.id });
  } catch (err) {
    log("warn", "routine fire failed", { routine: r.name, error: (err as Error).message });
  }
}

async function completeRoutine(routineId: string, sessionID: string) {
  const r = routines.find((x) => x.id === routineId);
  pendingRuns.delete(sessionID);
  if (!r) return;
  try {
    await new Promise((res) => setTimeout(res, 2000)); // let opencode persist parts
    const res = await fetch(new URL(`/session/${sessionID}/message`, OPENCODE_URL), {
      headers: authHeader ? { authorization: authHeader } : {},
    });
    const rows = (await res.json()) as {
      info?: { role?: string };
      parts?: { type: string; text?: string }[];
    }[];
    const lastAssistant = [...rows].reverse().find((x) => x.info?.role === "assistant");
    const text = (lastAssistant?.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (!text) return;
    const dir = join(STATE_DIR, "uploads");
    mkdirSync(dir, { recursive: true });
    const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 30);
    const path = join(dir, `${new Date().toISOString().slice(0, 10)}-${slug || "routine"}.md`);
    writeFileSync(path, text);
    r.lastSessionID = undefined;
    saveRoutines(routines);
    void pushToSubscribers(`⏰ ${r.name} pronto`, "Rotina concluída — toque para ver/salvar o arquivo", {
      url: "#/files",
    });
    log("info", "routine completed", { routine: r.name, path, bytes: text.length });
  } catch (err) {
    log("warn", "routine completion failed", { error: (err as Error).message });
  }
}

function checkRoutines() {
  const now = new Date();
  const today = now.toLocaleDateString("sv"); // local YYYY-MM-DD
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const r of routines) {
    if (r.lastRun === today) continue;
    if (nowMin < r.hour * 60 + r.minute) continue;
    void fireRoutine(r, today);
  }
}

// retry pending routine completions after a restart
for (const r of loadRoutines()) {
  if (r.lastSessionID) pendingRuns.set(r.lastSessionID, r.id);
}
setInterval(checkRoutines, 30_000);
setTimeout(checkRoutines, 10_000);

// relay frames are capped at 1MB; keep a safety margin for the sealed payload
const SAFE_PAYLOAD = 900_000;
// oversized bodies travel split across several sealed frames
const CHUNK_BODY = 600_000;
const MAX_CHUNKS = 512; // ~300MB ceiling on a single response

async function sealAndSend(session: ClientSession, env: DaemonEnvelope) {
  metrics.inc(env.type === "event" ? "ocr_event_frames_total" : "ocr_res_frames_total");
  const seq = ++session.sendSeq;
  let payload: string;
  try {
    payload = await seal(env, session.key, seqAad(daemon.room, seq));
  } catch (err) {
    metrics.inc("ocr_seal_failures_total");
    log("error", "seal failed", { error: (err as Error).message });
    return;
  }
  metrics.inc("ocr_sealed_bytes_total", payload.length);
  if (session.socket.readyState === WebSocket.OPEN) {
    session.socket.send(
      JSON.stringify({ room: daemon.room, from: daemon.room, seq, payload } satisfies RelayFrame),
    );
  }
}

async function sendToSession(session: ClientSession, env: DaemonEnvelope) {
  if (env.type === "res") {
    const serialized = JSON.stringify(env.res.body ?? null);
    if (serialized.length > SAFE_PAYLOAD) {
      const of = Math.ceil(serialized.length / CHUNK_BODY);
      if (of > MAX_CHUNKS) {
        await sealAndSend(session, {
          type: "res",
          res: {
            id: env.res.id,
            status: 413,
            body: { error: `response too large (${serialized.length} bytes) for the tunnel` },
          },
        });
        return;
      }
      for (let i = 0; i < of; i++) {
        await sealAndSend(session, {
          type: "res-chunk",
          chunk: { id: env.res.id, status: env.res.status, i, of, part: serialized.slice(i * CHUNK_BODY, (i + 1) * CHUNK_BODY) },
        });
      }
      return;
    }
  }
  await sealAndSend(session, env);
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
            const sessionID = ((evt.properties ?? {}) as { sessionID?: string }).sessionID ?? "";
            if (t.includes("permission") && appSettings.notify.permission) {
              const p = (evt.properties ?? {}) as { type?: string };
              void pushToSubscribers(
                "Approve needed",
                `opencode wants to ${p.type ?? "perform an action"} on ${machineName}`,
                { url: sessionID ? `#/session/${sessionID}` : "#/", evt },
              );
            } else if (evt.type === "session.idle") {
              const rid = pendingRuns.get(sessionID);
              if (rid) void completeRoutine(rid, sessionID);
              if (appSettings.notify.idle)
                void pushToSubscribers("Agent finished", `Session idle on ${machineName}`, {
                  url: sessionID ? `#/session/${sessionID}` : "#/",
                });
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
    log("warn", "sealed frame from unknown session; asking client to re-handshake", {
      from: frame.from,
    });
    metrics.inc("ocr_reconnects_asked_total");
    // daemon restart or stale client: tell the client to re-run the handshake
    ws.send(
      JSON.stringify({
        room: daemon.room,
        from: daemon.room,
        payload: b64(Buffer.from(JSON.stringify({ type: "reconnect" }))),
      } satisfies RelayFrame),
    );
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
  metrics.inc("ocr_ops_total");
  await proxy(envelope.req)
    .then((res) => {
      if (res.status >= 400) metrics.inc("ocr_ops_errors_total");
      sendToSession(session, { type: "res", res });
    })
    .catch((err) => {
      metrics.inc("ocr_ops_errors_total");
      sendToSession(session, {
        type: "res",
        res: { id: envelope.req.id, status: 500, body: { error: String(err) } },
      });
    });
}

interface HelloMsg {
  type: "hello" | "ping" | "pong";
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
    if (maybeControl?.type === "ping") {
      isControl = true;
      // liveness probe: pong when the session is known, otherwise ask for a
      // fresh handshake (daemon restarted while the client stayed up)
      const reply = sessions.has(frame.from) ? { type: "pong" } : { type: "reconnect" };
      ws.send(
        JSON.stringify({
          room: daemon.room,
          from: daemon.room,
          payload: b64(Buffer.from(JSON.stringify(reply))),
        } satisfies RelayFrame),
      );
      return;
    }
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
        const reject = await rejectPayload(accepted.sessionKey, "not-allowed");
        ws.send(
          JSON.stringify({
            room: daemon.room,
            from: daemon.room,
            payload: b64(Buffer.from(JSON.stringify(reject))),
          } satisfies RelayFrame),
        );
        setTimeout(() => ws.close(), 500);
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
      metrics.inc("ocr_handshakes_total");
      metrics.gauge("ocr_sessions_active", sessions.size);
      const confirm = await acceptPayload(accepted.sessionKey, { transcribe: !!whisperTool });
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
    metrics.gauge("ocr_relay_connected", 1);
    metrics.inc("ocr_relay_connects_total");
    ws.send(JSON.stringify({ room: daemon.room, from: daemon.room, payload: "" }));
  });

  ws.on("message", (data) => void handleMessage(data, ws));

  ws.on("close", () => {
    log("warn", "relay connection lost; retrying in 2s");
    metrics.gauge("ocr_relay_connected", 0);
    metrics.gauge("ocr_sessions_active", 0);
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
    machine: machineName,
    opencode: OPENCODE_URL,
    relay: RELAY_URL,
    pairedClients: readAllowlist().length,
  });

  const metricsPort = Number(process.env.OCR_METRICS_PORT);
  if (metricsPort) startMetricsServer(metricsPort);

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
    `&k=${encodeURIComponent(daemon.identity.publicKey)}` +
    `&vapid=${encodeURIComponent(daemon.vapid.publicKey)}` +
    `&name=${encodeURIComponent(machineName)}`;

  console.log(`\n  opencode remote daemon (protocol v2)`);
  console.log(`  machine:  ${machineName}`);
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
