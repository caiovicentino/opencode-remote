// Voice replies: local speech synthesis via the edge-tts CLI (optional host
// tool, like whisper-cli). Zero network surface in the app itself — the CLI
// contacts Microsoft's TTS endpoint on its own; we only shell out and read the
// rendered mp3 back. Audio content never touches the log file.
import { spawn, execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { normalizeLang, spokenNumbers, type SpeechLang } from "./spoken.js";

const TTS_TIMEOUT_MS = 30_000;
/** Upper bound on a single request: replies are spoken briefly (the client
 * sends only the brief); anything longer is a bug and gets rejected. */
export const MAX_TTS_CHARS = 2000;

/** One natural voice per supported speech language (allowlist — the client
 * never picks the voice string directly). */
export const TTS_VOICES: Record<SpeechLang, string> = {
  "pt-BR": "pt-BR-AntonioNeural",
  "en-US": "en-US-AndrewNeural",
  "es-ES": "es-ES-AlvaroNeural",
};

/** Resolve an untrusted lang value to a fixed voice; an env override (legacy
 * OCR_TTS_VOICE) replaces the pt-BR default. */
export function resolveVoice(lang: unknown, ptOverride?: string): { lang: SpeechLang; voice: string } {
  const l = normalizeLang(lang);
  return { lang: l, voice: (l === "pt-BR" && ptOverride) || TTS_VOICES[l] };
}

export function detectEdgeTts(): string | null {
  try {
    const out = execSync("command -v edge-tts", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const p = out.trim();
    return p.startsWith("/") ? p : null;
  } catch {
    return null;
  }
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("edge-tts timed out"));
    }, timeoutMs);
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < 2000) stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`edge-tts exited ${code}: ${stderr.slice(-400) || "no stderr"}`));
    });
  });
}

/** Render `text` to mp3 bytes with edge-tts. Temp media is always unlinked. */
export async function synthesizeSpeech(bin: string, text: string, voice: string): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty text");
  if (trimmed.length > MAX_TTS_CHARS) throw new Error(`text too long (${trimmed.length} > ${MAX_TTS_CHARS})`);
  const out = join(tmpdir(), `ocr-tts-${randomUUID()}.mp3`);
  try {
    await run(bin, ["--voice", voice, "--text", trimmed, "--write-media", out], TTS_TIMEOUT_MS);
    return readFileSync(out);
  } finally {
    try {
      unlinkSync(out);
    } catch {}
  }
}

// ── mp3 cache + warm-up (voice-reply latency) ─────────────────────────────
// Synthesis takes 1-3s (edge-tts contacts Microsoft); on the phone that sits
// on the critical path. forwardEvents() pre-renders the brief at session.idle
// so the client's later request is usually a cache hit. Keyed by the spoken
// (normalized) text + resolved voice.
const TTS_CACHE_TTL_MS = 15 * 60_000;
const TTS_CACHE_MAX = 24;
const ttsCache = new Map<string, { audio: Buffer; at: number }>();

function ttsCacheKey(spokenText: string, voice: string): string {
  return `${voice}|${createHash("sha256").update(spokenText).digest("hex")}`;
}

function cachePut(key: string, audio: Buffer): void {
  const now = Date.now();
  ttsCache.delete(key);
  ttsCache.set(key, { audio, at: now });
  for (const [k, v] of ttsCache) if (now - v.at > TTS_CACHE_TTL_MS) ttsCache.delete(k);
  while (ttsCache.size > TTS_CACHE_MAX) {
    const oldest = ttsCache.keys().next().value;
    if (oldest === undefined) break;
    ttsCache.delete(oldest);
  }
}

export function putSpeech(spokenText: string, voice: string, audio: Buffer): void {
  cachePut(ttsCacheKey(spokenText, voice), audio);
}

export function cachedSpeech(spokenText: string, voice: string): Buffer | null {
  const hit = ttsCache.get(ttsCacheKey(spokenText, voice));
  if (!hit || Date.now() - hit.at > TTS_CACHE_TTL_MS) return null;
  return hit.audio;
}

/** Fire-and-forget warm-up: render the spoken brief into the cache. Best
 * effort — a miss just falls back to on-demand synthesis. */
export async function prewarmSpeech(
  bin: string,
  briefText: string,
  lang: SpeechLang,
  ptOverride?: string,
): Promise<void> {
  const trimmed = briefText.trim();
  if (!trimmed) return;
  const { lang: spokenLang, voice } = resolveVoice(lang, ptOverride);
  const spoken = spokenNumbers(trimmed, spokenLang);
  if (cachedSpeech(spoken, voice)) return;
  try {
    putSpeech(spoken, voice, await synthesizeSpeech(bin, spoken, voice));
  } catch {
    // best effort
  }
}
