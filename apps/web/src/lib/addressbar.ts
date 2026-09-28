// P3-378 (eval-09): the Browser pane's address-bar verdict. Pure so
// scripts/addressbar.test.ts can pin every input class a person actually
// types — the pane only ever loads http(s), and every other input answers
// with a named rejection instead of silently keeping the old page.
import { normalizeHttpUrl } from "./preview";

export type AddressRejection = "local-file" | "scheme" | "invalid";

export type AddressVerdict = { kind: "go"; url: string } | { kind: "reject"; reason: AddressRejection };

// Loopback targets are dev servers (the auto-preview story), served over
// plain http — an https upgrade there would only fail the load.
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// A dotted name with an alphabetic-led TLD (IDN and punycode included). A
// single bare word never qualifies: the bar is not a search box.
const DOMAIN_HOST = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}[\p{L}\p{N}-]{1,62}$/u;

/** Classifies what was typed into the Browser pane's address bar.
 * - empty input: null (nothing to do — Enter on an empty bar is a no-op);
 * - http(s) URLs: normalized and loaded;
 * - a pasted filesystem path or a file: URL: "local-file" (the sandboxed pane
 *   never opens local files — the copy names the localhost way out);
 * - any other scheme (javascript:, data:, about:, chrome:, ftp:…): "scheme";
 * - a schemeless host ("localhost:5173", "example.com/docs"): completed the
 *   way a browser omnibox does — http for loopback and IP literals, https for
 *   names. Before this, "localhost:5173" parsed as an opaque URL with the
 *   scheme "localhost:" and got the local-FILE sentence, telling someone who
 *   typed a localhost URL to go open a localhost URL;
 * - everything else (spaces, bare words, broken URLs): "invalid". */
export function resolveAddress(raw: string): AddressVerdict | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  // POSIX, home-relative, dot-relative, Windows drive and UNC paths.
  if (/^(?:\/|~[\\/]|\.{1,2}[\\/]|[a-z]:[\\/]|\\\\)/i.test(text)) return { kind: "reject", reason: "local-file" };
  // host:port is a host, not a scheme — checked before the scheme probe.
  const hostPort = /^[^\s/?#:@]+:\d{1,5}(?:[/?#]|$)/.test(text);
  const scheme = hostPort ? null : (/^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase() ?? null);
  if (scheme === "http" || scheme === "https") {
    const url = normalizeHttpUrl(text);
    return url ? { kind: "go", url } : { kind: "reject", reason: "invalid" };
  }
  if (scheme === "file") return { kind: "reject", reason: "local-file" };
  if (scheme) return { kind: "reject", reason: "scheme" };
  if (/\s/.test(text)) return { kind: "reject", reason: "invalid" };
  const host = (text.split(/[/?#]/, 1)[0] ?? "").replace(/:\d{1,5}$/, "");
  const plain = LOOPBACK_HOST.test(host) || IPV4_HOST.test(host);
  if (!plain && !DOMAIN_HOST.test(host)) return { kind: "reject", reason: "invalid" };
  const url = normalizeHttpUrl(`${plain ? "http" : "https"}://${text}`);
  return url ? { kind: "go", url } : { kind: "reject", reason: "invalid" };
}
