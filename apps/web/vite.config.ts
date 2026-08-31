import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// HTTPS mode (iPhone testing): VITE_TLS_CERT=/path/cert.pem VITE_TLS_KEY=/path/key.pem
const cert = process.env.VITE_TLS_CERT;
const key = process.env.VITE_TLS_KEY;

export default defineConfig({
  plugins: [react()],
  // relative base: the desktop shell loads dist/index.html via file://,
  // where absolute /assets/... paths 404 and render a blank window
  base: "./",
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
