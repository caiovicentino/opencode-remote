#!/usr/bin/env node
// P2-011: tiny CLI over the daemon's /api/browse (Playwright on the host).
// Lets builder/reviewer agents (and humans) self-drive a browser to validate
// UI output, e.g.:
//   node tools/browse.mjs open http://127.0.0.1:8792/dashboard dash.png
//   node tools/browse.mjs click "text=Settings"
//   node tools/browse.mjs text
// Reads the Bearer token from the 0600 daemon state file; loopback only.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const [, , cmd, ...args] = process.argv;
const PORT = process.env.OCR_DAEMON_METRICS_PORT || process.env.OCR_METRICS_PORT || 8792;

function token() {
  const raw = JSON.parse(readFileSync(join(homedir(), ".opencode-remote", "daemon.json"), "utf8"));
  if (!raw.apiToken) throw new Error("no apiToken in daemon.json");
  return raw.apiToken;
}

async function api(path, method = "GET", body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("image/png")) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, png: buf };
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function savePng(out, buf) {
  const dir = dirname(out);
  if (dir && dir !== "." && !dir.startsWith("~")) mkdirSync(dir, { recursive: true });
  const path = out.startsWith("~") ? join(homedir(), out.slice(1)) : out;
  writeFileSync(path, buf);
  console.log(path);
}

const session = process.env.OCR_BROWSE_SESSION;
const sfx = session ? `?session=${session}` : "";

async function main() {
  if (!cmd || cmd === "help") {
    console.log(
      "usage: node tools/browse.mjs open <url> [shot.png] | shot <out.png> | click <selector | x y> | text | close",
    );
    process.exit(cmd ? 0 : 2);
  }
  if (cmd === "open") {
    const url = args[0];
    if (!url) throw new Error("open <url> required");
    const r = await api(`/api/browse/open${sfx}`, "POST", { url });
    if (r.status >= 400) throw new Error(JSON.stringify(r.json));
    if (args[1]) {
      const shot = await api(`/api/browse/screenshot${sfx}`);
      if (shot.status === 200) savePng(args[1], shot.png);
    }
    console.log(JSON.stringify(r.json, null, 2));
  } else if (cmd === "shot") {
    const out = args[0] ?? "shot.png";
    const r = await api(`/api/browse/screenshot${sfx}`);
    if (r.status !== 200) throw new Error(JSON.stringify(r.json ?? r.status));
    savePng(out, r.png);
  } else if (cmd === "click") {
    const x = Number(args[0]);
    const y = Number(args[1]);
    const body = Number.isFinite(x) && Number.isFinite(y) && args.length >= 2 ? { x, y } : { selector: args[0] };
    const r = await api(`/api/browse/click${sfx}`, "POST", body);
    if (r.status >= 400) throw new Error(JSON.stringify(r.json));
    console.log(JSON.stringify(r.json, null, 2));
  } else if (cmd === "text") {
    const r = await api(`/api/browse/text${sfx}`);
    if (r.status >= 400) throw new Error(JSON.stringify(r.json));
    console.log(JSON.stringify(r.json, null, 2));
  } else if (cmd === "close") {
    const r = await api(`/api/browse/close${sfx}`, "POST", {});
    console.log(JSON.stringify(r.json, null, 2));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
