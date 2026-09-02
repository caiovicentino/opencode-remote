#!/usr/bin/env node
// P2-075: minimal static server for the PWA origin (com.ocr.pwa, launchd).
// Serves apps/web/dist on 127.0.0.1:5173 — the port `tailscale serve` proxies
// the phone to. Replaces the ad-hoc vite dev server that used to die with the
// shell that started it (~16h of white screen on the phone). Kept free of npm
// dependencies on purpose: this runs under launchd KeepAlive, not a dev loop.
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join, normalize, sep } from "node:path";

const HOST = process.env.PWA_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PWA_PORT ?? 5173);
const ROOT =
  process.env.PWA_DIST_DIR ??
  fileURLToPath(new URL("../apps/web/dist", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

// hashed Vite assets never change → cache hard; the shell files must always
// be revalidated or a deploy never reaches the phone
const IMMUTABLE_RE = /^\/assets\//;

function log(level, msg, data) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, data }));
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function notFound(res) {
  send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "not found");
}

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("allow", "GET, HEAD");
    send(res, 405, { "content-type": "text/plain; charset=utf-8" }, "method not allowed");
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/healthz") {
    send(res, 200, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ ok: true, service: "com.ocr.pwa" }));
    return;
  }
  // decode + normalize, then refuse anything that escapes the dist root
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    notFound(res);
    return;
  }
  if (pathname.includes("\0")) {
    notFound(res);
    return;
  }
  const file = normalize(join(ROOT, pathname));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    notFound(res);
    return;
  }
  let target = file;
  try {
    if (statSync(target).isDirectory()) target = join(target, "index.html");
  } catch {
    notFound(res);
    return;
  }
  try {
    statSync(target);
  } catch {
    notFound(res);
    return;
  }
  const type = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
  const headers = { "content-type": type };
  headers["cache-control"] = IMMUTABLE_RE.test(url.pathname)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  createReadStream(target)
    .on("error", () => res.destroy())
    .pipe(res);
});

// a missing dist must not crash-loop the service: the server answers /healthz
// and 404s until the first `npm run build` lands (deploy kickstarts after it)
server.listen(PORT, HOST, () => {
  log("info", "pwa origin listening", { host: HOST, port: PORT, root: ROOT });
});
server.on("error", (err) => {
  const code = err?.code ?? "";
  log("error", "pwa origin server error", {
    error: err?.message ?? String(err),
    ...(code === "EADDRINUSE" ? { hint: "port busy — is a vite dev server still holding 5173?" } : {}),
  });
  process.exit(1); // launchd KeepAlive retries after ThrottleInterval
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
