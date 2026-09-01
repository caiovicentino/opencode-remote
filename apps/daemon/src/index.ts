import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync, readdirSync, openSync, readSync, closeSync, appendFileSync, copyFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import JSON5 from "json5";
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
import { metrics, startMetricsServer, VERSION } from "./metrics.js";
import { loadRoutines, saveRoutines, type Routine } from "./routines.js";
import { artifactMime, kindFor, listArtifacts, readArtifact } from "./artifacts.js";

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
  autoMode?: boolean;
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

/** security-relevant events, append-only JSONL the user can review in the app */
function audit(event: string, data?: Record<string, unknown>) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...(data ? { data } : {}),
    });
    appendFileSync(join(STATE_DIR, "audit.log"), line + "\n");
  } catch {}
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

// Initialized at the top of main() before any handler registers (top-level
// await is unavailable: the desktop sidecar bundles this file to single-file
// CJS, apps/desktop/scripts/bundle-daemon.mjs).
let daemon: DaemonIdentity;

// user-editable settings (name, notifications) persisted in the state file
let appSettings: AppSettings;

// local whisper transcription (optional; scripts/setup-whisper.sh installs it)
let whisperTool: WhisperTool | null = null;

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
  autoMode: boolean;
}

function readSettings(): AppSettings {
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<IdentityFile>;
  return {
    name: raw.name,
    notify: { permission: true, idle: true, ...(raw.notify ?? {}) },
    autoMode: raw.autoMode === true,
  };
}

