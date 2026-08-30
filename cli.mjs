#!/usr/bin/env node
// OpenCode Remote CLI — setup, diagnostics and service control.
// Works from a repo checkout (npm i -g github:caiovicentino/opencode-remote)
// or a Homebrew prefix (formula runs npm ci at install time).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dirname;
const STATE_DIR = join(homedir(), ".opencode-remote");
const STATE_FILE = join(STATE_DIR, "daemon.json");
const GUI = `gui/${process.getuid?.() ?? 501}`;
const RELAY_URL_DEFAULT = "ws://127.0.0.1:8787";

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", R = "\x1b[0m";
const ok = (msg) => console.log(`  ${GREEN}✓${R} ${msg}`);
const warn = (msg) => console.log(`  ${YELLOW}⚠${R} ${msg}`);
const bad = (msg) => console.log(`  ${RED}✗${R} ${msg}`);
const info = (msg) => console.log(`  ${DIM}${msg}${R}`);

function which(bin) {
  const r = spawnSync("command", ["-v", bin], { encoding: "utf8", shell: true });
  const p = (r.stdout ?? "").trim();
  return r.status === 0 && p.startsWith("/") ? p : null;
}

function sh(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", ...opts });
}

function portOpen(port) {
  return fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(1200) })
    .then((r) => r.ok)
    .catch(() => false);
}

function pairingUri(relayUrl) {
  const st = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const name = st.name ?? process.env.OCR_MACHINE_NAME ?? "my-machine";
  return (
    `opencode-remote://pair?v=2&relay=${encodeURIComponent(relayUrl)}` +
    `&room=${st.room}&k=${encodeURIComponent(st.ecdhPub)}` +
    `&vapid=${encodeURIComponent(st.vapid.publicKey)}&name=${encodeURIComponent(name)}`
  );
}

