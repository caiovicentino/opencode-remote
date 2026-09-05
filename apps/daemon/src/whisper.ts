import { spawn, execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

export type WhisperKind = "whisper-cpp" | "openai" | "mlx";

export interface WhisperTool {
  kind: WhisperKind;
  bin: string;
  model?: string;
}

const MODEL_PATH = () => process.env.OCR_WHISPER_MODEL ?? join(homedir(), ".opencode-remote", "whisper", "ggml-base.bin");

/** Resolve a ggml model: env override, harness dir, or common cache locations. */
function resolveModel(): string | null {
  const candidates = [
    MODEL_PATH(),
    join(homedir(), ".cache", "whisper", "ggml-base.bin"),
    join(homedir(), ".cache", "whisper", "ggml-small.bin"),
    join(homedir(), ".cache", "whisper", "ggml-medium.bin"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
const RUN_TIMEOUT_MS = 180_000;
const MAX_AUDIO_BYTES = 30_000_000;

function which(bin: string): string | null {
  try {
    const out = execSync(`command -v ${bin}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const p = out.trim();
    return p.startsWith("/") ? p : null;
  } catch {
    return null;
  }
}

function buildCppTool(bin: string): { tool: WhisperTool | null; modelPresent: boolean } {
  const model = resolveModel();
  if (!model) {
    log("warn", "whisper.cpp found but no ggml model found; run scripts/setup-whisper.sh", {
      expected: MODEL_PATH(),
    });
    return { tool: null, modelPresent: false };
  }
  return { tool: { kind: "whisper-cpp", bin, model }, modelPresent: true };
}

export interface WhisperDetection {
  /** Usable transcription tool, or null when the host has none ready. */
  tool: WhisperTool | null;
  /** Raw engine type found on the host — survives even when no usable tool
   * could be built (binary present, model missing). */
  toolType: WhisperKind | null;
  /** Whether the engine's model file was found (whisper-cpp only needs one). */
  modelPresent: boolean;
}

/**
 * P2-201: full detection facts. detectWhisper() collapses a binary-without-
 * model host into null, which hides the real reason from the capability
 * status; this shape keeps it intact so the verdict can say what to fix.
 */
export async function detectWhisperDetail(): Promise<WhisperDetection> {
  // launchd/CI environments have a minimal PATH — probe common absolute
  // locations before falling back to PATH lookup
  const abs = ["/opt/homebrew/bin", "/usr/local/bin"];
  for (const bin of ["whisper-cli", "whisper-cpp"]) {
    for (const dir of abs) {
      const candidate = join(dir, bin);
      if (existsSync(candidate)) {
        const cpp = buildCppTool(candidate);
        return { tool: cpp.tool, toolType: "whisper-cpp", modelPresent: cpp.modelPresent };
      }
    }
  }
  for (const bin of ["whisper-cli", "whisper-cpp"]) {
    const p = which(bin);
    if (p) {
      const cpp = buildCppTool(p);
      return { tool: cpp.tool, toolType: "whisper-cpp", modelPresent: cpp.modelPresent };
    }
  }
  const mlx = which("mlx_whisper");
  if (mlx) return { tool: { kind: "mlx", bin: mlx }, toolType: "mlx", modelPresent: true };
  const oa = which("whisper");
  if (oa) return { tool: { kind: "openai", bin: oa }, toolType: "openai", modelPresent: true };
  return { tool: null, toolType: null, modelPresent: false };
}

export async function detectWhisper(): Promise<WhisperTool | null> {
  return (await detectWhisperDetail()).tool;
}

function run(
  bin: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; file?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", () => {});
    const killer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({ ok: false, stdout: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ ok: code === 0, stdout });
    });
  });
}

/** Transcribe a WAV (16 kHz mono) buffer with the local whisper install. */
export async function transcribeAudio(
  tool: WhisperTool,
  wav: Buffer,
  opts?: { lang?: string },
): Promise<string> {
  const lang = opts?.lang && opts.lang !== "auto" ? opts.lang : "auto";
  if (wav.length > MAX_AUDIO_BYTES) throw new Error("audio too large (30MB limit)");
  const dir = join(homedir(), ".opencode-remote", "whisper");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  const outDir = join(dir, "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(tmp, wav);
  try {
    let res: { ok: boolean; stdout: string; file?: string };
    if (tool.kind === "whisper-cpp") {
      res = await run(tool.bin, ["-m", tool.model!, "-nt", "-l", lang, "-f", tmp]);
      return res.ok
        ? res.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !/^\[.*\]$/.test(l))
            .join(" ")
            .trim()
        : "";
    }
    if (tool.kind === "mlx") {
      res = await run(tool.bin, [tmp, "--output-format", "txt", "--output-dir", outDir]);
    } else {
      res = await run(tool.bin, [tmp, "--output_format", "txt", "--output_dir", outDir]);
    }
    if (!res.ok) return "";
    const base = tmp.replace(/\.wav$/, ".txt").split("/").pop()!;
    const outFile = join(outDir, base);
    if (!existsSync(outFile)) return "";
    const text = readFileSync(outFile, "utf8").trim();
    unlinkSync(outFile);
    return text;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}
