#!/usr/bin/env node
// OpenCode Remote CLI — setup, diagnostics and service control.
// Works from a repo checkout (npm i -g github:caiovicentino/opencode-remote)
// or a Homebrew prefix (formula runs npm ci at install time).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { relayUrlFromArgv, relayUrlProblem, WEB_DIST_INDEX } from "./cli-setup.mjs";

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

  existsSync(join(ROOT, WEB_DIST_INDEX))
    ? ok("phone web app built (apps/web/dist)")
    : bad("phone web app not built — the pwa service would answer 404: npm run build --workspace @ocr/web");

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
  print("pwa service", state("com.ocr.pwa"));

  console.log("");
  if (existsSync(STATE_FILE) && daemonUp) {
    console.log(`  pair a phone: opencode-remote qr\n`);
  }
}

// eval-16: setup hands its own --relay value in — the QR it prints at the end
// used to read only RELAY_URL and embed the loopback default instead.
async function qr(relayOverride) {
  const relayUrl = relayOverride ?? process.env.RELAY_URL ?? RELAY_URL_DEFAULT;
  if (!existsSync(STATE_FILE)) return bad("no daemon state — run: opencode-remote setup");
  if (!relayOverride && !process.env.RELAY_URL) {
    warn(`RELAY_URL not set — this QR embeds ${RELAY_URL_DEFAULT}, which a phone cannot reach; re-run with RELAY_URL=<the address you gave setup>`);
  }
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
  for (const t of ["com.ocr.relay", "com.ocr.daemon", "com.ocr.pwa"]) {
    const r = sh(`launchctl kickstart -k ${serviceLabel(t)} 2>&1`);
    r.status === 0 ? ok(`${t} kicked`) : bad(`${t}: ${r.stderr || "not installed (opencode-remote setup)"}`);
  }
}

function stop() {
  for (const t of ["com.ocr.daemon", "com.ocr.relay", "com.ocr.pwa"]) {
    const r = sh(`launchctl bootout ${serviceLabel(t)} 2>&1`);
    r.status === 0 ? ok(`${t} stopped`) : bad(`${t}: not loaded`);
  }
}

function status() {
  for (const t of ["com.ocr.relay", "com.ocr.daemon", "com.ocr.pwa"]) {
    const out = sh(`launchctl print ${GUI}/${t} 2>/dev/null | grep -E "state|pid" | head -2`).stdout ?? "";
    const state = /state = (\w+)/.exec(out)?.[1] ?? "not loaded";
    const pid = /pid = (\d+)/.exec(out)?.[1] ?? "-";
    console.log(`  ${t}: ${state} (pid ${pid})`);
  }
  const st = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  console.log(`  paired clients: ${(st.clients ?? []).length}`);
}

async function setup() {
  let relayUrl = relayUrlFromArgv(process.argv.slice(3)) ?? process.env.RELAY_URL;
  if (!relayUrl) {
    if (!process.stdin.isTTY) return bad("set RELAY_URL or pass --relay=wss://host:8788");
    const readline = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    const answer = await readline.question("\n  Relay URL reachable from your phone (wss://host:8788) [tailscale recommended]: ");
    relayUrl = answer.trim();
    readline.close();
  }
  // eval-16: the phone dials this URL from the QR — refuse an address it can
  // never reach BEFORE installing anything (an empty answer used to fall back
  // to the loopback default and print an unpairable QR).
  const relayProblem = relayUrlProblem(relayUrl);
  if (relayProblem) {
    process.exitCode = 1;
    return bad(relayProblem);
  }

  console.log("\n  checking prerequisites…\n");
  await doctor();

  // eval-16: the pwa service serves apps/web/dist — a fresh clone has none,
  // so the phone would open "not found". Build it once before the services.
  if (!existsSync(join(ROOT, WEB_DIST_INDEX))) {
    console.log("\n  building the phone web app (apps/web/dist)…\n");
    const web = sh("npm run build --workspace @ocr/web", { cwd: ROOT });
    if (web.status !== 0 || !existsSync(join(ROOT, WEB_DIST_INDEX))) {
      process.stderr.write(web.stderr ?? "");
      process.exitCode = 1;
      return bad("web build failed — run `npm ci` (dev dependencies included) and retry");
    }
    ok("phone web app built");
  }

  console.log("\n  installing launchd services (KeepAlive)…\n");
  // eval-16: quoted — a checkout under a path with spaces split the argv.
  const r = sh(`RELAY_URL=${JSON.stringify(relayUrl)} bash ${JSON.stringify(join(ROOT, "deploy", "install.sh"))}`, { cwd: ROOT });
  process.stdout.write(r.stdout ?? "");
  if (r.status !== 0) {
    process.stderr.write(r.stderr ?? "");
    return bad("install failed — see output above");
  }
  console.log(`\n  done. pair your phone:\n`);
  await qr(relayUrl);
}

async function update(args) {
  const force = args.includes("--force");
  const isRepo =
    sh(`git -C ${JSON.stringify(ROOT)} rev-parse --is-inside-work-tree 2>/dev/null`).stdout?.trim() ===
    "true";
  if (!isRepo) {
    return bad("not a git checkout — update via `brew upgrade opencode-remote` or reinstall");
  }
  const dirty = sh(`git -C ${JSON.stringify(ROOT)} status --porcelain`).stdout?.trim();
  if (dirty && !force) {
    warn("local changes detected — commit/stash or run with --force:");
    console.log(dirty.split("\n").map((l) => `    ${l}`).join("\n"));
    return;
  }
  info("fetching…");
  const f = sh(`git -C ${JSON.stringify(ROOT)} fetch origin`);
  if (f.status !== 0) return bad("git fetch failed");
  const behind = sh(`git -C ${JSON.stringify(ROOT)} rev-list --count HEAD..origin/main`).stdout?.trim();
  if (behind === "0") return ok("already up to date");
  const log = sh(`git -C ${JSON.stringify(ROOT)} log --oneline HEAD..origin/main`).stdout ?? "";
  console.log("  incoming:");
  console.log(log.split("\n").map((l) => `    ${l}`).join("\n"));
  if (force) {
    sh(`git -C ${JSON.stringify(ROOT)} reset --hard origin/main`);
  } else {
    const pull = sh(`git -C ${JSON.stringify(ROOT)} pull --ff-only origin main`);
    if (pull.status !== 0) return bad("pull failed (diverged?) — use --force to hard-reset");
  }
  info("installing deps…");
  sh("npm ci --silent", { cwd: ROOT });
  info("restarting services…");
  start();
  await new Promise((r) => setTimeout(r, 2500));
  (await portOpen(8792)) ? ok("daemon back up — update complete") : bad("daemon not responding — run: opencode-remote doctor");
}

function token() {
  if (!existsSync(STATE_FILE)) return bad("no daemon state — run: opencode-remote setup");
  const st = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  if (!st.apiToken) return bad("no api token yet — restart the daemon once to generate it");
  console.log(st.apiToken);
}

const cmd = process.argv[2] ?? "status";
const commands = { doctor, qr, start, stop, status, setup, update, token };
if (commands[cmd]) await commands[cmd]();
else {
  console.log("usage: opencode-remote <setup|doctor|qr|start|stop|status|update|token>");
  process.exit(1);
}
