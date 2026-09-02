/**
 * Unit tests for pure glue code the e2e scripts don't cover.
 * Run: npx tsx scripts/unit.test.ts
 */
import { b64, fromB64, seal, openSealed, seqAad } from "@ocr/protocol";
import { parsePairingUri, localWsUrl, shouldFailoverToRelay } from "../apps/web/src/lib/client";
import { isLoopbackAddr, localOriginAllowed, localUpgradeAllowed } from "../apps/daemon/src/localws";
import { copyText, hasClipboardApi, legacyCopy } from "../apps/web/src/lib/clipboard";
import { mimeFor } from "../apps/web/src/lib/files";
import { timeAgo, sessionUpdatedTs } from "../apps/web/src/lib/time";
import { sessionTitleOf } from "../apps/web/src/lib/title";
import { dict } from "../apps/web/src/lib/i18n";
import { permissionPreview } from "../apps/web/src/lib/permission";
import { applySessionFilters, isPilotTitle, splitPilotSessions } from "../apps/web/src/lib/sessionFilter";
import { initialUnreadState, reduceUnread } from "../apps/web/src/lib/unread";
import {
  capMessagePage,
  parsePageLimit,
  shouldPaginateMessages,
  sliceMessagePage,
  PAGE_LIMIT_MAX,
} from "../apps/daemon/src/paginate";
import {
  dropCachedSession,
  getCachedSession,
  putCachedSession,
  SESSION_CACHE_MAX,
} from "../apps/web/src/lib/sessionCache";
import { taskMergedIn } from "../apps/pilot/src/pipeline";
import { cachedExec, rerunKey, type RerunResults } from "../apps/pilot/src/runner";
import {
  applySessionCosts,
  isSessionId,
  parseSessionTokens,
  pruneTaskCosts,
  querySessionTokens,
  sessionTotalTokens,
  TASK_COST_CAP,
  tokensSql,
} from "../apps/pilot/src/costs";
import { CORPUS_COMMANDS, appendCorpusSample, captureGateCorpus, corpusSlug, loadGateCorpus, sanitizeForCorpus } from "../apps/pilot/src/gate-corpus";
import {
  builderPrompt,
  codeChanges,
  budgetsFor,
  corpusGateDetail,
  isOverCap,
  MIN_CORPUS_SAMPLES,
  preserveBranch,
  recoverSpecFromBranch,
  branchHasCommits,
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
  crashRoundDecision,
  resumeBlock,
  RESUME_MAX_TASK_IDS,
  setupTaskBranch,
  specPathFor,
  touchedPilotInfraFromDiff,
  updateResumeState,
  parseScribeLessons,
  validateSpec,
  verifyEvidence,
  writeAuxSandboxConfig,
} from "../apps/pilot/src/pipeline";
import {
  appendLessons,
  dedupeAndPrune,
  EXPERIENCE_CAP,
  experienceTemplate,
  maintainExperienceFile,
  normalizeLesson,
  parseLessons,
  pickRelevantLessons,
} from "../apps/pilot/src/experience";
import {
  appendFailureLesson,
  failureLessonsBlock,
  FAILURE_FINDINGS_CAP,
  FAILURE_TAIL_CAP,
  formatFailureLesson,
  parseFailureLessons,
  readRecentFailureLessons,
  type FailureLesson,
} from "../apps/pilot/src/failureLessons";
import { AtomicWriteIo, clampSlots, ensureSingleton, loadState, normalizeModels, recordTaskFailure, saveState, startHeartbeat, tierBModelFor, writeJsonAtomic } from "../apps/pilot/src/state";
import type { PilotState } from "../apps/pilot/src/state";
import { clearTaskAttempts, doctorBacklog, doctorBranches, doctorRefs, doctorState, normalizePilotState, parseAttemptsArgs, runAttemptsCommand, validateBacklog, type AttemptsRequest, type RunFn } from "../apps/pilot/src/doctor";
import { avgPhaseDurations, burnDown, countFailSteps, rollbackHealthAlert } from "../apps/pilot/src/metrics";
import type { PilotEvent } from "../apps/pilot/src/events";
import { areaKey, pickBatch, pickTasks } from "../apps/pilot/src/scheduler";
import {
  AUDIT_BLOCK_TRIGGER,
  AUDIT_BLOCK_WINDOW_MS,
  AUDIT_RESUME_MS,
  AUDIT_WINDOW,
  auditResumeDue,
  buildDiagnosis,
  clearAuditMode,
  enterAuditMode,
  feverReason,
  formatDiagnosis,
  recordBlockEvent,
  recordCycle,
} from "../apps/pilot/src/audit";
import {
  appendCommitAndPush,
  appendReadyLines,
  auxPushIo,
  blockTask,
  loadBacklog,
  mayPush,
  parseAuxTaskLines,
  parseBacklog,
  addTask,
  type AuxPushIo,
  type Task,
} from "../apps/pilot/src/backlog";
import { clearPendingRefill, readPendingRefill, relandDetail, relandPendingRefill, savePendingRefill } from "../apps/pilot/src/refill";
import { EXPLORER_MAX_FINDINGS, EXPLORER_MAX_STEPS, EXPLORER_TIMEOUT_MIN, EXPLORER_PUSH_RETRIES, EXPLORER_PUSH_WAIT_MS, commitAndPushFindings, explorerSpec, parseExplorerFindings, type ExplorerFinding } from "../apps/pilot/src/explorer";
import { runAgent, API_PREFLIGHT, apiHealthy, claudeArgs, idScanner, mergeAgentIds, OPENCODE_URL_DEFAULT, scanIds, shouldFallbackTierB, waitForApi } from "../apps/pilot/src/runner";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, utimesSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { tmpdir, homedir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { artifactMime, kindFor, listArtifacts, readArtifact, validSegment } from "../apps/daemon/src/artifacts";
import { browseTarget, clickPoint, validSession, viewportFromParams } from "../apps/daemon/src/browse";
import { createShutdown, DRAIN_MS, stopAccepting } from "../apps/daemon/src/shutdown";
import {
  createShutdown as relayCreateShutdown,
  stopAccepting as relayStopAccepting,
  DRAIN_MS as RELAY_DRAIN_MS,
  type RelayLog,
} from "../apps/relay/src/shutdown";
import { touchedUiFromDiff, needsEscalation, parseFindings, verifyFindings, isTaskMergeSha, parseVerdict, reviewerOk } from "../apps/pilot/src/pipeline";
import { stdlibShadowHits } from "./stdlib-shadow";
import { latestUiShot, pruneShots } from "../apps/pilot/src/shot";
import { parseMarkdown, parseInline } from "../apps/web/src/lib/md";
import { parseCsv } from "../apps/web/src/lib/csv";
import { artifactMentions, fmtBytes } from "../apps/web/src/lib/artifacts";
import { clampSplitPct, isSplitViewport, SPLIT_MIN_PX } from "../apps/web/src/lib/split";
import { DISK_MIN_FREE_BYTES, diskGuardDetail, freeDiskBytes } from "../apps/pilot/src/disk";
import {
  BASELINE_SAMPLES,
  baselineFailureRate,
  baselineHealthRate,
  deploy,
  FAST_INSTALL_CMD,
  LIVE_INVARIANT_EVERY,
  quarantineWithEscalation,
  ROLLBACK_HEALTH_WINDOW_SEC,
  shouldSelfReload,
  soakFailureRateExceeded,
  soakMinutesFor,
  soakWatch,
  SOAK_RATE_TOLERANCE,
  SOAK_WINDOW,
  verifyRollbackHealth,
} from "../apps/pilot/src/deploy";
import {
  installModeFor,
  LOCK_HASH_RE,
  MAX_QUARANTINE_ENTRIES,
  MAX_VERIFIED_ENTRIES,
  MAX_WALK_COMMITS,
  parseQuarantine,
  parseVerifiedMerges,
  pickDeployableSha,
  quarantineSha,
  readLastInstall,
  readQuarantine,
  readVerifiedMerges,
  recordVerifiedMerge,
  shaGuardDetail,
  writeLastInstall,
} from "../apps/pilot/src/deployguard";
import type { PilotConfig } from "../apps/pilot/src/state";
import { overlayVisible, phonePaired } from "../apps/desktop/src/pairing";
import { versionMismatch } from "../apps/desktop/src/versions";
import { daemonTooltip, loginItemSupported, logsDirPath, openLogsFolder, trayIconSource } from "../apps/desktop/src/tray";
import { updateMenuLabel } from "../apps/desktop/src/update";
import { appIdForPlatform, applyAppUserModelId, daemonNotify, NOTIFY_BACK_BODY, NOTIFY_DOWN_BODY, WINDOWS_APP_ID } from "../apps/desktop/src/notify";
import { DEEP_LINK_QUERY_MAX, deepLinkFromArgv, parseDeepLink } from "../apps/desktop/src/deeplink";
import {
  DEFAULT_WINDOW_BOUNDS,
  loadWindowBounds,
  saveWindowBounds,
  sanitizeWindowBounds,
  WINDOW_MIN,
  windowStateFile,
  type WindowBounds,
} from "../apps/desktop/src/window-state";
import { extractReport, FORENSIC_MARKER, FORENSIC_WINDOW_MS, forensicDue, forensicPrompt, listGateFails } from "../apps/pilot/src/forensic";
import {
  activeSlots,
  initialViewState,
  isPaneOpen,
  topSlot,
  viewReducer,
  type ViewState,
} from "../apps/web/src/lib/viewState";
import { ALLOWED_EXTS, extOf, pickConverter, validateExt } from "../tools/doc2pdf.mjs";
import {
  avgDoneDuration,
  buildCards,
  buildForensicIndex,
  progressOf,
  shotsForTask,
  shotPath,
  takeoverFromBuilderLog,
  validateTakeoverDirectory,
  validateTakeoverSessionId,
} from "../apps/daemon/src/pilotforensic";

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

// --- opencode-remote:// deep link (P3-014) -----------------------------------
const deepUri =
  `opencode-remote://pair?v=2&relay=wss%3A%2F%2Frelay.example.com&room=abc123` +
  `&k=${encodeURIComponent(spki)}&name=mac`;
check("parseDeepLink valid (echoes uri)", parseDeepLink(deepUri) === deepUri);
check("parseDeepLink trims whitespace", parseDeepLink(`  ${deepUri}  `) === deepUri);
check("parseDeepLink rejects wrong scheme", parseDeepLink("https://evil.example/pair?v=2&room=x") === null);
check("parseDeepLink rejects unknown action", parseDeepLink("opencode-remote://evil?v=2&room=x") === null);
check("parseDeepLink rejects missing v", parseDeepLink("opencode-remote://pair?room=x") === null);
check("parseDeepLink rejects v1", parseDeepLink("opencode-remote://pair?v=1&room=x") === null);
check("parseDeepLink rejects path suffix", parseDeepLink("opencode-remote://pair/x?v=2") === null);
check("parseDeepLink rejects fragment", parseDeepLink("opencode-remote://pair?v=2#x") === null);
check("parseDeepLink rejects space (unsafe charset)", parseDeepLink("opencode-remote://pair?v=2&room=a b") === null);
check("parseDeepLink rejects control char", parseDeepLink("opencode-remote://pair?v=2&room=a\x00b") === null);
check(
  "parseDeepLink rejects oversize query",
  parseDeepLink(`opencode-remote://pair?v=2&room=${"a".repeat(DEEP_LINK_QUERY_MAX)}`) === null,
);
check("parseDeepLink accepts 4KB-boundary query", parseDeepLink(`opencode-remote://pair?v=2&room=${"a".repeat(DEEP_LINK_QUERY_MAX - 1 - "v=2&room=".length)}`) !== null);
check("parseDeepLink rejects garbage", parseDeepLink("not a uri") === null);
check("parseDeepLink rejects empty", parseDeepLink("") === null);
check("parseDeepLink rejects non-string", parseDeepLink(undefined) === null);
check("deepLinkFromArgv finds link in argv", deepLinkFromArgv(["C:\\app.exe", "--flag", deepUri]) === deepUri);
check("deepLinkFromArgv rejects invalid link in argv", deepLinkFromArgv(["C:\\app.exe", "opencode-remote://evil?v=2"]) === null);
check("deepLinkFromArgv no link", deepLinkFromArgv(["C:\\app.exe", "--flag"]) === null);
check("deepLinkFromArgv rejects non-array", deepLinkFromArgv("opencode-remote://pair?v=2") === null);


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

// --- dock unread badge reducer (P3-053) ---------------------------------------
check("unread starts at zero, focused at the tail", initialUnreadState(true, true).count === 0);
check("unread: arrival while blurred increments", (() => {
  let s = initialUnreadState(false, true);
  s = reduceUnread(s, { kind: "message" });
  return s.count === 1;
})());
check("unread: arrival scrolled away from the tail increments", (() => {
  let s = initialUnreadState(true, false);
  s = reduceUnread(s, { kind: "message" });
  return s.count === 1;
})());
check("unread: arrival focused at the tail does not count", (() => {
  let s = initialUnreadState(true, true);
  s = reduceUnread(s, { kind: "message" });
  return s.count === 0;
})());
check("unread: focusing zeroes", (() => {
  let s = initialUnreadState(false, true);
  s = reduceUnread(s, { kind: "message" });
  s = reduceUnread(s, { kind: "message" });
  s = reduceUnread(s, { kind: "focus" });
  return s.count === 0 && s.focused;
})());
check("unread: reaching the tail zeroes", (() => {
  let s = initialUnreadState(true, false);
  s = reduceUnread(s, { kind: "message" });
  s = reduceUnread(s, { kind: "message" });
  s = reduceUnread(s, { kind: "atEnd", atEnd: true });
  return s.count === 0 && s.atEnd;
})());
check("unread: count never regresses on non-zeroing transitions", (() => {
  let s = initialUnreadState(false, false);
  for (let i = 0; i < 5; i++) s = reduceUnread(s, { kind: "message" });
  s = reduceUnread(s, { kind: "atEnd", atEnd: false });
  s = reduceUnread(s, { kind: "blur" });
  return s.count === 5;
})());
check("unread: reset (session switch) zeroes and keeps the flags", (() => {
  let s = initialUnreadState(false, false);
  s = reduceUnread(s, { kind: "message" });
  s = reduceUnread(s, { kind: "reset" });
  return s.count === 0 && !s.focused && !s.atEnd;
})());
check("unread: scrolling away never fabricates or clears", (() => {
  let s = initialUnreadState(true, true);
  s = reduceUnread(s, { kind: "message" });
  s = reduceUnread(s, { kind: "atEnd", atEnd: false });
  return s.count === 0 && !s.atEnd;
})());

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

// --- P1-064: server-side message paging --------------------------------------
{
  const rows = Array.from({ length: 500 }, (_, i) => ({
    info: { id: `msg-${i + 1}`, role: i % 2 === 0 ? "user" : "assistant" },
    parts: [{ type: "text", text: `hello ${i + 1}` }],
  }));
  const p1 = sliceMessagePage(rows, 50);
  check("P1-064: tail page of 500x50 has exactly the last 50 rows", p1.rows.length === 50 && p1.rows[0]!.info!.id === "msg-451" && p1.rows[49]!.info!.id === "msg-500");
  check("P1-064: tail page hasMore + oldest cursor", p1.hasMore === true && p1.oldest === "msg-451" && p1.total === 500);
  const p2 = sliceMessagePage(rows, 100, "msg-451");
  check("P1-064: before cursor returns the 100 previous rows", p2.rows.length === 100 && p2.rows[0]!.info!.id === "msg-351" && p2.rows[99]!.info!.id === "msg-450");
  check("P1-064: before page still has more behind it", p2.hasMore === true && p2.oldest === "msg-351");
  const p3 = sliceMessagePage(rows, 50, "msg-2");
  check("P1-064: page at the head of history has no more behind", p3.hasMore === false && p3.rows.length === 1 && p3.oldest === "msg-1");
  const p4 = sliceMessagePage(rows, 50, "msg-vanished");
  check("P1-064: vanished before id serves the available tail", p4.rows.length === 50 && p4.hasMore === true);
  const p5 = sliceMessagePage([], 50);
  check("P1-064: empty session yields empty page without more", p5.rows.length === 0 && p5.hasMore === false && p5.oldest === null);

  // size guard: a page of 200KB tool outputs must shrink until it fits 800KB
  const fat = Array.from({ length: 500 }, (_, i) => ({
    info: { id: `fat-${i + 1}`, role: "assistant" },
    parts: [{ type: "tool", state: { output: "x".repeat(200_000) } }],
  }));
  const capped = capMessagePage(fat, 50);
  check("P1-064: oversize page shrinks until under the frame budget", JSON.stringify(capped.rows).length <= 800_000 && capped.rows.length < 50);
  check("P1-064: capped page always keeps at least one row", capped.rows.length >= 1);
  const small = capMessagePage(rows, 50);
  check("P1-064: small pages pass through the guard untouched", small.rows.length === 50 && small.hasMore === true);

  // passthrough semantics: no params -> no intercept, plain array stays
  check("P1-064: no query params keeps the passthrough", shouldPaginateMessages("GET", "/session/ses_1/message") === false && shouldPaginateMessages("GET", "/session/ses_1/message", {}) === false);
  check("P1-064: limit or before opts into paging", shouldPaginateMessages("GET", "/session/ses_1/message", { limit: "50" }) === true && shouldPaginateMessages("GET", "/session/ses_1/message", { before: "msg-1" }) === true);
  check("P1-064: paging only applies to GET of the message route", shouldPaginateMessages("POST", "/session/ses_1/message", { limit: "50" }) === false && shouldPaginateMessages("GET", "/session/ses_1", { limit: "50" }) === false);
  check("P1-064: limit clamps to 1..200", parsePageLimit("9999") === PAGE_LIMIT_MAX && parsePageLimit("0") === 1 && parsePageLimit("abc") === 50 && parsePageLimit(undefined) === 50);

  // the relay frame is BYTES: emoji/CJK tool output costs 3-4 bytes per char,
  // so the guard must measure UTF-8 (round 2 review finding)
  const cjk = Array.from({ length: 500 }, (_, i) => ({
    info: { id: `cjk-${i + 1}`, role: "assistant" },
    parts: [{ type: "tool", state: { output: "🐢".repeat(200_000) } }],
  }));
  const cappedCjk = capMessagePage(cjk, 50);
  check("P1-064: size guard measures UTF-8 bytes, not UTF-16 chars", Buffer.byteLength(JSON.stringify(cappedCjk.rows), "utf8") <= 800_000);
  const slimmedPart = cappedCjk.rows[0]?.parts?.[0] as { state?: { output?: string } } | undefined;
  check("P1-064: single oversize row is trimmed to fit, not dropped", cappedCjk.rows.length === 1 && !!slimmedPart?.state?.output && slimmedPart.state.output.length <= 2000);
  const texty = [{ info: { id: "msg-big", role: "user" }, parts: [{ type: "text", text: "x".repeat(2_000_000) }] }];
  const clipped = capMessagePage(texty, 50);
  check("P1-064: giant text row is clipped so the frame guarantee holds", clipped.rows.length === 1 && Buffer.byteLength(JSON.stringify(clipped.rows), "utf8") <= 800_000);
  const weird: { info: { id: string }; parts: { loop?: unknown }[] }[] = [{ info: { id: "msg-cyc" }, parts: [{}] }];
  weird[0]!.parts[0]!.loop = weird; // cyclic: cannot be serialized at all
  const dropped = capMessagePage(weird as never[], 50);
  check("P1-064: unserializable row is dropped instead of killing the frame", dropped.rows.length === 0 && dropped.hasMore === false);

  // acceptance 4: a 50-row tail of a 500-message session <100KB and fast
  const perfRows = Array.from({ length: 500 }, (_, i) => ({
    info: { id: `p-${i + 1}`, role: i % 2 ? "assistant" : "user" },
    parts: [{ type: "text", text: `message body ${i + 1} with some realistic bubble content` }],
  }));
  const perfT0 = Date.now();
  const perfPage = capMessagePage(perfRows, 50, undefined);
  const perfMs = Date.now() - perfT0;
  const perfBytes = Buffer.byteLength(JSON.stringify(perfPage.rows), "utf8");
  check(`P1-064: tail page of 500 rows <100KB (${perfBytes}B) and sliced <500ms (${perfMs}ms)`, perfBytes < 100_000 && perfMs < 500);
}

// --- P1-064: warm session cache (last 3 conversations) -----------------------
{
  const entry = { bubbles: [] as unknown[], tools: new Map(), hasMore: false, oldest: null };
  for (const id of ["cache-a", "cache-b", "cache-c", "cache-d", "cache-e"]) dropCachedSession(id);
  putCachedSession("cache-a", entry);
  putCachedSession("cache-b", entry);
  putCachedSession("cache-c", entry);
  const touched = getCachedSession("cache-a"); // touch: a becomes the newest again
  putCachedSession("cache-d", entry); // evicts b (oldest)
  putCachedSession("cache-e", entry); // evicts c — a survives thanks to the touch
  const ra = getCachedSession("cache-a");
  const rb = getCachedSession("cache-b");
  const rc = getCachedSession("cache-c");
  const rd = getCachedSession("cache-d");
  const re = getCachedSession("cache-e");
  check("P1-064: cache keeps at most 3 sessions, evicting the oldest", touched !== null && ra !== null && rb === null && rc === null && rd !== null && re !== null);
  check("P1-064: unknown session id is a cache miss", getCachedSession("cache-zzz") === null);
  check("P1-064: cache cap is 3", SESSION_CACHE_MAX === 3);
}

// --- P1-064: pilot session grouping heuristic --------------------------------
check("P1-064: canonical pilot task titles are detected", isPilotTitle("P1-064: fast session switch") && isPilotTitle("P2-049: pairing copy fixed"));
// spec heuristic matches the task id anywhere in the title — so a USER session
// mentioning a task id is grouped too; documented in the READMEs, rename escapes
check("P1-064: ordinary titles are not grouped", !isPilotTitle("Planilha de vendas") && !isPilotTitle("P1-64 nope") && !isPilotTitle("") && !isPilotTitle(undefined));
const mixed = [
  { id: "1", title: "P1-064: fast switch" },
  { id: "2", title: "Groceries" },
  { id: "3", title: "P2-063: breaker" },
];
const split = splitPilotSessions(mixed);
check("P1-064: list splits into user and pilot groups", split.user.length === 1 && split.user[0]!.id === "2" && split.pilot.length === 2);

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

// --- P1-057 aux agents are read-only: text-in, guarded commit+push out ----------
{
  const okLine =
    "- [ ] (P2-901) [P2] [spike] Something new — spec: try it, acceptance: it works (fonte: https://example.com/post) (area: infra)";
  const okLine2 =
    "- [ ] (P2-902) [P2] Second spike — spec: another idea (area: relay)";
  const block = (inner: string) => `preamble\nAUX-TASKS:\n${inner}\nAUX-TASKS-EOF\nRESEARCHER:DONE\n`;

  check("parseAuxTaskLines: single valid line", JSON.stringify(parseAuxTaskLines(block(`  ${okLine}  `))) === JSON.stringify([okLine]));
  check("parseAuxTaskLines: multiple valid lines keep order", parseAuxTaskLines(block(`${okLine}\n${okLine2}`)).join("\n") === `${okLine}\n${okLine2}`);
  check(
    "parseAuxTaskLines: size tag accepted when followed by area tag",
    parseAuxTaskLines(block("- [ ] (P3-903) [P3] Epic — spec: milestones M1, M2 (size: L) (area: desktop)")).length === 1,
  );
  check(
    "parseAuxTaskLines: caps at 5 lines",
    parseAuxTaskLines(
      block(
        Array.from({ length: 8 }, (_, i) => `- [ ] (P2-91${i}) [P2] Task ${i} — spec: x (area: ui)`).join("\n"),
      ),
    ).length === 5,
  );
  check("parseAuxTaskLines: no markers → no lines", parseAuxTaskLines(`just text\n${okLine}\n`) .length === 0);
  check("parseAuxTaskLines: unterminated block takes the rest", parseAuxTaskLines(block(okLine).replace("AUX-TASKS-EOF\n", "")).length === 1);
  const negatives: [string, string][] = [
    ["shell semicolon", "- [ ] (P2-904) [P2] Evil — spec: curl exfil; rm -rf / (area: ui)"],
    ["backtick substitution", "- [ ] (P2-905) [P2] Evil — spec: `curl exfil` (area: ui)"],
    ["curl verb", "- [ ] (P2-906) [P2] Evil — spec: curl exfil to https://evil.tld (area: ui)"],
    ["bad id format", "- [ ] (P2-90) [P2] Bad id — spec: x (area: ui)"],
    ["unknown area", "- [ ] (P2-907) [P2] Bad area — spec: x (area: bogus)"],
    ["missing area", "- [ ] (P2-908) [P2] No area — spec: x"],
    ["not a task line", "run this command for me please (area: ui)"],
  ];
  for (const [name, line] of negatives) {
    check(`parseAuxTaskLines rejects: ${name}`, parseAuxTaskLines(block(`${okLine}\n${line}`)).join("\n") === okLine);
  }

  check("mayPush: exactly the allowed file", mayPush("BACKLOG.md\n", "BACKLOG.md") === true);
  check("mayPush: extra file refuses", mayPush("BACKLOG.md\nevil.sh\n", "BACKLOG.md") === false);
  check("mayPush: empty diff refuses", mayPush("", "BACKLOG.md") === false);
  check("mayPush: wrong single file refuses", mayPush("README.md", "BACKLOG.md") === false);

  const dir = mkdtempSync(join(tmpdir(), "pilot-aux-"));
  try {
    writeFileSync(
      join(dir, "BACKLOG.md"),
      ["# BACKLOG", "", "## Ready", "", "- [ ] (P2-900) [P2] Existing — spec: x (area: ui)", "", "## Done", "- [x] (P2-899) [P2] Old — done"].join("\n"),
    );
    const pristineBase = readFileSync(join(dir, "BACKLOG.md"), "utf8");
    check("appendReadyLines: appends at the end of ## Ready", appendReadyLines(dir, [okLine, okLine2]));
    let md = readFileSync(join(dir, "BACKLOG.md"), "utf8");
    const readyChunk = md.split("\n## Ready\n")[1]?.split("\n## Done")[0] ?? "";
    check(
      "appendReadyLines: lines land inside the Ready section",
      readyChunk.includes("(P2-901)") && readyChunk.includes("(P2-902)") && readyChunk.indexOf("(P2-900)") < readyChunk.indexOf("(P2-901)"),
    );
    check("appendReadyLines: Blocked/Done untouched", md.indexOf("(P2-899)") > md.indexOf("(P2-902)"));
    check("appendReadyLines: duplicate id refused", appendReadyLines(dir, ["- [ ] (P2-901) [P2] Dup — spec: x (area: ui)"]) === false);
    md = readFileSync(join(dir, "BACKLOG.md"), "utf8");
    check("appendReadyLines: duplicate did not double-insert", (md.match(/\(P2-901\)/g) ?? []).length === 1);
    check("appendReadyLines: empty input is a no-op", appendReadyLines(dir, []) === false);

    // appendCommitAndPush with fake git: guard refusal must never push, retries re-append
    let pristine = pristineBase;
    let pushCalls = 0;
    let diffBehavior = "BACKLOG.md\n";
    let sleeps = 0;
    const fakeIo = (pushFails = 0) => ({
      exec: (cmd: string) => {
        if (cmd.includes("git reset")) writeFileSync(join(dir, "BACKLOG.md"), pristine);
        if (cmd.startsWith("git diff")) return { ok: true, output: diffBehavior };
        if (cmd.startsWith("git push")) {
          pushCalls++;
          return { ok: pushCalls > pushFails, output: "" };
        }
        return { ok: true, output: "" };
      },
      sleep: () => {
        sleeps++;
        return Promise.resolve();
      },
    });
    check("appendCommitAndPush: lands with the guard green", (await appendCommitAndPush(dir, [okLine], "m1", fakeIo())) === "pushed");
    check("appendCommitAndPush: exactly one push for the happy path", pushCalls === 1);
    check("appendCommitAndPush: lines committed into BACKLOG.md", readFileSync(join(dir, "BACKLOG.md"), "utf8").includes("(P2-901)"));

    pristine = pristineBase;
    pushCalls = 0;
    diffBehavior = "BACKLOG.md\nevil.sh\n";
    check("appendCommitAndPush: guard refusal refuses the push", (await appendCommitAndPush(dir, [okLine], "m2", fakeIo())) === "refused");
    check("appendCommitAndPush: refused means zero pushes", pushCalls === 0);

    diffBehavior = "BACKLOG.md\n";
    pushCalls = 0;
    sleeps = 0;
    check("appendCommitAndPush: non-fast-forward retries then lands", (await appendCommitAndPush(dir, [okLine2], "m3", fakeIo(2))) === "pushed");
    check("appendCommitAndPush: push retried twice with sleeps", pushCalls === 3 && sleeps === 2);

    pristine = pristineBase.replace("(P2-900)", "(P2-901)"); // line already landed
    pushCalls = 0;
    check(
      "appendCommitAndPush: all-duplicate lines land nothing",
      (await appendCommitAndPush(dir, [okLine], "m4", fakeIo())) === "failed" && pushCalls === 0,
    );

    // real-git smoke (P3-052 lesson): bare remote + apostrophed commit message
    const gdir = mkdtempSync(join(tmpdir(), "pilot-aux-git-"));
    try {
      const remote = join(gdir, "remote.git");
      const work = join(gdir, "work");
      execSync(`git init -q --bare -b main ${JSON.stringify(remote)}`);
      execSync(`git clone -q ${JSON.stringify(remote)} ${JSON.stringify(work)}`);
      writeFileSync(join(work, "BACKLOG.md"), pristineBase);
      execSync(`git -C ${JSON.stringify(work)} add BACKLOG.md`);
      execSync(`git -C ${JSON.stringify(work)} -c user.name=t -c user.email=t@t commit -qm init`);
      execSync(`git -C ${JSON.stringify(work)} push -q origin main`);
      const message = "pilot(researcher): it's a scan — 'quoted'";
      check("appendCommitAndPush real-git smoke: apostrophed message lands", (await appendCommitAndPush(work, [okLine], message, auxPushIo(work))) === "pushed");
      const shown = execSync(`git -C ${JSON.stringify(work)} show origin/main:BACKLOG.md`, { encoding: "utf8" });
      const subject = execSync(`git -C ${JSON.stringify(work)} log -1 --format=%s origin/main`, { encoding: "utf8" }).trim();
      check("appendCommitAndPush real-git smoke: line landed on origin/main", shown.includes("(P2-901)"));
      check("appendCommitAndPush real-git smoke: apostrophed subject intact", subject === message);
      const names = execSync(`git -C ${JSON.stringify(work)} diff --name-only origin/main~1 origin/main`, { encoding: "utf8" }).trim();
      check("appendCommitAndPush real-git smoke: diff is exactly BACKLOG.md", names === "BACKLOG.md");
    } finally {
      rmSync(gdir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const sandboxDir = mkdtempSync(join(tmpdir(), "pilot-aux-sandbox-"));
  try {
    writeAuxSandboxConfig(sandboxDir);
    const cfg = JSON.parse(readFileSync(join(sandboxDir, "opencode.json"), "utf8")) as {
      permission: Record<string, string>;
    };
    check(
      "writeAuxSandboxConfig: bash/edit/external_directory denied, webfetch allowed",
      cfg.permission.bash === "deny" && cfg.permission.edit === "deny" && cfg.permission.external_directory === "deny" && cfg.permission.webfetch === "allow",
    );
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
}

// --- P1-037 pending refill: drafted tasks survive a failed push ------------------
{
  const line1 = "- [ ] (P3-951) [P3] Refill survivor — spec: x (area: infra)";
  const line2 = "- [ ] (P3-952) [P3] Refill second — spec: y (area: ui)";
  const dir = mkdtempSync(join(tmpdir(), "pilot-refill-"));
  try {
    const file = join(dir, "pending-refill.json");
    check(
      "pendingRefill: save/read round-trip preserves lines + message",
      (() => {
        if (!savePendingRefill(file, [line1, line2], "refill-msg")) return false;
        const r = readPendingRefill(file);
        return !!r && r.lines.join("\n") === `${line1}\n${line2}` && r.message === "refill-msg" && r.ts.length > 0;
      })(),
    );
    writeFileSync(file, "{corrupt");
    check("pendingRefill: corrupt JSON reads as null without throwing", readPendingRefill(file) === null);
    clearPendingRefill(file);
    check("pendingRefill: clear removes the store", readPendingRefill(file) === null);
    check("pendingRefill: relandDetail summaries", relandDetail("pushed", 2) === "pending refill landed (2 lines)" && relandDetail("empty", 1) === "pending refill already landed on origin/main" && relandDetail("failed", 1) === "pending refill still failing");

    // real bare remote: the push outage + recovery story of a real idle cycle
    const gdir = mkdtempSync(join(tmpdir(), "pilot-refill-git-"));
    try {
      const remote = join(gdir, "remote.git");
      const work = join(gdir, "work");
      execSync(`git init -q --bare -b main ${JSON.stringify(remote)}`);
      execSync(`git clone -q ${JSON.stringify(remote)} ${JSON.stringify(work)}`);
      writeFileSync(join(work, "BACKLOG.md"), "# BACKLOG\n\n## Ready\n\n## Done\n");
      execSync(`git -C ${JSON.stringify(work)} add BACKLOG.md`);
      execSync(`git -C ${JSON.stringify(work)} -c user.name=t -c user.email=t@t commit -qm init`);
      execSync(`git -C ${JSON.stringify(work)} push -q origin main`);
      const realIo = auxPushIo(work);
      const pushDownIo: AuxPushIo = {
        exec: (cmd) => (cmd.startsWith("git push") ? { ok: false, output: "" } : realIo.exec(cmd)),
        sleep: () => Promise.resolve(),
      };
      let pushes = 0;
      const countingIo: AuxPushIo = {
        exec: (cmd) => {
          if (cmd.startsWith("git push")) pushes++;
          return realIo.exec(cmd);
        },
        sleep: () => Promise.resolve(),
      };
      check("pendingRefill: push outage lands nothing", (await appendCommitAndPush(work, [line1], "m1", pushDownIo)) === "failed");
      check("pendingRefill: failed landing is saved as pending", savePendingRefill(file, [line1], "m1") === true);
      // the very next syncWorkspace: reset --hard + clean against origin/main
      execSync(`git -C ${JSON.stringify(work)} reset -q --hard origin/main`);
      execSync(`git -C ${JSON.stringify(work)} clean -qfd`);
      check("pendingRefill: syncWorkspace reset does not lose drafted tasks", (readPendingRefill(file)?.lines ?? []).join("\n") === line1);
      check("pendingRefill: reland pushes when git recovers", (await relandPendingRefill(work, file, countingIo)) === "pushed");
      check("pendingRefill: reland clears the store", readPendingRefill(file) === null);
      const shown = execSync(`git -C ${JSON.stringify(work)} show origin/main:BACKLOG.md`, { encoding: "utf8" });
      check("pendingRefill: relanded line is on origin/main", shown.includes("(P3-951)"));
      savePendingRefill(file, [line1], "m2");
      pushes = 0;
      check("pendingRefill: already-landed ids reland as empty", (await relandPendingRefill(work, file, countingIo)) === "empty");
      check("pendingRefill: empty reland clears the store", readPendingRefill(file) === null);
      check("pendingRefill: empty reland never pushes", pushes === 0);
      savePendingRefill(file, [line2], "m3");
      check(
        "pendingRefill: reland with push down keeps the store",
        (await relandPendingRefill(work, file, pushDownIo)) === "failed" && readPendingRefill(file)?.lines[0] === line2,
      );
    } finally {
      rmSync(gdir, { recursive: true, force: true });
    }
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

// --- P2-024 writeJsonAtomic: state.json survives a crash mid-write --------------
{
  const makeIo = () => {
    const files = new Map<string, string>();
    const renames: string[] = [];
    const unlinks: string[] = [];
    let failRename = false;
    const io: AtomicWriteIo = {
      writeFileSync: (f, d) => {
        files.set(f, d);
      },
      renameSync: (from, to) => {
        if (failRename) throw new Error("rename boom");
        const v = files.get(from);
        if (v === undefined) throw new Error(`ENOENT: ${from}`);
        files.delete(from);
        files.set(to, v);
        renames.push(`${from}->${to}`);
      },
      unlinkSync: (f) => {
        unlinks.push(f);
        files.delete(f);
      },
    };
    return { io, files, renames, unlinks, breakRename: () => (failRename = true) };
  };

  const dest = "/mock/state.json";
  const tmp = `${dest}.tmp`;

  // successful rename: destination has the payload, no .tmp left behind
  const ok = makeIo();
  writeJsonAtomic(dest, { a: 1 }, ok.io);
  check("writeJsonAtomic: rename swaps the destination", ok.files.get(dest) === JSON.stringify({ a: 1 }, null, 2));
  check("writeJsonAtomic: .tmp never survives on success", ok.files.has(tmp) === false && ok.renames.join() === `${tmp}->${dest}`);

  // failed rename: .tmp removed, error rethrown for the caller, dest untouched
  const badRename = makeIo();
  ok.files.forEach((v, k) => badRename.files.set(k, v));
  badRename.files.set(dest, "previous-good-state");
  badRename.breakRename();
  let threw = false;
  try {
    writeJsonAtomic(dest, { a: 2 }, badRename.io);
  } catch {
    threw = true;
  }
  check("writeJsonAtomic: failed rename rethrows to the caller", threw);
  check("writeJsonAtomic: failed rename removes the .tmp", badRename.files.has(tmp) === false && badRename.unlinks.join() === tmp);
  check("writeJsonAtomic: failed rename leaves the old destination intact", badRename.files.get(dest) === "previous-good-state");

  // failed write: same cleanup contract, no rename attempted
  const badWrite = makeIo();
  badWrite.io.writeFileSync = () => {
    throw new Error("disk full");
  };
  threw = false;
  try {
    writeJsonAtomic(dest, { a: 3 }, badWrite.io);
  } catch {
    threw = true;
  }
  check("writeJsonAtomic: failed write rethrows and cleans the .tmp", threw && badWrite.files.has(tmp) === false && badWrite.renames.length === 0);
}
{
  const dir = mkdtempSync(join(tmpdir(), "pilot-state-atomic-"));
  try {
    const file = join(dir, "state.json");
    saveState({ date: "2026-01-01", tasks: 2, deploys: 1, failures: 0, merges: 0, taskAttempts: { "P2-024": 1 } }, file);
    check("saveState: atomic write round-trips through loadState", loadState(file).taskAttempts["P2-024"] === 1);
    check("saveState: no .tmp residue in the state dir", readdirSync(dir).join() === "state.json");
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

// --- side-by-side artifact preview thresholds (P2-062) ------------------------
check(
  "split preview: viewport threshold + divider drag clamp",
  SPLIT_MIN_PX === 900 &&
    isSplitViewport(900) &&
    isSplitViewport(1440) &&
    !isSplitViewport(899) &&
    !isSplitViewport(390) &&
    clampSplitPct(0.5) === 0.5 &&
    clampSplitPct(0.05) === 0.25 &&
    clampSplitPct(0.99) === 0.75 &&
    clampSplitPct(Number.NaN) === 0.5,
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
  // P2-042: the planner sees the same lessons as the builder/strategist
  check(
    "planner: no lessons → prompt stays clean",
    !plannerPrompt(TASK, 1).includes("EXPERIENCE") && !plannerPrompt(TASK, 1).includes("FAILURE LESSONS"),
  );
  check(
    "planner: prompt carries injected IER lessons",
    plannerPrompt(TASK, 1, ["- When X, do Y (fonte: P0-001)"]).includes("EXPERIENCE — relevant lessons from past merges") &&
      plannerPrompt(TASK, 1, ["- When X, do Y (fonte: P0-001)"]).includes("(fonte: P0-001)"),
  );
  const plannerLessons = pickRelevantLessons(
    "# Experience memory (IER)\n\n## Lessons\n- When you build the planner prompt, inject matched lessons (fonte: P2-042)\n",
    TASK.title,
    TASK.spec,
  );
  check(
    "planner: keyword-matched lessons reach the prompt (match criterion)",
    plannerLessons.length === 1 && plannerPrompt(TASK, 1, plannerLessons).includes("inject matched lessons"),
  );
  check(
    "planner: prompt carries the failure-lessons block",
    plannerPrompt(TASK, 1, [], failureLessonsBlock([
      { kind: "failure", ts: "", task: "P2-001", attempts: 4, step: "typecheck", findings: "finding f", tail: "tail t" },
    ])).includes("FAILURE LESSONS") &&
      plannerPrompt(TASK, 1, [], failureLessonsBlock([
        { kind: "failure", ts: "", task: "P2-001", attempts: 4, step: "typecheck", findings: "finding f", tail: "tail t" },
      ])).includes("[P2-001]"),
  );
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

// --- P1-060 long-horizon tasks: size tag, budgets, checkpoint review ----------
{
  const md = [
    "## Ready",
    "",
    "- [ ] (L-001) [P1] Epic — spec: whole shell v2 (size: L) (area: desktop)",
    "- [ ] (L-002) [P2] Plain — spec: x (area: ui)",
    "- [ ] (L-003) [P2] Reversed tags — spec: x (area: daemon) (size: L)",
    "- [ ] (L-004) [P2] Bogus size — spec: x (size: XL)",
  ].join("\n");
  const tasks = parseBacklog(md);
  const byId = (id: string) => tasks.find((t) => t.id === id)!;
  check("size: (size: L) parsed and stripped before (area:)", byId("L-001")!.size === "L" && byId("L-001")!.area === "desktop" && byId("L-001")!.spec === "whole shell v2");
  check("size: absent tag defaults to S", byId("L-002")!.size === "S");
  check("size: tag after the area tag also parses", byId("L-003")!.size === "L" && byId("L-003")!.area === "daemon");
  check("size: unknown value falls back to S and stays in spec", byId("L-004")!.size === "S" && byId("L-004")!.spec.includes("(size: XL)"));

  check("budgetsFor: S keeps the classic budgets", JSON.stringify(budgetsFor("S")) === '{"rounds":3,"timeoutMin":45,"attempts":4}');
  check("budgetsFor: M behaves like S", JSON.stringify(budgetsFor("M")) === JSON.stringify(budgetsFor("S")));
  check("budgetsFor: L scales to 6 rounds / 90min / 6 attempts", JSON.stringify(budgetsFor("L")) === '{"rounds":6,"timeoutMin":90,"attempts":6}');
  check("budgetsFor: undefined size falls back to S", JSON.stringify(budgetsFor(undefined)) === JSON.stringify(budgetsFor("S")));

  check("isOverCap: L with 5 attempts keeps going (cap 6)", isOverCap(5, "L") === false && isOverCap(6, "L") === true);
  check("isOverCap: S with 4 attempts is capped", isOverCap(4, "S") === true && isOverCap(3, "S") === false);
  check("isOverCap: undefined attempts is below every cap", isOverCap(undefined, "S") === false && isOverCap(undefined, "L") === false);

  check("preserveBranch: first attempt (0/undefined) recreates the branch", preserveBranch(0, true) === false && preserveBranch(undefined, true) === false);
  check("preserveBranch: later attempt keeps an existing branch", preserveBranch(2, true) === true);
  check("preserveBranch: missing branch falls back to fresh", preserveBranch(2, false) === false);

  // P1-044 autocatalysis lane: pilot-infra detection from a name-only diff
  check(
    "pilotInfra: any diff line under apps/pilot/ marks the lane",
    touchedPilotInfraFromDiff("apps/pilot/src/deploy.ts\napps/web/src/x.ts") === true &&
      touchedPilotInfraFromDiff("apps/pilot/") === true,
  );
  check(
    "pilotInfra: lookalike paths and UI-only diffs are not the lane",
    touchedPilotInfraFromDiff("apps/web/src/pilot-helper.ts\napps/desktop/x.ts") === false &&
      touchedPilotInfraFromDiff("") === false,
  );
  check("pilotInfra: corpus gate demands >=3 samples per command", MIN_CORPUS_SAMPLES === 3);

  const L_TASK: Task = { id: "P1-060", priority: "P1", title: "Long horizon", spec: "", area: "infra", line: "", size: "L" };
  const S_TASK: Task = { ...L_TASK, size: "S" };
  check("planner: L task demands numbered milestones in the spec", plannerPrompt(L_TASK, 1).includes("milestones M1..Mn"));
  check("planner: S task gets no milestone demand", !plannerPrompt(S_TASK, 1).includes("milestones M1..Mn"));
  check("builder: L task gets the milestone-per-round instruction", builderPrompt(L_TASK, 1).includes("M1..Mn") && builderPrompt(L_TASK, 1).includes("IN ORDER"));
  check("builder: attempt>1 orders continuation from the preserved branch", builderPrompt(S_TASK, 1, "", [], null, null, 2).includes("was PRESERVED"));
  check("builder: attempt 1 has no continuation block", !builderPrompt(S_TASK, 1).includes("was PRESERVED"));
  const inc = reviewerPrompt("SECURITY", "crypto", L_TASK, "", null, null, "abc1234");
  check("reviewer: incremental scope note cites the range", inc.includes("INCREMENTAL REVIEW") && inc.includes("commits since abc1234"));
  check("reviewer: no incremental note for total diffs", !reviewerPrompt("SECURITY", "crypto", L_TASK, "", null).includes("INCREMENTAL REVIEW"));

  // scratch git repo: spec recovery from a preserved branch's history
  const recRepo = mkdtempSync(join(tmpdir(), "ocr-specrecover-"));
  try {
    const g = (c: string) => execSync(c, { cwd: recRepo, stdio: ["ignore", "pipe", "pipe"] });
    g("git init -q -b main .");
    g("git config user.email t@t.local");
    g("git config user.name t");
    writeFileSync(join(recRepo, "README.md"), "base\n");
    g("git add . && git commit -qm base");
    g("git update-ref refs/remotes/origin/main HEAD");
    g("git checkout -qb pilot/P1-060");
    mkdirSync(join(recRepo, "specs"));
    const validSpec = ["## Problem", "## Approach", "## Touched files", "## Edge cases", "## Acceptance criteria", "## Out of scope"].join("\n") + "\n";
    writeFileSync(join(recRepo, "specs", "P1-060.md"), validSpec);
    g("git add specs/P1-060.md && git commit -qm 'pilot(P1-060): planner spec'");
    g("git commit -qm work --allow-empty"); // preserved attempt work
    check("branchHasCommits: preserved branch has commits beyond origin/main", branchHasCommits(recRepo, "pilot/P1-060") === true);
    check("branchHasCommits: branch at origin/main has none", branchHasCommits(recRepo, "main") === false);
    // tampered tip: the recovery must walk back to the committed planner spec
    writeFileSync(join(recRepo, "specs", "P1-060.md"), "tampered\n");
    g("git add specs/P1-060.md && git commit -qm 'tamper the spec'");
    check("spec recovery: tampered tip falls back to the committed planner spec", recoverSpecFromBranch(recRepo, "P1-060", "specs/P1-060.md") === validSpec);
    // missing tip: the recovery still finds the ancestor blob
    g("git rm -q specs/P1-060.md && git commit -qm 'delete the spec'");
    check("spec recovery: deleted tip still recovers from history", recoverSpecFromBranch(recRepo, "P1-060", "specs/P1-060.md") === validSpec);
    check("spec recovery: no history at all returns null", recoverSpecFromBranch(recRepo, "P1-061", "specs/P1-061.md") === null);
  } finally {
    rmSync(recRepo, { recursive: true, force: true });
  }
}

// --- P1-036: setupTaskBranch preserves the task branch across attempts ----------
{
  const originDir = mkdtempSync(join(tmpdir(), "ocr-branchorigin-"));
  const wsRepo = mkdtempSync(join(tmpdir(), "ocr-branchws-"));
  try {
    // real bare origin: setupTaskBranch runs `git fetch origin` unconditionally
    execSync(`git init -q --bare ${JSON.stringify(originDir)}`, { stdio: ["ignore", "pipe", "pipe"] });
    const g = (c: string) => execSync(c, { cwd: wsRepo, stdio: ["ignore", "pipe", "pipe"] });
    g("git init -q -b main .");
    g("git config user.email t@t.local");
    g("git config user.name t");
    writeFileSync(join(wsRepo, "README.md"), "base\n");
    g("git add . && git commit -qm base");
    g(`git remote add origin ${JSON.stringify(originDir)}`);
    g("git push -q origin main");
    const originSha = g("git rev-parse origin/main").toString().trim();

    // attempt 2 with a preserved branch: attempt-1 committed work survives
    g("git checkout -qb pilot/P1-036T");
    writeFileSync(join(wsRepo, "attempt-work.txt"), "attempt-1 work\n");
    g("git add . && git commit -qm 'attempt-1 work'");
    const preservedSha = g("git rev-parse HEAD").toString().trim();
    g("git checkout -q main"); // workspace sits anywhere; the branch is the carrier
    const resumed = setupTaskBranch(wsRepo, "P1-036T", 1);
    let shaResolves = false;
    try {
      g(`git cat-file -e '${preservedSha}^{commit}'`);
      shaResolves = true;
    } catch {}
    check("P1-036: attempt 2 with preserved branch resumes it", resumed === true);
    check("P1-036: attempt 2 HEAD is the task branch", g("git rev-parse --abbrev-ref HEAD").toString().trim() === "pilot/P1-036T");
    check("P1-036: attempt-1 commit survives the resume", shaResolves);
    check("P1-036: attempt-1 work present in the worktree", existsSync(join(wsRepo, "attempt-work.txt")));

    // attempt 0 recreates: stale branch + stale commit are discarded by design
    g("git checkout -qb pilot/P2-000T origin/main");
    writeFileSync(join(wsRepo, "stale.txt"), "stale\n");
    g("git add . && git commit -qm stale");
    const staleSha = g("git rev-parse HEAD").toString().trim();
    check("P1-036: attempt 0 recreates the branch (fresh path)", setupTaskBranch(wsRepo, "P2-000T", 0) === false);
    check("P1-036: attempt 0 branch points at origin/main", g("git rev-parse refs/heads/pilot/P2-000T").toString().trim() === originSha);
    check("P1-036: attempt 0 leaves the stale commit unreachable", !g("git rev-list --all").toString().includes(staleSha));

    // undefined attempts behaves like attempt 0
    g("git checkout -qb pilot/P3-000T origin/main");
    g("git commit -qm stale3 --allow-empty");
    const stale3Sha = g("git rev-parse HEAD").toString().trim();
    check(
      "P1-036: undefined attempts behaves like attempt 0",
      setupTaskBranch(wsRepo, "P3-000T", undefined) === false &&
        g("git rev-parse refs/heads/pilot/P3-000T").toString().trim() === originSha,
    );
    check("P1-036: undefined attempts drops the stale commit", !g("git rev-list --all").toString().includes(stale3Sha));

    // attempts > 0 with a missing branch (fresh slot clone) falls back to fresh
    check("P1-036: missing branch with attempts>0 falls back to fresh", setupTaskBranch(wsRepo, "P0-000T", 3) === false);
    check(
      "P1-036: fallback still creates the branch at origin/main",
      g("git rev-parse refs/heads/pilot/P0-000T").toString().trim() === originSha &&
        g("git rev-parse --abbrev-ref HEAD").toString().trim() === "pilot/P0-000T",
    );
  } finally {
    rmSync(wsRepo, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  }
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

// --- verdict = last marker wins + code-observation findings (P2-038) -----------
{
  check("p2-038: parseVerdict takes the LAST marker (approve then changes)", parseVerdict("VERDICT: APPROVE\nprose...\nVERDICT: REQUEST_CHANGES") === "REQUEST_CHANGES");
  check("p2-038: parseVerdict takes the LAST marker (changes then approve)", parseVerdict("VERDICT: REQUEST_CHANGES\n- x\nVERDICT: APPROVE") === "APPROVE");
  check("p2-038: parseVerdict single markers", parseVerdict("VERDICT: APPROVE") === "APPROVE" && parseVerdict("VERDICT: REQUEST_CHANGES") === "REQUEST_CHANGES");
  check("p2-038: parseVerdict case-insensitive with spacing", parseVerdict("verdict:  approve") === "APPROVE");
  check("p2-038: parseVerdict no marker → null", parseVerdict("looks great to me") === null);
  check("p2-038: reviewerOk — APPROVE with verified findings REJECTS", !reviewerOk("VERDICT: APPROVE\n- real.ts:1 — wrong", ["- real.ts:1 — wrong"], []));
  check("p2-038: reviewerOk — clean APPROVE approves", reviewerOk("VERDICT: APPROVE", [], []));
  check("p2-038: reviewerOk — REQUEST_CHANGES with verified findings rejects", !reviewerOk("VERDICT: REQUEST_CHANGES\n- real.ts:1 — wrong", ["- real.ts:1 — wrong"], []));
  check("p2-038: reviewerOk — all findings dropped → effective approve", reviewerOk("VERDICT: REQUEST_CHANGES\n- ghost.ts:1 — nope", [], ["- ghost.ts:1 — nope"]));
  check("p2-038: reviewerOk — no marker fails closed", !reviewerOk("all good", [], []));
  const twoMarkers = parseFindings("VERDICT: APPROVE\n- early bullet\nVERDICT: REQUEST_CHANGES\n- late bullet");
  check("p2-038: parseFindings anchored at the LAST marker", twoMarkers.some((f) => f.includes("late bullet")) && !twoMarkers.some((f) => f.includes("early")));

  // requirement (d): code-observation findings verified deterministically
  const ws2 = mkdtempSync(join(tmpdir(), "p2-038-"));
  mkdirSync(join(ws2, "apps", "desktop", "src"), { recursive: true });
  // line 3 contains the real symbol `[request]`
  writeFileSync(join(ws2, "apps", "desktop", "src", "CommandPalette.tsx"), "export const a = 1;\n\nconst q = [request];\n");
  writeFileSync(join(ws2, "real.ts"), "alpha\nbeta\n");
  const diff2 = "diff --git a/real.ts b/real.ts\n+beta touched\n";
  check(
    "p2-038: REAL finding — bare-name file:line + real symbol resolves",
    verifyFindings(["- `CommandPalette.tsx:3` — `[request]` is used without a guard"], ws2, diff2).kept.length === 1,
  );
  check(
    "p2-038: FAKE finding — real file:line but symbol exists nowhere → hallucinated",
    verifyFindings(["- `CommandPalette.tsx:3` — `totallyFakeSymbol` is unused"], ws2, diff2).dropped.length === 1,
  );
  check(
    "p2-038: symbol present in the reviewed diff → finding valid",
    verifyFindings(["- `real.ts:2` — the `beta touched` line is misplaced"], ws2, diff2).kept.length === 1,
  );
  check(
    "p2-038: cited line empty/out-of-range still hallucinated",
    verifyFindings(["- `CommandPalette.tsx:99` — `[request]` leaks"], ws2, diff2).dropped.length === 1,
  );
  check(
    "p2-038: nonexistent file with real-looking symbol hallucinated",
    verifyFindings(["- `ghost.ts:1` — `[request]` leaks"], ws2, diff2).dropped.length === 1,
  );
  check(
    "p2-038: file-path-shaped quotes are citations, not symbols",
    verifyFindings(["- `real.ts:2` conflicts with `apps/desktop/src/CommandPalette.tsx:3`"], ws2, diff2).kept.length === 1,
  );
  rmSync(ws2, { recursive: true, force: true });
}

// --- union symbol semantics + two-tier rule (P1-065) ---------------------------
{
  const ws = mkdtempSync(join(tmpdir(), "p1-065-"));
  mkdirSync(join(ws, "apps", "pilot", "src"), { recursive: true });
  // doctor.ts: DOCTOR_ID_RE lives at line 34, runDoctor further down — TASK_ID_RE nowhere.
  const doctorLines = Array.from({ length: 40 }, (_, i) => `// filler ${i + 1}`);
  doctorLines[33] = "export const DOCTOR_ID_RE = /P\\d+-\\d+:/;";
  doctorLines[39] = "export function runDoctor() { return DOCTOR_ID_RE.test(\"P1-065\"); }";
  writeFileSync(join(ws, "apps", "pilot", "src", "doctor.ts"), doctorLines.join("\n"));
  // pipeline.ts: TASK_ID_RE lives at line 589 — DOCTOR_ID_RE nowhere.
  const pipelineLines = Array.from({ length: 600 }, (_, i) => `// filler ${i + 1}`);
  pipelineLines[588] = "export const TASK_ID_RE = /P\\d+-\\d+:/;";
  writeFileSync(join(ws, "apps", "pilot", "src", "pipeline.ts"), pipelineLines.join("\n"));
  // unit.test.ts: no mention of runDoctor (the finding is about its absence).
  writeFileSync(join(ws, "apps", "pilot", "src", "unit.test.ts"), "// no coverage here\n");
  const diff = "";

  const out = [
    "- `apps/pilot/src/doctor.ts:34` and `apps/pilot/src/pipeline.ts:589` — `DOCTOR_ID_RE` and `TASK_ID_RE` disagree",
    "- `apps/pilot/src/unit.test.ts` has no coverage of `runDoctor` (defined in `apps/pilot/src/doctor.ts`)",
    "- `apps/pilot/src/doctor.ts:34` — `totallyFakeSymbol` is unused",
    "- `apps/pilot/src/ghost.ts:1` — anything",
  ].join("\n");
  const v = verifyFindings(parseFindings(out), ws, diff);
  check("p1-065: cross-file finding with symbols spread across citations KEPT", v.kept.length === 2);
  check("p1-065: cross-file repro (DOCTOR_ID_RE + TASK_ID_RE) kept verbatim", v.kept.some((f) => f.includes("DOCTOR_ID_RE") && f.includes("TASK_ID_RE")));
  check("p1-065: absence finding kept (symbol resolves via the union)", v.kept.some((f) => f.includes("runDoctor")));
  check("p1-065: nonexistent symbol dropped (0 union matches)", v.dropped.some((f) => f.includes("totallyFakeSymbol")));
  check("p1-065: nonexistent file dropped", v.dropped.some((f) => f.includes("ghost.ts")));
  check(
    "p1-065: tier-2 — one real >=6-char span keeps the finding even when the full set fails",
    verifyFindings(["- `apps/pilot/src/doctor.ts:34` — `DOCTOR_ID_RE` and `totallyFakeSymbol` disagree"], ws, diff).kept.length === 1,
  );
  check(
    "p1-065: short (<6 chars) quoted spans never trigger tier-2",
    verifyFindings(["- `apps/pilot/src/doctor.ts:34` — `fake` and `totallyFakeSymbol` disagree"], ws, diff).dropped.length === 1,
  );
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

  // P3-033 golden corpus: the matcher must keep accepting REAL gate outputs.
  // Samples live in apps/pilot/src/__fixtures__/gate-corpus/<cmd>/<seq>-<label>.txt
  // (label = commit-ish of the capture; cross-sample pairs are only compared
  // within the same label, since different commits legitimately diverge).
  {
    const corpus = loadGateCorpus();
    const byCmd = new Map<string, typeof corpus>();
    for (const s of corpus) {
      const list = byCmd.get(s.cmd) ?? [];
      list.push(s);
      byCmd.set(s.cmd, list);
    }
    check(
      "corpus: >= 3 samples for every evidence command",
      CORPUS_COMMANDS.every((c) => (byCmd.get(c)?.length ?? 0) >= 3),
    );
    let selfFail = 0,
      noiseFail = 0,
      truncFail = 0,
      fabFail = 0,
      crossFail = 0;
    for (const s of corpus) {
      if (!evidenceMatches(s.output, s.output)) selfFail++;
      // real terminal noise: ANSI coloring, extra spacing, blank lines
      const noisy = s.output
        .split("\n")
        .map((l, i) => (i % 3 === 0 ? `\x1b[2m${l}\x1b[0m   ` : i % 3 === 1 ? `  ${l} ` : l))
        .join("\n");
      if (!evidenceMatches(noisy, s.output)) noiseFail++;
      // subset semantics: an honest truncated paste must match the full re-run
      const half = s.output.split("\n").slice(0, Math.max(1, Math.floor(s.output.split("\n").length / 2))).join("\n");
      if (!evidenceMatches(half, s.output)) truncFail++;
      // anti-fabrication direction: a line with no source in the re-run fails.
      // Prepended so the assertion stays independent of the 600-line paste cap
      // (appended lines beyond the cap are legitimately sliced away).
      if (evidenceMatches(`FABRICATED-CORPUS-LINE-31337\n${s.output}`, s.output)) fabFail++;
      // normalization is idempotent — a line survives repeated normalization
      for (const l of s.output.split("\n")) {
        if (normalizeEvidenceLine(normalizeEvidenceLine(l)) !== normalizeEvidenceLine(l)) {
          selfFail++;
          break;
        }
      }
      // same-commit cross-pairs: an honest paste from run A must match the
      // re-run output of run B — this is where false positives live
      const peers = (byCmd.get(s.cmd) ?? []).filter((p) => p.label === s.label && p.file !== s.file);
      for (const p of peers) {
        if (!evidenceMatches(s.output, p.output)) {
          crossFail++;
          console.error(`corpus cross-pair fails: ${s.file} vs ${p.file}`);
        }
      }
    }
    if (selfFail + noiseFail + truncFail + fabFail + crossFail > 0) {
      console.error(`corpus failures: self=${selfFail} noise=${noiseFail} trunc=${truncFail} fab=${fabFail} cross=${crossFail}`);
    }
    check("corpus: every real sample matches itself (and stays idempotent)", selfFail === 0);
    check("corpus: ANSI/spacing noise on real outputs still matches", noiseFail === 0);
    check("corpus: truncated real paste still matches", truncFail === 0);
    check("corpus: fabricated line over real output still rejected", fabFail === 0);
    check("corpus: same-commit cross-pairs match both ways (no false positives)", crossFail === 0);
  }
  // the exact false-positive shapes the corpus was seeded from (P1-030 class)
  const ts1 = '{"ts":"2026-09-01T16:28:19.322Z","level":"info","msg":"daemon shutting down","data":{"signal":"SIGTERM","activeConnections":2,"uptimeS":65}}';
  const ts2 = '{"ts":"2026-09-02T16:28:34.484Z","level":"info","msg":"daemon shutting down","data":{"signal":"SIGTERM","activeConnections":2,"uptimeS":65}}';
  const tmpA = "[desktop] window-state unreadable (/var/folders/T/ocr-winstate-w9xFX1/window-state.json)";
  const tmpB = "[desktop] window-state unreadable (/var/folders/T/ocr-winstate-OR30AT/window-state.json)";
  check(
    "evidence: ISO stamps, pids and random tempdirs never diverge two green runs",
    evidenceMatches(ts1, ts2) && evidenceMatches(tmpA, tmpB),
  );

  // --- P3-033 gate-corpus module: sanitize, dedupe, capture ------------------
  {
    check("corpus: slug mirrors the command string", corpusSlug("npm run test:unit --silent") === "npm-run-test-unit-silent");
    const home = process.env.HOME ?? "/home/x";
    const dirty = `path ${home}/logs\n/Users/caio/x\n/home/joao/y\n aa1f0c2d3e4b5a6f7c8d9e0a1b2c3d4f tail`;
    const clean = sanitizeForCorpus(dirty, home);
    check("corpus: sanitizer masks home paths, user dirs and long hex", clean === "path ~/logs\n/Users/USER/x\n/home/USER/y\n HEX tail");
    check("corpus: sanitizer no-ops with an empty home", sanitizeForCorpus("a/b", "").includes("a/b"));
    const dir = mkdtempSync(join(tmpdir(), "p3-033-"));
    try {
      const first = appendCorpusSample(dir, "npm run typecheck --silent", "\n", "abc1234");
      const dedup = appendCorpusSample(dir, "npm run typecheck --silent", "\n", "abc1234");
      const second = appendCorpusSample(dir, "npm run typecheck --silent", "new output\n", "abc1234");
      check("corpus: append writes, dedupes identical, seqs new files", first === "npm-run-typecheck-silent/1-abc1234.txt" && dedup === null && second === "npm-run-typecheck-silent/2-abc1234.txt");

      // capture e2e: temp workspace + bare origin, same git flow as production
      execSync(`git init -q --bare "${join(dir, "origin.git")}"`);
      const ws = join(dir, "ws");
      execSync(`git init -q -b main "${ws}"`);
      writeFileSync(join(ws, "README.md"), "x\n");
      execSync(`git -C "${ws}" add README.md && git -C "${ws}" commit -qm init`);
      execSync(`git -C "${ws}" remote add origin "${join(dir, "origin.git")}" && git -C "${ws}" push -q -u origin main`);
      const reruns = new Map([
        [rerunKey("npm run typecheck --silent", ws), { ok: true, output: "" }],
        [rerunKey("npm run test:unit --silent", ws), { ok: true, output: "OK   a\n" }],
        [rerunKey("npm run build --silent", ws), { ok: true, output: "built in 1.2s\n" }],
      ]);
      const written = captureGateCorpus(ws, "P3-033", reruns);
      check("corpus: capture records the gate re-runs and pushes to main", written.length === 3);
      const pushed = execSync(`git -C "${ws}" ls-remote origin main`).toString().trim();
      const head = execSync(`git -C "${ws}" rev-parse main`).toString().trim();
      check("corpus: capture commit is on origin/main", pushed.includes(head));
      const again = captureGateCorpus(ws, "P3-033", reruns);
      check("corpus: identical re-capture dedupes away", again.length === 0);
      const hostileReruns = new Map([[rerunKey("npm run build --silent", ws), { ok: true, output: "hostile-id output\n" }]]);
      const hFiles = captureGateCorpus(ws, 'x" ; rm -rf /; echo "', hostileReruns);
      const subjects = execSync(`git -C "${ws}" log --format=%s -5 main`).toString();
      check(
        "corpus: hostile task id neutralized in the commit message",
        hFiles.length === 1 && subjects.includes("pilot(corpus): 1 gate sample(s) from unknown-task") && !subjects.includes("rm -rf"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- P1-044 (a): golden-corpus gate for pilot-infra tasks -------------------
  {
    check("corpus gate: the shipped corpus is green", corpusGateDetail() === null);
    const dir = mkdtempSync(join(tmpdir(), "p1-044-corpus-"));
    try {
      check("corpus gate: empty corpus fails closed", corpusGateDetail(dir)?.startsWith("golden corpus too thin") === true);
      appendCorpusSample(dir, "npm run typecheck --silent", "sample one\n", "abc1234");
      appendCorpusSample(dir, "npm run typecheck --silent", "sample two\n", "abc1234");
      appendCorpusSample(dir, "npm run typecheck --silent", "sample three\n", "abc1234");
      const thin = corpusGateDetail(dir);
      check(
        "corpus gate: <3 samples for ANY command rejects the gate",
        thin !== null && thin.includes("npm run test:unit --silent"),
      );
      // a tampered sample must be caught: the matcher must still reject a
      // fabricated line placed over the real output
      appendCorpusSample(dir, "npm run test:unit --silent", "OK 1\n", "abc1234");
      appendCorpusSample(dir, "npm run test:unit --silent", "OK 2\n", "abc1234");
      appendCorpusSample(dir, "npm run test:unit --silent", "OK 3\n", "abc1234");
      appendCorpusSample(dir, "npm run build --silent", "built\n", "abc1234");
      appendCorpusSample(dir, "npm run build --silent", "built 2\n", "abc1234");
      appendCorpusSample(dir, "npm run build --silent", "built 3\n", "abc1234");
      check("corpus gate: 3 samples per command is green", corpusGateDetail(dir) === null);
      // the matcher itself must still reject a fabricated line over a real
      // sample — the gate's fabrication probe composes exactly this predicate
      // (prepended: lines beyond the 600-line paste cap are sliced away)
      const real = "OK   scripts/a.test.ts\nOK   scripts/b.test.ts\n";
      check(
        "corpus gate: fabrication probe matches the matcher's rejection rule",
        evidenceMatches(`FABRICATED-CORPUS-PROBE-LINE\n${real}`, real) === false && evidenceMatches(real, real) === true,
      );
      // the tamper branches themselves, driven via the injectable matcher
      check(
        "corpus gate: a permissive matcher regression is caught (fabricated line accepted)",
        corpusGateDetail(dir, () => true)?.includes("accepts a fabricated line") === true,
      );
      check(
        "corpus gate: a rejecting matcher regression is caught (self-match fails)",
        corpusGateDetail(dir, () => false)?.includes("no longer matches itself") === true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

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
  const wsSilent = mkdtempSync(join(tmpdir(), "p2-009-silent-"));
  writeFileSync(wsSilent + "/package.json", JSON.stringify({ name: "p2-009s", scripts: { typecheck: "node -e ''", "test:unit": "node -e ''" } }));
  const pasteVerbose = `EVIDENCE:\n$ npm run typecheck --silent\n0 errors\n$ npm run test:unit --silent\nUNIT TESTS PASSED\nPILOT:TASK-DONE`;
  check("evidence: verbose paste over silent successful re-run accepted", verifyEvidence(wsSilent, pasteVerbose, false).ok === true);
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

// --- P2-040: shared preflight ⇄ gate re-run cache ----------------------------
{
  // pure cache semantics: same (command, workspace) executes once
  const calls: string[] = [];
  const run = (cmd: string, cwd: string) => {
    calls.push(`${cmd}@${cwd}`);
    return { ok: true, output: `out-of-${cmd}` };
  };
  const cache: RerunResults = new Map();
  const wsA = "/ws/slot-1";
  const pre = cachedExec(cache, "npm run typecheck --silent", wsA, { timeoutMin: 10 }, run);
  const viaEvidence = cachedExec(cache, "npm run typecheck --silent", wsA, { timeoutMin: 20 }, run);
  const viaStep = cachedExec(cache, "npm run typecheck --silent", wsA, { timeoutMin: 20 }, run);
  check("rerun cache: preflight + evidence re-run + gate step share ONE execution", calls.length === 1 && pre === viaEvidence && viaEvidence === viaStep);
  cachedExec(cache, "npm run typecheck --silent", "/ws/slot-2", {}, run);
  check("rerun cache: same command in another slot workspace runs again", calls.length === 2 && calls[1] === `npm run typecheck --silent@/ws/slot-2`);
  cachedExec(cache, "npm run build --silent", wsA, {}, run);
  check("rerun cache: other command in the same workspace runs again", calls.length === 3 && calls[2]!.startsWith("npm run build"));
  check("rerun key: workspace and command are not aliased into one key", rerunKey("a", "b") !== rerunKey("a", "c") && rerunKey("a", "b") !== rerunKey("b", "b"));
  // a failed result caches too — same code, deterministic failure, no re-roll
  const failCache: RerunResults = new Map();
  let failRuns = 0;
  const failRun = () => {
    failRuns++;
    return { ok: false, output: "error TS9999" };
  };
  const f1 = cachedExec(failCache, "npm run typecheck --silent", wsA, {}, failRun);
  const f2 = cachedExec(failCache, "npm run typecheck --silent", wsA, {}, failRun);
  check("rerun cache: failure is cached — no second execution either", failRuns === 1 && !f1.ok && f2 === f1);

  // full round simulation: preflight populates the round's shared map, the
  // gate (verifyEvidence re-run + step battery) reuses it — each command runs
  // exactly 1x per round, not 3x.
  const ws = mkdtempSync(join(tmpdir(), "p2-040-"));
  writeFileSync(ws + "/package.json", JSON.stringify({ name: "p2-040", scripts: { typecheck: "echo TS-OK", "test:unit": "echo UNIT-OK" } }));
  const counts = new Map<string, number>();
  const roundCache: RerunResults = new Map();
  const roundRun = (cmd: string, cwd: string) =>
    cachedExec(roundCache, cmd, cwd, {}, (c) => {
      counts.set(c, (counts.get(c) ?? 0) + 1);
      return { ok: true, output: c.includes("typecheck") ? "TS-OK" : "UNIT-OK" };
    });
  // preflight (round loop) runs first and populates the shared map
  roundRun("npm run typecheck --silent", ws);
  // gate: verifyEvidence re-runs the cited commands through the same cache
  const block = `EVIDENCE:\n$ npm run typecheck --silent\nTS-OK\n$ npm run test:unit --silent\nUNIT-OK\nPILOT:TASK-DONE`;
  const ev = verifyEvidence(ws, block, false, 0, roundRun);
  // gate step battery reads the same canonical command strings from the cache
  roundRun("npm run typecheck --silent", ws);
  roundRun("npm run test:unit --silent", ws);
  check(
    "rerun cache: full round — typecheck executes 1x per round, not 3x (P2-040)",
    ev.ok === true && counts.get("npm run typecheck --silent") === 1 && counts.get("npm run test:unit --silent") === 1,
  );
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

// --- P2-013 cheap resumption: id capture + resume prompt ----------------------
{
  const RESUME_TASK: Task = { id: "P2-013", priority: "P2", title: "Cheap resumption", spec: "", area: "infra", line: "" };
  const CANNED = [
    "[LOG] builder session ses_1a2B3c4D5e6F7g8h9i0JkL started",
    "subagent tool call failed: task_A1b2C3d4E5f6 is resumable (opencode >=1.18.20)",
    "a second failure surfaced task_Zz9Yy8Xx7Ww6 as well",
    "done",
  ].join("\n");

  const ids = scanIds(CANNED);
  check("resume: canned output extracts the ses_ id", ids.sessionId === "ses_1a2B3c4D5e6F7g8h9i0JkL");
  check(
    "resume: canned output extracts task_ ids in order",
    JSON.stringify(ids.taskIds) === JSON.stringify(["task_A1b2C3d4E5f6", "task_Zz9Yy8Xx7Ww6"]),
  );
  const none = scanIds("all good here, nothing to resume");
  check("resume: plain output yields no ids", none.sessionId === undefined && none.taskIds.length === 0);

  // round-3: prose echoing docs through stdout must not become "resumable work"
  const prose = scanIds("the task_id is resumable; see task_ids and mytask_abc and my_task_abc too");
  check(
    "resume: prose tokens task_id/task_ids/glued words are not captured",
    prose.sessionId === undefined && prose.taskIds.length === 0,
  );
  const mixed = scanIds("echoed task_id prose next to a real failed task_A1b2C3d4E5f6 here");
  check(
    "resume: prose tokens do not evict or distort real ids",
    JSON.stringify(mixed.taskIds) === JSON.stringify(["task_A1b2C3d4E5f6"]),
  );

  // P2-028: session ids now feed DB cost lookups — the capture must stay
  // anchored so glued prose ("my_ses_…", "abcses_…") never reaches the query
  const gluedSes = scanIds("prefix my_ses_abc123def456 suffix abcses_abc123def456x end");
  check("resume: glued ses_ prose is not captured", gluedSes.sessionId === undefined);
  const anchored = scanIds("word ses_abc123def456x more");
  check("resume: a real anchored ses_ id still captures", anchored.sessionId === "ses_abc123def456x");

  // streaming: an id split across two stdout chunks is captured whole via the
  // tail buffer; a match still growing at the chunk edge waits for flush()
  const scanner = idScanner();
  const r1 = scanner.scan("failed subagent task_");
  check("resume: split task id not committed while incomplete", r1.taskIds.length === 0);
  const r2 = scanner.scan("Ab12Cd3E4 done; ses_9");
  check("resume: split task id completed by the tail buffer", r2.taskIds.includes("task_Ab12Cd3E4"));
  check("resume: session id stays pending while its match ends at the chunk edge", r2.sessionId === undefined);
  const r3 = scanner.scan("8z7Yy6 end");
  check("resume: split session id completed on the next chunk", r3.sessionId === "ses_98z7Yy6");

  const dup = idScanner();
  dup.scan("task_R1R2R3R4 registered; ");
  const dup2 = dup.scan("the tail repeats task_R1R2R3R4 verbatim");
  check("resume: duplicate task ids collapse to one", dup2.taskIds.filter((t) => t === "task_R1R2R3R4").length === 1);

  const RESUME_IDS = { sessionId: "ses_1a2B3c4D5e6F7g8h9i0JkL", taskIds: ["task_A1b2C3d4E5f6", "task_Zz9Yy8Xx7Ww6"] };
  const block = resumeBlock(RESUME_IDS);
  check(
    "resume: block carries session + task ids and the continue instruction",
    block.includes("ses_1a2B3c4D5e6F7g8h9i0JkL") &&
      block.includes("task_A1b2C3d4E5f6") &&
      block.includes("task_Zz9Yy8Xx7Ww6") &&
      block.includes("CONTINUE from it"),
  );
  check("resume: no ids -> empty block", resumeBlock({ taskIds: [] }) === "" && resumeBlock(null) === "");
  check(
    "resume: task id list is capped",
    resumeBlock({ sessionId: "ses_x", taskIds: Array.from({ length: RESUME_MAX_TASK_IDS + 4 }, (_, i) => `task_${i}`) }).split("\n")
      .some((l) => l.startsWith(`- Resumable`) && l.split("task_").length - 1 === RESUME_MAX_TASK_IDS),
  );

  const round2 = builderPrompt(RESUME_TASK, 2, "", [], null, RESUME_IDS);
  check(
    "resume: round N+1 prompt contains the captured session + task ids",
    round2.includes("ses_1a2B3c4D5e6F7g8h9i0JkL") &&
      round2.includes("task_A1b2C3d4E5f6") &&
      round2.includes("task_Zz9Yy8Xx7Ww6"),
  );
  check(
    "resume: round 1 prompt without ids has no resume block",
    !builderPrompt(RESUME_TASK, 1, "", [], null, { taskIds: [] }).includes("RESUME PARTIAL WORK"),
  );
  check(
    "resume: prompt keeps the mandatory evidence block intact",
    round2.includes("EVIDENCE:") && round2.includes("PILOT:TASK-DONE"),
  );

  // round-2 fixes: resume state transition + crash decision, pure and pinned
  const st1 = updateResumeState(null, true, { sessionId: "ses_aaa", taskIds: ["task_1"] });
  check(
    "resume: failed round opens resume state with its ids",
    st1?.sessionId === "ses_aaa" && JSON.stringify(st1.taskIds) === JSON.stringify(["task_1"]),
  );
  const st2 = updateResumeState(st1, true, { sessionId: "ses_bbb", taskIds: ["task_1", "task_2"] });
  check(
    "resume: a later failed round dedupes ids and tracks the latest session",
    st2?.sessionId === "ses_bbb" && JSON.stringify(st2.taskIds) === JSON.stringify(["task_1", "task_2"]),
  );
  check(
    "resume: successful round resets resume state (no false crash claim on review-fix rounds)",
    updateResumeState(st2, false, { sessionId: "ses_bbb", taskIds: ["task_9"] }) === null,
  );
  const flooded = updateResumeState(st1, true, {
    sessionId: "ses_ccc",
    taskIds: Array.from({ length: RESUME_MAX_TASK_IDS + 4 }, (_, i) => `task_new${i}`),
  });
  check(
    "resume: state cap keeps the FIRST ids (later garbage cannot evict real ones)",
    flooded !== null &&
      flooded.taskIds.length === RESUME_MAX_TASK_IDS &&
      flooded.taskIds[0] === "task_1" &&
      flooded.taskIds[1] === "task_new0" &&
      !flooded.taskIds.includes("task_new9"),
  );

  // round-3: the failure notice is part of the resume block, named by round
  check(
    "resume: block names the failed round",
    resumeBlock({ sessionId: "ses_a", taskIds: ["task_1"] }, 2).includes("round 2 failed mid-work (crash or timeout)") &&
      resumeBlock({ sessionId: "ses_a", taskIds: ["task_1"] }).includes("the previous round on this task failed"),
  );
  const prompt3 = builderPrompt(RESUME_TASK, 3, "finding A", [], null, RESUME_IDS);
  check(
    "resume: block sits before (not under) the reviewer findings header",
    prompt3.indexOf("RESUME PARTIAL WORK") < prompt3.indexOf("REVIEWER FINDINGS TO ADDRESS") &&
      prompt3.includes("round 2 failed mid-work"),
  );

  const m = mergeAgentIds({ sessionId: undefined, taskIds: ["task_1"] }, { sessionId: "ses_a", taskIds: ["task_1", "task_2"] });
  check(
    "resume: per-stream scans merge without duplicate ids",
    m.sessionId === "ses_a" && JSON.stringify(m.taskIds) === JSON.stringify(["task_1", "task_2"]),
  );
  check(
    "resume: merge prefers the stdout session when both streams saw one",
    mergeAgentIds({ sessionId: "ses_x", taskIds: [] }, { sessionId: "ses_y", taskIds: [] }).sessionId === "ses_x",
  );

  const retry = crashRoundDecision(1, 3);
  check(
    "resume: crash on a non-final round retries (failure notice lives in the block, not findings)",
    retry.retry === true && retry.detail === "",
  );
  check("resume: crash retry boundary is round < maxRounds", crashRoundDecision(2, 3).retry === true);
  const abort = crashRoundDecision(3, 3);
  check(
    "resume: crash on the final round aborts with the pre-spike detail",
    abort.retry === false && abort.detail === "builder did not finish (round 3)",
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
    // P2-058: the sha guard runs before the disk probe — inject the verified
    // list so this test still exercises the disk-guard path specifically
    verifiedMerges: [{ sha: "1234567890abcdef1234567890abcdef12345678", task: "P3-006", at: "t" }],
    quarantine: [],
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

// --- P1-044 autocatalysis lane: reinforced soak for apps/pilot/** deploys ----
{
  check("soak lane: regular deploy keeps the configured window", soakMinutesFor(10, false) === 10 && soakMinutesFor(3, false) === 3);
  check("soak lane: pilot-infra deploy doubles the window (10 → 20)", soakMinutesFor(10, true) === 20);
  check("soak lane: the lane never soaks less than 20min", soakMinutesFor(5, true) === 20 && soakMinutesFor(15, true) === 30);

  check("baseline: no samples → rate 0", baselineFailureRate([]) === 0);
  check("baseline: 1 failing probe of 3 → 1/3", Math.abs(baselineFailureRate([true, false, true]) - 1 / 3) < 1e-9);

  const w = (fails: number, total = SOAK_WINDOW) => [...Array(total - fails).fill(true), ...Array(fails).fill(false)];
  check("soak rate: window below SOAK_WINDOW never trips", soakFailureRateExceeded([false, false, false], 0) === false);
  check("soak rate: clean window on clean baseline continues", soakFailureRateExceeded(w(0), 0) === false);
  check("soak rate: 1/5 failures on clean baseline is inside tolerance", soakFailureRateExceeded(w(1), 0) === false);
  check("soak rate: 2/5 failures on clean baseline rolls back", soakFailureRateExceeded(w(2), 0) === true);
  check(
    "soak rate: a flaky baseline (1/3 failing) absorbs an equal window",
    soakFailureRateExceeded(w(2), baselineFailureRate([true, false, true])) === false,
  );
  check("soak rate: degradation beyond a flaky baseline rolls back", soakFailureRateExceeded(w(3), baselineFailureRate([true, false, true])) === true);
  check("soak rate: tolerance constant pins the 20% margin", SOAK_RATE_TOLERANCE === 0.2 && SOAK_WINDOW === 5);
  check("soak lane: baseline is 3 probes; extra live invariants every 5 checks", BASELINE_SAMPLES === 3 && LIVE_INVARIANT_EVERY === 5);
}

// --- P1-044 round 2: soak-loop wiring (baseline, window, scheduling, rollback) ---
{
  const noSleep = () => Promise.resolve();
  const events: Array<{ phase: string; ok: boolean; detail?: string }> = [];
  const base = { heartbeat: () => {}, sleep: noSleep, onEvent: (e: { phase: string; ok: boolean; detail?: string }) => events.push(e) };

  // baseline sampling: 3 probes, rate from the failures
  const probeSeq = [false, true, true];
  let p = 0;
  const rate = await baselineHealthRate(async () => probeSeq[p++] ?? true, 3, noSleep);
  check("soak lane: baseline rate is the failing fraction of the sampled probes", Math.abs(rate - 1 / 3) < 1e-9 && p === 3);

  // full green lane run: 20 checks (20min), live invariants exactly at 5/10/15/20
  let liveRuns = 0;
  events.length = 0;
  const okRun = await soakWatch({
    ...base,
    checks: 20,
    pilotInfra: true,
    baselineRate: 0,
    probe: async () => true,
    live: () => {
      liveRuns++;
      return { ok: true, output: "" };
    },
  });
  check(
    "soak lane: green 20-check run schedules live invariants exactly at 5/10/15/20",
    okRun.outcome === "ok" && okRun.at === 20 && liveRuns === 4 && events.some((e) => e.phase === "live-invariants 5/20" && e.ok === true),
  );
  check("soak lane: every check emits a soak event through the injectable sink", events.filter((e) => e.phase.startsWith("soak ")).length === 20);

  // rate rollback: 2 failures fill 2/5 of the first full window (check 5) — the
  // live run at check 5 happens first and must not mask the rate trip
  const seq = [true, true, true, false, false];
  let idx = 0;
  const rateRun = await soakWatch({
    ...base,
    checks: 20,
    pilotInfra: true,
    baselineRate: 0,
    probe: async () => seq[idx++ % seq.length]!,
    live: () => ({ ok: true, output: "" }),
  });
  check(
    "soak lane: 2/5 failing window trips the rate rollback at check 5 (live ran first)",
    rateRun.outcome === "rate" && rateRun.at === 5 && rateRun.why.includes("2/5") && rateRun.why.includes("baseline 0.00"),
  );

  // health rollback: 3 consecutive failures, before live/rate logic applies
  const healthRun = await soakWatch({
    ...base,
    checks: 10,
    pilotInfra: true,
    baselineRate: 0,
    probe: async () => false,
    live: () => ({ ok: true, output: "" }),
  });
  check("soak lane: 3 consecutive failures roll back as health at check 3", healthRun.outcome === "health" && healthRun.at === 3);

  // live rollback: failed extra invariant stops the loop with the output tail
  let liveCalls = 0;
  const liveRun = await soakWatch({
    ...base,
    checks: 10,
    pilotInfra: true,
    baselineRate: 0,
    probe: async () => true,
    live: () => {
      liveCalls++;
      return { ok: false, output: "ERR boom" };
    },
  });
  check(
    "soak lane: failed live invariant rolls back at its check with the output tail",
    liveRun.outcome === "live" && liveRun.at === 5 && liveRun.why.includes("ERR boom") && liveCalls === 1,
  );

  // non-lane deploy: no live runs, no rate rollback (only 3-consecutive applies)
  const pat = [true, true, false, true, false, true, true, false, true, true];
  let j = 0;
  let laneLiveCalls = 0;
  const plainRun = await soakWatch({
    ...base,
    checks: 10,
    pilotInfra: false,
    baselineRate: 0,
    probe: async () => pat[j++ % pat.length]!,
    live: () => {
      laneLiveCalls++;
      return { ok: true, output: "" };
    },
  });
  check(
    "soak lane: regular deploy never runs live invariants nor the rate rule",
    plainRun.outcome === "ok" && laneLiveCalls === 0,
  );
}

// --- P2-058 deploy sha guard: only gate-verified merges deploy ----------------
{
  const vm = (sha: string) => ({ sha, task: "P2-058", at: "t" });
  const q = (sha: string) => ({ sha, task: "P2-058", at: "t", why: "soak failed" });
  const OLD = "1111111111111111111111111111111111111111";
  const GOOD = "2222222222222222222222222222222222222222";
  const BAD = "3333333333333333333333333333333333333333";
  const NOISE = "4444444444444444444444444444444444444444";
  const history = [NOISE, BAD, GOOD, OLD]; // newest-first first-parent

  check(
    "deploy guard: walks past unverified bookkeeping commits to the newest verified merge",
    pickDeployableSha(history, [vm(GOOD)], []) === GOOD,
  );
  check(
    "deploy guard: newest verified sha wins",
    pickDeployableSha(history, [vm(OLD), vm(GOOD), vm(BAD)], []) === BAD,
  );
  check(
    "deploy guard: quarantined sha skipped — walk falls back to the last good verified sha",
    pickDeployableSha(history, [vm(GOOD), vm(BAD)], [q(BAD)]) === GOOD,
  );
  check(
    "deploy guard: nothing verified → null (a direct push to main never deploys)",
    pickDeployableSha([NOISE], [vm(GOOD)], []) === null && pickDeployableSha([], [vm(GOOD)], []) === null,
  );
  check(
    "deploy guard: walk capped at MAX_WALK_COMMITS (fail-closed on both sides)",
    pickDeployableSha([...Array(MAX_WALK_COMMITS).fill(NOISE), GOOD], [vm(GOOD)], []) === null &&
      pickDeployableSha([...Array(MAX_WALK_COMMITS - 1).fill(NOISE), GOOD], [vm(GOOD)], []) === GOOD,
  );
  check(
    "deploy guard: non-object-id lines are never selected",
    pickDeployableSha(["; rm -rf /", GOOD], [vm(GOOD)], []) === GOOD,
  );

  check("deploy guard: unverified sha refused", shaGuardDetail(NOISE, [vm(GOOD)], []) === "sha not gate-verified — deploy refused");
  check("deploy guard: verified-but-quarantined sha refused", shaGuardDetail(BAD, [vm(BAD)], [q(BAD)]) === "sha quarantined after a failed deploy — deploy refused");
  check("deploy guard: verified non-quarantined sha passes", shaGuardDetail(GOOD, [vm(GOOD)], [q(BAD)]) === null);
  check("deploy guard: unverifiable sha charset refused", shaGuardDetail("../../main", [], []) === "unverifiable sha — deploy refused");

  check(
    "deploy guard: tolerant parse — corrupt lines and invalid shas skipped",
    JSON.stringify(parseVerifiedMerges(`not json\n{"sha":"2222222"}\n{"sha":"${GOOD}","task":"T","at":"t"}\n`)) ===
      JSON.stringify([{ sha: "2222222", task: "", at: "" }, { sha: GOOD, task: "T", at: "t" }]) &&
      parseQuarantine("garbage\n").length === 0,
  );

  const dir = mkdtempSync(join(tmpdir(), "ocr-deployguard-"));
  const vf = join(dir, "verified-merges.jsonl");
  const qf = join(dir, "quarantine.jsonl");
  check(
    "deploy guard: recordVerifiedMerge persists + dedupes per sha",
    recordVerifiedMerge(vf, GOOD, "P2-058", "t") &&
      recordVerifiedMerge(vf, GOOD, "P2-058", "t") &&
      readVerifiedMerges(vf).length === 1 &&
      readVerifiedMerges(vf)[0]!.sha === GOOD,
  );
  check("deploy guard: recordVerifiedMerge rejects an invalid sha", recordVerifiedMerge(vf, "nope", "P2-058", "t") === false);
  check(
    "deploy guard: quarantineSha persists + dedupes per sha",
    quarantineSha(qf, BAD, "soak failed", "P2-058", "t") &&
      quarantineSha(qf, BAD, "soak failed", "P2-058", "t") &&
      readQuarantine(qf).length === 1 &&
      readQuarantine(qf)[0]!.why === "soak failed",
  );
  for (let i = 1; i <= MAX_VERIFIED_ENTRIES + 10; i++) {
    recordVerifiedMerge(vf, i.toString(16).padStart(7, "0"), "T", "t");
  }
  check(
    "deploy guard: verified list capped at MAX_VERIFIED_ENTRIES",
    readVerifiedMerges(vf).length === MAX_VERIFIED_ENTRIES,
  );
  for (let i = 1; i <= MAX_QUARANTINE_ENTRIES + 10; i++) {
    quarantineSha(qf, i.toString(16).padStart(7, "0"), "why", "T", "t");
  }
  check(
    "deploy guard: quarantine list capped at MAX_QUARANTINE_ENTRIES",
    readQuarantine(qf).length === MAX_QUARANTINE_ENTRIES,
  );
  rmSync(dir, { recursive: true, force: true });

  // deploy() itself must refuse before touching git/npm — a bare tmpdir repo
  // would make the first git exec throw if the guard were not first
  const cfgGuard: PilotConfig = {
    repo: join(tmpdir(), "ocr-guard-bare-does-not-exist"),
    workspace: join(tmpdir(), "ocr-guard-bare-does-not-exist"),
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
  const refused = await deploy(cfgGuard, NOISE, { task: "P2-058" }, { verifiedMerges: [vm(GOOD)], quarantine: [] });
  check(
    "deploy guard: unverified sha refused before any git step",
    refused.ok === false && refused.rolledBack === false && refused.detail.startsWith("sha not gate-verified"),
  );
  const banned = await deploy(cfgGuard, BAD, { task: "P2-058" }, { verifiedMerges: [vm(BAD)], quarantine: [q(BAD)] });
  check(
    "deploy guard: quarantined sha refused before any git step",
    banned.ok === false && banned.rolledBack === false && banned.detail.startsWith("sha quarantined"),
  );
}

// --- P1-021 fast install: skip npm ci when the lockfile is unchanged ----------
{
  const h = "a".repeat(64);
  const h2 = "b".repeat(64);
  check("fast install: identical persisted hash → fast", installModeFor(h, { sha256: h, at: "t" }) === "fast");
  check("fast install: different persisted hash → ci", installModeFor(h2, { sha256: h, at: "t" }) === "ci");
  check("fast install: no persisted state → ci (fail-closed)", installModeFor(h, null) === "ci");
  check("fast install: empty/unusable current hash → ci", installModeFor("", { sha256: h, at: "t" }) === "ci" && installModeFor("nope", null) === "ci");
  check("fast install: LOCK_HASH_RE pins full sha256 hex", LOCK_HASH_RE.test(h) === true && LOCK_HASH_RE.test(h.slice(0, 63)) === false && LOCK_HASH_RE.test("A".repeat(64)) === false);

  const dir = mkdtempSync(join(tmpdir(), "ocr-last-install-"));
  const lf = join(dir, "last-install.json");
  check("fast install: readLastInstall on a missing file → null", readLastInstall(lf) === null);
  check(
    "fast install: writeLastInstall/readLastInstall roundtrip",
    writeLastInstall(lf, h, "2026-09-02T00:00:00-03:00") && readLastInstall(lf)?.sha256 === h && readLastInstall(lf)?.at === "2026-09-02T00:00:00-03:00",
  );
  writeFileSync(lf, "{corrupt json");
  check("fast install: corrupt json → null", readLastInstall(lf) === null);
  writeFileSync(lf, JSON.stringify({ sha256: "z".repeat(64), at: "t" }));
  check("fast install: non-hex hash → null", readLastInstall(lf) === null);
  writeFileSync(lf, JSON.stringify({ sha256: h.slice(1), at: "t" }));
  check("fast install: truncated hash → null", readLastInstall(lf) === null);
  check("fast install: writeLastInstall rejects an invalid hash", writeLastInstall(lf, "nope", "t") === false && readLastInstall(lf) === null);
  rmSync(dir, { recursive: true, force: true });

  check(
    "fast install: FAST_INSTALL_CMD is an offline no-wipe install with scripts ignored",
    FAST_INSTALL_CMD.includes("npm install --prefer-offline --no-audit --no-fund --ignore-scripts") &&
      FAST_INSTALL_CMD.startsWith('ELECTRON_CACHE="$HOME/.cache/electron"') &&
      !FAST_INSTALL_CMD.includes("npm ci"),
  );
  // P1-021 acceptance: `npm ci` appears ONLY in the changed-lock path (npmInstall,
  // both attempts) and in the rollback — never on the fast path.
  const deploySrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "deploy.ts"), "utf8");
  check(
    "fast install: ELECTRON_CACHE + --ignore-scripts pinned on both npm ci attempts",
    deploySrc.includes('ELECTRON_CACHE="$HOME/.cache/electron" npm ci --no-audit --no-fund --ignore-scripts --loglevel=error'),
  );
  check(
    "fast install: rollback npm ci also uses the electron cache + --ignore-scripts",
    deploySrc.includes('ELECTRON_CACHE="$HOME/.cache/electron" npm ci --silent --ignore-scripts'),
  );
  check(
    "fast install: deploy emits an install event with mode + duration",
    deploySrc.includes('phase: "install"') && deploySrc.includes("fast-install (lock unchanged) in") && deploySrc.includes("npm ci in"),
  );
}

// --- P2-041: post-rollback health verification --------------------------------
{
  const events: Array<{ phase?: string; ok?: boolean; detail?: string }> = [];
  const notified: Array<{ task: string; ok: boolean; detail: string }> = [];
  const notify = async (task: string, ok: boolean, detail: string) => {
    notified.push({ task, ok, detail });
    return true;
  };
  // cfg only feeds the default probe (overridden in every hook below)
  const cfgRoll: PilotConfig = {
    repo: join(tmpdir(), "ocr-rollback-health-unused"),
    workspace: "unused",
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
  const hooksFor = (probe: () => Promise<boolean>, windowSec = 10) => ({
    task: "P2-041",
    probe,
    onEvent: (e: { phase: string; ok: boolean; detail?: string }) => events.push(e),
    notify,
    sleep: () => Promise.resolve(),
    windowSec,
  });

  check("rollback health: window is 30s at the shared 5s probe cadence", ROLLBACK_HEALTH_WINDOW_SEC === 30);

  // healthy prod: the first probe passes — no retries, ok event, no escalation
  let probes = 0;
  events.length = 0;
  notified.length = 0;
  const okRun = await verifyRollbackHealth(cfgRoll, hooksFor(async () => {
    probes++;
    return true;
  }));
  check(
    "rollback health: healthy prod verifies immediately with an ok rollback-health event",
    okRun === true && probes === 1 && events.length === 1 &&
      events[0]!.phase === "rollback-health" && events[0]!.ok === true && notified.length === 0,
  );

  // flappy start: two failing probes then recovery inside the window
  const seq = [false, false, true];
  let idx = 0;
  events.length = 0;
  const retryRun = await verifyRollbackHealth(cfgRoll, hooksFor(async () => seq[idx++] ?? true));
  check(
    "rollback health: prod recovering inside the window still verifies ok",
    retryRun === true && idx === 3 && events[0]!.ok === true,
  );

  // unhealthy: window exhausted → ok=false event + supervisor escalation
  let fails = 0;
  events.length = 0;
  notified.length = 0;
  const badRun = await verifyRollbackHealth(cfgRoll, hooksFor(async () => {
    fails++;
    return false;
  }, 10));
  check(
    "rollback health: unhealthy prod after rollback emits ok=false and escalates",
    badRun === false && fails === 3 && events[0]!.ok === false &&
      notified.length === 1 && notified[0]!.task === "P2-041" && notified[0]!.ok === false &&
      notified[0]!.detail.includes("UNHEALTHY"),
  );

  // pure aggregation behind the dashboard chip: newest verdict wins
  const ev = (phase: string, ok: boolean): PilotEvent => ({ ts: "t", type: "deploy", phase, ok });
  check(
    "rollback health: latest unhealthy verdict lights the dashboard chip",
    rollbackHealthAlert([ev("start", true), ev("rollback", false), ev("rollback-health", false)]) !== null,
  );
  check(
    "rollback health: a healthy verdict clears the chip",
    rollbackHealthAlert([ev("rollback", false), ev("rollback-health", false), ev("rollback-health", true)]) === null,
  );
  check(
    "rollback health: a later clean deploy supersedes an old alert",
    rollbackHealthAlert([ev("rollback-health", false), ev("start", true), ev("done", true)]) === null,
  );
  check("rollback health: feed without verdicts never fakes an alert", rollbackHealthAlert([]) === null);

  // wiring pin: rollback() must end in the health watch — the blind sleep is gone
  const deploySrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "deploy.ts"), "utf8");
  check(
    "rollback health: rollback() wires verifyRollbackHealth (no blind sleep)",
    deploySrc.includes("await verifyRollbackHealth(cfg, hooks)") && !deploySrc.includes("sleep(15_000)"),
  );
}

// --- P1-034: self-reload whenever HEAD moved (stale-brain incident) ----------
{
  const A = "a".padEnd(40, "1");
  const B = "b".padEnd(40, "2");
  // the function receives no diff at all: a distinct id pair reloads even when
  // the apps/pilot diff would be empty — the stale-incident root cause
  check("P1-034: HEAD moved → reload", shouldSelfReload(A, B) === true);
  check("P1-034: same sha → no reload", shouldSelfReload(A, A) === false);
  check(
    "P1-034: invalid ids → no reload",
    shouldSelfReload("", B) === false && shouldSelfReload("nope", B) === false && shouldSelfReload(A, "") === false,
  );
  // regression pin: the broken sha-vs-HEAD diff that always came back empty
  // must stay out of deploy.ts
  const deploySrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "deploy.ts"), "utf8");
  check("P1-034: sha-vs-HEAD self-reload diff removed", !deploySrc.includes("git diff --name-only ${sha} HEAD"));
}

// --- P2-058 round 2: quarantine-write escalation + merge-identity validation --
{
  const dir = mkdtempSync(join(tmpdir(), "ocr-qesc-"));
  const qf = join(dir, "q.jsonl");
  const calls: Array<{ task: string; ok: boolean; detail: string }> = [];
  const notify = async (task: string, ok: boolean, detail: string) => {
    calls.push({ task, ok, detail });
    return true;
  };
  const GOOD = "2222222222222222222222222222222222222222";
  const recorded = await quarantineWithEscalation(qf, GOOD, "soak failed", "P2-058", notify);
  check(
    "quarantine escalation: successful write stays silent",
    recorded === true && calls.length === 0 && readQuarantine(qf).length === 1,
  );
  const rejected = await quarantineWithEscalation(qf, "not-a-sha", "why", "P2-058", notify);
  check(
    "quarantine escalation: write failure notifies the supervisor",
    rejected === false &&
      calls.length === 1 &&
      calls[0]!.task === "P2-058" &&
      calls[0]!.ok === false &&
      calls[0]!.detail.includes("quarantine write failed"),
  );
  check("quarantine escalation: failed write leaves no file entry", readQuarantine(qf).length === 1);
  const throwing = async (): Promise<boolean> => {
    throw new Error("net down");
  };
  let escalated = false;
  try {
    await quarantineWithEscalation(qf, "zz", "why", "T", throwing);
  } catch {
    escalated = true;
  }
  check("quarantine escalation: notify crash is best-effort, never rejects", escalated === false);
  rmSync(dir, { recursive: true, force: true });
}

{
  const repo = mkdtempSync(join(tmpdir(), "ocr-mergeid-"));
  const g = (c: string) => execSync(c, { cwd: repo, stdio: "pipe" });
  const shaOf = () => execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  g("git init -q -b main .");
  g("git config user.email t@t.local");
  g("git config user.name tester");
  g("git commit -q --allow-empty -m base");
  g("git checkout -qb pilot/T1");
  g("git commit -q --allow-empty -m 'pilot(T1): feature work'");
  g("git checkout -q main");
  // PR squash shape: canonical subject (GitHub may append the PR number)
  g("git commit -q --allow-empty -m 'pilot(T1): feature work (#62)'");
  const squashSha = shaOf();
  g("git commit -q --allow-empty -m 'bookkeeping between tasks'");
  const bookkeepingSha = shaOf();
  // local --no-ff fallback shape
  g("git merge -q --no-ff --no-edit pilot/T1");
  const fallbackMergeSha = shaOf();
  g("git commit -q --allow-empty -m 'pilot(T9): other task'");
  const otherTaskSha = shaOf();
  g("git commit -q --allow-empty -m 'pilot(T1-9): id-prefix confusion'");
  const prefixTrapSha = shaOf();

  check("merge identity: squash commit subject matches the task", isTaskMergeSha(repo, squashSha, "T1") === true);
  check("merge identity: --no-ff fallback merge commit matches the task", isTaskMergeSha(repo, fallbackMergeSha, "T1") === true);
  check("merge identity: bookkeeping commit is never a verified merge", isTaskMergeSha(repo, bookkeepingSha, "T1") === false);
  check("merge identity: another task's subject does not match", isTaskMergeSha(repo, otherTaskSha, "T1") === false);
  check("merge identity: id-prefix confusion rejected", isTaskMergeSha(repo, prefixTrapSha, "T1") === false);
  check(
    "merge identity: invalid sha/id charset refused",
    isTaskMergeSha(repo, "../../etc", "T1") === false && isTaskMergeSha(repo, squashSha, "T1/../x") === false,
  );
  rmSync(repo, { recursive: true, force: true });
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
  const mem = "# Experience memory (IER)\n\n## Lessons\n- existing lesson one survives (fonte: P1-007)\n- existing lesson two survives (fonte: P1-007)\n";
  const memOut = appendLessons(mem, ["- brand new lesson three"], "P1-052");
  check("experience: append preserves existing lessons (no amnesia)", parseLessons(memOut.md).length === 3 && memOut.md.includes("existing lesson one survives"));
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
check(
  "experience: template + landed doc name the planner audience (P2-042, no stale claim)",
  experienceTemplate().includes("de planner, builder e strategist") &&
    readFileSync(join(import.meta.dirname, "..", "docs", "EXPERIENCE.md"), "utf8").includes("de planner, builder e strategist"),
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

// --- P2-031 failure lessons (blocked-task scribe) -----------------------------
{
  const lessonOf = (id: string, n: number): FailureLesson => ({
    kind: "failure",
    ts: `2026-09-0${n}T10:0${n}:00-03:00`,
    task: id,
    attempts: 4,
    step: "typecheck",
    findings: `finding ${n}`,
    tail: `tail ${n}`,
  });
  const jsonl = [
    "not json at all",
    JSON.stringify({ kind: "success", task: "P9-999" }),
    JSON.stringify(lessonOf("P1-001", 1)),
    "{broken json",
    JSON.stringify(lessonOf("P2-002", 2)),
    "",
  ].join("\n");

  const parsed = parseFailureLessons(jsonl);
  check("failure lessons: parses only kind:failure lines, skips corrupt", parsed.length === 2 && parsed[0]!.task === "P1-001" && parsed[1]!.task === "P2-002");
  check("failure lessons: empty content → empty list", parseFailureLessons("").length === 0 && parseFailureLessons("\n\n").length === 0);
  check(
    "failure lessons: malformed optional fields degrade to defaults",
    parseFailureLessons(JSON.stringify({ kind: "failure", task: "X-1" }))[0]!.attempts === 0 &&
      parseFailureLessons(JSON.stringify({ kind: "failure" })).length === 0,
  );

  check("failure lessons: empty list → no prompt block", failureLessonsBlock([]) === "");
  const block = failureLessonsBlock(parsed);
  check(
    "failure lessons: block cites task id, step, findings and gate tail",
    block.includes("FAILURE LESSONS") && block.includes("[P1-001]") && block.includes("typecheck") && block.includes("finding 1") && block.includes("tail 1"),
  );
  const twelve = Array.from({ length: 12 }, (_, i) => lessonOf(`P2-0${String(i).padStart(2, "0")}`, i));
  const capped = failureLessonsBlock(twelve);
  check("failure lessons: block caps at 10 most recent", (capped.match(/\n- \[/g) ?? []).length === 10 && capped.includes("[P2-011]") && !capped.includes("[P2-000]"));
  check(
    "failure lessons: formatFailureLesson collapses whitespace and bounds parts",
    formatFailureLesson({ ...lessonOf("P1-001", 1), findings: "a\n\nb\tc", tail: `x${"y".repeat(500)}` }).length < 500 &&
      !formatFailureLesson({ ...lessonOf("P1-001", 1), findings: "a\n\nb\tc" }).includes("\n"),
  );

  const dir = mkdtempSync(join(tmpdir(), "ocr-faillessons-"));
  const file = join(dir, "nested", "lessons.jsonl");
  check("failure lessons: read missing file → []", readRecentFailureLessons(file).length === 0);
  check("failure lessons: append creates parent dirs", appendFailureLesson(file, lessonOf("P3-003", 3)));
  check("failure lessons: read roundtrip", readRecentFailureLessons(file)[0]!.task === "P3-003");
  check("failure lessons: append caps findings", appendFailureLesson(file, { ...lessonOf("P3-004", 4), findings: "f".repeat(10_000), tail: "t".repeat(10_000) }));
  const stored = readRecentFailureLessons(file, 10);
  check(
    "failure lessons: stored fields are bounded",
    stored.length === 2 && stored[1]!.findings.length === FAILURE_FINDINGS_CAP && stored[1]!.tail.length === FAILURE_TAIL_CAP,
  );
  check("failure lessons: readRecentFailureLessons caps at max", readRecentFailureLessons(file, 1).length === 1);
  rmSync(dir, { recursive: true, force: true });
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

// --- desktop daemon/app version mismatch (P3-054) -----------------------------
{
  // spec matrix: equal ok, daemon minor ahead ok, older daemon and any major
  // drift flag. Both directions of the banner text depend on this verdict.
  check("versions: equal is compatible", versionMismatch("1.2.3", "1.2.3") === false);
  check("versions: daemon minor ahead is compatible", versionMismatch("1.2.3", "1.3.0") === false);
  check("versions: daemon patch ahead is compatible", versionMismatch("1.2.3", "1.2.4") === false);
  check("versions: daemon older minor flags", versionMismatch("1.2.3", "1.1.9") === true);
  check("versions: daemon older patch flags", versionMismatch("1.2.3", "1.2.2") === true);
  check("versions: daemon major ahead flags", versionMismatch("1.2.3", "2.0.0") === true);
  check("versions: daemon major behind flags", versionMismatch("2.0.0", "1.9.9") === true);
  // -dev suffix tolerance: prerelease of the same core version is compatible.
  check("versions: -dev suffix tolerated (equal)", versionMismatch("1.2.3-dev", "1.2.3") === false);
  check("versions: -dev suffix tolerated (reversed)", versionMismatch("1.2.3", "1.2.3-dev") === false);
  check("versions: -dev does not hide a major drift", versionMismatch("2.0.0-dev", "1.9.9") === true);
  check("versions: leading v tolerated", versionMismatch("v1.2.3", "1.2.3") === false);
  // Unknown versions never flag: a false positive nags every healthy user.
  check("versions: missing daemon version is compatible", versionMismatch("1.2.3", null) === false);
  check("versions: missing app version is compatible", versionMismatch(null, "1.2.3") === false);
  check("versions: non-semver daemon is compatible", versionMismatch("1.2.3", "dev-main") === false);
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

// --- desktop tray: template-image source decision (P3-015) ---------------------
{
  const asset = "/abs/path/build/trayTemplate.png";
  const src = (platform: string, usable: boolean) => trayIconSource(platform, asset, usable);
  check("tray: usable asset wins over the data-URL fallback", src("darwin", true).kind === "asset" && src("darwin", true).path === asset);
  check("tray: missing/empty asset falls back to the data-URL glyph", src("darwin", false).kind === "fallback" && src("darwin", false).path === "");
  check("tray: fallback is never a template image", src("darwin", false).template === false);
  check("tray: template set on darwin only", src("darwin", true).template === true && src("win32", true).template === false && src("linux", true).template === false);
  // The committed asset is what createFromPath loads in buildTray(); guard its
  // format (16x16 + 32x32 @2x) and the electron-builder `files` entry so a
  // packaged build keeps the auto-Retina pairing.
  const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop");
  const tray16 = join(desktopRoot, "build", "trayTemplate.png");
  const tray32 = join(desktopRoot, "build", "trayTemplate@2x.png");
  check("tray: template asset committed at 16px with 2x variant", pngSize(tray16)?.w === 16 && pngSize(tray16)?.h === 16 && pngSize(tray32)?.w === 32 && pngSize(tray32)?.h === 32);
  const builderYml = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
  check("tray: template assets packaged via electron-builder files", builderYml.includes("build/trayTemplate.png") && builderYml.includes("build/trayTemplate@2x.png"));
}

// --- desktop tray: update status item label (P3-019) ----------------------------
{
  // The disabled status item mirrors the latest check decision in the tray;
  // the update-available string is the task-mandated label shown above
  // "Restart daemon". All six UpdateStatus values must map to a stable,
  // distinct label (disabled → null = no status item, tray unchanged).
  // P1-050 r2: "update-available" no longer says "restart to install" — at
  // that point nothing has downloaded and a plain restart installs nothing
  // under the consent flow; only update-downloaded does.
  check("tray: update-available label", updateMenuLabel("update-available") === "Update available — check for updates");
  check("tray: update-not-available label", updateMenuLabel("update-not-available") === "Up to date");
  check("tray: unrecognized-feed label", updateMenuLabel("unrecognized-feed") === "Update check failed — unrecognized feed");
  check("tray: feed-unreachable label", updateMenuLabel("feed-unreachable") === "Update check failed — feed unreachable");
  check("tray: disabled → no status item (null)", updateMenuLabel("disabled") === null);
  const labels = [
    updateMenuLabel("update-available"),
    updateMenuLabel("update-not-available"),
    updateMenuLabel("unrecognized-feed"),
    updateMenuLabel("feed-unreachable"),
    updateMenuLabel("disabled"),
  ];
  check("tray: the five status labels are distinct", new Set(labels).size === 5);
  check(
    "tray: update label keeps the mandated em-dash phrasing",
    updateMenuLabel("update-available")?.includes("Update available") === true &&
      updateMenuLabel("update-available")?.includes("check for updates") === true,
  );
}

// --- desktop tray: open logs folder (P3-016) ------------------------------------
{
  // The item must point at the exact folder the file logger (P3-012) writes
  // to: <userData>/logs. Guard the join so tray and logger never drift apart.
  check("logs: logsDirPath is <userData>/logs", logsDirPath("/home/u/AppData") === join("/home/u/AppData", "logs"));

  // Path 1 — folder did not exist: mkdir called with recursive:true, then open.
  {
    const calls: string[] = [];
    const opts: { recursive: boolean }[] = [];
    const ok = await openLogsFolder("/u/logs", {
      mkdir: (d, o) => {
        opts.push(o);
        calls.push(`mkdir ${d}`);
      },
      openPath: async (p) => {
        calls.push(`open ${p}`);
      },
    });
    check("logs: missing dir is created recursively", ok === true && calls.join("|") === "mkdir /u/logs|open /u/logs" && opts[0]?.recursive === true);
  }
  // Path 2 — folder already exists: mkdir (idempotent, recursive) still runs
  // and the folder is opened anyway.
  {
    let mkdirs = 0;
    const opened: string[] = [];
    const ok = await openLogsFolder("/u/logs", {
      mkdir: () => {
        mkdirs++;
      },
      openPath: async (p) => {
        opened.push(p);
      },
    });
    check("logs: existing dir is opened (mkdir idempotent)", ok === true && mkdirs === 1 && opened[0] === "/u/logs");
  }
  // Path 3a — fs error (mkdir throws): no open, resolves false, never throws.
  {
    let opened = 0;
    const ok = await openLogsFolder("/u/logs", {
      mkdir: () => {
        throw new Error("EROFS: read-only file system");
      },
      openPath: async () => {
        opened++;
      },
    });
    check("logs: mkdir failure is swallowed (log-only)", ok === false && opened === 0);
  }
  // Path 3b — openPath rejects: same best-effort contract.
  {
    const ok = await openLogsFolder("/u/logs", {
      mkdir: () => {},
      openPath: async () => {
        throw new Error("openPath failed");
      },
    });
    check("logs: openPath failure is swallowed (log-only)", ok === false);
  }
}

// --- desktop native daemon notifications (P3-013) -------------------------------
{
  // The 4 transitions: each real transition notifies exactly once, a stable
  // state never re-notifies on every 3s poll (dedupe by transition).
  check("notify: healthy→down fires 'down'", daemonNotify("healthy", "down").notify === "down");
  check("notify: down→healthy fires 'back'", daemonNotify("down", "healthy").notify === "back");
  check("notify: healthy→healthy is deduped", daemonNotify("healthy", "healthy").notify === "none");
  check("notify: down→down is deduped", daemonNotify("down", "down").notify === "none");
  // First observation after boot is not a transition — no notification.
  check("notify: boot observation (null→down) stays silent", daemonNotify(null, "down").notify === "none");
  check("notify: boot observation (null→healthy) stays silent", daemonNotify(null, "healthy").notify === "none");
  // The bodies are wired into new Notification({body}) in main.ts; guard
  // against accidental rewording that would orphan the strings.
  check(
    "notify: message strings are distinct and non-empty",
    NOTIFY_DOWN_BODY.length > 0 && NOTIFY_BACK_BODY.length > 0 && NOTIFY_DOWN_BODY !== NOTIFY_BACK_BODY,
  );
}

// --- desktop Windows AppUserModelID (P3-020) -------------------------------------
{
  // The appId registered by electron-builder.yml must not drift apart from the
  // runtime AUMID, or win32 toasts silently drop again.
  check("aumid: constant matches the electron-builder appId", WINDOWS_APP_ID === "com.culturabuilder.opencode-remote");
  check("aumid: win32 resolves the appId", appIdForPlatform("win32") === WINDOWS_APP_ID);
  check("aumid: darwin resolves null (Info.plist covers it)", appIdForPlatform("darwin") === null);
  check("aumid: linux resolves null", appIdForPlatform("linux") === null);
  check("aumid: unknown platform resolves null", appIdForPlatform("freebsd") === null);

  // Fake-app wiring: setAppUserModelId fires exactly once on win32, never on
  // darwin — this is the exact contract main.ts relies on before whenReady.
  const fakeApp = (calls: string[]) => ({ setAppUserModelId: (id: string) => calls.push(id) });
  const winCalls: string[] = [];
  check(
    "aumid: win32 wires setAppUserModelId exactly 1x",
    applyAppUserModelId(fakeApp(winCalls), "win32") === true && winCalls.length === 1 && winCalls[0] === WINDOWS_APP_ID,
  );
  const macCalls: string[] = [];
  check(
    "aumid: darwin never calls setAppUserModelId",
    applyAppUserModelId(fakeApp(macCalls), "darwin") === false && macCalls.length === 0,
  );
}

// --- desktop window-state persistence (P3-008) ---------------------------------
{
  // A single 1920x1080 display at origin, plus a second one to its right.
  const displays = [
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
  ];
  const partial = (o: Partial<WindowBounds>): WindowBounds => ({ ...DEFAULT_WINDOW_BOUNDS, ...o });

  // Field-wise compares: JSON key order is not part of the contract.
  const eq = (a: WindowBounds, b: WindowBounds): boolean =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  check(
    "window-state: valid on-screen bounds pass through",
    eq(sanitizeWindowBounds(partial({ x: 10, y: 20, width: 1600, height: 900 }), displays), { x: 10, y: 20, width: 1600, height: 900 }),
  );
  check(
    "window-state: second display counts as on-screen",
    sanitizeWindowBounds(partial({ x: 2000, y: 50, width: 1280, height: 820 }), displays).x === 2000,
  );
  check(
    "window-state: off-screen (display disconnected) → default",
    eq(sanitizeWindowBounds(partial({ x: 9999, y: 20, width: 1600, height: 900 }), displays), DEFAULT_WINDOW_BOUNDS),
  );
  check(
    "window-state: fully beyond right edge → default",
    eq(sanitizeWindowBounds(partial({ x: 2000, y: 0, width: 1600, height: 900 }), [displays[0]]), DEFAULT_WINDOW_BOUNDS),
  );
  check(
    "window-state: size-only state is valid (x/y omitted → Electron centers)",
    eq(sanitizeWindowBounds({ width: 1600, height: 900 }, displays), { width: 1600, height: 900 }),
  );
  check(
    "window-state: sizes below the min are clamped",
    sanitizeWindowBounds({ x: 0, y: 0, width: 10, height: 10 }, displays).width === WINDOW_MIN.width &&
      sanitizeWindowBounds({ x: 0, y: 0, width: 10, height: 10 }, displays).height === WINDOW_MIN.height,
  );
  check(
    "window-state: garbage shapes → default (non-object, non-numeric, zero/negative)",
    eq(sanitizeWindowBounds(null, displays), DEFAULT_WINDOW_BOUNDS) &&
      eq(sanitizeWindowBounds("corrupted", displays), DEFAULT_WINDOW_BOUNDS) &&
      eq(sanitizeWindowBounds({ width: "big", height: true, x: 0, y: 0 }, displays), DEFAULT_WINDOW_BOUNDS) &&
      eq(sanitizeWindowBounds({ width: 0, height: -5, x: 0, y: 0 }, displays), DEFAULT_WINDOW_BOUNDS),
  );

  // File roundtrip against a real temp file.
  const wsd = mkdtempSync(join(tmpdir(), "ocr-winstate-"));
  const stateFile = windowStateFile(wsd);
  check("window-state: state file lives in the given userData dir", stateFile.endsWith("window-state.json") && stateFile.includes(wsd));
  check("window-state: missing file → default, no crash", eq(loadWindowBounds(stateFile, displays), DEFAULT_WINDOW_BOUNDS));
  check("window-state: save then load roundtrips the bounds", saveWindowBounds(stateFile, { x: 33, y: 44, width: 1440, height: 900 }));
  const loaded = loadWindowBounds(stateFile, displays);
  check("window-state: loaded bounds match what was saved", loaded.x === 33 && loaded.y === 44 && loaded.width === 1440 && loaded.height === 900);
  writeFileSync(stateFile, "{not json!!", "utf8");
  check(
    "window-state: corrupted JSON file → default without crashing",
    eq(loadWindowBounds(stateFile, displays), DEFAULT_WINDOW_BOUNDS),
  );
  rmSync(wsd, { recursive: true, force: true });
  check(
    "window-state: write failure is log-only (unwritable dir)",
    saveWindowBounds(join(wsd, "gone", "window-state.json"), DEFAULT_WINDOW_BOUNDS) === false,
  );
}

// --- P2-020 daemon graceful shutdown (SIGTERM/SIGINT) ---------------------------
{
  // controllable fake timers: hard-drain timers fire only when flushed
  type Timer = ReturnType<typeof setTimeout>;
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let nextId = 1;
  const fakeSetTimeout = (fn: () => void, ms: number): Timer => {
    const t = { id: nextId++, fn, ms };
    timers.push(t);
    return t as unknown as Timer;
  };
  const fakeClearTimeout = (timer: Timer) => {
    const i = timers.indexOf(timer as unknown as { id: number });
    if (i >= 0) timers.splice(i, 1);
  };
  const flushTimers = (upToMs: number) => {
    const due = timers.filter((t) => t.ms <= upToMs);
    for (const t of due) {
      fakeClearTimeout(t);
      t.fn();
    }
  };

  // 1. clean path: stopListeners runs once, state is logged, exit(0)
  {
    let stopCalls = 0;
    const exits: number[] = [];
    const { shutdown, isShuttingDown } = createShutdown({
      activeConnections: () => 2,
      uptimeMs: () => 65_000,
      stopListeners: async () => {
        stopCalls++;
      },
      exit: (code) => exits.push(code),
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    });
    check("shutdown: idle state is not shutting down", isShuttingDown() === false);
    const p = shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 0)); // let stopListeners run and queue the settle timer
    check("shutdown: hard timer queued at DRAIN_MS (plus settle)", timers.length === 2 && timers[0]!.ms === DRAIN_MS);
    flushTimers(DRAIN_MS - 1); // fire the settle timer, keep the hard one queued
    await p;
    check("shutdown: stops listeners exactly once", stopCalls === 1);
    check("shutdown: exits with code 0 after drain", exits.length === 1 && exits[0] === 0);
    check("shutdown: flag flips while draining", isShuttingDown() === true);
    check("shutdown: hard timer consumed on clean path", timers.length === 0);
  }

  // 2. idempotent: a second signal exits immediately, no second cleanup pass
  {
    let stopCalls = 0;
    const exits: number[] = [];
    const { shutdown } = createShutdown({
      activeConnections: () => 0,
      uptimeMs: () => 0,
      stopListeners: async () => {
        stopCalls++;
        await new Promise(() => {}); // drain hangs (e.g. stuck socket)
      },
      exit: (code) => exits.push(code),
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    });
    void shutdown("SIGTERM"); // first signal: drain starts and hangs
    await shutdown("SIGINT"); // second signal: immediate exit
    check("shutdown: second signal exits immediately (code 0)", exits.length === 1 && exits[0] === 0);
    check("shutdown: second signal does not re-run cleanup", stopCalls === 1);
  }

  // 3. drain timer: hanging stopListeners still exits(0) within DRAIN_MS
  {
    const exits: number[] = [];
    const { shutdown } = createShutdown({
      activeConnections: () => 0,
      uptimeMs: () => 0,
      stopListeners: () => new Promise<void>(() => {}), // never resolves
      exit: (code) => exits.push(code),
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    });
    void shutdown("SIGTERM");
    flushTimers(DRAIN_MS);
    check("shutdown: drain timer forces exit(0)", exits.length === 1 && exits[0] === 0);
  }

  // 4. behavioral: real http server + real ws peer, close code 1001
  {
    const httpServer = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = (httpServer.address() as AddressInfo).port;
    // an open keep-alive socket must not stall server.close()
    const keepAlive = netConnect(port, "127.0.0.1");
    await new Promise((r) => keepAlive.on("connect", r));

    const wss = new WebSocketServer({ port: 0 });
    const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    await new Promise((r) => client.on("open", r));
    const serverSock = [...wss.clients][0]!;

    let closeCode: number | null = null;
    client.on("close", (code) => {
      closeCode = code;
    });
    let stopped = false;
    let refused = false;
    const stop = stopAccepting(httpServer, [serverSock]).then(() => {
      stopped = true;
    });
    await Promise.race([stop, new Promise((r) => setTimeout(r, 2000))]);
    try {
      await fetch(`http://127.0.0.1:${port}/metrics`);
    } catch {
      refused = true;
    }
    check("shutdown: http server stops accepting (keep-alive drained ≤2s)", stopped && !httpServer.listening && refused);
    await new Promise((r) => setTimeout(r, 300)); // let the ws close handshake land
    check("shutdown: ws peer receives close code 1001", closeCode === 1001);
    keepAlive.destroy();
    client.terminate();
    wss.close();
  }
}

// --- P2-023 relay graceful shutdown (SIGTERM/SIGINT) -----------------------------
{
  // controllable fake timers: hard-drain timers fire only when flushed
  type Timer = ReturnType<typeof setTimeout>;
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let nextId = 1;
  const fakeSetTimeout = (fn: () => void, ms: number): Timer => {
    const t = { id: nextId++, fn, ms };
    timers.push(t);
    return t as unknown as Timer;
  };
  const fakeClearTimeout = (timer: Timer) => {
    const i = timers.indexOf(timer as unknown as { id: number });
    if (i >= 0) timers.splice(i, 1);
  };
  const flushTimers = (upToMs: number) => {
    const due = timers.filter((t) => t.ms <= upToMs);
    for (const t of due) {
      fakeClearTimeout(t);
      t.fn();
    }
  };
  const logLines: { level: string; msg: string; data?: unknown }[] = [];
  const fakeLog: RelayLog = (level, msg, data) => logLines.push({ level, msg, data });

  // 1. clean path: stopListeners runs once, final JSONL line with uptime + closed count
  {
    let stopCalls = 0;
    const exits: number[] = [];
    const { shutdown, isShuttingDown } = relayCreateShutdown({
      activeConnections: () => 7,
      uptimeMs: () => 120_000,
      stopListeners: async () => {
        stopCalls++;
      },
      log: fakeLog,
      exit: (code) => exits.push(code),
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    });
    check("relay-shutdown: idle state is not shutting down", isShuttingDown() === false);
    const p = shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 0)); // let stopListeners run and queue the settle timer
    check(
      "relay-shutdown: hard timer queued at DRAIN_MS (plus settle)",
      timers.length === 2 && timers[0]!.ms === RELAY_DRAIN_MS,
    );
    flushTimers(RELAY_DRAIN_MS - 1); // fire the settle timer, keep the hard one queued
    await p;
    check("relay-shutdown: stops listeners exactly once", stopCalls === 1);
    check("relay-shutdown: exits with code 0 after drain", exits.length === 1 && exits[0] === 0);
    check("relay-shutdown: flag flips while draining", isShuttingDown() === true);
    check("relay-shutdown: hard timer consumed on clean path", timers.length === 0);
    const finalLine = logLines.find((l) => l.msg === "relay shut down");
    const finalData = finalLine?.data as { closedConnections?: number; uptimeS?: number } | undefined;
    check(
      "relay-shutdown: final JSONL log carries uptime + closed count",
      !!finalData && finalData.closedConnections === 7 && finalData.uptimeS === 120,
    );
  }

  // 2. idempotent: a second signal exits immediately, no second cleanup pass
  {
    let stopCalls = 0;
    const exits: number[] = [];
    const { shutdown } = relayCreateShutdown({
      activeConnections: () => 0,
      uptimeMs: () => 0,
      stopListeners: async () => {
        stopCalls++;
        await new Promise(() => {}); // drain hangs (e.g. stuck socket)
      },
      log: fakeLog,
      exit: (code) => exits.push(code),
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    });
    void shutdown("SIGTERM"); // first signal: drain starts and hangs
    await shutdown("SIGINT"); // second signal: immediate exit
    check("relay-shutdown: second signal exits immediately (code 0)", exits.length === 1 && exits[0] === 0);
    check("relay-shutdown: second signal does not re-run cleanup", stopCalls === 1);
  }

  // 3. drain timer: hanging stopListeners still exits(0) within DRAIN_MS
  {
    const exits: number[] = [];
    const { shutdown } = relayCreateShutdown({
      activeConnections: () => 0,
      uptimeMs: () => 0,
      stopListeners: () => new Promise<void>(() => {}), // never resolves
      log: fakeLog,
      exit: (code) => exits.push(code),
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    });
    void shutdown("SIGTERM");
    flushTimers(RELAY_DRAIN_MS);
    check("relay-shutdown: drain timer forces exit(0)", exits.length === 1 && exits[0] === 0);
  }

  // 4. behavioral: relay-shaped stopAccepting — ws peers get close 1001
  //    with the documented reason, new connections are refused, and the
  //    underlying TCP sockets are NOT destroyed before the close frames flush
  {
    const httpServer = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = (httpServer.address() as AddressInfo).port;

    const wss = new WebSocketServer({ server: httpServer, maxPayload: 1_000_000 });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => client.on("open", r));
    const serverSock = [...wss.clients][0]!;

    let closeCode: number | null = null;
    let closeReason = "";
    client.on("close", (code, reason) => {
      closeCode = code;
      closeReason = reason.toString();
    });
    relayStopAccepting(httpServer, [serverSock], fakeLog);
    await new Promise((r) => setTimeout(r, 300)); // let the ws close handshake land
    check(
      "relay-shutdown: ws client receives close 1001 'server shutting down'",
      closeCode === 1001 && closeReason === "server shutting down",
    );
    let refused = false;
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch {
      refused = true;
    }
    check("relay-shutdown: server refuses new connections after close()", refused);
    client.terminate();
    wss.close();
    if (httpServer.listening) httpServer.close();
  }
}

// --- P2-032 fever circuit breaker (audit mode): fault injection ------------------
{
  const st = () =>
    ({ date: "2026-09-01", tasks: 0, deploys: 0, failures: 0, taskAttempts: {} } as Parameters<typeof feverReason>[0]);

  // sliding window keeps only the AUDIT_WINDOW most recent samples
  {
    const s = st();
    for (let i = 0; i < AUDIT_WINDOW + 4; i++) recordCycle(s, true, undefined, i);
    check("audit: sliding window keeps the last 10 cycles", s.cycles!.length === AUDIT_WINDOW && s.cycles![0]!.at === 4);
  }

  // trigger 1: >= 3 DISTINCT tasks failed inside the cycle window (P2-063)
  {
    // spec criterion: 10-cycle window where 1 stubborn task fails 4x — the
    // per-task maxAttemptsPerTask circuit owns it, not the global pause
    const s = st();
    for (let i = 0; i < 4; i++) recordCycle(s, false, "P1-056", i);
    for (let i = 4; i < AUDIT_WINDOW; i++) recordCycle(s, true, undefined, i);
    check("audit: 1 task failing 4x in 10 cycles never trips the fever", feverReason(s, AUDIT_WINDOW) === null);

    // even alternating failures from 2 distinct tasks stay under the global breaker
    const s2 = st();
    for (let i = 0; i < 6; i++) recordCycle(s2, false, i % 2 === 0 ? "T-A" : "T-B", i);
    for (let i = 6; i < AUDIT_WINDOW; i++) recordCycle(s2, true, undefined, i);
    check("audit: 2 distinct tasks failing do not trip the fever", feverReason(s2, AUDIT_WINDOW) === null);

    // 3 distinct failing tasks trip it — even in a sparse window
    const s3 = st();
    recordCycle(s3, false, "T-A", 0);
    recordCycle(s3, false, "T-B", 1);
    check("audit: 2 distinct failing tasks in a partial window stay calm", feverReason(s3, 2) === null);
    recordCycle(s3, false, "T-C", 2);
    check("audit: 3 distinct failing tasks trip the fever", (feverReason(s3, 3) ?? "").includes("3 distinct tasks"));
    // repeats from an already-counted task add no evidence
    recordCycle(s3, false, "T-A", 3);
    recordCycle(s3, false, "T-A", 4);
    check("audit: repeats of the same task do not deepen the fever", (feverReason(s3, 5) ?? "").includes("3 distinct tasks"));

    // id-less failures (pipeline crashes, legacy samples) each count as their
    // own distinct entry — 3 crashed pipelines are still systemic evidence
    const s4 = st();
    recordCycle(s4, false, undefined, 0);
    recordCycle(s4, false, undefined, 1);
    check("audit: 2 id-less failures do not trip yet", feverReason(s4, 2) === null);
    recordCycle(s4, false, undefined, 2);
    check("audit: 3 crashed pipelines trip the fever (conservative)", (feverReason(s4, 3) ?? "").includes("3 distinct tasks"));
  }

  // trigger 2: 2 tasks blocked within 30 min
  {
    check("audit: burst trigger constant is 2 blocks", AUDIT_BLOCK_TRIGGER === 2);
    const s = st();
    recordBlockEvent(s, 0);
    check("audit: one block is not a burst", feverReason(s, 1) === null);
    recordBlockEvent(s, AUDIT_BLOCK_WINDOW_MS - 1);
    check("audit: 2 blocks within 30min trip the burst trigger", (feverReason(s, AUDIT_BLOCK_WINDOW_MS) ?? "").includes("2 tasks blocked"));
    check("audit: stale blocks no longer count (pruned lazily)", feverReason(s, AUDIT_BLOCK_WINDOW_MS * 2) === null);
    recordBlockEvent(s, AUDIT_BLOCK_WINDOW_MS * 3);
    check("audit: recording prunes timestamps outside the window", s.blockEvents!.length === 1);
  }

  // lifecycle: enter once, hold, resume on either path
  {
    const s = st();
    for (let i = 0; i < AUDIT_WINDOW; i++) recordCycle(s, false, `T-${i}`, i);
    const reason = feverReason(s, AUDIT_WINDOW);
    check("audit: enterAuditMode trips once", enterAuditMode(s, reason!, 1000) === true && enterAuditMode(s, reason!, 1001) === false);
    check("audit: entering clears the trigger windows", s.cycles!.length === 0 && s.blockEvents!.length === 0);
    check("audit: audit state carries reason + since", s.auditMode!.reason === reason && s.auditMode!.since.length > 0);
    check("audit: resume not due before 2h", auditResumeDue(s.auditMode!, 1000 + AUDIT_RESUME_MS - 1) === false);
    check("audit: resume due after 2h without failure", auditResumeDue(s.auditMode!, 1000 + AUDIT_RESUME_MS) === true);
    recordCycle(s, false, undefined, 2000);
    check("audit: fresh failure pushes the resume deadline", s.auditMode!.lastFailure === 2000);
    recordCycle(s, true, undefined, 3000);
    check("audit: success does not push the resume deadline", s.auditMode!.lastFailure === 2000);
    recordBlockEvent(s, 4000);
    check("audit: block landing also pushes the deadline", s.auditMode!.lastFailure === 4000);
    clearAuditMode(s);
    check("audit: clear resets every breaker counter", s.auditMode === null && s.cycles!.length === 0 && s.blockEvents!.length === 0);
    check("audit: healthy state has no trigger", feverReason(s, 5000) === null);
  }
}

// --- P2-032 audit diagnosis: doctor summary aggregation ---------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "pilot-audit-"));
  try {
    const gateDir = join(dir, "gate-fail");
    mkdirSync(gateDir, { recursive: true });
    writeFileSync(
      join(dir, "lessons.jsonl"),
      [
        JSON.stringify({ kind: "failure", ts: "t", task: "P1-001", attempts: 4, step: "unit", findings: "f", tail: "" }),
        JSON.stringify({ kind: "failure", ts: "t", task: "P1-002", attempts: 4, step: "unit", findings: "f", tail: "" }),
        JSON.stringify({ kind: "failure", ts: "t", task: "P1-001", attempts: 4, step: "review", findings: "f", tail: "" }),
        "not json",
      ].join("\n"),
    );
    // P1-003 has no lesson yet (still retrying) — its gate-fail file must count
    writeFileSync(join(gateDir, "P1-003.json"), JSON.stringify({ task: "P1-003", step: "build", tail: "boom", at: "t" }));
    // P1-002 already has a lesson — no double counting
    writeFileSync(join(gateDir, "P1-002.json"), JSON.stringify({ task: "P1-002", step: "unit", tail: "boom", at: "t" }));

    const d = buildDiagnosis({ lessonsFile: join(dir, "lessons.jsonl"), gateFailDir: gateDir, attempts: { "P1-009": 2, "P1-001": 4 }, api: false });
    check("audit diagnosis: api probe result carried through", d.api === "down");
    check("audit diagnosis: top step is the double-failing one", d.topSteps[0]?.step === "unit" && d.topSteps[0]?.count === 2);
    check("audit diagnosis: gate-fail of lessoned task not double counted", d.topSteps.find((x) => x.step === "unit")?.count === 2);
    check("audit diagnosis: retrying task counted from gate-fail", d.topSteps.find((x) => x.step === "build")?.count === 1);
    check("audit diagnosis: top task merges lessons + live attempts", d.topTasks[0]?.task === "P1-001" && d.topTasks[0]?.count === 4);
    check("audit diagnosis: live-attempt-only task present", d.topTasks.find((x) => x.task === "P1-009")?.count === 2);
    const line = formatDiagnosis(d);
    check(
      "audit diagnosis: one-line log format",
      line.includes("api=down") && line.includes("top failure steps: unit(2)") && line.includes("top rejected tasks: P1-001(4)"),
    );

    const empty = buildDiagnosis({ lessonsFile: join(dir, "missing.jsonl"), gateFailDir: join(dir, "no-such-dir") });
    check("audit diagnosis: missing sources degrade to none", empty.topSteps.length === 0 && empty.topTasks.length === 0 && empty.api === "unknown");
    check("audit diagnosis: empty format", formatDiagnosis(empty).includes("top failure steps: none"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- P2-032 state.json: fever breaker survives the daily rollover -----------------
{
  const dir = mkdtempSync(join(tmpdir(), "pilot-audit-state-"));
  try {
    const file = join(dir, "state.json");
    writeFileSync(
      file,
      JSON.stringify({
        date: "2026-01-01",
        tasks: 5,
        deploys: 3,
        failures: 2,
        taskAttempts: { "T-001": 3 },
        cycles: [{ ok: false, at: 1 }],
        blockEvents: [42],
        auditMode: { since: "s", reason: "fever: test", lastFailure: 7 },
      }),
    );
    const rolled = loadState(file);
    check("loadState keeps fever windows across midnight", rolled.cycles!.length === 1 && rolled.blockEvents!.length === 1);
    check("loadState keeps audit mode across midnight", rolled.auditMode?.reason === "fever: test" && rolled.auditMode.lastFailure === 7);
    writeFileSync(file, JSON.stringify({ date: "2026-01-01", tasks: 1, deploys: 1, failures: 1 }));
    const legacy = loadState(file);
    check("loadState backfills fever fields for legacy state", legacy.cycles!.length === 0 && legacy.blockEvents!.length === 0 && legacy.auditMode === null);
    writeFileSync(file, JSON.stringify({ date: "2026-01-01", auditMode: { reason: "" } }));
    check("loadState rejects a malformed audit mode", loadState(file).auditMode === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- P2-045 dashboard v2: honest counters + diagnostics aggregations --------------
{
  const dir = mkdtempSync(join(tmpdir(), "pilot-metrics-"));
  try {
    const file = join(dir, "state.json");
    // daily MERGES counter: rolls at midnight like tasks/deploys/failures and
    // backfills 0 for legacy state files written before P2-045
    writeFileSync(file, JSON.stringify({ date: "2026-01-01", tasks: 5, deploys: 3, failures: 2, merges: 4, taskAttempts: {} }));
    const rolled = loadState(file);
    check("loadState rolls the daily merge counter at midnight", rolled.date !== "2026-01-01" && rolled.merges === 0);
    writeFileSync(file, JSON.stringify({ date: new Date().toLocaleDateString("en-CA"), tasks: 1, deploys: 1, failures: 1 }));
    const legacy = loadState(file);
    check("loadState backfills merges for legacy state", legacy.merges === 0 && legacy.tasks === 1);

    // per-step failure breakdown from gate-fail events
    const evs: PilotEvent[] = [
      { ts: "2026-09-01T10:00:00Z", type: "phase", task: "P1", phase: "gate-fail", ok: false, detail: "evidence" },
      { ts: "2026-09-01T10:01:00Z", type: "phase", task: "P1", phase: "gate-fail", ok: false, detail: "invariants" },
      { ts: "2026-09-01T10:02:00Z", type: "phase", task: "P2", phase: "gate-fail", ok: false, detail: "evidence" },
      { ts: "2026-09-01T10:03:00Z", type: "phase", task: "P3", phase: "merge", ok: false },
      { ts: "2026-09-01T10:04:00Z", type: "result", task: "P3", ok: false, detail: "gatekeeper rejected" },
    ];
    const steps = countFailSteps(evs);
    check("failSteps: groups gate-fail events by step", steps[0]?.step === "evidence" && steps[0]?.count === 2);
    check("failSteps: keeps every failing step", steps.find((s) => s.step === "invariants")?.count === 1 && steps.length === 2);
    check("failSteps: empty on a clean feed", countFailSteps([{ ts: "t", type: "result", task: "P1", ok: true }]).length === 0);

    // burn-down: 7 zero-filled buckets, ok/failed split per local day
    const hist = [
      { ts: "2026-08-30T12:00:00-03:00", id: "P1", ok: true, durMin: 12, attempts: 1 },
      { ts: "2026-08-30T14:00:00-03:00", id: "P2", ok: false, durMin: 30, attempts: 4 },
      { ts: "2026-08-31T10:00:00-03:00", id: "P3", ok: true, durMin: 8, attempts: 1 },
    ];
    const days = burnDown(hist, 7, new Date("2026-09-01T12:00:00-03:00"));
    check("burnDown: always returns 7 buckets ending today", days.length === 7 && days[6]?.day === "2026-09-01");
    check("burnDown: splits ok/failed per day", days[5]?.ok === 1 && days[5]?.failed === 0 && days[4]?.ok === 1 && days[4]?.failed === 1);
    check("burnDown: today zero-filled", days[6]?.ok === 0 && days[6]?.failed === 0);
    check("burnDown: tolerates malformed rows", burnDown([{ ts: "nope" }, null as unknown as { ts: string }], 1, new Date("2026-09-01T12:00:00-03:00"))[0]?.ok === 0);

    // avg duration per phase from phase transitions (multi-round aware)
    // t(h) ticks 1 second per step — every phase below spans exactly 1s
    const t = (h: number) => `2026-09-01T10:00:0${h}-03:00`;
    const flow: PilotEvent[] = [
      { ts: t(0), type: "phase", task: "PA", phase: "planner" },
      { ts: t(1), type: "phase", task: "PA", phase: "planner-done", ok: true }, // 1s planner
      { ts: t(2), type: "phase", task: "PA", phase: "builder" },
      { ts: t(3), type: "phase", task: "PA", phase: "builder-done", ok: false }, // 1s round 1
      { ts: t(4), type: "phase", task: "PA", phase: "builder" },
      { ts: t(5), type: "phase", task: "PA", phase: "builder-done", ok: true }, // 1s round 2
      { ts: t(6), type: "phase", task: "PA", phase: "reviewers" },
      { ts: t(7), type: "phase", task: "PA", phase: "reviewers-done", ok: true }, // 1s
      { ts: t(8), type: "phase", task: "PA", phase: "gatekeeper" },
      { ts: t(9), type: "phase", task: "PA", phase: "merge", ok: true }, // 1s
    ];
    const avg = avgPhaseDurations(flow);
    check("phaseDur: averages multi-round phases", avg.find((p) => p.phase === "builder")?.avgMs === 1_000 && avg.find((p) => p.phase === "builder")?.n === 2);
    check("phaseDur: closes every tracked phase", avg.find((p) => p.phase === "planner")?.avgMs === 1_000 && avg.find((p) => p.phase === "reviewers")?.avgMs === 1_000 && avg.find((p) => p.phase === "gatekeeper")?.avgMs === 1_000);
    check("phaseDur: no completed sample → phase omitted", avg.find((p) => p.phase === "scribe") === undefined);
    check("phaseDur: empty feed → empty summary", avgPhaseDurations([]).length === 0);

    // clearing audit mode also drops the persisted diagnosis (chip hygiene)
    const st = loadState(file);
    enterAuditMode(st, "fever: test", Date.now());
    st.auditDiagnosis = "api=down | top failure steps: unit(2)";
    clearAuditMode(st);
    check("clearAuditMode: wipes the diagnosis with the pause", st.auditMode === null && st.auditDiagnosis === undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- P3-052 nightly explorer: finding parser + backlog insertion format -----------
{
  const dir = mkdtempSync(join(tmpdir(), "pilot-explorer-"));
  try {
    const shot = join(dir, "01-boot.png");
    writeFileSync(shot, "png");
    const output = [
      "prelude noise EXPLORER: FINDING inline mentions are ignored",
      "EXPLORER: FINDING",
      "title: Pairing error vanishes after retry",
      "severity: high",
      "area: ui",
      `shot: ${shot}`,
      "detail: The invalid-code error clears after 2s with no explanation.",
      "",
      "EXPLORER: FINDING",
      "title: Unknown area finding",
      "severity: low",
      "area: bogus",
      `shot: ${shot}`,
      "detail: Kept but serial.",
      "",
      "EXPLORER: FINDING",
      "title: Bad severity is dropped",
      "severity: critical",
      `shot: ${shot}`,
      "detail: x",
      "",
      "EXPLORER: FINDING",
      "title: Missing shot is dropped",
      "severity: low",
      "shot: /definitely/not/a/file.png",
      "detail: x",
      "",
      "EXPLORER: FINDING",
      "title: duplicate title",
      "severity: low",
      `shot: ${shot}`,
      "detail: first",
      "",
      "EXPLORER: FINDING",
      "title: Duplicate TITLE",
      "severity: high",
      `shot: ${shot}`,
      "detail: second",
    ].join("\n");
    const found = parseExplorerFindings(output);
    check("explorer: parses valid findings with severity/area/evidence", found[0]?.title === "Pairing error vanishes after retry" && found[0]?.severity === "high" && found[0]?.area === "ui" && found[0]?.shot === shot);
    check("explorer: unknown area degrades to serial", found[1]?.area === "" && found[1]?.severity === "low");
    check("explorer: invalid severity dropped", !found.some((f) => f.title === "Bad severity is dropped"));
    check("explorer: nonexistent shot dropped", !found.some((f) => f.title === "Missing shot is dropped"));
    check("explorer: duplicate titles deduped keeping the first", found.length === 3 && found[2]?.detail === "first");
    check("explorer: detail collapses whitespace/newlines", found[0]?.detail === "The invalid-code error clears after 2s with no explanation.");

    // budget: the per-run cap is enforced deterministically by the parser
    const three = [1, 2, 3].map((n) => `EXPLORER: FINDING\ntitle: f${n}\nseverity: low\nshot: ${shot}\ndetail: d${n}`).join("\n");
    check("explorer: max option caps insertion", parseExplorerFindings(three, { exists: () => true, max: 2 }).length === 2);
    check("explorer: default budget cap is the module constant", parseExplorerFindings(three, { exists: () => true, max: EXPLORER_MAX_FINDINGS }).length === 3 && EXPLORER_MAX_FINDINGS <= 5);
    check("explorer: budgets keep the run cost predictable", EXPLORER_MAX_STEPS > 0 && EXPLORER_TIMEOUT_MIN > 0 && EXPLORER_TIMEOUT_MIN <= 30);

    // real insertion path: the addTask line must round-trip through parseBacklog
    writeFileSync(join(dir, "BACKLOG.md"), "# B\n\n## Ready\n\n## Done\n");
    const f: ExplorerFinding = { title: "Pairing error vanishes after retry", severity: "high", area: "ui", shot, detail: "The invalid-code error clears after 2s." };
    addTask(dir, "P3-099", "P3", `[explorer][${f.severity}] ${f.title}`, explorerSpec(f));
    const parsed = parseBacklog(readFileSync(join(dir, "BACKLOG.md"), "utf8"));
    check("explorer: inserted line lands as a parseable Ready task", parsed.length === 1 && parsed[0]!.id === "P3-099" && parsed[0]!.priority === "P3" && parsed[0]!.area === "ui");
    check("explorer: inserted spec carries severity + evidence path", parsed[0]!.spec.includes("(severity: high, evidence: ") && parsed[0]!.spec.includes(shot));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- P3-052 round 2: push retry semantics (commitAndPushFindings) -----------------
{
  // fake-driven: lands on the 3rd attempt — commit once, push 3x, sleep only between
  const calls: string[] = [];
  const sleeps: number[] = [];
  let pushes = 0;
  const landed = await commitAndPushFindings("pilot(explorer): test run", {
    exec: (cmd) => {
      calls.push(cmd);
      if (cmd.includes("git push")) return { ok: ++pushes >= 3, output: "" };
      return { ok: true, output: "" };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  check("explorer push retry: lands on a later attempt", landed === true);
  check("explorer push retry: commit once, then pushes", calls.filter((c) => c.includes("git commit")).length === 1 && calls.filter((c) => c.includes("git push")).length === 3);
  check("explorer push retry: waits between attempts only", sleeps.length === 2 && sleeps.every((s) => s === EXPLORER_PUSH_WAIT_MS));

  // always-failing push (commit itself succeeds): budget exhausted, false reported
  let failPushes = 0;
  const exhausted = await commitAndPushFindings("msg", {
    exec: (cmd) => {
      if (cmd.includes("git push")) {
        failPushes++;
        return { ok: false, output: "" };
      }
      return { ok: true, output: "" };
    },
    sleep: async () => {},
  });
  check("explorer push retry: false after exhausting the budget", exhausted === false && failPushes === EXPLORER_PUSH_RETRIES);

  // commit failure: aborts before any push is attempted
  let calls2 = 0;
  const noCommit = await commitAndPushFindings("msg", {
    exec: () => {
      calls2++;
      return { ok: false, output: "" };
    },
    sleep: async () => {},
  });
  check("explorer push retry: commit failure aborts before pushing", noCommit === false && calls2 === 1);

  // real git smoke: apostrophe in the message pins the shq escaping, and the
  // commit must actually land on the bare remote's main
  const repo = mkdtempSync(join(tmpdir(), "pilot-explorer-push-"));
  try {
    const git = (cmd: string, opts: { cwd: string }) => execSync(cmd, { cwd: opts.cwd, stdio: "pipe" }).toString();
    execSync("git init -q -b main && git config user.email t@t.local && git config user.name t", { cwd: repo });
    const bare = join(repo, "origin.git");
    execSync(`git init -q --bare "${bare}"`, { cwd: repo });
    execSync(`git remote add origin "${bare}"`, { cwd: repo });
    writeFileSync(join(repo, "BACKLOG.md"), "# B\n\n## Ready\n");
    const smoke = await commitAndPushFindings("pilot(explorer): smoke'd run", {
      exec: (cmd) => {
        try {
          execSync(cmd, { cwd: repo, stdio: "pipe" });
          return { ok: true, output: "" };
        } catch {
          return { ok: false, output: "" };
        }
      },
      sleep: async () => {},
    });
    const remoteLog = execSync(`git --git-dir "${bare}" log --format=%s main`).toString();
    check("explorer push retry: real git lands the commit on origin/main", smoke === true && remoteLog.includes("smoke'd run"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// --- P1-059: tiered cognition — claude CLI dispatch + escalation predicate ---

check("p1-059 claudeArgs pins the tier-B argv contract", JSON.stringify(claudeArgs("opus", "/w")) === JSON.stringify(["-p", "--model", "opus", "--add-dir", "/w", "--permission-mode", "acceptEdits"]));

check("p1-059 shouldFallbackTierB: not ok", shouldFallbackTierB({ ok: false, timedOut: false, output: "x" }));
check("p1-059 shouldFallbackTierB: timed out", shouldFallbackTierB({ ok: true, timedOut: true, output: "x" }));
check("p1-059 shouldFallbackTierB: empty output", shouldFallbackTierB({ ok: true, timedOut: false, output: "   \n " }));
check("p1-059 shouldFallbackTierB: marker missing", shouldFallbackTierB({ ok: true, timedOut: false, output: "some output" }, "PLANNER:DONE"));
check("p1-059 shouldFallbackTierB: ok with marker", !shouldFallbackTierB({ ok: true, timedOut: false, output: "done\nPLANNER:DONE" }, "PLANNER:DONE"));
check("p1-059 shouldFallbackTierB: no marker required", !shouldFallbackTierB({ ok: true, timedOut: false, output: "any output" }));

// config resolution: absent models block → every role stays tier A
for (const role of ["strategist", "planner", "forensic", "reviewerEscalation"] as const) {
  check(`p1-059 no models block → tier A for ${role}`, tierBModelFor(undefined, role) === undefined);
}
check(
  "p1-059 tierB block resolves per-role models",
  tierBModelFor({ tierB: { planner: "fable-5.1", reviewerEscalation: "opus" } }, "planner") === "fable-5.1" &&
    tierBModelFor({ tierB: { planner: "fable-5.1" } }, "reviewerEscalation") === undefined,
);
check(
  "p1-059 normalizeModels keeps string values, drops garbage",
  JSON.stringify(normalizeModels({ tierA: { builder: "glm-5.3-flash", scribe: 3 }, tierB: { planner: " opus " } })) ===
    JSON.stringify({ tierA: { builder: "glm-5.3-flash" }, tierB: { planner: "opus" } }),
);
check("p1-059 normalizeModels: non-object → undefined", normalizeModels("nope") === undefined && normalizeModels(null) === undefined);
check("p1-059 normalizeModels: empty tiers → undefined", normalizeModels({ tierA: {}, tierB: { planner: "" } }) === undefined);

// escalation table (P1-059 acceptance): divergent ⇒ true; both APPROVE ⇒ false; round>1 ⇒ false
check("p1-059 needsEscalation: divergent round 1", needsEscalation(1, true, false, false, false) && needsEscalation(1, false, true, false, false));
check("p1-059 needsEscalation: both approve round 1", !needsEscalation(1, true, true, false, false));
check("p1-059 needsEscalation: both reject with kept findings", !needsEscalation(1, false, false, false, false));
check("p1-059 needsEscalation: all-dropped triggers", needsEscalation(1, true, true, true, false) && needsEscalation(1, false, false, false, true));
check("p1-059 needsEscalation: never past round 1", !needsEscalation(2, true, false, true, true));

// forensic guards + report extraction
check("p1-059 forensicDue: never ran", forensicDue(undefined) === true);
check("p1-059 forensicDue: unparsable date", forensicDue("not-a-date") === true);
check("p1-059 forensicDue: within 7 days", !forensicDue(new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()));
check("p1-059 forensicDue: older than 7 days", forensicDue(new Date(Date.now() - (FORENSIC_WINDOW_MS + 60_000)).toISOString()));
check("p1-059 extractReport: body before marker, echo-safe", extractReport("REPORT\nFORENSIC:DONE is the marker\nmore\nFORENSIC:DONE") === "REPORT\nFORENSIC:DONE is the marker\nmore");
check("p1-059 extractReport: missing marker keeps everything", extractReport("just a report") === "just a report");
check("p1-059 forensicPrompt carries the sections + marker", forensicPrompt("l1", [{ task: "P9-001", step: "unit" }], "abc1234 x").includes("## Patterns") && forensicPrompt("l1", [{ task: "P9-001", step: "unit" }], "abc1234 x").includes(FORENSIC_MARKER));
check("p1-059 listGateFails: missing dir → []", listGateFails(join(tmpdir(), `no-such-dir-${Date.now()}`)).length === 0);
{
  const dir = mkdtempSync(join(tmpdir(), "gatefail-sort-"));
  try {
    for (const [i, name] of ["a.json", "b.json", "c.json"].entries()) {
      writeFileSync(join(dir, name), JSON.stringify({ task: name.replace(".json", ""), step: `s-${i}` }));
    }
    // b.json newest, then c.json, then a.json (round-2 finding: newest first)
    utimesSync(join(dir, "a.json"), new Date(1_000_000), new Date(1_000_000));
    utimesSync(join(dir, "b.json"), new Date(3_000_000), new Date(3_000_000));
    utimesSync(join(dir, "c.json"), new Date(2_000_000), new Date(2_000_000));
    const fails = listGateFails(dir);
    check("p1-059 listGateFails: sorted by mtime desc", fails.map((f) => f.task).join(",") === "b,c,a");
    const capped = listGateFails(dir, 2);
    check("p1-059 listGateFails: cap keeps most recent", capped.length === 2 && capped[0].task === "b" && capped[1].task === "c");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- P1-035: aux agents feed the self-watchdog (silent strategist must not kill the pilot) ---

{
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let beats = 0;
  const stop = startHeartbeat(20, () => beats++);
  await sleep(70);
  stop();
  const armedBeats = beats;
  stop(); // idempotent — a second call must not throw or double-clear
  await sleep(70);
  check("p1-035 startHeartbeat: touches >=2x while armed", armedBeats >= 2);
  check("p1-035 startHeartbeat: stop() halts all touches", beats === armedBeats);
}

{
  // Backlog criterion: a 6min-silent strategist must not starve the watchdog.
  // Scale 1:1 — silent child for 300ms, heartbeat every 20ms.
  let beats = 0;
  const silentSpawn = (() => spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),300)"])) as unknown as typeof spawn;
  const r = await runAgent("p1-035 silent strategist", {
    cwd: tmpdir(),
    timeoutMin: 5,
    label: "t",
    preflight: async () => true,
    spawnImpl: silentSpawn,
    heartbeatMs: 20,
    heartbeatTouch: () => beats++,
  });
  check("p1-035 runAgent: silent agent resolves ok with empty output", r.ok === true && r.output === "" && !r.timedOut);
  check("p1-035 runAgent: silent agent fed the watchdog (>=2 beats in 300ms)", beats >= 2);
}

{
  // Edge case: preflight failure must not leak a heartbeat interval (nothing armed, no touches).
  let beats = 0;
  const r = await runAgent("p1-035 preflight down", {
    cwd: tmpdir(),
    timeoutMin: 5,
    label: "t",
    preflight: async () => false,
    heartbeatMs: 20,
    heartbeatTouch: () => beats++,
  });
  await new Promise<void>((r2) => setTimeout(r2, 70));
  check("p1-035 runAgent: preflight failure aborts before spawn", r.ok === false && r.output.includes("[preflight]"));
  check("p1-035 runAgent: no heartbeat armed on preflight failure", beats === 0);
}

// --- P1-061: local direct-mode transport ------------------------------------

check("p1-061 localWsUrl builds ws://127.0.0.1:<port>/ws?token=…", localWsUrl(8792, "tok") === "ws://127.0.0.1:8792/ws?token=tok");
check("p1-061 localWsUrl encodes the token", localWsUrl(8792, "a/b c") === "ws://127.0.0.1:8792/ws?token=a%2Fb%20c");
check("p1-061 failover predicate: 0 and 1 failures stay sticky local", !shouldFailoverToRelay(0) && !shouldFailoverToRelay(1));
check("p1-061 failover predicate: 2 consecutive failures hand over to relay", shouldFailoverToRelay(2) && shouldFailoverToRelay(3));
check("p1-061 isLoopbackAddr: v4, v6 and v4-mapped", isLoopbackAddr("127.0.0.1") && isLoopbackAddr("::1") && isLoopbackAddr("::ffff:127.0.0.1"));
check("p1-061 isLoopbackAddr: foreign addr rejected", !isLoopbackAddr("192.168.1.10") && !isLoopbackAddr(undefined));
check("p1-061 origin: absent (non-browser) allowed", localOriginAllowed(undefined));
check("p1-061 origin: Electron loadFile allowed", localOriginAllowed("null") && localOriginAllowed("file://"));
check("p1-061 origin: loopback pages allowed", localOriginAllowed("http://127.0.0.1:5173") && localOriginAllowed("http://localhost:5173"));
check("p1-061 origin: arbitrary web pages rejected", !localOriginAllowed("https://evil.example") && !localOriginAllowed("not-a-url"));
check(
  "p1-061 upgrade predicate: exact path + loopback + origin + token",
  localUpgradeAllowed("/ws", "tok", "127.0.0.1", undefined, "tok") &&
    !localUpgradeAllowed("/other", "tok", "127.0.0.1", undefined, "tok") &&
    !localUpgradeAllowed("/ws", "tok", "192.168.1.10", undefined, "tok") &&
    !localUpgradeAllowed("/ws", "bad", "127.0.0.1", undefined, "tok") &&
    !localUpgradeAllowed("/ws", null, "127.0.0.1", undefined, "tok") &&
    !localUpgradeAllowed("/ws", "tok", "127.0.0.1", "https://evil.example", "tok"),
);
// log hygiene: the token rides in the upgrade query — no log call may ever
// include it (acceptance criterion "nenhum log contém token=")
{
  const daemonSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const leaky = daemonSrc.split("\n").filter((l) => l.includes("log(") && l.includes("token="));
  check("p1-061 no daemon log call contains token=", leaky.length === 0);
}

// --- P1-046: desktop shell v2 view-state reducer -----------------------------
{
  const base: ViewState = initialViewState;
  const chat = viewReducer(base, { type: "openChat", sessionId: "s1" });
  check(
    "p1-046 openChat sets chatSession and pushes the chat slot",
    chat.chatSession === "s1" && topSlot(chat) === "chat" && isPaneOpen(chat) === false,
  );
  const withArtifacts = viewReducer(chat, { type: "open", slot: "artifacts" });
  check(
    "p1-046 opening a pane keeps the active chat (chat + artifact coexist)",
    withArtifacts.chatSession === "s1" && topSlot(withArtifacts) === "artifacts" && isPaneOpen(withArtifacts),
  );
  const withFiles = viewReducer(withArtifacts, { type: "open", slot: "files" });
  const slots = activeSlots(withFiles);
  check(
    "p1-046 opening a second pane leaves exactly ONE active rail slot",
    slots.size === 1 && slots.has("files") && !slots.has("artifacts"),
  );
  const backToArtifacts = viewReducer(withFiles, { type: "back" });
  check(
    "p1-046 back() pops the pane stack",
    topSlot(backToArtifacts) === "artifacts" && backToArtifacts.chatSession === "s1",
  );
  const backToChat = viewReducer(backToArtifacts, { type: "back" });
  check(
    "p1-046 back() to chat keeps the session",
    topSlot(backToChat) === "chat" && backToChat.chatSession === "s1",
  );
  const backHome = viewReducer(backToChat, { type: "back" });
  check(
    "p1-046 back() from chat closes the conversation and lands home",
    backHome.chatSession === null && backHome.stack.length === 0 && isPaneOpen(backHome) === false,
  );
  check(
    "p1-046 topSlot falls back to chat on the home screen",
    topSlot(base) === "chat" && activeSlots(base).has("chat"),
  );
  const share = viewReducer(chat, { type: "open", slot: "share" });
  const shareClosed = viewReducer(share, { type: "back" });
  check(
    "p1-046 share enters and leaves the stack without touching the chat",
    topSlot(share) === "share" && topSlot(shareClosed) === "chat" && shareClosed.chatSession === "s1",
  );
  const noDupes = viewReducer(viewReducer(chat, { type: "open", slot: "files" }), { type: "open", slot: "files" });
  check(
    "p1-046 the stack never holds duplicates",
    noDupes.stack.filter((s) => s === "files").length === 1 && noDupes.stack.length === 2,
  );
  const replaced = viewReducer(viewReducer(chat, { type: "open", slot: "settings" }), {
    type: "replace",
    slot: "files",
  });
  check(
    "p1-046 replace() swaps the top slot, preserving the chat below",
    topSlot(replaced) === "files" && replaced.stack.length === 2 && replaced.stack[0] === "chat",
  );
  const wiped = viewReducer(withArtifacts, { type: "reset" });
  check(
    "p1-046 reset() clears the whole view state (disconnect/switchMachine)",
    wiped.stack.length === 0 && wiped.chatSession === null,
  );
  check("p1-046 back() on the home screen is a no-op", viewReducer(base, { type: "back" }) === base);
  const closeChat = viewReducer(chat, { type: "closeChat" });
  check(
    "p1-046 closeChat clears the session and drops the chat slot",
    closeChat.chatSession === null && !closeChat.stack.includes("chat"),
  );
}

// --- doc2pdf: extension allowlist + converter pick (P2-065) -----------------
const SOFFICE_CONV = { kind: "soffice", bin: "/app/LibreOffice.app/soffice", exts: [...ALLOWED_EXTS] };
const NATIVE_CONV = {
  kind: "native",
  textutil: "/usr/bin/textutil",
  cupsfilter: "/usr/sbin/cupsfilter",
  exts: ["doc", "docx", "rtf", "html", "csv"],
};
check("doc2pdf allowlist is exactly the office formats", ALLOWED_EXTS.join(" ") === "docx doc rtf html csv xlsx pptx");
for (const ext of ALLOWED_EXTS) {
  check(`doc2pdf accepts .${ext}`, validateExt(`relatorio.${ext}`).ok && validateExt(`relatorio.${ext}`).ext === ext);
}
check("doc2pdf rejects disallowed extension", !validateExt("payload.exe").ok);
check("doc2pdf rejects file without extension", !validateExt("README").ok);
check("doc2pdf rejects dotfile as extension-less", !validateExt(".hidden").ok);
check("doc2pdf rejects trailing-dot name", !validateExt("file.").ok);
check("doc2pdf accepts uppercase extensions", validateExt("Doc.REPORT.DOCX").ok);
check("doc2pdf empty ext is empty string", extOf("file.") === "");
check("doc2pdf soffice wins wherever it appears", pickConverter("darwin", [NATIVE_CONV, SOFFICE_CONV]) === SOFFICE_CONV);
check("doc2pdf falls back to native on darwin", pickConverter("darwin", [NATIVE_CONV]) === NATIVE_CONV);
check("doc2pdf native unusable on linux", pickConverter("linux", [NATIVE_CONV]) === null);
check("doc2pdf soffice usable on linux", pickConverter("linux", [SOFFICE_CONV]) === SOFFICE_CONV);
check("doc2pdf no candidates means no converter", pickConverter("darwin", []) === null);
check("doc2pdf malformed candidates are ignored", pickConverter("darwin", [undefined, {}, { kind: "soffice" }] as never) === null);
check("doc2pdf non-array candidates fail graceful", pickConverter("darwin", "soffice" as never) === null);

// --- P2-048: forensic index from real pilot.log shapes -----------------------
// Fixture mirrors the two real timestamp formats: pilot.log uses local -03:00,
// events.jsonl uses UTC Z — sorting must be by parsed instant, not string.
const FORENSIC_LOG = [
  '{"ts":"2026-09-01T10:00:00-03:00","level":"info","msg":"pipeline start","data":{"task":"P9-001","title":"Fix the thing","slot":1}}',
  '{"ts":"2026-09-01T10:00:30-03:00","level":"info","msg":"planner","data":{"task":"P9-001"}}',
  '{"ts":"2026-09-01T10:01:00-03:00","level":"info","msg":"agent","data":"Lendo o spec e os arquivos afetados."}',
  '{"ts":"2026-09-01T10:02:00-03:00","level":"info","msg":"builder round","data":{"task":"P9-001","round":1}}',
  '{"ts":"2026-09-01T10:12:00-03:00","level":"info","msg":"builder done","data":{"task":"P9-001","round":1}}',
  '{"ts":"2026-09-01T10:13:00-03:00","level":"info","msg":"reviewers start","data":{"task":"P9-001","round":1}}',
  '{"ts":"2026-09-01T10:15:00-03:00","level":"info","msg":"reviewers done","data":{"task":"P9-001","round":1,"secOk":true,"qualOk":false}}',
  '{"ts":"2026-09-01T10:15:01-03:00","level":"warn","msg":"gatekeeper fail","data":{"task":"P9-001","step":"evidence","tail":"npm run typecheck\\nERR!"}}',
  '{"ts":"2026-09-01T10:16:00-03:00","level":"info","msg":"builder round","data":{"task":"P9-001","round":2}}',
  '{"ts":"2026-09-01T10:20:00-03:00","level":"info","msg":"builder done","data":{"task":"P9-001","round":2}}',
  '{"ts":"2026-09-01T10:21:00-03:00","level":"info","msg":"pipeline result","data":{"task":"P9-001","ok":true,"slot":1,"detail":"task P9-001 merged"}}',
  '{"ts":"2026-09-01T10:21:30-03:00","level":"info","msg":"deploy result","data":{"task":"P9-001","ok":true,"rolledBack":false,"detail":"sha 1a2b3c4 done in 40s"}}',
  '{"ts":"2026-09-01T10:22:00-03:00","level":"info","msg":"scribe","data":{"task":"P9-001","msg":"committed 2 lesson(s)"}}',
  // second task: still running, narration must attribute to the latest context
  '{"ts":"2026-09-01T11:00:00-03:00","level":"info","msg":"pipeline start","data":{"task":"P9-002","title":"Add the other thing","slot":2}}',
  '{"ts":"2026-09-01T11:01:00-03:00","level":"info","msg":"builder round","data":{"task":"P9-002","round":1}}',
  '{"ts":"2026-09-01T11:02:00-03:00","level":"info","msg":"agent","data":"Escrevendo o widget agora."}',
  '{"ts":"2026-09-01T11:20:00-03:00","level":"info","msg":"planner","data":{"task":"P9-003"}}',
  // unattributed narration AFTER a task line without task field → P9-003
  '{"ts":"2026-09-01T11:21:00-03:00","level":"info","msg":"agent","data":"Planejando."}',
];
const FORENSIC_EVENTS = [
  '{"ts":"2026-09-01T13:05:00.000Z","type":"agent","task":"P9-001","detail":"Decisão estruturada vinda do events.jsonl."}',
];
const idx = buildForensicIndex(FORENSIC_LOG, FORENSIC_EVENTS);
const t1 = idx.timelines.get("P9-001")!;
check("forensic: task with pipeline start builds timeline", !!t1 && t1.length > 5);
check("forensic: title captured from pipeline start", idx.titles.get("P9-001") === "Fix the thing");
check(
  "forensic: timeline sorted by parsed instant across sources",
  t1.map((e) => e.ts).every((ts, i, a) => i === 0 || Date.parse(a[i - 1]) <= Date.parse(ts)),
);
const card1 = buildCards(idx.timelines, idx.titles).find((c) => c.id === "P9-001")!;
check("forensic: merged card status", card1.status === "merged");
check("forensic: rounds counted from phase entries", card1.rounds === 2);
check("forensic: gate fails counted", card1.gateFails === 1);
check("forensic: effort in minutes from wall clock", card1.effortMin === 21);
check("forensic: merge sha parsed from deploy detail", card1.mergeSha === "1a2b3c4");
check("forensic: decisions include events.jsonl narration", card1.decisions === 2);
check("forensic: gate tail kept for navigation", t1.some((e) => e.kind === "gate" && e.step === "evidence" && e.tail.includes("ERR!")));
const card2 = buildCards(idx.timelines, idx.titles, { avgDoneMs: 30 * 60_000, nowMs: Date.parse("2026-09-01T11:10:00-03:00") }).find((c) => c.id === "P9-002")!;
check("forensic: running card without result", card2.status === "running" && card2.effortMin === null);
check("forensic: ETA projects avg minus elapsed", card2.etaMs === 20 * 60_000);
check("forensic: narration attributed to latest task context", idx.timelines.get("P9-003")?.some((e) => e.text === "Planejando.") === true);
const avg = avgDoneDuration(idx.timelines);
check("forensic: avg duration from ok results only", avg !== undefined && Math.abs(avg! - 21 * 60_000) < 60_000);
check("forensic: progress full for merged task", progressOf(idx.timelines.get("P9-001")!) === 1);
check("forensic: partial progress for running", progressOf(idx.timelines.get("P9-002")!) === 1 / 6);
check("forensic: shots filtered by task prefix", shotsForTask("P9-001", ["P9-001-1a2b3c4-123.png", "P9-010-9x-1.png", "notes.png"]).join(",") === "P9-001-1a2b3c4-123.png");
check("forensic: shot path validation rejects traversal", shotPath("../daemon.json") === null && shotPath("a/b.png") === null);
check("forensic: shot path accepts real shape", shotPath("P9-001-1a2b3c4-1788325050913.png")?.endsWith("pilot/shots/P9-001-1a2b3c4-1788325050913.png") === true);
check(
  "forensic: takeover extraction from real builder log lines",
  (() => {
    const { directory, sessionId } = takeoverFromBuilderLog([
      'timestamp=2026-09-02T04:05:17.340Z level=INFO run=1 message="creating instance" directory=/ws/repo-2',
      'timestamp=2026-09-02T04:05:17.511Z level=INFO run=1 message=created id=ses_abc123def456 directory=/ws/repo-2 tokens.input=0',
    ]);
    return directory === "/ws/repo-2" && sessionId === "ses_abc123def456";
  })(),
);
// P2-048 round 2: takeover target validation (hostile log values must die here)
const HOME = homedir();
check(
  "takeover: real workspace clone accepted",
  validateTakeoverDirectory(`${HOME}/.opencode-remote/pilot/repo-2`, HOME) === `${HOME}/.opencode-remote/pilot/repo-2`,
);
check("takeover: shell breakout rejected", validateTakeoverDirectory('foo"; touch /tmp/pwn; echo "', HOME) === null);
check("takeover: $() command substitution rejected", validateTakeoverDirectory(`${HOME}/.opencode-remote/pilot/repo-2$(id)`, HOME) === null);
check("takeover: backtick substitution rejected", validateTakeoverDirectory("repo-`id`", HOME) === null);
check("takeover: AppleScript trailing-backslash breakout rejected", validateTakeoverDirectory(`${HOME}/.opencode-remote/pilot/repo-2\\`, HOME) === null);
check("takeover: single quote rejected (shell quote escape)", validateTakeoverDirectory(`${HOME}/.opencode-remote/pilot/repo-2'`, HOME) === null);
check("takeover: path escaping the pilot root rejected", validateTakeoverDirectory(`${HOME}/.opencode-remote/pilot/../evil/repo-1`, HOME) === null);
check("takeover: path outside pilot root rejected", validateTakeoverDirectory("/tmp/repo-2", HOME) === null);
check("takeover: non-repo child of pilot root rejected", validateTakeoverDirectory(`${HOME}/.opencode-remote/pilot/checkpoints`, HOME) === null);
check("takeover: relative path rejected", validateTakeoverDirectory("repo-2", HOME) === null);
check("takeover: missing value rejected", validateTakeoverDirectory(undefined, HOME) === null);
check("takeover: session id only ses_<alnum>", validateTakeoverSessionId("ses_abc123def456") === "ses_abc123def456");
check("takeover: hostile session id rejected", validateTakeoverSessionId('ses_x; rm -rf ~; echo "') === null);
check("takeover: missing session id rejected", validateTakeoverSessionId(undefined) === null);

// --- i18n dictionary parity (P2-049) -------------------------------------------
// The web UI ships two locales from one dict; a key that exists only in one
// language silently falls back to English (or the raw key) at runtime.
const enKeys = Object.keys(dict.en).sort();
const ptKeys = Object.keys(dict.pt).sort();
check("i18n: en and pt share the exact same key set", JSON.stringify(enKeys) === JSON.stringify(ptKeys));
check("i18n: no empty strings in either locale", enKeys.every((k) => String((dict.en as Record<string, string>)[k]).trim() !== "") && ptKeys.every((k) => String((dict.pt as Record<string, string>)[k]).trim() !== ""));
check("i18n: vars interpolatable in both locales", ["queued", "reconnecting", "olderMessages", "changesFor", "connTitle"].every((k) => String((dict.en as Record<string, string>)[k]).includes("{") && String((dict.pt as Record<string, string>)[k]).includes("{")));

// --- P2-028 per-task token costs from opencode.db -----------------------------
{
  const SESS = { id: "ses_abc123456", tokens_input: 1000, tokens_output: 100, tokens_cache_read: 20, tokens_cache_write: 5 };
  check("costs: session id charset guard", isSessionId("ses_abc123456") && !isSessionId("ses_ab; rm") && !isSessionId("myses_abc123456") && !isSessionId("nope"));
  check("costs: total sums input+output+both caches", sessionTotalTokens(SESS) === 1125);

  const json = JSON.stringify([SESS, { id: "junk; DROP", tokens_input: 9, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0 }]);
  const parsed = parseSessionTokens(json);
  check("costs: parser keeps canonical ids only", parsed.ses_abc123456 === 1125 && !("junk; DROP" in parsed));
  check("costs: parser survives garbage", Object.keys(parseSessionTokens("not json")).length === 0);

  check("costs: sql inlines validated ids", tokensSql(["ses_abc123456"]).includes("IN ('ses_abc123456')"));
  const viaQuery = await querySessionTokens(["ses_abc123456"], "/tmp/fake.db", async () => json);
  check("costs: query maps session → total tokens", viaQuery.ses_abc123456 === 1125);
  // round 2 (review): the sqlite call is async — a rejected exec must reject
  // the promise (caught by the runSlot try/catch), never throw synchronously
  let rejected = false;
  try {
    await querySessionTokens(["ses_abc123456"], "/tmp/fake.db", async () => {
      throw new Error("db locked");
    });
  } catch {
    rejected = true;
  }
  check("costs: query failure rejects instead of throwing sync", rejected);

  const store: { taskCosts: Record<string, number>; taskCostSessions: Record<string, string[]> } = { taskCosts: {}, taskCostSessions: {} };
  await applySessionCosts(store, "P2-028", ["ses_abc123456", "glued_ses_x"], async () => ({ ses_abc123456: 1000 }));
  check("costs: applySessionCosts records the task total", store.taskCosts["P2-028"] === 1000);
  check("costs: non-session ids are filtered before the query", JSON.stringify(store.taskCostSessions["P2-028"]) === JSON.stringify(["ses_abc123456"]));
  // recompute semantics: a resumed session GROWS — the stored total is replaced,
  // never added twice, and re-applied ids are deduped
  await applySessionCosts(store, "P2-028", ["ses_abc123456"], async () => ({ ses_abc123456: 2500 }));
  check("costs: re-applied session recomputes instead of double counting", store.taskCosts["P2-028"] === 2500);
  await applySessionCosts(store, "P2-028", ["ses_def6789012"], async () => ({ ses_abc123456: 2500, ses_def6789012: 500 }));
  check("costs: a second session adds to the task total", store.taskCosts["P2-028"] === 3000);
  // a transient DB failure keeps the previous honest total; the id stays
  // recorded so the next reconciliation picks it up once the DB has it
  await applySessionCosts(store, "P2-028", ["ses_ghi9012345"], async () => ({}));
  check("costs: failed DB read keeps the previous total", store.taskCosts["P2-028"] === 3000 && store.taskCostSessions["P2-028"].length === 3);
  // unknown task id never reaches the store
  await applySessionCosts(store, "../evil", ["ses_abc123456"], async () => ({ ses_abc123456: 1 }));
  check("costs: hostile task id is ignored", !("../evil" in store.taskCosts));
  // rolling window keeps state.json bounded
  const big: { taskCosts: Record<string, number>; taskCostSessions: Record<string, string[]> } = { taskCosts: {}, taskCostSessions: {} };
  for (let i = 0; i < TASK_COST_CAP + 10; i++) {
    big.taskCosts[`P9-${i}`] = i;
    big.taskCostSessions[`P9-${i}`] = [`ses_abc${String(i).padStart(6, "0")}`];
  }
  pruneTaskCosts(big);
  check("costs: rolling window prunes oldest tasks", Object.keys(big.taskCosts).length === TASK_COST_CAP && !("P9-0" in big.taskCosts) && "P9-209" in big.taskCostSessions);
}

// --- P1-030 pilot doctor: deterministic, idempotent repair pass -----------------
{
  const REF_SEQ = [
    "git rev-parse HEAD",
    "git fetch origin",
    "git checkout -q main",
    "git reset -q --hard origin/main",
    "git clean -qfd",
    "git rev-parse HEAD",
  ];
  const mkRun = (opts: { heads?: string[]; fail?: string[] } = {}) => {
    const ran: string[] = [];
    const heads = opts.heads ?? ["aaaa111", "bbbb222"];
    let headIdx = 0;
    const run: RunFn = (cmd) => {
      ran.push(cmd);
      if (cmd === "git rev-parse HEAD") return { ok: true, output: `${heads[Math.min(headIdx++, heads.length - 1)]}\n` };
      if (opts.fail?.includes(cmd)) return { ok: false, output: "boom\n" };
      return { ok: true, output: "" };
    };
    return { ran, run };
  };

  {
    const { ran, run } = mkRun();
    const r = doctorRefs("/ws", run);
    check("doctor refs: runs the exact fetch+reset+clean sequence", ran.join("|") === REF_SEQ.join("|"));
    check("doctor refs: ok and reports the HEAD move", r.ok && r.changed && r.detail.includes("bbbb222"));
  }
  {
    const { run } = mkRun({ heads: ["aaaa111", "aaaa111"] });
    const r = doctorRefs("/ws", run);
    check("doctor refs: idempotent — same HEAD logs changed=false", r.ok && !r.changed);
  }
  {
    const { run } = mkRun({ fail: ["git reset -q --hard origin/main"] });
    const r = doctorRefs("/ws", run);
    check("doctor refs: failed reset reports the step", !r.ok && r.detail.includes("git reset -q --hard origin/main"));
  }

  check("doctor backlog: healthy sections + unique ids", validateBacklog("## Ready\n\n- [ ] (P9-001) [P1] A — spec: x\n\n## Done\n- [x] (P9-000) [P1] Old — done\n").ok);
  check("doctor backlog: missing ## Done is a problem", !validateBacklog("## Ready\n- [ ] (P9-001) [P1] A — spec: x\n").ok);
  check("doctor backlog: missing ## Ready is a problem", !validateBacklog("## Done\n- [x] (P9-000) [P1] Old — done\n").ok);
  {
    const md = "## Ready\n\n- [ ] (P9-001) [P1] A — spec: x\n- [ ] (P9-002) [P2] B — spec: y\n\n## Done\n- [x] (P9-001) [P1] A — done\n";
    const d = validateBacklog(md);
    check("doctor backlog: duplicate ids detected across sections", !d.ok && d.duplicateIds.join(",") === "P9-001" && d.taskCount === 2);
  }
  {
    const d = validateBacklog("## Ready\n- [ ] (P9-001) [P1] mentions (P9-002) mid-spec — spec: x\n## Done\n");
    check("doctor backlog: ids quoted inside a spec are not duplicates", d.ok && d.duplicateIds.length === 0);
  }
  {
    const dir = mkdtempSync(join(tmpdir(), "pilot-doctor-"));
    try {
      writeFileSync(join(dir, "BACKLOG.md"), "## Ready\n\n- [ ] (P9-001) [P1] A — spec: x\n\n## Done\n");
      const d = doctorBacklog(dir);
      check("doctor backlog: loadBacklog path counts ready tasks", d.ok && d.taskCount === 1);
      rmSync(join(dir, "BACKLOG.md"));
      const missing = doctorBacklog(dir);
      check("doctor backlog: missing file is a finding, not a crash", !missing.ok && missing.problems[0]?.includes("loadBacklog failed"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const st: PilotState = {
      date: "2026-09-02",
      tasks: 0,
      deploys: 0,
      failures: 0,
      merges: 0,
      taskAttempts: { "P9-001": 2, "P9-002": 1 },
    };
    check("doctor attempts: clear one id", clearTaskAttempts(st, "P9-001") === 1 && st.taskAttempts["P9-001"] === undefined && st.taskAttempts["P9-002"] === 1);
    check("doctor attempts: clearing an unknown id is a no-op", clearTaskAttempts(st, "P9-999") === 0);
    check("doctor attempts: clear all", clearTaskAttempts(st) === 1 && Object.keys(st.taskAttempts).length === 0);
    check("doctor attempts: clearing empty state stays zero", clearTaskAttempts(st) === 0);
    const legacy = { date: "", tasks: Number.NaN, deploys: 0, failures: 0, taskAttempts: undefined } as unknown as PilotState;
    const n = normalizePilotState(legacy);
    check("doctor state: normalizePilotState fills schema defaults", n.merges === 0 && n.tasks === 0 && n.date.length === 10 && JSON.stringify(n.taskAttempts) === "{}" && Array.isArray(n.cycles) && Array.isArray(n.blockEvents) && n.auditMode === null && JSON.stringify(n.taskCosts) === "{}");
  }

  {
    // P1-030 round 2: the CLI argv dispatch is where the destructive default
    // hid — table-drive every form against a throwaway state file.
    const table: [string, string[], AttemptsRequest["mode"], string | undefined][] = [
      ["no flag reports", ["doctor.ts", "attempts"], "report", undefined],
      ["--clear <id> clears one", ["doctor.ts", "attempts", "--clear", "P9-001"], "clear", "P9-001"],
      ["bare --clear errors", ["doctor.ts", "attempts", "--clear"], "error", undefined],
      ["--clear <garbage> errors", ["doctor.ts", "attempts", "--clear", "garbage;rm"], "error", undefined],
      ["--clear <unknown id> errors", ["doctor.ts", "attempts", "--clear", "P9-99"], "error", undefined],
    ];
    for (const [name, argv, mode, id] of table) {
      const req = parseAttemptsArgs(argv);
      check(`doctor attempts args: ${name}`, req.mode === mode && (mode !== "clear" || req.id === id));
    }
    const dir = mkdtempSync(join(tmpdir(), "pilot-doctor-cli-"));
    try {
      const file = join(dir, "state.json");
      writeFileSync(file, JSON.stringify({ taskAttempts: { "P9-001": 2 } }));
      const logs: string[] = [];
      const sink = (level: string, msg: string, data?: unknown) => logs.push(`${level}:${msg}`);
      check("doctor attempts cli: report leaves every counter alone", runAttemptsCommand(["doctor.ts", "attempts"], file, sink) && JSON.parse(readFileSync(file, "utf8")).taskAttempts["P9-001"] === 2);
      check("doctor attempts cli: bare --clear is rejected", !runAttemptsCommand(["doctor.ts", "attempts", "--clear"], file, sink) && JSON.parse(readFileSync(file, "utf8")).taskAttempts["P9-001"] === 2);
      check("doctor attempts cli: --clear <id> clears and persists", runAttemptsCommand(["doctor.ts", "attempts", "--clear", "P9-001"], file, sink) && JSON.parse(readFileSync(file, "utf8")).taskAttempts["P9-001"] === undefined);
      check("doctor attempts cli: garbage id rejected", !runAttemptsCommand(["doctor.ts", "attempts", "--clear", "garbage;rm"], file, sink) && !("garbage;rm" in JSON.parse(readFileSync(file, "utf8")).taskAttempts));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const dir = mkdtempSync(join(tmpdir(), "pilot-doctor-state-"));
    try {
      const file = join(dir, "state.json");
      writeFileSync(file, JSON.stringify({ date: "2026-09-02", tasks: "many", taskAttempts: "nope" }));
      const first = doctorState(file);
      const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      check("doctor state: legacy/garbage fields normalized", first.ok && first.changed && after.tasks === 0 && after.merges === 0 && JSON.stringify(after.taskAttempts) === "{}" && Array.isArray(after.cycles) && after.auditMode === null);
      const second = doctorState(file);
      check("doctor state: idempotent — second pass changes nothing", second.ok && !second.changed);
      writeFileSync(file, "{corrupt json");
      const third = doctorState(file);
      const repaired = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      check("doctor state: corrupt file reset to defaults", third.ok && third.changed && repaired.tasks === 0 && typeof repaired.date === "string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const mkBranchRun = (current: string) => {
      const ran: string[] = [];
      const run: RunFn = (cmd) => {
        ran.push(cmd);
        if (cmd === "git for-each-ref --format=%(refname:short) refs/heads/pilot/*")
          return { ok: true, output: "pilot/P9-001\npilot/P9-002\npilot/P9-003\npilot/P9-004\n" };
        if (cmd === "git rev-parse --abbrev-ref HEAD") return { ok: true, output: `${current}\n` };
        return { ok: true, output: "" };
      };
      return { ran, run };
    };
    const gh = (out: Record<string, string>, failKeys: string[] = []): RunFn => (cmd) => {
      const hit = Object.entries(out).find(([k]) => cmd.includes(k));
      if (hit) return { ok: !failKeys.some((f) => cmd.includes(f)), output: hit[1] };
      return { ok: false, output: "" };
    };
    {
      const { run } = mkBranchRun("main");
      const r = doctorBranches("/ws", {
        run,
        gh: gh({ "pilot/P9-001": "[]", "pilot/P9-002": '[{"number":1}]', "pilot/P9-003": "[]", "pilot/P9-004": "[]" }, ["pilot/P9-003"]),
        protectedIds: new Set(["P9-004"]),
      });
      check("doctor branches: deletes only PR-less branches", r.ok && r.changed && r.detail.includes("deleted: pilot/P9-001"));
      check("doctor branches: open PR is skipped", r.detail.includes("pilot/P9-002 (open PR)"));
      check("doctor branches: gh failure is fail-safe (skip)", r.detail.includes("pilot/P9-003 (gh unavailable)"));
      check("doctor branches: preserved retry branch is protected", r.detail.includes("pilot/P9-004 (preserved for retry)"));
      check("doctor branches: protected branch is not deleted", !r.detail.includes("deleted: pilot/P9-004") && !r.detail.includes("deleted: pilot/P9-002"));
    }
    {
      const { run } = mkBranchRun("pilot/P9-001");
      const r = doctorBranches("/ws", {
        run,
        gh: gh({ "pilot/P9-001": "[]" }),
        protectedIds: new Set(["P9-002"]),
      });
      check("doctor branches: checked-out branch never deleted", r.detail.includes("pilot/P9-001 (checked out)") && !r.changed);
      check("doctor branches: preserved retry branch is protected", r.detail.includes("pilot/P9-002 (preserved for retry)"));
    }
    {
      const { run } = mkBranchRun("main");
      const r = doctorBranches("/ws", { run, gh: () => ({ ok: false, output: "" }) });
      check("doctor branches: gh down skips every branch", r.ok && !r.changed && r.detail.includes("gh unavailable"));
    }
    {
      // shell-injection guard: a refname that is not pilot/<TASK_ID> must never
      // reach the gh probe or `git branch -D` (both run via a shell)
      const probed: string[] = [];
      const run: RunFn = (cmd) => {
        if (cmd.startsWith("git for-each-ref")) return { ok: true, output: "pilot/evil;rm\npilot/P9-001\n" };
        return { ok: true, output: "" };
      };
      const ghRun: RunFn = (cmd) => {
        probed.push(cmd);
        return { ok: true, output: "[]" };
      };
      const r = doctorBranches("/ws", { run, gh: ghRun });
      check("doctor branches: off-shape refname skipped unmanaged", r.ok && r.detail.includes("pilot/evil;rm (invalid refname)"));
      check("doctor branches: off-shape refname never reaches a shell command", probed.every((c) => !c.includes("evil")) && !r.detail.includes("deleted: pilot/evil;rm"));
      check("doctor branches: valid task branch still deleted next to it", r.changed && r.detail.includes("deleted: pilot/P9-001"));
    }
    {
      // a failed `git branch -D` means the repair did not happen — ok must be false
      const run: RunFn = (cmd) => {
        if (cmd.startsWith("git for-each-ref")) return { ok: true, output: "pilot/P9-001\n" };
        if (cmd === "git rev-parse --abbrev-ref HEAD") return { ok: true, output: "main\n" };
        if (cmd.startsWith("git branch -D")) return { ok: false, output: "error: branch locked\n" };
        return { ok: true, output: "" };
      };
      const r = doctorBranches("/ws", { run, gh: () => ({ ok: true, output: "[]" }) });
      check("doctor branches: failed deletion reports ok=false", !r.ok && r.detail.includes("pilot/P9-001 (delete failed)"));
    }
  }
}

if (failures > 0) {
  console.error(`UNIT TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("UNIT TESTS PASSED");
process.exit(0);
