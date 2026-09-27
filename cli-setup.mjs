// Pure helpers behind `opencode-remote setup` (cli.mjs) — kept out of cli.mjs
// so the unit battery can import them without running a command.
//
// eval-16: two third-party dead ends of the source install lived here.
//   1. The relay URL is embedded in the pairing QR and dialed by the PHONE,
//      but an empty answer at the setup prompt silently fell back to
//      ws://127.0.0.1:8787 — a loopback address no phone can reach — and the
//      wizard printed a QR that could never pair. relayUrlProblem() names that
//      before anything is installed.
//   2. `git clone && npm ci && node cli.mjs setup` (README Quick Start) never
//      built apps/web: the com.ocr.pwa origin then answers /healthz and 404s
//      everything else, so the phone opens "not found". cli.mjs now builds the
//      web UI when WEB_DIST_INDEX is missing and doctor reports it.
import { join } from "node:path";

/** Built PWA entry point, relative to the repo root (what com.ocr.pwa serves). */
export const WEB_DIST_INDEX = join("apps", "web", "dist", "index.html");

/**
 * The relay URL passed on the command line: `--relay=<url>` (everything after
 * the FIRST "=", so a URL carrying "=" survives) or `--relay <url>`. Null when
 * absent.
 */
export function relayUrlFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? "");
    if (arg.startsWith("--relay=")) return arg.slice("--relay=".length).trim() || null;
    if (arg === "--relay") return String(argv[i + 1] ?? "").trim() || null;
  }
  return null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Why a relay URL cannot be used in a phone pairing QR, or null when it can.
 * The phone dials this address itself: it must be a ws:// or wss:// URL with
 * a host the phone can reach — never loopback (127.0.0.0/8, localhost, ::1)
 * nor the 0.0.0.0 wildcard.
 */
export function relayUrlProblem(url) {
  const text = typeof url === "string" ? url.trim() : "";
  if (!text) {
    return "no relay URL — pass the wss:// address your phone can reach (e.g. --relay=wss://your-mac.tailnet.ts.net:8788)";
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return `"${text}" is not a URL — expected ws://host:port or wss://host:port`;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return `"${text}" is not a ws:// or wss:// URL`;
  }
  const host = parsed.hostname.toLowerCase();
  // IPv4-mapped IPv6 loopback (eval-16 fix-round): `ws://[::ffff:127.0.0.1]:
  // 8788` reaches the same loopback relay. WHATWG URL keeps the brackets and
  // NORMALIZES the address to the compressed hex form — "[::ffff:127.0.0.1]"
  // comes back as "[::ffff:7f00:1]" — so unmap the tail into dotted-quad
  // before the loopback tests.
  const unbracketed = host.replace(/^\[/, "").replace(/\]$/, "");
  let mappedV4 = null;
  if (unbracketed.startsWith("::ffff:")) {
    const tail = unbracketed.slice("::ffff:".length);
    if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(tail)) {
      const [hi, lo] = tail.split(":").map((g) => parseInt(g, 16));
      mappedV4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) {
      mappedV4 = tail;
    }
  }
  const mappedIsLoopback = mappedV4 !== null && (LOOPBACK_HOSTS.has(mappedV4) || /^127\./.test(mappedV4));
  if (LOOPBACK_HOSTS.has(host) || /^127\./.test(host) || mappedIsLoopback) {
    return `"${text}" points at this machine's loopback — the phone dials the relay itself and can never reach ${host}; use this Mac's tailnet name or LAN IP instead`;
  }
  return null;
}
