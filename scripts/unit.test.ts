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
import {
  builderPrompt,
  codeChanges,
  commitSpec,
  evidenceMatches,
  evidenceShotDimsOk,
  lessonsBlock,
  needsPlanner,
  needsUiEvidence,
  normalizeEvidenceLine,
  parseEvidenceBlock,
  plannerPrompt,
  pngSize,
  reviewerPrompt,
  specPathFor,
  parseScribeLessons,
  validateSpec,
  verifyEvidence,
} from "../apps/pilot/src/pipeline";
import {
  appendLessons,
  dedupeAndPrune,
  EXPERIENCE_CAP,
  maintainExperienceFile,
  normalizeLesson,
  parseLessons,
  pickRelevantLessons,
} from "../apps/pilot/src/experience";
import { clampSlots, ensureSingleton, loadState, recordTaskFailure } from "../apps/pilot/src/state";
import { areaKey, pickBatch, pickTasks } from "../apps/pilot/src/scheduler";
import { blockTask, loadBacklog, parseBacklog, type Task } from "../apps/pilot/src/backlog";
import { API_PREFLIGHT, apiHealthy, OPENCODE_URL_DEFAULT, waitForApi } from "../apps/pilot/src/runner";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, utimesSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { artifactMime, kindFor, listArtifacts, readArtifact, validSegment } from "../apps/daemon/src/artifacts";
import { browseTarget, clickPoint, validSession, viewportFromParams } from "../apps/daemon/src/browse";
import { touchedUiFromDiff, parseFindings, verifyFindings } from "../apps/pilot/src/pipeline";
import { stdlibShadowHits } from "./stdlib-shadow";
import { latestUiShot, pruneShots } from "../apps/pilot/src/shot";
import { parseMarkdown, parseInline } from "../apps/web/src/lib/md";
import { parseCsv } from "../apps/web/src/lib/csv";
import { artifactMentions, fmtBytes } from "../apps/web/src/lib/artifacts";
import { DISK_MIN_FREE_BYTES, diskGuardDetail, freeDiskBytes } from "../apps/pilot/src/disk";
import { deploy } from "../apps/pilot/src/deploy";
import type { PilotConfig } from "../apps/pilot/src/state";
import { overlayVisible, phonePaired } from "../apps/desktop/src/pairing";
import { daemonTooltip, loginItemSupported } from "../apps/desktop/src/tray";

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

// --- desktop render smoke: driver helpers required as a CJS library ----------
const requireCjs = createRequire(import.meta.url);
const { readConsoleMessage } = requireCjs("../scripts/desktop-render-driver.cjs") as {
  readConsoleMessage: (...args: unknown[]) => {
    level: string;
    message?: string;
    sourceUrl?: string;
    lineNumber?: number;
  };
};

// --- desktop render smoke: console-message arg normalization (P0-002) --------
// Shapes verified at runtime on Electron 38.8.6: (details, 3, msg, line, src)
// with details = { message, level: "error", lineNumber, sourceId }.
const details38 = { level: "error", message: "boom", lineNumber: 12, sourceId: "file:///x/y.js" };
const m38 = readConsoleMessage(details38, 3, "boom", 12, "file:///x/y.js");
check(
  "console-message: Electron 38 details-object shape",
  m38.level === "error" && m38.message === "boom" && m38.sourceUrl === "file:///x/y.js" && m38.lineNumber === 12,
);
const mTailless = readConsoleMessage(details38);
check(
  "console-message: details shape survives when the deprecated positional tail is dropped",
  mTailless.message === "boom" && mTailless.sourceUrl === "file:///x/y.js" && mTailless.level === "error",
);
const mLegacy = readConsoleMessage({}, 3, "legacy-boom", 7, "file:///a.js");
check(
  "console-message: legacy numeric shape",
  mLegacy.level === "error" &&
    mLegacy.message === "legacy-boom" &&
    mLegacy.sourceUrl === "file:///a.js" &&
    mLegacy.lineNumber === 7,
);
check(
  "console-message: legacy event object (no payload) is not mistaken for details",
  readConsoleMessage({}, 2, "w", 1, "") .level === "warning" && readConsoleMessage({}, 0, "v", 1, "").level === "verbose",
);
check("console-message: undefined first arg falls back to legacy", readConsoleMessage(undefined, 3, "u", 1, "").message === "u");

// --- pilot singleton via pidfile (P0-004) --------------------------------------
{
  const pidDir = mkdtempSync(join(tmpdir(), "pilot-pid-"));
  const pidFile = join(pidDir, "pilot.pid");
  let holder: ReturnType<typeof spawn> | null = null;
  try {
    writeFileSync(pidFile, "999999999"); // above any real pid range — dead
    await ensureSingleton(pidFile);
    check("singleton overwrites stale pidfile", readFileSync(pidFile, "utf8").trim() === String(process.pid));

    writeFileSync(pidFile, "not-a-pid");
    await ensureSingleton(pidFile);
    check("singleton survives garbage pidfile", readFileSync(pidFile, "utf8").trim() === String(process.pid));

    // child traps SIGTERM so the 2s grace expires and the SIGKILL path must fire
    holder = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
      stdio: "ignore",
    });
    await new Promise((r) => setTimeout(r, 300)); // let the child install its SIGTERM handler
    writeFileSync(pidFile, String(holder.pid));
    const exited = new Promise<string>((resolve) => holder!.once("exit", (_code, signal) => resolve(String(signal))));
    await ensureSingleton(pidFile);
    const signal = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("timeout"), 5_000))]);
    check("singleton kills live previous instance (SIGTERM trapped → SIGKILL)", signal === "SIGKILL");
    check("singleton pidfile points at current pid after kill", readFileSync(pidFile, "utf8").trim() === String(process.pid));
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    rmSync(pidDir, { recursive: true, force: true });
  }
}

