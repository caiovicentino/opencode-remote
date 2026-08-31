// Bundles @ocr/daemon into a single-file CJS entry for the packaged desktop
// app. electron-builder then ships it as resources/daemon/index.js, where
// apps/desktop/src/daemon.ts (resolveEntry) looks for it. The bundle must be
// self-contained: the packaged app has no node_modules, so every runtime dep
// (qrcode, ws, web-push, tweetnacl, json5, @ocr/protocol) is inlined here.
// Node builtins stay external (platform=node); ws's optional native accel
// deps are external too — ws try/catches their require and falls back.
//
// Also copies the pilot dashboard next to the bundle as dashboard.html: the
// CJS bundle has no import.meta, so the daemon resolves /dashboard via
// __dirname (see dashboardFile() in apps/daemon/src/index.ts) and
// electron-builder.yml ships both files from dist-daemon.
//
// Run: npm run build:daemon --workspace @ocr/desktop
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scripts = dirname(fileURLToPath(import.meta.url)); // apps/desktop/scripts
const desktop = dirname(scripts); // apps/desktop
const repoRoot = join(desktop, "..", "..");
const daemonRoot = join(desktop, "..", "daemon");
// Version must come from the repo root to match metrics.ts's source fallback
// (which reads ../../../package.json), otherwise bundle and source drift.
const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

await build({
  entryPoints: [join(daemonRoot, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: join(desktop, "dist-daemon", "index.js"),
  external: ["bufferutil", "utf-8-validate"],
  // metrics.ts reads the root package.json via import.meta.url in source
  // checkouts; the bundle has no package.json next to it, so the version is
  // baked in instead (see the typeof guard there).
  define: { OCR_DAEMON_VERSION: JSON.stringify(version) },
  logLevel: "info",
});

copyFileSync(
  join(repoRoot, "apps", "pilot", "dashboard", "index.html"),
  join(desktop, "dist-daemon", "dashboard.html"),
);