function writeSettings(s: AppSettings) {
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<IdentityFile>;
  raw.name = s.name;
  raw.notify = s.notify;
  raw.autoMode = s.autoMode;
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
    const b = (req.body ?? {}) as {
      name?: string;
      prompt?: string;
      hour?: number;
      minute?: number;
      mode?: string;
      days?: number[];
      intervalMinutes?: number;
    };
    const name = (b.name ?? "").trim().slice(0, 40);
    const prompt = (b.prompt ?? "").trim();
    const mode = b.mode === "days" || b.mode === "interval" ? b.mode : "daily";
    if (!name || !prompt) {
      return { id: req.id, status: 400, body: { error: "name and prompt required" } };
    }
    let hour = Number(b.hour);
    let minute = Number(b.minute);
    let days: number[] | undefined;
    let intervalMinutes: number | undefined;
    if (mode === "interval") {
      intervalMinutes = Number(b.intervalMinutes);
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 10080) {
        return { id: req.id, status: 400, body: { error: "intervalMinutes must be 5..10080" } };
      }
      hour = Number.isInteger(hour) ? hour : 0;
      minute = Number.isInteger(minute) ? minute : 0;
    } else {
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        return { id: req.id, status: 400, body: { error: "valid hour/minute required" } };
      }
      if (mode === "days") {
        days = Array.isArray(b.days)
          ? [...new Set(b.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
          : [];
        if (!days.length) return { id: req.id, status: 400, body: { error: "days required for mode=days" } };
      }
    }
    const routine: Routine = { id: randomUUID(), name, prompt, hour, minute, mode, days, intervalMinutes };
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

  // --- artifacts: agent-produced documents (P1-010) ---------------------------
  // listing
  if (req.path === "/__ocr/artifacts" && req.method === "GET") {
    const sessionId = req.query?.session || undefined;
    metrics.inc("ocr_artifacts_list_total");
    return { id: req.id, status: 200, body: { artifacts: listArtifacts(sessionId) } };
  }
  // content of a single artifact (base64; the tunnel chunks oversized bodies)
  if (req.path === "/__ocr/artifact" && req.method === "GET") {
    const sessionId = req.query?.session ?? "";
    const name = req.query?.name ?? "";
    const buf = readArtifact(sessionId, name);
    if (!buf) return { id: req.id, status: 404, body: { error: "artifact not found" } };
    metrics.inc("ocr_artifacts_read_total");
    return {
      id: req.id,
      status: 200,
      body: {
        name,
        sessionId,
        kind: kindFor(name),
        mime: artifactMime(name),
        size: buf.length,
        data: buf.toString("base64"),
      },
    };
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
  if (req.path === "/__ocr/audit" && req.method === "GET") {
    try {
      const lines = readFileSync(join(STATE_DIR, "audit.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-100);
      return { id: req.id, status: 200, body: { entries: lines.map((l) => JSON.parse(l)) } };
    } catch {
      return { id: req.id, status: 200, body: { entries: [] } };
    }
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
    audit("client.revoked", { pub: pub.slice(0, 16) });
    return { id: req.id, status: 200, body: { ok: true } };
  }
  if (req.path === "/__ocr/settings" && req.method === "GET") {
    return { id: req.id, status: 200, body: { ...readSettings(), version: VERSION } };
  }
  if (req.path === "/__ocr/settings" && req.method === "PATCH") {
    const b = req.body as { name?: string; notify?: Partial<NotifySettings>; autoMode?: boolean };
    const s = readSettings();
    if (typeof b.name === "string" && b.name.trim()) s.name = b.name.trim().slice(0, 40);
    if (b.notify) s.notify = { ...s.notify, ...b.notify };
    if (typeof b.autoMode === "boolean") s.autoMode = b.autoMode;
    writeSettings(s);
    appSettings = s;
    machineName = s.name || MACHINE_NAME;
    audit("settings.updated", { autoMode: s.autoMode });
    return { id: req.id, status: 200, body: s };
  }
  // --- MCP manager: read/write the mcp section of the opencode config -------
  if (req.path === "/__ocr/mcp" && req.method === "GET") {
    const { servers, configFile } = readMcpConfig();
    return { id: req.id, status: 200, body: { servers, configFile } };
  }
  if (req.path === "/__ocr/mcp" && req.method === "PUT") {
    const b = req.body as {
      name?: string;
      remove?: boolean;
      config?: { type?: string; command?: string[]; url?: string; enabled?: boolean };
    };
    if (!b.name || !/^[a-zA-Z0-9_-]+$/.test(b.name)) {
      return { id: req.id, status: 400, body: { error: "valid name required" } };
    }
    try {
      const { file } = mcpConfigPaths();
      const parsed = readMcpConfigJson(file);
      const mcp = (parsed.mcp ?? {}) as Record<string, unknown>;
      if (b.remove) delete mcp[b.name];
      else {
        const cfg = b.config ?? {};
        if (cfg.type === "remote" && !cfg.url) {
          return { id: req.id, status: 400, body: { error: "url required for remote servers" } };
        }
        if (cfg.type === "local" && (!cfg.command || cfg.command.length === 0)) {
          return { id: req.id, status: 400, body: { error: "command required for local servers" } };
        }
        mcp[b.name] = { enabled: true, ...cfg };
      }
      parsed.mcp = mcp;
      if (existsSync(file)) {
        copyFileSync(file, `${file}.bak-mcp-${Date.now()}`);
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(parsed, null, 2));
      audit("mcp.updated", { name: b.name, remove: b.remove === true });
      const { servers } = readMcpConfig();
      return { id: req.id, status: 200, body: { ok: true, servers } };
    } catch (err) {
      return { id: req.id, status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  // --- export a session as a markdown file the phone can save ----------------
  if (req.path === "/__ocr/export" && req.method === "POST") {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId || !sessionId.startsWith("ses")) {
      return { id: req.id, status: 400, body: { error: "sessionId required" } };
    }
    try {
      const res = await fetch(new URL(`/session/${sessionId}/message`, OPENCODE_URL), {
        headers: authHeader ? { authorization: authHeader } : {},
      });
      if (!res.ok) return { id: req.id, status: 502, body: { error: `opencode ${res.status}` } };
      const rows = (await res.json()) as {
        info?: { role?: string };
        parts?: {
          type: string;
          text?: string;
          tool?: string;
          state?: { title?: string; output?: string };
        }[];
      }[];
      const lines: string[] = [];
      let title = "";
      for (const row of rows) {
        for (const part of row.parts ?? []) {
          if (part.type === "text" && part.text?.trim()) {
            const role = row.info?.role === "user" ? "👤 Você" : "🤖 Agente";
            if (row.info?.role === "user" && !title) title = part.text.trim().slice(0, 60);
            lines.push(`## ${role}`, "", part.text.trim(), "");
          } else if (part.type === "tool" && part.tool) {
            const out = (part.state?.output ?? "").replace(/\s+/g, " ").slice(0, 300);
            lines.push(`> 🔧 **${part.tool}**${part.state?.title ? ` — ${part.state.title}` : ""}${out ? `\n> \`${out}\`` : ""}`, "");
          }
        }
      }
      if (!title) title = "Conversa";
      const when = new Date().toLocaleString("pt-BR", { timeZone: "America/Bahia" });
      const md = [`# ${title}`, "", `_${when} (GMT-3)_`, "", ...lines].join("\n");
      const dir = join(STATE_DIR, "uploads");
      mkdirSync(dir, { recursive: true });
      const name = `conversa-${sessionId.slice(-8)}.md`;
      const path = join(dir, name);
      writeFileSync(path, md);
      audit("session.exported", { sessionId });
      return { id: req.id, status: 200, body: { path, name } };
    } catch (err) {
      return {
        id: req.id,
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  // --- handoff: open this session in Terminal on the Mac ---------------------
  if (req.path === "/__ocr/handoff" && req.method === "POST") {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId || !sessionId.startsWith("ses")) {
      return { id: req.id, status: 400, body: { error: "sessionId required" } };
    }
    try {
      const res = await fetch(new URL(`/session/${sessionId}`, OPENCODE_URL), {
        headers: authHeader ? { authorization: authHeader } : {},
      });
      if (!res.ok) return { id: req.id, status: 502, body: { error: `opencode ${res.status}` } };
      const info = (await res.json()) as { directory?: string; path?: string };
      const dir = info.directory || info.path;
      if (!dir) return { id: req.id, status: 404, body: { error: "session directory unknown" } };
      const script = `tell application "Terminal"
  activate
  do script "cd ${dir.replace(/"/g, '\\"')} && opencode -s ${sessionId}"
end tell`;
      await promisify(execFile)("osascript", ["-e", script]);
      log("info", "session handed off to desktop", { sessionId, dir });
      audit("session.handoff", { sessionId, dir });
      return { id: req.id, status: 200, body: { ok: true, dir } };
    } catch (err) {
      return {
        id: req.id,
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
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
    const maxBytes = (Number(process.env.OCR_UPLOAD_MAX_MB) || 200) * 1_000_000;
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
  lastSeen: number; // last sealed frame received (stale sweep)
}

const sessions = new Map<string, ClientSession>();

// --- scheduled routines: daemon fires prompts and ships results to the phone -
let routines = loadRoutines();
const pendingRuns = new Map<string, string>(); // sessionID -> routineID

async function fireRoutine(r: Routine) {
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
    r.lastRun = undefined;
    r.lastFiredAt = undefined;
    saveRoutines(routines);
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
    if (!text) throw new Error("no assistant text produced");
    const dir = join(STATE_DIR, "uploads");
    mkdirSync(dir, { recursive: true });
    const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 30);
    const path = join(dir, `${new Date().toISOString().slice(0, 10)}-${slug || "routine"}.md`);
    writeFileSync(path, text);
    r.lastSessionID = undefined;
    r.lastStatus = "ok";
    r.lastError = undefined;
    saveRoutines(routines);
    void pushToSubscribers(`⏰ ${r.name} pronto`, "Rotina concluída — toque para ver/salvar o arquivo", {
      url: "#/files",
    });
    log("info", "routine completed", { routine: r.name, path, bytes: text.length });
  } catch (err) {
    r.lastSessionID = undefined;
    r.lastStatus = "error";
    r.lastError = (err as Error).message.slice(0, 200);
    saveRoutines(routines);
    void pushToSubscribers(
      `⏰ ${r.name} falhou`,
      `Rotina com erro: ${r.lastError} — roda de novo amanhã ou recria a rotina`,
      { url: "#/" },
    );
    log("warn", "routine completion failed", { error: (err as Error).message });
  }
}

async function failRoutine(routineId: string, sessionID: string, why: string) {
  const r = routines.find((x) => x.id === routineId);
  if (!r || !pendingRuns.has(sessionID)) return;
  pendingRuns.delete(sessionID);
  r.lastSessionID = undefined;
  r.lastStatus = "error";
  r.lastError = why.slice(0, 200);
  saveRoutines(routines);
  void pushToSubscribers(`⏰ ${r.name} falhou`, `Erro do agent: ${why.slice(0, 120)}`, { url: "#/" });
  log("warn", "routine run errored", { routine: r.name, why });
}

function checkRoutines() {
  const now = new Date();
  const today = now.toLocaleDateString("sv"); // local YYYY-MM-DD
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dow = now.getDay();
  for (const r of routines) {
    if (r.lastSessionID) continue; // a run is already in flight
    const mode = r.mode ?? "daily";
    if (mode === "interval") {
      const every = Math.max(5, r.intervalMinutes ?? 60) * 60_000;
      if (r.lastFiredAt && Date.now() - r.lastFiredAt < every) continue;
      r.lastFiredAt = Date.now();
      saveRoutines(routines);
      void fireRoutine(r);
      continue;
    }
    if (r.lastRun === today) continue;
    if (mode === "days" && !(r.days ?? []).includes(dow)) continue;
    if (nowMin < r.hour * 60 + r.minute) continue;
    r.lastRun = today;
    saveRoutines(routines);
    void fireRoutine(r);
  }
}

// retry pending routine completions after a restart
for (const r of loadRoutines()) {
  if (r.lastSessionID) pendingRuns.set(r.lastSessionID, r.id);
}
setInterval(checkRoutines, 30_000);
setTimeout(checkRoutines, 10_000);

// watchdog: tell the phone when the agent server goes down (and back up)
let opencodeHealthy = true;
metrics.gauge("ocr_opencode_healthy", 1);
setInterval(() => {
  void (async () => {
    let healthy: boolean;
    try {
      const res = await fetch(new URL("/global/health", OPENCODE_URL), {
        headers: authHeader ? { authorization: authHeader } : {},
      });
      const body = (await res.json().catch(() => ({}))) as { healthy?: boolean };
      healthy = res.ok && body.healthy !== false;
    } catch {
      healthy = false;
    }
    metrics.gauge("ocr_opencode_healthy", healthy ? 1 : 0);
    if (healthy !== opencodeHealthy) {
      opencodeHealthy = healthy;
      void pushToSubscribers(
        healthy ? "opencode is back ✅" : "opencode is DOWN ⛔",
        healthy
          ? `Agent server reachable again on ${machineName}`
          : `Agent server unreachable on ${machineName} — chats will fail until it's back`,
        { url: "#/" },
      );
      log("warn", "opencode health flipped", { healthy });
    }
  })();
}, 60_000);

// stale client sessions (phone reloaded, new `from` id) get swept
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [from, s] of sessions) {
    if (s.lastSeen < cutoff) {
      sessions.delete(from);
      metrics.gauge("ocr_sessions_active", sessions.size);
      audit("client.session.expired", { pub: s.pub.slice(0, 16) });
    }
  }
}, 300_000);

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

const autoApproved = new Map<string, number>();

/**
 * AutoMode: answer an opencode permission ask with "once" on the user's behalf,
 * tell connected clients (synthetic event so the PWA clears its ask UI) and
 * optionally push a notification. Best-effort: failures just keep the ask
 * pending so the user can still approve manually.
 */
async function autoApprove(sessionID: string, permissionID: string, action: string) {
  const now = Date.now();
  if (now - (autoApproved.get(permissionID) ?? 0) < 120_000) return;
  autoApproved.set(permissionID, now);
  for (const [k, v] of autoApproved) if (now - v > 600_000) autoApproved.delete(k);
  try {
    const res = await fetch(
      new URL(`/session/${sessionID}/permissions/${permissionID}`, OPENCODE_URL),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        body: JSON.stringify({ response: "once" }),
      },
    );
    if (!res.ok) {
      autoApproved.delete(permissionID);
      log("warn", "auto-approve rejected by opencode", { status: res.status, action });
      return;
    }
    log("info", "permission auto-approved", { sessionID, permissionID, action });
    audit("permission.auto", { sessionID, permissionID, action });
    broadcast({
      type: "event",
      event: {
        id: randomUUID(),
        type: "ocr.permission.auto",
        properties: { sessionID, permissionID, action },
      },
    });
    if (appSettings.notify.permission) {
      void pushToSubscribers("Auto-approved", `${action} on ${machineName} (AutoMode)`, {
        url: `#/session/${sessionID}`,
      });
    }
  } catch (err) {
    autoApproved.delete(permissionID);
    log("warn", "auto-approve error", { err: err instanceof Error ? err.message : String(err) });
  }
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
            const permProps = (evt.properties ?? {}) as {
              type?: string;
              id?: string;
              permissionID?: string;
            };
            const permId = permProps.permissionID ?? permProps.id ?? "";
            const isAsk = t.includes("permission") && !t.includes("response") && !t.includes("revoke");
            if (isAsk && sessionID && permId && appSettings.autoMode) {
              void autoApprove(sessionID, permId, permProps.type ?? "action");
            } else if (t.includes("permission") && appSettings.notify.permission) {
              void pushToSubscribers(
                "Approve needed",
                `opencode wants to ${permProps.type ?? "perform an action"} on ${machineName}`,
                {
                  url: sessionID ? `#/session/${sessionID}` : "#/",
                  evt,
                  actions: [
                    { action: "open", title: "Review" },
                  ],
                },
              );
            } else if (evt.type === "question.asked" && appSettings.notify.permission) {
              void pushToSubscribers("Question from agent", `The agent has a question on ${machineName}`, {
                url: sessionID ? `#/session/${sessionID}` : "#/",
                actions: [{ action: "open", title: "Answer" }],
              });
            } else if (evt.type === "session.error") {
              const rid = pendingRuns.get(sessionID);
              if (rid) {
                const errObj = ((evt.properties ?? {}) as { error?: { message?: string; name?: string } })
                  .error;
                void failRoutine(rid, sessionID, errObj?.message ?? errObj?.name ?? "unknown error");
              }
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
  session.lastSeen = Date.now();
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
        audit("client.paired", { pub: accepted.clientPub.slice(0, 16), bootstrap: true });
        log("info", "bootstrap client persisted", { pub: accepted.clientPub.slice(0, 16) });
      }
      if (!client) {
        audit("client.rejected", { pub: accepted.clientPub.slice(0, 16) });
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
        lastSeen: Date.now(),
      });
      log("info", "client paired", {
        pub: accepted.clientPub.slice(0, 16),
        activeSessions: sessions.size,
      });
      audit("client.connected", { pub: accepted.clientPub.slice(0, 16) });
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

// --- MCP config (opencode.jsonc/json in ~/.config/opencode) -----------------

function mcpConfigPaths() {
  const dir = join(homedir(), ".config", "opencode");
  return { dir, file: join(dir, "opencode.jsonc"), jsonFile: join(dir, "opencode.json") };
}

function readMcpConfigJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON5.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {}; // unparseable config — report empty rather than crash
  }
}

function readMcpConfig() {
  const { file, jsonFile } = mcpConfigPaths();
  const configFile = existsSync(file) ? file : jsonFile;
  const parsed = readMcpConfigJson(configFile);
  const servers = Object.entries((parsed.mcp as Record<string, Record<string, unknown>>) ?? {}).map(
    ([name, cfg]) => ({
      name,
      type: (cfg.type as string) ?? "local",
      command: cfg.command as string[] | undefined,
      url: cfg.url as string | undefined,
      enabled: cfg.enabled !== false,
    }),
  );
  return { servers, configFile };
}

// ---------------------------------------------------------------------------
// local HTTP API (127.0.0.1 only) — the public SDK talks to this
// ---------------------------------------------------------------------------

function apiToken(): string {
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { apiToken?: string };
  if (raw.apiToken) return raw.apiToken;
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  raw.apiToken = token;
  writeFileSync(STATE_FILE, JSON.stringify(raw, null, 2));
  chmodSync(STATE_FILE, 0o600);
  log("info", "api token generated (see apiToken in daemon.json)");
  return token;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function send401(res: ServerResponse) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized — Authorization: Bearer <apiToken from daemon.json>" }));
}

// Dashboard static file. The packaged desktop sidecar runs a single-file CJS
// bundle where esbuild empties `import.meta` (CJS has no import.meta), so the
// source-relative URL below would throw and /dashboard would answer 500. The
// bundler (apps/desktop/scripts/bundle-daemon.mjs) therefore ships
// dashboard.html next to the bundle and the bundle resolves it via __dirname;
// source checkouts (ESM, no __dirname) keep the repo-relative URL.
function dashboardFile(): string | URL {
  if (typeof __dirname !== "undefined") return join(__dirname, "dashboard.html");
  return new URL("../../../apps/pilot/dashboard/index.html", import.meta.url);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  // GET /dashboard — pilot three.js mission control (static file, no secrets inside)
  if (req.method === "GET" && url.pathname === "/dashboard") {
    try {
      const html = readFileSync(dashboardFile(), "utf8").replace("__APITOKEN__", apiToken());
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("dashboard file missing");
    }
    return true;
  }
  if (!url.pathname.startsWith("/api/")) return false;
  const expected = `Bearer ${apiToken()}`;
  if (req.headers.authorization !== expected) {
    send401(res);
    return true;
  }
  const op = async (method: string, path: string, body?: unknown) =>
    proxy({ id: randomUUID(), method, path, body } as OpRequest);
  const seg = url.pathname.split("/").filter(Boolean); // ["api", "session", ...]
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };  try {
    // GET /api/health
    if (req.method === "GET" && seg[1] === "health") {
      send(200, {
        healthy: true,
        version: VERSION,
        machine: machineName,
        opencodeHealthy: metrics.get("ocr_opencode_healthy") === 1,
        relayConnected: metrics.get("ocr_relay_connected") === 1,
      });
      return true;
    }
    // /api/session…
    if (seg[1] === "mcp" && (req.method === "GET" || req.method === "PUT")) {
      const body = req.method === "PUT" ? JSON.parse((await readBody(req)) || "{}") : undefined;
      const r = await op(req.method, "/__ocr/mcp", body);
      send(r.status, r.body);
      return true;
    }
    // GET /api/pilot-log?n=300 — tail of the raw pilot.log (JSONL) for the log viewer
    if (seg[1] === "pilot-log") {
      const n = Math.min(Number(new URL(req.url || "/", "http://x").searchParams.get("n") || 400), 2000);
      let lines: string[] = [];
      try {
        lines = readFileSync(join(homedir(), ".opencode-remote", "logs", "pilot.log"), "utf8")
          .split("\n")
          .filter(Boolean)
          .slice(-n);
      } catch {}
      send(200, { lines });
      return true;
    }
    // GET /api/pilot-done — completed tasks from BACKLOG.md (## Done section)
    if (seg[1] === "pilot-done") {
      let done: { id: string; title: string }[] = [];
      try {
        const md = readFileSync(new URL("../../../BACKLOG.md", import.meta.url), "utf8");
        const section = md.split("\n## Done\n")[1] ?? "";
        done = section
          .split("\n")
          .filter((l) => l.startsWith("- [x]"))
          .map((l) => {
            const m = l.match(/\(([P\d][\w.-]*)\)\s*\[.*?\]\s*([^—]+)/);
            return { id: m?.[1] ?? "?", title: (m?.[2] ?? l).trim() };
          });
      } catch {}
      send(200, { done });
      return true;
    }
    // GET /api/pilot-ready — pending queue from BACKLOG.md (## Ready + ## Blocked)
    if (seg[1] === "pilot-ready") {
      let ready: { id: string; title: string; area: string }[] = [];
      let blocked: { id: string; title: string; area: string }[] = [];
      try {
        const md = readFileSync(new URL("../../../BACKLOG.md", import.meta.url), "utf8");
        const parse = (chunk: string) =>
          chunk
            .split("\n")
            .filter((l) => l.startsWith("- [ ]"))
            .map((l) => {
              const m = l.match(/\(([P\d][\w.-]*)\)\s*\[.*?\]\s*([^—]+)/);
              const area = (l.match(/\(area:\s*(\w+)\)/)?.[1] ?? "").toLowerCase();
              return { id: m?.[1] ?? "?", title: (m?.[2] ?? l).trim(), area };
            });
        ready = parse(md.split("\n## Ready\n")[1] ?? md.split("## Ready\n")[1] ?? "");
        blocked = parse(md.split("\n## Blocked\n")[1] ?? "");
      } catch {}
      send(200, { ready, blocked });
      return true;
    }
    // POST /api/pilot-budget — edit daily budgets from the dashboard
    if (seg[1] === "pilot-budget" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        maxTasksPerDay?: number;
        maxDeploysPerDay?: number;
      };
      const file = join(homedir(), ".opencode-remote", "pilot.json");
      try {
        const cfg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        if (Number.isFinite(body.maxTasksPerDay) && (body.maxTasksPerDay as number) > 0)
          cfg.maxTasksPerDay = body.maxTasksPerDay;
        if (Number.isFinite(body.maxDeploysPerDay) && (body.maxDeploysPerDay as number) > 0)
          cfg.maxDeploysPerDay = body.maxDeploysPerDay;
        writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        send(200, { cfg });
      } catch (err) {
        send(500, { error: String(err) });
      }
      return true;
    }
    // POST /api/pilot-notify — wake the supervisor session after a pipeline result
    if (seg[1] === "pilot-notify" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { text?: string };
      let delivered = false;
      try {
        const sup = (
          JSON.parse(readFileSync(join(homedir(), ".opencode-remote", "pilot.json"), "utf8")) as {
            supervisorSession?: string;
          }
        ).supervisorSession;
        if (sup && body.text) {
          const res = await fetch(new URL(`/session/${sup}/message`, OPENCODE_URL), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authHeader ? { authorization: authHeader } : {}),
            },
            body: JSON.stringify({ parts: [{ type: "text", text: body.text }] }),
          });
          delivered = res.ok;
        }
      } catch {}
      send(200, { delivered });
      return true;
    }
    // GET/POST /api/pilot-mission — the north-star statement shown on the dash
    if (seg[1] === "pilot-mission") {
      const file = join(homedir(), ".opencode-remote", "pilot.json");
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { mission?: string };
        try {
          const cfg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
          cfg.mission = String(body.mission ?? "").slice(0, 500);
          writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
          send(200, { mission: cfg.mission });
        } catch (err) {
          send(500, { error: String(err) });
        }
        return true;
      }
      try {
        const cfg = JSON.parse(readFileSync(file, "utf8")) as { mission?: string };
        send(200, { mission: cfg.mission ?? "" });
      } catch {
        send(200, { mission: "" });
      }
      return true;
    }
    // GET /api/pilot-events — dashboard feed: state, heartbeat freshness, event tail
    if (seg[1] === "pilot-events") {
      const dir = join(homedir(), ".opencode-remote", "pilot");
      let events: unknown[] = [];
      try {
        events = readFileSync(join(dir, "events.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .slice(-200)
          .map((l) => JSON.parse(l));
      } catch {}
      let state: unknown = {};
      let heartbeatMs: number | null = null;
      try {
        state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
      } catch {}
      try {
        heartbeatMs = Date.now() - Number(readFileSync(join(dir, "heartbeat"), "utf8"));
      } catch {}
      let cfg: unknown = {};
      try {
        cfg = JSON.parse(readFileSync(join(homedir(), ".opencode-remote", "pilot.json"), "utf8"));
      } catch {}
      let lastAux: Record<string, string> = {};
      try {
        const tail = readFileSync(join(homedir(), ".opencode-remote", "logs", "pilot.log"), "utf8")
          .split("\n")
          .filter(Boolean)
          .slice(-400);
        for (const line of tail) {
          if (!line.includes("researcher") && !line.includes("strategist")) continue;
          try {
            const j = JSON.parse(line) as { msg?: string; ts?: string };
            if (typeof j.msg !== "string" || typeof j.ts !== "string") continue;
            if (/researcher/i.test(j.msg)) lastAux.researcher = j.ts;
            if (/strategist/i.test(j.msg)) lastAux.strategist = j.ts;
          } catch {}
        }
      } catch {}
      send(200, { state, heartbeatMs, events, cfg, lastAux });
      return true;
    }
    // GET /api/artifacts?session=… — list agent artifacts (P1-010)
    if (seg[1] === "artifacts" && seg[2] === "file" && req.method === "GET") {
      const session = url.searchParams.get("session") ?? "";
      const name = url.searchParams.get("name") ?? "";
      const buf = readArtifact(session, name);
      if (!buf) {
        send(404, { error: "artifact not found" });
        return true;
      }
      metrics.inc("ocr_artifacts_read_total");
      // html/svg artifacts are agent-authored active content: never render them
      // in the daemon's origin — sandbox CSP + force download
      const kind = kindFor(name);
      const active = kind === "html" || name.toLowerCase().endsWith(".svg");
      res.writeHead(200, {
        "content-type": artifactMime(name),
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "content-disposition": `${active ? "attachment" : "inline"}; filename="${name.replace(/"/g, "")}"`,
      });
      res.end(buf);
      return true;
    }
    if (seg[1] === "artifacts" && req.method === "GET") {
      metrics.inc("ocr_artifacts_list_total");
      send(200, { artifacts: listArtifacts(url.searchParams.get("session") ?? undefined) });
      return true;
    }
    if (seg[1] !== "session") {
      // POST /api/push — authenticated digest push (used by the pilot loop)
      if (seg[1] === "push" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          title?: string;
          body?: string;
          url?: string;
        };
        if (!body.title || !body.body) {
          send(400, { error: "title and body required" });
          return true;
        }
        await pushToSubscribers(body.title, body.body, { url: body.url ?? "#/" });
        send(200, { ok: true, delivered: loadSubscriptions().length });
        return true;
      }
      send(404, { error: "unknown route" });
      return true;
    }
    if (req.method === "GET" && !seg[2]) {
      send(200, (await op("GET", "/session")).body);
      return true;
    }
    if (req.method === "POST" && !seg[2]) {
      const body = JSON.parse((await readBody(req)) || "{}") as { title?: string };
      send(200, (await op("POST", "/session", { title: body.title })).body);
      return true;
    }
    const sessionId = seg[2] ?? "";
    if (!sessionId.startsWith("ses")) {
      send(400, { error: "bad session id" });
      return true;
    }
    if (req.method === "GET" && !seg[3]) {
      send(200, (await op("GET", `/session/${sessionId}`)).body);
      return true;
    }
    if (req.method === "DELETE" && !seg[3]) {
      send(200, (await op("DELETE", `/session/${sessionId}`)).body);
      return true;
    }
    if (req.method === "GET" && seg[3] === "messages") {
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const rows = ((await op("GET", `/session/${sessionId}/message`)).body ?? []) as unknown[];
      send(200, rows.slice(-limit));
      return true;
    }
    if (req.method === "POST" && seg[3] === "message") {
      const body = JSON.parse((await readBody(req)) || "{}") as { text?: string };
      if (!body.text) {
        send(400, { error: "text required" });
        return true;
      }
      const r = await op("POST", `/session/${sessionId}/message`, {
        parts: [{ type: "text", text: body.text }],
      });
      send(r.status === 200 ? 202 : r.status, { accepted: r.status === 200, opencode: r.body });
      return true;
    }
    send(404, { error: "unknown route" });
    return true;
  } catch (err) {
    send(500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

async function main() {
  // Async module state first (see note at the declarations): identity, settings
  // and whisper detection must be ready before anything is served or sent.
  daemon = await loadIdentity();

  webpush.setVapidDetails(
    process.env.OCR_VAPID_SUBJECT ?? "https://github.com/caiovicentino/opencode-remote",
    daemon.vapid.publicKey,
    daemon.vapid.privateKey,
  );

  appSettings = readSettings();
  machineName = appSettings.name || MACHINE_NAME;

  whisperTool = await detectWhisper();
  if (whisperTool) log("info", "voice transcription available", { kind: whisperTool.kind });
  else log("info", "voice transcription unavailable (optional feature)");

  log("info", "daemon starting (protocol v2)", {
    machine: machineName,
    opencode: OPENCODE_URL,
    relay: RELAY_URL,
    pairedClients: readAllowlist().length,
  });

  const metricsPort = Number(process.env.OCR_METRICS_PORT);
  if (metricsPort) startMetricsServer(metricsPort, handleApi);

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
