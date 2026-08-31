/**
 * Unit tests for pure glue code the e2e scripts don't cover.
 * Run: npx tsx scripts/unit.test.ts
 */
import { b64, fromB64, seal, openSealed, seqAad } from "@ocr/protocol";
import { parsePairingUri } from "../apps/web/src/lib/client";
import { mimeFor } from "../apps/web/src/lib/files";
import { timeAgo, sessionUpdatedTs } from "../apps/web/src/lib/time";
import { sessionTitleOf } from "../apps/web/src/lib/title";
import { permissionPreview } from "../apps/web/src/lib/permission";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// --- b64 roundtrip ----------------------------------------------------------
const bytes = new Uint8Array(256).map((_, i) => i);
check("b64/fromB64 roundtrip", Buffer.from(fromB64(b64(bytes))).equals(Buffer.from(bytes)));

// --- sealed payload + AAD binding ------------------------------------------
const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
  "encrypt",
  "decrypt",
]);
const sealed = await seal({ hello: "world" }, key, seqAad("client", 1));
check("seal/openSealed roundtrip", (await openSealed<{ hello: string }>(sealed, key, seqAad("client", 1)))?.hello === "world");
check("wrong seq rejected", (await openSealed(sealed, key, seqAad("client", 2))) === null);
check("wrong sender rejected", (await openSealed(sealed, key, seqAad("other", 1))) === null);

// --- pairing URI ------------------------------------------------------------
// base64 keys contain + / = which URLSearchParams would mangle
const spki = b64(bytes).replace(/\+/g, "+");
const uri =
  `opencode-remote://pair?v=2&relay=wss%3A%2F%2Frelay.example.com&room=abc123` +
  `&k=${encodeURIComponent(spki)}&name=mac`;
const parsed = parsePairingUri(uri);
check("parsePairingUri valid", parsed?.room === "abc123" && parsed?.relay === "wss://relay.example.com");
check("parsePairingUri preserves base64 key", parsed?.k === spki);
check("parsePairingUri wrong scheme", parsePairingUri("https://evil.example/pair") === null);
check("parsePairingUri missing fields", parsePairingUri("opencode-remote://pair?v=2") === null);
let threw = false;
try {
  parsePairingUri("opencode-remote://pair?v=1&relay=x&room=y&k=z");
} catch {
  threw = true;
}
check("parsePairingUri rejects v1", threw);

// --- mime map ---------------------------------------------------------------
check("mimeFor pdf", mimeFor("report.pdf") === "application/pdf");
check("mimeFor unknown", mimeFor("blob.bin") === "application/octet-stream");

// --- relative time ----------------------------------------------------------
const now = Date.parse("2026-08-31T12:00:00Z");
check("timeAgo just now", timeAgo(now - 30_000, "now", now) === "now");
check("timeAgo minutes", timeAgo(now - 5 * 60_000, "now", now) === "5m");
check("timeAgo hours", timeAgo(now - 2 * 3_600_000, "now", now) === "2h");
check("timeAgo days", timeAgo(now - 3 * 86_400_000, "now", now) === "3d");
check("timeAgo ISO string", timeAgo("2026-08-31T11:00:00Z", "now", now) === "1h");
check("timeAgo invalid", timeAgo("garbage", "now", now) === "");
check("timeAgo missing", timeAgo(undefined, "now", now) === "");

// --- session list ordering (P2-003) ----------------------------------------
type S = { id: string; updatedAt?: string | number; time?: { updated?: string } };
const s1: S = { id: "a", updatedAt: "2026-08-31T12:00:00Z" }; // newest (now)
const s2: S = { id: "b", updatedAt: now - 60_000 };
const s3: S = { id: "c", time: { updated: "2026-08-31T10:00:00Z" } };
const s4: S = { id: "d" }; // unknown -> last
const s5: S = { id: "e", updatedAt: "garbage" }; // invalid -> last
const desc = [s1, s2, s3, s4, s5].sort((a, b) => sessionUpdatedTs(b) - sessionUpdatedTs(a));
check("sessionUpdatedTs sorts desc by recent activity", desc.slice(0, 3).map((s) => s.id).join("") === "abc");
check("sessionUpdatedTs unknown last", desc[3].id === "d" && desc[4].id === "e");
check("sessionUpdatedTs epoch millis", sessionUpdatedTs({ updatedAt: now }) === now);
check("sessionUpdatedTs time.updated fallback", sessionUpdatedTs(s3) === Date.parse("2026-08-31T10:00:00Z"));
check("sessionUpdatedTs missing/invalid -> 0", sessionUpdatedTs(s4) === 0 && sessionUpdatedTs(s5) === 0 && sessionUpdatedTs(undefined) === 0);

// --- chat header title (P3-001) ---------------------------------------------
check("sessionTitleOf trimmed title", sessionTitleOf({ title: "  fix login bug  " }) === "fix login bug");
check("sessionTitleOf empty title", sessionTitleOf({ title: "" }) === "" && sessionTitleOf({ title: "   " }) === "");
check("sessionTitleOf missing body", sessionTitleOf(null) === "" && sessionTitleOf(undefined) === "");
check("sessionTitleOf non-string title", sessionTitleOf({ title: 42 }) === "" && sessionTitleOf({}) === "");

// --- approval card preview (P2-004) ------------------------------------------
check("preview from metadata.command", permissionPreview({ metadata: { command: "git status\nnpm test\nls\nrm -rf /" } }) === "git status\nnpm test\nls");
check("preview from metadata.diff", permissionPreview({ metadata: { diff: "--- a\n+++ b\n@@ -1\nmore" } }) === "--- a\n+++ b\n@@ -1");
check("preview from pattern string", permissionPreview({ pattern: "src/*.ts" }) === "src/*.ts");
check("preview from patterns array", permissionPreview({ patterns: ["a.ts", "b.ts", "c.ts", "d.ts"] }) === "a.ts\nb.ts\nc.ts");
check("preview command wins over pattern", permissionPreview({ metadata: { command: "ls" }, pattern: "x" }) === "ls");
check("preview caps long lines", (permissionPreview({ metadata: { command: "x".repeat(200) } }) ?? "").length <= 120);
check("preview empty payload", permissionPreview({ metadata: {} }) === undefined);
check("preview null/undefined payload", permissionPreview(null) === undefined && permissionPreview(undefined) === undefined);

if (failures > 0) {
  console.error(`UNIT TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("UNIT TESTS PASSED");
process.exit(0);
