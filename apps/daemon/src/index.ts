import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, statSync, lstatSync, readdirSync, openSync, readSync, closeSync, copyFileSync, createReadStream, accessSync, constants, rmSync, statfs } from "node:fs";
import { stat } from "node:fs/promises";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import type { Socket as NetSocket } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve, dirname } from "node:path";
import JSON5 from "json5";
import { randomBytes, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import WebSocket, { WebSocketServer } from "ws";
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
  speakBrief,
} from "@ocr/protocol";
import type {
  ClientEnvelope,
  DaemonEnvelope,
  OpRequest,
  OpResponse,
  RelayFrame,
} from "@ocr/protocol";
import { log } from "./log.js";
import { IdempotencyCache } from "./idempotency.js";
import { writeStateAtomic } from "./statefile.js";
import { identityVerdict, quarantineName } from "./identityfile.js";
import {
  backupContentVerdict,
  backupName,
  backupWritePlan,
  IDENTITY_BACKUP_RESTORED_LOG,
  identityRecoveryPlan,
} from "./identitybackup.js";
import { appendAudit, readAuditTail } from "./auditlog.js";
import { capMessagePage, parsePageLimit, shouldPaginateMessages, type HistoryRowLike } from "./paginate.js";
import { handleBrowse } from "./browse.js";
import {
  avgDoneDuration,
  buildCards,
  builderLogPath,
  listShots,
  progressOf,
  readForensicIndex,
  shotsForTask,
  shotPath,
  takeoverFromBuilderLog,
  validateTakeoverDirectory,
  validateTakeoverSessionId,
} from "./pilotforensic.js";
import { detectWhisperDetail, transcribeAudio, type WhisperTool } from "./whisper.js";
import { sttVerdict } from "./voicecap.js";
import { modelReadyVerdict, providerSummary, type ProviderSummary } from "./modelready.js";
import { MIN_OPENCODE_VERSION, versionVerdict, type OpencodeVersionVerdict } from "./opencodever.js";
import { parseReadinessKnobs, readinessRefreshPlan } from "./readiness.js";
import { cachedSpeech, detectEdgeTts, prewarmSpeech, putSpeech, resolveVoice, synthesizeSpeech, TTS_VOICES } from "./edgetts.js";
import { spokenNumbers, SPEECH_LANGS } from "./spoken.js";
import { metrics, startMetricsServer, VERSION } from "./metrics.js";
import { loadRoutines, saveRoutines, type Routine } from "./routines.js";
import { ARTIFACTS_ROOT, artifactMime, capArtifacts, kindFor, listArtifacts, readArtifact, sessionTitleMap } from "./artifacts.js";
import { RETENTION_INTERVAL_MS, retentionDisabled, retentionPlan, type RetentionEntry } from "./artifactretention.js";
import { parseUploadRetention, uploadRetentionPlan, type UploadEntry as UploadFile } from "./uploadretention.js";
import { clipRetentionPlan, parseClipRetention, type ClipGroup } from "./clipretention.js";
import { diskVerdict, type DiskVerdict } from "./diskguard.js";
import { docConvertProbe, docConvertVerdict, type DocConvertVerdict } from "./doccap.js";
import { WindowCache, contextPct, sessionTokenTotal } from "./contextgauge.js";
import { ArtifactWatcher } from "./artifactwatch.js";
import { createShutdown, stopAccepting } from "./shutdown.js";
import { localUpgradeAllowed } from "./localws.js";
import { createRelayRetry } from "./relayretry.js";
import { classifyRelayClose, effectiveRetryDelayMs, type RelayCloseKind } from "./relayclose.js";
import { relayDialVerdict, type RelayDialKind } from "./relaydialerror.js";
import { parseRelayUrl, redactRelayUrl } from "./relayurl.js";
import { bodyLimit, isBodyLimitError, readLimitedBody, type BodyLimitError } from "./bodylimit.js";
import { pairWindow, bootstrapDecision } from "./pairwindow.js";
import { leaseVerdict, parseRunLease, RUN_LEASE_KILL_MESSAGE } from "./routinelease.js";
import { queueView } from "./backlogview.js";
import { DEVICE_TOUCH_INTERVAL_MS, nextDeviceLabel, touchDecision } from "./devicetouch.js";
import {
  admitNewUpload,
  chunkIndexProblem,
  chunkStoreLimits,
  expiredKeys,
  stagedOverLimit,
} from "./chunkstore.js";
import {
  classifyUpstream,
  UPSTREAM_PROBE_TIMEOUT_MS,
  type UpstreamDetail,
  type UpstreamVerdict,
} from "./upstream.js";
import { opencodeCandidates, pickOpencodeBinary, type OpencodeBinaryPick } from "./opencodebin.js";
import {
  injectArtifactsPathPart,
  injectArtifactsSystem,
  workspaceCoversArtifacts,
} from "./sessionctx.js";
import { previewsFromEvent, PreviewDedupe } from "./preview.js";
import { UPDATE_CONTENT_TYPES, resolveUpdatePath, updatesDir } from "./updates.js";
import { rewriteFeedPort } from "./feedport.js";
// P2-075: PWA origin watchdog — pure helpers in their own module (P1-072 lesson)
import {
  defaultPwaPlistPath,
  pwaOriginAlert,
  pwaWatchEnabled,
  startPwaWatch,
} from "./pwawatch.js";
// P2-045: dashboard v2 metrics — aggregations shared with the pilot's eval battery
import { avgPhaseDurations, burnDown, countFailSteps, rollbackHealthAlert, type HistoryEntry } from "../../pilot/src/metrics";
import { PRICE_SOURCE_LABEL } from "../../pilot/src/pricing";
import { readMission, removeMissionFile } from "../../pilot/src/mission";
import { activeModelSubstitutions, defaultModelSubstitutionsFile, readModelSubstitutions } from "../../pilot/src/modelsubst";
import { emit } from "../../pilot/src/events";
import type { PilotEvent } from "../../pilot/src/events";

const RELAY_URL = process.env.RELAY_URL ?? "ws://127.0.0.1:8787";
// P2-139: validate RELAY_URL once at boot — a typo, a wrong scheme or plain
// ws:// on a public host must not become a silent reconnect loop (now with
// backoff) that still serves the phone a QR it can never use. Fail-closed:
// with any problem the daemon never opens the relay socket; local mode is
// unaffected because it does not ride the relay.
const relayUrl = parseRelayUrl(RELAY_URL);
const relayDisabled = relayUrl.problems.length > 0;
// P2-180: the JSON body ceiling is resolved exactly once at boot. Fail-closed
// like the RELAY_URL preflight above: an invalid OCR_MAX_BODY_BYTES never
// falls back to the default — main() logs one line per problem and exits 1
// without opening any listener.
const bodyLimitResolution = bodyLimit(process.env);
// P2-181: the chunk-staging ceilings are resolved exactly once at boot too —
// same fail-closed contract: any problem means exit 1 with no listener.
const chunkLimits = chunkStoreLimits(process.env);
// P2-190: the bootstrap pairing window is resolved exactly once at boot —
// same fail-closed contract: an invalid OCR_PAIR_WINDOW_MS never falls back
// to the default; main() logs one line per problem and exits 1 with no
// listener.
const pairWindowCfg = pairWindow(process.env);
// P2-236: the routine run lease is resolved exactly once at boot — same
// fail-closed contract: an invalid OCR_RUN_LEASE_MS never falls back to the
// default; main() logs one line per problem and exits 1 with no listener.
const runLease = parseRunLease(process.env);
const OPENCODE_URL = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const OPENCODE_USER = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const OPENCODE_PASS = process.env.OPENCODE_SERVER_PASSWORD ?? "";
// replayed prompt sends (same op id from the PWA reconnect replay) → deduped
const promptIdem = new IdempotencyCache();
// P1-079 (round 2): context gauge — shared short-TTL cache of the model
// window map (the /provider catalog is ~6MB; do not refetch it per request).
const providerWindows = new WindowCache();
const MACHINE_NAME = process.env.OCR_MACHINE_NAME ?? "my-machine";
let machineName = MACHINE_NAME;

// ---------------------------------------------------------------------------
// identity + client allowlist, persisted with restrictive permissions
// ---------------------------------------------------------------------------

export interface PairedClient {
  pub: string; // client ECDH SPKI base64
  label?: string;
  addedAt: string;
  // P2-194: approximate last successful handshake, throttled to one write per
  // client per DEVICE_TOUCH_INTERVAL_MS (touchDecision). Optional + additive:
  // an allowlist without the field reads back as "never seen" and keeps every
  // pre-existing field byte-for-byte (saveAllowlist only mutates the parsed
  // object in place — unknown fields survive the round trip).
  lastSeenAt?: string;
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
  // P2-165: atomic + 0600-from-creation (tmp + rename) — a crash mid-write
  // used to truncate daemon.json and lose every pairing.
  const serialized = JSON.stringify(raw, null, 2);
  writeStateAtomic(STATE_FILE, serialized);
  persistIdentityBackup(serialized);
}

function assertPrivateMode(file: string) {
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) {
    chmodSync(file, 0o600);
    log("warn", "state file permissions tightened to 0600", { file, previousMode: mode.toString(8) });
  }
}

// P2-254: automatic backup copy of the identity file. Written through the
// same atomic 0600 write as the main file, only as a side effect of a
// successful persistence (no timers, no periodic scheduling), at most once
// per minimum interval. Failure is strictly log-only: it never brings the
// daemon down and never invalidates the main write it follows.
const IDENTITY_BACKUP_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// One single source for the backup path: every consumer derives it from
// STATE_DIR here, so boot and persistence can never drift apart.
function identityBackupPath(): string {
  return join(STATE_DIR, backupName(basename(STATE_FILE)));
}

function persistIdentityBackup(serialized: string) {
  try {
    const backupPath = identityBackupPath();
    let backupExists = false;
    let lastBackupAt: number | null = null;
    try {
      lastBackupAt = statSync(backupPath).mtimeMs;
      backupExists = true;
    } catch {}
    const plan = backupWritePlan({
      contentUsable: backupContentVerdict(serialized).plan === "use",
      backupExists,
      lastBackupAt,
      now: Date.now(),
      minIntervalMs: IDENTITY_BACKUP_MIN_INTERVAL_MS,
    });
    if (plan.decision === "write") writeStateAtomic(backupPath, serialized);
  } catch {
    log("warn", "identity backup copy skipped: write failed");
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
    // P2-167: 0600-from-creation, capped with rotation to audit.log.1, never throws.
    appendAudit(join(STATE_DIR, "audit.log"), line + "\n");
  } catch {}
}

