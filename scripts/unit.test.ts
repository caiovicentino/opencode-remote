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
import { clampSlots, ensureSingleton, loadState, recordTaskFailure } from "../apps/pilot/src/state";
import { areaKey, pickBatch, pickTasks } from "../apps/pilot/src/scheduler";
import { blockTask, loadBacklog, parseBacklog, type Task } from "../apps/pilot/src/backlog";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
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
const { isKnownNoise, readConsoleMessage } = requireCjs("../scripts/desktop-render-driver.cjs") as {
  isKnownNoise: (message: string, sourceUrl: string | undefined) => boolean;
  readConsoleMessage: (...args: unknown[]) => {
    level: string;
    message?: string;
    sourceUrl?: string;
    lineNumber?: number;
  };
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

if (failures > 0) {
  console.error(`UNIT TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("UNIT TESTS PASSED");
process.exit(0);