// --- P1-014 stop-loss circuit breaker ------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "pilot-blocker-"));
  try {
    writeFileSync(
      join(dir, "BACKLOG.md"),
      [
        "# BACKLOG",
        "",
        "## Ready",
        "",
        "- [ ] (T-001) [P1] Task A — spec: fails 4x",
        "- [ ] (T-002) [P2] Task B — spec: fine",
        "",
        "## Done",
        "- [x] (T-000) [P1] Old — done",
      ].join("\n"),
    );
    const st = { date: "2026-08-31", tasks: 0, deploys: 0, failures: 0, taskAttempts: {} as Record<string, number> };
    check("breaker: failures 1..3 stay under the cap", [1, 2, 3].every(() => !recordTaskFailure(st, "T-001", 4)));
    check("breaker: 4th failure trips", recordTaskFailure(st, "T-001", 4) === true);
    check("breaker: attempts tracked in state", st.taskAttempts["T-001"] === 4);
    check("breaker: other task unaffected", recordTaskFailure(st, "T-002", 4) === false);

    check("blockTask moves the Ready line under ## Blocked", blockTask(dir, "T-001", "max review rounds reached — findings:\n- bad\n- thing") === true);
    const md = readFileSync(join(dir, "BACKLOG.md"), "utf8");
    const blockedChunk = md.split("\n## Blocked\n")[1] ?? "";
    check(
      "blocked section holds task line + findings summary (whitespace collapsed)",
      blockedChunk.includes("(T-001)") && blockedChunk.includes("max review rounds reached") && blockedChunk.includes("findings: - bad - thing"),
    );
    check("blocked section sits before ## Done", md.indexOf("## Blocked") < md.indexOf("## Done"));
    check("blocked task leaves the Ready queue (no solo reschedule)", loadBacklog(dir).map((t) => t.id).join(",") === "T-002");
    check("blockTask is idempotent", blockTask(dir, "T-001", "again") === false && (md.match(/\(T-001\)/g) ?? []).length === 1);
    check("blockTask unknown id returns false", blockTask(dir, "T-999", "x") === false);
    check("blockTask escapes the id regex", blockTask(dir, "T-001) [P1] x.*", "y") === false);

    // reset on gate pass: deleting the counter gives a fresh allowance
    delete st.taskAttempts["T-001"];
    check("breaker: gate pass resets the counter", recordTaskFailure(st, "T-001", 4) === false && st.taskAttempts["T-001"] === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- P1-014 state.json: attempts survive the daily reset ------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "pilot-state-"));
  try {
    const file = join(dir, "state.json");
    writeFileSync(
      file,
      JSON.stringify({ date: "2026-01-01", tasks: 5, deploys: 3, failures: 2, taskAttempts: { "T-001": 3 } }),
    );
    const rolled = loadState(file);
    const today = new Date().toLocaleDateString("en-CA");
    check("loadState rolls daily counters", rolled.date === today && rolled.tasks === 0 && rolled.deploys === 0);
    check("loadState keeps taskAttempts across midnight", rolled.taskAttempts["T-001"] === 3);
    writeFileSync(file, JSON.stringify({ date: today, tasks: 1, deploys: 1, failures: 1 }));
    const legacy = loadState(file);
    check("loadState backfills missing taskAttempts", legacy.tasks === 1 && Object.keys(legacy.taskAttempts).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- P1-006 parallel slots: area tags, scheduler picking, slot clamp -----------
{
  const md = [
    "# BACKLOG",
    "",
    "## Ready",
    "",
    "- [ ] (T-101) [P1] UI task — spec: do ui things (area: ui)",
    "- [ ] (T-102) [P1] Daemon task — spec: do daemon things (area: daemon)",
    "- [ ] (T-103) [P2] Untagged task — spec: mystery",
    "- [ ] (T-104) [P2] Second daemon — spec: more daemon (area: daemon)",
    "- [ ] (T-105) [P3] Tricky — spec: mentions (area: ui) mid-spec (area: relay)",
  ].join("\n");
  const tasks = parseBacklog(md);
  const byId = (id: string) => tasks.find((t) => t.id === id)!;
  check("parseBacklog: trailing area tag parsed and stripped from spec", byId("T-101").area === "ui" && byId("T-101").spec === "do ui things");
  check("parseBacklog: untagged task has empty area", byId("T-103").area === "" && byId("T-103").spec === "mystery");
  check("parseBacklog: only the trailing tag counts", byId("T-105").area === "relay" && byId("T-105").spec === "mentions (area: ui) mid-spec");
  check("parseBacklog: tagged task stays in the Ready queue", tasks.length === 5);

  const md2 = [
    "## Ready",
    "",
    "- [ ] (T-201) [P1] Bogus area — spec: x (area: bogus)",
    "- [ ] (T-202) [P1] Good area — spec: x (area: daemon)",
    "- [ ] (T-203) [P1] Injection-ish area — spec: x (area: ui; rm -rf)",
  ].join("\n");
  const tasks2 = parseBacklog(md2);
  check("parseBacklog: unknown area tag falls back to serial (empty)", tasks2[0]!.area === "" && tasks2[2]!.area === "");
  check("parseBacklog: known area tag accepted", tasks2[1]!.area === "daemon");

  check("clampSlots: default/invalid go to 1", clampSlots(undefined) === 1 && clampSlots(0) === 1 && clampSlots(-2) === 1 && clampSlots(2.5) === 1);
  check("clampSlots: accepts ints up to the hard cap", clampSlots(2) === 2 && clampSlots(99) === 8);

  const queue = [byId("T-101"), byId("T-102"), byId("T-103"), byId("T-104")];
  check("pickTasks: distinct areas run in parallel, same area waits", pickTasks(queue, 2, new Set()).map((t) => t.id).join(",") === "T-101,T-102");
  check("pickTasks: busy area is skipped for new slots", pickTasks(queue, 2, new Set([areaKey(byId("T-101"))])).map((t) => t.id).join(",") === "T-102,T-103");
  check("pickTasks: respects free slot count", pickTasks(queue, 1, new Set()).length === 1);
  check("pickTasks: zero free slots picks nothing", pickTasks(queue, 0, new Set()).length === 0);
  const untaggedPair = [byId("T-103"), { ...byId("T-103"), id: "T-106" }];
  check("pickTasks: untagged tasks never run in parallel (safe default)", pickTasks(untaggedPair, 2, new Set()).map((t) => t.id).join(",") === "T-103");
  check("pickTasks: queue order (priority) respected", pickTasks(queue, 3, new Set())[0].id === "T-101");

  check("pickBatch: remaining budget caps the batch (in-flight counted)", pickBatch(queue, 2, new Set(), 1).length === 1);
  check("pickBatch: exhausted budget picks nothing", pickBatch(queue, 2, new Set(), 0).length === 0 && pickBatch(queue, 2, new Set(), -1).length === 0);
  check("pickBatch: slots cap still applies with budget to spare", pickBatch(queue, 3, new Set(), 99).length === 3);

  // --- P1-006 slots=2 scheduler loop simulation (real pickBatch + worker pattern) ---
  {
    const simQueue = parseBacklog(
      [
        "## Ready",
        "",
        "- [ ] (S-001) [P1] UI one — spec: x (area: ui)",
        "- [ ] (S-002) [P1] Daemon one — spec: x (area: daemon)",
        "- [ ] (S-003) [P1] UI two — spec: x (area: ui)",
        "- [ ] (S-004) [P1] Daemon two — spec: x (area: daemon)",
      ].join("\n"),
    );
    const maxTasks = 3; // budget smaller than the queue: the cap must hold
    let tasksDone = 0;
    let areaViolations = 0;
    let concurrentBatches = 0;
    const running = new Map<number, { task: Task }>();
    const doneIds = new Set<string>();
    const freeSlots = [1, 2]; // slots=2
    for (let tick = 0; tick < 4; tick++) {
      const free = freeSlots.filter((s) => !running.has(s));
      const busy = new Set([...running.values()].map((r) => areaKey(r.task)));
      const pending = simQueue.filter((t) => !doneIds.has(t.id));
      const picked = pickBatch(pending, free.length, busy, maxTasks - tasksDone - running.size);
      for (const t of picked) {
        const slot = free.find((s) => !running.has(s))!;
        if ([...running.values()].some((r) => areaKey(r.task) === areaKey(t))) areaViolations++;
        running.set(slot, { task: t });
      }
      if (running.size === 2) concurrentBatches++;
      // workers finish out of order, like real pipelines
      await Promise.all(
        [...running.entries()].map(async ([slot, r]) => {
          await new Promise((resolve) => setTimeout(resolve, 5 + ((slot * 7) % 11)));
          running.delete(slot);
          doneIds.add(r.task.id);
          tasksDone++;
        }),
      );
    }
    check("slots=2 simulation: same-area tasks never run concurrently", areaViolations === 0);
    check("slots=2 simulation: daily task budget is a hard cap", tasksDone === maxTasks);
    check("slots=2 simulation: two tasks of distinct areas ran simultaneously", concurrentBatches > 0);
  }
}

// --- artifacts (P1-010) -------------------------------------------------------
check("validSegment accepts ids/names", validSegment("ses_abc123") && validSegment("report-1.html"));
check("validSegment rejects traversal", !validSegment("..") && !validSegment("../etc") && !validSegment("a/b"));
check("kindFor kinds", kindFor("a.pdf") === "pdf" && kindFor("a.html") === "html" && kindFor("a.md") === "md" && kindFor("a.csv") === "csv" && kindFor("a.exe") === "binary");
check("artifactMime csv", artifactMime("a.csv") === "text/csv; charset=utf-8");
const aroot = mkdtempSync(join(tmpdir(), "ocr-artifacts-"));
try {
  mkdirSync(join(aroot, "ses_test"));
  writeFileSync(join(aroot, "ses_test", "index.html"), "<h1>oi</h1>");
  writeFileSync(join(aroot, "ses_test", "data.csv"), "a,b\n1,2");
  symlinkSync(join(aroot, "ses_test", "index.html"), join(aroot, "ses_test", "symlink.html"));
  symlinkSync("/etc/hosts", join(aroot, "ses_test", "outside.html"));
  check(
    "readArtifact reads inside root",
    readArtifact("ses_test", "index.html", aroot)?.toString() === "<h1>oi</h1>",
  );
  check(
    "readArtifact blocks traversal",
    readArtifact("ses_test", "..", aroot) === null &&
      readArtifact("ses_test", "../../daemon.json", aroot) === null &&
      readArtifact("../evil", "x.html", aroot) === null,
  );
  check("readArtifact missing is null", readArtifact("ses_test", "nope.html", aroot) === null);
  check(
    "readArtifact refuses symlinks (even to outside the root)",
    readArtifact("ses_test", "symlink.html", aroot) === null &&
      readArtifact("ses_test", "outside.html", aroot) === null,
  );
  const list = listArtifacts(undefined, aroot);
  const listNames = list.map((a) => a.name).sort().join(",");
  check(
    "listArtifacts lists and classifies (symlinks excluded)",
    listNames === "data.csv,index.html" &&
      list[0]?.kind !== undefined &&
      kindFor("index.html") === "html",
  );
  check("listArtifacts filters by session", listArtifacts("other", aroot).length === 0);
} finally {
  rmSync(aroot, { recursive: true, force: true });
}

// --- artifacts web lib (P1-010) -----------------------------------------------
check(
  "fmtBytes: zero/sub-KB/KB/MB/GB/negative",
  fmtBytes(0) === "0 B" &&
    fmtBytes(999) === "999 B" &&
    fmtBytes(1500) === "1.5 KB" &&
    fmtBytes(2e6) === "2.0 MB" &&
    fmtBytes(1.5e9) === "1.5 GB" &&
    fmtBytes(-5) === "0 B",
);
const mentionsList = [
  { sessionId: "s1", name: "report.html", size: 10, mtime: 1, kind: "html" as const },
  { sessionId: "s1", name: "data.csv", size: 20, mtime: 2, kind: "csv" as const },
];
check(
  "artifactMentions matches filenames mentioned in text",
  JSON.stringify(artifactMentions("veja o report.html anexo", mentionsList)) ===
    JSON.stringify([mentionsList[0]]) &&
    artifactMentions("nada aqui", mentionsList).length === 0 &&
    artifactMentions("", mentionsList).length === 0,
);

// --- markdown model for the artifacts pane (P1-010) ---------------------------
const md = parseMarkdown(
  "# Title\n\nintro **bold** and `code`\n\n- item one\n- item two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx()\n```",
);
check(
  "parseMarkdown block types",
  md[0]?.type === "heading" &&
    md[1]?.type === "para" &&
    md[2]?.type === "li" &&
    md[3]?.type === "li" &&
    md[4]?.type === "table" &&
    md[5]?.type === "code",
);
const mdTable = md.find((b) => b.type === "table") as { header: string[]; rows: string[][] } | undefined;
check("parseMarkdown table cells", mdTable?.header.join(",") === "a,b" && mdTable?.rows[0]?.join(",") === "1,2");
const inl = parseInline("**b** `c` [x](https://a.b)");
check(
  "parseInline bold/code/link",
  inl.filter((s) => typeof s === "object").map((s) => (s as { kind: string }).kind).join(",") ===
    "bold,code,link",
);
const jsInl = parseInline("[x](javascript:alert(1)) next");
check(
  "parseInline rejects javascript: hrefs (plain text, no link)",
  typeof jsInl[0] === "string" &&
    jsInl[0] === "[x](javascript:alert(1)" &&
    jsInl.every((s) => typeof s === "string" || (s as { kind: string }).kind !== "link"),
);
const mailInl = parseInline("[mail me](mailto:a@b.c)");
check(
  "parseInline keeps mailto links",
  typeof mailInl[0] === "object" && (mailInl[0] as { kind: string }).kind === "link",
);

// --- csv parsing (P1-010) -----------------------------------------------------
check("parseCsv basic", JSON.stringify(parseCsv("a,b\n1,2")) === JSON.stringify([["a", "b"], ["1", "2"]]));
check("parseCsv quoted comma", JSON.stringify(parseCsv('a,b\n"x, y",2')) === JSON.stringify([["a", "b"], ["x, y", "2"]]));
check("parseCsv escaped quotes", parseCsv('"he said ""hi"""')[0]?.[0] === 'he said "hi"');

// --- browser self-driving guards (P2-011) ------------------------------------
check("browseTarget accepts http", browseTarget("http://127.0.0.1:8792/dashboard")?.protocol === "http:");
check("browseTarget accepts https", browseTarget("https://example.com/x")?.hostname === "example.com");
check("browseTarget rejects file:", browseTarget("file:///etc/passwd") === null);
check("browseTarget rejects javascript:", browseTarget("javascript:alert(1)") === null);
check("browseTarget rejects garbage", browseTarget("not a url") === null);
check("browseTarget rejects oversize", browseTarget(`http://a.com/${"x".repeat(3000)}`) === null);
check("validSession accepts simple", validSession("main_2-x"));
check("validSession rejects empty/long/path", !validSession("") && !validSession("a".repeat(40)) && !validSession("../etc"));

// --- UI-cycle screenshot detection (P2-011, round-2 regression) --------------
// input is `git diff --name-only` output: bare paths, one per line
check("touchedUi: web file", touchedUiFromDiff("apps/daemon/src/browse.ts\napps/web/src/App.tsx"));
check("touchedUi: desktop file", touchedUiFromDiff("apps/desktop/src/main.ts"));
check("touchedUi: daemon-only diff", !touchedUiFromDiff("apps/daemon/src/browse.ts\ndocs/api.md"));
check("touchedUi: empty diff", !touchedUiFromDiff(""));
// prefixed unified-diff lines must never fool the check (bare-path contract)
check("touchedUi: prefixed lines rejected", !touchedUiFromDiff("+++ b/apps/web/src/App.tsx"));
// lookalike prefixes must not match ("apps/web/" is a directory boundary)
check("touchedUi: lookalike apps/webui rejected", !touchedUiFromDiff("apps/webui/src/x.ts"));
check("touchedUi: lookalike apps/webs rejected", !touchedUiFromDiff("apps/webs/src/x.ts"));

// --- spec-before-build planner phase (P2-008) --------------------------------
{
  const TASK: Task = { id: "P0-999", priority: "P0", title: "Spec before build", spec: "s", area: "", line: "" };
  check("planner: P0/P1 need the planner phase", needsPlanner("P0") && needsPlanner("P1"));
  check("planner: P2/P3 skip straight to the builder", !needsPlanner("P2") && !needsPlanner("P3"));
  check("planner: spec path follows the task id", specPathFor("P0-999") === "specs/P0-999.md" && specPathFor("../x") === null);
  const prompt = plannerPrompt(TASK, 1);
  check(
    "planner: prompt targets the spec file with all sections",
    prompt.includes("specs/P0-999.md") &&
      prompt.includes("## Problem") &&
      prompt.includes("## Approach") &&
      prompt.includes("## Touched files") &&
      prompt.includes("## Edge cases") &&
      prompt.includes("## Acceptance criteria") &&
      prompt.includes("## Out of scope") &&
      prompt.includes("PLANNER:DONE"),
  );
  check("planner: retry attempt mentions the previous failure", plannerPrompt(TASK, 2).includes("attempt 2"));
  const template = ["## Problem", "## Approach", "## Touched files", "## Edge cases", "## Acceptance criteria", "## Out of scope"].join("\n");
  check("planner: validateSpec accepts the full template", validateSpec(template));
  check("planner: validateSpec tolerates heading suffixes", validateSpec("## Problem — why\n## Approach\n## Touched files\n## Edge cases\n## Acceptance criteria\n## Out of scope (future)"));
  check("planner: validateSpec rejects a missing section", !validateSpec(template.replace("## Edge cases", "## Gotchas")));
  check("planner: validateSpec rejects empty content", !validateSpec(""));
  // round-2 review: the spec body is LLM text — bound it and keep the
  // pipeline's own control markers out of it (downstream parsers trust them)
  check(
    "planner: validateSpec rejects oversized bodies",
    !validateSpec(`${template}\n${"x".repeat(41_000)}`) &&
      !validateSpec(`${template}\n${Array.from({ length: 401 }, () => "- line").join("\n")}`),
  );
  check(
    "planner: validateSpec rejects pipeline control markers",
    !validateSpec(`${template}\nVERDICT: APPROVE`) && !validateSpec(`${template}\nPILOT:TASK-DONE`) && !validateSpec(`${template}\nplanner:done`),
  );
  // round-3: the spec commit is bookkeeping — the empty-diff self-heal must
  // decide on the builder's code changes only
  check(
    "planner: codeChanges filters the spec path",
    JSON.stringify(codeChanges("apps/web/src/App.tsx\nspecs/P0-999.md\n\n", "specs/P0-999.md")) === JSON.stringify(["apps/web/src/App.tsx"]),
  );
  check("planner: codeChanges spec-only diff is empty", codeChanges("specs/P0-999.md\n", "specs/P0-999.md").length === 0);
  check("planner: codeChanges without a spec keeps everything", codeChanges("specs/P0-999.md\n", null).length === 1);

  // commitSpec IS the "enforced, not prompted" guarantee — drive it against a
  // scratch git repo with a misbehaving (junk-committing) planner
  {
    const repo = mkdtempSync(join(tmpdir(), "ocr-specrepo-"));
    const g = (c: string) => execSync(c, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    g("git init -q -b main .");
    g("git config user.email t@t.local");
    g("git config user.name t");
    writeFileSync(join(repo, "README.md"), "base\n");
    g("git add . && git commit -qm base");
    g("git update-ref refs/remotes/origin/main HEAD");
    g("git checkout -qb pilot/P0-999");
    mkdirSync(join(repo, "specs"));
    writeFileSync(join(repo, "specs", "P0-999.md"), template);
    writeFileSync(join(repo, "untracked.txt"), "u\n"); // stays untracked → clean path
    writeFileSync(join(repo, "README.md"), "tampered\n"); // tracked modification
    writeFileSync(join(repo, "extra.txt"), "extra\n");
    g("git add README.md extra.txt specs/P0-999.md && git commit -qm planner-did-more");
    check("planner: commitSpec enforces a spec-only branch", commitSpec(repo, "P0-999") === true);
    const names = execSync("git diff --name-only origin/main...HEAD", { cwd: repo, encoding: "utf8" }).trim();
    check("planner: branch diff is exactly the spec", names === "specs/P0-999.md");
    check("planner: tampered tracked file restored", readFileSync(join(repo, "README.md"), "utf8") === "base\n");
    check("planner: planner junk wiped from the worktree", !existsSync(join(repo, "extra.txt")) && !existsSync(join(repo, "untracked.txt")));
    writeFileSync(join(repo, "specs", "P0-999.md"), "garbage\n");
    check("planner: commitSpec rejects an invalid spec", commitSpec(repo, "P0-999") === false);
    rmSync(join(repo, "specs"), { recursive: true, force: true });
    check("planner: commitSpec false without a spec file", commitSpec(repo, "P0-999") === false);
    rmSync(repo, { recursive: true, force: true });
  }
  const bpWith = builderPrompt(TASK, 1, "", [], "specs/P0-999.md");
  const bpWithout = builderPrompt(TASK, 1, "", [], null);
  check("planner: builder prompt cites the spec when present", bpWith.includes("specs/P0-999.md") && bpWith.includes("read it FIRST"));
  check("planner: builder prompt silent without a spec", !bpWithout.includes("specs/P0-999.md"));
  const qual = reviewerPrompt("QUALITY", "regressions", TASK, "", null, "specs/P0-999.md");
  check("planner: quality reviewer gets the spec criterion", qual.includes("does the diff fulfill specs/P0-999.md"));
  check("planner: no spec criterion without a spec", !reviewerPrompt("QUALITY", "regressions", TASK, "", null).includes("specs/P0-999.md"));
  check("planner: security reviewer never gets the spec criterion", !reviewerPrompt("SECURITY", "crypto", TASK, "", null, "specs/P0-999.md").includes("does the diff fulfill"));
}

// --- module-shadowing invariant (P2-014) --------------------------------------
// input is `git diff --name-status` output; only introduced (A/R/C) root files count
check("stdlibShadow: clean diff passes", stdlibShadowHits("M\tapps/daemon/src/index.ts\nA\ttools/lib.py\nA\tREADME.md\n").length === 0);
check("stdlibShadow: root struct.py fails", JSON.stringify(stdlibShadowHits("A\tstruct.py\n")) === JSON.stringify(["struct.py"]));
check("stdlibShadow: subdir struct.py ok", stdlibShadowHits("A\tdir/struct.py\n").length === 0);
check("stdlibShadow: rename into os.py fails", JSON.stringify(stdlibShadowHits("R100\tdocs/notes.txt\tos.py\n")) === JSON.stringify(["os.py"]));
check("stdlibShadow: deleted json.py no hit", stdlibShadowHits("D\tjson.py\n").length === 0);
check("stdlibShadow: modified types.py not an introduction", stdlibShadowHits("M\ttypes.py\n").length === 0);
check("stdlibShadow: every hardcoded name is caught", stdlibShadowHits(["struct.py", "os.py", "base64.py", "json.py", "types.py", "random.py"].map((n) => `A\t${n}`).join("\n")).length === 6);
check("stdlibShadow: case-insensitive on root file", stdlibShadowHits("A\tRANDOM.PY\n").length === 1);
check("stdlibShadow: non-stdlib root file passes", stdlibShadowHits("A\tmain.py\nA\tstruct.ts\n").length === 0);

// --- verifiable findings / anti-hallucination filter (P2-015) ----------------
{
  const ws = mkdtempSync(join(tmpdir(), "p2-015-"));
  // line 2 non-empty, line 3 empty (whitespace-only), line 4 beyond EOF
  writeFileSync(join(ws, "real.ts"), "alpha\nbeta\n\n   \ndelta\n");
  const diff = "diff --git a/real.ts b/real.ts\n+beta touched\n";
  const out = [
    "VERDICT: REQUEST_CHANGES",
    "- real.ts:2 — beta is wrong",
    "- ghost.ts:1 — this file does not exist",
    "- real.ts:3 — cites an empty line",
    "- real.ts:99 — line beyond EOF",
    "- no citation at all, just vibes",
    '- the snippet "beta touched" is misplaced',
  ].join("\n");
  const parsed = parseFindings(out);
  check("parseFindings: bullet lines after verdict", parsed.length === 6 && parsed[0].includes("real.ts:2"));
  const v = verifyFindings(parsed, ws, diff);
  check("verifyFindings: valid path:line kept", v.kept.some((f) => f.includes("real.ts:2")));
  check("verifyFindings: kept exactly the 2 resolvable findings", v.kept.length === 2);
  check("verifyFindings: snippet present in diff kept", v.kept.some((f) => f.includes("beta touched")));
  check("verifyFindings: exactly 4 hallucinations dropped", v.dropped.length === 4);
  check("verifyFindings: nonexistent path dropped", v.dropped.some((f) => f.includes("ghost.ts")));
  check("verifyFindings: empty cited line dropped", v.dropped.some((f) => f.includes("real.ts:3")));
  check("verifyFindings: out-of-range line dropped", v.dropped.some((f) => f.includes("real.ts:99")));
  check("verifyFindings: citation-free finding dropped", v.dropped.some((f) => f.includes("just vibes")));
  check("verifyFindings: snippet absent from diff dropped", verifyFindings(['- the string "totally absent" is wrong'], ws, diff).kept.length === 0);
  check("verifyFindings: prose mention of real file resolves", verifyFindings(["- mention of real.ts in prose is fine"], ws, diff).kept.length === 1);
  check("verifyFindings: URL not mistaken for a file citation", verifyFindings(["- see https://example.com/a/real.ts:2, plus `beta touched` here"], ws, diff).kept.length === 1);
  rmSync(ws, { recursive: true, force: true });
}

// --- mandatory builder evidence (P2-009) --------------------------------------
{
  const UI_TASK: Task = { id: "P2-009", priority: "P2", title: "Evidence", spec: "", area: "ui", line: "" };
  const INFRA_TASK: Task = { id: "P2-009", priority: "P2", title: "Evidence", spec: "", area: "infra", line: "" };
  const bp = builderPrompt(INFRA_TASK, 1, "", []);
  const bpUi = builderPrompt(UI_TASK, 1, "", []);
  check("evidence: builder prompt mandates the EVIDENCE block", bp.includes("MANDATORY EVIDENCE") && bp.includes("EVIDENCE:"));
  check("evidence: builder prompt requires typecheck + test:unit", bp.includes("$ npm run typecheck --silent") && bp.includes("$ npm run test:unit --silent"));
  check("evidence: non-UI prompt shows the shot keys as conditional lines", bp.includes("if this round's diff touches apps/web/") && bp.includes("shot-1440x900:") && bp.includes("shot-390:"));
  check("evidence: UI prompt asks both sized screenshots", bpUi.includes("shot-1440x900:") && bpUi.includes("shot-390:"));
  check("evidence: task-done marker stays the last line", bp.trimEnd().endsWith("PILOT:TASK-DONE"));

  const block = `working...\nEVIDENCE:\n$ npm run typecheck --silent\nTS-OK\n$ npm run test:unit --silent\nOK   one\nOK   two\nUNIT TESTS PASSED\nshot-1440x900: /tmp/desktop.png\nshot-390: /tmp/phone.png\nPILOT:TASK-DONE`;
  const parsed = parseEvidenceBlock(block);
  check("evidence: parses commands after the marker", parsed !== null && parsed.commands.length === 2 && parsed.commands[0]!.cmd === "npm run typecheck --silent" && parsed.commands[0]!.output === "TS-OK");
  check("evidence: multi-line pasted output preserved", parsed?.commands[1]?.output === "OK   one\nOK   two\nUNIT TESTS PASSED");
  check("evidence: shot paths parsed", parsed?.shots["shot-1440x900"] === "/tmp/desktop.png" && parsed?.shots["shot-390"] === "/tmp/phone.png");
  check("evidence: block stops at the task-done marker", !JSON.stringify(parsed).includes("PILOT:TASK-DONE"));
  check("evidence: no marker → null", parseEvidenceBlock("no evidence here\nPILOT:TASK-DONE") === null);
  check("evidence: prose quoting the marker is ignored", parseEvidenceBlock("EVIDENCE: is required\n\nEVIDENCE:\n$ npm run build --silent\nx\n")?.commands.length === 1);
  check("evidence: works without a trailing task-done marker", parseEvidenceBlock("EVIDENCE:\n$ npm run build --silent\nx\n")?.commands.length === 1);
  check("evidence: padded block rejected", parseEvidenceBlock(`EVIDENCE:\n${"x\n".repeat(700)}`) === null);
  const longHonest = parseEvidenceBlock(`EVIDENCE:\n$ npm run test:unit --silent\n${"OK  check\n".repeat(550)}`);
  check("evidence: block cap leaves headroom for honest full pastes", (longHonest?.commands[0]?.output.split("\n").length ?? 0) === 550);
  check("evidence: prompt teaches the positional browse CLI the tool implements", bpUi.includes("browse.mjs shot <path>.png 1440 900") && bpUi.includes("browse.mjs shot <path>.png 390 844") && !bpUi.includes("--w"));
  check("evidence: prompt drops the unpredictable screencapture fallback", !bpUi.includes("screencapture"));

  check("evidence: containment accepts a truncated real paste", evidenceMatches("UNIT TESTS PASSED", "OK a\nOK b\nUNIT TESTS PASSED") === true);
  check("evidence: empty paste honest only for a silent re-run", evidenceMatches("", "") === true && evidenceMatches("", "OK a") === false);
  check("evidence: fabricated line diverges", evidenceMatches("OK a\nFABRICATED 999", "OK a\nOK b") === false);
  check("evidence: whitespace/ANSI normalized", evidenceMatches("OK   \x1b[32ma\x1b[0m", "OK a") === true);
  check("evidence: line normalization is order/spacing insensitive", normalizeEvidenceLine("  OK   a  b  ") === "OK a b");

  // PNG header parsing: hand-built IHDR for 1440x900 and 390x844
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  check("evidence: pngSize null on missing file / bad magic", pngSize("nope-missing.png") === null && pngSize(join(tmpdir(), "p2-009-missing.png")) === null);
  check("evidence: shot dims accept 1440x900 (and 2x Retina)", evidenceShotDimsOk("shot-1440x900", { w: 1440, h: 900 }) && evidenceShotDimsOk("shot-1440x900", { w: 2880, h: 1800 }));
  check("evidence: shot dims accept 390-wide (and 2x)", evidenceShotDimsOk("shot-390", { w: 390, h: 844 }) && evidenceShotDimsOk("shot-390", { w: 780, h: 1688 }));
  check("evidence: shot dims reject wrong sizes", !evidenceShotDimsOk("shot-1440x900", { w: 1280, h: 800 }) && !evidenceShotDimsOk("shot-390", { w: 391, h: 844 }));

  // end-to-end verifyEvidence against a real re-execution (echo scripts)
  const ws = mkdtempSync(join(tmpdir(), "p2-009-"));
  writeFileSync(ws + "/package.json", JSON.stringify({ name: "p2-009", scripts: { typecheck: "echo TS-OK", "test:unit": "echo UNIT-OK" } }));
  const good = `EVIDENCE:\n$ npm run typecheck --silent\nTS-OK\n$ npm run test:unit --silent\nUNIT-OK\nPILOT:TASK-DONE`;
  check("evidence: honest paste survives re-execution", verifyEvidence(ws, good, false).ok === true);
  const fabricated = `EVIDENCE:\n$ npm run typecheck --silent\nTS-OK\n$ npm run test:unit --silent\nall 999 checks passed\nPILOT:TASK-DONE`;
  const fab = verifyEvidence(ws, fabricated, false);
  check("evidence: fabricated output rejected by re-execution", fab.ok === false && fab.detail.includes("diverges"));
  const emptyPaste = `EVIDENCE:\n$ npm run typecheck --silent\nTS-OK\n$ npm run test:unit --silent\n`;
  const ep = verifyEvidence(ws, emptyPaste, false);
  check("evidence: empty paste for a verbose command rejected", ep.ok === false && ep.detail.includes("no output pasted"));
  check("evidence: missing block rejected", verifyEvidence(ws, "all done", false).detail.includes("no EVIDENCE block"));
  check("evidence: non-allowlisted command dropped, never executed", verifyEvidence(ws, "EVIDENCE:\n$ rm -rf /\n", false).detail.includes("missing required command"));
  const transcript = `EVIDENCE:\n$ npm run typecheck --silent\nTS-OK\n$ npm run test:unit --silent\n$ npm run typecheck\nUNIT-OK\n`;
  check("evidence: prompt-looking lines in real output don't reject an honest block", verifyEvidence(ws, transcript, false).ok === true && !parseEvidenceBlock(transcript)?.commands.some((c) => c.cmd === "npm run typecheck"));
  // round 2: one predicate drives prompt AND gate (reviewer finding #1/#5)
  check("evidence: needsUiEvidence is the union of area tag and diff", needsUiEvidence("ui", false) && needsUiEvidence("desktop", false) && needsUiEvidence("infra", true) && !needsUiEvidence("infra", false));
  check("evidence: prompt warns that UI diffs need shots even untagged", builderPrompt(INFRA_TASK, 1, "", []).includes("even when this task is not tagged ui/desktop"));
  // round 2: screenshot freshness — a stale PNG from an earlier task must not pass
  const stale = join(ws, "stale.png");
  writeFileSync(stale, png(1440, 900));
  const past = Date.now() / 1000 - 60;
  utimesSync(stale, past, past);
  const fresh = join(ws, "fresh.png");
  writeFileSync(fresh, png(1440, 900));
  writeFileSync(join(ws, "phone-still-fresh.png"), png(390, 844));
  const uiStale = `EVIDENCE:\n$ npm run typecheck --silent\nTS-OK\n$ npm run test:unit --silent\nUNIT-OK\nshot-1440x900: ${stale}\nshot-390: ${ws}/phone-still-fresh.png\n`;
  const uiFresh = uiStale.replace(stale, fresh);
  const startedAt = Date.now() - 10_000;
  check("evidence: stale screenshot rejected by mtime bound", verifyEvidence(ws, uiStale, true, startedAt).detail.includes("stale screenshot"));
  check("evidence: fresh screenshot passes the mtime bound", verifyEvidence(ws, uiFresh, true, startedAt).ok === true);
  check("evidence: freshness off when not requested", verifyEvidence(ws, uiStale, true).ok === true);
  check("evidence: missing required command rejected", verifyEvidence(ws, "EVIDENCE:\n$ npm run build --silent\nx\n", false).detail.includes("missing required command"));
  const realPng = join(ws, "shot-desktop.png");
  writeFileSync(realPng, png(1440, 900));
  writeFileSync(join(ws, "shot-phone.png"), png(390, 844));
  check("evidence: pngSize reads IHDR dimensions", JSON.stringify(pngSize(realPng)) === JSON.stringify({ w: 1440, h: 900 }));
  const uiOk = `EVIDENCE:\n$ npm run typecheck --silent\nTS-OK\n$ npm run test:unit --silent\nUNIT-OK\nshot-1440x900: ${realPng}\nshot-390: ${ws}/shot-phone.png\nPILOT:TASK-DONE`;
  check("evidence: UI shots verified by dimension", verifyEvidence(ws, uiOk, true).ok === true);
  writeFileSync(join(ws, "tiny.png"), "not a png");
  const uiBad = uiOk.replace(realPng, join(ws, "tiny.png"));
  check("evidence: unreadable shot rejected", verifyEvidence(ws, uiBad, true).detail.includes("not a readable PNG"));
  rmSync(ws, { recursive: true, force: true });
}

// --- click coordinate bounds (P2-011, round-3) -------------------------------
const vp = { width: 1280, height: 800 };
check("clickPoint: in-range passes", clickPoint(100, 200, vp)?.x === 100 && clickPoint(100, 200, vp)?.y === 200);
check("clickPoint: edge inclusive", clickPoint(1280, 800, vp) !== null);
check("clickPoint: beyond width rejected", clickPoint(1281, 400, vp) === null);
check("clickPoint: beyond height rejected", clickPoint(100, 801, vp) === null);
check("clickPoint: negative rejected", clickPoint(-1, 100, vp) === null);
check("clickPoint: NaN rejected", clickPoint("x", 100, vp) === null);
check("clickPoint: no silent clamp to edge (round-3)", clickPoint(9999, 9999, vp) === null);

// --- screenshot viewport params (P2-011, round-2 regression) -----------------
check("viewport: absent params keep live viewport", viewportFromParams(null, null) === null);
check("viewport: absent w only", viewportFromParams(null, "800") === null);
check("viewport: valid", viewportFromParams("1280", "800")?.width === 1280);
check("viewport: clamped to max", viewportFromParams("99999", "800")?.width === 1920);
check("viewport: zero rejected (round-1 bug shrank shots to 200)", viewportFromParams("0", "0") === null);
check("viewport: garbage rejected", viewportFromParams("x", "800") === null);

// --- newest shot by mtime + per-task evidence scope (P2-011, round-3) --------
{
  const dir = mkdtempSync(join(tmpdir(), "ocr-shots-"));
  const dir2 = mkdtempSync(join(tmpdir(), "ocr-shots2-"));
  try {
    check("latestUiShot: empty dir", latestUiShot(undefined, dir) === null);
    const old = join(dir, "aaa-old.png");
    const newest = join(dir, "zzz-new.png");
    writeFileSync(old, "x");
    writeFileSync(newest, "y");
    // lexical order says aaa-old.png is first; mtime must win
    const past = Date.now() / 1000 - 60;
    utimesSync(old, past, past);
    check("latestUiShot: newest by mtime, not lexical", latestUiShot(undefined, dir) === newest);
    writeFileSync(join(dir, "notes.txt"), "not a shot");
    check("latestUiShot: ignores non-png", latestUiShot(undefined, dir) === newest);
    // evidence scope (round-3): only deploy-shot shape <task>-<sha7>-<ts>.png
    writeFileSync(join(dir2, "P2-011-r1.png"), "builder self-shot");
    writeFileSync(join(dir2, "P3-002-deadbee-123.png"), "other task");
    const mine = join(dir2, "P2-011-abc1234-456.png");
    writeFileSync(mine, "deploy shot");
    check("latestUiShot: builder shots excluded from evidence", latestUiShot("P2-011", dir2) === mine);
    check("latestUiShot: other task's shot excluded", latestUiShot("P9-999", dir2) === null);
    check("latestUiShot: per-task filter returns own shot", latestUiShot("P3-002", dir2)?.endsWith("P3-002-deadbee-123.png") === true);
    check("latestUiShot: unscoped call still works", latestUiShot(undefined, dir2) !== null);
    // retention: prune keeps the newest N
    for (let i = 0; i < 5; i++) {
      const p = join(dir2, `P3-00${i}-abc1234-${i}.png`);
      writeFileSync(p, "x");
      const t = Date.now() / 1000 + i;
      utimesSync(p, t, t);
    }
    pruneShots(dir2, 3);
    check("pruneShots: keeps only newest N", readdirSync(dir2).filter((f) => f.endsWith(".png")).length === 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
}

// --- P2-016 API preflight: wait for opencode instead of burning an attempt ------
{
  // minimal Response stand-in: apiHealthy only reads .ok and .json()
  const res = (ok: boolean, healthy = true) => ({ ok, json: async () => ({ healthy }) }) as unknown as Response;
  const fetchOf = (fn: () => Promise<Response>) => fn as unknown as typeof fetch;
  const sleeper = () => {
    const waits: number[] = [];
    return { waits, sleepImpl: async (ms: number) => void waits.push(ms) };
  };

  check(
    "preflight: defaults are 5s timeout / 15s wait x3 retries (~45s)",
    API_PREFLIGHT.timeoutMs === 5_000 && API_PREFLIGHT.waitMs === 15_000 && API_PREFLIGHT.retries === 3,
  );
  check(
    "preflight: default URL is the local opencode serve (pinned fallback, env-independent)",
    OPENCODE_URL_DEFAULT === "http://127.0.0.1:4096",
  );

  const s1 = sleeper();
  const up1 = await waitForApi({ fetchImpl: fetchOf(async () => res(true)), sleepImpl: s1.sleepImpl, timeoutMs: 50 });
  check("preflight: healthy API is up with zero waits", up1 === true && s1.waits.length === 0);

  let calls = 0;
  const s2 = sleeper();
  const up2 = await waitForApi({
    fetchImpl: fetchOf(async () => res(++calls >= 3)),
    sleepImpl: s2.sleepImpl,
    timeoutMs: 50,
    waitMs: 15_000,
  });
  check("preflight: transient outage waits 15s per retry and recovers", up2 === true && s2.waits.length === 2 && s2.waits.every((w) => w === 15_000));

  const s3 = sleeper();
  const up3 = await waitForApi({ fetchImpl: fetchOf(async () => res(false)), sleepImpl: s3.sleepImpl, timeoutMs: 50 });
  check("preflight: API dead through all retries gives up after the wait window", up3 === false && s3.waits.length === 3 && s3.waits.every((w) => w === 15_000));

  check("preflight: healthy:false body counts as down", (await apiHealthy("http://x", 50, fetchOf(async () => res(true, false)))) === false);
  check(
    "preflight: network error counts as down",
    (await apiHealthy("http://x", 50, fetchOf(async () => { throw new Error("econnrefused"); }))) === false,
  );
  check("preflight: non-2xx counts as down", (await apiHealthy("http://x", 50, fetchOf(async () => res(false)))) === false);
  check(
    "preflight: non-JSON 200 body counts as up",
    (await apiHealthy("http://x", 50, fetchOf(async () => ({ ok: true, json: async () => { throw new Error("not json"); } } as unknown as Response)))) === true,
  );
}

// --- P3-006 disk guard -------------------------------------------------------
const GB = 1024 ** 3;
check("disk guard: default threshold is 5GB", DISK_MIN_FREE_BYTES === 5 * GB);
check("disk guard: below threshold aborts with clear detail", diskGuardDetail(4.2 * GB, 5 * GB)?.startsWith("disk low: 4.2gb free") === true);
check("disk guard: at/above threshold proceeds", diskGuardDetail(5 * GB, 5 * GB) === null && diskGuardDetail(9.9 * GB, 5 * GB) === null);
check("disk guard: unavailable probe fails open", diskGuardDetail(null, 5 * GB) === null);
const realFree = await freeDiskBytes(tmpdir());
check("disk guard: statfs probe returns bytes on a real dir", realFree !== null && realFree > 0);

// deploy() with a mocked probe + threshold must abort BEFORE any git/npm step:
// the bare tmp-dir repo would make `git rev-parse HEAD` throw if it were reached.
{
  const tmpDisk = mkdtempSync(join(tmpdir(), "ocr-disk-guard-"));
  const notified: Array<{ task: string; ok: boolean; detail: string }> = [];
  const events: Array<{ phase?: string; ok?: boolean; detail?: string }> = [];
  let probeCalls = 0;
  const cfgDisk: PilotConfig = {
    repo: tmpDisk,
    workspace: tmpDisk,
    slots: 1,
    maxTasksPerDay: 1,
    maxDeploysPerDay: 1,
    maxReviewRounds: 1,
    maxAttemptsPerTask: 1,
    taskTimeoutMin: 1,
    reviewTimeoutMin: 1,
    monitorMin: 1,
    digest: false,
  };
  const res = await deploy(cfgDisk, "1234567890abcdef1234567890abcdef12345678", { task: "P3-006" }, {
    minFreeBytes: 5 * GB,
    probeFreeBytes: async () => {
      probeCalls++;
      return 4.2 * GB;
    },
    notify: async (task, ok, detail) => {
      notified.push({ task, ok, detail });
      return true;
    },
    emitEvent: (_type, fields) => {
      events.push(fields);
    },
  });
  check(
    "disk guard: mocked threshold aborts deploy before npm ci",
    res.ok === false &&
      res.rolledBack === false &&
      res.detail.startsWith("disk low: 4.2gb free") &&
      probeCalls === 1,
  );
  check(
    "disk guard: supervisor notified with disk-low detail",
    notified.length === 1 &&
      notified[0]!.task === "P3-006" &&
      notified[0]!.ok === false &&
      notified[0]!.detail.startsWith("disk low"),
  );
  check(
    "disk guard: abort emits start + disk-guard deploy events",
    events.length === 2 && events[1]!.phase === "disk-guard" && events[1]!.ok === false,
  );
  rmSync(tmpDisk, { recursive: true, force: true });
}

// --- P1-007 experience memory (IER) ------------------------------------------
check("experience: cap pinned at 60", EXPERIENCE_CAP === 60);

const EXP_TASK: Task = { id: "P1-007", priority: "P1", title: "Memory of experience", spec: "scribe lessons", area: "infra", line: "" };
const lessonOf = (n: number) => `- When case ${n} happens, do remedy ${n} on the relay frames (fonte: P0-001)`;

{
  const md = `# Experience memory (IER)\n\nintro text\n\n## Lessons\n${lessonOf(1)}\n${lessonOf(2)}\n\n## Done\n- not a lesson\n`;
  check("experience: parseLessons reads only the Lessons section", JSON.stringify(parseLessons(md)) === JSON.stringify([lessonOf(1), lessonOf(2)]));
  check("experience: parseLessons empty when section missing", parseLessons("# file\n\n- nope\n").length === 0);
}

{
  const md = [
    "# Experience memory (IER)",
    "",
    "## Lessons",
    "- When touching relay frames, keep them opaque (fonte: P0-004)",
    "- When styling the dashboard canvas, avoid layout thrash (fonte: P2-011)",
    "- When relay frames duplicate, check the seq watermark first (fonte: P1-002)",
    "- When editing deploy scripts, justify invariants changes (fonte: P3-006)",
    "- When relay latency grows, queue with backoff and retry (fonte: P9-002)",
    "- When relay spikes happen, slow down and back off (fonte: P9-001)",
    "",
  ].join("\n");
  const pick = pickRelevantLessons(md, "relay frame duplication", "keep frames opaque, check watermark");
  check("experience: picks only keyword-matched lessons", pick.length === 4);
  check("experience: higher score first (title beats spec weight)", pick[0]!.includes("seq watermark"));
  check(
    "experience: ties resolved most-recent-first",
    pick[2]!.includes("slow down and back off") && pick[3]!.includes("queue with backoff"),
  );
  check("experience: no match → empty injection", pickRelevantLessons(md, "capacitor ios build", "app store packaging").length === 0);
  const many = Array.from({ length: 7 }, (_, i) => `- When relay topic ${i} appears, handle relay ${i} (fonte: P2-00${i})`).join("\n");
  check("experience: capped at 5 lessons", pickRelevantLessons(`${md}\n${many}`, "relay", "relay").length === 5);
}

{
  check("experience: normalizeLesson rewrites the fonte tag", normalizeLesson("- When X happens, do Y (fonte: WRONG-ID)", "P1-007") === "- When X happens, do Y (fonte: P1-007)");
  check("experience: normalizeLesson drops junk", normalizeLesson("too short", "P1-007") === "");
  const t0 = "# Experience memory (IER)\n\n## Lessons\n- When a thing exists already, do not duplicate it ever again (fonte: P0-001)\n";
  const appended = appendLessons(t0, ["- When a thing exists already, do not duplicate it ever again", "When writing tests, pin the acceptance criterion"], "P1-007");
  check("experience: append dedupes against the file and adds new", appended.added.length === 1 && appended.added[0]!.includes("(fonte: P1-007)"));
  const back = appendLessons(appended.md, ["- When writing tests, pin the acceptance criterion"], "P1-007");
  check("experience: append is idempotent", back.added.length === 0 && back.md === appended.md);
  const fresh = appendLessons(
    "",
    ["- When lesson one appears, do one", "- When lesson two appears, do two", "- When lesson three appears, do three", "- When lesson four appears, do four"],
    "P1-007",
  );
  check("experience: append caps at 3 and creates the section", fresh.added.length === 3 && parseLessons(fresh.md).length === 3);
}

{
  const capMd = "# Experience memory (IER)\n\n## Lessons\n" + Array.from({ length: 65 }, (_, i) => lessonOf(i)).join("\n") + "\n" + lessonOf(0) + "\n";
  const pruned = dedupeAndPrune(capMd);
  const kept = parseLessons(pruned.md);
  check("experience: prune removes dupes + oldest above cap", pruned.removed === 6 && kept.length === EXPERIENCE_CAP);
  check("experience: dedupe keeps the newest occurrence only", kept.filter((l) => l.includes("case 0")).length === 1);
  check("experience: keeps the most recent lessons", kept[0]!.includes("case 6") && kept[kept.length - 1]!.includes("case 0"));
  const underCap = "# Experience memory (IER)\n\n## Lessons\n" + lessonOf(1) + "\n" + lessonOf(2) + "\n";
  check("experience: at/under cap is a no-op", dedupeAndPrune(underCap).md === underCap && dedupeAndPrune(underCap).removed === 0);
}

check("experience: lessonsBlock injects nothing when empty", lessonsBlock([]) === "" && !builderPrompt(EXP_TASK, 1, "", []).includes("EXPERIENCE"));
check(
  "experience: builder prompt carries the injected lessons",
  builderPrompt(EXP_TASK, 1, "", ["- When X, do Y (fonte: P0-001)"]).includes("EXPERIENCE — relevant lessons from past merges") &&
    builderPrompt(EXP_TASK, 1, "", ["- When X, do Y (fonte: P0-001)"]).includes("(fonte: P0-001)"),
);

{
  const out = `thinking...\nLESSONS:\n- When a relay frame drops, check the seq watermark (fonte: P1-007)\n- When a test fails only in CI, pin the clock first (fonte: P1-007)\n- junk one-word\n- When three, do 3 (fonte: P1-007)\n- When four, do 4 (fonte: P1-007)\nSCRIBE:DONE\n`;
  check("experience: parseScribeLessons takes max 3 between markers", parseScribeLessons(out).length === 3);
  check("experience: parseScribeLessons requires SCRIBE:DONE", parseScribeLessons(out.replace("SCRIBE:DONE", "")).length === 0);
  check("experience: parseScribeLessons empty without marker", parseScribeLessons("- When a, do b (fonte: P1-007)").length === 0);
}

{
  const expDir = mkdtempSync(join(tmpdir(), "ocr-experience-"));
  mkdirSync(join(expDir, "docs"), { recursive: true });
  const file = join(expDir, "docs", "EXPERIENCE.md");
  writeFileSync(file, `# Experience memory (IER)\n\n## Lessons\n${Array.from({ length: 62 }, (_, i) => lessonOf(i)).join("\n")}\n`);
  const first = maintainExperienceFile(expDir);
  check("experience: maintain prunes a file above the cap", first.changed && first.removed === 2 && first.lessons === 60);
  const second = maintainExperienceFile(expDir);
  check("experience: maintain is a no-op below the cap", !second.changed && second.lessons === 60);
  check("experience: maintain on a missing file does nothing", maintainExperienceFile(join(expDir, "nope")).changed === false);
  rmSync(expDir, { recursive: true, force: true });
}

// --- desktop first-run pairing overlay (P2-007) ------------------------------
{
  // the shell self-approves its own identity, so a virgin allowlist already
  // holds one entry — only a non-host device (the phone) counts as paired
  const host = { pub: "a".repeat(40), label: "desktop-host", addedAt: "2026-09-01T00:00:00Z" };
  const phone = { pub: "b".repeat(40), addedAt: "2026-09-01T00:00:00Z" };
  check("pairing: host-only allowlist is not 'phone paired'", phonePaired([host]) === false);
  check("pairing: empty allowlist is not 'phone paired'", phonePaired([]) === false);
  check("pairing: unlabeled device counts as a phone", phonePaired([phone]) === true);
  check("pairing: phone closes the overlay", phonePaired([host, phone]) === true);
  const state = { uri: "opencode-remote://pair?v=2&room=r", qrDataUrl: "data:image/png;base64,x", devices: 1, phonePaired: false };
  check("pairing: overlay visible with QR and no phone", overlayVisible(state) === true);
  check("pairing: overlay hidden once the phone pairs", overlayVisible({ ...state, phonePaired: true }) === false);
  check("pairing: overlay hidden without a QR", overlayVisible({ ...state, qrDataUrl: null }) === false);
  check("pairing: overlay hidden with no state (daemon down)", overlayVisible(null) === false);
}

// --- desktop tray: tooltip + login autostart (P3-007) -------------------------
{
  check("tray: healthy tooltip text", daemonTooltip(true) === "OpenCode Remote — daemon ok");
  check("tray: down tooltip text", daemonTooltip(false) === "OpenCode Remote — daemon down");
  check("tray: login item supported on macOS", loginItemSupported("darwin") === true);
  check("tray: login item supported on Windows", loginItemSupported("win32") === true);
  check("tray: login item hidden on Linux", loginItemSupported("linux") === false);
  // The tooltip string is wired via setToolTip in buildTray(); guard against
  // accidental rewording that would break the ok/down contract with the UI.
  check(
    "tray: tooltip strings are distinct and carry the daemon state",
    daemonTooltip(true) !== daemonTooltip(false) &&
      daemonTooltip(true).endsWith("daemon ok") &&
      daemonTooltip(false).endsWith("daemon down"),
  );
}

if (failures > 0) {
  console.error(`UNIT TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("UNIT TESTS PASSED");
process.exit(0);