async function doctor() {
  console.log("\n  opencode-remote doctor\n");
  const [maj] = process.versions.node.split(".").map(Number);
  maj >= 20 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} — 20+ required`);

  const oc = which("opencode");
  oc ? ok(`opencode CLI: ${oc}`) : bad("opencode CLI not found — curl -fsSL https://opencode.ai/install | bash");

  try {
    const r = await fetch("http://127.0.0.1:4096/global/health", { signal: AbortSignal.timeout(1500) });
    const b = await r.json();
    r.ok && b.healthy !== false ? ok(`opencode serve healthy on :4096 (${b.version ?? "?"})`) : bad("opencode serve responded but is not healthy");
  } catch {
    bad("opencode serve unreachable on :4096 — run: opencode serve --port 4096");
  }

  if (existsSync(STATE_FILE)) {
    const mode = (statSync(STATE_FILE).mode & 0o777).toString(8);
    mode === "600" ? ok("daemon state file present (0600)") : warn(`daemon state file perms are ${mode} — will be tightened on next daemon start`);
    const st = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    ok(`${(st.clients ?? []).length} paired device(s)`);
  } else {
    bad("no daemon state — run: opencode-remote setup");
  }

  const whisperModel = ["ggml-base.bin", "ggml-small.bin", "ggml-medium.bin"]
    .map((f) => join(STATE_DIR, "whisper", f))
    .find(existsSync) ?? join(homedir(), ".cache", "whisper", "ggml-base.bin");
  existsSync(whisperModel) && which("whisper-cli")
    ? ok(`voice transcription ready (${whisperModel.split("/").pop()})`)
    : warn("voice transcription not installed — scripts/setup-whisper.sh (optional)");

  which("ffmpeg") ? ok("ffmpeg present (clips pipeline)") : warn("ffmpeg not found — clips pipeline disabled (optional)");

  const daemonUp = await portOpen(8792);
  daemonUp ? ok("daemon running (metrics :8792)") : bad("daemon not running — opencode-remote start");
  const relayUp = (await portOpen(8790)) || (await portOpen(8787));
  relayUp ? ok("relay running") : warn("relay not running locally (may be remote — check RELAY_URL)");

  const print = (label, s) => s ? ok(`${label}: ${s}`) : bad(`${label}: not loaded`);
  const state = (label) => {
    const r = sh(`launchctl print ${GUI}/${label} 2>/dev/null | grep -m1 state`);
    return (r.stdout ?? "").trim().split("=").pop()?.trim() || null;
  };
  print("daemon service", state("com.ocr.daemon"));
  print("relay service", state("com.ocr.relay"));

  console.log("");
  if (existsSync(STATE_FILE) && daemonUp) {
    console.log(`  pair a phone: opencode-remote qr\n`);
  }
}

async function qr() {
  const relayUrl = process.env.RELAY_URL ?? RELAY_URL_DEFAULT;
  if (!existsSync(STATE_FILE)) return bad("no daemon state — run: opencode-remote setup");
  const uri = pairingUri(relayUrl);
  const QRCode = (await import("qrcode")).default;
  console.log(`\n  relay: ${relayUrl}\n`);
  console.log(await QRCode.toString(uri, { type: "terminal", small: true }));
  console.log(`  or paste: ${uri}\n`);
}

function serviceLabel(name) {
  return `${GUI}/com.ocr.${name}`;
}

function start() {
  for (const t of ["com.ocr.relay", "com.ocr.daemon"]) {
    const r = sh(`launchctl kickstart -k ${serviceLabel(t)} 2>&1`);
    r.status === 0 ? ok(`${t} kicked`) : bad(`${t}: ${r.stderr || "not installed (opencode-remote setup)"}`);
  }
}

function stop() {
  for (const t of ["com.ocr.daemon", "com.ocr.relay"]) {
    const r = sh(`launchctl bootout ${serviceLabel(t)} 2>&1`);
    r.status === 0 ? ok(`${t} stopped`) : bad(`${t}: not loaded`);
  }
}

function status() {
  for (const t of ["com.ocr.relay", "com.ocr.daemon"]) {
    const out = sh(`launchctl print ${GUI}/${t} 2>/dev/null | grep -E "state|pid" | head -2`).stdout ?? "";
    const state = /state = (\w+)/.exec(out)?.[1] ?? "not loaded";
    const pid = /pid = (\d+)/.exec(out)?.[1] ?? "-";
    console.log(`  ${t}: ${state} (pid ${pid})`);
  }
  const st = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  console.log(`  paired clients: ${(st.clients ?? []).length}`);
}

async function setup() {
  const relayArg = process.argv.find((a) => a.startsWith("--relay="));
  let relayUrl = relayArg?.split("=")[1] ?? process.env.RELAY_URL;
  if (!relayUrl) {
    if (!process.stdin.isTTY) return bad("set RELAY_URL or pass --relay=wss://host:8788");
    const readline = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    const answer = await readline.question("\n  Relay URL reachable from your phone (wss://host:8788) [tailscale recommended]: ");
    relayUrl = answer.trim() || RELAY_URL_DEFAULT;
    readline.close();
  }

  console.log("\n  checking prerequisites…\n");
  await doctor();

  console.log("\n  installing launchd services (KeepAlive)…\n");
  const r = sh(`RELAY_URL=${JSON.stringify(relayUrl)} bash ${ROOT}/deploy/install.sh`, { cwd: ROOT });
  process.stdout.write(r.stdout ?? "");
  if (r.status !== 0) {
    process.stderr.write(r.stderr ?? "");
    return bad("install failed — see output above");
  }
  console.log(`\n  done. pair your phone:\n`);
  await qr();
}

const cmd = process.argv[2] ?? "status";
const commands = { doctor, qr, start, stop, status, setup };
if (commands[cmd]) await commands[cmd]();
else {
  console.log("usage: opencode-remote <setup|doctor|qr|start|stop|status>");
  process.exit(1);
}
