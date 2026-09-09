import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// HTTPS mode (iPhone testing): VITE_TLS_CERT=/path/cert.pem VITE_TLS_KEY=/path/key.pem
const cert = process.env.VITE_TLS_CERT;
const key = process.env.VITE_TLS_KEY;

export default defineConfig({
  plugins: [react()],
  // P3-358: the app bundle is ~570 kB minified (~180 kB gzip) by design — the
  // whole PWA is one screen tree. The default 500 kB warning flooded the
  // gate's evidence tails and made cited build outputs diverge on every run.
  build: { chunkSizeWarningLimit: 700 },
  // VITE_BASE=./ for the desktop shell (file:// can't load absolute
  // /assets paths); default "/" for the phone/dev server
  base: process.env.VITE_BASE ?? "/",
  // non-TLS mode still binds 127.0.0.1 (IPv4) so tailscale serve / proxies
  // that target 127.0.0.1 can reach it — localhost alone binds ::1.
  // allowedHosts: dev-only, the tailnet hostname is not in vite's allowlist.
  server: cert && key
    ? {
        host: true,
        allowedHosts: true,
        https: { cert: readFileSync(cert), key: readFileSync(key) },
      }
    : { host: "127.0.0.1", allowedHosts: true },
});
