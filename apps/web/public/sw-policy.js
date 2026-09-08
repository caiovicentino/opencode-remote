// P2-239 — single source of truth for the service worker's offline decisions.
// Classic script on purpose: sw.js pulls it in with importScripts() before any
// event wiring, so it carries no imports, no exports, no I/O (no fetch), no
// cache access, no listeners and no mutable global state — only pure
// functions, published on `self`. The plan names returned by strategyFor are
// part of the contract with sw.js: "cache-first", "network-first",
// "network-first-nosave".

/**
 * Why: whether the app opens with no network is decided by the files the
 * publication's root document references. This extracts the same-origin,
 * root-relative addresses (src=/href= attributes) that must be precached at
 * install, in stable order of first appearance, deduplicated. Cross-origin
 * and protocol-relative addresses, data: URIs and bare anchors are not cache
 * keys of this publication and are ignored; the bare root "/" is excluded
 * because install caches the navigation document itself. Never throws.
 * @param {string} rootDocument text of the fetched "/" document
 * @returns {string[]} ordered, deduplicated root-relative paths
 */
function precacheTargets(rootDocument) {
  try {
    if (typeof rootDocument !== "string" || rootDocument.length === 0) return [];
    const targets = [];
    const seen = new Set();
    const attr = /(?:\s(?:src|href)\s*=\s*)("([^"]*)"|'([^']*)')/g;
    for (const m of rootDocument.matchAll(attr)) {
      const path = normalizeReference(m[2] !== undefined ? m[2] : m[3]);
      if (path === null || path === "/" || seen.has(path)) continue;
      seen.add(path);
      targets.push(path);
    }
    return targets;
  } catch {
    return [];
  }
}

// Root-relative only: anything else (https://, //host, data:, #anchor,
// relative paths) is not an address this origin must keep. The #fragment is
// stripped because the cache key is the address without it.
function normalizeReference(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.charAt(0) !== "/") return null;
  if (trimmed.startsWith("//")) return null;
  const hash = trimmed.indexOf("#");
  const value = hash === -1 ? trimmed : trimmed.slice(0, hash);
  return value === "" ? null : value;
}

/**
 * Why: only a file whose address changes on every publication (a hash in the
 * name) can be served cache-first with no risk of mixing an old publication
 * with a new one; the navigation document must always be revalidated
 * (network-first) so an install is discovered at all, and everything else —
 * including any non-GET method, which must never be answered from a cache —
 * goes to the network without recording anything. The rules are evaluated in
 * exactly this order.
 * @param {string} path pathname of the request
 * @param {string} [method] HTTP method of the request (GET when omitted)
 * @returns {"cache-first"|"network-first"|"network-first-nosave"}
 */
function strategyFor(path, method) {
  if (typeof method === "string" && method.toUpperCase() !== "GET") {
    return "network-first-nosave";
  }
  if (isHashVersioned(path)) return "cache-first";
  if (path === "/" || path === "/index.html") return "network-first";
  return "network-first-nosave";
}

// A hash-shaped immutable asset: name-<hash>.ext (Vite/rollup, e.g.
// index-B3iKfWlp.js) or name.<hash>.ext (legacy hex), where the token is 8+
// chars and carries at least one uppercase letter or digit so ordinary words
// ("download") and counters ("512") never read as hashes.
function isHashVersioned(path) {
  if (typeof path !== "string") return false;
  const base = path.split("/").pop() || "";
  const m =
    /-([A-Za-z0-9_-]{8,})\.([A-Za-z0-9]{1,10})$/.exec(base) ||
    /\.([A-Za-z0-9]{8,})\.([A-Za-z0-9]{1,10})$/.exec(base);
  if (!m) return false;
  return /[0-9A-Z]/.test(m[1]);
}

/**
 * Why: the offline fallback must exist even when nothing was ever cached —
 * one minimal, always-static page in Portuguese with short actionable text.
 * It carries no absolute file path, no URL scheme, no session identifier and
 * no secret, so it is safe to serve from any state of any cache.
 * @returns {string} full HTML document
 */
