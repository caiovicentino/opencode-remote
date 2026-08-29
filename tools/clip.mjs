#!/usr/bin/env node
// opencode-remote video clipping pipeline (local, no cloud).
//   node tools/clip.mjs transcribe <video>           -> prints path of word-timed JSON
//   node tools/clip.mjs render <video> <plan.json>   -> renders social clips per plan
// plan.json: { "clips": [ { "start": 12.3, "end": 45.6, "title": "Hook",
//   "captions": true, "aspect": "9:16", "cropX": 0.5 } ] }
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";

const MODEL_CANDIDATES = [
  process.env.OCR_WHISPER_MODEL,
  join(homedir(), ".opencode-remote", "whisper", "ggml-base.bin"),
  join(homedir(), ".cache", "whisper", "ggml-base.bin"),
  join(homedir(), ".cache", "whisper", "ggml-small.bin"),
  join(homedir(), ".cache", "whisper", "ggml-medium.bin"),
].filter(Boolean);

function model() {
  for (const c of MODEL_CANDIDATES) if (existsSync(c)) return c;
  throw new Error("no whisper ggml model found; run scripts/setup-whisper.sh");
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr?.slice(-400) || r.stdout?.slice(-400)}`);
  return r;
}

/** Prefer an ffmpeg build with libass (subtitles filter); fall back to PATH. */
function ffmpegBin() {
  if (process.env.OCR_FFMPEG) return process.env.OCR_FFMPEG;
  const candidates = [
    "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  const w = spawnSync("which", ["ffmpeg-full"], { encoding: "utf8" });
  if (w.status === 0 && w.stdout.trim()) return w.stdout.trim();
  return "ffmpeg";
}

function transcribe(video) {
  const work = join(homedir(), ".opencode-remote", "clips");
  mkdirSync(work, { recursive: true });
  const wav = join(work, `${basename(video)}-${Date.now()}.wav`);
  run(ffmpegBin(), ["-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", wav]);
  const json = `${wav}.json`;
  run("whisper-cli", ["-m", model(), "-ojf", "-sow", "-l", "auto", "-f", wav, "-oj", "-of", wav]);
  if (!existsSync(json)) throw new Error("whisper did not produce JSON");
  unlinkSync(wav);
  console.log(json);
}

function fmtAssTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

const ASPECTS = { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080] };

function loadStyle() {
  const p = join(homedir(), ".opencode-remote", "clip-style.json");
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      // fall back to defaults
    }
  }
  return {};
}

function buildAss(words, clipStart, clipEnd, shift, style = {}, dims = [1080, 1920]) {
  const st = {
    font: "Helvetica Bold",
    fontSize: 64,
    primary: "&H00FFFFFF",
    secondary: "&H0000E5FF",
    outlineColor: "&H00000000",
    outline: 4,
    marginV: 300,
    ...style,
  };
  const header =
    "[Script Info]\nScriptType: v4.00+\n" +
    `PlayResX: ${dims[0]}\nPlayResY: ${dims[1]}\nWrapStyle: 2\n\n` +
    "[V4+ Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    `Style: Cap,${st.font},${st.fontSize},${st.primary},${st.secondary},${st.outlineColor},&H80000000,-1,0,0,0,100,100,0,0,1,${st.outline},2,2,60,60,${st.marginV},1\n\n` +
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  const lines = [];
  let cur = [];
  let curStart = null;
  let curEnd = null;
  for (const w of words) {
    if (!w.text?.trim()) continue;
    if (w.end <= clipStart || w.start >= clipEnd) continue;
    const s = Math.max(w.start, clipStart) - shift;
    const e = Math.min(w.end, clipEnd) - shift;
    if (curStart === null) curStart = s;
    cur.push({ s, e, text: w.text.trim() });
    curEnd = e;
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0);
    if (/[.!?…]$/.test(w.text) || chars > 40) {
      lines.push({ start: curStart, end: curEnd, words: cur });
      cur = [];
      curStart = null;
      curEnd = null;
    }
  }
  if (curStart !== null && cur.length) lines.push({ start: curStart, end: curEnd, words: cur });
  const events = lines
    .map((l) => {
      let prev = l.start;
      let text = "";
      for (const w of l.words) {
        const dur = Math.max(1, Math.round((w.e - prev) * 100));
        text += `{\\k${dur}}${w.text} `;
        prev = w.e;
      }
      return `Dialogue: 0,${fmtAssTime(l.start)},${fmtAssTime(l.end)},Cap,,0,0,0,,${text.trimEnd()}`;
    })
    .join("\n");
  return `${header}${events}\n`;
}
function render(video, planPath) {
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const style = loadStyle();
  const words = plan.__words ?? null;
  const outDir = join(homedir(), ".opencode-remote", "clips", basename(video).replace(/\.[^.]+$/, ""));
  mkdirSync(outDir, { recursive: true });
  const assPath = join(outDir, "cap.ass");
  let wordTimed = plan.__words;
  if (!wordTimed) {
    // look for the JSON next to the video (from transcribe step) if referenced
    const jsonPath = plan.transcriptJson;
    if (jsonPath && existsSync(jsonPath)) wordTimed = JSON.parse(readFileSync(jsonPath, "utf8"));
  }
  const outs = [];
  let n = 0;
  for (const clip of plan.clips) {
    n += 1;
    const dur = clip.end - clip.start;
    if (dur <= 0.5) continue;
    const cropX = typeof clip.cropX === "number" ? Math.min(1, Math.max(0, clip.cropX)) : 0.5;
    const dims = ASPECTS[clip.aspect] ?? ASPECTS["9:16"];
    const vf = [
      `scale=${dims[0]}:${dims[1]}:force_original_aspect_ratio=increase`,
      `crop=${dims[0]}:${dims[1]}:(iw-${dims[0]})*${cropX}:(ih-${dims[1]})*0.5`,
    ];
    if (clip.captions !== false && wordTimed) {
      const ass = buildAss(wordTimed, clip.start, clip.end, clip.start, style, dims);
      writeFileSync(assPath, ass);
      vf.push(`subtitles=${assPath}:alpha=0`);
    }
    const out = join(outDir, `${String(n).padStart(2, "0")}-${(clip.title || "clip").replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}.mp4`);
    run(ffmpegBin(), [
      "-y", "-ss", String(clip.start), "-to", String(clip.end), "-i", video,
      "-vf", vf.join(","), "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
    ]);
    outs.push({ title: clip.title || `clip ${n}`, path: resolve(out) });
  }
  for (const o of outs) console.log(`${o.title}\t${o.path}`);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === "transcribe") transcribe(resolve(rest[0]));
else if (cmd === "render") {
  const plan = JSON.parse(readFileSync(rest[1], "utf8"));
  const transcriptJson = plan.transcriptJson;
  if (transcriptJson && existsSync(transcriptJson)) {
    plan.__words = flattenWords(JSON.parse(readFileSync(transcriptJson, "utf8")));
    writeFileSync(rest[1], JSON.stringify(plan));
  }
  render(resolve(rest[0]), resolve(rest[1]));
} else {
  console.error("usage: clip.mjs transcribe <video> | render <video> <plan.json>");
  process.exit(1);
}

function flattenWords(fullJson) {
  const words = [];
  for (const seg of fullJson.transcription ?? []) {
    for (const t of seg.tokens ?? []) {
      if (!t.text || t.text.startsWith("[")) continue;
      words.push({ text: t.text, start: (t.offsets?.from ?? 0) / 1000, end: (t.offsets?.to ?? 0) / 1000 });
    }
  }
  return words;
}