async function loadIdentity(): Promise<DaemonIdentity> {
  const dir = STATE_DIR;
  mkdirSync(dir, { recursive: true });
  // P2-234: the identity file is read through the pure verdict in
  // identityfile.ts. An unreadable daemon.json (truncated pre-P2-165 write,
  // full disk, failed manual edit) used to crash right here with a raw
  // SyntaxError and the machine vanished from the phone without a word.
  let exists = true;
  let content: string | null = null;
  let readFailure: string | null = null;
  try {
    content = readFileSync(STATE_FILE, "utf8");
  } catch (err) {
    // A missing file is the long-standing first-run path, bit for bit; any
    // other filesystem failure refuses the boot with the file untouched.
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    if (code === "ENOENT") exists = false;
    else readFailure = code || "EUNKNOWN";
  }
  const verdict = identityVerdict(exists, content, readFailure);

  // P2-254: an illegible identity file may be recoverable from the automatic
  // backup copy. Only a content refusal (the quarantine mark) is ever
  // recoverable — identityRecoveryPlan owns the rule order: a usable main
  // wins, a read failure never restores, a missing file stays a first run.
  let restoredContent: string | null = null;
  if (verdict.quarantine) {
    const backupPath = identityBackupPath();
    let backupContent: string | null = null;
    let backupExists = false;
    try {
      backupContent = readFileSync(backupPath, "utf8");
      backupExists = true;
    } catch {
      backupExists = existsSync(backupPath);
    }
    const recovery = identityRecoveryPlan(
      verdict,
      backupExists,
      backupContentVerdict(backupContent),
    );
    if (recovery === "restore-from-backup" && backupContent !== null) {
      // Preserve the illegible file beside the original first (the P2-234
      // quarantine path — nothing is ever deleted); only then put the copy
      // in place through the same atomic 0600 write. If the preservation
      // itself fails the bytes stay put and the boot refuses as before.
      let preserved: string | null = null;
      try {
        const qfile = join(dir, quarantineName(basename(STATE_FILE), new Date()));
        renameSync(STATE_FILE, qfile);
        chmodSync(qfile, 0o600);
        preserved = qfile;
      } catch {}
      let restored = false;
      if (preserved !== null) {
        try {
          writeStateAtomic(STATE_FILE, backupContent);
          restored = true;
        } catch {
          // The restore write itself failed (a full disk — the exact
          // scenario this task exists for). Never die with the main file
          // missing while a good backup survives: put the preserved
          // illegible bytes back over the main path and fall through to
          // the refuse branch below (exit 78, backup copy intact).
          try {
            renameSync(preserved, STATE_FILE);
          } catch {}
        }
      }
      if (restored) {
        log("info", IDENTITY_BACKUP_RESTORED_LOG);
        audit("identity.restored-from-backup");
        content = backupContent;
        restoredContent = backupContent;
      }
    }
  }

  if (verdict.plan === "refuse" && restoredContent === null) {
    // Rule-order contract (identityfile.ts header): a filesystem read
    // failure NEVER quarantines — the file stays exactly where it is. For
    // unreadable content, preserve it beside the original (0600, never
    // deleted) so the owner can restore the pairings.
    let quarantined = false;
    if (verdict.quarantine) {
      try {
        const qfile = join(dir, quarantineName(basename(STATE_FILE), new Date()));
        renameSync(STATE_FILE, qfile);
        chmodSync(qfile, 0o600);
        quarantined = true;
      } catch {}
    }
    log("error", verdict.message, { quarantined });
    audit("identity.unreadable", { quarantined });
    // Documented exit code 78 (EX_CONFIG): the identity is never recreated
    // behind the owner's back in this run — the next run either finds the
    // file quarantined (first run) or fails the same read again.
    process.exit(78);
  }
  let raw: Partial<IdentityFile> =
    restoredContent !== null || verdict.plan === "use" ? (JSON.parse(content!) as Partial<IdentityFile>) : {};

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

  // P2-165: atomic write — the identity must survive a power loss mid-write.
  const serialized = JSON.stringify(raw, null, 2);
  writeStateAtomic(STATE_FILE, serialized);
  assertPrivateMode(STATE_FILE);
  persistIdentityBackup(serialized);

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

// P2-007: the `opencode-remote://pair?v=2&…` URI built at boot (printed to the
// terminal as text + QR). Exposed read-only to loopback callers via
// GET /__ocr/pairing-uri so the desktop shell can render the first-run QR
// without scraping stdout. Null until main() finishes building it.
let pairingUri: string | null = null;

// P2-190: instant the current bootstrap pairing window opened. 0 = epoch =
// closed, fail-closed before main() opens it. Re-armed on every authenticated
// read of the pairing screen — exactly the period the QR is on screen.
let pairWindowOpenedAt = 0;

// user-editable settings (name, notifications) persisted in the state file
let appSettings: AppSettings;

// local whisper transcription (optional; scripts/setup-whisper.sh installs it)
let whisperTool: WhisperTool | null = null;
// P2-201: raw detection facts kept beside the usable tool — a host with the
// whisper binary but no model still has a toolType, and the capability status
// must say "model missing" instead of pretending nothing exists.
let sttToolType: string | null = null;
let sttModelPresent = false;

/**
 * P2-201: speech-to-text capability verdict for the status route and the 501
 * body. OCR_STT_BLOCK=1 is a documented test hatch (same spirit as the
 * desktop camera block): it forces a missing-binary verdict so the disabled
 * mic UI can be evidenced deterministically on hosts that DO have whisper.
 */
function sttStatus(): { available: boolean; state: string; message: string } {
  const verdict = process.env.OCR_STT_BLOCK === "1" ? sttVerdict(null, false) : sttVerdict(sttToolType, sttModelPresent);
  return { available: verdict.state === "ready", state: verdict.state, message: verdict.message };
}

// P2-210: last summary observed from the provider catalog — fed ONLY by
// fetches that already happen (the context ruler's on-miss refresh and the
// /provider passthrough). The readiness route never fetches on its own: it
// reads this summary, so "no usable provider" surfaces before the first
// message instead of as a raw upstream error after it.
let modelCatalogSummary: ProviderSummary[] | null = null;
let modelCatalogFailed = false;

/** Record an observation of the already-fetched provider catalog. */
function noteProviderCatalog(catalog: unknown, ok: boolean) {
  modelCatalogFailed = !ok;
  if (ok) {
    modelCatalogSummary = providerSummary(catalog as Parameters<typeof providerWindows.refresh>[0]);
  }
}

/**
 * P2-210: model-readiness verdict for the status route. OCR_MODEL_BLOCK=1 is
 * a documented test hatch (same spirit as OCR_STT_BLOCK): it forces the
 * no-provider verdict so the composer hint can be evidenced deterministically
 * on hosts that DO have credentials.
 */
function modelStatus(): { available: boolean; state: string; message: string } {
  const verdict =
    process.env.OCR_MODEL_BLOCK === "1"
      ? modelReadyVerdict([])
      : modelReadyVerdict(modelCatalogSummary, modelCatalogFailed);
  return { available: verdict.state === "ready", state: verdict.state, message: verdict.message };
}

// P2-231: document→PDF conversion readiness, probed EXACTLY ONCE at boot on
// the same readiness hook as whisper/edge-tts — never per request, never
// periodic (the single probe call site lives inside main()). The verdict is
// announced in /api/health BEFORE the user sends a document, instead of the
// old raw English terminal error mid-conversation.
let docConvert: DocConvertVerdict = docConvertVerdict(process.platform, {
  soffice: false,
  textutil: false,
  cupsfilter: false,
});

/** One probe over the known install locations from doccap.ts. Synchronous on
 * purpose (a handful of existsSync calls — it cannot delay boot); any probe
 * failure degrades to the unavailable verdict with a single log line instead
 * of an exception. */
function probeDocConvert(): void {
  try {
    docConvert = docConvertVerdict(process.platform, docConvertProbe(process.platform, existsSync));
  } catch (err) {
    docConvert = docConvertVerdict(process.platform, { soffice: false, textutil: false, cupsfilter: false });
    log("warn", "doc conversion probe failed — advertising unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
// local TTS replies (optional; edge-tts CLI) — P2-125 voice mode
let edgeTtsBin: string | null = null;
const TTS_PT_VOICE = process.env.OCR_TTS_VOICE;

interface UploadEntry {
  parts: string[];
  at: number;
  // P2-181: base64 bytes currently staged across parts, summed per chunk —
  // enforced against the staging ceiling BEFORE the part is kept.
  bytes: number;
}
const uploadChunks = new Map<string, UploadEntry>();
const uploads = new Map<string, { buf: Buffer; mime: string; filename: string; at: number }>();

// P2-181: shared staging path for the two chunk routes (upload + transcribe).
// These requests arrive as E2E tunnel frames — not HTTP bodies — so the
// P2-180 readBody ceiling never sees them. Every dimension is bounded here,
// before anything is kept: stale ids are swept first, then the index is
// validated (400), then the staging byte cap (413, whole entry dropped so a
// truncated body can never silently complete as corrupt audio/file) and the
// concurrent-id admission (429). Refusal log lines carry only the route and
// the refused size — never chunk content, a full id, a token or a session id.
function stageChunk(
  req: OpRequest,
  route: "/__ocr/upload/chunk" | "/__ocr/transcribe/chunk",
): OpResponse {
  const { id, idx, data } = req.body as { id?: string; idx?: number; data?: string };
  if (!id || idx === undefined || typeof data !== "string") {
    return { id: req.id, status: 400, body: { error: "invalid chunk" } };
  }
  const now = Date.now();
  for (const key of expiredKeys(
    Array.from(uploadChunks, ([key, v]) => ({ key, at: v.at })),
    now,
    chunkLimits.expirationMs,
  )) {
    uploadChunks.delete(key);
  }
  const idxProblem = chunkIndexProblem(idx, chunkLimits.maxChunkIndex);
  if (idxProblem) {
    return { id: req.id, status: 400, body: { error: idxProblem } };
  }
  const existing = uploadChunks.get(id);
  const incoming = Buffer.byteLength(data, "utf8");
  // a retry replacing an existing index must not double-count the old copy
  const prev = existing?.parts[idx];
  const staged = (existing?.bytes ?? 0) - (typeof prev === "string" ? Buffer.byteLength(prev, "utf8") : 0);
  if (stagedOverLimit(staged, incoming, chunkLimits.stagingBytesPerId)) {
    uploadChunks.delete(id);
    log("warn", "staged chunk refused: over the byte cap", { route, bytes: staged + incoming });
    return {
      id: req.id,
      status: 413,
      body: { error: `staged upload too large (${chunkLimits.stagingBytesPerId} byte staging cap per id)` },
    };
  }
  if (!existing && !admitNewUpload(uploadChunks.size, chunkLimits.maxStagedIds)) {
    log("warn", "staged chunk refused: too many concurrent uploads", { route, bytes: staged + incoming });
    return { id: req.id, status: 429, body: { error: "too many concurrent uploads; try again soon" } };
  }
  const entry: UploadEntry = existing ?? { parts: [], at: 0, bytes: 0 };
  entry.parts[idx] = data;
  entry.bytes = staged + incoming;
  entry.at = now;
  uploadChunks.set(id, entry);
  return { id: req.id, status: 200, body: { ok: true } };
}

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
  const serialized = JSON.stringify(raw, null, 2);
  writeStateAtomic(STATE_FILE, serialized);
  persistIdentityBackup(serialized);
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

  // --- context pressure (P1-079): token totals + model window for one session.
  // The client gauge reads this instead of the whole /provider catalog (~6MB).
  // Tokens come from the opencode server, which materializes the same
  // per-session totals it persists in opencode.db.
  if (req.path === "/__ocr/context" && req.method === "GET") {
    const sessionId = req.query?.session ?? "";
    if (!/^ses_[A-Za-z0-9]{4,64}$/.test(sessionId)) {
      return { id: req.id, status: 400, body: { error: "valid session id required" } };
    }
    try {
      const sres = await fetch(new URL(`/session/${sessionId}`, OPENCODE_URL), {
        headers: authHeader ? { authorization: authHeader } : {},
      });
      if (!sres.ok) return { id: req.id, status: 502, body: { error: `opencode ${sres.status}` } };
      const s = (await sres.json()) as {
        tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
        model?: { providerID?: string; modelID?: string };
      };
      const tokens = sessionTokenTotal(s);
      const providerID = s.model?.providerID ?? "";
      const modelID = s.model?.modelID ?? "";
      let window = 0;
      if (providerID && modelID) {
        // P1-079 (round 2): the gauge fires on every idle transition of every
        // open chat — a short-TTL cache of the flattened window map avoids
        // refetching the ~6MB /provider catalog per request (an uncovered
        // model still refetches per request: correct and no worse than before).
        window = providerWindows.lookup(providerID, modelID);
        if (!window) {
          try {
            const pres = await fetch(new URL("/provider", OPENCODE_URL), {
              headers: authHeader ? { authorization: authHeader } : {},
            });
            if (pres.ok) {
              const catalog = (await pres.json()) as Parameters<typeof providerWindows.refresh>[0];
              providerWindows.refresh(catalog);
              // P2-210: same catalog, already fetched — record the readiness
              // summary without a new request or a freshness-policy change.
              noteProviderCatalog(catalog, true);
              window = providerWindows.lookup(providerID, modelID);
            } else {
              noteProviderCatalog(null, false);
            }
          } catch {
            noteProviderCatalog(null, false);
            // provider catalog is optional — without it there is no gauge
          }
        }
      }
      return {
        id: req.id,
        status: 200,
        body: { tokens, window, pct: contextPct(tokens, window), model: modelID },
      };
    } catch (err) {
      return { id: req.id, status: 502, body: { error: String(err instanceof Error ? err.message : err) } };
    }
  }

  // --- artifacts: agent-produced documents (P1-010) ---------------------------
  // listing. P2-091: the global listing (no ?session=) also carries a
  // sessionId → conversation-title map resolved against the opencode session
  // list, so the Artifacts pane groups by title instead of the raw
  // ses_… id. Best effort: an unreachable backend degrades to the ids.
  // P2-173: the payload is capped (MAX_ARTIFACTS_LISTED, newest first) with
  // additive total/truncated fields, and titles resolve only for the capped
  // items — a months-old install no longer ships thousands of rows per open.
  if (req.path === "/__ocr/artifacts" && req.method === "GET") {
    const sessionId = req.query?.session || undefined;
    metrics.inc("ocr_artifacts_list_total");
    const { items, total, truncated } = capArtifacts(listArtifacts(sessionId));
    let titles: Record<string, string> = {};
    if (items.length > 0 && !sessionId) {
      try {
        const r = await proxy({ id: req.id, method: "GET", path: "/session" });
        titles = sessionTitleMap(r.body, [...new Set(items.map((a) => a.sessionId))]);
      } catch {
        // opencode unreachable — the client falls back to the raw session ids
      }
    }
    return { id: req.id, status: 200, body: { artifacts: items, titles, total, truncated } };
  }
  // content of a single artifact (base64; the tunnel chunks oversized bodies)
  // P2-097: reads are capped (MAX_ARTIFACT_BYTES) — too-large answers 413 so
  // the client previews never OOM the daemon with a multi-MB base64 blob
  if (req.path === "/__ocr/artifact" && req.method === "GET") {
    const sessionId = req.query?.session ?? "";
    const name = req.query?.name ?? "";
    const read = readArtifact(sessionId, name);
    if (!read.ok) {
      if (read.reason === "too-large") {
        return { id: req.id, status: 413, body: { error: "artifact too large", name } };
      }
      return { id: req.id, status: 404, body: { error: "artifact not found" } };
    }
    const buf = read.data;
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
      // P2-167: the tail spans audit.log + audit.log.1 in chronological order,
      // so the first rotation does not wipe the user's security view.
      const lines = readAuditTail(join(STATE_DIR, "audit.log"), 100);
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
    // P2-213: additive mirror of the health opencode.version* verdict on the
    // existing settings read — the only daemon→app channel the Settings
    // machine section can reach without a new route (the desktop bridge
    // forwards only the known health fields, apps/desktop stays untouched).
    // P2-215: same channel logic for the disk verdict (`disk`, additive).
    // P2-250: lazy version re-probe right before the verdict is answered —
    // an opencode updated after boot is picked up here (at most once per
    // interval) instead of needing a daemon restart.
    maybeReprobeOpencodeVersion();
    return {
      id: req.id,
      status: 200,
      body: { ...readSettings(), version: VERSION, opencodeVersion: opencodeVersion, disk: diskStatus() },
    };
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
    return stageChunk(req, "/__ocr/transcribe/chunk");
  }
  if (req.path === "/__ocr/transcribe" && req.method === "POST") {
    const { id } = req.body as { id?: string };
    const entry = id ? uploadChunks.get(id) : undefined;
    uploadChunks.delete(id ?? "");
    if (!entry) {
      return { id: req.id, status: 501, body: { error: "transcription upload not found" } };
    }
    if (!whisperTool) {
      // P2-201: the actionable capability phrase (pt-BR, no script paths) from
      // the same verdict the status route serves — never the raw English hint.
      // P2-250: lazy re-probe right before the refusal — a whisper installed
      // after boot is picked up here instead of needing a daemon restart.
      await maybeReprobeTranscription();
      return { id: req.id, status: 501, body: { error: sttStatus().message } };
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
  // Voice replies (P2-125): edge-tts renders a short brief of the assistant's
  // answer to mp3. The client speaks at most a couple of sentences — the full
  // text stays in the chat.
  if (req.path === "/__ocr/voice/tts-status" && req.method === "GET") {
    return { id: req.id, status: 200, body: { available: !!edgeTtsBin, voice: resolveVoice("pt-BR", TTS_PT_VOICE).voice, voices: TTS_VOICES, langs: SPEECH_LANGS } };
  }
  // P2-201: speech-to-text capability status, mirroring the tts-status shape
  // (available boolean + verdict state and actionable pt-BR message). Same
  // auth, same tunnel — no new network surface.
  if (req.path === "/__ocr/voice/stt-status" && req.method === "GET") {
    return { id: req.id, status: 200, body: sttStatus() };
  }
  // P2-210: model-readiness status, mirroring the stt-status route shape
  // (available boolean + verdict state and actionable pt-BR message). Same
  // auth, same tunnel — no new network surface. Reads ONLY the already-cached
  // catalog summary (see noteProviderCatalog); it never fires its own fetch.
  if (req.path === "/__ocr/model/status" && req.method === "GET") {
    return { id: req.id, status: 200, body: modelStatus() };
  }
  if (req.path === "/__ocr/voice/tts" && req.method === "POST") {
    const { text, lang } = req.body as { text?: string; lang?: string };
    if (!text || typeof text !== "string" || text.length > 2000) {
      return { id: req.id, status: 400, body: { error: "text required (1..2000 chars)" } };
    }
    if (!edgeTtsBin) {
      return { id: req.id, status: 501, body: { error: "voice replies unavailable; install edge-tts on the host" } };
    }
    try {
      const t0 = Date.now();
      const { lang: spoken0, voice } = resolveVoice(lang, TTS_PT_VOICE);
      // numbers/IDs/percentages read as natural words, never raw digits
      const spoken = spokenNumbers(text, spoken0);
      const cached = cachedSpeech(spoken, voice);
      if (cached) {
        metrics.inc("ocr_tts_cache_hits_total");
        return { id: req.id, status: 200, body: { audioB64: cached.toString("base64"), mime: "audio/mpeg" } };
      }
      const audio = await synthesizeSpeech(edgeTtsBin, spoken, voice);
      putSpeech(spoken, voice, audio);
      metrics.inc("ocr_tts_total");
      metrics.inc("ocr_tts_ms_total", Date.now() - t0);
      return { id: req.id, status: 200, body: { audioB64: audio.toString("base64"), mime: "audio/mpeg" } };
    } catch (err) {
      metrics.inc("ocr_tts_failures_total");
      return { id: req.id, status: 500, body: { error: String(err instanceof Error ? err.message : err) } };
    }
  }
  if (req.path === "/__ocr/upload/chunk" && req.method === "POST") {
    return stageChunk(req, "/__ocr/upload/chunk");
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
    const body = req.body as {
      parts?: { url?: string; mime?: string; filename?: string }[];
      system?: string;
    };
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
    // P1-068: daemon-created sessions carry the artifacts protocol on every
    // turn (SessionPromptData.system is per-turn). The /api message route
    // flows through the same proxy (op() → proxy), so this is the single
    // injection point for both tunnels; the marker keeps it idempotent.
    const sid = req.path.split("/")[2] ?? "";
    if (sid && artifactSessions.has(sid) && body && typeof body === "object") {
      injectArtifactsSystem(body);
      // P1-096: the per-session artifacts dir rides the first turn's parts
      // (the line then lives in the history); the system block stays
      // byte-identical across sessions so the provider prefix-caches it.
      if (!artifactPathTold.has(sid) && injectArtifactsPathPart(body, sid)) {
        artifactPathTold.add(sid);
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

  // P1-064: paged history — the client asks ?limit=N&before=<messageID> and
  // gets the tail of the conversation as { rows, hasMore, oldest, total },
  // sized to stay under the relay's 1MB frame. Without those params the
  // passthrough below keeps returning the integral array (export, handoff and
  // internal syncs depend on the unchanged shape).
  if (shouldPaginateMessages(req.method, req.path, req.query)) {
    const sessionId = req.path.split("/")[2] ?? "";
    const limit = parsePageLimit(req.query?.limit);
    const before = typeof req.query?.before === "string" ? req.query.before : undefined;
    try {
      const res = await fetch(new URL(`/session/${sessionId}/message`, OPENCODE_URL), {
        headers: authHeader ? { authorization: authHeader } : {},
      });
      if (!res.ok) return { id: req.id, status: 502, body: { error: `opencode ${res.status}` } };
      const rows = ((await res.json()) ?? []) as HistoryRowLike[];
      const page = capMessagePage(rows, limit, before);
      metrics.inc("ocr_message_pages_total");
      // P1-064: observable trail for the paged fetch contract (acceptance: the
      // client opens a session with exactly one ?limit=50 op). `bytes` is the
      // size of the body actually served — the thing that must fit the relay frame.
      const body = {
        rows: page.rows,
        hasMore: page.hasMore,
        oldest: page.oldest,
        total: page.total,
      };
      audit("session.historyPage", {
        sessionId,
        limit,
        before: before ?? null,
        bytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
      });
      return { id: req.id, status: 200, body };
    } catch (err) {
      return {
        id: req.id,
        status: 502,
        body: { error: String(err instanceof Error ? err.message : err) },
      };
    }
  }

  const url = new URL(req.path, OPENCODE_URL);
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
  }
  // prompt-idempotency: a replayed in-flight op (WS reconnect on the PWA)
  // carries the same op id — never prompt the agent twice for it
  if (req.method === "POST" && /^\/session\/[^/]+\/message$/.test(req.path)) {
    if (promptIdem.seen(req.id)) {
      metrics.inc("ocr_prompt_dedupe_total");
      return { id: req.id, status: 200, body: { deduped: true } };
    }
    promptIdem.remember(req.id);
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
    // P1-068: remember sessions created through the tunnel (PWA/relay and the
    // /api routes — both pass through here) so their turns carry the artifacts
    // protocol. The response is repassed untouched.
    if (res.ok && req.method === "POST" && req.path === "/session") {
      registerArtifactSession(body as { id?: string; directory?: string });
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
        connected?: unknown;
      };
      // P2-210: the client's own /provider fetch (model selector) already
      // delivered the raw catalog — record the readiness summary BEFORE it is
      // slimmed away (no new request; this is what makes the verdict available
      // on the home screen before the first message).
      noteProviderCatalog(j, true);
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
    } else if (!res.ok && req.method === "GET" && req.path === "/provider") {
      // P2-210: the catalog fetch the client already made failed — an honest
      // unknown until the next successful observation.
      noteProviderCatalog(null, false);
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
  /** P1-061: session rides a direct loopback WS instead of the relay. */
  local?: boolean;
}

const sessions = new Map<string, ClientSession>();

// P1-068: sessions created by the daemon (E2E tunnel, /api, routines) whose
// turns must carry the artifacts protocol. In-memory by design: after a
// restart only newly created sessions are injected (documented behavior).
const artifactSessions = new Set<string>();

// P1-096: sessions that already received the one-shot artifacts path line
// (injected on the first turn only — afterwards the line lives in the
// history). In-memory by design, same tradeoff as artifactSessions: after a
// restart only newly created sessions are told the path again.
const artifactPathTold = new Set<string>();

/** Register a daemon-created session unless its workspace already teaches the
 * artifacts protocol via AGENTS.md. Missing `directory` fails open (register):
 * a redundant instruction is cheaper than a session without the protocol. */
function registerArtifactSession(info: { id?: string; directory?: string } | null | undefined) {
  const id = info?.id;
  if (!id || !id.startsWith("ses")) return; // defensive: ignore malformed creates
  if (artifactSessions.has(id)) return;
  const dir = typeof info?.directory === "string" ? info.directory : "";
  if (dir && workspaceCoversArtifacts(dir)) return;
  artifactSessions.add(id);
}

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
    ).json()) as { id?: string; directory?: string };
    if (!created.id) throw new Error("session create failed");
    registerArtifactSession(created);
    r.lastSessionID = created.id;
    // P2-236: stamp the run start where the in-flight marker is written, for
    // every mode (daily, days, interval) — the lease counts from here.
    r.runStartedAt = Date.now();
    saveRoutines(routines);
    pendingRuns.set(created.id, r.id);
    // P1-068: routine sessions get the artifacts protocol too (their fetches
    // bypass proxy(), so the injection is explicit here).
    const promptBody: { parts: { type: string; text: string }[]; system?: string } = {
      parts: [{ type: "text", text: r.prompt }],
    };
    if (artifactSessions.has(created.id)) {
      injectArtifactsSystem(promptBody);
      if (injectArtifactsPathPart(promptBody, created.id)) artifactPathTold.add(created.id);
    }
    await fetch(new URL(`/session/${created.id}/message`, OPENCODE_URL), {
      method: "POST",
      headers,
      body: JSON.stringify(promptBody),
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

// P2-236: a run whose session event never arrived (daemon restart mid-run,
// opencode closed, lost session) would hold the in-flight marker forever and
// silently kill the routine. The release mirrors the existing failure path:
// marker cleared, routine marked as errored with the static lease phrase,
// persisted through the same write path, ONE warn line without session ids
// and at most ONE notification per released routine. The routine itself is
// never deleted; the next sweep makes it eligible again, so it fires
// normally at its next scheduled time.
function releaseStuckRun(r: Routine) {
  if (r.lastSessionID) pendingRuns.delete(r.lastSessionID);
  r.lastSessionID = undefined;
  r.runStartedAt = undefined;
  r.lastStatus = "error";
  r.lastError = RUN_LEASE_KILL_MESSAGE;
  saveRoutines(routines);
  void pushToSubscribers(`⏰ ${r.name} falhou`, RUN_LEASE_KILL_MESSAGE, { url: "#/" });
  log("warn", RUN_LEASE_KILL_MESSAGE, { routine: r.name });
}

function checkRoutines() {
  const now = new Date();
  const today = now.toLocaleDateString("sv"); // local YYYY-MM-DD
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dow = now.getDay();
  const nowMs = now.getTime();
  // P2-236: consult the run lease inside the same periodic sweep — no new
  // timer, no per-request probing, no boot delay. A stuck run (marker left
  // behind by a restart or a lost session event) is stamped on first
  // observation and released once the lease is exceeded; everything else is
  // untouched.
  const leasePlans = new Map(
    leaseVerdict(
      nowMs,
      runLease.leaseMs,
      routines.map((r) => ({ id: r.id, inFlight: Boolean(r.lastSessionID), startedAt: r.runStartedAt })),
    ).map((v) => [v.id, v.plan]),
  );
  for (const r of routines) {
    const leasePlan = leasePlans.get(r.id) ?? "none";
    if (leasePlan === "kill") {
      releaseStuckRun(r);
      continue;
    }
    if (leasePlan === "stamp") {
      r.runStartedAt = nowMs; // lease starts counting from the first observation
      saveRoutines(routines);
    }
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

// retry pending routine completions after a restart (P2-256: the same list
// already loaded above — one read, one verdict and at most one refusal log
// per boot, and never a second look at a file the first load quarantined)
for (const r of routines) {
  if (r.lastSessionID) pendingRuns.set(r.lastSessionID, r.id);
}
setInterval(checkRoutines, 30_000);
setTimeout(checkRoutines, 10_000);

// P1-056 (round 2): <repo>/apps/daemon/src/index.ts → <repo>

// P1-056 (round 2): autonomous self-restart — if the prod checkout's HEAD
// moved past this process's boot sha, exit so launchd KeepAlive boots the new
// code without operator intervention. Idle-only is enough here (the daemon
// serves HTTP, it does not run pipelines): a mid-request exit is avoided by
// requiring the process to be at least DRIFT_FORCE_RELOAD_MS old — bounded
// staleness instead of request-level surgery.
// P2-159: source-only by construction — the single-file CJS sidecar bundle
// (apps/desktop/scripts/bundle-daemon.mjs) has no git checkout to probe and
// esbuild empties `import.meta`, so the whole block is gated on the same
// bundle detector dashboardFile() uses (CJS bundle defines __dirname, ESM
// source does not). Unbundled top-level it crashed the daemon at boot
// (fileURLToPath(undefined)) and took the desktop bundle smoke down with it.
if (typeof __dirname === "undefined") {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const BOOT_HEAD = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  let daemonDriftSince: number | undefined;
  setInterval(() => {
    try {
      const head = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (head && BOOT_HEAD && head !== BOOT_HEAD) {
        daemonDriftSince ??= Date.now();
        if (Date.now() - daemonDriftSince >= 60_000) {
          console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "self-restart: prod HEAD moved since boot", data: { bootHead: BOOT_HEAD.slice(0, 7), head: head.slice(0, 7) } }));
          process.exit(0);
        }
      } else {
        daemonDriftSince = undefined;
      }
    } catch {
      // git probe failed (transient) — never crash the routine interval
    }
  }, 30_000).unref();
}

// P2-090: artifacts watcher metric help (counter self-registers on inc).
metrics.describe(
  "ocr_artifact_events_total",
  "session.artifact events emitted for agent-written artifacts",
  "counter",
);

// P2-228: uploads retention sweep counter help (counter self-registers on inc).
metrics.describe(
  "ocr_upload_retention_deleted_total",
  "files deleted by the uploads retention sweep",
  "counter",
);

// P2-075: PWA origin watchdog — probes the static origin's /healthz and, on
// flip, appends a dashboard event (`[pwa] origin`), lights the red chip and
// pushes the phone. Only on hosts that actually serve the PWA.
if (pwaWatchEnabled(process.env.PWA_HEALTHZ_URL, defaultPwaPlistPath())) {
  metrics.describe("ocr_pwa_origin_healthy", "1 when the static PWA origin answers /healthz", "gauge");
  metrics.gauge("ocr_pwa_origin_healthy", 1);

  startPwaWatch({
    onTransition: (down, detail) => {
      emit("phase", { task: "pwa", phase: "origin", ok: !down, detail });
      void pushToSubscribers(down ? "📵 PWA offline" : "📶 PWA de volta", detail, { url: "#/" });
      log("warn", "pwa origin flipped", { down });
    },
  });
}

// watchdog: tell the phone when the agent server goes down (and back up)
// P2-135: probes feed classifyUpstream so /api/health and the down-push carry
// the real failure mode (not installed, wrong port, bad token, slow server).
let opencodeHealthy = true;
let opencodeDetail: UpstreamDetail = {
  state: "unknown",
  reason: "aguardando a primeira sonda",
  hint: "",
  checkedAt: null,
};
metrics.gauge("ocr_opencode_healthy", 1);

// P2-149: resolve the opencode binary once at boot and, at most, once a minute
// while the upstream looks unreachable, so the refused hint can separate
// "server stopped" from "server never installed" without an accessSync per
// watchdog tick. Only the boolean + origin ever leave this module state.
let binaryPick: OpencodeBinaryPick = { path: null, source: null };
let binaryCheckedAt = 0;

/** Re-resolve the opencode binary (rate-limited to one check per minute
 * unless forced); the pick feeds binaryFound/binarySource — never the path. */
function refreshOpencodeBinary(force = false): void {
  if (!force && Date.now() - binaryCheckedAt < 60_000) return;
  binaryCheckedAt = Date.now();
  binaryPick = pickOpencodeBinary(opencodeCandidates(process.env, process.platform, homedir()), (p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// P2-213: opencode version readiness. Probed EXACTLY ONCE at boot, on the
// already-resolved binary — never per request, never periodic, no retries.
// The whole spawn is capped at VERSION_PROBE_TIMEOUT_MS and stdout is
// truncated to VERSION_PROBE_MAX_BYTES before the verdict; spawn errors,
// stderr output and timeouts all land in the neutral unknown.
const VERSION_PROBE_TIMEOUT_MS = 3_000;
const VERSION_PROBE_MAX_BYTES = 200;

let opencodeVersion: OpencodeVersionVerdict = versionVerdict(null, MIN_OPENCODE_VERSION);

/** One fire-and-forget `--version` probe against the resolved binary. The
 * callback only ever sets the module state above — boot never awaits it. */
function probeOpencodeVersion(binPath: string): void {
  execFile(binPath, ["--version"], { timeout: VERSION_PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
    const raw = typeof stdout === "string" ? stdout.slice(0, VERSION_PROBE_MAX_BYTES) : "";
    opencodeVersion =
      !err && !stderr && raw ? versionVerdict(raw, MIN_OPENCODE_VERSION) : versionVerdict(null, MIN_OPENCODE_VERSION);
    log("info", "opencode version probed", { state: opencodeVersion.state });
  });
}

// P2-250: lazy capability re-probing. The boot probes above stay EXACTLY as
// they are (once per capability, no new timer); what is new is that the
// cached verdicts can now be refreshed lazily, at the point of use and at
// most once per capability per interval, guided by the pure planner in
// readiness.ts. The lay user who installs LibreOffice, installs whisper or
// updates opencode AFTER the first boot stops receiving the same polite
// refusal forever (docs/VISION.md stage 3). The knobs are fail-closed:
// main() exits when parseReadinessKnobs reported any problem.
const readinessKnobs = parseReadinessKnobs(process.env);

/** Per-capability probe bookkeeping: when the cached verdict was established
 * and whether a probe is currently running (never duplicated). */
const readinessState: Record<"transcription" | "doc-convert" | "opencode-version", { probedAt: number; inFlight: boolean }> = {
  transcription: { probedAt: 0, inFlight: false },
  "doc-convert": { probedAt: 0, inFlight: false },
  "opencode-version": { probedAt: 0, inFlight: false },
};

/** ISO instant of the last probe of a capability, for the health payload. */
function readinessCheckedAt(probedAt: number): string | null {
  return probedAt > 0 ? new Date(probedAt).toISOString() : null;
}

/** Lazy transcription re-probe: reuses detectWhisperDetail() as-is. Ready
 * never re-probes (happy path costs zero); a missing capability re-probes at
 * most once per interval, right before the route answers with the refusal. */
async function maybeReprobeTranscription(): Promise<void> {
  const st = readinessState.transcription;
  const ready = whisperTool !== null && sttToolType !== null && sttModelPresent;
  const plan = readinessRefreshPlan(ready, st.probedAt, Date.now(), st.inFlight, readinessKnobs);
  if (readinessKnobs.disabled || plan.action !== "redo") return;
  st.inFlight = true;
  try {
    const detected = await detectWhisperDetail();
    whisperTool = detected.tool;
    sttToolType = detected.toolType;
    sttModelPresent = detected.modelPresent;
  } catch {
    // a re-probe that cannot run teaches nothing new — keep the cached verdict
  } finally {
    st.inFlight = false;
    st.probedAt = Date.now();
    // one line per re-done probe: capability name + resulting state only
    log("info", "readiness re-probe", { capability: "transcription", state: sttStatus().state });
  }
}

/** Lazy document-conversion re-probe: reuses probeDocConvert() as-is. Only a
 * "complete" verdict counts as ready — a partial one (native macOS pipeline)
 * must still be able to flip to complete once LibreOffice is installed. */
function maybeReprobeDocConvert(): void {
  const st = readinessState["doc-convert"];
  const plan = readinessRefreshPlan(docConvert.state === "complete", st.probedAt, Date.now(), st.inFlight, readinessKnobs);
  if (readinessKnobs.disabled || plan.action !== "redo") return;
  st.inFlight = true;
  try {
    probeDocConvert();
  } finally {
    st.inFlight = false;
    st.probedAt = Date.now();
    // one line per re-done probe: capability name + resulting state only
    log("info", "readiness re-probe", { capability: "doc-convert", state: docConvert.state });
  }
}

/** Lazy opencode-version re-probe: reuses the existing binary refresh and
 * version-spawn helpers as-is, fire-and-forget — the probe callback already
 * logs the resulting state ("opencode version probed"). The dispatch stamps
 * probedAt immediately; the 3 s probe cap is far below the minimum interval,
 * so no in-flight duplication is possible. The documented OCR_OPENCODE_OLD=1
 * test hatch keeps its forced verdict (never re-probed away). */
function maybeReprobeOpencodeVersion(): void {
  if (process.env.OCR_OPENCODE_OLD === "1") return;
  const st = readinessState["opencode-version"];
  const plan = readinessRefreshPlan(opencodeVersion.state === "ok", st.probedAt, Date.now(), st.inFlight, readinessKnobs);
  if (readinessKnobs.disabled || plan.action !== "redo") return;
  st.probedAt = Date.now();
  refreshOpencodeBinary(true);
  if (binaryPick.path !== null) probeOpencodeVersion(binaryPick.path);
}

/** Record a finished probe: refreshes the /api/health detail and the legacy
 * boolean gauge. Returns whether the upstream counts as healthy. */
function recordUpstream(verdict: UpstreamVerdict): boolean {
  opencodeDetail = {
    state: verdict.state,
    reason: verdict.reason,
    hint: verdict.hint,
    checkedAt: new Date().toISOString(),
  };
  const healthy = verdict.state === "ok";
  metrics.gauge("ocr_opencode_healthy", healthy ? 1 : 0);
  return healthy;
}

/** One probe against the upstream /global/health, classified by upstream.ts. */
async function probeUpstream(): Promise<UpstreamVerdict> {
  const signal = AbortSignal.timeout(UPSTREAM_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(new URL("/global/health", OPENCODE_URL), {
      headers: authHeader ? { authorization: authHeader } : {},
      signal,
    });
    let body: unknown;
    let bodyOk = true;
    try {
      body = await res.json();
    } catch {
      bodyOk = false;
    }
    return classifyUpstream({ status: res.status, body, bodyOk, binaryFound: binaryPick.path !== null });
  } catch (err) {
    // P2-149: the probe never reached the server — refresh the binary pick
    // (rate-limited to once a minute) so the refused hint can say "install"
    // when the binary is gone, without re-scanning on every healthy tick.
    refreshOpencodeBinary();
    return classifyUpstream({ error: err, timedOut: signal.aborted, binaryFound: binaryPick.path !== null });
  }
}

setInterval(() => {
  void (async () => {
    const verdict = await probeUpstream();
    const healthy = recordUpstream(verdict);
    if (healthy !== opencodeHealthy) {
      opencodeHealthy = healthy;
      void pushToSubscribers(
        healthy ? "opencode is back ✅" : "opencode is DOWN ⛔",
        healthy
          ? `Agent server reachable again on ${machineName}`
          : `${machineName}: ${verdict.hint}`,
        { url: "#/" },
      );
      log("warn", "opencode health flipped", { healthy, state: verdict.state });
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
      audit("client.session.expired", { pub: s.pub.slice(0, 16), local: s.local === true });
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

// P2-090: watch ~/.opencode-remote/artifacts — every agent-written artifact
// emits a synthetic `session.artifact` event so desktop clients can open the
// preview pane on the turn's session.idle (manual choices and the browser
// pane keep priority on the client side). The relay stays a blind router:
// this rides the existing sealed envelope, like ocr.preview.
const artifactWatcher = new ArtifactWatcher(ARTIFACTS_ROOT, (a) => {
  log("info", "artifact written", { sessionID: a.sessionID, name: a.name });
  metrics.inc("ocr_artifact_events_total");
  broadcast({
    type: "event",
    event: {
      id: randomUUID(),
      type: "session.artifact",
      properties: { sessionID: a.sessionID, name: a.name, kind: a.kind, path: a.path },
    },
  });
});
artifactWatcher.start();

// --- P2-215: disk-space readiness -------------------------------------------
// The volume hosting the state dir also carries everything else the daemon
// writes (artifacts, upload staging, audit log, state file) and a full volume
// turns every write into a raw error mid-conversation. One reading at boot,
// then on the SAME interval the P2-207 janitor sweep below already uses —
// never per request, no new periodic timer, no retry: a failed reading lands
// in the neutral unknown and the next scheduled sweep cycle reads again.
// Fire-and-forget async statfs: boot is never blocked or delayed.

let diskSpace: DiskVerdict = diskVerdict(null, null);

function refreshDiskState(): void {
  statfs(STATE_DIR, (err, stats) => {
    if (err) {
      diskSpace = diskVerdict(null, null);
      log("warn", "disk space probe failed", { error: err.message });
      return;
    }
    diskSpace = diskVerdict(stats.bavail * stats.bsize, stats.blocks * stats.bsize);
    log("info", "disk space probed", { state: diskSpace.state });
  });
}

/**
 * P2-215: disk verdict for /api/health and the settings mirror. OCR_DISK_FULL=1
 * is a documented test hatch (same spirit as OCR_OPENCODE_OLD/OCR_MODEL_BLOCK):
 * it forces the critical verdict so the Settings disk line can be evidenced
 * deterministically on hosts with plenty of free space.
 */
function diskStatus(): DiskVerdict {
  if (process.env.OCR_DISK_FULL === "1") return diskVerdict(0, 1);
  return diskSpace;
}

// --- P2-207: artifact retention janitor -------------------------------------
// The artifacts root grows forever otherwise: every conversation that produced
// a report/spreadsheet/pdf keeps its bytes on the user's disk. The janitor
// sweeps ONLY this root — never uploads/ (user-requested download material),
// never clips/ and never any other state dir — once at boot and then every
// RETENTION_INTERVAL_MS. Set OCR_ARTIFACT_RETENTION=off to disable entirely.

function dirFacts(dir: string): { bytes: number; mtime: number } {
  let bytes = 0;
  let mtime = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, ent.name);
    if (ent.isDirectory()) {
      const nested = dirFacts(child);
      bytes += nested.bytes;
      mtime = Math.max(mtime, nested.mtime);
    } else {
      const st = statSync(child);
      bytes += st.size;
      mtime = Math.max(mtime, st.mtimeMs);
    }
  }
  return { bytes, mtime };
}

function scanRetentionEntries(): RetentionEntry[] {
  const entries: RetentionEntry[] = [];
  for (const ent of readdirSync(ARTIFACTS_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue; // session dirs are the deletion unit
    const dir = join(ARTIFACTS_ROOT, ent.name);
    const facts = dirFacts(dir);
    entries.push({ path: dir, bytes: facts.bytes, mtime: facts.mtime });
  }
  return entries;
}

function sweepArtifactRetention(): void {
  try {
    // the ONLY root the janitor ever scans or deletes under is ARTIFACTS_ROOT
    const plan = retentionPlan(ARTIFACTS_ROOT, scanRetentionEntries(), Date.now());
    for (const path of plan.paths) {
      rmSync(path, { recursive: true, force: true });
    }
    log("info", "artifact retention sweep", { deleted: plan.paths.length, bytes: plan.bytes });
    metrics.inc("ocr_artifact_retention_deleted_total", plan.paths.length);
  } catch (err) {
    // a filesystem error aborts this cycle only — no immediate retry; the
    // next scheduled sweep picks it up
    log("warn", "artifact retention sweep failed", { error: (err as Error).message });
  }
}

// --- P2-228: uploads retention -----------------------------------------------
// ~/.opencode-remote/uploads/ is where videos and documents sent from the
// phone land and where files generated for download are written — the only
// state dir without a ceiling until now. The sweep reads ONLY UPLOADS_ROOT
// (flat regular files; no subdirectories, no hidden files, symlinks never
// followed) and NEVER touches the artifacts root, clips/, the chunk-staging
// area, the state file, the audit log or anything outside UPLOADS_ROOT —
// the prohibition is written in uploadretention.ts's header and pinned by
// the real-source assertions in scripts/unit.test.ts.

const UPLOADS_ROOT = join(STATE_DIR, "uploads");

function scanUploadEntries(): UploadFile[] {
  const entries: UploadFile[] = [];
  for (const ent of readdirSync(UPLOADS_ROOT, { withFileTypes: true })) {
    if (!ent.isFile()) continue; // regular files only; dirs and symlinks are ignored
    if (ent.name.startsWith(".")) continue; // hidden files are ignored
    const path = join(UPLOADS_ROOT, ent.name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue; // vanished between readdir and stat — skip, never plan it
    }
    entries.push({ path, bytes: st.size, mtime: st.mtimeMs });
  }
  return entries;
}

function sweepUploadRetention(): void {
  try {
    // the ONLY root this sweep ever scans or deletes under is UPLOADS_ROOT
    const plan = uploadRetentionPlan(scanUploadEntries(), Date.now(), uploadRetention.thresholds);
    for (const path of plan.paths) {
      rmSync(path, { force: true });
    }
    // one log line per sweep, count and bytes only — never a file name
    log("info", "upload retention sweep", { deleted: plan.paths.length, bytes: plan.bytes });
    metrics.inc("ocr_upload_retention_deleted_total", plan.paths.length);
  } catch (err) {
    // a filesystem error aborts this cycle only — one log line, no immediate
    // retry; the next scheduled sweep picks it up
    log("warn", "upload retention sweep failed", { error: (err as Error).message });
  }
}

// --- P2-248: clips retention ---------------------------------------------------
// ~/.opencode-remote/clips/ is where tools/clip.mjs writes the heaviest files
// the product produces — rendered vertical clips plus the extracted
// transcription audio — one folder per source video with loose work files at
// the root, and nothing ever cleaned it. The sweep reads ONLY the immediate
// children of CLIPS_ROOT (a group = one source-video folder or one loose work
// file), never follows a symbolic link (lstat + isSymbolicLink skips only),
// never walks above the root and NEVER touches the uploads root, the
// artifacts root, the chunk-staging area, the state file, the audit log or
// anything outside CLIPS_ROOT — deletion removes whole groups and never the
// root itself. The prohibition is written in clipretention.ts's header and
// pinned by the real-source assertions in scripts/unit.test.ts.

const CLIPS_ROOT = join(STATE_DIR, "clips");

/** Recursive size/latest-mtime of one group dir; symlinks are never followed. */
function clipGroupFacts(dir: string): { bytes: number; mtime: number } {
  let bytes = 0;
  let mtime = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue; // symlinks are never followed
    const child = join(dir, ent.name);
    if (ent.isDirectory()) {
      const nested = clipGroupFacts(child);
      bytes += nested.bytes;
      mtime = Math.max(mtime, nested.mtime);
    } else {
      const st = lstatSync(child);
      bytes += st.size;
      mtime = Math.max(mtime, st.mtimeMs);
    }
  }
  return { bytes, mtime };
}

function scanClipGroups(): ClipGroup[] {
  const groups: ClipGroup[] = [];
  for (const ent of readdirSync(CLIPS_ROOT, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue; // symlinks are never followed
    if (ent.name.startsWith(".")) continue; // hidden entries are ignored
    const path = join(CLIPS_ROOT, ent.name);
    try {
      if (ent.isDirectory()) {
        const facts = clipGroupFacts(path);
        groups.push({ path, bytes: facts.bytes, mtime: facts.mtime });
      } else if (ent.isFile()) {
        const st = lstatSync(path);
        groups.push({ path, bytes: st.size, mtime: st.mtimeMs });
      }
    } catch {
      continue; // vanished between readdir and stat — skip, never plan it
    }
  }
  return groups;
}

function sweepClipRetention(): void {
  try {
    // the ONLY root this sweep ever scans or deletes under is CLIPS_ROOT
    const plan = clipRetentionPlan(scanClipGroups(), Date.now(), clipRetention.thresholds);
    for (const path of plan.paths) {
      rmSync(path, { recursive: true, force: true }); // whole group, never the root
    }
    // one log line per sweep, count and bytes only — never a file or folder
    // name: those come from the user's video titles (P2-182)
    log("info", "clip retention sweep", { deleted: plan.paths.length, bytes: plan.bytes });
    metrics.inc("ocr_clip_retention_deleted_total", plan.paths.length);
  } catch (err) {
    // a filesystem error aborts this cycle only — one log line, no immediate
    // retry; the next scheduled sweep picks it up
    log("warn", "clip retention sweep failed", { error: (err as Error).message });
  }
}

// P2-215: the disk reading fires once at boot (unconditionally — the verdict
// must exist even with the janitor disabled) and then rides the SAME
// RETENTION_INTERVAL_MS interval the sweep already uses; no new timer exists.
// P2-228: the uploads janitor shares this exact hook and interval — ONE timer
// drives both sweeps, each honoring its own kill switch, so no new periodic
// timer exists here either. An invalid OCR_UPLOAD_RETENTION_* keeps the sweep
// off: main() exits fail-closed before any listener opens.
// P2-248: the clips janitor shares the same hook and interval too — still one
// timer, three janitors, each with its own kill switch and fail-closed parse.
refreshDiskState();
const artifactsSweepOn = !retentionDisabled(process.env);
const uploadRetention = parseUploadRetention(process.env);
const uploadsSweepOn = uploadRetention.problems.length === 0 && !uploadRetention.disabled;
const clipRetention = parseClipRetention(process.env);
const clipsSweepOn = clipRetention.problems.length === 0 && !clipRetention.disabled;
if (artifactsSweepOn || uploadsSweepOn || clipsSweepOn) {
  if (artifactsSweepOn) sweepArtifactRetention();
  if (uploadsSweepOn) {
    // first sweep is fire-and-forget one tick after boot: boot is never
    // blocked or delayed by the uploads scan
    const bootSweep = setTimeout(sweepUploadRetention, 0);
    bootSweep.unref?.();
  }
  if (clipsSweepOn) {
    // same fire-and-forget boot tick: boot is never delayed by the clips scan
    const clipBootSweep = setTimeout(sweepClipRetention, 0);
    clipBootSweep.unref?.();
  }
  const retentionTimer = setInterval(() => {
    refreshDiskState();
    if (artifactsSweepOn) sweepArtifactRetention();
    if (uploadsSweepOn) sweepUploadRetention();
    if (clipsSweepOn) sweepClipRetention();
  }, RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
}

const autoApproved = new Map<string, number>();

/**
 * AutoMode: answer an opencode permission ask with "once" on the user's behalf,
 * tell connected clients (synthetic event so the PWA clears its ask UI) and
 * optionally push a notification. Two quick attempts ride out transient
 * hiccups; a final failure is audited and broadcast as
 * `ocr.permission.autoFailed` so clients surface the ask as a manual card —
 * AutoMode must never fail in silence (P1-093).
 */
async function autoApprove(sessionID: string, permissionID: string, action: string) {
  const now = Date.now();
  if (now - (autoApproved.get(permissionID) ?? 0) < 120_000) return;
  autoApproved.set(permissionID, now);
  for (const [k, v] of autoApproved) if (now - v > 600_000) autoApproved.delete(k);
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    // P1-093: keep the gate fast — one retry after ~500ms, nothing longer
    if (attempt > 1) await new Promise((r) => setTimeout(r, 500));
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
        lastError = `HTTP ${res.status}`;
        continue;
      }
      log("info", "permission auto-approved", { sessionID, permissionID, action, attempt });
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
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  autoApproved.delete(permissionID);
  log("warn", "auto-approve failed after retry", { sessionID, permissionID, action, error: lastError });
  audit("permission.auto.failed", { sessionID, permissionID, action, error: lastError });
  broadcast({
    type: "event",
    event: {
      id: randomUUID(),
      type: "ocr.permission.autoFailed",
      properties: { sessionID, permissionID, action, error: lastError },
    },
  });
}

async function forwardEvents() {
  let attempt = 0;
  // P1-072: auto-preview state — messageID→role map (user parts are echoed
  // back as message.part.updated too; only assistant text opens previews) and
  // the per-session URL dedupe. Both survive stream reconnects on purpose.
  const messageRoles = new Map<string, string>();
  const previewDedupe = new PreviewDedupe();
  // voice warm-up: latest assistant text per session, spoken at session.idle
  const lastAssistantText = new Map<string, string>();
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
              // voice warm-up: render the spoken brief now, so the phone's
              // later /__ocr/voice/tts request is usually an mp3 cache hit
              const warmText = sessionID ? lastAssistantText.get(sessionID) : undefined;
              if (warmText && edgeTtsBin) {
                void prewarmSpeech(edgeTtsBin, speakBrief(warmText), "pt-BR", TTS_PT_VOICE);
                lastAssistantText.delete(sessionID);
              }
            }

            // P1-072: auto-preview — assistant text mentioning a loopback
            // http(s) URL with an explicit port emits a synthetic `ocr.preview`
            // event so the desktop app opens its Browser pane on it. The relay
            // stays a blind router: this rides the existing sealed envelope.
            // Role tracking must stay in the same loop as the part handling
            // below (message.updated always arrives before its parts).
            if (evt.type === "message.updated") {
              const info = ((evt.properties ?? {}) as { info?: { id?: string; role?: string } }).info;
              if (info?.id) {
                messageRoles.set(info.id, info.role ?? "assistant");
                if (messageRoles.size > 1000) {
                  const oldest = messageRoles.keys().next().value;
                  if (oldest !== undefined) messageRoles.delete(oldest);
                }
              }
            } else if (evt.type === "message.part.updated") {
              // pure helper pins the semantics: fail-closed role check
              // (assistant only) and sessionID from part.sessionID first
              for (const { sessionID: sid, url } of previewsFromEvent(evt, messageRoles)) {
                if (!previewDedupe.firstSeen(sid, url)) continue;
                log("info", "preview detected", { sessionID: sid, url });
                broadcast({
                  type: "event",
                  event: {
                    id: randomUUID(),
                    type: "ocr.preview",
                    properties: { sessionID: sid, url },
                  },
                });
              }
              // voice warm-up tracking: remember each session's latest
              // assistant text (same fail-closed role check as previews)
              const warmPart = ((evt.properties ?? {}) as {
                part?: { type?: unknown; text?: unknown; messageID?: unknown; sessionID?: unknown };
              }).part;
              if (
                warmPart &&
                warmPart.type === "text" &&
                typeof warmPart.text === "string" &&
                typeof warmPart.messageID === "string" &&
                messageRoles.get(warmPart.messageID) === "assistant"
              ) {
                const sid = typeof warmPart.sessionID === "string" && warmPart.sessionID ? warmPart.sessionID : "";
                if (sid) {
                  lastAssistantText.set(sid, warmPart.text);
                  if (lastAssistantText.size > 100) {
                    const oldest = lastAssistantText.keys().next().value;
                    if (oldest !== undefined) lastAssistantText.delete(oldest);
                  }
                }
              }
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
    if (isShuttingDown()) return; // drain in progress: stop reconnecting
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
      const known = sessions.get(frame.from);
      // P1-061 (reviewer fix): a ping IS liveness — refresh lastSeen so the
      // 1h stale sweep can never delete a session whose socket is open and
      // heartbeating (otherwise broadcast() silently stops delivering while
      // the client stays "paired" and never reconnects).
      if (known) known.lastSeen = Date.now();
      const reply = known ? { type: "pong" } : { type: "reconnect" };
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
      // bootstrap: the first QR pairing on a virgin daemon auto-persists —
      // but only while the P2-190 bootstrap pairing window is open (opened at
      // boot, re-armed on every authenticated pairing-screen read);
      // afterwards only clients in the allowlist may connect.
      const allowlist = readAllowlist();
      let client = allowlist.find((c) => c.pub === accepted.clientPub);
      const decision = client
        ? "allow"
        : bootstrapDecision(allowlist.length, pairWindowOpenedAt, Date.now(), pairWindowCfg.windowMs);
      if (decision === "reject-expired") {
        audit("client.bootstrap-expired", { pub: accepted.clientPub.slice(0, 16) });
        log(
          "warn",
          "bootstrap pairing window closed: reopen the pairing screen in the desktop app or restart the daemon",
          { pub: accepted.clientPub.slice(0, 16) },
        );
      }
      if (decision === "allow" && !client) {
        // P2-194: stable, personal-data-free label ("Telefone 1", ...) instead
        // of the hardcoded "first" — two phones must be distinguishable in
        // Settings without comparing public-key prefixes. First handshake
        // already counts as seen (we are writing the entry anyway).
        client = {
          pub: accepted.clientPub,
          addedAt: new Date().toISOString(),
          label: nextDeviceLabel(allowlist.map((c) => c.label ?? "")),
          lastSeenAt: new Date().toISOString(),
        };
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

      // P2-194: throttled last-seen stamp — at most one daemon.json rewrite
      // per client per interval, never per frame. Approximate on purpose.
      if (touchDecision(client.lastSeenAt, Date.now(), DEVICE_TOUCH_INTERVAL_MS) === "write") {
        client.lastSeenAt = new Date().toISOString();
        saveAllowlist(allowlist);
      }

      sessions.set(frame.from, {
        from: frame.from,
        pub: accepted.clientPub,
        key: accepted.sessionKey,
        socket: ws,
        lastSeq: 0,
        sendSeq: 0,
        lastSeen: Date.now(),
        local: localSockets.has(ws),
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

// handle to the live relay websocket (shutdown closes it with code 1001)
let relaySocket: WebSocket | null = null;
// P2-129: exponential backoff with full jitter for relay reconnects — a fleet
// of daemons must not hammer a downed relay twice per second, nor reconnect
// all in lockstep the moment it comes back.
const relayRetry = createRelayRetry();
// P2-156: verdict of the most recent relay close, surfaced additively inside
// /api/health's relayRetry object as lastClose — code + kind only; the raw
// close reason never reaches the API surface.
let relayLastClose: { code: number | null; kind: RelayCloseKind } | null = null;
// P2-260: verdict of the most recent relay dial failure, surfaced additively
// inside /api/health's relayRetry object as lastDial — kind + static pt-BR
// hint only; the raw Node message (it embeds the relay host and port) never
// reaches the log or the API surface.
let relayLastDial: { kind: RelayDialKind; hint: string } | null = null;
// P2-260: floor of the dial failure in flight. A dial error never produces a
// close code (ws emits a generic 1006 close right after the error), so the
// close handler consumes this with the same max(jittered, floor) rule
// effectiveRetryDelayMs applies to close floors — no new timer.
let relayPendingDialFloorMs = 0;
// handle to the loopback API/metrics server (shutdown calls .close())
let apiServer: HttpServer | null = null;
// P2-161: the port the loopback API server actually bound (set in main()).
// The staged feed.json embeds absolute artifact URLs recorded at publish
// time; after a fallback boot (P2-143) that recorded port is stale, so the
// feed route resolves it against THIS port when serving.
let boundMetricsPort = 0;

// P2-020: SIGTERM/SIGINT graceful shutdown — drain ≤3s, then exit 0.
const bootTime = Date.now();
const { shutdown, isShuttingDown } = createShutdown({
  activeConnections: () => sessions.size,
  uptimeMs: () => Date.now() - bootTime,
  stopListeners: () => {
    const sockets = new Set<WebSocket>([...sessions.values()].map((s) => s.socket));
    if (relaySocket) sockets.add(relaySocket);
    return stopAccepting(apiServer, sockets);
  },
  exit: (code) => process.exit(code),
  setTimeout,
  clearTimeout,
});
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

function connectRelay() {
  // P2-139: an invalid RELAY_URL never opens a socket. The reason is logged
  // once at boot instead of repeating on every retry; nothing here schedules
  // a reconnect, so the backoff loop never starts.
  if (relayDisabled) return;
  const ws = new WebSocket(RELAY_URL);
  relaySocket = ws;

    ws.on("open", () => {
      relayRetry.reset();
      // P2-260: a successful dial invalidates any stale dial-failure floor.
      relayPendingDialFloorMs = 0;
      log("info", "connected to relay", { relay: redactRelayUrl(RELAY_URL), room: daemon.room });
    metrics.gauge("ocr_relay_connected", 1);
    metrics.inc("ocr_relay_connects_total");
    ws.send(JSON.stringify({ room: daemon.room, from: daemon.room, payload: "" }));
  });

  ws.on("message", (data) => void handleMessage(data, ws));

  ws.on("close", (code, reason) => {
    if (isShuttingDown()) return; // drain in progress: do not reconnect
    // P2-156: the close code says WHY the relay let go — a saturated relay
    // (1013 capacity / 4029 rate limit) must not be hammered on the same 2s
    // curve as an abrupt network drop. The kind's floor only ever lengthens
    // the wait; transient keeps the P2-129 jittered schedule untouched.
    const verdict = classifyRelayClose(code, Buffer.isBuffer(reason) ? reason.toString("utf-8") : "");
    // P2-260: a dial failure (unresolved name, refused, timeout, bad relay
    // certificate) never produces a close code — the close that follows the
    // error is the generic 1006. The pending dial verdict floors the same
    // wait via the same max(jittered, floor) rule the close verdict uses; a
    // transient drop keeps the P2-129 jittered schedule untouched.
    const retryInMs = Math.max(
      effectiveRetryDelayMs(relayRetry.schedule(), verdict),
      relayPendingDialFloorMs,
    );
    relayPendingDialFloorMs = 0;
    relayLastClose = { code: typeof code === "number" ? code : null, kind: verdict.kind };
    metrics.inc("ocr_relay_retries_total");
    log("warn", "relay connection lost; retrying", {
      attempt: relayRetry.attempt,
      retryInMs,
      closeCode: relayLastClose.code,
      closeKind: verdict.kind,
    });
    metrics.gauge("ocr_relay_connected", 0);
    // P1-061: only sessions that actually ride this relay socket go away —
    // a relay kickstart must never disturb direct local WS sessions.
    for (const [from, s] of sessions) {
      if (s.socket === ws) sessions.delete(from);
    }
    metrics.gauge("ocr_sessions_active", sessions.size);
    setTimeout(connectRelay, retryInMs);
  });

  ws.on("error", (err) => {
    // P2-260: triage the failure instead of logging the raw Node message —
    // the message embeds the relay host and port, and the sidecar log ships
    // in support requests (P2-163). Only the kind + static pt-BR hint are
    // recorded; unknown input stays transient (floor 0), so the wait only
    // ever lengthens for a known permanent cause.
    const errCode = (err as NodeJS.ErrnoException).code;
    const verdict = relayDialVerdict(typeof errCode === "string" ? errCode : null, err.message);
    relayPendingDialFloorMs = verdict.floorMs;
    relayLastDial = { kind: verdict.kind, hint: verdict.hint };
    log("error", "relay dial failed", { kind: verdict.kind, hint: verdict.hint });
  });
}

// ---------------------------------------------------------------------------
// local direct mode (P1-061): same-machine clients dial ws://127.0.0.1:<port>/ws
// with the apiToken from the 0600 state file — no relay hop. Frames are the
// exact same RelayFrame envelopes: E2E handshake, fresh-read allowlist and
// seq-in-AAD replay guard are untouched, so no plaintext route is added.
// ---------------------------------------------------------------------------

const localWss = new WebSocketServer({ noServer: true });
const localSockets = new WeakSet<WebSocket>();
let localWsCount = 0;

function refreshLocalGauge() {
  metrics.gauge("ocr_local_ws_sessions", localWsCount);
}

/** A closed socket's session must not linger in the map: broadcast() skips
 * non-OPEN sockets silently, but a stale entry would keep answering pings
 * with "pong" and block the client's fresh handshake. */
function pruneLocalSessions(ws: WebSocket) {
  for (const [from, s] of sessions) {
    if (s.socket === ws) sessions.delete(from);
  }
  metrics.gauge("ocr_sessions_active", sessions.size);
}

function attachLocalWs(server: HttpServer): void {
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const allowed = localUpgradeAllowed(
        url.pathname,
        url.searchParams.get("token"),
        (socket as NetSocket).remoteAddress,
        req.headers.origin,
        apiToken(),
      );
      if (!allowed) {
        // no log with the URL: the token rides in the query string
        socket.destroy();
        return;
      }
      localWss.handleUpgrade(req, socket, head, (ws) => {
        localSockets.add(ws);
        localWsCount++;
        refreshLocalGauge();
        ws.on("close", () => {
          localWsCount--;
          refreshLocalGauge();
          pruneLocalSessions(ws);
        });
        ws.on("error", () => {});
        ws.on("message", (data) => void handleMessage(data, ws));
      });
    } catch {
      // unreadable state file / malformed URL: never crash the daemon on an
      // upgrade — just refuse the socket
      socket.destroy();
    }
  });
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
  const serialized = JSON.stringify(raw, null, 2);
  writeStateAtomic(STATE_FILE, serialized);
  persistIdentityBackup(serialized);
  log("info", "api token generated (see apiToken in daemon.json)");
  return token;
}

// P2-180: readBody keeps its signature but now enforces the boot-resolved
// byte ceiling via readLimitedBody — an oversized body rejects instead of
// growing the heap until the process (and, packaged as stage 3, the whole
// desktop window) dies.
function readBody(req: IncomingMessage): Promise<string> {
  return readLimitedBody(req, bodyLimitResolution.limit);
}

// P2-180: the single 413 path for every JSON route, in the same { error }
// shape as every other response. The refusal log carries the route and the
// refused size only — never body content, token or session ids.
function refuseBody(res: ServerResponse, route: string, err: BodyLimitError): void {
  log("warn", "request body refused — over the JSON body limit", {
    route,
    bytes: err.bytes,
    limit: err.limit,
  });
  res.writeHead(413, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `request body too large (${err.limit / 1_000_000}MB limit)` }));
}

// JSON body + 413 on limit. Non-limit errors (JSON.parse syntax) rethrow so
// each route keeps today's exact behavior for them.
async function readJsonBody<T>(req: IncomingMessage, res: ServerResponse, route: string): Promise<T | null> {
  try {
    return JSON.parse((await readBody(req)) || "{}") as T;
  } catch (err) {
    if (isBodyLimitError(err)) {
      refuseBody(res, route, err);
      return null;
    }
    throw err;
  }
}

function send401(res: ServerResponse) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized — Authorization: Bearer <apiToken from daemon.json>" }));
}

// ── P1-057: browser sessions (Bearer → short-lived HttpOnly cookie) ──────────
// The dashboard HTML never carries the apiToken anymore; a browser that already
// proved the token can exchange it for a 12h session cookie via POST /api/session.

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** id (32 hex) → expiresAt (ms). Memory-only: a daemon restart just means the
 * browser re-authenticates with the Bearer token (documented behavior). */
const apiSessions = new Map<string, number>();

function cookieValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** True when the request carries the Bearer apiToken OR a live ocr_session cookie. */
function authorized(req: IncomingMessage): boolean {
  if (req.headers.authorization === `Bearer ${apiToken()}`) return true;
  const sid = cookieValue(req, "ocr_session");
  if (!sid) return false;
  const exp = apiSessions.get(sid);
  if (exp === undefined) return false;
  if (Date.now() > exp) {
    apiSessions.delete(sid);
    return false;
  }
  return true;
}

// Dashboard static file. The packaged desktop sidecar runs a single-file CJS
// bundle where esbuild empties `import.meta` (CJS has no import.meta), so the
// source-relative URL below would throw and /dashboard would answer 500. The
// bundler (apps/desktop/scripts/bundle-daemon.mjs) therefore ships
// dashboard.html next to the bundle and the bundle resolves it via __dirname;
// source checkouts (ESM, no __dirname) keep the repo-relative URL.
function dashboardFile(variant: "index" | "mission-v3" = "index"): string | URL {
  if (typeof __dirname !== "undefined") return join(__dirname, variant === "index" ? "dashboard.html" : "dashboard-v3.html");
  return new URL(`../../../apps/pilot/dashboard/${variant}.html`, import.meta.url);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  // GET /dashboard — pilot three.js mission control (static file). P1-057: the
  // apiToken is NEVER embedded in the HTML anymore — the browser proves itself
  // via the token box / ?token= (saved to localStorage) or a session cookie.
  // GET /dashboard and /dashboard/v3 — Mission Control (mission-v3.html).
  // The old orbital dashboard is retired for now; both URLs serve v3 so
  // existing links and the desktop pane keep working.
  if (req.method === "GET" && (url.pathname === "/dashboard" || url.pathname === "/dashboard/v3")) {
    try {
      const variant = "mission-v3" as const;
      const html = readFileSync(dashboardFile(variant), "utf8").replace("__APITOKEN__", "");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("dashboard file missing");
    }
    return true;
  }
  // P1-050: staged auto-update feed — GET /__ocr/updates/<version>/<file>.
  // Serves ONLY files under ~/.opencode-remote/updates (resolveUpdatePath is
  // strict: charset + extension allowlist + resolved-path containment). The
  // route is intentionally unauthenticated like /dashboard because the
  // desktop's autoUpdater cannot attach the Bearer token; the metrics server
  // binds 127.0.0.1 only, so the folder is unreachable off-machine.
  if (req.method === "GET" && url.pathname.startsWith("/__ocr/updates/")) {
    const file = resolveUpdatePath(updatesDir(), url.pathname.slice("/__ocr/updates".length));
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return true;
    }
    // P2-161: feed.json is a small pointer document whose `url` field embeds
    // the port recorded at publish time — after a fallback boot (P2-143) that
    // port is stale and the desktop would announce a new version, then fail
    // the download on a dead address with no signal to the user. The port is
    // resolved at SERVE time instead: rewriteFeedPort (pure, fail-closed)
    // retargets the loopback URL at the actually-bound port, and the response
    // carries the resulting body's content-length. Artifacts (zip, dmg, exe,
    // yml, blockmap — multi-MB) keep the streaming path below untouched;
    // latest.yml stays verbatim too, its `path` field is relative to the
    // feed's own address.
    if (basename(file) === "feed.json") {
      try {
        const raw = readFileSync(file, "utf8");
        const feed = rewriteFeedPort(raw, boundMetricsPort);
        const body = Buffer.from(feed.body, "utf8");
        log("info", "update feed served", {
          file: basename(file),
          feedRewritten: feed.rewritten,
          feedPort: boundMetricsPort,
        });
        res.writeHead(200, {
          "content-type": UPDATE_CONTENT_TYPES[".json"],
          "content-length": String(body.byteLength),
          "cache-control": "no-store",
        });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
      return true;
    }
    try {
      // P1-050 r2: stream, don't buffer. Update artifacts are multi-MB; a
      // readFileSync here would block the shared event loop (relay WS client,
      // /api/*) for the whole read and hold the entire file in memory.
      // stat() is async (404 fallback preserved), content-length helps the
      // desktop's download progress, and errors mid-stream just tear the
      // response down — headers are already sent at that point.
      const size = (await stat(file)).size;
      const ext = (file.match(/(\.[a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
      res.writeHead(200, {
        "content-type": UPDATE_CONTENT_TYPES[ext] ?? "application/octet-stream",
        "content-length": String(size),
        "cache-control": "no-store",
      });
      const stream = createReadStream(file);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
    return true;
  }
  // P1-057: exchange the Bearer token for a short-lived HttpOnly session cookie.
  // Bearer-only by design: a cookie must never mint fresh cookies.
  if (req.method === "POST" && url.pathname === "/api/session") {
    if (req.headers.authorization !== `Bearer ${apiToken()}`) {
      send401(res);
      return true;
    }
    for (const [k, exp] of apiSessions) if (Date.now() > exp) apiSessions.delete(k);
    const id = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    apiSessions.set(id, expiresAt);
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": `ocr_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    });
    res.end(JSON.stringify({ ok: true, expiresAt }));
    return true;
  }
  // P2-007: loopback-only, Bearer-gated reads of boot pairing state for the
  // desktop shell's first-run QR overlay. Strictly read-only: the URI is the
  // same one printed to stdout at boot and devices come from a fresh
  // readAllowlist() — identical to the E2E /__ocr/devices route. No crypto or
  // allowlist logic is touched (handshake auth path stays exactly as it was).
  if (req.method === "GET" && (url.pathname === "/__ocr/pairing-uri" || url.pathname === "/__ocr/devices")) {
    if (!authorized(req)) {
      send401(res);
      return true;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    if (url.pathname === "/__ocr/pairing-uri") {
      // P2-190: every authenticated read of the pairing screen re-arms the
      // bootstrap window — this is exactly the period the desktop app shows
      // the QR. Silent on purpose: the overlay polls this route, so one log
      // line per read would flood. When the QR is withheld (invalid relay,
      // pairingUri === null) there is no re-arm.
      if (pairingUri !== null) pairWindowOpenedAt = Date.now();
      res.end(JSON.stringify({ uri: pairingUri }));
    } else {
      let devices: PairedClient[] = [];
      try {
        devices = readAllowlist();
      } catch {
        // state file missing/unreadable: report an empty allowlist rather than
        // letting the exception escape into an unhandled rejection
      }
      res.end(JSON.stringify({ devices }));
    }
    return true;
  }
  if (!url.pathname.startsWith("/api/")) return false;
  // P2-011: /api/browse/* — host browser automation (Playwright), same auth gate
  if (url.pathname.startsWith("/api/browse")) {
    const seg = url.pathname.split("/").filter(Boolean);
    if (!authorized(req)) {
      send401(res);
      return true;
    }
    return await handleBrowse(req, res, url, seg);
  }
  if (!authorized(req)) {
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
      // P2-129: additive relayRetry — attempt number + pending delay while the
      // daemon is scheduling its next relay dial, null when connected.
      const relayConnected = metrics.get("ocr_relay_connected") === 1;
      // P2-215: additive disk verdict for the volume hosting the state dir —
      // state + short pt-BR phrase only; no absolute path and no raw byte
      // count of the volume ever reach the payload.
      const disk = diskStatus();
      // P2-250: lazy re-probes when the health route is consulted — doc
      // conversion and the opencode version verdicts are answered here, so
      // they are the two refreshed (at most once per interval each; reuse
      // answers immediately, never delayed).
      maybeReprobeDocConvert();
      maybeReprobeOpencodeVersion();
      send(200, {
        healthy: true,
        version: VERSION,
        machine: machineName,
        opencodeHealthy: metrics.get("ocr_opencode_healthy") === 1,
        // P2-135: additive detail of the last upstream probe; opencodeHealthy
        // above keeps its legacy boolean shape for existing clients.
        // P2-149: binaryFound/binarySource separate "opencode stopped" from
        // "opencode never installed" — only the boolean and the origin are
        // exposed; no absolute path, token or password ever reaches the payload.
        opencode: {
          ...opencodeDetail,
          binaryFound: binaryPick.path !== null,
          binarySource: binaryPick.source,
          // P2-213: additive version-readiness verdict — probed once at boot
          // (state + short pt-BR phrase). No absolute path and no raw probe
          // output ever reach the payload.
          versionState: opencodeVersion.state,
          versionMessage: opencodeVersion.message,
          // P2-250: additive — when the version verdict was last probed, so a
          // screen can say when that was checked. null until the first probe.
          versionCheckedAt: readinessCheckedAt(readinessState["opencode-version"].probedAt),
        },
        relayConnected,
        // P2-156: additive lastClose inside relayRetry — the close code and
        // triage kind of the most recent relay close (null until the first
        // close happens). No raw reason, URL or room id is ever exposed.
        // P2-260: additive lastDial in the same surface — kind + static
        // pt-BR hint of the most recent relay dial failure (null until the
        // first dial error), so the machine's owner can see WHY the relay is
        // unreachable; the raw Node message never reaches the payload.
        relayRetry: relayConnected
          ? null
          : { ...relayRetry.snapshot(), lastClose: relayLastClose, lastDial: relayLastDial },
        // P2-139: additive boot-validation verdict of RELAY_URL; relayConnected
        // and relayRetry above keep their exact shape. Userinfo (if any) is
        // redacted before the URL reaches the API surface.
        relay: {
          url: redactRelayUrl(RELAY_URL),
          ok: !relayDisabled,
          reason: relayDisabled ? relayUrl.problems.join(" ") : null,
        },
        // P2-190: additive bootstrap pairing-window verdict — true while a
        // virgin daemon (empty allowlist) would still auto-pair the first
        // client completing the handshake. `pairWindowOpenedAt = 0` (never
        // opened) reads as closed. No existing field is removed or renamed.
        pairingWindowOpen:
          bootstrapDecision(0, pairWindowOpenedAt, Date.now(), pairWindowCfg.windowMs) === "allow",
        // P2-215: additive disk-space verdict (see disk above) — existing
        // fields keep their exact shape.
        diskState: disk.state,
        diskMessage: disk.message,
        // P2-231: additive document→PDF conversion readiness — probed once at
        // boot (state + short pt-BR phrase + covered extensions). No absolute
        // path, URL scheme or raw probe output ever reaches the payload, and
        // no existing field is removed or renamed.
        docConvertState: docConvert.state,
        docConvertMessage: docConvert.message,
        docConvertExts: docConvert.exts,
        // P2-250: additive — when the doc-conversion verdict was last probed
        // (ISO instant, null before the first probe). Existing fields keep
        // their exact shape for the consumers P2-232 introduced.
        docConvertCheckedAt: readinessCheckedAt(readinessState["doc-convert"].probedAt),
      });
      return true;
    }
    // /api/session…
    if (seg[1] === "mcp" && (req.method === "GET" || req.method === "PUT")) {
      let body: unknown;
      if (req.method === "PUT") {
        const parsed = await readJsonBody<Record<string, unknown>>(req, res, "/api/mcp");
        if (parsed === null) return true;
        body = parsed;
      }
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
    // GET /api/pilot-ready — pending queue from BACKLOG.md (## Ready + ## Blocked).
    // P2-240: the queue comes from the pure backlogview module, which stops each
    // section at the next heading — unmarked lines in ## Done (or any later
    // section) no longer leak into both lists. Body shape is unchanged.
    if (seg[1] === "pilot-ready") {
      let ready: { id: string; title: string; area: string }[] = [];
      let blocked: { id: string; title: string; area: string }[] = [];
      try {
        const md = readFileSync(new URL("../../../BACKLOG.md", import.meta.url), "utf8");
        const view = queueView(md);
        ready = view.ready;
        blocked = view.blocked;
      } catch {}
      send(200, { ready, blocked });
      return true;
    }
    // POST /api/pilot-budget — edit daily budgets from the dashboard
    if (seg[1] === "pilot-budget" && req.method === "POST") {
      const body = await readJsonBody<{ maxTasksPerDay?: number; maxDeploysPerDay?: number }>(
        req,
        res,
        "/api/pilot-budget",
      );
      if (body === null) return true;
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
    // POST /api/pilot-fleet — live fleet control from the v3 dashboard:
    // slots (1-8, clamped) + tier-B coordinator model (fable/opus/…). The
    // pilot hot-reloads pilot.json every scheduling cycle (refreshFleet).
    if (seg[1] === "pilot-fleet" && req.method === "POST") {
      const body = await readJsonBody<{ slots?: number; coordinator?: string }>(req, res, "/api/pilot-fleet");
      if (body === null) return true;
      const file = join(homedir(), ".opencode-remote", "pilot.json");
      try {
        const cfg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const n = Number(body.slots);
        if (Number.isInteger(n) && n >= 1 && n <= 8) cfg.slots = n;
        if (typeof body.coordinator === "string" && /^[A-Za-z0-9._-]{3,64}$/.test(body.coordinator)) {
          const prev = (cfg.models as { tierB?: Record<string, string> } | undefined)?.tierB ?? {};
          cfg.models = {
            tierB: {
              ...prev,
              planner: body.coordinator,
              strategist: body.coordinator,
              forensic: body.coordinator,
              reviewerEscalation: body.coordinator,
            },
          };
        }
        writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        send(200, { cfg });
      } catch (err) {
        send(500, { error: String(err) });
      }
      return true;
    }
    // POST /api/pilot-notify — wake the supervisor session after a pipeline result
    if (seg[1] === "pilot-notify" && req.method === "POST") {
      const body = await readJsonBody<{ text?: string }>(req, res, "/api/pilot-notify");
      if (body === null) return true;
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
        const body = await readJsonBody<{ mission?: string }>(req, res, "/api/pilot-mission");
        if (body === null) return true;
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
      // Self-serve mission (mission.json, set from the chat) is the ACTIVE one
      // when present: its prompt wins over the legacy pilot.json statement and
      // the read-only spec (prompt/repoUrl/setAt — never anything else) feeds
      // the Mission Control sidebar.
      const spec = readMission().spec;
      let legacy = "";
      try {
        legacy = (JSON.parse(readFileSync(file, "utf8")) as { mission?: string }).mission ?? "";
      } catch {}
      // mission model substitutions: the pilot fell back from a pinned model
      // to the tier default (modelsubst.ts) — only entries matching the
      // active pins surface, so the card can say what actually ran
      const modelSubstitutions = activeModelSubstitutions(spec?.models, readModelSubstitutions(defaultModelSubstitutionsFile()));
      send(200, { mission: spec?.prompt ?? legacy, spec, modelSubstitutions });
      return true;
    }
    // DELETE /api/mission — mission v2 clear path: remove mission.json (atomic
    // unlink) so the pilot's drift check self-restarts back to self-improvement
    // mode. Same Bearer/cookie gate as every /api route (authorized() above);
    // a missing file is already the desired state (removed:false, still 200).
    if (seg[1] === "mission" && !seg[2] && req.method === "DELETE") {
      try {
        const r = removeMissionFile();
        log("info", "mission cleared via api", r);
        audit("mission.clear", r);
        send(200, { ok: true, ...r });
      } catch (err) {
        send(500, { error: String(err instanceof Error ? err.message : err) });
      }
      return true;
    }
    // GET /api/pilot-events — dashboard feed: state, heartbeat freshness, event tail
    if (seg[1] === "pilot-events") {
      const dir = join(homedir(), ".opencode-remote", "pilot");
      let allEvents: PilotEvent[] = [];
      try {
        allEvents = readFileSync(join(dir, "events.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as PilotEvent);
      } catch {}
      const events = allEvents.slice(-200);
      // P2-045: per-step gate failure breakdown over the full event file —
      // wider than the 200-event tail so the picture stays honest
      const failSteps = countFailSteps(allEvents);
      // P2-041: newest post-rollback health verdict (full file, not the tail) —
      // drives the dashboard's red "prod unhealthy" chip
      const rbAlert = rollbackHealthAlert(allEvents);
      // P2-075: newest pwa-origin verdict — drives the red "PWA down" chip
      const pwaAlert = pwaOriginAlert(allEvents);
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
      const lastAux: Record<string, string> = {};
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
      send(200, { state, heartbeatMs, events, cfg, lastAux, failSteps, rollbackUnhealthy: rbAlert !== null, rollbackDetail: rbAlert?.detail ?? "", pwaDown: pwaAlert?.down === true, pwaDetail: pwaAlert?.detail ?? "", priceSource: PRICE_SOURCE_LABEL });
      return true;
    }
    // GET /api/pilot-history — P2-043 history.jsonl digest: 7-day burn-down and
    // average duration per pipeline phase. `exists: false` until the file is
    // created, so the dashboard hides the widget instead of faking a trend.
    if (seg[1] === "pilot-history") {
      const dir = join(homedir(), ".opencode-remote", "pilot");
      let history: HistoryEntry[] = [];
      try {
        history = readFileSync(join(dir, "history.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as HistoryEntry);
      } catch {}
      let events: PilotEvent[] = [];
      try {
        events = readFileSync(join(dir, "events.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as PilotEvent);
      } catch {}
      send(200, { exists: history.length > 0, days: burnDown(history, 7), phaseAvg: avgPhaseDurations(events) });
      return true;
    }
    // P2-048: Mission Control forensic feed — navigable post-mortem per task.
    // GET /api/pilot-forensic          → session cards (goal/status/effort/ETA)
    // GET /api/pilot-forensic/timeline?task=ID → ordered forensic entries + shots
    if (seg[1] === "pilot-forensic" && req.method === "GET") {
      if (seg[2] === "timeline") {
        const task = url.searchParams.get("task") ?? "";
        if (!/^[P\d][\w.-]{1,24}$/.test(task)) {
          send(400, { error: "task required" });
          return true;
        }
        const index = readForensicIndex();
        const entries = index.timelines.get(task) ?? [];
        const cards = buildCards(index.timelines, index.titles, { avgDoneMs: avgDoneDuration(index.timelines) });
        const shots = shotsForTask(task, listShots());
        send(200, {
          card: cards.find((c) => c.id === task) ?? null,
          entries,
          progress: progressOf(entries),
          shots,
        });
        return true;
      }
      const index = readForensicIndex();
      const avgDoneMs = avgDoneDuration(index.timelines);
      const cards = buildCards(index.timelines, index.titles, { avgDoneMs });
      const shots = listShots();
      send(200, {
        cards: cards.map((c) => ({
          ...c,
          progress: progressOf(index.timelines.get(c.id) ?? []),
          shots: shotsForTask(c.id, shots),
        })),
      });
      return true;
    }
    // GET /api/pilot-shot?name=<file>.png — a real post-deploy capture from
    // pilot/shots. Name is a validated single segment; only .png is served.
    if (seg[1] === "pilot-shot" && req.method === "GET") {
      const p = shotPath(url.searchParams.get("name") ?? "");
      if (!p) {
        send(400, { error: "bad shot name" });
        return true;
      }
      try {
        const png = readFileSync(p);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(png);
      } catch {
        send(404, { error: "shot not found" });
      }
      return true;
    }
    // POST /api/pilot-takeover {task} — human takeover of a pilot agent run:
    // opens Terminal.app attached to the SAME opencode builder session
    // (opencode -s <ses_…>) inside the task's workspace clone. Ids are read
    // from the real builder log; without one, the workspace alone is opened.
    // Round-2 review: log-derived values are agent-adjacent, so directory and
    // session id are strictly validated (workspace under pilot/repo-*, char
    // allowlist, ses_<alnum> id) before touching AppleScript/shell — and the
    // body parse is guarded, a malformed POST is 400, never a daemon crash.
    if (seg[1] === "pilot-takeover" && req.method === "POST") {
      let body: { task?: string };
      try {
        body = JSON.parse((await readBody(req)) || "{}") as { task?: string };
      } catch (err) {
        if (isBodyLimitError(err)) {
          refuseBody(res, "/api/pilot-takeover", err);
          return true;
        }
        send(400, { error: "invalid body" });
        return true;
      }
      const task = body.task ?? "";
      if (!/^[P\d][\w.-]{1,24}$/.test(task)) {
        send(400, { error: "task required" });
        return true;
      }
      let directory: string | null = null;
      let sessionId: string | null = null;
      try {
        const lines = readFileSync(builderLogPath(task), "utf8").split("\n").filter(Boolean);
        const found = takeoverFromBuilderLog(lines.slice(-400));
        directory = validateTakeoverDirectory(found.directory);
        sessionId = validateTakeoverSessionId(found.sessionId);
      } catch {}
      // validated fallback: a static safe path, never a log value
      if (!directory) directory = join(homedir(), ".opencode-remote", "pilot");
      const cmd = sessionId ? `opencode -s ${sessionId}` : "opencode";
      const script = `tell application "Terminal"
  activate
  do script "cd '${directory}' && ${cmd}"
end tell`;
      try {
        await promisify(execFile)("osascript", ["-e", script]);
        log("info", "pilot takeover — terminal attached", { task, sessionId });
        send(200, { ok: true, directory, sessionId });
      } catch (err) {
        send(500, { error: String(err instanceof Error ? err.message : err) });
      }
      return true;
    }
    // GET /api/artifacts?session=… — list agent artifacts (P1-010)
    if (seg[1] === "artifacts" && seg[2] === "file" && req.method === "GET") {
      const session = url.searchParams.get("session") ?? "";
      const name = url.searchParams.get("name") ?? "";
      const read = readArtifact(session, name);
      if (!read.ok) {
        send(read.reason === "too-large" ? 413 : 404, {
          error: read.reason === "too-large" ? "artifact too large" : "artifact not found",
        });
        return true;
      }
      const buf = read.data;
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
      // P2-173: capped payload (newest first) + additive total/truncated —
      // same contract as the tunnel route.
      const { items, total, truncated } = capArtifacts(listArtifacts(url.searchParams.get("session") ?? undefined));
      // P2-091: resolve sessionId → conversation title for the global listing
      // (same contract as the tunnel route; best effort on backend failures).
      let titles: Record<string, string> = {};
      if (items.length > 0 && !url.searchParams.get("session")) {
        try {
          const r = await op("GET", "/session");
          titles = sessionTitleMap(r.body, [...new Set(items.map((a) => a.sessionId))]);
        } catch {
          // backend unreachable — clients fall back to the raw session ids
        }
      }
      send(200, { artifacts: items, titles, total, truncated });
      return true;
    }
    if (seg[1] !== "session") {
      // POST /api/push — authenticated digest push (used by the pilot loop)
      if (seg[1] === "push" && req.method === "POST") {
        const body = await readJsonBody<{ title?: string; body?: string; url?: string }>(req, res, "/api/push");
        if (body === null) return true;
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
      const body = await readJsonBody<{ title?: string }>(req, res, "/api/session");
      if (body === null) return true;
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
      const body = await readJsonBody<{ text?: string }>(req, res, "/api/session/:id/message");
      if (body === null) return true;
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
  // P2-180: fail-closed body-limit boot — one log line per problem, exit code
  // 1, and no listener at all when OCR_MAX_BODY_BYTES is invalid. The daemon
  // never runs with a ceiling the operator did not ask for.
  if (bodyLimitResolution.problems.length > 0) {
    for (const problem of bodyLimitResolution.problems) log("error", problem);
    process.exit(1);
    return;
  }
  // P2-181: same fail-closed contract for the chunk-staging ceilings — an
  // invalid OCR_UPLOAD_MAX_MB never falls back to the default silently.
  if (chunkLimits.problems.length > 0) {
    for (const problem of chunkLimits.problems) log("error", problem);
    process.exit(1);
    return;
  }
  // P2-190: same fail-closed contract for the bootstrap pairing window — an
  // invalid OCR_PAIR_WINDOW_MS never falls back to the default silently.
  if (pairWindowCfg.problems.length > 0) {
    for (const problem of pairWindowCfg.problems) log("error", problem);
    process.exit(1);
    return;
  }
  // P2-228: same fail-closed contract for the uploads retention thresholds —
  // an invalid OCR_UPLOAD_RETENTION_* never falls back to the default silently.
  if (uploadRetention.problems.length > 0) {
    for (const problem of uploadRetention.problems) log("error", problem);
    process.exit(1);
    return;
  }
  // P2-248: same fail-closed contract for the clips retention thresholds —
  // an invalid OCR_CLIP_RETENTION_* never falls back to the default silently.
  if (clipRetention.problems.length > 0) {
    for (const problem of clipRetention.problems) log("error", problem);
    process.exit(1);
    return;
  }
  // P2-236: same fail-closed contract for the routine run lease — an invalid
  // OCR_RUN_LEASE_MS never falls back to the default silently.
  if (runLease.problems.length > 0) {
    for (const problem of runLease.problems) log("error", problem);
    process.exit(1);
    return;
  }
  // P2-250: same fail-closed contract for the lazy re-probe knobs — an
  // invalid OCR_READINESS_* never falls back to the default silently.
  if (readinessKnobs.problems.length > 0) {
    for (const problem of readinessKnobs.problems) log("error", problem);
    process.exit(1);
    return;
  }

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

  const whisperDetected = await detectWhisperDetail();
  whisperTool = whisperDetected.tool;
  sttToolType = whisperDetected.toolType;
  sttModelPresent = whisperDetected.modelPresent;
  if (whisperTool) log("info", "voice transcription available", { kind: whisperTool.kind });
  else log("info", "voice transcription unavailable (optional feature)", { state: sttStatus().state });

  edgeTtsBin = detectEdgeTts();
  if (edgeTtsBin) log("info", "voice replies available", { voice: resolveVoice("pt-BR", TTS_PT_VOICE).voice, voices: TTS_VOICES });
  else log("info", "voice replies unavailable (edge-tts not found; optional feature)");

  // P2-231: same readiness hook as the capabilities above — one probe, in
  // memory, before any server answers; boot never blocks on it.
  probeDocConvert();

  // P2-250: stamp the boot instants of the cached verdicts — the lazy
  // re-probes count their interval from here. No additional boot probe.
  readinessState.transcription.probedAt = Date.now();
  readinessState["doc-convert"].probedAt = Date.now();

  log("info", "daemon starting (protocol v2)", {
    machine: machineName,
    opencode: OPENCODE_URL,
    relay: redactRelayUrl(RELAY_URL),
    pairedClients: readAllowlist().length,
  });

  // P2-139: log the fail-closed verdict exactly once at boot — retry-time
  // logging would just repeat the same static config error forever.
  if (relayDisabled) {
    log("error", "RELAY_URL is invalid — relay connection disabled (fail-closed)", {
      relay: redactRelayUrl(RELAY_URL),
      problems: relayUrl.problems,
    });
  }

  const metricsPort = Number(process.env.OCR_METRICS_PORT);
  if (metricsPort) {
    apiServer = startMetricsServer(metricsPort, handleApi);
    boundMetricsPort = metricsPort;
    // P1-061: direct loopback WS for same-machine clients (desktop shell).
    attachLocalWs(apiServer);
  }

  // boot healthcheck: fail loudly early if opencode is unreachable
  // P2-135: the probe now feeds the same classifier as the watchdog, so the
  // very first /api/health answer already carries the real failure mode.
  // P2-149: resolve the opencode binary once up front so even the boot verdict
  // distinguishes "server stopped" from "server never installed".
  refreshOpencodeBinary(true);
  // P2-213: version readiness — the documented OCR_OPENCODE_OLD=1 test hatch
  // forces too-old for deterministic visual evidence; otherwise probe once,
  // only when a binary was resolved, on the path already picked above.
  // Fire-and-forget: the probe never blocks or delays boot, has no retry and
  // no periodic re-probe — the verdict describes the binary that booted.
  if (process.env.OCR_OPENCODE_OLD === "1") {
    opencodeVersion = versionVerdict("v0.0.1", MIN_OPENCODE_VERSION);
  } else if (binaryPick.path !== null) {
    probeOpencodeVersion(binaryPick.path);
  }
  // P2-250: the version verdict above (probe, hatch or no-binary) is the
  // cached boot verdict — the lazy re-probe interval counts from here.
  readinessState["opencode-version"].probedAt = Date.now();
  const signal = AbortSignal.timeout(UPSTREAM_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(new URL("/global/health", OPENCODE_URL), {
      headers: authHeader ? { authorization: authHeader } : {},
      signal,
    });
    let body: unknown;
    let bodyOk = true;
    try {
      body = await res.json();
    } catch {
      bodyOk = false;
    }
    const verdict = classifyUpstream({ status: res.status, body, bodyOk, binaryFound: binaryPick.path !== null });
    recordUpstream(verdict);
    log("info", "opencode healthcheck", { status: res.status, state: verdict.state, reason: verdict.reason });
  } catch (err) {
    refreshOpencodeBinary();
    const verdict = classifyUpstream({ error: err, timedOut: signal.aborted, binaryFound: binaryPick.path !== null });
    recordUpstream(verdict);
    log("warn", "opencode unreachable at boot (will keep retrying events)", {
      opencode: OPENCODE_URL,
      state: verdict.state,
      reason: verdict.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (relayDisabled) {
    // P2-139: a QR embedding an unusable relay URL is worse than no QR —
    // withhold the pairing URI entirely (not printed here, and
    // /__ocr/pairing-uri keeps serving null). The desktop app's local mode
    // (P1-070) never rides the relay and keeps working.
    console.log(`\n  opencode remote daemon (protocol v2)`);
    console.log(`  machine:  ${machineName}`);
    console.log(`  opencode: ${OPENCODE_URL}`);
    console.log(`  relay:    ${redactRelayUrl(RELAY_URL)} (invalid — relay disabled, see log)`);
    console.log(`  clients:  ${readAllowlist().length} paired`);
    console.log(`\n  Pairing QR withheld: fix RELAY_URL and restart the daemon.\n`);
  } else {
    pairingUri =
      `opencode-remote://pair?v=2` +
      `&relay=${encodeURIComponent(RELAY_URL)}` +
      `&room=${daemon.room}` +
      `&k=${encodeURIComponent(daemon.identity.publicKey)}` +
      `&vapid=${encodeURIComponent(daemon.vapid.publicKey)}` +
      `&name=${encodeURIComponent(machineName)}`;

    console.log(`\n  opencode remote daemon (protocol v2)`);
    console.log(`  machine:  ${machineName}`);
    console.log(`  opencode: ${OPENCODE_URL}`);
    console.log(`  relay:    ${redactRelayUrl(RELAY_URL)}`);
    console.log(`  clients:  ${readAllowlist().length} paired`);
    console.log(`\n  Pair with the PWA by scanning this QR code:\n`);
    console.log(await QRCode.toString(pairingUri, { type: "terminal", small: true }));
    console.log(`  or paste: ${pairingUri}\n`);
  }

  // P2-190: the bootstrap window opens at boot; pairing right after the
  // daemon starts keeps working (the localws e2e depends on this).
  pairWindowOpenedAt = Date.now();
  connectRelay();
  void forwardEvents();
}

main().catch((err) => {
  log("error", "fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