function offlineDocument() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sem conexão — OpenCode Remote</title>
<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#111;color:#eee;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box}</style>
</head>
<body><main>
<h1>Você está sem conexão</h1>
<p>Este app precisa de internet na primeira abertura.<br>
Quando a conexão voltar, recarregue a página.</p>
</main></body>
</html>`;
}

/**
 * Why: hashed files are named anew on every publication, so entries from an
 * older publication would otherwise accumulate forever. This picks, from the
 * paths currently in the cache, the versioned ones that are NOT targets of
 * the current publication — received order preserved, never the root
 * document, never a path outside the received list. Non-versioned entries
 * keep their address across publications and are never stale.
 * @param {string[]} cachedPaths paths currently held in the cache
 * @param {string[]} currentTargets paths of the current publication
 * @returns {string[]} stale versioned paths, safe to delete
 */
function staleEntries(cachedPaths, currentTargets) {
  try {
    const cached = Array.isArray(cachedPaths) ? cachedPaths : [];
    const keep = new Set(Array.isArray(currentTargets) ? currentTargets : []);
    const stale = [];
    const seen = new Set();
    for (const path of cached) {
      if (typeof path !== "string" || path === "" || path === "/") continue;
      if (seen.has(path) || keep.has(path) || !isHashVersioned(path)) continue;
      seen.add(path);
      stale.push(path);
    }
    return stale;
  } catch {
    return [];
  }
}

/**
 * Why (P2-246): a new publication must never break the tab that is already
 * open — the worker it was serving from just had its versioned leftovers
 * swept, and an immediate takeover would evict files that document still
 * asks for on demand. takeoverPlan returns exactly one of two plans:
 * "takeover-now" only when there is no controlled client at all (first
 * install, nothing to break), "wait" when a live tab from the previous
 * publication exists. Doubtful counts (not a number, not finite, negative)
 * are treated as a live client, fail-closed: taking over under a doubtful
 * count is worse than waiting one more cycle, and a waiting worker is
 * activated by the browser by itself as soon as the last controlled tab
 * closes — so the new version still lands on the next opening.
 * @param {number} clientCount window clients controlled in this scope
 * @returns {"takeover-now"|"wait"}
 */
function takeoverPlan(clientCount) {
  return liveClient(clientCount) ? "wait" : "takeover-now";
}

/**
 * Why (P2-246): activation may only sweep versioned leftovers when no client
 * is being served — otherwise the open document could still request an entry
 * this sweep is about to delete. Rule order is the contract: the live-client
 * rule comes FIRST, before any leftover, cache-name or target consideration,
 * and returns an empty list. Only with no controlled client at all the result
 * is exactly what staleEntries decides for the same input — received order
 * preserved, never the root document, never a path outside the received list.
 * @param {number} clientCount window clients controlled in this scope
 * @param {string[]} cachedPaths paths currently held in the cache
 * @param {string[]} currentTargets paths of the current publication
 * @returns {string[]} paths safe to delete now
 */
function sweepPlan(clientCount, cachedPaths, currentTargets) {
  if (liveClient(clientCount)) return [];
  return staleEntries(cachedPaths, currentTargets);
}

// Fail-closed presence check: any count that is not a plain non-negative
// number reads as "client present", so an unreliable count can never cause a
// takeover or a sweep — both simply wait for the next cycle.
function liveClient(clientCount) {
  if (typeof clientCount !== "number") return true;
  if (!Number.isFinite(clientCount)) return true;
  if (clientCount < 0) return true;
  return clientCount > 0;
}

self.precacheTargets = precacheTargets;
self.strategyFor = strategyFor;
self.offlineDocument = offlineDocument;
self.staleEntries = staleEntries;
self.takeoverPlan = takeoverPlan;
self.sweepPlan = sweepPlan;
