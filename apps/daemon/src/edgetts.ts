// Voice replies: local speech synthesis via the edge-tts CLI (optional host
// tool, like whisper-cli). Zero network surface in the app itself — the CLI
// contacts Microsoft's TTS endpoint on its own; we only shell out and read the
// rendered mp3 back. Audio content never touches the log file.
import { spawn, execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const TTS_TIMEOUT_MS = 30_000;
/** Upper bound on a single request: replies are spoken briefly (the client
 * sends only the brief); anything longer is a bug and gets rejected. */
export const MAX_TTS_CHARS = 2000;

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
