/**
 * Unit tests for pure glue code the e2e scripts don't cover.
 * Run: npx tsx scripts/unit.test.ts
 */
import { b64, fromB64, seal, openSealed, seqAad } from "@ocr/protocol";
import { parsePairingUri } from "../apps/web/src/lib/client";
import { copyText, hasClipboardApi, legacyCopy } from "../apps/web/src/lib/clipboard";
import { mimeFor } from "../apps/web/src/lib/files";
import { timeAgo, sessionUpdatedTs } from "../apps/web/src/lib/time";
import { sessionTitleOf } from "../apps/web/src/lib/title";
import { permissionPreview } from "../apps/web/src/lib/permission";
import { applySessionFilters } from "../apps/web/src/lib/sessionFilter";
import { taskMergedIn } from "../apps/pilot/src/pipeline";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

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

// --- session badge filter chips (P2-005) -------------------------------------
type FS = { id: string; title?: string };
const fs1: FS = { id: "a", title: "Fix login" };
const fs2: FS = { id: "b", title: "Ship api" };
const fs3: FS = { id: "c" };
const funread = { a: 3, b: 0 };
const all = [fs1, fs2, fs3];
const fAll = applySessionFilters(all, funread, "", "all");
check("badge filter all keeps everything", fAll.length === 3);
const fWith = applySessionFilters(all, funread, "", "with");
check("badge filter with keeps only unread", fWith.length === 1 && fWith[0].id === "a");
const fWithout = applySessionFilters(all, funread, "", "without");
check("badge filter without keeps zero/missing badge", fWithout.length === 2 && fWithout[0].id === "b" && fWithout[1].id === "c");
const fQuery = applySessionFilters(all, funread, "SHIP", "all");
check("search query still matches title case-insensitive", fQuery.length === 1 && fQuery[0].id === "b");
const fBoth = applySessionFilters(all, funread, "fix", "without");
check("badge filter and query compose", fBoth.length === 0);
check("empty query string passes all", applySessionFilters(all, funread, "   ", "all").length === 3);

// --- file card copy path (P3-002) --------------------------------------------
check("hasClipboardApi present", hasClipboardApi({ clipboard: { writeText: () => {} } }));
check("hasClipboardApi absent", !hasClipboardApi({}) && !hasClipboardApi(undefined));
let captured = "";
const fakeNav = { clipboard: { writeText: async (t: string) => { captured = t; } } };
check("copyText via clipboard api", (await copyText("/a/b.txt", fakeNav)) === true && captured === "/a/b.txt");
const deniedNav = { clipboard: { writeText: async () => { throw new Error("denied"); } } };
function makeFakeDoc(execOk: boolean) {
  const appended: unknown[] = [];
  const removed: unknown[] = [];
  const created: string[] = [];
  const doc = {
    createElement(tag: string) {
      created.push(tag);
      return { value: "", setAttribute() {}, style: {} as Record<string, string>, select() {} };
    },
    body: { appendChild(node: unknown) { appended.push(node); }, removeChild(node: unknown) { removed.push(node); } },
    execCommand(cmd: string) {
      return execOk && cmd === "copy";
    },
  };
  return { doc, created, appended, removed };
}
const okDoc = makeFakeDoc(true);
const denyDoc = makeFakeDoc(false);
check("copyText denied + no document -> false (Node has no document; legacyCopy covered above)", (await copyText("x", deniedNav)) === false);
check("legacyCopy writes and cleans up the textarea", legacyCopy("/a/b.txt", okDoc.doc) === true && okDoc.created[0] === "textarea" && okDoc.removed.length === 1 && (okDoc.appended[0] as { value: string }).value === "/a/b.txt");
check("legacyCopy reports execCommand failure", legacyCopy("x", denyDoc.doc) === false);
check("legacyCopy without document fails", legacyCopy("x", undefined) === false);

// --- empty-diff self-heal: task merge detection (P0-001) ----------------------
let pilotRepo = "";
try {
  pilotRepo = mkdtempSync(join(tmpdir(), "pilot-unit-"));
  const g = (cmd: string) => execSync(cmd, { cwd: pilotRepo, encoding: "utf8" });
  g("git init -q");
  g("git config user.email pilot@test.local");
  g("git config user.name pilot");
  g("git commit -q --allow-empty -m 'pilot(P0-001): empty diff deve completar a task'");
  g("git update-ref refs/remotes/origin/main HEAD");
  check("taskMergedIn finds merged task id", taskMergedIn(pilotRepo, "P0-001") === true);
  check("taskMergedIn rejects unknown task id", taskMergedIn(pilotRepo, "P9-999") === false);
  check("taskMergedIn is escaped (no regex leak)", taskMergedIn(pilotRepo, "P0-00.") === false);
  g("git commit -q --allow-empty -m 'unrelated' -m 'this reverts pilot(P9-777): body ref only'");
  g("git update-ref refs/remotes/origin/main HEAD");
  check("taskMergedIn ignores body references", taskMergedIn(pilotRepo, "P9-777") === false);
  check(
    "taskMergedIn rejects injection-style ids without exec",
    taskMergedIn(pilotRepo, "P0-$(touch boom)") === false && !existsSync(join(pilotRepo, "boom")),
  );
  check("taskMergedIn rejects ids with shell metacharacters", taskMergedIn(pilotRepo, "P0-1'; ls") === false);
} catch (e) {
  check(`taskMergedIn test env failed: ${String(e)}`, false);
} finally {
  if (pilotRepo) rmSync(pilotRepo, { recursive: true, force: true });
}

// --- desktop render smoke: ServiceWorker-on-file:// noise filter (P0-002) ----
const requireCjs = createRequire(import.meta.url);
const { isKnownNoise } = requireCjs("../scripts/desktop-render-driver.cjs") as {
  isKnownNoise: (message: string, sourceUrl: string | undefined) => boolean;
};
check(
  "noise filter: SW registration failure on file:// is noise",
  isKnownNoise(
    "Uncaught (in promise) TypeError: Failed to register a ServiceWorker: The URL protocol of the script (file:///sw.js) is not supported.",
    "file:///repo/apps/web/dist/index.html",
  ) === true,
);
check("noise filter: SW failure without source URL is noise", isKnownNoise("ServiceWorker registration failed", "") === true);
check(
  "noise filter: SW failure on http(s) is NOT noise",
  isKnownNoise("ServiceWorker registration failed", "https://ui.example/index.html") === false,
);
check(
  "noise filter: renderer TypeError on file:// is NOT noise",
  isKnownNoise("Uncaught TypeError: x is undefined", "file:///repo/apps/web/dist/assets/index.js") === false,
);
check("noise filter: empty message is noise-free", isKnownNoise("", "file:///x") === false);

if (failures > 0) {
  console.error(`UNIT TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("UNIT TESTS PASSED");
process.exit(0);
