/**
 * Unit tests for pure glue code the e2e scripts don't cover.
 * Run: npx tsx scripts/unit.test.ts
 */
// P2-120: isolate the event sink BEFORE any pilot module evaluates — synthetic
// sha-guard/deploy events from tests must never land in the production feed.
process.env.PILOT_EVENTS_FILE = "/tmp/pilot-unit-events.jsonl";

import { b64, fromB64, seal, openSealed, seqAad } from "@ocr/protocol";

import { gateFailFile, mergeConflictBlock } from "../apps/pilot/src/pipeline";

import { parsePairingUri, localWsUrl, shouldFailoverToRelay } from "../apps/web/src/lib/client";

import { isLoopbackAddr, localOriginAllowed, localUpgradeAllowed } from "../apps/daemon/src/localws";

import { classifyRelayClose, effectiveRetryDelayMs } from "../apps/daemon/src/relayclose";
import {
  DEFAULT_RUN_LEASE_MS,
  RUN_LEASE_CEILING_MS,
  RUN_LEASE_KILL_MESSAGE,
  RUN_LEASE_OFF_MS,
  leaseVerdict,
  parseRunLease,
  type RoutineRunFacts,
} from "../apps/daemon/src/routinelease";
import { sttVerdict } from "../apps/daemon/src/voicecap";
import {
  CONVERTER_PREFERENCE,
  CUPSFILTER_PATHS,
  NATIVE_EXTS,
  SOFFICE_EXTS,
  SOFFICE_PATHS,
  TEXTUTIL_PATHS,
  docConvertProbe,
  docConvertVerdict,
} from "../apps/daemon/src/doccap";
import {
  IDENTITY_FIRST_RUN_MESSAGE,
  IDENTITY_REFUSE_CONTENT_MESSAGE,
  IDENTITY_REFUSE_READ_MESSAGE,
  IDENTITY_USE_MESSAGE,
  identityVerdict,
  quarantineName,
  type IdentityVerdict,
} from "../apps/daemon/src/identityfile";
import { modelReadyVerdict, providerSummary } from "../apps/daemon/src/modelready";
import { MIN_OPENCODE_VERSION, parseVersion, versionVerdict } from "../apps/daemon/src/opencodever";
import {
  DISK_ALERT_FREE_BYTES,
  DISK_ALERT_FREE_FRACTION,
  DISK_WARN_FREE_BYTES,
  DISK_WARN_FREE_FRACTION,
  diskVerdict,
} from "../apps/daemon/src/diskguard";
import { rewriteFeedPort } from "../apps/daemon/src/feedport";
import { createRelayRetry } from "../apps/daemon/src/relayretry";
import { nodeStateFileFs, writeStateAtomic, type StateFileFs } from "../apps/daemon/src/statefile";
import { appendAudit, readAuditTail, nodeAuditLogFs, AUDIT_CAP_BYTES, type AuditLogFs } from "../apps/daemon/src/auditlog";

import {
  isLoopbackHost as isLoopbackHostBoot,
  parseRelayUrl,
  redactRelayUrl,
} from "../apps/daemon/src/relayurl";
import {
  DEFAULT_RELAY_URL,
  isLoopbackHost as isLoopbackHostSetting,
  RELAY_URL_MAX_LEN,
  relayUrlProblems,
  resolveRelayUrl,
} from "../apps/desktop/src/relaysetting";
import {
  readStoredRelayUrl,
  readStoredWebAppUrl,
  relaySettingFile,
  writeStoredRelayUrl,
  writeStoredWebAppUrl,
} from "../apps/desktop/src/relaystore";
import {
  deriveWebAppUrl,
  isLoopbackHost as isLoopbackHostWebApp,
  resolveWebAppUrl,
  webAppUrlProblems,
  WEB_APP_URL_MAX_LEN,
} from "../apps/desktop/src/webappurl";
import { buildPairLink, PAIR_LINK_HASH_ROUTE, PAIR_LINK_MAX_LEN } from "../apps/desktop/src/pairlink";
import { hasAppMarker, probeVerdict, WEB_REACH_TIMEOUT_MS } from "../apps/desktop/src/webreach";
import { clockSkewMessage, skewVerdict, CLOCK_SKEW_TOLERANCE_MS } from "../apps/desktop/src/clockskew";
import { linkVerdict, type RelayLinkFacts } from "../apps/desktop/src/relaylink";
import { installMessage, installVerdict } from "../apps/desktop/src/installloc";
import { loginItemMessage, loginItemPlan } from "../apps/desktop/src/loginitem";
import { readStartupDecided, startupSettingFile, writeStartupDecided } from "../apps/desktop/src/startupstore";
import {
  QUIT_BUTTON_INDEX,
  QUIT_BUTTON_NEVER,
  QUIT_BUTTON_QUIT,
  QUIT_BUTTON_STAY,
  QUIT_DIALOG_DETAIL,
  QUIT_DIALOG_MESSAGE,
  QUIT_DIALOG_TITLE,
  quitVerdict,
} from "../apps/desktop/src/quithint";
import {
  hangVerdict,
  HANG_BUTTON_INDEX,
  HANG_BUTTON_RELOAD,
  HANG_BUTTON_WAIT,
  HANG_DIALOG_THRESHOLD_MS,
  HANG_DIALOG_TITLE,
  HANG_NOTIFY_TITLE,
  HANG_WARN_THRESHOLD_MS,
} from "../apps/desktop/src/hangwatch";
import { quitAskFile, readQuitDontAsk, writeQuitDontAsk } from "../apps/desktop/src/quitstore";
import { installBlocksUpdate } from "../apps/desktop/src/update";
import {
  isWakeEventType,
  RESPAWN_WAIT_CEILING_MS,
  WAKE_DEBOUNCE_MS,
  WAKE_EVENT_TYPES,
  wakePlan,
  type WakePlanInput,
  type WakePlanVerdict,
} from "../apps/desktop/src/wakeplan";
import {
  bodyLimit,
  isBodyLimitError,
  MAX_JSON_BODY_BYTES,
  MAX_JSON_BODY_CEILING_BYTES,
  overLimit,
  readLimitedBody,
  type LimitedBodyReader,
} from "../apps/daemon/src/bodylimit";
import {
  bootstrapDecision,
  DEFAULT_PAIR_WINDOW_MS,
  PAIR_WINDOW_CEILING_MS,
  pairWindow,
} from "../apps/daemon/src/pairwindow";
import {
  DEVICE_TOUCH_INTERVAL_MS,
  nextDeviceLabel,
  touchDecision,
} from "../apps/daemon/src/devicetouch";

import {
  admitNewUpload,
  chunkIndexProblem,
  chunkStoreLimits,
  expiredKeys,
  stagingCapBytes,
  stagedOverLimit,
  DEFAULT_EXPIRATION_MS,
  DEFAULT_MAX_CHUNK_INDEX,
  DEFAULT_MAX_STAGED_IDS,
  DEFAULT_UPLOAD_MAX_MB,
  STAGING_MARGIN_BYTES,
  UPLOAD_MAX_MB_CEILING,
} from "../apps/daemon/src/chunkstore";

import { classifyUpstream, UPSTREAM_PROBE_TIMEOUT_MS } from "../apps/daemon/src/upstream";

import { opencodeCandidates, pickOpencodeBinary } from "../apps/daemon/src/opencodebin";

import { copyText, hasClipboardApi, legacyCopy } from "../apps/web/src/lib/clipboard";

import { mimeFor } from "../apps/web/src/lib/files";

import { timeAgo, sessionUpdatedTs } from "../apps/web/src/lib/time";

import { sessionTitleOf } from "../apps/web/src/lib/title";

import { dict, translate } from "../apps/web/src/lib/i18n";

import { degradedKind, sawHealthyDaemon, sidecarExitNotice, upstreamNotice, type SidecarExitHealth, type UpstreamHealth } from "../apps/web/src/lib/degraded";
import {
  MACHINE_ROW_ORDER,
  MACHINE_SEVERITY_DOT,
  readinessRows,
  summarize,
  type MachineReadinessRow,
} from "../apps/web/src/lib/machinestate";

import { WELCOME_DONE, shouldShowWelcome } from "../apps/web/src/lib/welcome";

import { permissionPreview } from "../apps/web/src/lib/permission";

import { applySessionFilters, isPilotTitle, splitPilotSessions } from "../apps/web/src/lib/sessionFilter";

import { initialUnreadState, reduceUnread } from "../apps/web/src/lib/unread";

import { recencyGroup, groupByRecency, startOfLocalDay } from "../apps/web/src/lib/recency";

import { accountInitial, accountPlanKey } from "../apps/web/src/lib/account";

import { toggleArchived, ARCHIVED_MAX } from "../apps/web/src/lib/archive";
import {
  INSTALL_HINT_DISMISSED_KEY,
  INSTALL_HINT_MESSAGE,
  installHintVerdict,
  parseInstallHintDismissed,
  serializeInstallHintDismissed,
} from "../apps/web/src/lib/installhint";

import { previewFromEvents, clipPreview } from "../apps/web/src/lib/sessionPreview";

import {
  capMessagePage,
  parsePageLimit,
  shouldPaginateMessages,
  sliceMessagePage,
  PAGE_LIMIT_MAX,
} from "../apps/daemon/src/paginate";

import { backlogSections, queueView } from "../apps/daemon/src/backlogview";

import {
  dropCachedSession,
  getCachedSession,
  putCachedSession,
  SESSION_CACHE_MAX,
} from "../apps/web/src/lib/sessionCache";

import { appendDraft, clearDraft, getDraft, setDraft, DRAFTS_MAX } from "../apps/web/src/lib/drafts";

import { taskMergedIn } from "../apps/pilot/src/pipeline";

import { cachedExec, exec, rerunKey, runStepWithRetry, type RerunResults } from "../apps/pilot/src/runner";

import {
  applySessionCosts,
  cacheHitRatio,
  foldSlotCache,
  isSessionId,
  parseSessionTokenRows,
  parseSessionTokens,
  pruneTaskCosts,
  querySessionTokenRows,
  querySessionTokens,
  sessionTotalTokens,
  TASK_COST_CAP,
  tokensSql,
} from "../apps/pilot/src/costs";

import { normalizeSessionModel, PRICE_SOURCES, PRICE_TABLE, taskCostUSD } from "../apps/pilot/src/pricing";

import { unreachableTests } from "./testreachability";

import { CORPUS_COMMANDS, CORPUS_SAMPLE_RE, appendCorpusSample, captureGateCorpus, corpusSlug, loadGateCorpus, sanitizeForCorpus } from "../apps/pilot/src/gate-corpus";

import {
  appendLessons,
  dedupeAndPrune,
  EXPERIENCE_CAP,
  experienceTemplate,
  isHarnessLesson,
  jaccard,
  JACCARD_DUPE,
  maintainExperienceFile,
  maintainExperienceWorkspace,
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

import { clearTaskAttempts, doctorBacklog, doctorBranches, doctorRefs, doctorState, doctorTierB, normalizePilotState, parseAttemptsArgs, protectedBranchIds, runAttemptsCommand, runDoctor, validateBacklog, type AttemptsRequest, type RunFn } from "../apps/pilot/src/doctor";

import { avgPhaseDurations, burnDown, countFailSteps, recordLessonImpact, rollbackHealthAlert } from "../apps/pilot/src/metrics";

import type { PilotEvent } from "../apps/pilot/src/events";

import { areaKey, NIGHTLY_IDLE_MS, nightlyIdleDue, nightlySkipDue, pickBatch, pickTasks, AFFINITY_TTL_MS, assignSlots, SLOT_START_STAGGER_MS, startDelayMs, type SlotAffinity } from "../apps/pilot/src/scheduler";

import { researcherPrompt } from "../apps/pilot/src/researcher";

import {
  AUDIT_BLOCK_TRIGGER,
  AUDIT_BLOCK_WINDOW_MS,
  AUDIT_RESUME_MS,
  AUDIT_WINDOW,
  INFRA_DOCTOR_EVERY,
  auditResumeDue,
  buildDiagnosis,
  clearAuditMode,
  enterAuditMode,
  feverReason,
  formatDiagnosis,
  recordBlockEvent,
  recordCycle,
  recordInfraFailure,
  recordPipelineCrash,
  resultInfraKind,
  specFailureIsInfra,
} from "../apps/pilot/src/audit";

import {
  appendCommitAndPush,
  appendReadyLines,
  auxPushIo,
  blockTask,
  blockTaskEdit,
  doneTaskIds,
  loadBacklog,
  mayPush,
  parseAuxTaskLines,
  parseBacklog,
  addTask,
  type AuxPushIo,
  type Task,
} from "../apps/pilot/src/backlog";

import { clearPendingRefill, defaultPendingRefillFile, readPendingRefill, relandDetail, relandPendingRefill, savePendingRefill } from "../apps/pilot/src/refill";

import { landMetaCommit, mayPushUnderDir, metaIo, META_BRANCH, type MetaPushIo } from "../apps/pilot/src/metapush";

import { EXPLORER_MAX_FINDINGS, EXPLORER_MAX_STEPS, EXPLORER_TIMEOUT_MIN, EXPLORER_PUSH_RETRIES, EXPLORER_PUSH_WAIT_MS, FABLE_MARKER, FABLE_MAX_FINDINGS, JOURNEY_STEPS, claimExplorerRun, commitAndPushFindings, commitAndPushFableFindings, explorerPrompt, explorerSessionName, explorerSpec, fablePrompt, fableSpec, journeyShotName, parseExplorerFindings, parseFableFindings, type ExplorerFinding, type FableFinding } from "../apps/pilot/src/explorer";

import { noteTierBOutcome, resetTierBSpawnStreak, runAgent, runAgentForRole, API_PREFLIGHT, apiHealthy, TIERB_SPAWN_ALERT_EVERY, shouldAlertTierBSpawn, claudeArgs, idScanner, mergeAgentIds, OPENCODE_URL_DEFAULT, scanIds, shouldFallbackTierB, waitForApi } from "../apps/pilot/src/runner";

import { GUARD_ALERT_THRESHOLD, clearGuardRejections, guardAlertDetail, noteGuardRejection, raiseGuardAlert, resetGuardAlerts } from "../apps/pilot/src/guardalert";

import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, symlinkSync, utimesSync, copyFileSync } from "node:fs";

import { execSync, execFileSync, spawn, spawnSync } from "node:child_process";

import { createServer, get } from "node:http";

import { createHash } from "node:crypto";

import { AddressInfo } from "node:net";

import { connect as netConnect } from "node:net";

import WebSocket, { WebSocketServer } from "ws";

import { tmpdir, homedir } from "node:os";

import { createRequire } from "node:module";

import { fileURLToPath } from "node:url";

import { dirname, join } from "node:path";

import { MAX_ARTIFACT_BYTES, MAX_ARTIFACTS_LISTED, artifactMime, capArtifacts, kindFor, listArtifacts, readArtifact, validSegment, type ArtifactMeta } from "../apps/daemon/src/artifacts";

import {
  RETENTION_DISABLE_ENV,
  RETENTION_GRACE_MS,
  RETENTION_INTERVAL_MS,
  RETENTION_MAX_AGE_DAYS,
  RETENTION_MAX_TOTAL_BYTES,
  RETENTION_MIN_SESSIONS,
  retentionDisabled,
  retentionPlan,
  type RetentionEntry,
} from "../apps/daemon/src/artifactretention";

import {
  UPLOAD_RETENTION_DEFAULTS,
  UPLOAD_RETENTION_DISABLE_ENV,
  UPLOAD_RETENTION_GRACE_HOURS,
  UPLOAD_RETENTION_MAX_AGE_DAYS,
  UPLOAD_RETENTION_MAX_BYTES_CEILING,
  UPLOAD_RETENTION_MAX_TOTAL_BYTES,
  UPLOAD_RETENTION_MIN_FILES,
  parseUploadRetention,
  uploadRetentionDisabled,
  uploadRetentionPlan,
  type UploadEntry,
} from "../apps/daemon/src/uploadretention";

import {
  ARTIFACTS_MARKER,
  buildArtifactsPathLine,
  buildArtifactsPrompt,
  buildMissionPrompt,
  injectArtifactsPathPart,
  injectArtifactsSystem,
  MISSION_FILE_HINT,
  MISSION_MARKER,
  workspaceCoversArtifacts,
} from "../apps/daemon/src/sessionctx";

import {
  GITHUB_REPO_URL_RE,
  MISSION_MODEL_ROLES,
  MISSION_PROMPT_MAX,
  attemptsKey,
  bareTaskId,
  missionDrifted,
  missionHash,
  missionModelFor,
  missionWorkspaceKey,
  normalizeRepoUrl,
  parseMissionModels,
  parseMissionSpec,
  readMission,
  removeMissionFile,
  repoSlug,
  validModelId,
  validRepoUrl,
  writeMissionSpec,
  type MissionFileIo,
} from "../apps/pilot/src/mission";

import { CATALOG_TTL_MS, fetchAvailableModels, parseProviderCatalog, pickMissionModel, resetCatalogCache } from "../apps/pilot/src/modelcatalog";
import { deployPreflight } from "../apps/pilot/src/deploy";
import { directionGuardDetail } from "../apps/pilot/src/deployguard";
import { DEPLOY_REFUSAL_BACKOFF_AFTER, DEPLOY_REFUSAL_BACKOFF_MS, deployBackoffRemaining, noteDeployRefusal } from "../apps/pilot/src/deploybackoff";
import { nightlyLayer } from "../apps/pilot/src/scheduler";
import { detectDefaultBranch, parseRemoteShowHead, parseSymbolicHead } from "../apps/pilot/src/missionrepo";
import { BACKLOG_SKELETON, backlogSkeletonEdit, needsBacklogSkeleton, seedBacklogSkeleton } from "../apps/pilot/src/backlog";
import { activeModelSubstitutions, clearModelSubstitution, formatModelSubstitutions, readModelSubstitutions, recordModelSubstitution } from "../apps/pilot/src/modelsubst";
import { formatModelSubstitutions as formatModelSubstitutionsView } from "../apps/web/src/components/MissionControlView";

import { INFRA_STREAK_HARD_FAIL, clearTaskInfraStreak, infraStarvationReason, infraStreakExhausted, recordTaskInfraStreak } from "../apps/pilot/src/audit";

import { formatMissionModels } from "../apps/web/src/components/MissionControlView";

import {
  buildGenericProfile,
  detectGateProfile,
  GENERIC_GATE_SCRIPTS,
  GENERIC_STEP_TIMEOUT_MIN,
  isPilotCheckoutPath,
  PILOT_GATE_STEPS,
} from "../apps/pilot/src/gateprofile";

import { browseTarget, clickPoint, validSession, viewportFromParams } from "../apps/daemon/src/browse";

import { createShutdown, DRAIN_MS, stopAccepting } from "../apps/daemon/src/shutdown";

import {
  createShutdown as relayCreateShutdown,
  stopAccepting as relayStopAccepting,
  DRAIN_MS as RELAY_DRAIN_MS,
  type RelayLog,
} from "../apps/relay/src/shutdown";

import { tlsPlan } from "../apps/relay/src/tlsconfig";

import { makeIpTagger, UNKNOWN_IP_TAG, IP_TAG_LENGTH } from "../apps/relay/src/iptag";

import {
  relayKnobs,
  RATE_PER_MIN_CEILING,
  RATE_BURST_CEILING,
  MAX_PER_IP_CEILING,
  TRUST_PROXY_HOPS_CEILING,
  PING_INTERVAL_S_CEILING,
} from "../apps/relay/src/knobs";

import { resolveLogLevel, shouldLog, LOG_LEVELS, LOG_LEVEL_DEFAULT } from "../apps/relay/src/loglevel";

import {
  parseBufferCap,
  sendVerdict,
  BUFFER_CAP_ENV,
  BUFFER_CAP_DEFAULT,
  BUFFER_CAP_CEILING,
  SLOW_CONSUMER_CLOSE_CODE,
  SLOW_CONSUMER_CLOSE_REASON,
} from "../apps/relay/src/backpressure";

import {
  acceptVerdict,
  parseMaxSockets,
  CAPACITY_REFUSE_REASON,
  MAX_SOCKETS_GLOBAL_CEILING,
  MAX_SOCKETS_GLOBAL_DEFAULT,
  MAX_SOCKETS_GLOBAL_ENV,
} from "../apps/relay/src/capacity";

import {
  idleUnjoined,
  parseJoinDeadline,
  JOIN_DEADLINE_MS_CEILING,
  JOIN_DEADLINE_MS_DEFAULT,
  JOIN_DEADLINE_MS_DISABLED,
  JOIN_DEADLINE_MS_ENV,
  JOIN_UNJOINED_CLOSE_CODE,
  JOIN_UNJOINED_CLOSE_REASON,
  type JoinDeadlinePeer,
} from "../apps/relay/src/joindeadline";

import {
  assetIntegrityPlan,
  indexAssetPlan,
  WEB_INDEX_MAX_BYTES,
  type AssetProbe,
} from "../apps/relay/src/webroot";

import { touchedUiFromDiff, needsEscalation, parseFindings, verifyFindings, isTaskMergeSha, parseVerdict, reviewerOk, tagUnverified, isBlockingFinding, findingsRepeat, writeAuxSandboxConfig , CONSTITUTION, PR_MERGE_CONFIRM_DELAY_MS, PR_MERGE_CONFIRM_POLLS, PrMergeIo, RESUME_MAX_TASK_IDS, TASK_ID_RE, builderPrompt, codeChanges, commitSpec, commitSpecWithReason, crashRoundDecision, lessonsBlock, mergeBlockReason, mergePrForTask, needsPlanner, parseScribeLessons, plannerPrompt, plannerRetryPolicy, rebaseOutcome, resumeBlock, reviewerPrompt, setupTaskBranch, specPathFor, specRejectReason, updateResumeState, validateSpec } from "../apps/pilot/src/pipeline";


import { latestUiShot, pruneShots } from "../apps/pilot/src/shot";

import { parseMarkdown, parseInline } from "../apps/web/src/lib/md";

import { parseCsv } from "../apps/web/src/lib/csv";
import { stampVersion, pkgWithVersion, SEMVER } from "./sync-version";

import { ARTIFACT_MAX_BYTES, ArtifactTooLarge, artifactMentions, fetchArtifact, fmtBytes } from "../apps/web/src/lib/artifacts";

import { clampSplitPct, isSplitViewport, SPLIT_MIN_PX } from "../apps/web/src/lib/split";

import { DISK_MIN_FREE_BYTES, diskGuardDetail, freeDiskBytes } from "../apps/pilot/src/disk";

import {
  BASELINE_SAMPLES,
  baselineFailureRate,
  baselineHealthRate,
  deploy,
  drainForReload,
  FAST_INSTALL_CMD,
  headDrifted,
  LIVE_INVARIANT_EVERY,
  quarantineWithEscalation,
  RELOAD_DRAIN_POLL_MS,
  ROLLBACK_HEALTH_WINDOW_SEC,
  shouldSelfHealReload,
  shouldForceReload,
  DRIFT_FORCE_RELOAD_MS,
  shouldSelfReload,
  soakFailureRateExceeded,
  soakMinutesFor,
  soakWatch,
  SOAK_RATE_TOLERANCE,
  SOAK_WINDOW,
  verifyRollbackHealth,
} from "../apps/pilot/src/deploy";

import {
  dirtyGuardDetail,
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

import { overlayVisible, phonePaired, localPairing } from "../apps/desktop/src/pairing";

import { classifySidecarExit } from "../apps/desktop/src/sidecarexit";

import {
  createSidecarRedactor,
  PAIRING_SCHEME,
  REDACTED_MARKER,
  SIDECAR_PARTIAL_MAX_BYTES,
} from "../apps/desktop/src/sidecar-redact";
import { createSidecarTee, sidecarLogFile } from "../apps/desktop/src/sidecar-log";

import { candidatePorts, pickDaemonPort } from "../apps/desktop/src/daemonport";

import { versionMismatch } from "../apps/desktop/src/versions";

import { daemonTooltip, loginItemSupported, logsDirPath, openLogsFolder, trayIconSource } from "../apps/desktop/src/tray";

import { HOTKEY_MENU_LABEL, menuSpec, type MenuItemSpec } from "../apps/desktop/src/menu";
import {
  DEFAULT_ZOOM_LEVEL,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  sanitizeZoom,
  ZOOM_STEP,
  zoomStartupPlan,
  zoomVerdict,
} from "../apps/desktop/src/zoomlevel";
import { contextMenuSpec, SPELLING_SUGGESTIONS_MAX } from "../apps/desktop/src/ctxmenu";
import {
  acceleratorProblem,
  defaultHotkeyFor,
  hotkeyPlan,
  HOTKEY_DISABLE_ENV,
  HOTKEY_MAX_LEN,
} from "../apps/desktop/src/hotkey";

import { badgePlan } from "../apps/desktop/src/badge";

import {
  CLOSE_HINT_BODY_MENUBAR,
  CLOSE_HINT_BODY_TRAY,
  CLOSE_HINT_LOG,
  CLOSE_HINT_SENTINEL,
  CLOSE_HINT_TITLE,
  closeHintPlan,
  hintFlagPath,
  readHintFlag,
  writeHintFlag,
} from "../apps/desktop/src/closehint";

import { publicFeedUrl, updateMenuLabel } from "../apps/desktop/src/update";

import { permissionDecision, requestingScheme, SHELL_PERMISSIONS } from "../apps/desktop/src/permissions";

import {
  nextCheckDelayMs,
  UPDATE_RECHECK_BACKOFF_START_MS,
  UPDATE_RECHECK_BASE_MS,
  UPDATE_RECHECK_JITTER,
  UPDATE_RECHECK_MIN_MS,
} from "../apps/desktop/src/updateschedule";

import { appIdForPlatform, applyAppUserModelId, daemonNotify, NOTIFY_BACK_BODY, NOTIFY_DOWN_BODY, WINDOWS_APP_ID } from "../apps/desktop/src/notify";

import { DEEP_LINK_QUERY_MAX, deepLinkFromArgv, parseDeepLink } from "../apps/desktop/src/deeplink";

import { externalOpenDecision } from "../apps/desktop/src/extlink";

import {
  downloadVerdict,
  DOWNLOAD_LIMITS,
  DOWNLOAD_MAX_BYTES,
  DOWNLOAD_NAME_MAX,
  DOWNLOAD_PHRASES,
  safeDownloadName,
  uniqueDownloadName,
} from "../apps/desktop/src/downloadplan";

import { guestAttachDecision, guestNavigationDecision } from "../apps/desktop/src/webviewguard";

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

import { checkPng } from "../tools/pngcheck.mjs";

import { signingProfile } from "../apps/desktop/scripts/signing-profile.mjs";
import { signingProfileWin } from "../apps/desktop/scripts/signing-profile-win.mjs";
import { archOfFileName, macFeedPlan } from "../apps/desktop/scripts/update-feed.mjs";

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

import { findWindowsInstaller, listProblems, smokeFlags, windowsInstallerProblems } from "../apps/desktop/scripts/dist-smoke.mjs";

import { bootVerdict } from "../apps/desktop/scripts/packaged-boot-verdict.mjs";
import { candidatePaths } from "../apps/desktop/scripts/packaged-boot-layout.mjs";

import {
  AUDIO_ENTITLEMENT,
  BUILDER_LABEL,
  CAMERA_ENTITLEMENT,
  CAMERA_KEY,
  MIC_KEY,
  PLIST_LABEL,
  privacyProblems,
} from "./mac-privacy";

import { touchesDesktop, touchesRelayImage } from "./ci-scope";

import { PORTABLE_TESTS, portableSuitePlan } from "./portable-suite";

import { PORTABLE_EXCLUSION_CAUSES, PORTABLE_EXCLUSIONS, portableCoverage } from "./portablecoverage";

import { bootSmokeParity, parseWorkflowJobs, type WorkflowJob, type WorkflowStep } from "./bootsmokeparity";

import { imageTags } from "./relay-image";

import { imageSmokeVerdict } from "./relay-image-smoke";

import { expectedAssets, missingAssets, tagProblems } from "./release-assets";
import { publishDecision } from "./release-publish";

import { gatekeeperProblems } from "./gatekeeper-verify";

import { authenticodeProblems } from "./authenticode-verify";

import { checksumLines, checksumProblems, MANIFEST_NAME } from "./release-checksums";

import { applyGuide, downloadGuide, GUIDE_END, GUIDE_START } from "./release-notes";

import { archFeedProblems, archOfFileName, feedProblems } from "./feed-consistency";

import { BUNDLE_BUDGETS, budgetProblems, type BundleEntry } from "./bundle-budget";


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



// --- external open decision (P2-178) ----------------------------------------
const extAllowed = externalOpenDecision("https://example.com/docs");

check("externalOpenDecision allows http", externalOpenDecision("http://example.com/").allow);

check("externalOpenDecision allows https", externalOpenDecision("https://example.com/docs").allow);

check("externalOpenDecision allows mailto", externalOpenDecision("mailto:support@example.com").allow);

check("externalOpenDecision treats uppercase scheme like lowercase (allowed)", externalOpenDecision("HTTPS://example.com/docs").allow);

check("externalOpenDecision echoes normalized href when allowed", extAllowed.allow && extAllowed.href === "https://example.com/docs");

check("externalOpenDecision normalizes uppercase scheme in href", externalOpenDecision("HTTPS://example.com/docs").href === "https://example.com/docs");

check("externalOpenDecision allows href non-empty", !extAllowed.allow || extAllowed.href.length > 0);

const extRefusals: Array<[string, unknown, string]> = [
  ["file", "file:///etc/passwd", "file-scheme-denied"],
  ["javascript", "javascript:alert(1)", "javascript-scheme-denied"],
  ["data", "data:text/html,hello", "data-scheme-denied"],
  ["blob", "blob:https://example.com/uuid", "blob-scheme-denied"],
  ["unknown scheme", "smb://server/share", "scheme-not-allowed:smb"],
  ["uppercase file", "FILE:///etc/passwd", "file-scheme-denied"],
  ["empty string", "", "empty"],
  ["non-string", 42, "not-a-string"],
  ["malformed url", "http://exa mple.com/<>", "unparseable-url"],
];

for (const [name, input, expectedReason] of extRefusals) {
  const decision = externalOpenDecision(input);
  check(`externalOpenDecision refuses ${name}`, !decision.allow);
  check(`externalOpenDecision refuses ${name} with non-empty reason`, !decision.allow && decision.reason.length > 0);
  check(`externalOpenDecision refuses ${name} with expected reason`, !decision.allow && decision.reason === expectedReason);
  check(`externalOpenDecision refuses ${name} with empty href`, !decision.allow && decision.href === "");
}

// The gate in main.ts: every shell.openExternal call site must sit behind the
// externalOpenDecision decision (only decision.href may reach the shell).
const mainTsSource = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
const openExternalLines = mainTsSource.split("\n").filter((line) => line.includes("shell.openExternal("));

check("main.ts has shell.openExternal call sites", openExternalLines.length >= 2);

check("main.ts routes every shell.openExternal through the extlink decision", openExternalLines.every((line) => line.includes("decision.href")));

check("main.ts imports externalOpenDecision", mainTsSource.includes('from "./extlink"'));

check("main.ts consults externalOpenDecision four times (window-open + release page + context menu + download gate)", (mainTsSource.match(/externalOpenDecision\(/g) ?? []).length === 4);



// --- shell permission decision (P2-182) -------------------------------------

const bundleCtx = { cameraBlocked: false };

const shellMedia = permissionDecision("media", "file:///Applications/OpenCode%20Remote.app/Contents/Resources/app.asar/index.html", bundleCtx);

check("permissionDecision allows media for the packaged shell origin", shellMedia.allow);

check("permissionDecision allow reason is non-empty", shellMedia.allow && shellMedia.reason.length > 0);

const devCtx = { devUrl: "http://localhost:5173", cameraBlocked: false };

check("permissionDecision allows media for the dev URL origin", permissionDecision("media", "http://localhost:5173/index.html", devCtx).allow);

check("permissionDecision allows clipboard-sanitized-write for the shell", permissionDecision("clipboard-sanitized-write", "file:///app/index.html", bundleCtx).allow);

check("permissionDecision allows fullscreen for the shell", permissionDecision("fullscreen", "file:///app/index.html", bundleCtx).allow);

check("permissionDecision treats uppercase FILE scheme like lowercase (allowed)", permissionDecision("media", "FILE:///app/index.html", bundleCtx).allow);

check("permissionDecision allows every SHELL_PERMISSIONS entry for file origin", SHELL_PERMISSIONS.every((p) => permissionDecision(p, "file:///app/index.html", bundleCtx).allow));

const externalMedia = permissionDecision("media", "https://evil.example.com/page", bundleCtx);

check("permissionDecision denies media for an external site", !externalMedia.allow);

check("permissionDecision denies media for external site with non-empty reason", !externalMedia.allow && externalMedia.reason.length > 0);

check("permissionDecision reason names foreign origin scheme", permissionDecision("media", "https://evil.example.com/page", bundleCtx).reason === "origin-not-shell:https");

check("permissionDecision denies media for dev origin when devUrl is set but requester is another host", !permissionDecision("media", "http://localhost:9999/", devCtx).allow);

const blockedCtx = { cameraBlocked: true };

const blockedMedia = permissionDecision("media", "file:///app/index.html", blockedCtx);

check("permissionDecision denies media for shell origin when cameraBlocked", !blockedMedia.allow);

check("permissionDecision camera-blocked reason", !blockedMedia.allow && blockedMedia.reason === "camera-blocked");

check("permissionDecision cameraBlocked still allows fullscreen", permissionDecision("fullscreen", "file:///app/index.html", blockedCtx).allow);

const deniedEvenForShell: Array<[string, string]> = [
  ["geolocation", "geolocation-denied"],
  ["notifications", "notifications-denied"],
  ["midi", "midi-denied"],
  ["midiSysex", "midiSysex-denied"],
  ["usb", "usb-denied"],
  ["hid", "hid-denied"],
  ["serial", "serial-denied"],
  ["openExternal", "openExternal-denied"],
  ["pointerLock", "pointerLock-denied"],
  ["idle-detection", "idle-detection-denied"],
  ["window-management", "window-management-denied"],
];

for (const [name, expectedReason] of deniedEvenForShell) {
  const decision = permissionDecision(name, "file:///app/index.html", bundleCtx);
  check(`permissionDecision refuses ${name} even for shell origin`, !decision.allow);
  check(`permissionDecision refuses ${name} with expected reason`, !decision.allow && decision.reason === expectedReason);
  check(`permissionDecision refuses ${name} with non-empty reason`, !decision.allow && decision.reason.length > 0);
}

const unknownPermission = permissionDecision("future-sensor-api", "file:///app/index.html", bundleCtx);

check("permissionDecision refuses unknown permission name", !unknownPermission.allow);

check("permissionDecision unknown-name reason names the permission", !unknownPermission.allow && unknownPermission.reason === "permission-not-allowed:future-sensor-api");

const permissionInputRefusals: Array<[string, unknown, unknown, string]> = [
  ["non-string permission", 42, "file:///app/index.html", "permission-not-a-string"],
  ["empty permission", "", "file:///app/index.html", "empty-permission"],
  ["non-string url", "media", 42, "not-a-string"],
  ["empty url", "media", "", "empty"],
  ["malformed url", "media", "http://exa mple.com/<>", "unparseable-url"],
  ["missing origin", "media", "blob:file:///", "missing-origin"],
];

for (const [name, perm, url, expectedReason] of permissionInputRefusals) {
  const decision = permissionDecision(perm, url, bundleCtx);
  check(`permissionDecision refuses ${name}`, !decision.allow);
  check(`permissionDecision refuses ${name} with expected reason`, !decision.allow && decision.reason === expectedReason);
  check(`permissionDecision refuses ${name} with non-empty reason`, !decision.allow && decision.reason.length > 0);
}

check("permissionDecision devUrl unparseable still allows file origin", permissionDecision("media", "file:///app/index.html", { devUrl: "not a url", cameraBlocked: false }).allow);

check("permissionDecision devUrl absent denies http origins", !permissionDecision("media", "http://localhost:5173/", bundleCtx).allow);

check("requestingScheme lowercases and strips the protocol", requestingScheme("FILE:///app/index.html") === "file");

check("requestingScheme returns unknown for garbage", requestingScheme("not a url") === "unknown");

// The shell's single permission path: both Electron handlers must be
// registered unconditionally (never inside the P2-117 test hatch) and must be
// the only permission callbacks in main.ts.
check("main.ts imports the permissions module", mainTsSource.includes('from "./permissions"'));

check("main.ts registers setPermissionRequestHandler exactly once", (mainTsSource.match(/setPermissionRequestHandler/g) ?? []).length === 1);

check("main.ts registers setPermissionCheckHandler exactly once", (mainTsSource.match(/setPermissionCheckHandler/g) ?? []).length === 1);

check("main.ts OCR_DESKTOP_CAMERA_BLOCK only feeds cameraBlocked", (mainTsSource.match(/OCR_DESKTOP_CAMERA_BLOCK/g) ?? []).length === 1);

check("main.ts permission callbacks no longer hand-roll the decision", !mainTsSource.includes('permission !== "media"'));

check("main.ts request handler answers with the shared decision", mainTsSource.includes("callback(decision.allow)"));

const refusalLogLines = mainTsSource.split("\n").filter((line) => line.includes("permission denied"));

check("main.ts refusal log carries permission name, requester scheme and reason", refusalLogLines.length === 1 && refusalLogLines[0].includes("${permission}") && refusalLogLines[0].includes("requestingScheme(") && refusalLogLines[0].includes("${decision.reason}"));

check("main.ts refusal log omits the full URL", refusalLogLines.length === 1 && !refusalLogLines[0].includes("requestingUrl}"));

// permissions.ts stays pure: no electron, no node builtins, no fetch — so the
// unit test always exercises the real decision code.
const permissionsSource = readFileSync(new URL("../apps/desktop/src/permissions.ts", import.meta.url), "utf8");

check("permissions.ts is pure (no electron import)", !permissionsSource.includes('from "electron"'));

check("permissions.ts is pure (no node builtins)", !permissionsSource.includes("node:fs") && !permissionsSource.includes("node:path") && !permissionsSource.includes("node:os") && !permissionsSource.includes("node:child_process"));

check("permissions.ts is pure (no fetch)", !permissionsSource.includes("fetch("));



// --- guest webContents guard (P2-184) ----------------------------------------

const httpAttach = guestAttachDecision("http://localhost:3000/", {}, undefined);

check("guestAttachDecision allows http origin", httpAttach.allow);

check("guestAttachDecision allow reason is non-empty", httpAttach.allow && httpAttach.reason.length > 0);

check("guestAttachDecision forces contextIsolation on the allowed attach", httpAttach.allow && httpAttach.webPreferences.contextIsolation === true);

check("guestAttachDecision allows https origin", guestAttachDecision("https://example.com/", undefined, undefined).allow);

check("guestAttachDecision treats uppercase HTTP scheme like lowercase (allowed)", guestAttachDecision("HTTP://localhost:3000/", undefined, undefined).allow);

const fileAttach = guestAttachDecision("file:///Users/x/secret.txt", undefined, undefined);

check("guestAttachDecision denies file origin", !fileAttach.allow);

check("guestAttachDecision denies file origin with expected reason", !fileAttach.allow && fileAttach.reason === "file-scheme-denied");

check("guestAttachDecision treats uppercase FILE scheme like lowercase (denied)", !guestAttachDecision("FILE:///etc/passwd", undefined, undefined).allow);

const ocrAttach = guestAttachDecision("ocr://x", undefined, undefined);

check("guestAttachDecision denies unknown scheme", !ocrAttach.allow);

check("guestAttachDecision unknown scheme reason names the scheme", !ocrAttach.allow && ocrAttach.reason === "scheme-not-allowed:ocr");

const attachVariants: Array<[string, unknown, unknown]> = [
  ["no prefs at all", undefined, undefined],
  ["non-object prefs", "garbage", undefined],
  ["unsafe prefs", { nodeIntegration: true, sandbox: false, contextIsolation: false, webviewTag: true, nodeIntegrationInSubFrames: true }, undefined],
  ["empty preload", {}, ""],
  ["non-empty preload", {}, "/tmp/evil.js"],
  ["preloadURL key", { preloadURL: "/tmp/evil.js" }, undefined],
];

for (const [name, prefs, preload] of attachVariants) {
  const decision = guestAttachDecision("https://example.com/", prefs, preload);
  check(`guestAttachDecision still allows attach with ${name}`, decision.allow);
  check(`guestAttachDecision sanitizes preferences for ${name}`, decision.allow && decision.webPreferences.contextIsolation === true && decision.webPreferences.sandbox === true && decision.webPreferences.nodeIntegration === false && decision.webPreferences.nodeIntegrationInSubFrames === false && decision.webPreferences.webviewTag === false);
  check(`guestAttachDecision strips renderer preload for ${name}`, decision.allow && decision.webPreferences.preload === undefined && !("preload" in decision.webPreferences) && !("preloadURL" in decision.webPreferences));
  check(`guestAttachDecision reason stays non-empty for ${name}`, decision.reason.length > 0);
}

check("guestNavigationDecision allows http", guestNavigationDecision("http://localhost:3000/x").allow);

check("guestNavigationDecision allows https", guestNavigationDecision("https://example.com/x").allow);

check("guestNavigationDecision treats uppercase HTTPS like lowercase (allowed)", guestNavigationDecision("HTTPS://EXAMPLE.COM/").allow);

const guestNavRefusals: Array<[string, unknown, string]> = [
  ["file", "file:///etc/passwd", "file-scheme-denied"],
  ["javascript", "javascript:alert(1)", "javascript-scheme-denied"],
  ["data", "data:text/html,hello", "data-scheme-denied"],
  ["blob", "blob:https://example.com/uuid", "blob-scheme-denied"],
  ["uppercase file", "FILE:///etc/passwd", "file-scheme-denied"],
  ["unknown scheme", "smb://server/share", "scheme-not-allowed:smb"],
  ["about", "about:blank", "scheme-not-allowed:about"],
  ["empty string", "", "empty"],
  ["whitespace only", "   ", "empty"],
  ["non-string", 42, "not-a-string"],
  ["malformed url", "http://exa mple.com/<>", "unparseable-url"],
  ["bare word", "not a url", "unparseable-url"],
];

for (const [name, input, expectedReason] of guestNavRefusals) {
  const decision = guestNavigationDecision(input);
  check(`guestNavigationDecision refuses ${name}`, !decision.allow);
  check(`guestNavigationDecision refuses ${name} with expected reason`, !decision.allow && decision.reason === expectedReason);
  check(`guestNavigationDecision refuses ${name} with non-empty reason`, !decision.allow && decision.reason.length > 0);
}

// The shell's single guest path: one web-contents-created handler classifies
// every webContents, the <webview> guest navigations go through the pure
// decision and the shell window owns the attach hook.
check("main.ts registers exactly one web-contents-created handler", (mainTsSource.match(/web-contents-created/g) ?? []).length === 1);

check("main.ts imports the webview guard", mainTsSource.includes('from "./webviewguard"'));

check("main.ts hooks will-attach-webview on the shell window", (mainTsSource.match(/on\("will-attach-webview"/g) ?? []).length === 1);

check("main.ts guards guest will-redirect too", (mainTsSource.match(/will-redirect/g) ?? []).length === 1);

check("main.ts has a will-navigate guard for the window and one for the guest", (mainTsSource.match(/will-navigate/g) ?? []).length === 2);

check("main.ts routes guest navigation through the decision", mainTsSource.includes("guestNavigationDecision("));

check("main.ts guest window-open is denied outright", (mainTsSource.match(/setWindowOpenHandler/g) ?? []).length === 2 && mainTsSource.includes('setWindowOpenHandler(() => ({ action: "deny" }))'));

const guestRefusalLines = mainTsSource.split("\n").filter((line) => line.includes("guest navigation refused") || line.includes("guest attach refused"));

check("main.ts has both guest refusal logs", guestRefusalLines.length === 2);

check("main.ts guest refusal logs carry scheme + reason only", guestRefusalLines.length === 2 && guestRefusalLines.every((line) => line.includes("requestingScheme(") && line.includes("${decision.reason}")));

check("main.ts guest refusal logs omit the full URL", guestRefusalLines.length === 2 && guestRefusalLines.every((line) => !line.includes("${url}") && !line.includes("${params.src}")));

// webviewguard.ts stays pure: no electron, no node builtins, no fetch — so the
// unit test always exercises the real decision code.
const webviewGuardSource = readFileSync(new URL("../apps/desktop/src/webviewguard.ts", import.meta.url), "utf8");

check("webviewguard.ts is pure (no electron import)", !webviewGuardSource.includes('from "electron"'));

check("webviewguard.ts is pure (no node builtins)", !webviewGuardSource.includes("node:fs") && !webviewGuardSource.includes("node:path") && !webviewGuardSource.includes("node:os") && !webviewGuardSource.includes("node:child_process"));

check("webviewguard.ts is pure (no fetch)", !webviewGuardSource.includes("fetch("));



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

const s1: S = { id: "a", updatedAt: "2026-08-31T12:00:00Z" };
 // newest (now)
const s2: S = { id: "b", updatedAt: now - 60_000 };

const s3: S = { id: "c", time: { updated: "2026-08-31T10:00:00Z" } };

const s4: S = { id: "d" };
 // unknown -> last
const s5: S = { id: "e", updatedAt: "garbage" };
 // invalid -> last
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


// --- P1-088: per-session composer drafts --------------------------------------
{
  // start clean regardless of test order
  for (const id of ["draft-a", "draft-b", "draft-empty"]) clearDraft(id);
  setDraft("draft-a", "x");
  check("P1-088: drafts are independent per session", getDraft("draft-empty") === "" && getDraft("draft-a") === "x");
  setDraft("draft-a", "");
  check("P1-088: emptying the composer deletes the draft key", getDraft("draft-a") === "");
  setDraft("draft-a", "x");
  check("P1-088: append joins with a single space", appendDraft("draft-a", "y") === "x y");
  setDraft("draft-empty", "");
  check("P1-088: append onto an empty draft has no leading space", appendDraft("draft-empty", "y") === "y");
  clearDraft("draft-a");
  clearDraft("draft-empty");
  check("P1-088: clearDraft empties the entry", getDraft("draft-a") === "" && getDraft("draft-empty") === "");
  // eviction: insert DRAFTS_MAX + 1 distinct keys, the first must be evicted
  for (let i = 0; i <= DRAFTS_MAX; i++) setDraft(`draft-cap-${i}`, `t${i}`);
  check("P1-088: oldest draft is evicted past the cap", getDraft("draft-cap-0") === "" && getDraft(`draft-cap-${DRAFTS_MAX}`) === `t${DRAFTS_MAX}`);
  for (let i = 0; i <= DRAFTS_MAX; i++) clearDraft(`draft-cap-${i}`);
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

    check("blockTask moves the Ready line under ## Blocked", blockTask(dir, "T-001", "max review rounds reached — findings:\n- bad\n- thing") === "applied");
    const md = readFileSync(join(dir, "BACKLOG.md"), "utf8");
    const blockedChunk = md.split("\n## Blocked\n")[1] ?? "";
    check(
      "blocked section holds task line + findings summary (whitespace collapsed)",
      blockedChunk.includes("(T-001)") && blockedChunk.includes("max review rounds reached") && blockedChunk.includes("findings: - bad - thing"),
    );
    check("blocked section sits before ## Done", md.indexOf("## Blocked") < md.indexOf("## Done"));
    check("blocked task leaves the Ready queue (no solo reschedule)", loadBacklog(dir).map((t) => t.id).join(",") === "T-002");
    check("blockTask is idempotent", blockTask(dir, "T-001", "again") === "noop" && (md.match(/\(T-001\)/g) ?? []).length === 1);
    check("blockTask unknown id returns false", blockTask(dir, "T-999", "x") === "missing");
    check("blockTask escapes the id regex", blockTask(dir, "T-001) [P1] x.*", "y") === "missing");

    // reset on gate pass: deleting the counter gives a fresh allowance
    delete st.taskAttempts["T-001"];
    check("breaker: gate pass resets the counter", recordTaskFailure(st, "T-001", 4) === false && st.taskAttempts["T-001"] === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// --- P2-142 blockTaskEdit: idempotent stop-loss + Blocked-header normalization ---
{
  const t1 = "- [ ] (T-001) [P1] Task A — spec: fails 4x";
  const withDone = `# BACKLOG\n\n## Ready\n\n${t1}\n\n## Done\n- [x] (T-000) [P1] Old — done\n`;
  const dupes = [
    "# BACKLOG",
    "",
    "## Ready",
    "",
    t1,
    "",
    "## Blocked",
    "- [ ] (T-010) [P1] First — spec: x",
    "",
    "## Blocked",
    "- [ ] (T-011) [P2] Second — spec: y",
    "",
    "## Blocked",
    "- [ ] (T-012) [P3] Third — spec: z",
    "",
    "## Done",
    "- [x] (T-000) [P1] Old — done",
  ].join("\n");
  const everyTaskOnce = (md: string) =>
    ["(T-001)", "(T-010)", "(T-011)", "(T-012)"].every((id) => (md.match(new RegExp(id.replace(/[()]/g, "\\$&"), "g")) ?? []).length === 1);

  // single existing header is reused — never a second section
  const oneHeader = `# BACKLOG\n\n## Ready\n\n${t1}\n\n## Blocked\n- [ ] (T-099) [P2] Old — spec: x\n\n## Done\n- [x] (T-000) [P1] Old — done\n`;
  const reused = blockTaskEdit(oneHeader, "T-001", "max review rounds — findings:\n- a\n- b");
  check("blockTaskEdit: reuses the existing Blocked header", reused.result === "applied" && (reused.text.match(/^## Blocked$/gm) ?? []).length === 1);
  check("blockTaskEdit: new line sits right below the reused header", /^## Blocked\n- \[ \] \(T-001\)/m.test(reused.text));
  check("blockTaskEdit: existing blocked lines stay", reused.text.includes("- [ ] (T-099) [P2] Old — spec: x"));
  check("blockTaskEdit: line leaves the Ready queue", !/## Ready\n\n- \[ \] \(T-001\)/.test(reused.text));
  check("blockTaskEdit: findings summary collapsed + attached", reused.text.includes("(T-001) [P1] Task A — spec: fails 4x — max review rounds — findings: - a - b"));

  // no header at all → created before ## Done
  const created = blockTaskEdit(withDone, "T-001", "boom");
  check(
    "blockTaskEdit: without a header one is created before ## Done",
    created.result === "applied" && created.text.includes("## Blocked\n- [ ] (T-001) [P1] Task A — spec: fails 4x — boom\n\n## Done"),
  );

  // no header, no ## Done → appended at the end of the file
  const noDone = blockTaskEdit(`# BACKLOG\n\n## Ready\n\n${t1}\n`, "T-001", "boom");
  check(
    "blockTaskEdit: without Done the header lands at the end of the file",
    noDone.result === "applied" && noDone.text.trimEnd().endsWith("## Blocked\n- [ ] (T-001) [P1] Task A — spec: fails 4x — boom"),
  );

  // duplicate headers collapse into one, preserving every task line in order
  const collapsedEdit = blockTaskEdit(dupes, "T-001", "circuit broken");
  check("blockTaskEdit: duplicate Blocked headers collapse into one", collapsedEdit.result === "applied" && (collapsedEdit.text.match(/^## Blocked$/gm) ?? []).length === 1);
  check("blockTaskEdit: collapse discards no task line", everyTaskOnce(collapsedEdit.text));
  check("blockTaskEdit: collapse preserves the existing task order", collapsedEdit.text.indexOf("(T-010)") < collapsedEdit.text.indexOf("(T-011)") && collapsedEdit.text.indexOf("(T-011)") < collapsedEdit.text.indexOf("(T-012)"));
  check("blockTaskEdit: entry lands under the surviving header", collapsedEdit.text.includes("## Blocked\n- [ ] (T-001) [P1] Task A — spec: fails 4x — circuit broken\n- [ ] (T-010)"));
  check("blockTaskEdit: Done section survives the collapse", collapsedEdit.text.includes("## Done\n- [x] (T-000) [P1] Old — done"));

  // already-blocked detection considers ANY Blocked section
  const noop = blockTaskEdit(dupes, "T-011", "x");
  check("blockTaskEdit: task under a later Blocked section is noop with untouched text", noop.result === "noop" && noop.text === dupes);
  check("blockTaskEdit: unknown id is missing", blockTaskEdit(dupes, "T-999", "x").result === "missing");
  check("blockTaskEdit: regex metacharacters in the id stay literal", blockTaskEdit(dupes, "T-001) [P1] x.*", "y").result === "missing");

  // disk wrapper keeps read → edit → write and normalizes legacy files
  const dir2 = mkdtempSync(join(tmpdir(), "pilot-blocknorm-"));
  try {
    writeFileSync(join(dir2, "BACKLOG.md"), dupes);
    check("blockTask: legacy multi-section file normalizes on a real write", blockTask(dir2, "T-001", "circuit broken") === "applied");
    const md2 = readFileSync(join(dir2, "BACKLOG.md"), "utf8");
    check("blockTask: normalized file carries exactly one Blocked section", (md2.match(/^## Blocked$/gm) ?? []).length === 1);
    check("blockTask: normalized file keeps every task line", everyTaskOnce(md2));
    check("blockTask: second block of an already-blocked task stays noop", blockTask(dir2, "T-012", "again") === "noop" && readFileSync(join(dir2, "BACKLOG.md"), "utf8") === md2);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
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
    check("appendReadyLines: appends at the end of ## Ready", appendReadyLines(dir, [okLine, okLine2]) === "applied");
    let md = readFileSync(join(dir, "BACKLOG.md"), "utf8");
    const readyChunk = md.split("\n## Ready\n")[1]?.split("\n## Done")[0] ?? "";
    check(
      "appendReadyLines: lines land inside the Ready section",
      readyChunk.includes("(P2-901)") && readyChunk.includes("(P2-902)") && readyChunk.indexOf("(P2-900)") < readyChunk.indexOf("(P2-901)"),
    );
    check("appendReadyLines: Blocked/Done untouched", md.indexOf("(P2-899)") > md.indexOf("(P2-902)"));
    check("appendReadyLines: duplicate id refused", appendReadyLines(dir, ["- [ ] (P2-901) [P2] Dup — spec: x (area: ui)"]) === "noop");
    md = readFileSync(join(dir, "BACKLOG.md"), "utf8");
    check("appendReadyLines: duplicate did not double-insert", (md.match(/\(P2-901\)/g) ?? []).length === 1);
    check("appendReadyLines: empty input is a no-op", appendReadyLines(dir, []) === "missing");

    // appendCommitAndPush with fake git: guard refusal must never push, retries re-append
    let pristine = pristineBase;
    let pushCalls = 0;
    let diffBehavior = "BACKLOG.md\n";
    let sleeps = 0;
    let prCreated = false;
    let prMerged = false;
    const fakeIo = (pushFails = 0) => ({
      exec: (cmd: string) => {
        // P1-076: the landing re-bases pilot/meta on origin/main — the fake
        // restores the pristine file at that rewind instead of a git reset
        if (cmd.includes(`git checkout -q -B ${META_BRANCH}`)) writeFileSync(join(dir, "BACKLOG.md"), pristine);
        if (cmd.startsWith("git diff")) return { ok: true, output: diffBehavior };
        if (cmd.startsWith("git push")) {
          pushCalls++;
          return { ok: pushCalls > pushFails, output: "" };
        }
        // R4: the landing verifies our sha (40-hex) and confirms the merge
        if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${"c".repeat(40)}\n` };
        // R6: no PR exists until the landing creates one; after that the view
        // carries headRefOid = the landing's own push (fake rev-parse sha)
        if (cmd.startsWith("gh ") && cmd.includes("pr view"))
          return prCreated
            ? { ok: true, output: JSON.stringify({ state: prMerged ? "MERGED" : "OPEN", headRefOid: "c".repeat(40) }) }
            : { ok: false, output: "no pull requests" };
        if (cmd.startsWith("gh ") && cmd.includes("pr create")) {
          prCreated = true;
          return { ok: true, output: "" };
        }
        if (cmd.startsWith("gh ") && cmd.includes("pr merge")) {
          prMerged = true;
          return { ok: true, output: "" };
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
      "appendCommitAndPush: all-duplicate lines converge as a noop success (desired state present)",
      (await appendCommitAndPush(dir, [okLine], "m4", fakeIo())) === "pushed" && pushCalls === 0,
    );

    // real-git smoke (P3-052 lesson): bare remote + apostrophed commit message.
    // P1-076: gh is faked via the injectable io — the commit must land on
    // origin/pilot/meta and NEVER on origin/main.
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
      const realIo = auxPushIo(work);
      const ghFakedIo = ghMergingIo(realIo);
      check("appendCommitAndPush real-git smoke: apostrophed message lands", (await appendCommitAndPush(work, [okLine], message, ghFakedIo)) === "pushed");
      const shown = execSync(`git -C ${JSON.stringify(work)} show origin/${META_BRANCH}:BACKLOG.md`, { encoding: "utf8" });
      const subject = execSync(`git -C ${JSON.stringify(work)} log -1 --format=%s origin/${META_BRANCH}`, { encoding: "utf8" }).trim();
      check("appendCommitAndPush real-git smoke: line landed on origin/pilot/meta", shown.includes("(P2-901)"));
      check("appendCommitAndPush real-git smoke: apostrophed subject intact", subject === message);
      const mainShown = execSync(`git -C ${JSON.stringify(work)} show origin/main:BACKLOG.md`, { encoding: "utf8" });
      check("appendCommitAndPush real-git smoke: origin/main untouched (no direct push)", !mainShown.includes("(P2-901)"));
      const names = execSync(`git -C ${JSON.stringify(work)} diff --name-only origin/${META_BRANCH}~1 origin/${META_BRANCH}`, { encoding: "utf8" }).trim();
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


/**
 * Fake GitHub for landing smokes (R4/R6 merge confirmation): the PR only
 * exists after `pr create`, and `pr view` reports OPEN until a `pr merge`
 * succeeds, then MERGED with the REAL branch head as headRefOid — a landing
 * may only report "pushed" once the squash merge is confirmed with its own
 * commit as the merged head.
 */
function ghMergingIo(realIo: { exec: (cmd: string) => { ok: boolean; output: string } }) {
  let exists = false;
  let state = "OPEN";
  return {
    exec: (cmd: string) => {
      if (cmd.startsWith("gh ")) {
        if (cmd.includes("pr view")) {
          if (!exists) return { ok: false, output: "no pull requests" };
          return { ok: true, output: JSON.stringify({ state, headRefOid: realIo.exec(`git rev-parse origin/${META_BRANCH}`).output.trim() }) };
        }
        if (cmd.includes("pr create")) {
          exists = true;
          return { ok: true, output: "" };
        }
        if (cmd.includes("pr merge")) {
          state = "MERGED";
          return { ok: true, output: "" };
        }
        return { ok: true, output: "" };
      }
      return realIo.exec(cmd);
    },
    sleep: () => Promise.resolve(),
  };
}


// --- P1-076: meta commits land via pilot/meta + PR, never via direct main pushes --
{
  // guard refusal (real git, fake gh): the branch push must never happen
  const gdir = mkdtempSync(join(tmpdir(), "pilot-meta-"));
  try {
    const remote = join(gdir, "origin.git");
    const dir = join(gdir, "work");
    execSync(`git init -q --bare -b main ${JSON.stringify(remote)}`);
    execSync(`git clone -q ${JSON.stringify(remote)} ${JSON.stringify(dir)}`);
    execSync("git config user.email t@t.local && git config user.name t", { cwd: dir });
    writeFileSync(join(dir, "BACKLOG.md"), "# B\n\n## Ready\n\n## Done\n");
    execSync(`git -C ${JSON.stringify(dir)} add BACKLOG.md && git -C ${JSON.stringify(dir)} -c user.name=t -c user.email=t@t commit -qm init`);
    execSync(`git -C ${JSON.stringify(dir)} push -q -u origin main`);
    const baseIo = metaIo(dir);
    const calls: string[] = [];
    const io: MetaPushIo = {
      exec: (cmd) => {
        calls.push(cmd);
        if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\nevil.sh\n" };
        if (cmd.startsWith("gh ")) return { ok: false, output: "gh unavailable" };
        return baseIo.exec(cmd);
      },
      sleep: () => Promise.resolve(),
    };
    const refused = await landMetaCommit(
      dir,
      io,
      {
        files: ["BACKLOG.md"],
        message: "contaminated",
        guardFile: "BACKLOG.md",
        apply: () => {
          // the edit must be real: an empty commit would abort before the guard
          writeFileSync(join(dir, "BACKLOG.md"), "# B\n\n## Ready\n- [ ] (P2-910) [P2] Evil — spec: x (area: ui)\n\n## Done\n");
          return { action: "apply" };
        },
      },
    );
    check("landMetaCommit: guard refusal refuses", refused === "refused");
    check(
      "landMetaCommit: guard refusal ⇒ zero pilot/meta pushes",
      !calls.some((c) => c.startsWith("git push")),
    );
    check("landMetaCommit: refused diff never armed a PR", !calls.some((c) => c.startsWith("gh ") && (c.includes("pr create") || c.includes("pr merge"))));

    // noop vs abort semantics
    let applied = 0;
    const noop = await landMetaCommit(dir, baseIo, {
      files: ["BACKLOG.md"],
      message: "noop",
      guardFile: "BACKLOG.md",
      apply: () => {
        applied++;
        return { action: "noop" };
      },
    });
    check("landMetaCommit: noop is success with zero commits", noop === "pushed" && applied === 1);
    const abort = await landMetaCommit(dir, baseIo, {
      files: ["BACKLOG.md"],
      message: "abort",
      guardFile: "BACKLOG.md",
      apply: () => ({ action: "abort" }),
    });
    check("landMetaCommit: abort reports failed", abort === "failed");

    // R2 review: success requires our commit to stay in the PR head — a peer
    // landing that rewound the shared branch turns our landing into an honest
    // "failed" (retried), never a false "pushed"
    let dropPushes = 0;
    const droppedIo: MetaPushIo = {
      exec: (cmd) => {
        if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
        if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${"a".repeat(40)}\n` };
        if (cmd.startsWith("git merge-base")) return { ok: false, output: "" }; // dropped
        if (cmd.startsWith("git push")) dropPushes++;
        return { ok: true, output: "" };
      },
      sleep: () => Promise.resolve(),
    };
    const dropped = await landMetaCommit(dir, droppedIo, {
      files: ["BACKLOG.md"],
      message: "dropped by peer",
      guardFile: "BACKLOG.md",
      apply: () => ({ action: "apply" }),
    });
    check("landMetaCommit: commit dropped by a peer ⇒ honest failure, never false success", dropped === "failed" && dropPushes === 3);
    // R4 review: an undeterminable sha must fail CLOSED — the landing is
    // retried and, at worst, honestly reported as "failed"; it can never be
    // reported as pushed when the verification could not even run.
    let unverifiablePushes = 0;
    const unverifiable = await landMetaCommit(dir, {
      exec: (cmd) => {
        if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
        if (cmd.startsWith("git rev-parse")) return { ok: true, output: "" }; // sha undeterminable
        if (cmd.startsWith("git push")) unverifiablePushes++;
        return { ok: true, output: "" };
      },
      sleep: () => Promise.resolve(),
    }, {
      files: ["BACKLOG.md"],
      message: "unverifiable",
      guardFile: "BACKLOG.md",
      apply: () => ({ action: "apply" }),
    });
    check("landMetaCommit: undeterminable sha fails closed (retried, never reported pushed)", unverifiable === "failed" && unverifiablePushes === 3);
    // R4 review (arm-vs-merge TOCTOU): an armed --auto that never confirms the
    // merge is an honest failure — caller state (P1-037 pending refill) must
    // not be cleared on an unconfirmed landing.
    let queuedPrKnown = false;
    const neverMerged: MetaPushIo = {
      exec: (cmd) => {
        if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
        if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${"b".repeat(40)}\n` };
        if (cmd.startsWith("git merge-base")) return { ok: true, output: "" };
        if (cmd.startsWith("gh ")) {
          if (cmd.includes("pr view"))
            return queuedPrKnown
              ? { ok: true, output: JSON.stringify({ state: "OPEN", headRefOid: "b".repeat(40) }) }
              : { ok: false, output: "no pull requests" };
          if (cmd.includes("pr create")) {
            queuedPrKnown = true;
            return { ok: true, output: "" };
          }
          return { ok: true, output: "" }; // gh pr merge "succeeds" but stays queued forever
        }
        return { ok: true, output: "" };
      },
      sleep: () => Promise.resolve(),
    };
    const queued = await landMetaCommit(dir, neverMerged, {
      files: ["BACKLOG.md"],
      message: "queued auto-merge",
      guardFile: "BACKLOG.md",
      apply: () => ({ action: "apply" }),
    });
    check("landMetaCommit: auto-merge armed but unconfirmed ⇒ honest failure, state not cleared", queued === "failed");
    // R4/R5 review: arm-phase interleaving — the arm command only QUEUES the
    // merge, so the landing must (a) try --auto first, (b) fall back to the
    // immediate squash when --auto is refused, and (c) keep polling `pr view`
    // with sleeps in between, reporting "pushed" only when GitHub itself
    // reports MERGED with our commit as the head (never on the arm command's
    // own success).
    {
      const ghCalls: string[] = [];
      let views = 0;
      let sleeps = 0;
      let prKnown = false;
      const ourSha = "d".repeat(40);
      const interleaved: MetaPushIo = {
        exec: (cmd) => {
          if (cmd.startsWith("gh ")) {
            ghCalls.push(cmd);
            if (cmd.includes("pr view")) {
              views++;
              if (!prKnown) return { ok: false, output: "no pull requests" };
              // poll 0 OPEN (checks pending), poll 1 MERGED with our head
              return { ok: true, output: JSON.stringify({ state: views >= 4 ? "MERGED" : "OPEN", headRefOid: ourSha }) };
            }
            if (cmd.includes("pr create")) {
              prKnown = true;
              return { ok: true, output: "" };
            }
            if (cmd.includes("pr merge")) {
              // --auto refused (branch protection not configured yet)
              if (cmd.includes("--auto")) return { ok: false, output: "gh: no protection" };
              return { ok: true, output: "" }; // immediate squash accepted
            }
            return { ok: true, output: "" };
          }
          if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
          if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${ourSha}\n` };
          if (cmd.startsWith("git merge-base")) return { ok: true, output: "" };
          return { ok: true, output: "" };
        },
        sleep: () => {
          sleeps++;
          return Promise.resolve();
        },
      };
      const interl = await landMetaCommit(dir, interleaved, {
        files: ["BACKLOG.md"],
        message: "arm-phase interleaving",
        guardFile: "BACKLOG.md",
        apply: () => ({ action: "apply" }),
      });
      const ghShape = ghCalls.map((c) =>
        c.includes("pr view") ? "view" : c.includes("pr create") ? "create" : c.includes("--auto") ? "auto" : "merge",
      );
      check("landMetaCommit: arm-phase interleaving lands only on confirmed MERGED", interl === "pushed");
      check(
        "landMetaCommit: arm order is view → create → auto → immediate squash → confirm polls",
        ghShape[0] === "view" && ghShape[1] === "view" && ghShape[2] === "create" && ghShape[3] === "auto" && ghShape[4] === "merge" && ghShape.slice(5).every((s) => s === "view"),
      );
      check(
        "landMetaCommit: confirmation polls interleave with sleeps until MERGED (never trusts the arm)",
        views === 4 && sleeps === 1,
      );
    }

    // R6 review: the drop-during-arm window — a peer force-push between our
    // ancestry check and the deferred squash replaces the PR head; a MERGED
    // confirmation whose headRefOid is NOT our sha is an honest failure.
    {
      let pushes = 0;
      let armViews = 0;
      let prKnown = false;
      const ourSha = "b".repeat(40);
      const peerSha = "e".repeat(40);
      const dropArm: MetaPushIo = {
        exec: (cmd) => {
          if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
          if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${ourSha}\n` };
          if (cmd.startsWith("git merge-base")) return { ok: true, output: "" };
          if (cmd.startsWith("git push")) pushes++;
          if (cmd.startsWith("gh ")) {
            if (cmd.includes("pr view")) {
              armViews++;
              if (!prKnown) return { ok: false, output: "no pull requests" };
              // after arming: the peer replaces the head and ITS content
              // merges — MERGED without our sha must never read as success
              return {
                ok: true,
                output: JSON.stringify({ state: armViews >= 3 ? "MERGED" : "OPEN", headRefOid: armViews >= 3 ? peerSha : ourSha }),
              };
            }
            if (cmd.includes("pr create")) {
              prKnown = true;
              return { ok: true, output: "" };
            }
            return { ok: true, output: "" }; // pr merge --auto armed
          }
          return { ok: true, output: "" };
        },
        sleep: () => Promise.resolve(),
      };
      const droppedInArm = await landMetaCommit(dir, dropArm, {
        files: ["BACKLOG.md"],
        message: "drop-during-arm",
        guardFile: "BACKLOG.md",
        apply: () => ({ action: "apply" }),
      });
      check("landMetaCommit: MERGED with a replaced head is an honest failure (drop-during-arm)", droppedInArm === "failed" && pushes === 1);
    }

    // R6 review: a landing that starts while a PEER's meta PR is pending must
    // wait for the squash to confirm (no rewind of the pending head, no
    // check-restart livelock) — its own push may only happen after MERGED.
    {
      let state = "OPEN";
      let head = "f".repeat(40); // peer's pending landing
      let views = 0;
      let pushes = 0;
      let sleepsBeforePush = 0;
      const ourSha = "9".repeat(40);
      const peerPending: MetaPushIo = {
        exec: (cmd) => {
          if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
          if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${ourSha}\n` };
          if (cmd.startsWith("git merge-base")) return { ok: true, output: "" };
          if (cmd.startsWith("git push")) {
            pushes++;
            head = ourSha;
          }
          if (cmd.startsWith("gh ")) {
            if (cmd.includes("pr view")) {
              views++;
              if (views >= 3) state = "MERGED"; // peer's checks finish mid-wait
              return { ok: true, output: JSON.stringify({ state, headRefOid: head }) };
            }
            if (cmd.includes("pr create")) return { ok: true, output: "" };
            if (cmd.includes("pr merge")) {
              state = "MERGED";
              return { ok: true, output: "" };
            }
            return { ok: true, output: "" };
          }
          return { ok: true, output: "" };
        },
        sleep: () => {
          if (pushes === 0) sleepsBeforePush++;
          return Promise.resolve();
        },
      };
      const waited = await landMetaCommit(dir, peerPending, {
        files: ["BACKLOG.md"],
        message: "wait for pending peer",
        guardFile: "BACKLOG.md",
        apply: () => ({ action: "apply" }),
      });
      check("landMetaCommit: pending peer PR is waited out, then landed after MERGED", waited === "pushed" && pushes === 1 && sleepsBeforePush >= 2);
    }

    // R6 review: budget exhausted while the checks run ⇒ honest failure with
    // caller state intact; the next-cycle retry after the queued merge lands
    // converges as a noop success (desired state present) — never abort forever.
    {
      let known = false;
      let merged = false;
      let convPushes = 0;
      const ourSha = "7".repeat(40);
      const landedLine = "- [ ] (P2-911) [P2] Convergence — spec: x (area: ui)";
      const convIo: MetaPushIo = {
        exec: (cmd) => {
          if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
          if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${ourSha}\n` };
          if (cmd.startsWith("git merge-base")) return { ok: true, output: "" };
          if (cmd.startsWith("git push")) convPushes++;
          // model the deferred squash finally landing: after the merge the
          // rewind to origin/main restores a BACKLOG that already has the line
          if (cmd.includes(`git checkout -q -B ${META_BRANCH}`) && merged)
            writeFileSync(join(dir, "BACKLOG.md"), `# B\n\n## Ready\n${landedLine}\n\n## Done\n`);
          if (cmd.startsWith("gh ")) {
            if (cmd.includes("pr view"))
              return known
                ? { ok: true, output: JSON.stringify({ state: merged ? "MERGED" : "OPEN", headRefOid: ourSha }) }
                : { ok: false, output: "no pull requests" };
            if (cmd.includes("pr create")) {
              known = true;
              return { ok: true, output: "" };
            }
            return { ok: true, output: "" }; // pr merge --auto arms, checks pending
          }
          return { ok: true, output: "" };
        },
        sleep: () => Promise.resolve(),
      };
      const spec = {
        files: ["BACKLOG.md"],
        message: "convergence",
        guardFile: "BACKLOG.md",
        apply: () => {
          const md = readFileSync(join(dir, "BACKLOG.md"), "utf8");
          if (md.includes("(P2-911)")) return { action: "noop" as const };
          writeFileSync(join(dir, "BACKLOG.md"), md.replace("## Ready\n", `## Ready\n${landedLine}\n`));
          return { action: "apply" as const };
        },
      };
      const firstTry = await landMetaCommit(dir, convIo, spec);
      check("landMetaCommit: checks running past the budget ⇒ honest failure, no false success", firstTry === "failed" && convPushes === 1);
      merged = true; // the queued auto-merge finally lands between cycles
      const retry = await landMetaCommit(dir, convIo, spec);
      check("landMetaCommit: next-cycle retry after the queued merge converges as a noop success", retry === "pushed" && convPushes === 1);
    }

    // dir-prefix guard (corpus shape): several files inside the dir are allowed
    check("mayPushUnderDir: every file under the dir passes", mayPushUnderDir("d/a.txt\nd/b.txt\n", "d"));
    check("mayPushUnderDir: file outside the dir refuses", mayPushUnderDir("d/a.txt\nx.sh\n", "d") === false);
    check("mayPushUnderDir: empty diff refuses", mayPushUnderDir("", "d") === false);
    // R5 review: the corpus guard is the one multi-file path into main — the
    // landing cap and the appendCorpusSample filename shape must be enforced,
    // not just the directory prefix (arbitrary planted files refuse).
    const corpusFiles = [
      "apps/pilot/src/__fixtures__/gate-corpus/npm-run-typecheck-silent/1-abc1234.txt",
      "apps/pilot/src/__fixtures__/gate-corpus/npm-run-test-unit-silent/7-def5678.txt",
    ].join("\n");
    const corpusOpts = { maxFiles: 3, fileName: CORPUS_SAMPLE_RE };
    check("mayPushUnderDir: real sample filenames within the cap pass", mayPushUnderDir(corpusFiles + "\n", "apps/pilot/src/__fixtures__/gate-corpus", corpusOpts));
    check("mayPushUnderDir: over the per-landing file cap refuses", mayPushUnderDir(`${corpusFiles}\napps/pilot/src/__fixtures__/gate-corpus/npm-run-build-silent/2-abc1234.txt\n`, "apps/pilot/src/__fixtures__/gate-corpus", { ...corpusOpts, maxFiles: 2 }) === false);
    check(
      "mayPushUnderDir: filename not matching the sample shape refuses",
      mayPushUnderDir("apps/pilot/src/__fixtures__/gate-corpus/npm-run-typecheck-silent/planted.sh\n", "apps/pilot/src/__fixtures__/gate-corpus", corpusOpts) === false,
    );

    // real-git smoke: landing lands the commit on origin/pilot/meta with gh faked
    const realIo = metaIo(dir);
    let prState = "OPEN";
    let prExists = false;
    const ghIo: MetaPushIo = {
      exec: (cmd) => {
        if (cmd.startsWith("gh ")) {
          if (cmd.includes("pr view")) {
            if (!prExists) return { ok: false, output: "no pull requests" };
            const head = realIo.exec(`git rev-parse origin/${META_BRANCH}`).output.trim();
            return { ok: true, output: JSON.stringify({ state: prState, headRefOid: head }) };
          }
          if (cmd.includes("pr create")) {
            prExists = true;
            return { ok: true, output: "" };
          }
          if (cmd.includes("pr merge")) {
            prState = "MERGED"; // fake GitHub: the squash merge completes
            return { ok: true, output: "" };
          }
          return { ok: true, output: "" };
        }
        return realIo.exec(cmd);
      },
      sleep: () => Promise.resolve(),
    };
    const landed = await landMetaCommit(dir, ghIo, {
      files: ["BACKLOG.md"],
      message: "pilot(meta): smoke",
      guardFile: "BACKLOG.md",
      apply: () => {
        writeFileSync(join(dir, "BACKLOG.md"), "# B\n\n## Ready\n- [ ] (P2-909) [P2] Meta smoke — spec: x (area: ui)\n\n## Done\n");
        return { action: "apply" };
      },
    });
    check("landMetaCommit real-git smoke: landing reports pushed", landed === "pushed");
    const branchShown = execSync(`git -C ${JSON.stringify(dir)} show origin/${META_BRANCH}:BACKLOG.md`, { encoding: "utf8" });
    check("landMetaCommit real-git smoke: commit is on origin/pilot/meta", branchShown.includes("(P2-909)"));
    const mainShown = execSync(`git -C ${JSON.stringify(dir)} show origin/main:BACKLOG.md`, { encoding: "utf8" });
    check("landMetaCommit real-git smoke: origin/main untouched", !mainShown.includes("(P2-909)"));
    const branchName = execSync(`git -C ${JSON.stringify(dir)} rev-parse --abbrev-ref HEAD`, { encoding: "utf8" }).trim();
    check("landMetaCommit real-git smoke: worktree left on main", branchName === "main");
  } finally {
    rmSync(gdir, { recursive: true, force: true });
  }

  // grep-style acceptance check (P1-076): no pilot source site may push or
  // locally merge into main anymore — the meta PR is the only path.
  const pilotSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "pilot", "src");
  const offenders: string[] = [];
  for (const entry of readdirSync(pilotSrc, { recursive: true })) {
    const rel = entry.toString();
    if (!rel.endsWith(".ts") || rel.includes("__fixtures__")) continue;
    const src = readFileSync(join(pilotSrc, rel), "utf8");
    if (/push -q origin main/.test(src) || /git merge -q --no-ff/.test(src)) offenders.push(rel);
  }
  check("metapush: no site pushes origin main or locally merges into main", offenders.length === 0 && offenders.join(",") === "");
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
      // P1-076: landings go through the pilot/meta PR — fake gh as OPEN+mergeable
      const gh = ghMergingIo(realIo);
      const pushDownIo: AuxPushIo = {
        exec: (cmd) => (cmd.startsWith("git push") ? { ok: false, output: "" } : gh.exec(cmd)),
        sleep: () => Promise.resolve(),
      };
      let pushes = 0;
      const countingIo: AuxPushIo = {
        exec: (cmd) => {
          if (cmd.startsWith("git push")) pushes++;
          return gh.exec(cmd);
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
      const shown = execSync(`git -C ${JSON.stringify(work)} show origin/${META_BRANCH}:BACKLOG.md`, { encoding: "utf8" });
      check("pendingRefill: relanded line is on origin/pilot/meta", shown.includes("(P3-951)"));
      // simulate the meta PR's squash-merge completing so origin/main carries it
      execSync(`git -C ${JSON.stringify(work)} push -q origin ${META_BRANCH}:main`);
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


// --- P2-137 specFails: the spec-format free-retry survives the midnight rollover --
{
  const dir = mkdtempSync(join(tmpdir(), "pilot-state-"));
  try {
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ date: "2026-01-01", tasks: 1, deploys: 0, failures: 0, taskAttempts: {}, specFails: { "P2-137": 1 } }));
    const rolled = loadState(file);
    check("loadState keeps specFails across midnight", rolled.specFails?.["P2-137"] === 1);
    writeFileSync(file, JSON.stringify({ date: "2026-01-01", tasks: 1, deploys: 0, failures: 0 }));
    check("loadState backfills missing specFails", Object.keys(loadState(file).specFails ?? {}).length === 0);
    writeFileSync(file, JSON.stringify({ date: "2026-01-01", tasks: 1, deploys: 0, failures: 0, specFails: { "P2-137": "garbage", "P0-001": 2 } }));
    check("loadState drops garbage specFails entries", loadState(file).specFails?.["P2-137"] === undefined && loadState(file).specFails?.["P0-001"] === 2);
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


// --- P2-165 writeStateAtomic: daemon.json survives a crash mid-write ------------
{
  const makeFs = () => {
    const files = new Map<string, string>();
    const createdModes: number[] = [];
    const renames: string[] = [];
    const unlinks: string[] = [];
    let failWrite = false;
    let failRename = false;
    const io: StateFileFs = {
      writeFileSync: (f, d, opts) => {
        if (failWrite) throw new Error("ENOSPC: disk full");
        files.set(f, d);
        createdModes.push(opts.mode);
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
    return {
      io,
      files,
      createdModes,
      renames,
      unlinks,
      breakWrite: () => (failWrite = true),
      breakRename: () => (failRename = true),
    };
  };

  const dest = "/mock/daemon.json";
  const tmp = `${dest}.tmp`;
  const payload = JSON.stringify({ room: "r", ecdhPub: "pk", clients: [] }, null, 2);

  // happy path: payload lands in the destination through the temp rename,
  // temp file always created 0600, no residue
  const ok = makeFs();
  writeStateAtomic(dest, payload, ok.io);
  check("writeStateAtomic: rename swaps the destination", ok.files.get(dest) === payload);
  check("writeStateAtomic: .tmp never survives on success", ok.files.has(tmp) === false && ok.renames.join() === `${tmp}->${dest}`);
  check("writeStateAtomic: temp is created 0600", ok.createdModes.length === 1 && ok.createdModes.every((m) => m === 0o600));

  // crash/disk-full mid-write: previous state file stays intact, no rename
  const badWrite = makeFs();
  badWrite.files.set(dest, "previous-good-identity");
  badWrite.breakWrite();
  let threw = false;
  try {
    writeStateAtomic(dest, payload, badWrite.io);
  } catch {
    threw = true;
  }
  check("writeStateAtomic: failed write keeps the previous file intact", threw && badWrite.files.get(dest) === "previous-good-identity" && badWrite.renames.length === 0);
  check("writeStateAtomic: failed write removes the .tmp", threw && badWrite.files.has(tmp) === false && badWrite.unlinks.join() === tmp);

  // failed rename: same cleanup contract, destination untouched
  const badRename = makeFs();
  badRename.files.set(dest, "previous-good-identity");
  badRename.breakRename();
  threw = false;
  try {
    writeStateAtomic(dest, payload, badRename.io);
  } catch {
    threw = true;
  }
  check("writeStateAtomic: failed rename rethrows and cleans the .tmp", threw && badRename.files.has(tmp) === false && badRename.unlinks.join() === tmp);
  check("writeStateAtomic: failed rename leaves the old destination intact", badRename.files.get(dest) === "previous-good-identity");

  // real fs binding: on-disk destination is private (0600) from creation
  const dir = mkdtempSync(join(tmpdir(), "daemon-statefile-"));
  try {
    const file = join(dir, "daemon.json");
    writeStateAtomic(file, payload);
    check("writeStateAtomic: real fs lands 0600 at the destination", (statSync(file).mode & 0o777) === 0o600);
    check("writeStateAtomic: real fs round-trips and leaves no .tmp", readFileSync(file, "utf8") === payload && readdirSync(dir).join() === "daemon.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // the default binding really is the node one (no accidental test-only io)
  check("writeStateAtomic: node binding wired", typeof nodeStateFileFs.writeFileSync === "function" && typeof nodeStateFileFs.renameSync === "function" && typeof nodeStateFileFs.unlinkSync === "function");
}


// --- P2-167 appendAudit/readAuditTail: audit.log is 0600, capped and readable
// across rotation (security events must not grow forever or be born readable) --
{
  const LINE = (i: number) => `{"ts":"2026-01-01T00:00:0${i}Z","event":"e${i}"}\n`;
  const RAW = (i: number) => LINE(i).slice(0, -1); // what readAuditTail returns

  const makeFs = () => {
    const files = new Map<string, string>();
    const createdModes: number[] = [];
    const renames: string[] = [];
    const unlinks: string[] = [];
    let failAppend = false;
    const io: AuditLogFs = {
      statSync: (f) => {
        const v = files.get(f);
        if (v === undefined) throw new Error(`ENOENT: ${f}`);
        return { size: v.length };
      },
      renameSync: (from, to) => {
        const v = files.get(from);
        if (v === undefined) throw new Error(`ENOENT: ${from}`);
        files.delete(from);
        files.set(to, v);
        renames.push(`${from}->${to}`);
      },
      unlinkSync: (f) => {
        if (!files.has(f)) throw new Error(`ENOENT: ${f}`);
        unlinks.push(f);
        files.delete(f);
      },
      appendFileSync: (f, data, opts) => {
        if (failAppend) throw new Error("ENOSPC: disk full");
        if (!files.has(f)) createdModes.push(opts.mode);
        files.set(f, (files.get(f) ?? "") + data);
      },
      readFileSync: (f) => {
        const v = files.get(f);
        if (v === undefined) throw new Error(`ENOENT: ${f}`);
        return v;
      },
    };
    return { io, files, createdModes, renames, unlinks, breakAppend: () => (failAppend = true) };
  };

  const file = "/mock/audit.log";
  const one = `${file}.1`;
  const cap = LINE(1).length;

  // 0600-from-creation: the mode rides on the creating append only
  const fresh = makeFs();
  appendAudit(file, LINE(1), fresh.io, cap * 10);
  appendAudit(file, LINE(2), fresh.io, cap * 10);
  check("appendAudit: file is created 0600 when absent", fresh.createdModes.length === 1 && fresh.createdModes[0] === 0o600);

  // below the cap: everything stays in the active file, no rotation
  const below = makeFs();
  const belowCap = cap * 10;
  appendAudit(file, LINE(1), below.io, belowCap);
  appendAudit(file, LINE(2), below.io, belowCap);
  check("appendAudit: below the cap there is no rotation", below.files.get(file) === LINE(1) + LINE(2) && below.renames.length === 0 && !below.files.has(one));

  // rotation exactly at the cap: active file reaches cap -> next append rotates
  const at = makeFs();
  appendAudit(file, LINE(1), at.io, cap);
  check("appendAudit: file at the cap holds the first line", at.files.get(file) === LINE(1) && at.renames.length === 0);
  appendAudit(file, LINE(2), at.io, cap);
  check("appendAudit: rotation exactly at the cap moves the active file to .1", at.files.get(one) === LINE(1) && at.files.get(file) === LINE(2) && at.renames.join() === `${file}->${one}`);
  check("appendAudit: rotated .1 was never recreated by unlinking a missing file", at.unlinks.length === 0);

  // second rotation replaces the previous .1 (exactly 2 files on disk, ever)
  appendAudit(file, LINE(3), at.io, cap);
  check("appendAudit: second rotation replaces the previous .1", at.files.get(one) === LINE(2) && at.files.get(file) === LINE(3) && at.unlinks.join() === one);

  // tail spanning both files: .1 (older) first, active file (newer) last
  const span = makeFs();
  span.files.set(one, LINE(1) + LINE(2) + LINE(3));
  span.files.set(file, LINE(4) + LINE(5));
  check(
    "readAuditTail: tail spans both files in chronological order",
    JSON.stringify(readAuditTail(file, 4, span.io)) === JSON.stringify([RAW(2), RAW(3), RAW(4), RAW(5)]),
  );
  check("readAuditTail: tail larger than both files returns everything", JSON.stringify(readAuditTail(file, 100, span.io)) === JSON.stringify([RAW(1), RAW(2), RAW(3), RAW(4), RAW(5)]));

  // tail fitting in the active file alone: .1 is not consulted
  const activeOnly = makeFs();
  activeOnly.files.set(one, LINE(1) + LINE(2));
  activeOnly.files.set(file, LINE(3) + LINE(4));
  check("readAuditTail: tail within the active file ignores .1", JSON.stringify(readAuditTail(file, 2, activeOnly.io)) === JSON.stringify([RAW(3), RAW(4)]));

  // missing/unreadable files: empty tail, never an exception
  let threw = false;
  let tail: string[] = [];
  try {
    tail = readAuditTail("/mock/absent.log", 10, makeFs().io);
  } catch {
    threw = true;
  }
  check("readAuditTail: missing files yield an empty tail, no exception", !threw && tail.length === 0);
  const unreadable = makeFs();
  unreadable.io.readFileSync = () => {
    throw new Error("EACCES: not readable");
  };
  check("readAuditTail: unreadable files yield an empty tail, no exception", JSON.stringify(readAuditTail(file, 10, unreadable.io)) === "[]");

  // write failure: audit is best-effort, the exception must never propagate
  const failing = makeFs();
  failing.breakAppend();
  let appendThrew = false;
  try {
    appendAudit(file, LINE(1), failing.io, cap);
  } catch {
    appendThrew = true;
  }
  check("appendAudit: write failure never propagates an exception", !appendThrew);

  // rotation failure: degrade to appending into the (oversized) active file
  const badRotate = makeFs();
  badRotate.files.set(file, LINE(1));
  badRotate.io.renameSync = () => {
    throw new Error("rename boom");
  };
  let rotateThrew = false;
  try {
    appendAudit(file, LINE(2), badRotate.io, cap);
  } catch {
    rotateThrew = true;
  }
  check("appendAudit: failed rotation never propagates and still records the event", !rotateThrew && badRotate.files.get(file) === LINE(1) + LINE(2));

  // real fs: created 0600 on disk, rotation leaves exactly audit.log + .1
  const dir = mkdtempSync(join(tmpdir(), "daemon-auditlog-"));
  try {
    const real = join(dir, "audit.log");
    appendAudit(real, LINE(1), nodeAuditLogFs, cap);
    appendAudit(real, LINE(2), nodeAuditLogFs, cap);
    appendAudit(real, LINE(3), nodeAuditLogFs, cap);
    check("appendAudit: real fs creates the active file 0600", (statSync(real).mode & 0o777) === 0o600);
    check("appendAudit: real fs keeps exactly 2 files after rotation", readdirSync(dir).sort().join() === "audit.log,audit.log.1");
    check(
      "readAuditTail: real fs tail crosses the rotation in chronological order",
      JSON.stringify(readAuditTail(real, 2, nodeAuditLogFs)) === JSON.stringify([RAW(2), RAW(3)]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // the shipped cap is the same 1MB contract the desktop side uses
  check("appendAudit: default cap is 1MB", AUDIT_CAP_BYTES === 1_000_000);
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
  check("pickTasks: untagged tasks are independent — full parallelism across slots", pickTasks(untaggedPair, 2, new Set()).map((t) => t.id).join(",") === "T-103,T-106");
  check("pickTasks: explicit same-area tasks still dedupe (affinity rules)", pickTasks([byId("T-101"), { ...byId("T-101"), id: "T-107" }], 2, new Set()).length === 1);
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


// --- P1-099 eager-fill: every pipeline end backfills ALL free slots ------------
{
  const eagerQueue = parseBacklog(
    [
      "## Ready",
      "",
      "- [ ] (E-001) [P1] UI one — spec: x (area: ui)",
      "- [ ] (E-002) [P1] Daemon one — spec: x (area: daemon)",
      "- [ ] (E-003) [P1] UI two — spec: x (area: ui)",
    ].join("\n"),
  );
  const maxTasks = 3; // budget equals the queue: only scheduling order matters
  let tasksDone = 0;
  let areaViolations = 0;
  let eagerStarts = 0;
  const running = new Map<number, { task: Task; done: Promise<void> }>();
  const doneIds = new Set<string>();
  // mirrors apps/pilot/src/index.ts fillFreeSlots: synchronous pick over the
  // fresh queue, called from the main loop AND from every worker's finally.
  const fillFreeSlots = (queue: Task[], reason: "loop" | "eager-fill") => {
    const free = [1, 2].filter((s) => !running.has(s));
    if (free.length === 0) return;
    const busy = new Set([...running.values()].map((r) => areaKey(r.task)));
    const remaining = maxTasks - tasksDone - running.size;
    for (const t of pickBatch(queue, free.length, busy, remaining)) {
      const slot = free.find((s) => !running.has(s))!;
      if ([...running.values()].some((r) => areaKey(r.task) === areaKey(t))) areaViolations++;
      if (reason === "eager-fill") eagerStarts++;
      const done = (async () => {
        // workers finish out of order, like real pipelines (slot 1 first)
        await new Promise((resolve) => setTimeout(resolve, 5 + ((slot * 4) % 11)));
        tasksDone++;
        doneIds.add(t.id);
        running.delete(slot);
        // P1-099 finally hook: refill ALL free slots the moment a slot frees
        fillFreeSlots(queue.filter((x) => !doneIds.has(x.id)), "eager-fill");
      })();
      running.set(slot, { task: t, done });
    }
  };
  fillFreeSlots(eagerQueue, "loop"); // main-loop fill
  check("P1-099 eager-fill: both slots fill when the 3 tasks span >= 2 area keys", running.size === 2);
  while (running.size > 0) {
    await Promise.all([...running.values()].map((r) => r.done));
  }
  check("P1-099 eager-fill: a pipeline end immediately starts the next schedulable task", eagerStarts >= 1);
  check("P1-099 eager-fill: every queued task scheduled exactly once", doneIds.size === 3);
  check("P1-099 eager-fill: same-area tasks never run concurrently", areaViolations === 0);

  // 1 slot busy on ui: the freed slot picks the next DISTINCT-key task and the
  // same-key task stays queued (P1-006 area rule preserved under eager-fill)
  check(
    "P1-099 eager-fill: freed slot picks a distinct-key task, same-key stays queued",
    pickBatch([eagerQueue[1]!, eagerQueue[2]!], 1, new Set([areaKey(eagerQueue[0]!)]), 3)
      .map((t) => t.id)
      .join(",") === "E-002",
  );
  // all-same-area queue → nothing extra picked on the eager fill
  check(
    "P1-099 eager-fill: all-same-area queue picks nothing extra",
    pickBatch([eagerQueue[0]!, eagerQueue[2]!], 1, new Set([areaKey(eagerQueue[0]!)]), 3).length === 0,
  );
  // budget exhausted → nothing picked, even with both slots free
  check("P1-099 eager-fill: budget 0 picks nothing", pickBatch(eagerQueue, 2, new Set(), 0).length === 0);
}


// --- P1-078 cache affinity: slot assignment + staggered starts -------------------
{
  const AFFINITY_QUEUE = parseBacklog(
    [
      "## Ready",
      "",
      "- [ ] (A-001) [P1] UI one — spec: x (area: ui)",
      "- [ ] (A-002) [P1] Daemon one — spec: x (area: daemon)",
      "- [ ] (A-003) [P1] Solo one — spec: x",
      "- [ ] (A-004) [P1] Solo two — spec: y",
    ].join("\n"),
  );
  const byId = (id: string) => AFFINITY_QUEUE.find((t) => t.id === id)!;
  const now = 1_000_000_000;
  const warm: SlotAffinity[] = [
    { slot: 2, area: "area:ui", at: now - 60_000 },
    { slot: 1, area: "area:daemon", at: now - 120_000 },
  ];
  // a same-area task prefers the slot that just ran that shape (warm prefix)
  check("affinity: ui task prefers the slot that just ran ui", assignSlots([byId("A-001")], [1, 2], new Set(), warm, now).get("A-001") === 2);
  // most recent same-area run wins
  const contested: SlotAffinity[] = [
    { slot: 1, area: "area:ui", at: now - 120_000 },
    { slot: 2, area: "area:ui", at: now - 30_000 },
  ];
  check("affinity: most recent same-area run wins", assignSlots([byId("A-001")], [1, 2], new Set(), contested, now).get("A-001") === 2);
  // expired affinity → lowest-numbered free slot (cold start is fine after 10min)
  check("affinity: expired TTL falls back to the lowest slot", assignSlots([byId("A-001")], [1, 2], new Set(), warm, now + AFFINITY_TTL_MS + 1).get("A-001") === 1);
  // a busy area is never assigned (P1-006 rule upstream of affinity)
  check("affinity: busy area never assigned", assignSlots([byId("A-001")], [1, 2], new Set(["area:ui"]), warm, now).size === 0);
  // solo keys are serial by P1-006 and never gain affinity
  check("affinity: solo tasks never gain affinity", assignSlots([byId("A-003")], [1, 2], new Set(), warm, now).get("A-003") === 1);
  // two picks in one batch land on distinct slots
  const two = assignSlots([byId("A-001"), byId("A-002")], [1, 2], new Set(), warm, now);
  check("affinity: two picks never share a slot", two.get("A-001") === 2 && two.get("A-002") === 1);
  // staggered starts: the first pick goes now, the rest wait 20s each
  check("stagger: first pick starts immediately", startDelayMs(0) === 0);
  check("stagger: 20s between simultaneous slot starts", startDelayMs(1) === 20_000 && startDelayMs(2) === 40_000 && SLOT_START_STAGGER_MS === 20_000);
}


// --- artifacts (P1-010) -------------------------------------------------------
check("validSegment accepts ids/names", validSegment("ses_abc123") && validSegment("report-1.html"));

check("validSegment rejects traversal", !validSegment("..") && !validSegment("../etc") && !validSegment("a/b"));

check("kindFor kinds", kindFor("a.pdf") === "pdf" && kindFor("a.html") === "html" && kindFor("a.md") === "md" && kindFor("a.csv") === "csv" && kindFor("a.exe") === "binary");

check("artifactMime csv", artifactMime("a.csv") === "text/csv; charset=utf-8");

// P2-097: preview MIME is derived from the file name — pin the shape the
// viewer blobs carry (case-insensitive ext, safe default for unknowns)
check(
  "artifactMime derives from the name (case-insensitive, safe default)",
  artifactMime("relatorio.PDF") === "application/pdf" &&
    artifactMime("img.PNG") === "image/png" &&
    artifactMime("noext") === "application/octet-stream" &&
    artifactMime("a.svg") === "image/svg+xml",
);

const aroot = mkdtempSync(join(tmpdir(), "ocr-artifacts-"));

try {
  mkdirSync(join(aroot, "ses_test"));
  writeFileSync(join(aroot, "ses_test", "index.html"), "<h1>oi</h1>");
  writeFileSync(join(aroot, "ses_test", "data.csv"), "a,b\n1,2");
  symlinkSync(join(aroot, "ses_test", "index.html"), join(aroot, "ses_test", "symlink.html"));
  symlinkSync("/etc/hosts", join(aroot, "ses_test", "outside.html"));
  const readOf = (sid: string, name: string) => {
    const r = readArtifact(sid, name, aroot);
    return r.ok ? "ok" : r.reason;
  };
  check(
    "readArtifact reads inside root",
    readOf("ses_test", "index.html") === "ok" &&
      readArtifact("ses_test", "index.html", aroot).ok &&
      (readArtifact("ses_test", "index.html", aroot) as { data: Buffer }).data.toString() === "<h1>oi</h1>",
  );
  check(
    "readArtifact blocks traversal",
    readOf("ses_test", "..") === "invalid" &&
      readOf("ses_test", "../../daemon.json") === "invalid" &&
      readOf("../evil", "x.html") === "invalid",
  );
  check("readArtifact missing is missing", readOf("ses_test", "nope.html") === "missing");
  check(
    "readArtifact refuses symlinks (even to outside the root)",
    readOf("ses_test", "symlink.html") === "missing" && readOf("ses_test", "outside.html") === "missing",
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
  // P2-097: size cap — at the limit the bytes flow, one byte over is refused
  // with a distinct reason so routes can answer 413 instead of eating RAM
  writeFileSync(join(aroot, "ses_test", "max.bin"), Buffer.alloc(MAX_ARTIFACT_BYTES, 7));
  writeFileSync(join(aroot, "ses_test", "over.bin"), Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 7));
  check(
    "readArtifact caps at MAX_ARTIFACT_BYTES with a distinct too-large reason",
    MAX_ARTIFACT_BYTES === 5_000_000 &&
      readOf("ses_test", "max.bin") === "ok" &&
      readOf("ses_test", "over.bin") === "too-large",
  );
} finally {
  rmSync(aroot, { recursive: true, force: true });
}


// --- P2-173: the listing cap — capArtifacts cuts the tail, never reorders ----
{
  const meta = (i: number): ArtifactMeta => ({
    sessionId: `ses_${i % 3}`,
    name: `f-${i}.md`,
    size: i,
    mtime: 1_000_000 - i, // already sorted newest-first (i=0 is the newest)
    kind: "md",
  });

  check("capArtifacts: list under the cap — truncated false, total real, order kept", (() => {
    const list = [0, 1, 2].map(meta);
    const r = capArtifacts(list, MAX_ARTIFACTS_LISTED);
    return (
      r.items.length === 3 &&
      r.total === 3 &&
      r.truncated === false &&
      r.items[0].name === "f-0.md" && r.items[2].name === "f-2.md" // order preserved
    );
  })());

  check("capArtifacts: list exactly at the cap — truncated false", (() => {
    const list = Array.from({ length: MAX_ARTIFACTS_LISTED }, (_, i) => meta(i));
    const r = capArtifacts(list, MAX_ARTIFACTS_LISTED);
    return r.items.length === MAX_ARTIFACTS_LISTED && r.total === MAX_ARTIFACTS_LISTED && r.truncated === false;
  })());

  check(
    "capArtifacts: list over the cap — exactly the cap of items starting at the newest, truncated true, real total",
    (() => {
      const list = Array.from({ length: 620 }, (_, i) => meta(i));
      const r = capArtifacts(list, MAX_ARTIFACTS_LISTED);
      return (
        MAX_ARTIFACTS_LISTED === 500 &&
        r.items.length === 500 &&
        r.items[0].name === "f-0.md" && // newest first
        r.items[499]?.name === "f-499.md" &&
        r.items[500] === undefined &&
        r.total === 620 &&
        r.truncated === true
      );
    })(),
  );

  check("capArtifacts: empty list — nothing, not truncated", (() => {
    const r = capArtifacts([], MAX_ARTIFACTS_LISTED);
    return r.items.length === 0 && r.total === 0 && r.truncated === false;
  })());

  check(
    "capArtifacts: missing/zero/negative/fractional/non-numeric cap falls back to the default (fail-closed, never uncapped)",
    (() => {
      const list = Array.from({ length: MAX_ARTIFACTS_LISTED + 1 }, (_, i) => meta(i));
      const fallback = (cap: unknown) => {
        const r = capArtifacts(list, cap as never);
        return r.items.length === MAX_ARTIFACTS_LISTED && r.truncated === true && r.total === MAX_ARTIFACTS_LISTED + 1;
      };
      return (
        MAX_ARTIFACTS_LISTED === 500 &&
        fallback(undefined) && // missing
        fallback(0) && // zero must NOT disable the cap
        fallback(-1) &&
        fallback(2.5) && // fractional
        fallback(Number.NaN) &&
        fallback("50") && // non-numeric
        fallback(null)
      );
    })(),
  );
}


// --- artifacts protocol injection into daemon sessions (P1-068, P1-096) ----------
{
  const block = buildArtifactsPrompt();
  check(
    "artifacts prompt: marker, [file: line, localhost preview pin — and NO per-session dir",
    block.includes(ARTIFACTS_MARKER) &&
      block.includes("[file:") &&
      block.includes("http://localhost:<porta>") &&
      !block.includes(join(homedir(), ".opencode-remote", "artifacts")) &&
      !block.includes("ses_"),
  );
  const sesA: { parts: unknown[]; system?: string } = { parts: [{ type: "text", text: "a" }] };
  const sesB: { parts: unknown[]; system?: string } = { parts: [{ type: "text", text: "b" }] };
  injectArtifactsSystem(sesA);
  injectArtifactsSystem(sesB);
  check(
    "P1-096: system block is byte-identical across sessions (provider prefix cache)",
    typeof sesA.system === "string" &&
      sesA.system.length > 0 &&
      sesA.system === sesB.system,
  );
  const pathLine = buildArtifactsPathLine("ses_a");
  check(
    "P1-096: path line carries the marker and the session's absolute artifacts dir",
    pathLine.includes("[ocr-artifacts-path]") &&
      pathLine.includes(join(homedir(), ".opencode-remote", "artifacts", "ses_a")),
  );
  const turn: { parts: unknown[]; system?: string } = {
    parts: [{ type: "text", text: "oi" }, { type: "file", mime: "image/png" }],
  };
  check("P1-096: path part appended on the first turn", injectArtifactsPathPart(turn, "ses_a") === true);
  check(
    "P1-096: path part is the LAST part, user parts intact",
    turn.parts.length === 3 &&
      JSON.stringify(turn.parts[0]) === JSON.stringify({ type: "text", text: "oi" }) &&
      (turn.parts[1] as { mime?: string }).mime === "image/png" &&
      (turn.parts[2] as { text: string }).text === buildArtifactsPathLine("ses_a"),
  );
  check(
    "P1-096: second path-part call is a no-op (marker dedupe)",
    injectArtifactsPathPart(turn, "ses_a") === false && turn.parts.length === 3,
  );
  const noParts: { system?: string } = {};
  check("P1-096: body without parts → path part skipped", injectArtifactsPathPart(noParts, "ses_a") === false);
  const noText: { parts: unknown[] } = { parts: [{ mime: "image/png" }] };
  check(
    "P1-096: body with no text part → path part skipped (fail-open)",
    injectArtifactsPathPart(noText, "ses_a") === false && noText.parts.length === 1,
  );
  const wroot = mkdtempSync(join(tmpdir(), "ocr-sessionctx-"));
  try {
    mkdirSync(join(wroot, "covered"));
    writeFileSync(join(wroot, "covered", "AGENTS.md"), "escreva em ~/.opencode-remote/artifacts/<sessionId>/");
    check("workspaceCoversArtifacts: AGENTS.md with the artifacts path → true", workspaceCoversArtifacts(join(wroot, "covered")));
    mkdirSync(join(wroot, "marker"));
    writeFileSync(join(wroot, "marker", "agents.md"), `bloco com ${ARTIFACTS_MARKER} presente`);
    check("workspaceCoversArtifacts: lowercase agents.md with the marker → true", workspaceCoversArtifacts(join(wroot, "marker")));
    mkdirSync(join(wroot, "uncovered"));
    writeFileSync(join(wroot, "uncovered", "AGENTS.md"), "# regras\n- fuso GMT-3\n");
    check("workspaceCoversArtifacts: AGENTS.md without the protocol → false", !workspaceCoversArtifacts(join(wroot, "uncovered")));
    check("workspaceCoversArtifacts: no AGENTS.md → false (fail-open)", !workspaceCoversArtifacts(join(wroot, "missing")));
    check("workspaceCoversArtifacts: empty directory → false", !workspaceCoversArtifacts(""));

    const bare: { parts: unknown[]; system?: string } = { parts: [{ type: "text", text: "oi" }] };
    injectArtifactsSystem(bare);
    check(
      "inject: body without system gains the block; parts untouched",
      bare.system?.includes(ARTIFACTS_MARKER) === true &&
        bare.system?.includes("ses_x") === false &&
        JSON.stringify(bare.parts) === JSON.stringify([{ type: "text", text: "oi" }]),
    );
    const client: { system?: string } = { system: "SYS" };
    injectArtifactsSystem(client);
    check(
      "inject: appends after a client-provided system prompt",
      client.system!.startsWith("SYS") && client.system!.includes(ARTIFACTS_MARKER),
    );
    injectArtifactsSystem(client);
    check("inject: second call is a no-op (marker dedupe)", client.system!.split(ARTIFACTS_MARKER).length - 1 === 1);
  } finally {
    rmSync(wroot, { recursive: true, force: true });
  }
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


// --- P2-097: client maps the daemon's 413 to the friendly too-large error -----
{
  let caught: unknown = null;
  try {
    await fetchArtifact(async () => ({ status: 413, body: { error: "artifact too large" } }), "ses", "big.pdf");
  } catch (e) {
    caught = e;
  }
  check(
    "P2-097: fetchArtifact throws the friendly ArtifactTooLarge on 413",
    caught instanceof ArtifactTooLarge &&
      (caught as Error).message.includes("5.0 MB") &&
      ARTIFACT_MAX_BYTES === 5_000_000,
  );
  check(
    "P2-097: fetchArtifact keeps null for missing artifacts",
    (await fetchArtifact(async () => ({ status: 404, body: {} }), "ses", "x.pdf")) === null,
  );
}


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

  // --- P2-137: planner learns from its own rejection — repair prompt with the
  // exact guard reason, conditional 3rd attempt, spec-format infra franchise
  {
    const sixHeadings = ["## Problem", "## Approach", "## Touched files", "## Edge cases", "## Acceptance criteria", "## Out of scope"];
    const pMissing = plannerPrompt(TASK, 2, [], "", "missing section(s): edge cases");
    const listIdx = sixHeadings.map((h) => pMissing.indexOf(`- ${h}`));
    check(
      "planner: repair prompt cites the exact reason and lists all six headings in order",
      pMissing.includes('"missing section(s): edge cases"') &&
        listIdx.every((idx) => idx > pMissing.indexOf("TASK (")) && // repair block lives in the variable tail
        listIdx.every((idx, n) => n === 0 || idx > listIdx[n - 1]!),
    );
    const pLarge = plannerPrompt(TASK, 2, [], "", "spec too large (500 lines / 60000 chars)");
    check(
      "planner: too-large repair cites the reason without the heading list",
      pLarge.includes('"spec too large (500 lines / 60000 chars)"') && !pLarge.includes("- ## Problem"),
    );
    const pA = plannerPrompt(TASK, 2, [], "", "missing section(s): problem");
    const pB = plannerPrompt(TASK, 3, [], "", "control marker at line 4: VERDICT");
    const stable = pA.indexOf("TASK (");
    check("planner: repair block keeps the P1-077 stable prefix byte-identical across reasons/attempts", stable > 0 && pA.slice(0, stable) === pB.slice(0, stable));
    check("planner: attempt 1 without a rejection reason gets no repair block", !plannerPrompt(TASK, 1).includes("PREVIOUS SPEC REJECTION"));
    check(
      "planner: format-repairable reason earns a 3rd attempt",
      plannerRetryPolicy("missing section(s): problem", 2) === true && plannerRetryPolicy("control marker at line 4: VERDICT", 2) === true,
    );
    check("planner: too-large/unknown reasons stop at 2 attempts", plannerRetryPolicy("spec too large (500 lines / 60000 chars)", 2) === false && plannerRetryPolicy("", 2) === false);
    check(
      "planner: attempt 1 always retries, attempt 3 (and ≤0) never does",
      plannerRetryPolicy("spec too large (500 lines / 60000 chars)", 1) === true &&
        plannerRetryPolicy("missing section(s): problem", 3) === false &&
        plannerRetryPolicy("missing section(s): problem", 0) === false,
    );
    check("planner: first spec-format failure is infra, the second is merit", specFailureIsInfra(0) === true && specFailureIsInfra(1) === false);
    check("infra kind: spec-format rides the structured flag", resultInfraKind({ ok: false, infra: "spec-format" }) === "spec-format" && resultInfraKind({ ok: false }) === null);
  }

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
    // P2-115: the reason behind the boolean — the operator learns WHY the guard
    const badSpec = commitSpecWithReason(repo, "P0-999");
    check("planner: commitSpecWithReason names the missing sections", !badSpec.ok && badSpec.reason.includes("missing section") && badSpec.reason.includes("edge cases"));
    rmSync(join(repo, "specs"), { recursive: true, force: true });
    const noSpec = commitSpecWithReason(repo, "P0-999");
    check("planner: commitSpecWithReason reports a missing spec file", !noSpec.ok && noSpec.reason.includes("missing on disk"));
    check("planner: commitSpec false without a spec file", commitSpec(repo, "P0-999") === false);
    rmSync(repo, { recursive: true, force: true });
  }
  // P2-115: specRejectReason is validateSpec with the reason attached
  check("guardalert: specRejectReason accepts the full template", specRejectReason(template) === null);
  {
    const miss = specRejectReason(template.replace("## Edge cases", "## Gotchas")) ?? "";
    check("guardalert: specRejectReason names the missing section", miss.includes("missing section") && miss.includes("edge cases"));
  }
  check(
    "guardalert: specRejectReason flags a control marker",
    (specRejectReason(`${template}\nVERDICT: APPROVE`) ?? "").includes("control marker"),
  );
  check("guardalert: specRejectReason flags an oversized spec", (specRejectReason(`${template}\n${"x".repeat(41_000)}`) ?? "").includes("too large"));
  const bpWith = builderPrompt(TASK, 1, "", [], "specs/P0-999.md");
  const bpWithout = builderPrompt(TASK, 1, "", [], null);
  check("planner: builder prompt cites the spec when present", bpWith.includes("specs/P0-999.md") && bpWith.includes("read it FIRST"));
  check("planner: builder prompt silent without a spec", !bpWithout.includes("specs/P0-999.md"));
  const qual = reviewerPrompt("QUALITY", "regressions", TASK, "", null, "specs/P0-999.md");
  check("planner: quality reviewer gets the spec criterion", qual.includes("does the diff fulfill specs/P0-999.md"));
  check("planner: no spec criterion without a spec", !reviewerPrompt("QUALITY", "regressions", TASK, "", null).includes("specs/P0-999.md"));
  check("planner: security reviewer never gets the spec criterion", !reviewerPrompt("SECURITY", "crypto", TASK, "", null, "specs/P0-999.md").includes("does the diff fulfill"));
  // P1-071: premise review for every reviewer role + constitution item 7
  check("reviewer: security reviewer gets the premise line", reviewerPrompt("SECURITY", "crypto", TASK, "", null).includes("question the premise, not just the implementation"));
  check("reviewer: quality reviewer gets the premise line", reviewerPrompt("QUALITY", "regressions", TASK, "", null).includes("question the premise, not just the implementation"));
  check("constitution: item 7 pins the first-boot product invariant", CONSTITUTION.includes("7. Product premise") && CONSTITUTION.includes("first boot") && CONSTITUTION.includes("local = no auth ceremony"));
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
  check("p1-073: reviewerOk — all findings dropped → fail-closed rejection (incident path)", !reviewerOk("VERDICT: REQUEST_CHANGES\n- ghost.ts:1 — nope", [], ["- ghost.ts:1 — nope"]));
  check("p2-038: reviewerOk — no marker fails closed", !reviewerOk("all good", [], []));
  // P1-103 severity contract: only [BLOCKING] rejects; nit-only reviews approve
  check("p1-103: reviewerOk — REQUEST_CHANGES with only [NIT] findings approves", reviewerOk("VERDICT: REQUEST_CHANGES\n- [NIT] real.ts:1 — wording", ["- [NIT] real.ts:1 — wording"], []));
  check("p1-103: reviewerOk — [BLOCKING] finding rejects", !reviewerOk("VERDICT: REQUEST_CHANGES\n- [BLOCKING] real.ts:1 — wrong", ["- [BLOCKING] real.ts:1 — wrong"], []));
  check("p1-103: reviewerOk — untagged finding fails closed as BLOCKING", !reviewerOk("VERDICT: REQUEST_CHANGES\n- real.ts:1 — wrong", ["- real.ts:1 — wrong"], []));
  check("p1-103: reviewerOk — verified NIT + unverifiable residue still rejects (P1-073)", !reviewerOk("VERDICT: REQUEST_CHANGES\n- [NIT] real.ts:1 — w", ["- [NIT] real.ts:1 — w"], ["- ghost.ts:1 — nope"]));
  check("p1-103: reviewerOk — nit-only REQUEST_CHANGES with no evidence at all rejects", !reviewerOk("VERDICT: REQUEST_CHANGES\n- [NIT] real.ts:1 — wording", [], []));
  check("p1-103: isBlockingFinding contract", isBlockingFinding("- [BLOCKING] x") && !isBlockingFinding("- [NIT] x") && isBlockingFinding("- untagged x") && isBlockingFinding("- [BLOCKING] + [NIT] ambiguous"));
  // P1-103 cross-round repetition signal for the escalation arbiter
  check("p1-103: findingsRepeat — same file citation repeats across rounds", findingsRepeat(["- [BLOCKING] src/x.ts:10 — boom"], ["- [NIT] src/x.ts:42 — still boom (rephrased)"]));
  check("p1-103: findingsRepeat — different citations do not repeat", !findingsRepeat(["- [BLOCKING] src/x.ts:10 — boom"], ["- [BLOCKING] src/y.ts:1 — other"]));
  check("p1-103: findingsRepeat — citation-free findings match on normalized text", findingsRepeat(["- [BLOCKING] Off-by-one in the loop"], ["- off-by-one in the LOOP!"]));
  check("p1-103: findingsRepeat — empty previous round never repeats", !findingsRepeat([], ["- [BLOCKING] src/x.ts:1 — boom"]));
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


// --- P1-102: findings only under REQUEST_CHANGES + verbatim-quote-first --------
{
  const ws = mkdtempSync(join(tmpdir(), "p1-102-"));
  writeFileSync(join(ws, "real.ts"), "alpha\nbeta\n");
  // real drop fixtures from the P1-102 audit: genuine findings (shell injection
  // via t.id, unused qrcode devDep) died in the mechanical verifier because
  // path:line resolution ran before any verbatim-diff-quote check.
  const diff = [
    "diff --git a/apps/pilot/src/pipeline.ts b/apps/pilot/src/pipeline.ts",
    "+    const id = taskId ? taskId : \"unknown-task\";",
    "+    \"qrcode\": \"^1.5.3\",",
    "",
  ].join("\n");

  check("p1-102: APPROVE rationale bullets are NOT findings", parseFindings("VERDICT: APPROVE\n- real.ts:2 looks fine, `beta` ok").length === 0);
  check("p1-102: REQUEST_CHANGES bullets still parse", parseFindings("VERDICT: REQUEST_CHANGES\n- real.ts:2 — wrong").length === 1);
  check("p1-102: marker-less output still yields candidate findings (fail-closed)", parseFindings("just prose, no marker\n- a bullet").length === 1);
  check(
    "p1-102: verbatim diff quote wins over a failed path:line (shell-injection drop fixture)",
    verifyFindings(["- `apps/pilot/src/ghost.ts:99` — shell injection via `t.id` interpolated as `taskId ? taskId`"], ws, diff).kept.length === 1,
  );
  check(
    "p1-102: verbatim diff quote wins over an empty cited line (qrcode devDep drop fixture)",
    verifyFindings(["- `real.ts:99` — dead devDep `\"qrcode\": \"^1.5.3\",` present in the diff"], ws, diff).kept.length === 1,
  );
  const v = verifyFindings(["- `ghost.ts:1` — nothing here"], ws, diff);
  check("p1-102: no quote + no resolvable citation still dropped", v.dropped.length === 1);
  check("p1-102: drop reason recorded (file not found)", (v.reasons["- `ghost.ts:1` — nothing here"] ?? "").includes("cited file not found"));
  check("p1-102: drop reason recorded (line beyond EOF)", (verifyFindings(["- `real.ts:99` — nothing"], ws, diff).reasons["- `real.ts:99` — nothing"] ?? "").includes("cited line empty"));
  check(
    "p1-102: quote absent from the diff never bypasses verification",
    verifyFindings(["- `ghost.ts:1` — `qrcodes` is unused"], ws, diff).dropped.length === 1,
  );
  check(
    "p1-102: quoted bare path repeated in diff headers never self-verifies",
    verifyFindings(["- `apps/pilot/src/pipeline.ts` leaks the relay private key to stdout"], ws, diff).dropped.length === 1,
  );
  const tagged = tagUnverified([["- `ghost.ts:1` — real leak"], [], ["- `real.ts:2` — off-by-one", "- `ghost.ts:1` — real leak"]]);
  check("p1-102: tagUnverified tags deduped dropped findings for the builder", tagged.join("\n") === "[unverified] - `ghost.ts:1` — real leak\n[unverified] - `real.ts:2` — off-by-one");
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
  check("soak lane: pilot-infra deploy soaks 3min (operator override 2026-09-03)", soakMinutesFor(10, true) === 3);
  check("soak lane: the pilot lane is flat 3min regardless of monitorMin", soakMinutesFor(5, true) === 3 && soakMinutesFor(15, true) === 3);

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


// --- P2-114 ops fail-closed: dirty prod checkout + tier-B binary probe --------
{
  check("dirty guard: empty status → null", dirtyGuardDetail("") === null);
  check("dirty guard: untracked-only status → null", dirtyGuardDetail("?? foo\n") === null);
  const dgDirty = dirtyGuardDetail(" M a.ts\nM  b.ts\n") ?? "";
  check(
    "dirty guard: tracked modifications abort with paths",
    dgDirty.includes("2 tracked file(s)") && dgDirty.includes("a.ts") && dgDirty.includes("deploy aborted before reset"),
  );
  check("dirty guard: failed probe fails closed", (dirtyGuardDetail(null) ?? "").includes("state unknown"));
  const dgMany = dirtyGuardDetail(" M a.ts\n M b.ts\n M c.ts\n M d.ts\nM  e.ts\n") ?? "";
  check(
    "dirty guard: >3 paths summarized with +k more",
    dgMany.includes("5 tracked file(s)") && dgMany.includes("a.ts, b.ts, c.ts +2 more"),
  );

  // Real-git acceptance (P1-036 lesson: never mock git): a dirty prod checkout
  // must abort BEFORE any reset — the operator edit survives and HEAD holds.
  const gdir = mkdtempSync(join(tmpdir(), "ocr-dirty-deploy-"));
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: gdir });
  writeFileSync(join(gdir, "f.txt"), "original\n");
  execSync("git add f.txt && git commit -q -m init", { cwd: gdir });
  writeFileSync(join(gdir, "f.txt"), "operator edit\n");
  const dirtySha = execSync("git rev-parse HEAD", { cwd: gdir, encoding: "utf8" }).trim();
  const dirtyEvents: Array<{ phase?: string; ok?: boolean }> = [];
  const dirtyNotifies: Array<{ task: string; ok: boolean; detail: string }> = [];
  const cfgDirty: PilotConfig = {
    repo: gdir,
    workspace: gdir,
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
  const dirtyRes = await deploy(cfgDirty, dirtySha, { task: "P2-114" }, {
    verifiedMerges: [{ sha: dirtySha, task: "P2-114", at: "t" }],
    quarantine: [],
    probeFreeBytes: async () => 100 * GB,
    notify: async (task, ok, detail) => {
      dirtyNotifies.push({ task, ok, detail });
      return true;
    },
    emitEvent: (_t, fields) => {
      dirtyEvents.push(fields);
    },
  });
  check(
    "dirty guard: dirty prod checkout aborts the deploy before reset",
    dirtyRes.ok === false && dirtyRes.rolledBack === false && dirtyRes.detail.startsWith("prod checkout dirty"),
  );
  check(
    "dirty guard: start + dirty-guard events emitted, ok:false",
    dirtyEvents.length === 2 && dirtyEvents[1]!.phase === "dirty-guard" && dirtyEvents[1]!.ok === false,
  );
  check(
    "dirty guard: supervisor notified once under the task id",
    dirtyNotifies.length === 1 && dirtyNotifies[0]!.task === "P2-114" && dirtyNotifies[0]!.ok === false,
  );
  check("dirty guard: operator edit survives (nothing reset)", readFileSync(join(gdir, "f.txt"), "utf8") === "operator edit\n");
  check("dirty guard: HEAD unchanged", execSync("git rev-parse HEAD", { cwd: gdir, encoding: "utf8" }).trim() === dirtySha);
  rmSync(gdir, { recursive: true, force: true });

  // tier-B binary probe (doctor)
  let probeCalls: string[] = [];
  const okRun: RunFn = (cmd) => {
    probeCalls.push(cmd);
    return { ok: true, output: "1.2.3 (Claude Code)\n" };
  };
  check(
    "tierb doctor: no models configured → probe skipped, run never called",
    doctorTierB(undefined, okRun).ok && probeCalls.length === 0,
  );
  const failRun: RunFn = () => ({ ok: false, output: "command not found: claude" });
  const badTierB = doctorTierB({ tierB: { planner: "opus" } }, failRun);
  check(
    "tierb doctor: broken binary → red with output tail",
    !badTierB.ok && !badTierB.changed && badTierB.detail.includes("tier-B binary unusable") && badTierB.detail.includes("command not found: claude"),
  );
  probeCalls = [];
  const goodTierB = doctorTierB({ tierB: { planner: "opus" } }, okRun);
  check(
    "tierb doctor: healthy binary → first line of claude --version",
    goodTierB.ok && goodTierB.detail.includes("1.2.3") && probeCalls.length === 1 && probeCalls[0] === "claude --version",
  );

  // runDoctor wiring: red tierb probe → warn log + tierB-binary event + notify
  const tierBLogs: Array<{ level: string; msg: string; data?: unknown }> = [];
  const tierBNotifies: Array<{ task: string; ok: boolean }> = [];
  const tierBEvents: Array<{ task?: string; phase?: string; ok?: boolean }> = [];
  runDoctor(
    { repo: tmpdir(), models: { tierB: { planner: "x" } } },
    [],
    (level, msg, data) => tierBLogs.push({ level, msg, data }),
    {
      runTierB: () => ({ ok: false, output: "spawn claude ENOENT" }),
      notify: async (task, ok) => {
        tierBNotifies.push({ task, ok });
        return true;
      },
      emitEvent: (_t, fields) => {
        tierBEvents.push({ ...fields });
      },
    },
  );
  check(
    "tierb doctor: runDoctor notifies the supervisor once with doctor/ok:false",
    tierBNotifies.length === 1 && tierBNotifies[0]!.task === "doctor" && tierBNotifies[0]!.ok === false,
  );
  check(
    "tierb doctor: runDoctor emits a red tierB-binary phase",
    tierBEvents.length === 1 && tierBEvents[0]!.phase === "tierB-binary" && tierBEvents[0]!.ok === false,
  );
  check(
    "tierb doctor: doctor pass complete goes red",
    (tierBLogs.find((l) => l.msg === "doctor pass complete")?.data as { ok?: boolean } | undefined)?.ok === false,
  );

  // consecutive spawn-failure alert
  check("tierb spawn: alert cadence pinned at 3", TIERB_SPAWN_ALERT_EVERY === 3);
  check(
    "tierb spawn: 0/1/2 consecutive failures stay quiet",
    !shouldAlertTierBSpawn(0) && !shouldAlertTierBSpawn(1) && !shouldAlertTierBSpawn(2),
  );
  check("tierb spawn: fires on 3 and 6, not 4", shouldAlertTierBSpawn(3) && shouldAlertTierBSpawn(6) && !shouldAlertTierBSpawn(4));
  resetTierBSpawnStreak();
  noteTierBOutcome({ infra: "spawn" });
  noteTierBOutcome({ infra: "spawn" });
  check("tierb spawn: consecutive spawn failures accumulate to 3", noteTierBOutcome({ infra: "spawn" }) === 3);
  check("tierb spawn: any non-spawn outcome resets the streak", noteTierBOutcome({}) === 0);
  check("tierb spawn: fresh failure starts at 1", noteTierBOutcome({ infra: "spawn" }) === 1);
  resetTierBSpawnStreak();
}


// --- P2-115 repeated-guard-rejection alerts --------------------------------------
{
  check("guardalert: threshold pinned at 2", GUARD_ALERT_THRESHOLD === 2);
  resetGuardAlerts();
  const n1 = noteGuardRejection("T1", "validateSpec", "missing section(s): edge cases");
  check("guardalert: first rejection stays quiet", n1.count === 1 && n1.alert === false);
  const n2 = noteGuardRejection("T1", "validateSpec", "missing section(s): edge cases");
  check("guardalert: second consecutive rejection alerts", n2.count === 2 && n2.alert === true);
  const n3 = noteGuardRejection("T1", "verifyFindings", "b");
  check("guardalert: guards count independently", n3.count === 1 && n3.alert === false);
  clearGuardRejections("T1", "validateSpec");
  const n4 = noteGuardRejection("T1", "validateSpec", "missing section(s): edge cases");
  check("guardalert: a pass of the guard resets its streak", n4.count === 1 && n4.alert === false);
  resetGuardAlerts();
  check("guardalert: detail fits the event feed cap", guardAlertDetail("verifyFindings", 3, "x".repeat(500)).length <= 220);
  check("guardalert: detail is single-line", !guardAlertDetail("validateSpec", 2, "line1\nline2").includes("\n"));

  // raiseGuardAlert: hooks injectable, quiet below the threshold, fires on it
  const emitted: Array<{ type: string; fields: Record<string, unknown> }> = [];
  const notified: Array<[string, boolean, string]> = [];
  const emitEvent = (type: PilotEvent["type"], fields: Omit<PilotEvent, "ts" | "type">) => {
    emitted.push({ type, fields: fields as Record<string, unknown> });
  };
  const notify = (task: string, ok: boolean, detail: string) => {
    notified.push([task, ok, detail]);
    return Promise.resolve(true);
  };
  raiseGuardAlert("T2", "validateSpec", "missing section(s): edge cases", { emitEvent, notify });
  check("guardalert: below the threshold nothing is emitted or notified", emitted.length === 0 && notified.length === 0);
  raiseGuardAlert("T2", "validateSpec", "missing section(s): edge cases", { emitEvent, notify });
  const ev = emitted[0];
  check(
    "guardalert: threshold raise emits one alert event with the reason",
    emitted.length === 1 &&
      ev?.type === "alert" &&
      ev.fields.task === "T2" &&
      ev.fields.phase === "validateSpec" &&
      ev.fields.ok === false &&
      String(ev.fields.detail).includes("rejected 2x in a row") &&
      String(ev.fields.detail).includes("missing section"),
  );
  check(
    "guardalert: threshold raise notifies once with the same detail",
    notified.length === 1 && notified[0]?.[0] === "T2" && notified[0]?.[1] === false && notified[0]?.[2] === ev?.fields.detail,
  );
  resetGuardAlerts();

  // alert events must not pollute the gate-fail breakdown
  check(
    "guardalert: countFailSteps ignores alert events",
    countFailSteps([{ ts: "t", type: "alert", task: "T", phase: "validateSpec", ok: false, detail: "d" }]).length === 0,
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


// --- P3-101: stale-process detection (boot-HEAD drift) -----------------------
{
  const A = "a".padEnd(40, "1");
  const B = "b".padEnd(40, "2");
  check("P3-101: HEAD moved past boot sha → drifted", headDrifted(A, B) === true);
  check("P3-101: same sha → not drifted", headDrifted(A, A) === false);
  check("P3-101: undefined boot sha (git failed) → not drifted", headDrifted(undefined, B) === false);
  check("P3-101: undefined current sha → not drifted", headDrifted(A, undefined) === false);
  check(
    "P3-101: malformed shas → not drifted (no restart flapping)",
    headDrifted("", B) === false && headDrifted("nope", B) === false && headDrifted(A, "dirty") === false,
  );
  // round 2: the exit decision is a pure seam — both idle gates pinned here so
  // a refactor can never silently enable mid-pipeline self-kills
  check("P3-101: idle + no deploy + drift → reload", shouldSelfHealReload(0, false, A, B) === true);
  check("P3-101: slot running → never reload (no mid-pipeline self-kill)", shouldSelfHealReload(1, false, A, B) === false && shouldSelfHealReload(2, false, A, B) === false);
  check("P3-101: deploy in flight → never reload", shouldSelfHealReload(0, true, A, B) === false);
  check("P3-101: no drift → no reload even when idle", shouldSelfHealReload(0, false, A, A) === false);

  // P1-056 (round 2): bounded patience — persistent drift forces a reload even
  // with busy slots, else a fed queue can deadlock on a stale in-memory battery
  check("P1-056: drift under threshold → keep working", shouldForceReload(DRIFT_FORCE_RELOAD_MS - 1, false) === false);
  check("P1-056: drift at threshold → force reload (slots busy is fine)", shouldForceReload(DRIFT_FORCE_RELOAD_MS, false) === true);
  check("P1-056: no drift timestamp → never force", shouldForceReload(undefined, false) === false);
  check("P1-056: deploy in flight → never force (deploy has its own reload)", shouldForceReload(DRIFT_FORCE_RELOAD_MS + 60_000, true) === false);
  // P1-034 precedent: source pin — the loop's process.exit(0) must be routed
  // through the pure seam, never a bare headDrifted() check
  const pilotIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "index.ts"), "utf8");
  check(
    "P1-056: loop self-heal exits routed through the pure seams (headDrifted + shouldForceReload) — never a bare sha comparison",
    pilotIndexSrc.includes("headDrifted(bootHead, headNow)") &&
      pilotIndexSrc.includes("shouldForceReload(Date.now() - driftSince, deployBusy)") &&
      !pilotIndexSrc.includes("headNow !== bootHead"),
  );
}


// --- P1-056: sync-version stamps the tag into the three truth points ---------
{
  const ROOT = JSON.stringify({ name: "opencode-remote", version: "0.2.0", scripts: { a: 1 } });
  const DESK = JSON.stringify({ name: "desktop", version: "0.3.0", main: "x" });
  const out = stampVersion("v0.3.0", { rootPkg: ROOT, desktopPkg: DESK, webVersion: "0.2.0" });
  check("sync: root stamped to 0.3.0 with all keys preserved", JSON.parse(out.files["package.json"]).version === "0.3.0" && JSON.parse(out.files["package.json"]).scripts.a === 1);
  check("sync: desktop untouched when already at target", out.files["apps/desktop/package.json"] === undefined);
  check("sync: version.ts generated", out.files["apps/web/src/version.ts"].includes('APP_VERSION = "0.3.0"'));
  const same = stampVersion("0.3.0", {
    rootPkg: JSON.stringify({ name: "opencode-remote", version: "0.3.0" }),
    desktopPkg: DESK,
    webVersion: "0.3.0",
  });
  check("sync: idempotent — nothing to write", Object.keys(same.files).length === 0);
  let threw = false;
  try { stampVersion("nope", { rootPkg: ROOT, desktopPkg: DESK, webVersion: "0.2.0" }); } catch { threw = true; }
  check("sync: non-semver rejected", threw && !SEMVER.test("nope"));
  const round = pkgWithVersion(ROOT, "9.9.9");
  check("sync: pkg round-trips every other key", JSON.parse(round).name === "opencode-remote" && JSON.parse(round).version === "9.9.9");
  // fable #10: the REAL files round-trip byte-identically (indent + newline)
  const realRoot = readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8");
  const realDesk = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "package.json"), "utf8");
  check("sync: real root package.json round-trips byte-identical", pkgWithVersion(realRoot, JSON.parse(realRoot).version) === realRoot);
  check("sync: real desktop package.json round-trips byte-identical", pkgWithVersion(realDesk, JSON.parse(realDesk).version) === realDesk);
}

// --- P1-104: deploy self-reload waits for the slots to drain ------------------
{
  // the drain loop: holds new picks, polls until 0 running, feeds the heartbeat
  let running = 2;
  const holds: boolean[] = [];
  const sleeps: number[] = [];
  let beats = 0;
  const waited = await drainForReload({
    slotsRunning: () => running,
    holdNewPicks: (h) => holds.push(h),
    sleep: async (ms) => {
      sleeps.push(ms);
      running--; // each poll drains one slot
    },
    heartbeat: () => {
      beats++;
    },
  });
  check("P1-104: drain polls at RELOAD_DRAIN_POLL_MS until slots reach 0", sleeps.length === 2 && sleeps.every((ms) => ms === RELOAD_DRAIN_POLL_MS));
  check("P1-104: drain holds new picks while waiting, releases when drained", holds[0] === true && holds[holds.length - 1] === false);
  check("P1-104: drain feeds the heartbeat on every poll", beats === 2);
  check("P1-104: drain returns the waited ms (0 when already drained)", waited === 2 * RELOAD_DRAIN_POLL_MS);

  let idleBeats = 0;
  const idleSleeps: number[] = [];
  await drainForReload({
    slotsRunning: () => 0,
    sleep: async (ms) => idleSleeps.push(ms),
    heartbeat: () => {
      idleBeats++;
    },
  });
  check("P1-104: already-drained slots reload immediately (no poll, no beat)", idleSleeps.length === 0 && idleBeats === 0);

  // wiring pins: the deploy reload site routes through the drain and the
  // scheduler honors the hold — a refactor cannot re-enable mid-pipeline exits
  const deploySrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "deploy.ts"), "utf8");
  const pilotIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "index.ts"), "utf8");
  check(
    "P1-104: deploy reload drains before process.exit when slots are running",
    deploySrc.includes("await drainForReload({ slotsRunning, holdNewPicks: opts?.holdNewPicks, sleep: opts?.sleep })") &&
      deploySrc.includes("opts?.slotsRunning ?? (() => 0)"),
  );
  check(
    "P1-104: launchDeploy wires slotsRunning + holdNewPicks into deploy",
    pilotIndexSrc.includes("slotsRunning: () => running.size") && pilotIndexSrc.includes("drainNewPicks = hold"),
  );
  check(
    "P1-104: fillFreeSlots honors the drain hold (no new picks while draining)",
    pilotIndexSrc.includes("if (drainNewPicks) return; // P1-104: self-reload draining — no new picks"),
  );
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

// P1-075: each lesson carries a DISTINCT pair of tokens (topicN/fixN) — with
// semantic dedupe on, same-token synthetic lessons would collapse to one.
const lessonOf = (n: number) => `- When topic${n} spikes, do fix${n} inside the relay frames (fonte: P0-001)`;


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
  check("experience: dedupe keeps the newest occurrence only", kept.filter((l) => l.includes("topic0")).length === 1);
  check("experience: keeps the most recent lessons", kept[0]!.includes("topic6") && kept[kept.length - 1]!.includes("topic0"));
  const underCap = "# Experience memory (IER)\n\n## Lessons\n" + lessonOf(1) + "\n" + lessonOf(2) + "\n";
  check("experience: at/under cap is a no-op", dedupeAndPrune(underCap).md === underCap && dedupeAndPrune(underCap).removed === 0);
}


// --- P1-075 semantic dedupe + scored prune/archive ----------------------------
check("experience: JACCARD_DUPE pinned at 0.6", JACCARD_DUPE === 0.6);

check("experience: jaccard of identical sets is 1, disjoint is 0", jaccard(new Set(["relay", "frames", "seq"]), new Set(["relay", "frames", "seq"])) === 1 && jaccard(new Set(["relay"]), new Set(["frames"])) === 0);

check("experience: isHarnessLesson matches process vocabulary", isHarnessLesson("when the pilot slot refresh breaks the gate") && !isHarnessLesson("when the relay frames duplicate, check the seq watermark"));


{
  // paraphrased re-landing of the same lesson (same token set, different fonte)
  const original = "- When topic0 spikes inside the relay frames, do fix0 now (fonte: P0-001)";
  const paraphrased = "- do fix0 now: topic0 spikes inside the relay frames (fonte: P9-009)";
  const different = "- When the daemon freezes, do drop the stale pidfile (fonte: P9-008)";
  const base = `# Experience memory (IER)\n\n## Lessons\n${original}\n`;
  const appended = appendLessons(base, [paraphrased, different], "P9-009");
  check("experience: paraphrase with jaccard >= 0.6 is dropped on append", appended.added.length === 1 && appended.added[0]!.includes("daemon freezes"));
  // above cap so the dedupe pass actually runs (under cap it is a no-op)
  const fillers = Array.from({ length: 60 }, (_, i) => lessonOf(i + 100));
  const both = dedupeAndPrune(`# Experience memory (IER)\n\n## Lessons\n${fillers.join("\n")}\n${original}\n${paraphrased}\n`);
  const keptLessons = parseLessons(both.md);
  check("experience: dedupeAndPrune drops the older paraphrase", keptLessons.includes(paraphrased) && !keptLessons.includes(original));
  // short lessons (< 5 tokens each): only exact-key dedupe applies
  const shortA = "- alpha beta gamma delta (fonte: P0-001)";
  const shortB = "- alpha then beta then gamma then delta (fonte: P9-009)";
  const shorts = appendLessons(`# Experience memory (IER)\n\n## Lessons\n${shortA}\n`, [shortB], "P9-009");
  check("experience: short lessons skip the semantic dedupe", shorts.added.length === 1);
}


{
  const backlogMd = [
    "# Backlog",
    "",
    "## Ready",
    "- [ ] (P9-900) [P1] pending thing — spec: x",
    "",
    "## Blocked",
    "- [ ] (P9-901) [P1] blocked thing — spec: y",
    "",
    "## Done",
    "- [x] (P1-001) first done task — merged",
    "- [x] (P1-002) second done task — merged",
  ].join("\n");
  check("backlog: doneTaskIds parses only the Done section", doneTaskIds(backlogMd).size === 2 && doneTaskIds(backlogMd).has("P1-001") && doneTaskIds(backlogMd).has("P1-002"));

  const harnessDone = "- When the pilot gatekeeper slot refresh breaks, do re-check the backlog checkpoint (fonte: P1-001)";
  const productOld = "- When the relay frames duplicate, do check the seq watermark first (fonte: P9-001)";
  // 59 distinct product fillers + 1 harness-done + product-old (oldest overall) = 61 → cap+1
  const fillers = Array.from({ length: 59 }, (_, i) => lessonOf(i + 10));
  const md = `# Experience memory (IER)\n\n## Lessons\n${productOld}\n${fillers.join("\n")}\n${harnessDone}\n`;
  const pruned = dedupeAndPrune(md, EXPERIENCE_CAP, doneTaskIds(backlogMd));
  check(
    "experience: prune archives the harness-done lesson only",
    pruned.archived.length === 1 && pruned.archived[0] === harnessDone && pruned.removed === 1,
  );
  const kept = parseLessons(pruned.md);
  check("experience: product lesson is never archived, even when oldest", kept.includes(productOld) && kept.length === EXPERIENCE_CAP);

  const twoHarness = `# Experience memory (IER)\n\n## Lessons\n${productOld}\n${fillers.join("\n")}\n${harnessDone}\n- When the planner slot refresh loses the builder checkpoint, do consult the backlog (fonte: P1-002)\n`;
  const pruned2 = dedupeAndPrune(twoHarness, EXPERIENCE_CAP, doneTaskIds(backlogMd));
  check("experience: archived equals the removed harness lines", pruned2.archived.length === 2 && pruned2.removed === 2 && parseLessons(pruned2.md).includes(productOld));
  // unknown/undone fonte: never archived — but still dropped harness-first by
  // the generic prune (product lessons last)
  const undone = `# Experience memory (IER)\n\n## Lessons\n${productOld}\n${fillers.join("\n")}\n- When the pilot gatekeeper slot refresh breaks, do re-check the backlog checkpoint (fonte: P9-999)\n`;
  const pruned3 = dedupeAndPrune(undone, EXPERIENCE_CAP, doneTaskIds(backlogMd));
  check(
    "experience: harness lesson from an undone fonte is not archived",
    pruned3.archived.length === 0 && pruned3.removed === 1 && parseLessons(pruned3.md).includes(productOld),
  );
}


// --- P1-075 nightly maintenance flow (own guard, archive sink, guarded push) ---
{
  const harnessDone = "- When the pilot gatekeeper slot refresh breaks, do re-check the backlog checkpoint (fonte: P1-001)";
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "ocr-expmaint-"));
    mkdirSync(join(dir, "docs"), { recursive: true });
    // 62 lessons: watermark (oldest) + 60 fillers + 1 harness-done → cap+2
    const lines = [
      "- When the relay frames duplicate, do check the seq watermark first (fonte: P9-001)",
      ...Array.from({ length: 60 }, (_, i) => lessonOf(i + 10)),
      harnessDone,
    ];
    writeFileSync(join(dir, "docs", "EXPERIENCE.md"), `# Experience memory (IER)\n\n## Lessons\n${lines.join("\n")}\n`);
    writeFileSync(join(dir, "BACKLOG.md"), "# Backlog\n\n## Done\n- [x] (P1-001) done task — merged\n");
    return dir;
  };
  const dir = setup();
  const cmds: string[] = [];
  const logs: string[] = [];
  const landed: FailureLesson[] = [];
  const st: { expMaintLast?: string } = {};
  const pristineExp = readFileSync(join(dir, "docs", "EXPERIENCE.md"), "utf8");
  const res = await maintainExperienceWorkspace(
    dir,
    st,
    "2026-09-03",
    {
      exec: (cmd) => {
        cmds.push(cmd);
        // P1-076: the landing re-bases pilot/meta — simulate the rewind of the
        // worktree file so the apply callback re-dedupes the fresh copy
        if (cmd.includes(`git checkout -q -B ${META_BRANCH}`)) writeFileSync(join(dir, "docs", "EXPERIENCE.md"), pristineExp);
        return { ok: true, output: cmd.includes("--name-only") ? "docs/EXPERIENCE.md" : "" };
      },
      appendLesson: (_file, lesson) => {
        landed.push(lesson);
        return true;
      },
      lessonsFile: join(dir, "lessons.jsonl"),
    },
    (level, msg) => logs.push(`${level}:${msg}`),
  );
  check("expmaint: prune runs, archives the harness lesson, stamps its own guard", res.changed && res.archived === 1 && st.expMaintLast === "2026-09-03");
  check("expmaint: archived entry is a failure lesson with step archived + fonte task", landed.length === 1 && landed[0]!.step === "archived" && landed[0]!.task === "P1-001" && landed[0]!.attempts === 0);
  check("expmaint: commit + guarded push executed", cmds.some((c) => c.includes("experience maintenance")) && cmds.some((c) => c.includes("origin HEAD:pilot/meta") && c.startsWith("git push")));
  check("expmaint: logs the maintenance line", logs.some((l) => l.includes("experience maintained")));
  const again = await maintainExperienceWorkspace(dir, st, "2026-09-03", { exec: () => ({ ok: true, output: "" }), appendLesson: () => true, lessonsFile: "x" });
  check("expmaint: same-day re-run is a guarded no-op", !again.changed && again.archived === 0);
  rmSync(dir, { recursive: true, force: true });

  // push-guard refusal: logged + never thrown, archive still lands, guard stamps
  const dir2 = setup();
  const logs2: string[] = [];
  const landed2: FailureLesson[] = [];
  const st2: { expMaintLast?: string } = {};
  const pristineExp2 = readFileSync(join(dir2, "docs", "EXPERIENCE.md"), "utf8");
  const res2 = await maintainExperienceWorkspace(
    dir2,
    st2,
    "2026-09-03",
    {
      exec: (cmd) => {
        if (cmd.includes(`git checkout -q -B ${META_BRANCH}`)) writeFileSync(join(dir2, "docs", "EXPERIENCE.md"), pristineExp2);
        return { ok: true, output: cmd.includes("--name-only") ? "BACKLOG.md" : "" };
      },
      appendLesson: (_file, lesson) => {
        landed2.push(lesson);
        return true;
      },
      lessonsFile: join(dir2, "out", "lessons.jsonl"),
    },
    (level, msg) => logs2.push(`${level}:${msg}`),
  );
  check(
    "expmaint: refused push never throws — archive lands, guard stamps, committed stays honest",
    logs2.some((l) => l.includes("aux push refused")) && landed2.length === 1 && st2.expMaintLast === "2026-09-03" && res2.committed === false,
  );
  rmSync(dir2, { recursive: true, force: true });

  // real fs roundtrip: archived lessons land in the shared jsonl (P1-037)
  const dir3 = setup();
  const st3: { expMaintLast?: string } = {};
  await maintainExperienceWorkspace(
    dir3,
    st3,
    "2026-09-03",
    {
      exec: () => ({ ok: false, output: "" }),
      appendLesson: appendFailureLesson,
      lessonsFile: join(dir3, "out", "lessons.jsonl"),
    },
  );
  const stored = readRecentFailureLessons(join(dir3, "out", "lessons.jsonl"));
  check("expmaint: real appendFailureLesson roundtrip (fs-first, outside worktrees)", stored.length === 1 && stored[0]!.step === "archived" && stored[0]!.findings.includes("gatekeeper"));
  rmSync(dir3, { recursive: true, force: true });

  // R3 review: on a successful landing the archived lessons must come from the
  // pass that actually landed (fresh origin/main recompute), not the stale
  // workspace copy — pre.archived only covers the failed-landing case (P1-037)
  const dir4 = mkdtempSync(join(tmpdir(), "pilot-expmaint-r3-"));
  try {
    mkdirSync(join(dir4, "docs"), { recursive: true });
    const staleHarness = "- When the pilot gatekeeper backlog STALE-ARCHIVE marker breaks, do re-check the slot checkpoint (fonte: P1-001)";
    const freshHarness = "- When the pilot gatekeeper backlog FRESH-ARCHIVE marker breaks, do re-check the slot checkpoint (fonte: P1-001)";
    const mdFor = (harness: string) =>
      `# Experience memory (IER)\n\n## Lessons\n- When the relay frames duplicate, do check the seq watermark first (fonte: P9-001)\n${Array.from({ length: 59 }, (_, i) => lessonOf(i + 10)).join("\n")}\n${harness}\n`;
    // workspace holds the stale copy; the fake checkout restores the fresh one
    writeFileSync(join(dir4, "docs", "EXPERIENCE.md"), mdFor(staleHarness));
    writeFileSync(join(dir4, "BACKLOG.md"), "# Backlog\n\n## Done\n- [x] (P1-001) done task — merged\n");
    const freshContent = readFileSync(join(dir4, "docs", "EXPERIENCE.md"), "utf8").replace("STALE-ARCHIVE", "FRESH-ARCHIVE");
    const landed4: FailureLesson[] = [];
    const st4: { expMaintLast?: string } = {};
    let prMerged4 = false;
    let prCreated4 = false;
    const res4 = await maintainExperienceWorkspace(dir4, st4, "2026-09-03", {
      exec: (cmd) => {
        if (cmd.includes(`git checkout -q -B ${META_BRANCH}`)) writeFileSync(join(dir4, "docs", "EXPERIENCE.md"), freshContent);
        // R4: the landing verifies our sha (40-hex) and confirms the merge
        if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${"f".repeat(40)}\n` };
        if (cmd.startsWith("gh ") && cmd.includes("pr view"))
          return prCreated4
            ? { ok: true, output: JSON.stringify({ state: prMerged4 ? "MERGED" : "OPEN", headRefOid: "f".repeat(40) }) }
            : { ok: false, output: "no pull requests" };
        if (cmd.startsWith("gh ") && cmd.includes("pr create")) {
          prCreated4 = true;
          return { ok: true, output: "" };
        }
        if (cmd.startsWith("gh ") && cmd.includes("pr merge")) {
          prMerged4 = true;
          return { ok: true, output: "" };
        }
        return { ok: true, output: cmd.includes("--name-only") ? "docs/EXPERIENCE.md" : "" };
      },
      appendLesson: (_file, lesson) => {
        landed4.push(lesson);
        return true;
      },
      lessonsFile: join(dir4, "out", "lessons.jsonl"),
    });
    check(
      "expmaint: archived lessons come from the landed fresh-copy pass, not the stale workspace",
      res4.archived === 1 && landed4.length === 1 && landed4[0]!.findings.includes("FRESH-ARCHIVE"),
    );
    check("expmaint: the stale workspace archive decision is discarded on success", !landed4.some((l) => l.findings.includes("STALE-ARCHIVE")));
  } finally {
    rmSync(dir4, { recursive: true, force: true });
  }
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


// --- P1-075 archived experience lessons ride the failure block, capped --------
{
  const realOf = (n: number): FailureLesson => ({ kind: "failure", ts: `2026-09-01T10:${String(n).padStart(2, "0")}:00-03:00`, task: `P2-${String(n).padStart(3, "0")}`, attempts: 4, step: "typecheck", findings: `finding ${n}`, tail: "" });
  const archivedOf = (n: number): FailureLesson => ({ kind: "failure", ts: `2026-09-02T10:${String(n).padStart(2, "0")}:00-03:00`, task: `P1-${String(n).padStart(3, "0")}`, attempts: 0, step: "archived", findings: `archived lesson ${n}`, tail: "" });
  // 8 real failures then 5 archived — the last-10 window holds 5 real + 5 archived
  const mixed = [...Array.from({ length: 8 }, (_, i) => realOf(i)), ...Array.from({ length: 5 }, (_, i) => archivedOf(i))];
  const block = failureLessonsBlock(mixed);
  const archivedLines = (block.match(/step: archived/g) ?? []).length;
  const realLines = (block.match(/step: typecheck/g) ?? []).length;
  check("failure lessons: archived entries cap at 3 of the slots", archivedLines === 3);
  check("failure lessons: real failures keep >= 7 slots via backfill", realLines === 7 && block.includes("finding 1") && block.includes("finding 7"));
  check("failure lessons: all-real window is untouched", (failureLessonsBlock(mixed.slice(0, 8)).match(/step: typecheck/g) ?? []).length === 8);
}


// --- P1-075 lesson-injection impact instrumentation ---------------------------
{
  const st: { lessonImpact?: import("../apps/pilot/src/state").LessonImpact } = {};
  recordLessonImpact(st, { lessons: 5, rounds: 2, ok: true, tokens: 100 });
  recordLessonImpact(st, { lessons: 3, rounds: 1, ok: false, tokens: 40 });
  recordLessonImpact(st, { lessons: 0, rounds: 3, ok: true, tokens: 7 });
  recordLessonImpact(st, { lessons: 0, rounds: 1, ok: false, tokens: 0 });
  check(
    "lesson impact: folds merges/rounds/tokens into the right cohort",
    st.lessonImpact!.with.merges === 1 && st.lessonImpact!.with.roundsTotal === 3 && st.lessonImpact!.with.tokensTotal === 140 &&
      st.lessonImpact!.without.merges === 1 && st.lessonImpact!.without.roundsTotal === 4 && st.lessonImpact!.without.tokensTotal === 7,
  );
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


// --- P1-070: local pairing derivation + new pairing copy ----------------------
{
  const link = { port: 8792, token: "a/b c", room: "room-1", ecdhPub: "KEY" };
  const p = localPairing(link);
  check(
    "p1-070 localPairing: full link → loopback relay + room + daemon key",
    !!p &&
      p.v === 2 &&
      p.relay === "ws://127.0.0.1:8792/ws?token=a%2Fb%20c" &&
      p.room === "room-1" &&
      p.k === "KEY" &&
      p.name === "local",
  );
  check("p1-070 localPairing: null link → null", localPairing(null) === null);
  check("p1-070 localPairing: missing token → null", localPairing({ ...link, token: "" }) === null);
  check("p1-070 localPairing: missing room → null", localPairing({ ...link, room: "" }) === null);
  check("p1-070 localPairing: missing ecdhPub → null", localPairing({ ...link, ecdhPub: "" }) === null);
  check("p1-070 localPairing: non-finite port → null", localPairing({ ...link, port: Number.NaN }) === null);
  check(
    "p1-070 local-mode state (uri/qr null) can never render the QR overlay",
    overlayVisible({ uri: null, qrDataUrl: null, devices: 1, phonePaired: false, mode: "local" }) === false,
  );
  for (const lang of ["en", "pt"] as const) {
    const d = dict[lang] as Record<string, string>;
    check(`p1-070 i18n ${lang}: pairRemoteTitle + pairRemoteAction present`, !!d.pairRemoteTitle && !!d.pairRemoteAction);
    check(`p1-070 i18n ${lang}: localConnecting names the local daemon`, /local/i.test(d.localConnecting));
    check(
      `p1-070 i18n ${lang}: pairIntro explains the zero-ceremony local auto-connect`,
      /automatically|sozinho/.test(d.pairIntro),
    );
  }
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


// --- desktop closehint: one-time close-to-tray hint plan (P2-152) ----------------
{
  // Flag absent ⇒ notify; darwin speaks of the menu bar, win32/linux of the
  // system tray.
  const darwin = closeHintPlan("darwin", null);
  check("hint: darwin with no flag notifies with the menu-bar body", darwin.kind === "notify" && darwin.title === CLOSE_HINT_TITLE && darwin.body === CLOSE_HINT_BODY_MENUBAR);
  check("hint: win32 with no flag notifies with the tray body", closeHintPlan("win32", null).body === CLOSE_HINT_BODY_TRAY);
  check("hint: linux with no flag notifies with the tray body", closeHintPlan("linux", null).body === CLOSE_HINT_BODY_TRAY);
  // Sentinel ⇒ total silence on every platform (like the badge zero).
  for (const p of ["darwin", "win32", "linux"]) {
    const silent = closeHintPlan(p, CLOSE_HINT_SENTINEL);
    check(`hint: sentinel flag silences on ${p}`, silent.kind === "none" && silent.title === "" && silent.body === "");
  }
  // Anything that is not the exact sentinel counts as not shown (fail-open,
  // P2-148 lesson): absent, empty, padded, wrong value, corrupted JSON.
  const corrupt = ["", "0", " 1 ", "1\n", '{"shown":true}', CLOSE_HINT_SENTINEL + CLOSE_HINT_SENTINEL];
  check(
    "hint: empty/corrupt flags all count as not shown",
    corrupt.every((f) => closeHintPlan("darwin", f).kind === "notify"),
  );
  check("hint: undefined flag counts as not shown", closeHintPlan("darwin", undefined).kind === "notify");
  // Unknown platform falls back to the generic tray wording.
  check("hint: unknown platform uses the generic tray body", closeHintPlan("sunos", null).kind === "notify" && closeHintPlan("sunos", null).body === CLOSE_HINT_BODY_TRAY);
  // Read sink throwing (missing file, bad disk) ⇒ null, decision stays notify.
  const thrown = readHintFlag(() => {
    throw new Error("boom");
  });
  check("hint: read sink throwing reads as absent", thrown === null && closeHintPlan("darwin", thrown).kind === "notify");
  // Write sink throwing ⇒ false, no exception escapes.
  check("hint: write sink throwing reports failure", writeHintFlag(() => { throw new Error("boom"); }) === false);
  let stamped = "";
  check("hint: write sink success stamps the sentinel", writeHintFlag((v) => { stamped = v; }) === true && stamped === CLOSE_HINT_SENTINEL);
  // Flag path lives at the userData root (same shape as window-state.json).
  check("hint: flag path is userData/close-hint.flag", hintFlagPath("/tmp/x") === join("/tmp/x", "close-hint.flag"));
  // Copy discipline: no emoji/glyph-as-icon (P2-107 regex) and no path
  // separators in anything user-visible.
  const BANNED = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2500}-\u{25FF}\u{FE0F}]/u;
  const copy = [CLOSE_HINT_TITLE, CLOSE_HINT_BODY_MENUBAR, CLOSE_HINT_BODY_TRAY, CLOSE_HINT_LOG];
  check("hint: copy has no emoji/glyph-as-icon", copy.every((s) => !BANNED.test(s)));
  check("hint: copy is path-free", copy.every((s) => !s.includes("/") && !s.includes("\\")));
  check("hint: log marker is unique and names the feature", CLOSE_HINT_LOG.includes("close-to-tray") && CLOSE_HINT_LOG.startsWith("[desktop]"));
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


// --- P2-176: pure app-menu specification (apps/desktop/src/menu.ts) ---------
{
  const mac = menuSpec("darwin", "Update available — check for updates", true);
  const win = menuSpec("win32", null, false);
  const linux = menuSpec("linux", null, false);

  const titled = (items: MenuItemSpec[], label: string) => items.find((i) => i.label === label);
  const goItems = (items: MenuItemSpec[]) => titled(items, "Ir")?.submenu ?? [];
  const helpItems = (items: MenuItemSpec[]) => titled(items, "Ajuda")?.submenu ?? [];
  const byId = (items: MenuItemSpec[], id: string) => items.find((i) => i.id === id);

  // 1. every go-* id survives byte-a-byte, with the exact accelerator and the
  //    exact renderer action sendMenuAction has always received (P1-046).
  const expected: [string, string, string][] = [
    ["go-new-chat", "CmdOrCtrl+T", "newChat"],
    ["go-palette", "CmdOrCtrl+K", "palette"],
    ["go-pane-chat", "CmdOrCtrl+1", "pane:chat"],
    ["go-pane-artifacts", "CmdOrCtrl+2", "pane:artifacts"],
    ["go-pane-browser", "CmdOrCtrl+3", "pane:browser"],
    ["go-pane-files", "CmdOrCtrl+4", "pane:files"],
    ["go-pane-settings", "CmdOrCtrl+5", "pane:settings"],
    ["go-pane-mission", "CmdOrCtrl+6", "pane:mission"],
  ];
  for (const platform of ["darwin", "win32", "linux"]) {
    const go = goItems(menuSpec(platform, null, false));
    check(
      `P2-176: all go ids/accelerators/actions preserved on ${platform}`,
      expected.every(([id, acc, action]) => {
        const item = byId(go, id);
        return item !== undefined && item.accelerator === acc && item.action === action;
      }),
    );
  }

  // 2. every owned label is the exact pt-BR string (product terms the UI's
  //    own pt-BR copy keeps — Artifacts/Browser/Mission Control — included).
  const labelChecks: [string, string][] = [
    ["go-new-chat", "Nova conversa"],
    ["go-palette", "Paleta de comandos"],
    ["go-pane-chat", "Conversas"],
    ["go-pane-artifacts", "Artifacts"],
    ["go-pane-browser", "Browser"],
    ["go-pane-files", "Arquivos"],
    ["go-pane-settings", "Configurações"],
    ["go-pane-mission", "Mission Control"],
  ];
  const go = goItems(mac);
  check("P2-176: Go menu is titled Ir", titled(mac, "Ir") !== undefined);
  check("P2-176: View menu is titled Visualizar", titled(mac, "Visualizar") !== undefined);
  for (const [id, label] of labelChecks) {
    check(`P2-176: ${id} is labeled "${label}"`, byId(go, id)?.label === label);
  }

  // 3. the macOS app submenu: darwin-only, quit is the P2-221 id-wired item
  //    (same explicitQuit path as the tray) with the pt-BR label, and no
  //    other platform carries an app submenu.
  const appMenu = mac[0];
  const quitItem = appMenu?.submenu?.find((i) => i.id === "app-quit");
  check(
    "P2-176: darwin app submenu with about/hide and the pt-BR quit item",
    appMenu?.label === "OpenCode Remote" &&
      appMenu.submenu?.some((i) => i.role === "about") === true &&
      appMenu.submenu?.some((i) => i.role === "hide") === true &&
      quitItem?.label === "Encerrar OpenCode Remote",
  );
  for (const [platform, spec] of [["win32", win], ["linux", linux]] as const) {
    check(
      `P2-176: no app submenu on ${platform}`,
      !spec.some((i) => i.submenu?.some((x) => x.role === "quit" || x.role === "about" || x.role === "hide")),
    );
  }

  // 4. editMenu/windowMenu stay native roles so the OS translates them.
  check(
    "P2-176: editMenu and windowMenu remain native roles on all platforms",
    ["darwin", "win32", "linux"].every((p) => {
      const spec = menuSpec(p, null, false);
      return spec.some((i) => i.role === "editMenu") && spec.some((i) => i.role === "windowMenu");
    }),
  );

  // 5. Help submenu on every platform, with the tray-grade support items.
  for (const platform of ["darwin", "win32", "linux"]) {
    const help = helpItems(menuSpec(platform, null, false));
    check(
      `P2-176: Help submenu present on ${platform} with logs + diagnostics`,
      titled(menuSpec(platform, null, false), "Ajuda") !== undefined &&
        byId(help, "help-logs")?.label === "Abrir pasta de logs" &&
        byId(help, "help-diagnostics")?.label === "Copiar diagnóstico",
    );
  }

  // 6. update items follow the updatesEnabled verdict: absent when false,
  //    present with the received label (status line, disabled) and the
  //    clickable check item when true.
  check(
    "P2-176: no update items when updatesEnabled is false",
    helpItems(win).every((i) => i.id !== "help-updates" && i.id !== "help-update-status"),
  );
  const helpOn = helpItems(mac);
  const statusItem = byId(helpOn, "help-update-status");
  check(
    "P2-176: update status item carries the received label (disabled, like the tray)",
    statusItem?.label === "Update available — check for updates" && statusItem?.enabled === false,
  );
  check(
    "P2-176: Verificar atualizações item present and clickable when enabled",
    byId(helpOn, "help-updates")?.label === "Verificar atualizações" && byId(helpOn, "help-updates")?.enabled !== false,
  );

  // 7. the real main.ts: buildMenu consumes menuSpec and writes no inline
  //    labels/accelerators anymore (the descriptor is the single source).
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const start = mainSrc.indexOf("function buildMenu(): void {");
  const end = start >= 0 ? mainSrc.indexOf("\n}\n", start) : -1;
  const buildMenuSrc = start >= 0 && end > start ? mainSrc.slice(start, end) : "";
  check(
    "P2-176: main.ts buildMenu consumes menuSpec with no inline labels",
    buildMenuSrc.includes("menuSpec(") && !buildMenuSrc.includes("label:") && !buildMenuSrc.includes("accelerator:"),
  );
}


// --- P2-238: remembered zoom level (apps/desktop/src/zoomlevel.ts) ---------------
{
  const viewItems = (level: number | undefined) => {
    const view = menuSpec("darwin", null, false, null, level).find((i) => i.label === "Visualizar");
    return (view?.submenu ?? []).filter((i) => i.id?.startsWith("view-zoom-"));
  };
  const byId = (items: MenuItemSpec[], id: string) => items.find((i) => i.id === id);

  // 1. sanitizeZoom full table: whatever the disk yields, a valid level comes
  //    out and nothing ever throws.
  check("P2-238: sanitizeZoom — absent state becomes the default", sanitizeZoom(undefined) === DEFAULT_ZOOM_LEVEL);
  check("P2-238: sanitizeZoom — text becomes the default", sanitizeZoom("big") === DEFAULT_ZOOM_LEVEL);
  check(
    "P2-238: sanitizeZoom — non-finite values become the default",
    sanitizeZoom(Number.NaN) === DEFAULT_ZOOM_LEVEL && sanitizeZoom(Number.POSITIVE_INFINITY) === DEFAULT_ZOOM_LEVEL && sanitizeZoom(Number.NEGATIVE_INFINITY) === DEFAULT_ZOOM_LEVEL,
  );
  check(
    "P2-238: sanitizeZoom — wrong types (null/bool/object/array) become the default",
    sanitizeZoom(null) === DEFAULT_ZOOM_LEVEL &&
      sanitizeZoom(true) === DEFAULT_ZOOM_LEVEL &&
      sanitizeZoom({ level: 2 }) === DEFAULT_ZOOM_LEVEL &&
      sanitizeZoom([2]) === DEFAULT_ZOOM_LEVEL,
  );
  check("P2-238: sanitizeZoom — below the minimum becomes the minimum", sanitizeZoom(-99) === MIN_ZOOM_LEVEL);
  check("P2-238: sanitizeZoom — above the maximum becomes the maximum", sanitizeZoom(99) === MAX_ZOOM_LEVEL);
  check(
    "P2-238: sanitizeZoom — valid levels (integer and fractional) pass through",
    sanitizeZoom(0) === 0 && sanitizeZoom(2.3) === 2.3 && sanitizeZoom(MIN_ZOOM_LEVEL) === MIN_ZOOM_LEVEL && sanitizeZoom(MAX_ZOOM_LEVEL) === MAX_ZOOM_LEVEL,
  );

  // 2. zoomVerdict table: one step per click, honest limit flags, restore
  //    always lands on the default.
  const up = zoomVerdict(DEFAULT_ZOOM_LEVEL, "increase");
  check(
    "P2-238: zoomVerdict — increase from the default moves exactly one step up",
    up.level === DEFAULT_ZOOM_LEVEL + ZOOM_STEP && up.atLimit === false,
  );
  const down = zoomVerdict(DEFAULT_ZOOM_LEVEL, "decrease");
  check(
    "P2-238: zoomVerdict — decrease from the default moves exactly one step down",
    down.level === DEFAULT_ZOOM_LEVEL - ZOOM_STEP && down.atLimit === false,
  );
  const atCeiling = zoomVerdict(MAX_ZOOM_LEVEL, "increase");
  check(
    "P2-238: zoomVerdict — increase at the ceiling keeps the level and flags the limit",
    atCeiling.level === MAX_ZOOM_LEVEL && atCeiling.atLimit === true,
  );
  const atFloor = zoomVerdict(MIN_ZOOM_LEVEL, "decrease");
  check(
    "P2-238: zoomVerdict — decrease at the floor keeps the level and flags the limit",
    atFloor.level === MIN_ZOOM_LEVEL && atFloor.atLimit === true,
  );
  check(
    "P2-238: zoomVerdict — restore always returns the default",
    zoomVerdict(MAX_ZOOM_LEVEL, "restore").level === DEFAULT_ZOOM_LEVEL &&
      zoomVerdict(MIN_ZOOM_LEVEL, "restore").level === DEFAULT_ZOOM_LEVEL &&
      zoomVerdict(2.3, "restore").level === DEFAULT_ZOOM_LEVEL &&
      zoomVerdict(DEFAULT_ZOOM_LEVEL, "restore").atLimit === true,
  );
  check(
    "P2-238: zoomVerdict — stable between two calls with the same input",
    JSON.stringify(zoomVerdict(1.4, "increase")) === JSON.stringify(zoomVerdict(1.4, "increase")) &&
      JSON.stringify(zoomVerdict(1.4, "restore")) === JSON.stringify(zoomVerdict(1.4, "restore")),
  );
  let sweepInBounds = true;
  for (const level of [-99, -3, 0, 0.5, 2.3, 6, 99, "x", undefined, Number.NaN]) {
    for (const action of ["increase", "decrease", "restore"] as const) {
      const v = zoomVerdict(level, action);
      sweepInBounds = sweepInBounds && v.level >= MIN_ZOOM_LEVEL && v.level <= MAX_ZOOM_LEVEL;
    }
  }
  check("P2-238: zoomVerdict — no verdict ever leaves the documented range", sweepInBounds);

  // 3. Startup plan: the harness-session rule is FIRST — the default level
  //    even when the state on disk says otherwise, and persist=false so
  //    nothing zoom-related is ever written (stable evidence framing).
  check(
    "P2-238: harness session — default level, nothing persisted, even with out-of-default saved state",
    zoomStartupPlan({ harnessSession: true, saved: 4 }).level === DEFAULT_ZOOM_LEVEL &&
      zoomStartupPlan({ harnessSession: true, saved: 4 }).persist === false &&
      zoomStartupPlan({ harnessSession: true, saved: -2.5 }).persist === false,
  );
  check(
    "P2-238: non-harness — absent/garbage state falls back to the default and persists",
    zoomStartupPlan({ harnessSession: false, saved: undefined }).level === DEFAULT_ZOOM_LEVEL &&
      zoomStartupPlan({ harnessSession: false, saved: "corrupted" }).level === DEFAULT_ZOOM_LEVEL &&
      zoomStartupPlan({ harnessSession: false, saved: undefined }).persist === true,
  );
  check(
    "P2-238: non-harness — a remembered level survives the roundtrip",
    zoomStartupPlan({ harnessSession: false, saved: 2 }).level === 2 &&
      zoomStartupPlan({ harnessSession: false, saved: 99 }).level === MAX_ZOOM_LEVEL,
  );

  // 4. Persistence shape: the zoom field is additive in window-state.json.
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  const zoomDir = mkdtempSync(join(tmpdir(), "ocr-zoom-"));
  const zoomFile = windowStateFile(zoomDir);
  check(
    "P2-238: window-state roundtrip preserves the zoom level",
    saveWindowBounds(zoomFile, { x: 1, y: 2, width: 1280, height: 820, zoom: 2 }) &&
      loadWindowBounds(zoomFile, displays).zoom === 2 &&
      JSON.parse(readFileSync(zoomFile, "utf8")).zoom === 2,
  );
  writeFileSync(zoomFile, JSON.stringify({ x: 7, y: 8, width: 1600, height: 900 }), "utf8");
  check(
    "P2-238: legacy file without the zoom field stays valid and means the default",
    loadWindowBounds(zoomFile, displays).zoom === undefined,
  );
  writeFileSync(zoomFile, JSON.stringify({ x: 7, y: 8, width: 1600, height: 900, zoom: 99 }), "utf8");
  check(
    "P2-238: out-of-range zoom on disk is clamped at load time",
    loadWindowBounds(zoomFile, displays).zoom === MAX_ZOOM_LEVEL,
  );
  rmSync(zoomDir, { recursive: true, force: true });

  // 5. The View menu renders the verdict: items go disabled at their limit
  //    instead of pretending the click did something.
  const mid = viewItems(1);
  check(
    "P2-238: View menu — mid-range level leaves every zoom item enabled",
    mid.length === 3 && mid.every((i) => i.enabled !== false),
  );
  check(
    "P2-238: View menu — at the ceiling only Ampliar is disabled",
    byId(viewItems(MAX_ZOOM_LEVEL), "view-zoom-in")?.enabled === false &&
      byId(viewItems(MAX_ZOOM_LEVEL), "view-zoom-out")?.enabled !== false,
  );
  check(
    "P2-238: View menu — at the floor only Reduzir is disabled",
    byId(viewItems(MIN_ZOOM_LEVEL), "view-zoom-out")?.enabled === false &&
      byId(viewItems(MIN_ZOOM_LEVEL), "view-zoom-in")?.enabled !== false,
  );
  check(
    "P2-238: View menu — Tamanho padrão is disabled while already at the default",
    byId(viewItems(DEFAULT_ZOOM_LEVEL), "view-zoom-reset")?.enabled === false,
  );
  check(
    "P2-238: View menu — legacy menuSpec callers keep every zoom item enabled",
    viewItems(undefined).every((i) => i.enabled === undefined),
  );
  const zoomSpec = viewItems(1);
  check(
    "P2-238: View menu — same labels and accelerators the native roles had, no emoji, no roles",
    byId(zoomSpec, "view-zoom-reset")?.label === "Tamanho padrão" &&
      byId(zoomSpec, "view-zoom-reset")?.accelerator === "CmdOrCtrl+0" &&
      byId(zoomSpec, "view-zoom-in")?.label === "Ampliar" &&
      byId(zoomSpec, "view-zoom-in")?.accelerator === "CmdOrCtrl+Plus" &&
      byId(zoomSpec, "view-zoom-out")?.label === "Reduzir" &&
      byId(zoomSpec, "view-zoom-out")?.accelerator === "CmdOrCtrl+-" &&
      zoomSpec.every((i) => i.role === undefined),
  );

  // 6. The real main.ts/menu.ts: the harness rule is consulted first, the
  //    level persists through the existing window-state path and no periodic
  //    timer came with the feature.
  const menuTsSource = readFileSync(new URL("../apps/desktop/src/menu.ts", import.meta.url), "utf8");
  const zoomTsSource = readFileSync(new URL("../apps/desktop/src/zoomlevel.ts", import.meta.url), "utf8");
  const planAt = mainTsSource.indexOf("zoomStartupPlan({");
  const firstApplyAt = mainTsSource.indexOf("setZoomLevel");
  check(
    "P2-238: main.ts consults the harness-session rule before anything applies a zoom level",
    planAt >= 0 && firstApplyAt > planAt && mainTsSource.slice(planAt, planAt + 120).includes("harnessSession: HERMETIC_E2E"),
  );
  const saveAt = mainTsSource.indexOf("saveWindowBounds(stateFile, {");
  const closeBlock = saveAt >= 0 ? mainTsSource.slice(saveAt, mainTsSource.indexOf("});", saveAt)) : "";
  check(
    "P2-238: main.ts persists the level through the same window-state path as the bounds",
    closeBlock.includes("getNormalBounds()") && closeBlock.includes("zoom:") && closeBlock.includes("zoomPersistable"),
  );
  check(
    "P2-238: the zoom wiring introduces no periodic timer",
    mainTsSource
      .split("\n")
      .filter((l) => l.includes("setZoomLevel") || l.includes("zoomStartupPlan"))
      .every((l) => !l.includes("setInterval") && !l.includes("setTimeout")) &&
      !/setInterval|setTimeout/.test(zoomTsSource),
  );
  check(
    "P2-238: zoomlevel.ts keeps the pure-module hygiene (no electron, no fs, no I/O)",
    zoomTsSource
      .split("\n")
      .filter((l) => l.trim().startsWith("import "))
      .every((l) => !/electron|node:fs|node:path|node:os|node:child_process/.test(l)) &&
      !/setInterval|setTimeout/.test(zoomTsSource),
  );
  check(
    "P2-238: menu.ts no longer carries the native zoom roles",
    !menuTsSource.includes('"resetZoom"') && !menuTsSource.includes('"zoomIn"') && !menuTsSource.includes('"zoomOut"'),
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


// --- P2-172 maximized-state persistence ------------------------------------------
{
  // Same fake display setup as the P3-008 block above.
  const displays = [
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
  ];

  const onScreen = sanitizeWindowBounds({ x: 10, y: 20, width: 1600, height: 900, maximized: true }, displays);
  check(
    "window-state: maximized true with valid on-screen bounds is preserved",
    onScreen.x === 10 && onScreen.y === 20 && onScreen.width === 1600 && onScreen.height === 900 && onScreen.maximized === true,
  );

  const offScreen = sanitizeWindowBounds({ x: 9999, y: 20, width: 1600, height: 900, maximized: true }, displays);
  check(
    "window-state: maximized true survives bounds falling back to the default (display gone)",
    offScreen.width === DEFAULT_WINDOW_BOUNDS.width &&
      offScreen.height === DEFAULT_WINDOW_BOUNDS.height &&
      offScreen.x === DEFAULT_WINDOW_BOUNDS.x &&
      offScreen.maximized === true,
  );

  const garbage = sanitizeWindowBounds({ width: "big", height: null, maximized: true }, displays);
  check(
    "window-state: maximized true survives garbage bounds falling back to the default",
    garbage.width === DEFAULT_WINDOW_BOUNDS.width &&
      garbage.height === DEFAULT_WINDOW_BOUNDS.height &&
      garbage.maximized === true,
  );

  const notBoolean = sanitizeWindowBounds({ x: 0, y: 0, width: 1600, height: 900, maximized: "yes" }, displays);
  const notBoolean2 = sanitizeWindowBounds({ x: 0, y: 0, width: 1600, height: 900, maximized: 1 }, displays);
  check(
    "window-state: non-boolean maximized (string/number) normalizes to false",
    notBoolean.maximized === false && notBoolean2.maximized === false,
  );

  check(
    "window-state: maximized absent → false (legacy file, no migration)",
    sanitizeWindowBounds({ x: 0, y: 0, width: 1600, height: 900 }, displays).maximized === false,
  );

  const invalidNoMax = sanitizeWindowBounds({ width: 0, height: -5, x: 0, y: 0 }, displays);
  check(
    "window-state: invalid bounds with maximized absent → default, not maximized",
    invalidNoMax.width === DEFAULT_WINDOW_BOUNDS.width &&
      invalidNoMax.height === DEFAULT_WINDOW_BOUNDS.height &&
      invalidNoMax.maximized === false,
  );

  // File roundtrip: saveWindowBounds + loadWindowBounds preserve the flag.
  const wsdMax = mkdtempSync(join(tmpdir(), "ocr-winstate-max-"));
  const maxFile = windowStateFile(wsdMax);
  check(
    "window-state: roundtrip preserves maximized true",
    saveWindowBounds(maxFile, { x: 5, y: 6, width: 1440, height: 900, maximized: true }),
  );
  const loadedMax = loadWindowBounds(maxFile, displays);
  check(
    "window-state: loaded maximized true matches what was saved",
    loadedMax.x === 5 && loadedMax.y === 6 && loadedMax.width === 1440 && loadedMax.height === 900 && loadedMax.maximized === true,
  );
  check(
    "window-state: roundtrip preserves maximized false",
    saveWindowBounds(maxFile, { x: 5, y: 6, width: 1440, height: 900, maximized: false }),
  );
  check(
    "window-state: loaded maximized false matches what was saved",
    loadWindowBounds(maxFile, displays).maximized === false,
  );
  // A legacy P3-008 file (no field) still loads — as not maximized.
  writeFileSync(maxFile, JSON.stringify({ x: 7, y: 8, width: 1600, height: 900 }), "utf8");
  const legacy = loadWindowBounds(maxFile, displays);
  check(
    "window-state: legacy file without the field loads maximized false",
    legacy.x === 7 && legacy.y === 8 && legacy.width === 1600 && legacy.maximized === false,
  );
  rmSync(wsdMax, { recursive: true, force: true });
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


// --- P1-074 infra failures must not burn attempts or fever samples ----------------
// P1-094: classification rides the structured `infra` flag, never the detail text
{
  // positives: only the producer-set structured flag counts
  check("infra kind: structured api-down flag → api-down", resultInfraKind({ ok: false, infra: "api-down" }) === "api-down");
  check("infra kind: structured spawn flag → spawn", resultInfraKind({ ok: false, infra: "spawn" }) === "spawn");
  check("infra kind: structured timeout flag → timeout", resultInfraKind({ ok: false, infra: "timeout" }) === "timeout");
  // THE task criterion: a merit finding citing infra words must stay merit
  check("infra kind: finding citing ECONNREFUSED is merit", resultInfraKind({ ok: false, detail: "max review rounds reached — findings: fix flaky test (got ECONNREFUSED at setup)" }) === null);
  // negatives — merit failures stay merit
  check("infra kind: gatekeeper rejection is merit", resultInfraKind({ ok: false, detail: "gatekeeper rejected: eval battery or invariants failed" }) === null);
  check("infra kind: review rounds exhausted is merit", resultInfraKind({ ok: false, detail: "max review rounds reached — findings: ..." }) === null);
  check("infra kind: empty diff is merit", resultInfraKind({ ok: false, detail: "builder produced an empty diff" }) === null);
  // ok outcomes are never infra, even with a text mention of infra words
  check("infra kind: ok result with econnrefused text is not infra", resultInfraKind({ ok: true, detail: "anything-econnrefused", infra: "spawn" }) === null);
  // preflight/spawn producer sites keep the free retry
  check("infra kind: preflight failure carries api-down", resultInfraKind({ ok: false, detail: "[preflight] opencode API unreachable", infra: "api-down" }) === "api-down");

  // fever immunity: 12 consecutive infra outcomes (the runSlot infra branch:
  // recordInfraFailure + skip recordCycle) add no cycle sample and no attempt
  const infraRun = { date: "2026-09-01", tasks: 0, deploys: 0, failures: 0, taskAttempts: {} } as PilotState;
  for (let i = 0; i < 12; i++) {
    const infra = resultInfraKind({ ok: false, detail: "[preflight] opencode API unreachable at http://127.0.0.1:4096", infra: "api-down" });
    if (infra) recordInfraFailure(infraRun);
    else recordCycle(infraRun, false, "P1-074", i);
  }
  check("infra: 12 infra outcomes never feed the fever window", feverReason(infraRun) === null);
  check("infra: infra outcomes burn no attempts", Object.keys(infraRun.taskAttempts).length === 0 && infraRun.infraFails === 12);

  // merit control: one non-infra failure still takes the existing path
  const meritRun = { date: "2026-09-01", tasks: 0, deploys: 0, failures: 0, taskAttempts: {} } as PilotState;
  if (!resultInfraKind({ ok: false, detail: "gatekeeper rejected: eval battery or invariants failed" })) {
    recordCycle(meritRun, false, "P1-074");
    recordTaskFailure(meritRun, "P1-074", 4);
  }
  check("infra: merit control still records cycle + attempt", meritRun.cycles!.length === 1 && meritRun.taskAttempts["P1-074"] === 1);

  // doctor wake: exactly on the 3rd and 6th infra failure
  check("infra: doctor cadence constant is 3", INFRA_DOCTOR_EVERY === 3);
  const wakeRun = { date: "2026-09-01", tasks: 0, deploys: 0, failures: 0, taskAttempts: {} } as PilotState;
  const wakes: boolean[] = [];
  for (let i = 0; i < 7; i++) wakes.push(recordInfraFailure(wakeRun));
  check("infra: doctor wakes exactly on the 3rd and 6th failure", wakes[2] === true && wakes[5] === true && wakes.filter(Boolean).length === 2);

  // legacy state.json without the field backfills to 0, never NaN
  const dir = mkdtempSync(join(tmpdir(), "pilot-infra-state-"));
  try {
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ date: new Date().toLocaleDateString("en-CA"), tasks: 1, deploys: 0, failures: 0, taskAttempts: {} }));
    check("infra: loadState backfills infraFails for legacy state", loadState(file).infraFails === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// --- P1-104: a thrown pipeline crash is infra — never a merit attempt ----------
{
  // THE task criterion: 12 crash loops (the runSlot catch path) burn no
  // per-task attempt and can never block the task
  const crashRun = { date: "2026-09-01", tasks: 0, deploys: 0, failures: 0, taskAttempts: {} } as PilotState;
  for (let i = 0; i < 12; i++) recordPipelineCrash(crashRun, i);
  check("P1-104: 12 crashes burn no per-task attempts", Object.keys(crashRun.taskAttempts).length === 0);
  check("P1-104: crashes count in the diagnostic infraFails counter", crashRun.infraFails === 12);
  // the systemic guard stays: each crash is its own un-attributed fever entry
  check("P1-104: a crash loop still trips the global fever breaker", feverReason(crashRun) !== null);
  // doctor wake cadence is shared with the result-infra path (every 3rd)
  const wakeRun = { date: "2026-09-01", tasks: 0, deploys: 0, failures: 0, taskAttempts: {} } as PilotState;
  const wakes: boolean[] = [];
  for (let i = 0; i < 7; i++) wakes.push(recordPipelineCrash(wakeRun, i));
  check("P1-104: doctor wakes exactly on the 3rd and 6th crash", wakes[2] === true && wakes[5] === true && wakes.filter(Boolean).length === 2);

  // wiring pin: the catch must record infra evidence and must NOT feed the
  // merit circuit breaker (the old `pipeline crashed:` detail is gone)
  const pilotIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "index.ts"), "utf8");
  check(
    "P1-104: crash catch routes through recordPipelineCrash, never tripCircuitBreaker",
    pilotIndexSrc.includes("const wake = recordPipelineCrash(state);") &&
      !pilotIndexSrc.includes("pipeline crashed: ${detail}"),
  );
}


// --- P2-125: the task-PR merge confirms MERGED fail-closed, gh noise is infra ----
{
  // budget pin: ~5 minutes, same shape as the meta-PR confirmation
  check("P2-125: confirm budget is 60 polls × 5s = 5min", PR_MERGE_CONFIRM_POLLS * PR_MERGE_CONFIRM_DELAY_MS === 300_000);

  const sha = "c".repeat(40);
  const otherSha = "d".repeat(40);
  // Fake gh surface (zero network): create fails (PR already open from a
  // previous cycle), list resolves the number, merge exec FAILS (the
  // P2-117/P2-123 shape: --auto armed under branch protection errors at arm
  // time) and the poll loop then decides what the view reports.
  const mkIo = (view: () => { state: string; headRefOid: string } | null, mergeOutput = "gh: failed to arm auto-merge") => {
    const calls: string[] = [];
    let sleeps = 0;
    const io: PrMergeIo = {
      exec: (cmd) => {
        calls.push(cmd);
        if (cmd.startsWith("gh pr create")) return { ok: false, output: "a pull request for head pilot/P2-125 already exists" };
        if (cmd.startsWith("gh pr list")) return { ok: true, output: "42\n" };
        if (cmd.startsWith("gh pr merge")) return { ok: false, output: mergeOutput };
        if (cmd.startsWith("gh pr view")) {
          const snap = view();
          return snap
            ? { ok: true, output: JSON.stringify({ state: snap.state, headRefOid: snap.headRefOid }) }
            : { ok: false, output: "no pull requests" };
        }
        return { ok: false, output: `unexpected exec: ${cmd}` };
      },
      sleep: () => {
        sleeps++;
        return Promise.resolve();
      },
    };
    return { io, calls, getSleeps: () => sleeps };
  };

  // THE P2-117/P2-123 criterion: merge exec errored, PR still confirms MERGED
  // with our sha ⇒ success (auto-merge was armed; the squash fired later).
  const confirmed = mkIo(() => ({ state: "MERGED", headRefOid: sha }));
  const confirmedOut = await mergePrForTask(confirmed.io, {
    branch: "pilot/P2-125",
    title: "t",
    body: "b",
    pushedSha: sha,
  });
  check("P2-125: merge exec failed but PR confirms MERGED ⇒ success", confirmedOut.ok === true);
  check("P2-125: create failure falls through to pr list (PR reused)", confirmed.calls.some((c) => c.startsWith("gh pr list --head pilot/P2-125 --state all")));
  check("P2-125: merge addressed by PR number, never by branch", confirmed.calls.some((c) => c.startsWith("gh pr merge 42 ")) && confirmed.calls.some((c) => c.startsWith("gh pr view 42 ")) && !confirmed.calls.some((c) => c.startsWith("gh pr view pilot/")));
  check("P2-125: immediate confirmation has zero artificial latency (no sleep before poll 0)", confirmed.getSleeps() === 0);

  // MERGED with another headRefOid is a real anomaly — merit, never success
  const swapped = mkIo(() => ({ state: "MERGED", headRefOid: otherSha }));
  const swappedOut = await mergePrForTask(swapped.io, { branch: "pilot/P2-125", title: "t", body: "b", pushedSha: sha });
  check("P2-125: MERGED with another headRefOid ⇒ failure, never success", swappedOut.ok === false && swappedOut.infra === undefined);

  // queued forever: view stays OPEN for the whole budget ⇒ honest infra
  // timeout; polling never sleeps before reading (59 sleeps for 60 polls)
  const queued = mkIo(() => ({ state: "OPEN", headRefOid: sha }));
  const queuedOut = await mergePrForTask(queued.io, { branch: "pilot/P2-125", title: "t", body: "b", pushedSha: sha });
  check("P2-125: merge never confirmed ⇒ ok=false with infra=timeout", queuedOut.ok === false && queuedOut.infra === "timeout");
  check("P2-125: unconfirmed detail carries the gh merge tail", queuedOut.detail.includes("failed to arm auto-merge"));
  check("P2-125: every poll in the budget ran", queued.calls.filter((c) => c.startsWith("gh pr view")).length === PR_MERGE_CONFIRM_POLLS);
  check("P2-125: sleep only between polls (59 sleeps for 60 polls)", queued.getSleeps() === PR_MERGE_CONFIRM_POLLS - 1);

  // the runSlot infra branch: structured kind → recordInfraFailure only —
  // no taskAttempts entry, no fever sample (mirrors apps/pilot/src/index.ts)
  const st = { date: "2026-09-04", tasks: 0, deploys: 0, failures: 0, taskAttempts: {} } as PilotState;
  const kind = resultInfraKind({ ok: queuedOut.ok, infra: queuedOut.infra });
  if (kind) recordInfraFailure(st);
  else {
    recordCycle(st, false, "P2-125");
    recordTaskFailure(st, "P2-125", 4);
  }
  check("P2-125: infra merge failure burns no per-task attempt", Object.keys(st.taskAttempts).length === 0);
  check("P2-125: infra merge failure never feeds the fever window", feverReason(st) === null);

  // both create and list dead: no PR number resolvable ⇒ infra network, and
  // the detail carries each captured gh tail (≤300 chars per step)
  const bothDead = mkIo(() => null);
  bothDead.io.exec = (cmd) => {
    bothDead.calls.push(cmd);
    if (cmd.startsWith("gh pr create")) return { ok: false, output: "x".repeat(400) };
    if (cmd.startsWith("gh pr list")) return { ok: false, output: "gh: no default remote (network down)" };
    return { ok: false, output: "" };
  };
  const deadOut = await mergePrForTask(bothDead.io, { branch: "pilot/P2-125", title: "t", body: "b", pushedSha: sha });
  check("P2-125: unresolvable PR number ⇒ infra network", deadOut.ok === false && deadOut.infra === "network");
  check("P2-125: detail carries the gh create/list tails", deadOut.detail.includes("pr create failed:") && deadOut.detail.includes("pr list: gh: no default remote"));
  check("P2-125: each captured gh tail is capped at 300 chars", deadOut.detail.includes("x".repeat(300)) && !deadOut.detail.includes("x".repeat(301)));

  // wiring pin: the caller propagates `infra` and the reason-free generic
  // detail is gone (it was the whole bug — merit classification of gh noise)
  const pipelineSrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "pipeline.ts"), "utf8");
  check(
    "P2-125: merge failure line propagates the structured infra kind",
    pipelineSrc.includes("infra: merged.infra") && pipelineSrc.includes("gate green but the PR merge failed: ${merged.detail}"),
  );
  check("P2-125: the old reason-free merge detail no longer exists", !pipelineSrc.includes("gate green but the PR merge failed — the next cycle retries the PR"));
  check(
    "P2-125: P2-058 verified-merge guard untouched (recordVerifiedMerge + isTaskMergeSha still wired)",
    pipelineSrc.includes("isTaskMergeSha(ws, postMergeHead, t.id)") && pipelineSrc.includes("recordVerifiedMerge(defaultVerifiedMergesFile(), postMergeHead, t.id"),
  );
}


// --- P2-134: conflict-blocked PR is infra, resume rebase refreshes the branch -----
{
  // pure classifier: only CONFLICTING/DIRTY block; anything else (missing
  // fields, MERGEABLE, UNKNOWN, BLOCKED, BEHIND, non-string values) keeps the
  // poll running exactly as before
  check("P2-134: mergeable=CONFLICTING ⇒ blocked", (mergeBlockReason({ mergeable: "CONFLICTING" }) ?? "").includes("CONFLICTING"));
  check("P2-134: mergeStateStatus=DIRTY ⇒ blocked", (mergeBlockReason({ mergeStateStatus: "DIRTY" }) ?? "").includes("DIRTY"));
  const both = mergeBlockReason({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) ?? "";
  check("P2-134: both fields ⇒ reason cites both", both.includes("CONFLICTING") && both.includes("DIRTY"));
  check(
    "P2-134: clean/blocked/behind/unknown snapshots never block",
    mergeBlockReason({}) === null &&
      mergeBlockReason({ mergeable: "MERGEABLE" }) === null &&
      mergeBlockReason({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }) === null &&
      mergeBlockReason({ mergeable: "BLOCKED" }) === null &&
      mergeBlockReason({ mergeStateStatus: "BEHIND" }) === null,
  );
  check(
    "P2-134: non-string fields behave as absent (external JSON)",
    mergeBlockReason({ mergeable: 1, mergeStateStatus: null }) === null && mergeBlockReason({ mergeable: undefined, mergeStateStatus: undefined }) === null,
  );

  // fake gh surface (zero network), same mold as P2-125: create fails (PR
  // already open), list resolves the number, merge exec fails, the poll loop
  // decides what the view reports — now with the P2-134 conflict fields.
  const sha = "c".repeat(40);
  const mkIo134 = (view: () => { state: string; headRefOid: string; mergeable?: string; mergeStateStatus?: string } | null) => {
    const calls: string[] = [];
    let sleeps = 0;
    const io: PrMergeIo = {
      exec: (cmd) => {
        calls.push(cmd);
        if (cmd.startsWith("gh pr create")) return { ok: false, output: "a pull request for head pilot/P2-134 already exists" };
        if (cmd.startsWith("gh pr list")) return { ok: true, output: "42\n" };
        if (cmd.startsWith("gh pr merge")) return { ok: false, output: "gh: failed to arm auto-merge" };
        if (cmd.startsWith("gh pr view")) {
          const snap = view();
          return snap ? { ok: true, output: JSON.stringify(snap) } : { ok: false, output: "no pull requests" };
        }
        return { ok: false, output: `unexpected exec: ${cmd}` };
      },
      sleep: () => {
        sleeps++;
        return Promise.resolve();
      },
    };
    return { io, calls, getSleeps: () => sleeps };
  };

  // THE P2-117/P2-123/P2-126 shape: gate green, PR parked on a merge conflict
  // with main ⇒ bail out on the CURRENT poll with infra "conflict"
  const conflicting = mkIo134(() => ({ state: "OPEN", headRefOid: sha, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }));
  const conflictOut = await mergePrForTask(conflicting.io, { branch: "pilot/P2-134", title: "t", body: "b", pushedSha: sha });
  check("P2-134: CONFLICTING PR ⇒ ok=false with infra=conflict", conflictOut.ok === false && conflictOut.infra === "conflict");
  check("P2-134: conflict detail cites the real GitHub reason", conflictOut.detail.includes("PR #42 blocked:") && conflictOut.detail.includes("CONFLICTING") && conflictOut.detail.includes("DIRTY"));
  check("P2-134: conflict bails on the current poll (exactly 1 view, 0 sleeps)", conflicting.calls.filter((c) => c.startsWith("gh pr view")).length === 1 && conflicting.getSleeps() === 0);
  check("P2-134: poll query pinned to state,headRefOid,mergeable,mergeStateStatus", conflicting.calls.some((c) => c === "gh pr view 42 --json state,headRefOid,mergeable,mergeStateStatus"));

  // MERGED wins over the conflict check — residual mergeable fields are noise
  const mergeable = mkIo134(() => ({ state: "MERGED", headRefOid: sha, mergeable: "UNKNOWN" }));
  const mergeableOut = await mergePrForTask(mergeable.io, { branch: "pilot/P2-134", title: "t", body: "b", pushedSha: sha });
  check("P2-134: MERGED with residual mergeable=UNKNOWN ⇒ success", mergeableOut.ok === true);
  const residual = mkIo134(() => ({ state: "MERGED", headRefOid: sha, mergeable: "CONFLICTING" }));
  const residualOut = await mergePrForTask(residual.io, { branch: "pilot/P2-134", title: "t", body: "b", pushedSha: sha });
  check("P2-134: MERGED wins over a residual CONFLICTING (order pinned)", residualOut.ok === true);

  // snapshot without mergeable/mergeStateStatus (old gh): today's behavior —
  // poll the whole budget, then honest infra timeout
  const noField = mkIo134(() => ({ state: "OPEN", headRefOid: sha }));
  const noFieldOut = await mergePrForTask(noField.io, { branch: "pilot/P2-134", title: "t", body: "b", pushedSha: sha });
  check("P2-134: snapshot without mergeable keeps polling ⇒ infra=timeout", noFieldOut.ok === false && noFieldOut.infra === "timeout");
  check("P2-134: legacy snapshot runs the full poll budget", noField.calls.filter((c) => c.startsWith("gh pr view")).length === PR_MERGE_CONFIRM_POLLS);

  // the runSlot infra branch: structured "conflict" → recordInfraFailure only —
  // no taskAttempts entry, no fever sample (mirrors apps/pilot/src/index.ts)
  const st = { date: "2026-09-04", tasks: 0, deploys: 0, failures: 0, taskAttempts: {} } as PilotState;
  const kind = resultInfraKind({ ok: conflictOut.ok, infra: conflictOut.infra });
  check("P2-134: conflict is a structured infra kind", kind === "conflict");
  if (kind) recordInfraFailure(st);
  else {
    recordCycle(st, false, "P2-134");
    recordTaskFailure(st, "P2-134", 4);
  }
  check("P2-134: conflict burns no per-task attempt", Object.keys(st.taskAttempts).length === 0);
  check("P2-134: conflict never feeds the fever window", feverReason(st) === null);

  // pure outcome interpretation of the resume rebase
  check("P2-134: rebaseOutcome ok ⇒ clean", rebaseOutcome({ ok: true, output: "" }) === "clean");
  check("P2-134: rebaseOutcome !ok ⇒ conflict (never throws)", rebaseOutcome({ ok: false, output: "CONFLICT (content): Merge conflict in shared.txt" }) === "conflict");

  // Real-git acceptance (P1-036 lesson: never mock git)
  const originDir = mkdtempSync(join(tmpdir(), "ocr-rebaseorigin-"));
  const wsRepo = mkdtempSync(join(tmpdir(), "ocr-rebasews-"));
  try {
    execSync(`git init -q --bare ${JSON.stringify(originDir)}`, { stdio: ["ignore", "pipe", "pipe"] });
    const g = (c: string) => execSync(c, { cwd: wsRepo, stdio: ["ignore", "pipe", "pipe"] });
    g("git init -q -b main .");
    g("git config user.email t@t.local");
    g("git config user.name t");
    writeFileSync(join(wsRepo, "README.md"), "base\n");
    g("git add . && git commit -qm base");
    g(`git remote add origin ${JSON.stringify(originDir)}`);
    g("git push -q origin main");

    // clean rebase: preserved branch commits b.txt while another slot's merge
    // (non-conflicting) advanced origin/main with a.txt. The previous attempt
    // already PUSHED the branch (mergeTask), so origin sits at the pre-rebase
    // tip — the exact scenario where a plain retry push is rejected.
    g("git checkout -qb pilot/P2-134T");
    writeFileSync(join(wsRepo, "b.txt"), "branch work\n");
    g("git add . && git commit -qm 'branch work'");
    const preservedSha = g("git rev-parse HEAD").toString().trim();
    g("git push -q origin pilot/P2-134T");
    g("git checkout -q main");
    writeFileSync(join(wsRepo, "a.txt"), "main moved\n");
    g("git add . && git commit -qm 'main moved'");
    g("git push -q origin main");

    check("P2-134: clean resume rebase reports resumed", setupTaskBranch(wsRepo, "P2-134T", 1) === true);
    check("P2-134: HEAD is the task branch", g("git rev-parse --abbrev-ref HEAD").toString().trim() === "pilot/P2-134T");
    let ancestor = false;
    try {
      g("git merge-base --is-ancestor origin/main HEAD");
      ancestor = true;
    } catch {}
    check("P2-134: rebased branch contains origin/main", ancestor);
    check("P2-134: branch work survived the rebase", existsSync(join(wsRepo, "b.txt")));
    check("P2-134: main's new file is present after the rebase", existsSync(join(wsRepo, "a.txt")));
    check("P2-134: clean rebase rewrote the branch tip (gate re-runs on the new sha)", g("git rev-parse HEAD").toString().trim() !== preservedSha);

    // the rewritten branch must still be able to update the PR head: a plain
    // push is rejected non-fast-forward (origin at the pre-rebase tip), the
    // production retry push (--force-with-lease, same as metapush) succeeds
    const okCmd = (c: string) => {
      try {
        g(c);
        return true;
      } catch {
        return false;
      }
    };
    check("P2-134: plain retry push after rebase is rejected (the blocking shape)", !okCmd("git push -q origin pilot/P2-134T"));
    check("P2-134: force-with-lease retry push lands the rewritten branch", okCmd("git push -q --force-with-lease origin pilot/P2-134T"));
    check("P2-134: origin PR head now matches the rebased HEAD", g("git rev-parse origin/pilot/P2-134T").toString().trim() === g("git rev-parse HEAD").toString().trim());
    const pipelineSrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "pipeline.ts"), "utf8");
    check("P2-134: retry push is pinned to --force-with-lease in the source", pipelineSrc.includes("git push -q --force-with-lease origin pilot/${t.id}"));

    // conflicting rebase: both sides edit the same file ⇒ abort, branch intact
    g("git checkout -qb pilot/P2-134C origin/main");
    writeFileSync(join(wsRepo, "shared.txt"), "branch version\n");
    g("git add . && git commit -qm 'branch edits shared'");
    const conflictSha = g("git rev-parse HEAD").toString().trim();
    g("git checkout -q main");
    writeFileSync(join(wsRepo, "shared.txt"), "main version\n");
    g("git add . && git commit -qm 'main edits shared'");
    g("git push -q origin main");
    g("git checkout -q main"); // workspace sits anywhere; the branch is the carrier

    check("P2-134: conflicting resume rebase still reports resumed", setupTaskBranch(wsRepo, "P2-134C", 1) === true);
    check("P2-134: abort leaves the branch at the preserved tip", g("git rev-parse refs/heads/pilot/P2-134C").toString().trim() === conflictSha);
    check("P2-134: abort leaves a clean worktree", g("git status --porcelain").toString() === "");
    check("P2-134: no rebase state left behind", !existsSync(join(wsRepo, ".git", "rebase-merge")) && !existsSync(join(wsRepo, ".git", "rebase-apply")));
    check("P2-134: worktree shows the branch content, not main's", readFileSync(join(wsRepo, "shared.txt"), "utf8") === "branch version\n");

    // first attempt: fresh path, branch born at origin/main, no rebase runs
    check("P2-134: first attempt takes the fresh path (no rebase)", setupTaskBranch(wsRepo, "P2-134U", 0) === false);
    check("P2-134: fresh branch sits at origin/main", g("git rev-parse refs/heads/pilot/P2-134U").toString().trim() === g("git rev-parse origin/main").toString().trim());
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(wsRepo, { recursive: true, force: true });
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
      { ts: t(9), type: "phase", task: "PA", phase: "gatekeeper-done", ok: true }, // 1s (P1-101: closes the gate phase, not merge)
    ];
    const avg = avgPhaseDurations(flow);
    check("phaseDur: averages multi-round phases", avg.find((p) => p.phase === "builder")?.avgMs === 1_000 && avg.find((p) => p.phase === "builder")?.n === 2);
    check("phaseDur: closes every tracked phase", avg.find((p) => p.phase === "planner")?.avgMs === 1_000 && avg.find((p) => p.phase === "reviewers")?.avgMs === 1_000 && avg.find((p) => p.phase === "gatekeeper")?.avgMs === 1_000);
    check("phaseDur: no completed sample → phase omitted", avg.find((p) => p.phase === "scribe") === undefined);
    check("phaseDur: empty feed → empty summary", avgPhaseDurations([]).length === 0);

    // P1-101: aux gate phases sit between the opener and its terminator — they
    // must not clobber the gatekeeper opener, and `merge` no longer closes it
    const gateFlow: PilotEvent[] = [
      { ts: t(0), type: "phase", task: "PB", phase: "gatekeeper" },
      { ts: t(1), type: "phase", task: "PB", phase: "gate-flaky", ok: true, detail: "integration" },
      { ts: t(2), type: "phase", task: "PB", phase: "gate-fail", ok: false, detail: "unit" },
      { ts: t(3), type: "phase", task: "PB", phase: "gatekeeper-done", ok: false, detail: "unit" },
      { ts: t(4), type: "phase", task: "PB", phase: "merge", ok: false },
    ];
    const gateAvg = avgPhaseDurations(gateFlow);
    check(
      "P1-101: gate-flaky/gate-fail don't break the gatekeeper pairing; one sample",
      gateAvg.length === 1 && gateAvg[0]?.phase === "gatekeeper" && gateAvg[0]?.avgMs === 3_000 && gateAvg[0]?.n === 1,
    );
    check("P1-101: merge no longer closes the gatekeeper phase", !gateAvg.some((p) => p.phase === "merge"));

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

    // P1-071: fresh-state first-boot journey — unique session + prompt shape
    check("explorer: session name derives a never-used key from the date", explorerSessionName("2026-09-02") === "explorer-fresh-20260902");
    const prompt = explorerPrompt("/abs/shots", "explorer-fresh-20260902");
    check("explorer: prompt keys the run to its own fresh session", prompt.includes("OCR_DESKTOP_SESSION=explorer-fresh-"));
    check("explorer: prompt demands an untouched first-boot shot at 1440x900", prompt.includes("first-boot-") && prompt.includes("1440 900"));
    check("explorer: prompt carries the product-premise questions", prompt.includes("Why does a local app show any auth/pairing ceremony") && prompt.includes("reachable from first boot") && prompt.includes("empty states"));
    check("explorer: prompt keeps the structured output contract", prompt.trimEnd().endsWith("Your LAST line of output must be exactly: EXPLORER: DONE"));

    // real insertion path: the addTask line must round-trip through parseBacklog
    writeFileSync(join(dir, "BACKLOG.md"), "# B\n\n## Ready\n\n## Done\n");
    const f: ExplorerFinding = { title: "Pairing error vanishes after retry", severity: "high", area: "ui", shot, detail: "The invalid-code error clears after 2s." };
    addTask(dir, "P3-099", "P3", `[explorer][${f.severity}] ${f.title}`, explorerSpec(f));
    const parsed = parseBacklog(readFileSync(join(dir, "BACKLOG.md"), "utf8"));
    check("explorer: inserted line lands as a parseable Ready task", parsed.length === 1 && parsed[0]!.id === "P3-099" && parsed[0]!.priority === "P3" && parsed[0]!.area === "ui");
    check("explorer: inserted spec carries severity + evidence path", parsed[0]!.spec.includes("(severity: high, evidence: ") && parsed[0]!.spec.includes(shot));

    // P3-101 round 2: the once-per-day claim persists BEFORE the agent spawns —
    // the exact property "a crash must not re-run it same-day" depends on
    const claimState: any = { taskAttempts: {} };
    let claimSaves = 0;
    const claimed = claimExplorerRun(claimState, "2026-09-03", () => {
      claimSaves++;
    });
    check("explorer claim: first call sets explorerLast and persists before the run", claimed === true && claimState.explorerLast === "2026-09-03" && claimSaves === 1);
    const reclaim = claimExplorerRun(claimState, "2026-09-03", () => {
      claimSaves++;
    });
    check("explorer claim: same-day re-claim is a no-op that never re-saves", reclaim === false && claimState.explorerLast === "2026-09-03" && claimSaves === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// --- P3-052 round 2 + P1-076: explorer findings land via pilot/meta -------------
{
  const pristine = "# B\n\n## Ready\n\n## Done\n";
  const findings: ExplorerFinding[] = [
    { title: "First", severity: "medium", area: "ui", shot: "/x.png", detail: "detail one" },
  ];

  // fake-driven: lands on the 3rd attempt — checkout+apply+commit per attempt,
  // push 3x, sleep only between attempts
  const dir = mkdtempSync(join(tmpdir(), "pilot-explorer-"));
  try {
    writeFileSync(join(dir, "BACKLOG.md"), pristine);
    const calls: string[] = [];
    const sleeps: number[] = [];
    let pushes = 0;
    let prCreated = false;
    const landed = await commitAndPushFindings(dir, findings, "pilot(explorer): test run", {
      exec: (cmd) => {
        calls.push(cmd);
        if (cmd.includes(`git checkout -q -B ${META_BRANCH}`)) writeFileSync(join(dir, "BACKLOG.md"), pristine);
        if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
        if (cmd.includes(`origin HEAD:${META_BRANCH}`)) return { ok: ++pushes >= 3, output: "" };
        // R4: the landing verifies our sha (40-hex) and confirms the merge
        if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${"e".repeat(40)}\n` };
        if (cmd.startsWith("gh ") && cmd.includes("pr view"))
          return prCreated
            ? { ok: true, output: JSON.stringify({ state: pushes >= 3 ? "MERGED" : "OPEN", headRefOid: "e".repeat(40) }) }
            : { ok: false, output: "no pull requests" };
        if (cmd.startsWith("gh ") && cmd.includes("pr create")) {
          prCreated = true;
          return { ok: true, output: "" };
        }
        return { ok: true, output: "" };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    check("explorer push retry: lands on a later attempt", landed === true);
    check("explorer push retry: re-applies and commits on each attempt", calls.filter((c) => c.includes("git commit")).length === 3);
    check("explorer push retry: waits between attempts only", sleeps.length === 2 && sleeps.every((s) => s === EXPLORER_PUSH_WAIT_MS));
    check("explorer push retry: finding inserted into BACKLOG", readFileSync(join(dir, "BACKLOG.md"), "utf8").includes("[explorer][medium] First"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // always-failing push: budget exhausted, false reported
  const dir2 = mkdtempSync(join(tmpdir(), "pilot-explorer-"));
  try {
    writeFileSync(join(dir2, "BACKLOG.md"), pristine);
    let failPushes = 0;
    const exhausted = await commitAndPushFindings(dir2, findings, "msg", {
      exec: (cmd) => {
        if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
        if (cmd.includes(`origin HEAD:${META_BRANCH}`)) {
          failPushes++;
          return { ok: false, output: "" };
        }
        return { ok: true, output: "" };
      },
      sleep: async () => {},
    });
    check("explorer push retry: false after exhausting the budget", exhausted === false && failPushes === EXPLORER_PUSH_RETRIES);

    // broken git (checkout impossible): no commit, no push, no PR ever armed
    const cmds2: string[] = [];
    const noLanding = await commitAndPushFindings(dir2, findings, "msg", {
      exec: (cmd) => {
        cmds2.push(cmd);
        return { ok: false, output: "" };
      },
      sleep: async () => {},
    });
    check(
      "explorer push retry: broken worktree fails without pushing or arming a PR",
      noLanding === false && cmds2.some((c) => c.startsWith("git ")) && !cmds2.some((c) => c.includes(`origin HEAD:${META_BRANCH}`)) && !cmds2.some((c) => c.startsWith("gh ") && (c.includes("pr create") || c.includes("pr merge"))),
    );
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }

  // real git smoke: apostrophe in the message pins the shq escaping, and the
  // commit must actually land on the bare remote's pilot/meta (never on main).
  // The bare remote lives OUTSIDE the work tree — `git clean -qfd` inside the
  // landing loop would otherwise delete it (untracked directory).
  const gdir2 = mkdtempSync(join(tmpdir(), "pilot-explorer-push-"));
  const repo = join(gdir2, "work");
  try {
    const bare = join(gdir2, "origin.git");
    execSync(`git init -q --bare -b main "${bare}"`);
    execSync(`git clone -q "${bare}" "${repo}"`);
    execSync("git config user.email t@t.local && git config user.name t", { cwd: repo });
    writeFileSync(join(repo, "BACKLOG.md"), pristine);
    execSync(`git -C ${JSON.stringify(repo)} add BACKLOG.md && git -C ${JSON.stringify(repo)} -c user.name=t -c user.email=t@t commit -qm init`);
    execSync(`git -C ${JSON.stringify(repo)} push -q -u origin main`);
    const realExec = (cmd: string) => {
      try {
        return { ok: true, output: execSync(cmd, { cwd: repo, stdio: "pipe" }).toString() };
      } catch {
        return { ok: false, output: "" };
      }
    };
    let prMerged = false;
    let prExists = false;
    const smoke = await commitAndPushFindings(repo, findings, "pilot(explorer): smoke'd run", {
      exec: (cmd) => {
        if (cmd.startsWith("gh ")) {
          if (cmd.includes("pr view")) {
            if (!prExists) return { ok: false, output: "no pull requests" };
            return { ok: true, output: JSON.stringify({ state: prMerged ? "MERGED" : "OPEN", headRefOid: realExec(`git rev-parse origin/${META_BRANCH}`).output.trim() }) };
          }
          if (cmd.includes("pr create")) {
            prExists = true;
            return { ok: true, output: "" };
          }
          if (cmd.includes("pr merge")) {
            prMerged = true;
            return { ok: true, output: "" };
          }
          return { ok: true, output: "" };
        }
        return realExec(cmd);
      },
      sleep: async () => {},
    });
    const remoteLog = execSync(`git --git-dir "${bare}" log --format=%s ${META_BRANCH}`).toString();
    const mainLog = execSync(`git --git-dir "${bare}" log --format=%s main`).toString();
    check("explorer push retry: real git lands the commit on origin/pilot/meta", smoke === true && remoteLog.includes("smoke'd run"));
    check("explorer push retry: origin/main never receives the finding directly", !mainLog.includes("smoke'd run"));
  } finally {
    rmSync(gdir2, { recursive: true, force: true });
  }
}


// --- P2-105 fable product review: visual findings parser + journey shot set --------
{
  const dir = mkdtempSync(join(tmpdir(), "pilot-fable-"));
  try {
    const shot = join(dir, "journey-first-boot-20260903.png");
    writeFileSync(shot, "png");
    const output = [
      "prelude noise FABLE: FINDING inline mentions are ignored",
      "FABLE: FINDING",
      "title: Pairing screen shouts instead of guiding",
      "priority: p1",
      "area: ui",
      `evidence: ${shot}`,
      "where: apps/web/src/components/PairingView.tsx:42",
      "detail: The error headline uses alarm styling for a recoverable typo.",
      "",
      "FABLE: FINDING",
      "title: Unknown area improvement",
      "priority: P3",
      "area: bogus",
      `evidence: ${shot}`,
      "detail: Kept but serial.",
      "",
      "FABLE: FINDING",
      "title: Bad priority is dropped",
      "priority: urgent",
      `evidence: ${shot}`,
      "detail: Not a known product priority.",
      "",
      "FABLE: FINDING",
      "title: Missing evidence is dropped",
      "priority: P2",
      "evidence: /nonexistent/shot.png",
      "detail: No real evidence, no finding.",
      "",
      "FABLE: FINDING",
      "title: Duplicate title is deduped",
      "priority: P2",
      `evidence: ${shot}`,
      "detail: first",
      "",
      "FABLE: FINDING",
      "title:   Duplicate   TITLE   is   deduped  ",
      "priority: P2",
      `evidence: ${shot}`,
      "detail: second",
    ].join("\n");
    const found = parseFableFindings(output, { exists: (p) => p === shot });
    check("fable: parses prioritized improvements with evidence and file:line", found[0]?.title === "Pairing screen shouts instead of guiding" && found[0]?.priority === "P1" && found[0]?.area === "ui" && found[0]?.where === "apps/web/src/components/PairingView.tsx:42" && found[0]?.shot === shot);
    check("fable: lowercase priority normalizes, unknown area degrades to serial", found[0]?.priority === "P1" && found[1]?.area === "" && found[1]?.priority === "P3");
    check("fable: unknown priority dropped (fail closed)", !found.some((f) => f.title === "Bad priority is dropped"));
    check("fable: nonexistent evidence dropped", !found.some((f) => f.title === "Missing evidence is dropped"));
    check("fable: duplicate titles deduped keeping the first", found.length === 3 && found[2]?.detail === "first");
    check("fable: title whitespace collapses", found[2]?.title === "Duplicate title is deduped");
    const three = [1, 2, 3].map((i) => `FABLE: FINDING\ntitle: T${i}\npriority: P2\nevidence: ${shot}\ndetail: d${i}`).join("\n");
    check("fable: max option caps insertion", parseFableFindings(three, { exists: () => true, max: 2 }).length === 2);
    check("fable: default budget cap is the module constant", parseFableFindings(three, { exists: () => true, max: FABLE_MAX_FINDINGS }).length === 3 && FABLE_MAX_FINDINGS === 10);

    const fableFinding: FableFinding = { title: "Tighten pairing errors", priority: "P1", area: "ui", shot, where: "PairingView.tsx:42", detail: "Calm the error state." };
    check("fable: spec carries priority, evidence and where", fableSpec(fableFinding).includes("(priority: P1, evidence: " + shot + ", where: PairingView.tsx:42)") && fableSpec(fableFinding).endsWith("(area: ui)"));

    // landing: [fable][<priority>] lines as P3 refill candidates
    const backlogDir = mkdtempSync(join(tmpdir(), "pilot-fable-land-"));
    try {
      writeFileSync(join(backlogDir, "BACKLOG.md"), "# B\n\n## Ready\n\n## Done\n");
      let prCreated = false;
      let prMerged = false;
      const landed = await commitAndPushFableFindings(backlogDir, [fableFinding], "pilot(fable): test run", {
        exec: (cmd) => {
          if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
          if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${"f".repeat(40)}\n` };
          if (cmd.startsWith("gh ") && cmd.includes("pr view"))
            return prCreated
              ? { ok: true, output: JSON.stringify({ state: prMerged ? "MERGED" : "OPEN", headRefOid: "f".repeat(40) }) }
              : { ok: false, output: "no pull requests" };
          if (cmd.startsWith("gh ") && cmd.includes("pr create")) {
            prCreated = true;
            return { ok: true, output: "" };
          }
          if (cmd.startsWith("gh ") && cmd.includes("pr merge")) {
            prMerged = true;
            return { ok: true, output: "" };
          }
          return { ok: true, output: "" };
        },
        sleep: async () => {},
      });
      const backlog = readFileSync(join(backlogDir, "BACKLOG.md"), "utf8");
      check("fable landing: reports pushed when the meta PR merges", landed === true);
      check("fable landing: improvement lands as a [fable][P1] P3 backlog line", /\(P3-\d+\) \[P3\] \[fable\]\[P1\] Tighten pairing errors/.test(backlog));
      check("fable landing: spec keeps priority + evidence + where", backlog.includes("(priority: P1, evidence: ") && backlog.includes("where: PairingView.tsx:42"));
    } finally {
      rmSync(backlogDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // journey shot set: stable names, six steps, prompt + fable contract
  check("fable: journey set has exactly the six mandated steps", JOURNEY_STEPS.length === 6 && JOURNEY_STEPS[0] === "first-boot" && JOURNEY_STEPS[5] === "mission-control");
  check("fable: journey shot names are stable and digits-only dated", journeyShotName("pairing", "2026-09-03") === "journey-pairing-20260903.png");
  const prompt = explorerPrompt("/abs/shots", "explorer-fresh-20260903", "2026-09-03");
  const journeyPaths = JOURNEY_STEPS.map((s) => journeyShotName(s, "2026-09-03"));
  check("fable: explorer prompt lists every journey shot with its stable name", journeyPaths.every((n) => prompt.includes(n)));
  check("fable: explorer prompt mandates the exact-name shot set", prompt.includes("EXACTLY as listed in the SESSION PARAMETERS") && prompt.includes("a missing file is not"));
  const fable = fablePrompt(journeyPaths.map((n) => `/abs/shots/${n}`));
  check("fable: fable prompt cites every journey shot path", journeyPaths.every((n) => fable.includes(`/abs/shots/${n}`)));
  check("fable: fable prompt demands PRODUCT.md grounding and verified file:line", fable.includes("docs/PRODUCT.md") && fable.includes("never an invented line number"));
  check("fable: fable prompt keeps the structured output contract", fable.includes("FABLE: FINDING") && fable.trimEnd().endsWith(`Your LAST line of output must be exactly: ${FABLE_MARKER}`));
  check("fable: tier-B budget keeps the review bounded", FABLE_MAX_FINDINGS === 10 && FABLE_MARKER === "FABLE: DONE");
}


// --- P2-105: tier-B dispatch mounts the journey shots dir --------------------------
check(
  "p2-105 claudeArgs mounts extra evidence dirs after the workspace",
  JSON.stringify(claudeArgs("opus", "/w", ["/shots"])) ===
    JSON.stringify(["-p", "--model", "opus", "--add-dir", "/w", "--add-dir", "/shots", "--permission-mode", "acceptEdits"]) &&
    JSON.stringify(claudeArgs("opus", "/w")) === JSON.stringify(["-p", "--model", "opus", "--add-dir", "/w", "--permission-mode", "acceptEdits"]),
);


// --- P1-095 nightly pass: idle-window trigger + skipped event ---------------------
{
  // nightlyIdleDue: undefined (fresh/legacy state) = idle since forever → due
  const now = 10_000_000_000;
  check("nightlyIdleDue: undefined lastCycleAt → due immediately", nightlyIdleDue(undefined, now) === true);
  check("nightlyIdleDue: just cycled → not due", nightlyIdleDue(now - 60_000, now) === false);
  check("nightlyIdleDue: 1h59m idle → not due", nightlyIdleDue(now - (NIGHTLY_IDLE_MS - 60_000), now) === false);
  check("nightlyIdleDue: 2h01m idle → due", nightlyIdleDue(now - (NIGHTLY_IDLE_MS + 60_000), now) === true);
  check("nightlyIdleDue: exactly 2h → due", nightlyIdleDue(now - NIGHTLY_IDLE_MS, now) === true);

  // nightlySkipDue matrix — reason only when busy + window over + pass pending
  const yesterday = "2026-01-01";
  const today = "2026-01-02";
  check("nightlySkipDue: busy inside the 03:xx window (hour 3) → null", nightlySkipDue({ redteamLast: yesterday, explorerLast: yesterday }, today, 3, true) === null);
  const busyReason = nightlySkipDue({ redteamLast: yesterday, explorerLast: yesterday }, today, 4, true);
  check("nightlySkipDue: busy at hour 4 with pass pending → reason", typeof busyReason === "string" && busyReason.length > 0);
  check("nightlySkipDue: already recorded today → null", nightlySkipDue({ redteamLast: yesterday, nightlySkipped: { date: today, reason: "x" } }, today, 4, true) === null);
  check("nightlySkipDue: pass already ran today → null", nightlySkipDue({ redteamLast: today, explorerLast: today }, today, 4, true) === null);
  check("nightlySkipDue: slots idle → null", nightlySkipDue({ redteamLast: yesterday, explorerLast: yesterday }, today, 4, false) === null);

  // recordCycle stamps the idle-window trigger with the injected now
  const rc = { date: today, tasks: 0, deploys: 0, failures: 0, merges: 0, taskAttempts: {} } as PilotState;
  recordCycle(rc, true, undefined, 12345);
  check("recordCycle: stamps lastCycleAt with the injected now", rc.lastCycleAt === 12345);
  recordCycle(rc, false, "P9-999", 23456);
  check("recordCycle: merit-fail refreshes lastCycleAt too", rc.lastCycleAt === 23456);

  // simulated busy day (state fixtures): slots busy + pass pending + hour 4 →
  // nightlySkipped recorded and the event line for events.jsonl is well-formed
  const dir = mkdtempSync(join(tmpdir(), "pilot-nightly-"));
  try {
    const file = join(dir, "state.json");
    writeFileSync(
      file,
      JSON.stringify({
        date: today,
        tasks: 1,
        deploys: 0,
        failures: 0,
        taskAttempts: {},
        redteamLast: yesterday,
        explorerLast: yesterday,
      }),
    );
    const busyState = loadState(file);
    const reason = nightlySkipDue(busyState, today, 4, true);
    check("busy day: skip due fires for a pending pass", typeof reason === "string");
    if (reason) {
      busyState.nightlySkipped = { date: today, reason };
      saveState(busyState, file);
      // the call site emits exactly this payload — verify it serializes with
      // the fields Mission Control keys on ("task":"nightly","phase":"skipped")
      const line = JSON.stringify({ ts: "t", type: "phase", task: "nightly", phase: "skipped", ok: false, detail: reason });
      check("busy day: event line carries task=nightly phase=skipped", line.includes('"task":"nightly"') && line.includes('"phase":"skipped"') && line.includes('"ok":false'));
    }
    const reloaded = loadState(file);
    check("busy day: nightlySkipped round-trips through state.json", reloaded.nightlySkipped?.date === today && reloaded.nightlySkipped.reason === reason);

    // legacy/garbage tolerance: non-numeric lastCycleAt → undefined (due),
    // garbage nightlySkipped → null
    writeFileSync(file, JSON.stringify({ date: today, tasks: 0, deploys: 0, failures: 0, taskAttempts: {}, lastCycleAt: "garbage", nightlySkipped: "garbage" }));
    const legacy = loadState(file);
    check("loadState: garbage nightly fields tolerated", legacy.lastCycleAt === undefined && legacy.nightlySkipped === null);

    // rollover: both fields survive midnight
    writeFileSync(
      file,
      JSON.stringify({
        date: "2026-01-01",
        tasks: 1,
        deploys: 0,
        failures: 0,
        taskAttempts: {},
        lastCycleAt: 777,
        nightlySkipped: { date: "2026-01-01", reason: "slots busy past the nightly window" },
      }),
    );
    const rolled = loadState(file);
    check("loadState: lastCycleAt survives midnight", rolled.lastCycleAt === 777);
    check("loadState: nightlySkipped survives midnight", rolled.nightlySkipped?.date === "2026-01-01" && rolled.nightlySkipped.reason === "slots busy past the nightly window");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // simulated idle day (pure-guard level): lastCycleAt 2h+ old and explorer
  // not stamped → maybeNightly would proceed past both guards
  const idleState = { redteamLast: today, explorerLast: undefined, lastCycleAt: now - (NIGHTLY_IDLE_MS + 60_000) };
  check("idle day: idle-window trigger fires", nightlyIdleDue(idleState.lastCycleAt, now) === true);
  check("idle day: pass not done (explorerLast unset) → guards pass", !(idleState.redteamLast === today && idleState.explorerLast === today));
  check("idle day: slots idle → no skip record", nightlySkipDue(idleState, today, 4, false) === null);
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


// escalation table (P1-059, trigger replaced by P1-103): repeated findings
// between rounds with a rejection ⇒ true; all-dropped (P1-073) ⇒ true in any
// round; plain divergence or repetition with both approvals ⇒ false
check("p1-073 needsEscalation: all-dropped escalates in any round", needsEscalation(false, false, true, false, false) && needsEscalation(true, true, false, true, false));

check("p1-103 needsEscalation: repeated findings with a rejection escalate", needsEscalation(true, false, false, false, true) && needsEscalation(false, true, false, false, true));

check("p1-103 needsEscalation: repetition with both approvals does not escalate", !needsEscalation(true, true, false, false, true));

check("p1-103 needsEscalation: no repetition, no escalation", !needsEscalation(true, false, false, false, false) && !needsEscalation(false, true, false, false, false));


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


// --- P2-118: connection screens resolve to ONE locale ---------------------------
// The daemon-down banner, its recovery button and the neighboring pairing /
// scanner copy must all come from the same dictionary, per app locale — the
// explorer nightly caught a screen mixing a pt-BR banner with English actions.
{
  const connKeys = [
    "daemonDown", "reconnectNow", "reconnecting", "daemonMismatch",
    "localConnecting", "connecting", "pairBtn", "invalidCode", "retry",
    "pairIntro", "scanQr", "orPaste",
    "pairRemoteTitle", "pairRemoteHint", "pairRemoteAction",
    "scanPairingTitle", "scanPointCamera", "scanBackManual",
    "camDenied", "camNotFound", "camBusy", "camInterrupted", "camUnavailable",
    "homeGreeting", "homeGreetingAnon", "homePlaceholder", "homeIdeasTitle", "homeStartError",
  ];
  const resolved = (lang: "en" | "pt") => connKeys.map((k) => translate(lang, k));
  check(
    "i18n conn: every connection-screen key resolves per locale (no raw-key fallback)",
    (["en", "pt"] as const).every((lang) => resolved(lang).every((s, i) => s !== connKeys[i] && s.trim() !== "")),
  );
  // pt-BR: banner + actions must read Portuguese on the connection screen.
  check(
    "i18n conn pt: banner, recovery action and scanner copy are pt-BR",
    translate("pt", "daemonDown").includes("Daemon local caiu") &&
      translate("pt", "reconnectNow") === "Reconectar agora" &&
      translate("pt", "scanPairingTitle").includes("Escanear") &&
      translate("pt", "scanPointCamera").includes("câmera") &&
      translate("pt", "homePlaceholder").includes("Como posso ajudar"),
  );
  // en: same screen, English copy — no pt leakage.
  check(
    "i18n conn en: banner, recovery action and scanner copy are English",
    translate("en", "daemonDown").includes("Local daemon is down") &&
      translate("en", "reconnectNow") === "Reconnect now" &&
      translate("en", "scanPairingTitle") === "Scan pairing code" &&
      translate("en", "homePlaceholder") === "How can I help you today?",
  );
  // homeGreeting interpolates the machine name the same way in both locales.
  check(
    "i18n conn: homeGreeting interpolates {name} in both locales",
    translate("en", "homeGreeting", { name: "foo" }) === "Back in action, foo" &&
      translate("pt", "homeGreeting", { name: "foo" }) === "De volta à ação, foo",
  );
  // The old hardcoded strings must be gone from the sources that render the
  // banner-adjacent screens (regression guard against reintroducing the mix).
  const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
  const appSrc = src("apps/web/src/App.tsx");
  const qrSrc = src("apps/web/src/components/QrScanner.tsx");
  check(
    "i18n conn: no hardcoded pt copy in the desktop empty state",
    !appSrc.includes("Selecione uma conversa") && !appSrc.includes(">olá"),
  );
  check(
    "i18n conn: no hardcoded en copy in the QR scanner",
    !qrSrc.includes("Scan pairing code") &&
      !qrSrc.includes("Back to manual pairing") &&
      !qrSrc.includes("Point the camera") &&
      !qrSrc.includes("Camera permission denied"),
  );
}


// --- P2-112: first-boot degraded journey decision (pure logic) ------------------
{
  check(
    "degraded: never-seen daemon down is a first contact, not an incident",
    degradedKind({ daemonDown: true }, false) === "first-contact",
  );
  check(
    "degraded: daemon down after a healthy poll is the incident state",
    degradedKind({ daemonDown: true }, true) === "down",
  );
  check(
    "degraded: reconnecting wins regardless of the seen marker (watchdog never gives up)",
    degradedKind({ reconnecting: true, daemonDown: true }, false) === "reconnecting" &&
      degradedKind({ reconnecting: true }, true) === "reconnecting",
  );
  check("degraded: no shell state → no degraded journey", degradedKind(null, false) === "none" && degradedKind(null, true) === "none");
  check(
    "degraded: healthy poll (mode=local) stamps the seen marker",
    sawHealthyDaemon({ mode: "local" }) === true &&
      sawHealthyDaemon({ daemonVersion: "0.2.0" }) === true &&
      sawHealthyDaemon({ versionMismatch: true, daemonVersion: "0.0.1-force" }) === true,
  );
  check(
    "degraded: outage states never stamp the seen marker",
    sawHealthyDaemon({ daemonDown: true }) === false &&
      sawHealthyDaemon({ reconnecting: true, reconnectAttempts: 3 }) === false &&
      sawHealthyDaemon(null) === false,
  );
  // Copy parity for the journey: every degraded title/hint key resolves in
  // both locales (same contract as the P2-118 connection screens).
  const degradedKeys = [
    "firstContactTitle", "firstContactHint", "degradedRetrying", "degradedDownHint",
    "degradedLocalTitle", "degradedLocalHint", "degradedPairManually",
    "reconnectTrying", "reconnectStarted", "reconnectFailed",
  ];
  check(
    "degraded: journey copy resolves per locale (no raw-key fallback)",
    (["en", "pt"] as const).every((lang) => degradedKeys.every((k) => {
      const s = translate(lang, k);
      return s !== k && s.trim() !== "";
    })),
  );
}


// --- P2-232: machine-state readiness rows (pure module) -------------------------
{
  // The daemon's own phrases, exactly as /api/health and /__ocr/settings serve
  // them (no paths, no URL schemes — that contract is asserted below too).
  const PHRASES = {
    relayReason: "O endereço do relay não passou na validação desta máquina.",
    versionTooOld: "O opencode instalado nesta máquina é mais antigo do que este app espera.",
    diskOk: "Espaço em disco suficiente nesta máquina.",
    diskLow: "O disco desta máquina está ficando sem espaço.",
    diskCritical: "O disco desta máquina está quase cheio.",
    docsComplete: "Esta máquina converte documentos com fidelidade completa.",
  };
  const FULL = {
    relay: { ok: false, reason: PHRASES.relayReason },
    opencode: {
      binaryFound: true,
      binarySource: "path",
      versionState: "too-old",
      versionMessage: PHRASES.versionTooOld,
    },
    diskState: "ok",
    diskMessage: PHRASES.diskOk,
    docConvertState: "complete",
    docConvertMessage: PHRASES.docsComplete,
  };

  // Empty / null / non-object payloads → empty list, never a throw.
  check(
    "machinestate: empty, null, undefined and non-object payloads yield an empty list",
    readinessRows({}).length === 0 &&
      readinessRows(null).length === 0 &&
      readinessRows(undefined).length === 0 &&
      readinessRows("junk").length === 0 &&
      readinessRows([1, 2, 3]).length === 0,
  );
  check(
    "machinestate: a malformed payload yields an empty list without throwing",
    (() => {
      try {
        return (
          readinessRows({ diskState: 42, relay: "x", opencode: 7, docConvertState: true }).length === 0 &&
          readinessRows({ relay: { ok: null, reason: 9 } }).length === 0
        );
      } catch {
        return false;
      }
    })(),
  );

  // Partial payload → only the known rows.
  const partial = readinessRows({ diskState: "low", diskMessage: PHRASES.diskLow });
  check(
    "machinestate: a partial payload renders only the known row with the daemon's verbatim phrase",
    partial.length === 1 &&
      partial[0].key === "disk" &&
      partial[0].severity === "attention" &&
      partial[0].message === PHRASES.diskLow &&
      partial[0].labelKey === "machineLabelDisk",
  );

  // The three severities, each with the correct marker class.
  const all = readinessRows(FULL);
  const byKey = new Map(all.map((r) => [r.key, r]));
  check(
    "machinestate: all three severity levels appear with the correct marker",
    byKey.get("relay")?.severity === "unavailable" &&
      MACHINE_SEVERITY_DOT[byKey.get("relay")!.severity] === "err" &&
      byKey.get("version")?.severity === "attention" &&
      MACHINE_SEVERITY_DOT[byKey.get("version")!.severity] === "wait" &&
      byKey.get("disk")?.severity === "ok" &&
      MACHINE_SEVERITY_DOT[byKey.get("disk")!.severity] === "ok" &&
      byKey.get("docs")?.severity === "ok" &&
      byKey.get("agent")?.severity === "ok",
  );
  check(
    "machinestate: the daemon's phrases ride verbatim (never rewritten)",
    byKey.get("relay")?.message === PHRASES.relayReason &&
      byKey.get("version")?.message === PHRASES.versionTooOld &&
      byKey.get("disk")?.message === PHRASES.diskOk,
  );

  // Ordering: unavailable before attention before ok.
  const ordered = readinessRows({
    ...FULL,
    diskState: "critical",
    diskMessage: PHRASES.diskCritical,
    docConvertState: "complete",
  });
  check(
    "machinestate: ordering puts unavailable before attention and attention before ok",
    ordered.map((r) => r.key).join(",") === "relay,disk,version,agent,docs" &&
      ordered[0].severity === "unavailable" &&
      ordered[1].severity === "unavailable" &&
      ordered[2].key === "version" &&
      ordered[2].severity === "attention" &&
      ordered[3].severity === "ok",
  );

  // Tie-break: same severity keeps the fixed, documented key order — and the
  // result is stable across two calls with the same input.
  const tie = readinessRows({
    opencode: { binaryFound: true, versionState: "ok", versionMessage: PHRASES.diskOk },
    diskState: "ok",
    diskMessage: PHRASES.diskOk,
  });
  const tieKeys = tie.map((r) => r.key);
  const fixedOrder = MACHINE_ROW_ORDER.filter((k) => tieKeys.includes(k));
  check(
    "machinestate: same-severity ties follow the fixed key order",
    JSON.stringify(tieKeys) === JSON.stringify(fixedOrder) &&
      JSON.stringify(tie) === JSON.stringify(readinessRows({
        opencode: { binaryFound: true, versionState: "ok", versionMessage: PHRASES.diskOk },
        diskState: "ok",
        diskMessage: PHRASES.diskOk,
      })),
  );

  // Wrong-typed fields are ignored, never turned into invented rows.
  const wrongTyped = readinessRows({
    diskState: 123,
    relay: { ok: "yes", reason: PHRASES.relayReason },
    opencode: { binaryFound: "yes", versionState: 7 },
    docConvertState: "complete",
    docConvertMessage: 5,
  });
  check(
    "machinestate: wrong-typed fields are ignored without becoming rows",
    wrongTyped.length === 1 &&
      wrongTyped[0].key === "docs" &&
      wrongTyped[0].message === "",
  );

  // Unknown verdicts stay silent (neutral, never accusatory — P2-213/P2-215).
  check(
    "machinestate: unknown verdicts yield no row",
    readinessRows({ diskState: "unknown", diskMessage: PHRASES.diskOk }).length === 0 &&
      readinessRows({ opencode: { versionState: "unknown", versionMessage: PHRASES.diskOk } }).length === 0,
  );

  // No absolute path and no URL scheme in any returned phrase.
  const everyMessage = (rows: MachineReadinessRow[]) => rows.map((r) => r.message);
  const allMessages = [
    ...everyMessage(all),
    ...everyMessage(partial),
    ...everyMessage(ordered),
    PHRASES.relayReason,
    PHRASES.versionTooOld,
  ];
  check(
    "machinestate: no returned phrase contains an absolute path or a URL scheme",
    allMessages.every((m) => !m.includes("://") && !m.startsWith("/") && !m.startsWith("\\\\") && !/^[A-Za-z]:\\/.test(m)),
  );

  // summarize: empty → calm documented state; worst severity wins the header.
  check(
    "machinestate: summarize over an empty list is the calm state",
    summarize([]).severity === "ok" &&
      summarize([]).titleKey === "machineStateEmpty" &&
      summarize(null).titleKey === "machineStateEmpty",
  );
  const okRows = readinessRows({ diskState: "ok", diskMessage: PHRASES.diskOk });
  const attentionRows = readinessRows({ opencode: { versionState: "too-old", versionMessage: PHRASES.versionTooOld } });
  const unavailableRows = readinessRows({ diskState: "critical", diskMessage: PHRASES.diskCritical });
  check(
    "machinestate: summarize picks the worst severity with one short header key",
    summarize(okRows).titleKey === "machineStateAllOkTitle" &&
      summarize(okRows).severity === "ok" &&
      summarize(attentionRows).titleKey === "machineStateAttentionTitle" &&
      summarize(attentionRows).severity === "attention" &&
      summarize(unavailableRows).titleKey === "machineStateUnavailableTitle" &&
      summarize(unavailableRows).severity === "unavailable",
  );
  check(
    "machinestate: summarize over a mixed list picks unavailable over attention",
    summarize(all).severity === "unavailable",
  );

  // Labels resolve in both locales (P2-118: one locale per screen, no raw keys).
  const machineKeys = [
    "machineStateTitle",
    "machineStateEmpty",
    "machineStateAllOkTitle",
    "machineStateAttentionTitle",
    "machineStateUnavailableTitle",
    "machineLabelRelay",
    "machineLabelAgent",
    "machineLabelVersion",
    "machineLabelDisk",
    "machineLabelDocs",
  ];
  check(
    "machinestate: labels and empty state resolve per locale (no raw-key fallback)",
    (["en", "pt"] as const).every((lang) =>
      machineKeys.every((k) => {
        const s = translate(lang, k);
        return s !== k && s.trim() !== "";
      }),
    ),
  );
  check(
    "machinestate: every row's labelKey resolves in the pt dictionary",
    all.every((r) => {
      const s = translate("pt", r.labelKey);
      return s !== r.labelKey && s.trim() !== "";
    }),
  );

  // Real-repo assertion: the Settings section consumes the pure module and the
  // module stays pure (no React import, no fetch) with no new health fields.
  const machineStateSrc = readFileSync(new URL("../apps/web/src/lib/machinestate.ts", import.meta.url), "utf8");
  const settingsViewSrc = readFileSync(new URL("../apps/web/src/components/SettingsView.tsx", import.meta.url), "utf8");
  const daemonIndexSrc = readFileSync(new URL("../apps/daemon/src/index.ts", import.meta.url), "utf8");
  check(
    "P2-232: SettingsView renders the machine-state section from readinessRows + summarize",
    settingsViewSrc.includes("readinessRows(") &&
      settingsViewSrc.includes("summarize(") &&
      settingsViewSrc.includes('className="card machine-state"'),
  );
  check(
    "P2-232: machinestate stays pure — no React, no fetch, no I/O imports",
    !machineStateSrc.includes("from \"react\"") &&
      !machineStateSrc.includes("fetch(") &&
      !machineStateSrc.includes("node:"),
  );
  check(
    "P2-232: the daemon payload is untouched (no new health fields, apps/daemon unchanged)",
    daemonIndexSrc.includes("docConvertState: docConvert.state") &&
      !daemonIndexSrc.includes("machineLabel") &&
      (daemonIndexSrc.match(/machinestate/g) || []).length === 0,
  );
}


// --- P2-148: first-run welcome flag (pure decision) -----------------------------
{
  // Corrupted/partial writes must never count as "done" — a wiped-looking
  // flag shows the onboarding again rather than silently skipping it.
  const CORRUPT = ["", "0", "true", " 1 ", "{}"];
  check(
    "welcome: absent flag + no pairing shows the onboarding",
    shouldShowWelcome(null, false) === true && shouldShowWelcome(undefined, false) === true,
  );
  check(
    "welcome: the done flag suppresses it even with no pairing",
    shouldShowWelcome(WELCOME_DONE, false) === false && shouldShowWelcome("1", false) === false,
  );
  check(
    "welcome: an existing pairing never shows the onboarding (upgraders)",
    shouldShowWelcome(null, true) === false && shouldShowWelcome(WELCOME_DONE, true) === false,
  );
  check(
    "welcome: corrupted flag values count as absent",
    CORRUPT.every((v) => shouldShowWelcome(v, false) === true) &&
      CORRUPT.every((v) => shouldShowWelcome(v, true) === false),
  );
  const welcomeKeys = [
    "welcomeStepOf", "welcomeStep1Title", "welcomeStep1Body", "welcomeStart",
    "welcomeSkip", "welcomeNext", "welcomeStep2Title", "welcomeAgentOk",
    "welcomeStep3Title", "welcomeStep3Body", "welcomeLater",
    "welcomeDone", "welcomePairedTitle", "welcomePairedHint", "welcomeQrWait",
  ];
  check(
    "welcome: onboarding copy resolves per locale (no raw-key fallback)",
    (["en", "pt"] as const).every((lang) => welcomeKeys.every((k) => {
      const s = translate(lang, k);
      return s !== k && s.trim() !== "";
    })),
  );
}


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


// --- P2-113 dollar telemetry: BYOK list-price table -----------------------------
{
  // the table itself is pinned: tier + every price constant + cited source
  check("pricing: GLM-5.2 is tier A with Z.ai list prices", PRICE_TABLE["glm-5.2"]?.tier === "A" && PRICE_TABLE["glm-5.2"]?.usdPerMTok.input === 1.4 && PRICE_TABLE["glm-5.2"]?.usdPerMTok.output === 4.4 && PRICE_TABLE["glm-5.2"]?.usdPerMTok.cacheRead === 0.26 && PRICE_TABLE["glm-5.2"]?.usdPerMTok.cacheWrite === 0);
  check("pricing: Sonnet 4.6 is tier B with Anthropic list prices", PRICE_TABLE["claude-sonnet-4-6"]?.tier === "B" && PRICE_TABLE["claude-sonnet-4-6"]?.usdPerMTok.input === 3 && PRICE_TABLE["claude-sonnet-4-6"]?.usdPerMTok.output === 15 && PRICE_TABLE["claude-sonnet-4-6"]?.usdPerMTok.cacheRead === 0.3 && PRICE_TABLE["claude-sonnet-4-6"]?.usdPerMTok.cacheWrite === 3.75);
  check("pricing: sources are cited with an as-of date", PRICE_SOURCES.zai.url.includes("z.ai") && PRICE_SOURCES.anthropic.url.includes("claude") && /^\d{4}-\d{2}-\d{2}$/.test(PRICE_SOURCES.zai.asOf) && PRICE_SOURCES.zai.asOf === PRICE_SOURCES.anthropic.asOf);

  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const glm = taskCostUSD({ "glm-5.2": { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 } });
  check("pricing: GLM 1M+1M+1M = $6.06 all tier A", close(glm.total, 6.06) && close(glm.tierA, 6.06) && glm.tierB === 0 && glm.tokens === 3e6);
  const sonnet = taskCostUSD({ "claude-sonnet-4-6": { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 } });
  check("pricing: Sonnet 1M of each = $22.05 all tier B", close(sonnet.total, 22.05) && close(sonnet.tierB, 22.05) && sonnet.tierA === 0);
  const mixed = taskCostUSD({ "glm-5.2": { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }, "mystery-model": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
  check("pricing: unpriced models are counted, never converted to $0", close(mixed.total, 2 * 1.4 / 1e6) && close(mixed.tierA, 2 * 1.4 / 1e6) && mixed.unpricedTokens === 2 && mixed.tokens === 4);
  check("pricing: empty breakdown prices to zero", taskCostUSD({}).total === 0 && taskCostUSD({}).tokens === 0);

  check("pricing: model column json blob normalizes to the id", normalizeSessionModel('{"id":"glm-5.2","providerID":"glm52","variant":"default"}') === "glm-5.2");
  check("pricing: legacy plain-string model normalizes too", normalizeSessionModel("glm-5.2") === "glm-5.2");
  check("pricing: missing/garbage model → unknown", normalizeSessionModel(null) === "unknown" && normalizeSessionModel("") === "unknown" && normalizeSessionModel("{oops") === "{oops");

  // the reconciler folds the dollar view alongside taskCosts/taskCache
  const row = (model: string | undefined) => ({ id: "ses_usd000001", tokens_input: 1000, tokens_output: 100, tokens_cache_read: 20, tokens_cache_write: 5, model });
  const store: { taskCosts: Record<string, number>; taskCostSessions: Record<string, string[]> } = { taskCosts: {}, taskCostSessions: {} };
  await applySessionCosts(store, "P2-113", ["ses_usd000001"], async () => ({ ses_usd000001: row('{"id":"glm-5.2","providerID":"glm52"}') }));
  const usd = (store as unknown as { taskUSD?: Record<string, { total: number; tierA: number; tierB: number; unpricedTokens: number; tokens: number }> }).taskUSD?.["P2-113"];
  // (1000×1.4 + 100×4.4 + 20×0.26 + 5×0)/1e6 = 1845.2/1e6
  check("pricing: reconciler folds tier-A usd from the model column", !!usd && close(usd.total, 0.0018452) && usd.tierA === usd.total && usd.tierB === 0 && usd.tokens === 1125);
  const legacy: { taskCosts: Record<string, number>; taskCostSessions: Record<string, string[]> } = { taskCosts: {}, taskCostSessions: {} };
  await applySessionCosts(legacy, "P2-113b", ["ses_usd000002"], async () => ({ ses_usd000002: 500 }));
  const legacyUsd = (legacy as unknown as { taskUSD?: Record<string, { unpricedTokens: number; tokens: number }> }).taskUSD?.["P2-113b"];
  check("pricing: legacy totals-only fold counts tokens as unpriced", !!legacyUsd && legacyUsd.total === 0 && legacyUsd.unpricedTokens === 500 && legacyUsd.tokens === 500);

  // round 2 review: session.model text is arbitrary — "__proto__" style keys
  // must stay own-key/hasOwn-safe (no built-in pollution, no NaN pricing)
  const sneaky: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = Object.create(null);
  sneaky["__proto__"] = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
  sneaky["constructor"] = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 };
  const guarded = taskCostUSD(sneaky);
  check("pricing: __proto__/constructor keys price as unpriced, never NaN", guarded.total === 0 && guarded.unpricedTokens === 2 && guarded.tokens === 2 && Number.isFinite(guarded.total));
  const pstore: { taskCosts: Record<string, number>; taskCostSessions: Record<string, string[]> } = { taskCosts: {}, taskCostSessions: {} };
  await applySessionCosts(pstore, "P2-113c", ["ses_usd000003"], async () => ({ ses_usd000003: { id: "ses_usd000003", tokens_input: 10, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0, model: "__proto__" } }));
  const pUsd = (pstore as unknown as { taskUSD?: Record<string, { total: number; unpricedTokens: number; tokens: number }> }).taskUSD?.["P2-113c"];
  check("pricing: __proto__ model cannot pollute Object.prototype or drop tokens", (Object.prototype as unknown as Record<string, unknown>).input === undefined && !!pUsd && pUsd.total === 0 && pUsd.unpricedTokens === 10 && pUsd.tokens === 10);
  check("pricing: __proto__ passes through normalization as an inert key", normalizeSessionModel("__proto__") === "__proto__");
  // REPLACE-by-recompute: re-folding replaces the dollar view too
  await applySessionCosts(store, "P2-113", ["ses_usd000001"], async () => ({ ses_usd000001: row("mystery-model") }));
  const refolded = (store as unknown as { taskUSD?: Record<string, { total: number; unpricedTokens: number }> }).taskUSD?.["P2-113"];
  check("pricing: re-fold replaces instead of double counting", store.taskCosts["P2-113"] === 1125 && !!refolded && refolded.total === 0 && refolded.unpricedTokens === 1125);
}


// --- P1-077 cache-aware prompt assembly: per-task cache metrics -----------------
{
  const row = (input: number, read: number, write: number, output = 0) => ({
    id: "ses_cache0001",
    tokens_input: input,
    tokens_output: output,
    tokens_cache_read: read,
    tokens_cache_write: write,
  });
  const rowsJson = (r: { id: string; tokens_input: number; tokens_output: number; tokens_cache_read: number; tokens_cache_write: number }) => JSON.stringify([r]);
  check("cache: rows parser keeps canonical ids and 4-way breakdown", parseSessionTokenRows(rowsJson(row(900, 300, 100, 50))).ses_cache0001.tokens_cache_read === 300);
  check("cache: rows parser survives garbage", Object.keys(parseSessionTokenRows("not json")).length === 0);
  const viaRows = await querySessionTokenRows(["ses_cache0001"], "/tmp/fake.db", async () => rowsJson(row(900, 300, 100, 50)));
  check("cache: rows query maps session → breakdown", viaRows.ses_cache0001.tokens_input === 900 && viaRows.ses_cache0001.tokens_cache_write === 100);
  const viaTotals = await querySessionTokens(["ses_cache0001"], "/tmp/fake.db", async () => rowsJson(row(900, 300, 100, 50)));
  check("cache: totals view still sums all four kinds", viaTotals.ses_cache0001 === 1350);

  const store: { taskCosts: Record<string, number>; taskCostSessions: Record<string, string[]>; taskCache?: Record<string, { input: number; cacheRead: number; cacheWrite: number }> } = { taskCosts: {}, taskCostSessions: {} };
  const fold = await applySessionCosts(store, "P1-077", ["ses_cache0001"], async () => ({ ses_cache0001: row(900, 300, 100, 50) }));
  check("cache: breakdown folded into taskCache", JSON.stringify(store.taskCache?.["P1-077"]) === JSON.stringify({ input: 900, cacheRead: 300, cacheWrite: 100 }));
  check("cache: totals path unchanged by the fold", store.taskCosts["P1-077"] === 1350);
  check("cache: fold returns the log payload with the hit ratio", fold?.input === 900 && fold.cacheRead === 300 && fold.cacheWrite === 100 && fold.ratio === 300 / 1200 && fold.task === "P1-077");
  // REPLACE-by-recompute: a resumed session grows — re-folding replaces, never accumulates
  await applySessionCosts(store, "P1-077", ["ses_cache0001"], async () => ({ ses_cache0001: row(1200, 600, 200, 60) }));
  check("cache: re-fold replaces instead of double counting", store.taskCache?.["P1-077"].cacheRead === 600 && store.taskCosts["P1-077"] === 2060);
  // failed DB read keeps the previous breakdown honest
  await applySessionCosts(store, "P1-077", ["ses_gone000001"], async () => ({}));
  check("cache: failed DB read keeps the previous fold", store.taskCache?.["P1-077"].cacheRead === 600);

  check("cache: ratio helper", cacheHitRatio(300, 900) === 0.25 && cacheHitRatio(0, 0) === 0 && cacheHitRatio(0, 100) === 0);

  // P1-078: per-slot fold — REPLACE by task (live window), independent entries
  // per slot, payload carries slot + the full breakdown for the log line
  const slotStore: { slotCache?: Record<number, { input: number; cacheRead: number; cacheWrite: number }> } = {};
  const foldA = { task: "P1-078", input: 900, cacheRead: 300, cacheWrite: 100, ratio: 0.25 };
  check("slot cache: fold returns the log payload with the slot", JSON.stringify(foldSlotCache(slotStore, 1, foldA)) === JSON.stringify({ slot: 1, task: "P1-078", input: 900, cacheRead: 300, cacheWrite: 100, ratio: 0.25 }));
  check("slot cache: fold writes the breakdown under the slot key", JSON.stringify(slotStore.slotCache?.[1]) === JSON.stringify({ input: 900, cacheRead: 300, cacheWrite: 100 }));
  foldSlotCache(slotStore, 1, { task: "P1-079", input: 1200, cacheRead: 600, cacheWrite: 200, ratio: 1 / 3 });
  check("slot cache: re-fold replaces instead of accumulating", JSON.stringify(slotStore.slotCache?.[1]) === JSON.stringify({ input: 1200, cacheRead: 600, cacheWrite: 200 }));
  foldSlotCache(slotStore, 2, foldA);
  check("slot cache: slots fold independently", slotStore.slotCache?.[2]?.cacheRead === 300 && slotStore.slotCache?.[1]?.cacheRead === 600);
  check("slot cache: nothing to fold → null, store untouched", foldSlotCache(slotStore, 3, null) === null && !(3 in (slotStore.slotCache ?? {})));
  check("slot cache: zero-denominator ratio stays 0", cacheHitRatio(0, 0) === 0);

  // the rolling window prunes taskCache in lockstep with taskCosts
  const big: { taskCosts: Record<string, number>; taskCostSessions: Record<string, string[]>; taskCache: Record<string, { input: number; cacheRead: number; cacheWrite: number }> } = { taskCosts: {}, taskCostSessions: {}, taskCache: {} };
  for (let i = 0; i < TASK_COST_CAP + 10; i++) {
    big.taskCosts[`P9-${i}`] = i;
    big.taskCostSessions[`P9-${i}`] = [`ses_abc${String(i).padStart(6, "0")}`];
    big.taskCache[`P9-${i}`] = { input: i, cacheRead: 0, cacheWrite: 0 };
  }
  pruneTaskCosts(big);
  check("cache: rolling window prunes taskCache in lockstep", Object.keys(big.taskCache).length === TASK_COST_CAP && !("P9-0" in big.taskCache) && "P9-209" in big.taskCache);

  // legacy state.json without the field backfills {} instead of crashing
  const legacyDir = mkdtempSync(join(tmpdir(), "ocr-legacy-state-"));
  writeFileSync(join(legacyDir, "state.json"), JSON.stringify({ tasks: 1, deploys: 0, failures: 0 }));
  const legacyState = loadState(join(legacyDir, "state.json"));
  check("cache: loadState backfills taskCache for legacy files", JSON.stringify(legacyState.taskCache) === "{}");
  check("cache: loadState backfills slotCache for legacy files (P1-078)", JSON.stringify(legacyState.slotCache) === "{}");
  rmSync(legacyDir, { recursive: true, force: true });
  // P1-078: the doctor normalization completes the same backfill
  check(
    "cache: normalizePilotState backfills slotCache",
    JSON.stringify(
      normalizePilotState({ date: "2026-09-03", tasks: 0, deploys: 0, failures: 0, merges: 0 } as unknown as PilotState).slotCache,
    ) === "{}",
  );
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
    // P2-142: legacy multi-section files warn but stay valid — the stop-loss self-normalizes
    const dupDiag = validateBacklog("## Ready\n\n## Blocked\n\n## Blocked\n\n## Blocked\n\n## Done\n");
    check(
      "doctor backlog: duplicate Blocked headers warn (self-normalizing)",
      dupDiag.ok && dupDiag.warnings.length === 1 && dupDiag.warnings[0]!.includes("3 duplicate ## Blocked sections") && dupDiag.warnings[0]!.includes("next stop-loss write"),
    );
    check("doctor backlog: single Blocked header warns nothing", validateBacklog("## Ready\n\n## Blocked\n\n## Done\n").warnings.length === 0);
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
    check("doctor state: normalizePilotState fills schema defaults", n.merges === 0 && n.tasks === 0 && n.date.length === 10 && JSON.stringify(n.taskAttempts) === "{}" && Array.isArray(n.cycles) && Array.isArray(n.blockEvents) && n.auditMode === null && JSON.stringify(n.taskCosts) === "{}" && JSON.stringify(n.taskCache) === "{}");
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


// --- P3-084: recency grouping, archive set + palette preview ------------------
{
  // fixed "now" = local noon today, so no wall-clock run-up can flip a group
  const nowD = new Date();
  nowD.setHours(12, 0, 0, 0);
  const nowMs = nowD.getTime();
  const noonAt = (dayOffset: number) =>
    new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + dayOffset, 12, 0, 0, 0).getTime();

  check("recency: noon today is today", recencyGroup(nowMs, nowMs) === "today");
  check("recency: 5 minutes ago is today", recencyGroup(nowMs - 5 * 60_000, nowMs) === "today");
  check("recency: noon yesterday is yesterday", recencyGroup(noonAt(-1), nowMs) === "yesterday");
  check("recency: 8 days ago is earlier", recencyGroup(noonAt(-8), nowMs) === "earlier");
  check("recency: unknown (0) is earlier", recencyGroup(0, nowMs) === "earlier");
  check("recency: NaN is earlier", recencyGroup(Number.NaN, nowMs) === "earlier");
  check("recency: small clock skew into the future stays today", recencyGroup(nowMs + 90_000, nowMs) === "today");

  // Reviewer pin (P3-084 round 1): the buckets are bounded by LOCAL CALENDAR
  // MIDNIGHTS, never by a fixed `now - 86_400_000` offset. The decisive case
  // is a 1 wall-clock-hour gap across midnight — epoch distance ≪ 24h, so any
  // fixed-offset "today window" files it under today; calendar fields don't.
  const earlyMorning = new Date(2026, 2, 8, 0, 30).getTime(); // Mar 8, 00:30 local
  const lateNight = new Date(2026, 2, 7, 23, 30).getTime(); // Mar 7, 23:30 local
  check("recency: 1h wall-clock gap across midnight is yesterday, not today", recencyGroup(lateNight, earlyMorning) === "yesterday");
  const startToday = startOfLocalDay(new Date(nowMs));
  const startYesterday = (() => {
    const d = new Date(startToday);
    d.setDate(d.getDate() - 1);
    return d.getTime();
  })();
  check("recency: boundary — exactly local midnight today is today", recencyGroup(startToday, nowMs) === "today");
  check("recency: boundary — 1ms before local midnight is yesterday", recencyGroup(startToday - 1, nowMs) === "yesterday");
  check("recency: boundary — exactly yesterday's local midnight is yesterday", recencyGroup(startYesterday, nowMs) === "yesterday");
  check("recency: boundary — 1ms before yesterday's midnight is earlier", recencyGroup(startYesterday - 1, nowMs) === "earlier");

  const mk = (id: string, ts: number) => ({ id, ts });
  const grouped = groupByRecency(
    (s) => s.ts,
    [mk("a", nowMs - 1_000), mk("b", nowMs - 2_000), mk("c", noonAt(-1)), mk("d", noonAt(-3)), mk("e", 0)],
    nowMs,
  );
  check(
    "recency: groupByRecency buckets and preserves recency order",
    grouped.today.map((s) => s.id).join(",") === "a,b" &&
      grouped.yesterday.map((s) => s.id).join(",") === "c" &&
      grouped.earlier.map((s) => s.id).join(",") === "d,e",
  );

  let ids = toggleArchived([], "a", true);
  ids = toggleArchived(ids, "b", true);
  check("archive: newest archived first", ids[0] === "b" && ids[1] === "a");
  ids = toggleArchived(ids, "a", true);
  check("archive: re-archiving dedupes to the front", ids.length === 2 && ids[0] === "a");
  ids = toggleArchived(ids, "a", false);
  check("archive: restore removes only the target", ids.length === 1 && ids[0] === "b");
  const capped = toggleArchived(Array.from({ length: ARCHIVED_MAX + 10 }, (_, i) => `s${i}`), "new", true);
  check("archive: archived set is capped", capped.length === ARCHIVED_MAX && capped[0] === "new");

  const previewEvents = [
    { type: "session.idle", properties: { sessionID: "s-idle" } },
    { type: "message.part.updated", properties: { sessionID: "s1", part: { text: "primeira  linha\ndupla" } } },
    { type: "message.part.updated", properties: { sessionID: "s2", part: { text: "x".repeat(200) } } },
    { type: "message.part.updated", properties: { sessionID: "s1", part: { text: "última" } } },
  ];
  const pv = previewFromEvents(previewEvents);
  check("preview: the LAST text event wins per session", pv.s1 === "última");
  check("preview: whitespace is collapsed to one line", clipPreview("primeira  linha\ndupla") === "primeira linha dupla");
  check("preview: long text clipped with an ellipsis", pv.s2.length === 90 && pv.s2.endsWith("…"));
  check("preview: sessions without text have no entry", !("s-idle" in pv));
  check("preview: clipPreview trims the edges", clipPreview("  a   b  ") === "a b");
}

// --- P2-220: iOS install hint (pure verdict + tolerant dismissal flag) --------
{
  const IOS_IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const IOS_IPAD =
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const IOS_IPAD_MAC_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const ANDROID =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
  const DESKTOP =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
  // every row that favors the hint: regular iOS tab, pairing saved, not dismissed
  const show = (over: Partial<Parameters<typeof installHintVerdict>[0]> = {}) =>
    installHintVerdict({
      userAgent: IOS_IPHONE,
      standalone: false,
      desktopShell: false,
      hasPairing: true,
      dismissed: false,
      ...over,
    });

  // full verdict table, rules in contract order
  check("p2-220: desktop shell hides even with every other condition favorable", show({ desktopShell: true }).show === false);
  check("p2-220: dismissed hides even in a regular iOS tab with a pairing", show({ dismissed: true }).show === false);
  check("p2-220: standalone (installed) hides", show({ standalone: true }).show === false);
  check("p2-220: android UA with a saved pairing hides (own install prompt + storage policy)", show({ userAgent: ANDROID }).show === false);
  check("p2-220: desktop UA hides", show({ userAgent: DESKTOP }).show === false);
  check("p2-220: iOS with no saved pairing hides (first screen stays quiet)", show({ hasPairing: false }).show === false);
  check("p2-220: iphone regular tab with pairing and no dismissal shows", show().show === true);
  check("p2-220: ipad regular tab with pairing and no dismissal shows", show({ userAgent: IOS_IPAD }).show === true);
  check("p2-220: empty UA hides", show({ userAgent: "" }).show === false);
  check("p2-220: iPadOS 13+ Mac UA is recognized only with the touch indicator", show({ userAgent: IOS_IPAD_MAC_UA, maxTouchPoints: 5 }).show === true);
  check("p2-220: Mac UA without the touch indicator stays quiet", show({ userAgent: IOS_IPAD_MAC_UA }).show === false);
  check("p2-220: Mac UA with a zero touch count stays quiet", show({ userAgent: IOS_IPAD_MAC_UA, maxTouchPoints: 0 }).show === false);

  // every generated message is the constant, clean phrase — no file path, no
  // URL scheme, no room/key/credential material
  const pathOrScheme = /[A-Za-z]:\\|\/[A-Za-z0-9_.-]+\/|:\/\//;
  const rows: Parameters<typeof installHintVerdict>[0][] = [
    { userAgent: IOS_IPHONE, standalone: false, desktopShell: false, hasPairing: true, dismissed: false },
    { userAgent: IOS_IPHONE, standalone: false, desktopShell: true, hasPairing: true, dismissed: false },
    { userAgent: IOS_IPHONE, standalone: true, desktopShell: false, hasPairing: true, dismissed: true },
    { userAgent: ANDROID, standalone: false, desktopShell: false, hasPairing: true, dismissed: false },
    { userAgent: DESKTOP, standalone: false, desktopShell: false, hasPairing: false, dismissed: true },
    { userAgent: "", standalone: false, desktopShell: false, hasPairing: false, dismissed: false },
  ];
  check(
    "p2-220: every verdict carries the same clean message",
    rows.every((r) => {
      const v = installHintVerdict(r);
      return v.message === INSTALL_HINT_MESSAGE && v.message.length > 0 && !pathOrScheme.test(v.message);
    }),
  );
  check("p2-220: dict.pt.installHintBody is exactly the module phrase", dict.pt.installHintBody === INSTALL_HINT_MESSAGE);
  check("p2-220: dict.en carries the bilingual copy", typeof dict.en.installHintBody === "string" && dict.en.installHintBody.length > 0 && !pathOrScheme.test(dict.en.installHintBody));
  check("p2-220: dismissal key is a quiet flag name (no room/key/relay)", INSTALL_HINT_DISMISSED_KEY === "ocr.installhint.dismissed");

  // dismissal flag table: absent key, wrong type or corrupted JSON → not
  // dismissed, NEVER an exception
  check("p2-220: dismissed parse — absent is false", parseInstallHintDismissed(null) === false && parseInstallHintDismissed(undefined) === false);
  check("p2-220: dismissed parse — wrong JSON type (array) is false", parseInstallHintDismissed("[]") === false);
  check("p2-220: dismissed parse — wrong JSON type (object) is false", parseInstallHintDismissed('{"a":1}') === false);
  check("p2-220: dismissed parse — corrupted JSON is false", parseInstallHintDismissed("{oops") === false);
  check("p2-220: dismissed parse — numbers/strings-of-wrong-type are false", parseInstallHintDismissed("5") === false && parseInstallHintDismissed('"true"') === false);
  check("p2-220: dismissed parse — bare true is true", parseInstallHintDismissed("true") === true);
  check("p2-220: dismissed parse — serialize/parse round-trips", parseInstallHintDismissed(serializeInstallHintDismissed()) === true);
  const serialized = serializeInstallHintDismissed();
  check("p2-220: serialized flag carries no room/key/relay/scheme", !/room|k=|relay|:\/\//.test(serialized));

  // App.tsx source pins: the environment is probed exactly once, on mount,
  // and no new listeners or timers snuck in
  const appSrc = readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8");
  const uaCount = (appSrc.match(/navigator\.userAgent/g) ?? []).length;
  const dmCount = (appSrc.match(/\(display-mode: standalone\)/g) ?? []).length;
  check("p2-220: App reads the user agent exactly once", uaCount === 1);
  check("p2-220: App reads the standalone display-mode exactly once", dmCount === 1);
  const uaAt = appSrc.indexOf("navigator.userAgent");
  const dmAt = appSrc.indexOf("(display-mode: standalone)");
  check(
    "p2-220: both probes live inside useState(() => initializers (mount-only)",
    uaAt > -1 && dmAt > -1 && appSrc.slice(Math.max(0, uaAt - 400), uaAt).includes("useState(() =>") && appSrc.slice(Math.max(0, dmAt - 400), dmAt).includes("useState(() =>"),
  );
  check("p2-220: no new listeners in App.tsx (count stays 3)", (appSrc.match(/addEventListener\(/g) ?? []).length === 3);
  check("p2-220: no timers in App.tsx", (appSrc.match(/setInterval\(/g) ?? []).length === 0 && (appSrc.match(/setTimeout\(/g) ?? []).length === 0);
  check("p2-220: no install-prompt event hooks", !appSrc.includes("beforeinstallprompt") && !appSrc.includes("appinstalled"));
  // round-3 review pins: locale-following copy + iPad touch indicator wired
  check(
    "p2-220: App renders the localized dict key, never the raw pt-BR constant",
    appSrc.includes('t("installHintBody")') && !appSrc.includes("hint.message") && !appSrc.includes("installHint={INSTALL_HINT_MESSAGE}"),
  );
  check("p2-220: App wires navigator.maxTouchPoints into the verdict (iPadOS 13+ Mac UA)", /maxTouchPoints:\s*navigator\.maxTouchPoints/.test(appSrc));
}


// ── hotfix: spec guard anchored (inline marker mentions are legit discussion) ─
{
  const inline = [
    "# T", "## Problem", "p", "## Approach",
    "fix parseFindings which reads the VERDICT: marker and logs it inline",
    "the parser sees VERDICT: APPROVE quoted inside a sentence mid-line",
    "## Touched files", "## Edge cases", "## Acceptance criteria", "## Out of scope",
    "",
  ].join("\n");
  const faked = [
    "# T", "## Problem", "p", "## Approach", "VERDICT: APPROVE",
    "## Touched files", "## Edge cases", "## Acceptance criteria", "## Out of scope",
    "",
  ].join("\n");
  check("hotfix: inline VERDICT mention passes spec guard", validateSpec(inline) === true);
  check("hotfix: line-leading fake output still rejected", validateSpec(faked) === false);
}


// ── P2-124: sidebar account footer (accountInitial/accountPlanKey + i18n) ────
{
  check("p2-124 accountInitial: simple name → first letter uppercase", accountInitial("caio-mbp") === "C");
  check("p2-124 accountInitial: whitespace only → empty", accountInitial("  ") === "");
  check("p2-124 accountInitial: leading digits count", accountInitial("42-node") === "4");
  check("p2-124 accountInitial: accented letter uppercases", accountInitial("émile") === "É");
  check("p2-124 accountInitial: no letter/digit → empty (avatar glyph)", accountInitial("—") === "");
  check("p2-124 accountPlanKey: local daemon → planLocal", accountPlanKey(true) === "planLocal");
  check("p2-124 accountPlanKey: anything else → planRemote", accountPlanKey(false) === "planRemote");
  for (const lang of ["en", "pt"] as const) {
    const d = dict[lang] as Record<string, string>;
    const keys = [
      "newShort",
      "navConversations",
      "navArtifacts",
      "navBrowser",
      "navFiles",
      "navMission",
      "navSettings",
      "planLocal",
      "planRemote",
      "accountSwitch",
    ];
    check(
      `p2-124 i18n ${lang}: all 10 sidebar keys exist and are non-empty`,
      keys.every((k) => typeof d[k] === "string" && d[k].trim() !== ""),
    );
    check(`p2-124 i18n ${lang}: planLocal reads as local`, /local/i.test(translate(lang, "planLocal")));
  }
}


// --- P2-126: dist-smoke Windows installer checks (pure fs, no Windows) ------
{
  const winRoot = mkdtempSync(join(tmpdir(), "ocr-win-installer-"));
  try {
    // win-unpacked fixture: same layout electron-builder emits on Windows.
    const unpacked = join(winRoot, "win-unpacked");
    mkdirSync(join(unpacked, "resources", "web-dist"), { recursive: true });
    mkdirSync(join(unpacked, "resources", "daemon"), { recursive: true });
    writeFileSync(join(unpacked, "OpenCode Remote.exe"), "exe");
    writeFileSync(join(unpacked, "resources", "web-dist", "index.html"), "<html>");
    writeFileSync(join(unpacked, "resources", "daemon", "index.js"), "// daemon");
    check("p2-126 win-unpacked: complete bundle passes listProblems", listProblems(unpacked).length === 0);
    rmSync(join(unpacked, "OpenCode Remote.exe"));
    check(
      "p2-126 win-unpacked: missing .exe is reported",
      listProblems(unpacked).some((p) => p.includes("no app binary")),
    );

    // dist root fixture: setup exe + latest.yml are the Windows release pair.
    const distRoot = join(winRoot, "dist");
    mkdirSync(distRoot, { recursive: true });
    check("p2-126 setup: no installer in a fresh dist root", findWindowsInstaller(distRoot) === null);
    const fresh = windowsInstallerProblems(distRoot);
    check(
      "p2-126 problems: fresh root reports setup exe and latest.yml",
      fresh.length === 2 && fresh.some((p) => p.includes("*.exe")) && fresh.some((p) => p.includes("latest.yml")),
    );
    check(
      "p2-126 problems: absent root reported clearly",
      windowsInstallerProblems(join(winRoot, "ghost")).length === 1 &&
        windowsInstallerProblems(join(winRoot, "ghost"))[0].includes("does not exist"),
    );

    writeFileSync(join(distRoot, "OpenCode Remote Setup 1.0.0.exe"), "exe");
    check(
      "p2-126 setup: finds the deterministic setup exe",
      findWindowsInstaller(distRoot) === join(distRoot, "OpenCode Remote Setup 1.0.0.exe"),
    );
    check(
      "p2-126 problems: only latest.yml missing after setup lands",
      JSON.stringify(windowsInstallerProblems(distRoot)) === JSON.stringify(["missing file: latest.yml"]),
    );
    writeFileSync(join(distRoot, "latest.yml"), "version: 1.0.0\npath: OpenCode Remote Setup 1.0.0.exe\n");
    check("p2-126 problems: empty when setup exe + latest.yml present", windowsInstallerProblems(distRoot).length === 0);

    // Sorted determinism + isFile guard, mirroring findDmg's contract.
    writeFileSync(join(distRoot, "AAA Setup 0.9.0.exe"), "exe");
    check("p2-126 setup: lexicographically first exe wins", findWindowsInstaller(distRoot)!.endsWith("AAA Setup 0.9.0.exe"));
    mkdirSync(join(distRoot, "ZZZ dir.exe"));
    rmSync(join(distRoot, "AAA Setup 0.9.0.exe"));
    rmSync(join(distRoot, "OpenCode Remote Setup 1.0.0.exe"));
    check("p2-126 setup: directory named *.exe is not an artifact", findWindowsInstaller(distRoot) === null);
    check("p2-126 absent dist root: findWindowsInstaller null", findWindowsInstaller(join(winRoot, "ghost")) === null);
  } finally {
    rmSync(winRoot, { recursive: true, force: true });
  }
}

// --- P2-127: hosted-relay smoke — the tsc-compiled dist the image runs -------
// No docker dependency: compile apps/relay to a tmp dist with the same
// tsconfig.build.json the image uses, run it on a kernel-assigned port,
// probe /healthz, round-trip a sealed frame between two sockets in one room
// and shut the process down cleanly.
{
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const smokeDir = mkdtempSync(join(tmpdir(), "ocr-relay-smoke-"));
  const distDir = join(smokeDir, "apps", "relay", "dist");
  let relayProc: ReturnType<typeof spawn> | null = null;
  const smokeGuard = setTimeout(() => {
    console.error("P2-127 relay smoke timed out");
    relayProc?.kill("SIGKILL");
    process.exit(1);
  }, 60_000);
  smokeGuard.unref();
  try {
    // mirror the image layout: /package.json + /apps/relay/dist/index.js —
    // the dist reads ../../../package.json to report the version on /healthz
    copyFileSync(join(repoRoot, "package.json"), join(smokeDir, "package.json"));
    symlinkSync(join(repoRoot, "node_modules"), join(smokeDir, "node_modules"));
    execSync(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(join(repoRoot, "node_modules", "typescript", "bin", "tsc"))} -p ${JSON.stringify(join(repoRoot, "apps", "relay", "tsconfig.build.json"))} --outDir ${JSON.stringify(distDir)}`,
      { cwd: repoRoot, stdio: "pipe" },
    );
    check("P2-127: tsc emits a runnable relay dist", existsSync(join(distDir, "index.js")));

    // ephemeral port asked to the kernel: bind 0, read the assignment, release
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const smokePort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    relayProc = spawn(process.execPath, [join(distDir, "index.js")], {
      cwd: smokeDir,
      env: { ...process.env, RELAY_PORT: String(smokePort), OCR_E2E_MARKER: "1" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    process.on("exit", () => relayProc?.kill("SIGTERM"));

    // GET /healthz: 200 + {"ok":true,...} — the first successful fetch both
    // proves the boot and is the probe (poll until the server listens)
    const fetchHealthz = () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = get(`http://127.0.0.1:${smokePort}/healthz`, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
    let healthz: { status: number; body: string } | null = null;
    for (let attempt = 0; attempt < 50 && !healthz; attempt++) {
      try {
        healthz = await fetchHealthz();
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!healthz) throw new Error("P2-127: relay never came up");
    const health = JSON.parse(healthz.body) as { ok: boolean; version: string };
    check(
      "P2-127: GET /healthz answers 200 with ok json",
      healthz.status === 200 && health.ok === true && typeof health.version === "string",
    );

    // sealed frame round-trip: the room grammar needs 8..128 id chars
    const smokeRoom = `smokeroom${Date.now().toString(36)}`;
    const fromA = "smoke-client";
    const fromB = "smoke-daemon";
    const smokeKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const dial = (from: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${smokePort}`);
        ws.on("open", () => {
          ws.send(JSON.stringify({ room: smokeRoom, from, payload: "" })); // join
          resolve(ws);
        });
        ws.on("error", reject);
      });
    const nextFrame = (ws: WebSocket, ms = 5000) =>
      new Promise<{ from?: string; seq?: number; payload?: string }>((resolve) => {
        const t = setTimeout(() => resolve({}), ms).unref();
        ws.once("message", (d) => {
          clearTimeout(t);
          resolve(JSON.parse(d.toString()));
        });
      });

    const wsA = await dial(fromA);
    const wsB = await dial(fromB);
    // A gets B's join echoed back — both sockets sit in the same room
    const joinEcho = await nextFrame(wsA);
    check("P2-127: both sockets joined the same room", joinEcho.from === fromB && joinEcho.payload === "");

    const smokeSeq = 1;
    const sealedPayload = await seal({ type: "op", text: "secret" }, smokeKey, seqAad(fromA, smokeSeq));
    wsA.send(JSON.stringify({ room: smokeRoom, from: fromA, seq: smokeSeq, payload: sealedPayload }));
    const got = await nextFrame(wsB);
    const opened =
      typeof got.payload === "string"
        ? await openSealed<{ type: string; text: string }>(got.payload, smokeKey, seqAad(fromA, smokeSeq))
        : null;
    check(
      "P2-127: sealed frame round-trips and opens with the right AAD",
      got.from === fromA && opened?.type === "op" && opened?.text === "secret",
    );
    // replay protection stays with the endpoints: wrong seq or sender opens nothing
    check(
      "P2-127: wrong seq or sender cannot open the payload",
      typeof got.payload === "string" &&
        (await openSealed(got.payload!, smokeKey, seqAad(fromA, 2))) === null &&
        (await openSealed(got.payload!, smokeKey, seqAad("evil", smokeSeq))) === null,
    );

    wsA.close();
    wsB.close();
    // clean shutdown: SIGTERM drains (≤3s) and exits 0
    const exited = new Promise<number>((resolve) => relayProc!.once("exit", (code) => resolve(code ?? -1)));
    relayProc!.kill("SIGTERM");
    const exitCode = await Promise.race([
      exited,
      new Promise<number>((r) => setTimeout(() => r(-1), 6000).unref()),
    ]);
    check("P2-127: SIGTERM ends the relay cleanly (exit 0)", exitCode === 0);
  } finally {
    clearTimeout(smokeGuard);
    relayProc?.kill("SIGKILL");
    rmSync(smokeDir, { recursive: true, force: true });
  }
}


// --- P2-135: upstream agent-server classifier (pure, no fetch/net imports) ---

{
  check("P2-135: healthy 200 classifies as ok with empty hint", (() => {
    const v = classifyUpstream({ status: 200, body: { healthy: true, version: "1.2.3" }, bodyOk: true });
    return v.state === "ok" && v.reason.length > 0 && v.hint === "";
  })());
  check("P2-135: 200 with healthy:false classifies as unhealthy", (() => {
    const v = classifyUpstream({ status: 200, body: { healthy: false }, bodyOk: true });
    return v.state === "unhealthy" && v.reason.length > 0 && v.hint.length > 0;
  })());
  check("P2-135: 200 with malformed body classifies as unhealthy", (() => {
    const v = classifyUpstream({ status: 200, body: undefined, bodyOk: false });
    return v.state === "unhealthy" && /malformada/.test(v.reason);
  })());
  check("P2-135: 401 classifies as unauthorized with actionable hint", (() => {
    const v = classifyUpstream({ status: 401, body: { error: "unauthorized" }, bodyOk: true });
    return v.state === "unauthorized" && v.hint.length > 0;
  })());
  check("P2-135: 403 classifies as unauthorized too", classifyUpstream({ status: 403 }).state === "unauthorized");
  check("P2-135: connection refused classifies as unreachable", (() => {
    const v = classifyUpstream({ error: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4096"), { code: "ECONNREFUSED" }) });
    return v.state === "unreachable" && /recusada/.test(v.reason) && v.hint.length > 0;
  })());
  check("P2-135: real fetch shape — TypeError 'fetch failed' with ECONNREFUSED cause — classifies as refused", (() => {
    // Node/undici wraps connection failures: top-level TypeError carries no
    // detail, the ECONNREFUSED error only appears in .cause. Regressions here
    // collapse "server not installed / wrong port" into the generic verdict.
    const v = classifyUpstream({
      error: Object.assign(new Error("fetch failed"), {
        name: "TypeError",
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4096"), { code: "ECONNREFUSED" }),
      }),
    });
    return v.state === "unreachable" && /recusada/.test(v.reason) && v.hint.length > 0;
  })());
  check("P2-135: plain-object cause with code (no Error wrapper) still classified as refused", (() => {
    const v = classifyUpstream({
      error: Object.assign(new Error("fetch failed"), {
        name: "TypeError",
        cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:4096" },
      }),
    });
    return v.state === "unreachable" && /recusada/.test(v.reason);
  })());
  check("P2-135: abort/timeout error classifies as timeout", (() => {
    const v = classifyUpstream({ error: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) });
    return v.state === "timeout" && v.hint.length > 0;
  })());
  check("P2-135: explicit timedOut flag classifies as timeout", classifyUpstream({ timedOut: true }).state === "timeout");
  check("P2-135: unexpected HTTP status classifies as unhealthy", classifyUpstream({ status: 502 }).state === "unhealthy");
  check("P2-135: probe payload never echoes secrets (static reason/hint)", (() => {
    const secret = "super-secret-token-9f8e7d6c";
    const v401 = classifyUpstream({ status: 401, body: { error: secret }, bodyOk: true });
    const vRefused = classifyUpstream({ error: new Error(`connect ECONNREFUSED token=${secret}`) });
    return !v401.reason.includes(secret) && !v401.hint.includes(secret) && !vRefused.reason.includes(secret) && !vRefused.hint.includes(secret);
  })());
  check("P2-135: classifier output is deterministic for identical probes", (() => {
    const a = classifyUpstream({ status: 200, body: { healthy: true }, bodyOk: true });
    const b = classifyUpstream({ status: 200, body: { healthy: true }, bodyOk: true });
    return a.state === b.state && a.reason === b.reason && a.hint === b.hint;
  })());
  check("P2-135: probe timeout cap is exported and sane", UPSTREAM_PROBE_TIMEOUT_MS === 5_000);
}


// --- P2-149: opencode binary resolution (pure) + refused-branch split ---------

{
  // ECONNREFUSED wrapped the way Node/undici wraps it — same shape as P2-135.
  const refusedErr = () =>
    Object.assign(new Error("fetch failed"), {
      name: "TypeError",
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4096"), { code: "ECONNREFUSED" }),
    });

  check("P2-149: PATH entry with an executable binary resolves with source path", (() => {
    const candidates = opencodeCandidates({ PATH: "/usr/local/bin:/bin" }, "darwin", "/home/u");
    const pick = pickOpencodeBinary(candidates, (p) => p === "/usr/local/bin/opencode");
    return pick.source === "path" && pick.path === "/usr/local/bin/opencode";
  })());
  check("P2-149: only a known location executable resolves with source known", (() => {
    const candidates = opencodeCandidates({ PATH: "/usr/local/bin" }, "darwin", "/home/u");
    const pick = pickOpencodeBinary(candidates, (p) => p === "/home/u/.opencode/bin/opencode");
    return pick.source === "known" && pick.path === "/home/u/.opencode/bin/opencode";
  })());
  check("P2-149: nothing executable resolves to null/null", (() => {
    const candidates = opencodeCandidates({ PATH: "/usr/local/bin" }, "darwin", "/home/u");
    const pick = pickOpencodeBinary(candidates, () => false);
    return pick.path === null && pick.source === null;
  })());
  check("P2-149: throwing isExecutable is discarded, not propagated", (() => {
    const candidates = opencodeCandidates({ PATH: "/a" }, "darwin", "/home/u");
    let first = true;
    const pick = pickOpencodeBinary(candidates, (p) => {
      if (first) {
        first = false;
        throw new Error("EACCES");
      }
      return p === "/home/u/.opencode/bin/opencode";
    });
    return pick.path === "/home/u/.opencode/bin/opencode" && pick.source === "known";
  })());
  check("P2-149: win32 candidates all end in .exe and never contain a slash", (() => {
    const candidates = opencodeCandidates(
      {
        PATH: "C:\\ops\\bin;C:\\Program Files\\opencode",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
      "win32",
      "C:\\Users\\u",
    );
    return (
      candidates.length > 0 && candidates.every((c) => c.path.endsWith(".exe") && !c.path.includes("/"))
    );
  })());
  check("P2-149: dedupe keeps first occurrence (PATH wins over known) in order", (() => {
    const candidates = opencodeCandidates({ PATH: "/opt/homebrew/bin:/usr/local/bin" }, "darwin", "/home/u");
    const paths = candidates.map((c) => c.path);
    const expected = [
      "/opt/homebrew/bin/opencode",
      "/usr/local/bin/opencode",
      "/home/u/.opencode/bin/opencode",
    ];
    return (
      paths.length === expected.length &&
      paths.every((p, i) => p === expected[i]) &&
      candidates[0].source === "path" &&
      candidates[2].source === "known"
    );
  })());
  check("P2-149: relative/empty PATH entries are dropped; trailing slash normalized", (() => {
    const candidates = opencodeCandidates({ PATH: "bin:.:~/x::/usr/local/bin/" }, "darwin", "/home/u");
    const paths = candidates.map((c) => c.path);
    return (
      candidates.length === 3 &&
      candidates[0].path === "/usr/local/bin/opencode" &&
      candidates[0].source === "path" &&
      paths.filter((p) => p === "/usr/local/bin/opencode").length === 1 &&
      paths.every((p) => !p.includes("//"))
    );
  })());
  check("P2-149: missing PATH still yields the known locations; win32 defaults to C:\\Program Files", (() => {
    const candidates = opencodeCandidates({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u");
    return (
      !candidates.some((c) => c.path.includes("undefined")) &&
      candidates.some((c) => c.path === "C:\\Program Files\\opencode\\opencode.exe") &&
      candidates.some((c) => c.path === "C:\\Users\\u\\AppData\\Local\\opencode\\bin\\opencode.exe")
    );
  })());

  check("P2-149: refused with binary present vs absent — same state, different hints", (() => {
    const withBinary = classifyUpstream({ error: refusedErr(), binaryFound: true });
    const withoutBinary = classifyUpstream({ error: refusedErr(), binaryFound: false });
    return (
      withBinary.state === "unreachable" &&
      withoutBinary.state === "unreachable" &&
      withBinary.reason !== withoutBinary.reason &&
      withBinary.hint !== withoutBinary.hint &&
      withBinary.hint.length > 0 &&
      withoutBinary.hint.length > 0
    );
  })());
  check("P2-149: binary-absent hint tells the user to install opencode first", (() => {
    const v = classifyUpstream({ error: refusedErr(), binaryFound: false });
    return /instal/i.test(v.hint) && !/rodando/.test(v.hint);
  })());
  check("P2-149: absent binaryFound keeps the legacy refused verdict byte a byte", (() => {
    const v = classifyUpstream({ error: refusedErr() });
    return (
      v.state === "unreachable" &&
      v.reason === "conexão recusada" &&
      v.hint === "o servidor do agente não está aceitando conexões — verifique se o opencode está rodando nesta máquina"
    );
  })());
  check("P2-149: verdicts never expose the resolved binary path", (() => {
    const binPath = "/opt/homebrew/bin/opencode";
    const a = classifyUpstream({ error: refusedErr(), binaryFound: true });
    const b = classifyUpstream({ error: refusedErr(), binaryFound: false });
    return [a.reason, a.hint, b.reason, b.hint].every((s) => !s.includes(binPath) && !s.includes("/home/"));
  })());
}


// --- P2-138: upstream notice mapping (pure, same contract as /api/health) -----

{
  // The daemon payload shape the desktop shell propagates (P2-135 classifier).
  const health = (state: string, reason = "motivo", hint = "dica"): UpstreamHealth => ({
    state,
    reason,
    hint,
    checkedAt: "2026-09-04T12:00:00.000Z",
  });

  // All five classifier states: the four non-ok ones map to a notice.
  check("P2-138: unreachable maps to an info notice with actionable copy", (() => {
    const n = upstreamNotice(health("unreachable", "conexão recusada", "verifique se o opencode está rodando"));
    return !!n && n.tone === "info" && n.titleKey === "upstreamUnreachableTitle" &&
      n.actionKey === "upstreamUnreachableAction" && n.reason === "conexão recusada" && n.hint === "verifique se o opencode está rodando";
  })());
  check("P2-138: unauthorized maps to a warn notice", (() => {
    const n = upstreamNotice(health("unauthorized"));
    return !!n && n.tone === "warn" && n.titleKey === "upstreamUnauthorizedTitle" && n.actionKey === "upstreamUnauthorizedAction";
  })());
  check("P2-138: timeout maps to a warn notice", (() => {
    const n = upstreamNotice(health("timeout"));
    return !!n && n.tone === "warn" && n.titleKey === "upstreamTimeoutTitle" && n.actionKey === "upstreamTimeoutAction";
  })());
  check("P2-138: unhealthy maps to a warn notice", (() => {
    const n = upstreamNotice(health("unhealthy"));
    return !!n && n.tone === "warn" && n.titleKey === "upstreamUnhealthyTitle" && n.actionKey === "upstreamUnhealthyAction";
  })());
  // ...and `ok` itself maps to NO notice (silence is the contract).
  check("P2-138: ok state produces no notice", upstreamNotice(health("ok", "opencode saudável", "")) === null);

  // Absent / legacy / malformed payloads must never invent a notice.
  check("P2-138: absent opencode object produces no notice", upstreamNotice(null) === null && upstreamNotice(undefined) === null);
  check("P2-138: unknown initial state produces no notice", upstreamNotice(health("unknown")) === null);
  check("P2-138: legacy payload without the opencode field produces no notice", upstreamNotice({}) === null);
  check("P2-138: malformed payload (non-string state) produces no notice", upstreamNotice({ state: 42, reason: "x", hint: "y" } as unknown as UpstreamHealth) === null);
  check("P2-138: non-string reason/hint degrade to empty strings, never crash", (() => {
    const n = upstreamNotice({ state: "timeout", reason: 7, hint: { bad: true } } as unknown as UpstreamHealth);
    return !!n && n.reason === "" && n.hint === "";
  })());

  // Copy parity: every notice key resolves in both locales (no raw-key leak),
  // and the Settings help section keys exist too.
  const noticeKeys = [
    "upstreamUnreachableTitle", "upstreamUnreachableAction",
    "upstreamUnauthorizedTitle", "upstreamUnauthorizedAction",
    "upstreamTimeoutTitle", "upstreamTimeoutAction",
    "upstreamUnhealthyTitle", "upstreamUnhealthyAction",
    "upstreamHelpAction", "upstreamHelpTitle",
  ];
  check(
    "P2-138: notice copy resolves per locale (en + pt) and never leaks the raw key",
    (["en", "pt"] as const).every((lang) =>
      noticeKeys.every((k) => {
        const s = translate(lang, k);
        return !!s && s !== k && dict[lang][k] === s;
      }),
    ),
  );
  check("P2-138: copy carries no markup (rendered as text, never HTML)", noticeKeys.every((k) =>
    (["en", "pt"] as const).every((lang) => {
      const s = dict[lang][k];
      return !s.includes("<") && !s.includes(">") && !s.includes("`") && !s.includes("{") && !s.includes("}");
    }),
  ));
}


// --- P2-140: sidecar exit classifier (pure, no electron/child_process) --------

{
  // The five kinds the spec names, driven by the exact shapes the shell feeds
  // in (exit code + signal + bounded stderr tail).
  check("P2-140: EADDRINUSE in stderr classifies as port-busy with actionable hint", (() => {
    const v = classifySidecarExit({ code: 1, signal: null, stderrTail: "Error: listen EADDRINUSE: address already in use 127.0.0.1:8792" });
    return v.kind === "port-busy" && v.reason.length > 0 && v.hint.length > 0;
  })());
  check("P2-140: ENOENT in stderr classifies as entry-missing", (() => {
    const v = classifySidecarExit({ code: 1, signal: null, stderrTail: "ErrorCode=ENOENT, syscall=spawn" });
    return v.kind === "entry-missing" && v.hint.length > 0;
  })());
  check("P2-140: SIGKILL exit (null code) classifies as killed", (() => {
    const v = classifySidecarExit({ code: null, signal: "SIGKILL", stderrTail: "" });
    return v.kind === "killed" && v.reason.length > 0 && v.hint.length > 0;
  })());
  check("P2-140: empty stderr with a nonzero code classifies as unknown", (() => {
    const v = classifySidecarExit({ code: 1, signal: null, stderrTail: "" });
    return v.kind === "unknown" && v.reason.length > 0 && v.hint.length > 0;
  })());
  check("P2-140: code zero without an intentional stop also classifies as unknown", (() => {
    const v = classifySidecarExit({ code: 0, signal: null, stderrTail: "" });
    return v.kind === "unknown";
  })());
  check("P2-140: nonzero code with marker-free stderr classifies as runtime-error", (() => {
    const v = classifySidecarExit({ code: 1, signal: null, stderrTail: "TypeError: foo is not a function" });
    return v.kind === "runtime-error" && v.hint.length > 0;
  })());
  // A busy port stays the story even when the child was killed afterwards —
  // the port verdict is the actionable one.
  check("P2-140: port-busy marker wins over a later kill signal", (() => {
    const v = classifySidecarExit({ code: null, signal: "SIGKILL", stderrTail: "EADDRINUSE" });
    return v.kind === "port-busy";
  })());
  check("P2-140: stderr tail is only searched, never echoed (static copy, no secrets)", (() => {
    const secret = "apiToken=super-secret-9f8e7d6c";
    const v = classifySidecarExit({ code: 1, signal: null, stderrTail: `${secret}\nEADDRINUSE` });
    return !v.reason.includes(secret) && !v.hint.includes(secret) && !v.reason.includes("/") && !v.hint.includes("/");
  })());
  check("P2-140: classifier output is deterministic for identical inputs", (() => {
    const a = classifySidecarExit({ code: 1, signal: null, stderrTail: "EADDRINUSE" });
    const b = classifySidecarExit({ code: 1, signal: null, stderrTail: "EADDRINUSE" });
    return a.kind === b.kind && a.reason === b.reason && a.hint === b.hint;
  })());

  // Renderer mapping: kind → i18n keys, tolerant to absent/malformed payloads.
  const exit = (kind: string): SidecarExitHealth => ({ kind, reason: "motivo", hint: "dica" });
  check("P2-140: port-busy maps to the port-busy notice", (() => {
    const n = sidecarExitNotice(exit("port-busy"));
    return !!n && n.titleKey === "sidecarPortBusyTitle" && n.actionKey === "sidecarPortBusyAction";
  })());
  check("P2-140: entry-missing maps to the entry-missing notice", (() => {
    const n = sidecarExitNotice(exit("entry-missing"));
    return !!n && n.titleKey === "sidecarEntryMissingTitle" && n.actionKey === "sidecarEntryMissingAction";
  })());
  check("P2-140: killed maps to the killed notice", (() => {
    const n = sidecarExitNotice(exit("killed"));
    return !!n && n.titleKey === "sidecarKilledTitle" && n.actionKey === "sidecarKilledAction";
  })());
  check("P2-140: runtime-error maps to the runtime-error notice", (() => {
    const n = sidecarExitNotice(exit("runtime-error"));
    return !!n && n.titleKey === "sidecarRuntimeErrorTitle" && n.actionKey === "sidecarRuntimeErrorAction";
  })());
  check("P2-140: unknown maps to the unknown notice", (() => {
    const n = sidecarExitNotice(exit("unknown"));
    return !!n && n.titleKey === "sidecarUnknownTitle" && n.actionKey === "sidecarUnknownAction";
  })());
  check("P2-140: absent or malformed sidecarExit objects produce no notice", sidecarExitNotice(null) === null && sidecarExitNotice(undefined) === null && sidecarExitNotice({}) === null && sidecarExitNotice({ kind: 42 }) === null);

  // Copy parity: every key resolves in both locales (no raw-key leak).
  const exitKeys = [
    "sidecarPortBusyTitle", "sidecarPortBusyAction",
    "sidecarEntryMissingTitle", "sidecarEntryMissingAction",
    "sidecarRuntimeErrorTitle", "sidecarRuntimeErrorAction",
    "sidecarKilledTitle", "sidecarKilledAction",
    "sidecarUnknownTitle", "sidecarUnknownAction",
  ];
  check(
    "P2-140: exit-warning copy resolves per locale (en + pt) and never leaks the raw key",
    (["en", "pt"] as const).every((lang) =>
      exitKeys.every((k) => {
        const s = translate(lang, k);
        return !!s && s !== k && dict[lang][k] === s;
      }),
    ),
  );
  check("P2-140: exit-warning copy carries no markup, paths or emoji", exitKeys.every((k) =>
    (["en", "pt"] as const).every((lang) => {
      const s = dict[lang][k];
      return !s.includes("<") && !s.includes(">") && !s.includes("{") && !s.includes("}") && !s.includes("/") && !/\p{Extended_Pictographic}/u.test(s);
    }),
  ));
}


// --- P2-133: orphan-test reachability (pure fixtures) ------------------------

{
  const FIXTURE_SCRIPTS: Record<string, string> = {
    "test:unit": "tsx scripts/in-chain.test.ts",
    "test:never-invoked": "tsx scripts/in-never-invoked.test.ts",
    "test:ci-runner": "tsx scripts/in-ci-only.test.ts",
    typecheck: "tsc --noEmit",
  };
  const GATE = ["npm run typecheck --silent", "npm run build --silent", "npm run test:unit --silent"];
  const CI = ["- run: npm run test:unit", "- run: npx tsx scripts/in-ci-only.test.ts"].join("\n");
  const REGISTRY = [
    { file: "scripts/only-registered.test.ts", runner: "manual", reason: "live test" },
    { file: "scripts/in-chain.test.ts", runner: "npm run test:unit", reason: "belt and braces" },
  ];
  const FILES = [
    "scripts/in-chain.test.ts",
    "scripts/in-never-invoked.test.ts",
    "scripts/in-ci-only.test.ts",
    "scripts/only-registered.test.ts",
    "scripts/nowhere.test.ts",
  ];
  const orphans = unreachableTests(FILES, FIXTURE_SCRIPTS, GATE, CI, REGISTRY);
  check("P2-133: file cited only in a never-invoked script is unreachable (declaration is not coverage)", orphans.includes("scripts/in-never-invoked.test.ts"));
  check("P2-133: file inside the test:unit chain is reachable", !orphans.includes("scripts/in-chain.test.ts"));
  check("P2-133: file only executed by CI is reachable", !orphans.includes("scripts/in-ci-only.test.ts"));
  check("P2-133: file only in the declared registry is not an orphan", !orphans.includes("scripts/only-registered.test.ts"));
  check("P2-133: file cited nowhere is an orphan", orphans.includes("scripts/nowhere.test.ts"));
  check(
    "P2-133: orphans are exactly the two uncovered fixtures, in input order",
    JSON.stringify(orphans) === JSON.stringify(["scripts/in-never-invoked.test.ts", "scripts/nowhere.test.ts"]),
  );
  check(
    "P2-133: registered AND in the chain is never an error",
    !unreachableTests(["scripts/in-chain.test.ts"], FIXTURE_SCRIPTS, GATE, CI, REGISTRY).includes("scripts/in-chain.test.ts"),
  );
  check(
    "P2-133: CI citing a script name only via npm run still expands the chain",
    unreachableTests(
      ["scripts/in-chain.test.ts"],
      { ...FIXTURE_SCRIPTS, "test:unit": "tsx scripts/other.test.ts && tsx scripts/in-chain.test.ts" },
      GATE,
      CI,
      [],
    ).length === 0,
  );
  check(
    "P2-133: registry entry with extra path segments matches by basename",
    unreachableTests(
      ["scripts/only-registered.test.ts"],
      {},
      [],
      "",
      [{ file: "./scripts/only-registered.test.ts", runner: "r", reason: "why" }],
    ).length === 0,
  );
}


// --- P2-136: signing profile — mac notarization preflight ----------------------

{
  const APPLE = { APPLE_ID: "ops@example.com", APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop", APPLE_TEAM_ID: "TEAM1234" };
  const pEmpty = signingProfile({});
  check("P2-136: empty env → ad-hoc, no notarization, no problems", pEmpty.mode === "adhoc" && pEmpty.notarizes === false && pEmpty.problems.length === 0);

  const pNotaryOnly = signingProfile({ ...APPLE });
  check(
    "P2-136: Apple credentials without a signing certificate → problem, stays ad-hoc",
    pNotaryOnly.mode === "adhoc" && pNotaryOnly.notarizes === false && pNotaryOnly.problems.length === 1,
  );

  const pCertOnly = signingProfile({ CSC_LINK: "/tmp/dev-id.p12" });
  check(
    "P2-136: certificate without Apple credentials → Developer ID signing, no notarization",
    pCertOnly.mode === "developer-id" && pCertOnly.notarizes === false && pCertOnly.problems.length === 0,
  );

  const full = { CSC_LINK: "/tmp/dev-id.p12", ...APPLE };
  const pFullDiscoveryOn = signingProfile({ ...full });
  check(
    "P2-136: everything present, auto discovery on (unset) → Developer ID + notarization",
    pFullDiscoveryOn.mode === "developer-id" && pFullDiscoveryOn.notarizes === true && pFullDiscoveryOn.problems.length === 0,
  );

  const pFullDiscoveryOff = signingProfile({ ...full, CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  check(
    "P2-136: everything present but auto discovery off → problem, stays ad-hoc (cert would be ignored)",
    pFullDiscoveryOff.mode === "adhoc" && pFullDiscoveryOff.notarizes === false && pFullDiscoveryOff.problems.length === 1,
  );

  const pExplicitTrue = signingProfile({ ...full, CSC_IDENTITY_AUTO_DISCOVERY: "true" });
  check("P2-136: explicit CSC_IDENTITY_AUTO_DISCOVERY=true behaves like unset", pExplicitTrue.notarizes === true && pExplicitTrue.problems.length === 0);

  const pCscName = signingProfile({ CSC_NAME: "Developer ID Application: Example (TEAM1234)" });
  check("P2-136: CSC_NAME alone counts as a signing credential", pCscName.mode === "developer-id" && pCscName.problems.length === 0);

  const pPartialApple = signingProfile({ ...full, APPLE_TEAM_ID: "" });
  check(
    "P2-136: partial Apple credentials → signing without notarization (same all-three rule as the workflow)",
    pPartialApple.mode === "developer-id" && pPartialApple.notarizes === false && pPartialApple.problems.length === 0,
  );

  check(
    "P2-136: problems cite the exact env vars to fix (dist-smoke problem format)",
    (pNotaryOnly.problems[0] ?? "").includes("CSC_LINK") &&
      (pFullDiscoveryOff.problems[0] ?? "").includes("CSC_IDENTITY_AUTO_DISCOVERY"),
  );
}


// --- P2-136: real-repo assertion — builder config stays wired to the plist -----

{
  const root = join(import.meta.dirname, "..");
  const plist = readFileSync(join(root, "apps", "desktop", "build", "entitlements.mac.plist"), "utf8");
  const builderYml = readFileSync(join(root, "apps", "desktop", "electron-builder.yml"), "utf8");
  const releaseYml = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const entitlementKeys = [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.cs.allow-dyld-environment-variables",
  ];
  check("P2-136: entitlements plist carries the Electron + node-sidecar keys", entitlementKeys.every((k) => plist.includes(k)));
  check(
    "P2-136: mac block wires hardened runtime + entitlements/entitlementsInherit",
    builderYml.includes("hardenedRuntime: true") &&
      builderYml.includes("gatekeeperAssess: false") &&
      builderYml.includes("entitlements: build/entitlements.mac.plist") &&
      builderYml.includes("entitlementsInherit: build/entitlements.mac.plist"),
  );
  check("P2-136: plist is shipped in the files list", builderYml.includes("- build/entitlements.mac.plist"));
  check(
    "P2-136: release.yml runs the preflight and only notarizes on its developer-id/no-problems verdict",
    releaseYml.includes("signing-profile.mjs") && releaseYml.includes("steps.signing.outputs.notarize"),
  );
}


// --- P2-139: RELAY_URL boot validation (pure, fail-closed) -------------------

{
  const ok = parseRelayUrl("ws://127.0.0.1:8787");
  check(
    "P2-139: loopback ws default accepted",
    ok.problems.length === 0 && !ok.secure && ok.host === "127.0.0.1:8787",
  );
  const wssPublic = parseRelayUrl("wss://relay.example.com:8788");
  check(
    "P2-139: wss on a public host accepted",
    wssPublic.problems.length === 0 && wssPublic.secure && wssPublic.href === "wss://relay.example.com:8788/",
  );
  const wsPublic = parseRelayUrl("ws://relay.example.com:8788");
  check("P2-139: ws on a public host is a problem", wsPublic.problems.length > 0 && !wsPublic.secure);
  check(
    "P2-139: ws public host still reports href/host for diagnostics",
    wsPublic.href === "ws://relay.example.com:8788/" && wsPublic.host === "relay.example.com:8788",
  );
  check("P2-139: http scheme rejected", parseRelayUrl("http://relay.example.com:8788").problems.length > 0);
  check("P2-139: https scheme rejected", parseRelayUrl("https://relay.example.com").problems.length > 0);
  const empty = parseRelayUrl("");
  check("P2-139: empty string rejected", empty.problems.length > 0 && empty.href === "" && empty.host === "");
  check("P2-139: whitespace-only rejected", parseRelayUrl("   ").problems.length > 0);
  const malformed = parseRelayUrl("not a url");
  check("P2-139: malformed URL rejected", malformed.problems.length > 0 && malformed.href === "");
  check(
    "P2-139: trailing slash normalization",
    parseRelayUrl("ws://127.0.0.1:8787").href === parseRelayUrl("ws://127.0.0.1:8787/").href,
  );
  check("P2-139: localhost counts as loopback over ws", parseRelayUrl("ws://localhost:8787").problems.length === 0);
  check("P2-139: ipv6 ::1 counts as loopback over ws", parseRelayUrl("ws://[::1]:8787").problems.length === 0);
  check("P2-139: wss never triggers the plain-ws problem", parseRelayUrl("wss://relay.example.com").problems.length === 0);
  check(
    "P2-139: problem mentions the env var so the operator knows what to fix",
    parseRelayUrl("http://x.example").problems.every((p) => p.includes("RELAY_URL")),
  );
  // round 2: strict dotted-quad loopback — nip.io-style wildcards must NOT pass
  check("P2-139: 127.0.0.1.evil.com is NOT loopback over ws", parseRelayUrl("ws://127.0.0.1.evil.com:8787").problems.length > 0);
  check("P2-139: 127.attacker.com is NOT loopback over ws", parseRelayUrl("ws://127.attacker.com").problems.length > 0);
  check("P2-139: real 127.0.0.1 still loopback over ws", parseRelayUrl("ws://127.0.0.1:8787").problems.length === 0);
  check("P2-139: 127.0.0.255 (full octet) is loopback over ws", parseRelayUrl("ws://127.0.0.255").problems.length === 0);
  check("P2-139: 127.0.0.256 is rejected outright by the URL parser", parseRelayUrl("ws://127.0.0.256").problems.length > 0);
  // round 2: userinfo redaction for display surfaces (logs + /api/health)
  check("P2-139: redactRelayUrl strips user:pass@", redactRelayUrl("wss://user:token@relay.example.com:8788") === "wss://relay.example.com:8788");
  check("P2-139: redactRelayUrl keeps plain URLs", redactRelayUrl("ws://127.0.0.1:8787") === "ws://127.0.0.1:8787");
  check("P2-139: redactRelayUrl ignores @ inside path", redactRelayUrl("ws://host:8788/pa@th") === "ws://host:8788/pa@th");
  check("P2-139: redactRelayUrl tolerates unparseable strings", redactRelayUrl("not a url") === "not a url");
  check("P2-139: redactRelayUrl handles no-authority strings", redactRelayUrl("nonsense") === "nonsense");
}


// --- P2-143: daemon port fallback (pure picker, no electron/net) --------------

{
  // 1. preferred port free (and not our daemon) → picked as "preferred".
  const pick1 = await pickDaemonPort(candidatePorts(8792), async () => true, async () => false);
  check("P2-143: free preferred port → {preferred, 8792}", pick1.reason === "preferred" && pick1.port === 8792);

  // 2. preferred port already running OUR daemon → adopt it; isFree never
  // decides (identity is checked first and short-circuits the walk).
  let freeCalls = 0;
  const pick2 = await pickDaemonPort(
    candidatePorts(8792),
    async () => {
      freeCalls += 1;
      return false;
    },
    async () => true,
  );
  check(
    "P2-143: our daemon on the preferred port → reused, isFree never consulted",
    pick2.reason === "reused" && pick2.port === 8792 && freeCalls === 0,
  );

  // 3. preferred occupied by a stranger, 8793 free → deterministic fallback.
  const busy3 = new Set([8792]);
  const pick3 = await pickDaemonPort(
    candidatePorts(8792),
    async (p) => !busy3.has(p),
    async () => false,
  );
  check("P2-143: preferred squatted by a stranger → fallback to 8793", pick3.reason === "fallback" && pick3.port === 8793);

  // 4. every candidate occupied by strangers → "none" on the preferred port
  // (spawn there, die with EADDRINUSE, P2-140 keeps explaining why).
  const pick4 = await pickDaemonPort(candidatePorts(8792), async () => false, async () => false);
  check("P2-143: all 5 candidates squatted → {none, 8792}", pick4.reason === "none" && pick4.port === 8792);

  // 5. Override (preferred outside 8792–8796) → single-entry list, the picker
  // never leaves the override port: fallback is off by construction.
  const ports5 = candidatePorts(9321);
  const pick5 = await pickDaemonPort(ports5, async () => true, async () => false);
  check(
    "P2-143: override 9321 → one candidate, picker stays on it",
    ports5.length === 1 && ports5[0] === 9321 && pick5.port === 9321 && pick5.reason === "preferred",
  );

  // 5b. In-span override (e.g. OCR_DAEMON_METRICS_PORT=8794): the override is
  // absolute EVEN inside the 8792–8796 span — single entry, the shell uses
  // exactly that port and never drifts to 8792 against the operator's choice.
  const ports5b = candidatePorts(8794, true);
  check("P2-143: in-span override 8794 → single candidate", ports5b.length === 1 && ports5b[0] === 8794);
  check("P2-143: override 9321 with flag → single candidate", (() => {
    const ports = candidatePorts(9321, true);
    return ports.length === 1 && ports[0] === 9321;
  })());
  const pick5b = await pickDaemonPort(ports5b, async () => false, async () => false);
  check(
    "P2-143: in-span override squatted → {none, 8794}, never drifts to 8792",
    pick5b.reason === "none" && pick5b.port === 8794,
  );
  const pick5c = await pickDaemonPort(ports5b, async () => true, async () => false);
  check(
    "P2-143: in-span override free → {preferred, 8794}",
    pick5c.reason === "preferred" && pick5c.port === 8794,
  );

  // 6. Span shape: preferred first, the rest ascending, no duplicates.
  check("P2-143: candidatePorts(8792) has 5 entries", candidatePorts(8792).length === 5);
  check("P2-143: candidatePorts(8794) = [8794,8792,8793,8795,8796], no duplicates", (() => {
    const ports = candidatePorts(8794);
    return (
      ports[0] === 8794 &&
      ports.join(",") === "8794,8792,8793,8795,8796" &&
      new Set(ports).size === ports.length
    );
  })());

  // 7. Edge: our daemon on a NON-first candidate is still adopted ("reused").
  const busy7 = new Set([8792]);
  let probed7 = 0;
  const pick7 = await pickDaemonPort(
    candidatePorts(8792),
    async (p) => {
      probed7 += 1;
      return !busy7.has(p);
    },
    async (p) => p === 8793,
  );
  // 8792: identity probe + free probe (false); 8793: identity probe wins.
  check(
    "P2-143: our daemon on 8793 adopted when 8792 is squatted",
    pick7.reason === "reused" && pick7.port === 8793 && probed7 === 1,
  );

  // 8. Edge: a throwing probe only discards the candidate — never propagates.
  const pick8 = await pickDaemonPort(
    candidatePorts(8792),
    async (p) => {
      if (p === 8792) throw new Error("EACCES");
      return true;
    },
    async () => false,
  );
  check("P2-143: throwing isFree on the preferred discards it, walk continues", pick8.reason === "fallback" && pick8.port === 8793);

  // 9. Edge: empty candidate list → the module default with reason "none".
  const pick9 = await pickDaemonPort([], async () => true, async () => false);
  check("P2-143: empty candidate list → {none, DEFAULT_DAEMON_PORT}", pick9.reason === "none" && pick9.port === 8792);
}


// P2-126-class: mergeConflictBlock only fires on CONFLICTING and carries the
// task id + both-sides instruction.
{
  const block = mergeConflictBlock("CONFLICTING", "P2-123");
  check("conflict block fires on CONFLICTING", block.includes("pilot/P2-123") && block.includes("git merge origin/main") && block.includes("BOTH sides"));
  check("clean mergeable yields no block", mergeConflictBlock("MERGEABLE", "P2-123") === "" && mergeConflictBlock(null, "P2-123") === "" && mergeConflictBlock(undefined, "P2-123") === "");
}


// --- P2-147: ci-scope — PR packaging scope classifier -------------------------
{
  check("P2-147: touchesDesktop — path under apps/desktop", touchesDesktop(["README.md", "apps/desktop/src/main.ts"]));
  check("P2-147: touchesDesktop — electron-builder.yml itself", touchesDesktop(["apps/desktop/electron-builder.yml"]));
  check("P2-147: touchesDesktop — path under apps/web", touchesDesktop(["apps/web/src/lib/viewState.ts"]));
  check("P2-147: touchesDesktop — root package-lock.json", touchesDesktop(["package-lock.json"]));
  check("P2-147: touchesDesktop — bare desktop dir entry counts", touchesDesktop(["apps/desktop"]));
  check("P2-147: touchesDesktop — irrelevant repo path", !touchesDesktop(["apps/relay/src/index.ts", "docs/PILOT.md", "scripts/other.ts"]));
  check("P2-147: touchesDesktop — empty diff", !touchesDesktop([]));
  check("P2-147: touchesDesktop — windows-style separators normalize", touchesDesktop(["apps\\desktop\\src\\main.ts"]));
  check("P2-147: touchesDesktop — ./ prefix and whitespace normalize", touchesDesktop([" ./apps/web/src/main.tsx"]));
  check("P2-147: touchesDesktop — app-sounding paths outside the surface don't count", !touchesDesktop(["apps/desktop-runner/x.ts", "src/apps/web-preview.ts"]));
}


// --- P2-147: dist-smoke --no-installer — pure argv contract -------------------
{
  check(
    "P2-147: smokeFlags — empty argv keeps the installer checks (release behavior)",
    smokeFlags([]).noInstaller === false && smokeFlags([]).dir === null,
  );
  check(
    "P2-147: smokeFlags — --no-installer opts out while keeping auto resolution",
    smokeFlags(["--no-installer"]).noInstaller === true && smokeFlags(["--no-installer"]).dir === null,
  );
  check(
    "P2-147: smokeFlags — --dir preserves the current behavior (no flag)",
    smokeFlags(["--dir", "/tmp/bundle"]).dir === "/tmp/bundle" &&
      smokeFlags(["--dir", "/tmp/bundle"]).noInstaller === false,
  );
  check(
    "P2-147: smokeFlags — --dir= form resolves too",
    smokeFlags(["--dir=/tmp/bundle"]).dir === "/tmp/bundle",
  );
  check(
    "P2-147: smokeFlags — --dir and --no-installer compose",
    smokeFlags(["--dir", "/tmp/b", "--no-installer"]).noInstaller === true &&
      smokeFlags(["--dir", "/tmp/b", "--no-installer"]).dir === "/tmp/b",
  );
}


// --- P2-147: real-repo assertion — ci.yml wires desktop-package to the scope --
{
  const root = join(import.meta.dirname, "..");
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  check(
    "P2-147: ci.yml scope job exposes the desktop flag from scripts/ci-scope.ts",
    ci.includes("scripts/ci-scope.ts") && ci.includes("desktop: ${{ steps.scope.outputs.desktop }}"),
  );
  check(
    "P2-147: desktop-package needs scope and is conditioned on its output",
    ci.includes("desktop-package:") && ci.includes("needs: scope") && ci.includes("if: needs.scope.outputs.desktop == 'true'"),
  );
  check(
    "P2-147: desktop-package packages mac dir target only (no dmg, no signing)",
    ci.includes("-- --mac --dir") && ci.includes("CSC_IDENTITY_AUTO_DISCOVERY: false"),
  );
  check(
    "P2-147: desktop-package smoke-checks the real bundle with installer checks skipped",
    ci.includes("dist:smoke --workspace @ocr/desktop -- --no-installer"),
  );
  check(
    "P2-147: release workflow keeps the flagless dist:smoke invocation byte for byte",
    release.includes("run: npm run dist:smoke --workspace @ocr/desktop\n") && !release.includes("--no-installer"),
  );
}


// --- P2-151: relay-image — GHCR references for the release workflow ----------
{
  const ok = imageTags("v0.2.0", "caiovicentino/opencode-remote");
  check(
    "P2-151: valid vX.Y.Z tag → bare-semver version ref + latest ref",
    ok.problems.length === 0 &&
      ok.versionRef === "ghcr.io/caiovicentino/opencode-remote:0.2.0" &&
      ok.latestRef === "ghcr.io/caiovicentino/opencode-remote:latest",
  );
  const noV = imageTags("0.2.0", "caiovicentino/opencode-remote");
  check(
    "P2-151: tag without the leading v is accepted and agrees with the v form",
    noV.problems.length === 0 && noV.versionRef === ok.versionRef && noV.latestRef === ok.latestRef,
  );
  const upper = imageTags("v0.2.0", "CaioVicentino/OpenCode-Remote");
  check(
    "P2-151: uppercase owner/name normalized to the lowercase GHCR canonical form",
    upper.problems.length === 0 && upper.versionRef === "ghcr.io/caiovicentino/opencode-remote:0.2.0",
  );
  const pre = imageTags("v1.2.3-rc.1", "caiovicentino/opencode-remote");
  check(
    "P2-151: prerelease semver accepted as-is in the docker tag",
    pre.problems.length === 0 && pre.versionRef === "ghcr.io/caiovicentino/opencode-remote:1.2.3-rc.1",
  );
  const notSemver = imageTags("nightly", "caiovicentino/opencode-remote");
  check(
    "P2-151: non-semver tag is a problem (fail-closed, empty refs)",
    notSemver.problems.length > 0 && notSemver.versionRef === "" && notSemver.latestRef === "",
  );
  const emptyTag = imageTags("", "caiovicentino/opencode-remote");
  check(
    "P2-151: empty tag is its own problem, not a semver complaint",
    emptyTag.problems.length === 1 && emptyTag.problems[0]!.includes("empty"),
  );
  const noSlash = imageTags("v0.2.0", "caiovicentino-opencode-remote");
  check(
    "P2-151: slug without a slash is a problem citing the owner/repo shape",
    noSlash.problems.length > 0 && noSlash.problems[0]!.includes("owner/repo"),
  );
  const both = imageTags("", "no-slash");
  check("P2-151: every problem is reported at once (tag + slug)", both.problems.length === 2);
}


// --- P2-151: real-repo assertion — release.yml wires the relay-image job -----
{
  const root = join(import.meta.dirname, "..");
  const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const start = release.indexOf("\n  relay-image:");
  const block = start === -1 ? "" : release.slice(start);
  check(
    "P2-151: release.yml has a relay-image job needing release with packages: write",
    block.includes("runs-on: ubuntu-latest") && block.includes("needs: release") && block.includes("packages: write"),
  );
  check(
    "P2-151: relay-image computes refs via scripts/relay-image.ts and builds deploy/relay/Dockerfile",
    block.includes("scripts/relay-image.ts") && block.includes("deploy/relay/Dockerfile"),
  );
  check(
    "P2-151: publish is opt-in fail-closed on the PUBLISH_RELAY_IMAGE repo variable",
    block.includes("if: vars.PUBLISH_RELAY_IMAGE == 'true'"),
  );
  check(
    "P2-151: ghcr login uses the built-in GITHUB_TOKEN and push steps declare shell: bash",
    block.includes("ghcr.io") && block.includes("${{ github.token }}") && block.includes("shell: bash"),
  );
}


// --- P2-196: relay-image-smoke — imageSmokeVerdict ---------------------------
{
  const okProbes = () => [
    {
      name: "healthz",
      status: 200,
      body: JSON.stringify({ ok: true, version: "0.2.0", uptimeS: 3, rooms: 1, roomsRejected: 0 }),
    },
    {
      name: "web-root",
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: {
        "content-security-policy": "default-src 'self'; script-src 'self'",
        "referrer-policy": "no-referrer",
        "permissions-policy": "geolocation=(), payment=()",
        "x-frame-options": "DENY",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
      },
    },
    { name: "hashed-asset", status: 200 },
    { name: "dotfile", status: 404 },
    { name: "method-not-get", status: 405 },
    { name: "container-user", user: "node" },
  ];
  const failOne = (name: string, patch: Record<string, unknown>) => {
    const probes = okProbes().map((p) => (p.name === name ? { ...p, ...patch } : p));
    return imageSmokeVerdict(probes);
  };

  check("P2-196: every probe passing → zero problems", imageSmokeVerdict(okProbes()).length === 0);

  const healthz = failOne("healthz", { status: 503, body: "draining" });
  check(
    "P2-196: healthz failing in isolation → exactly its own problem",
    healthz.length === 1 && healthz[0]!.includes("healthz") && healthz[0]!.includes("503"),
    JSON.stringify(healthz),
  );
  const webRoot = failOne("web-root", { headers: {} });
  check(
    "P2-196: web-root without the P2-192 headers failing in isolation → exactly its own problem",
    webRoot.length === 1 && webRoot[0]!.includes("web-root") && webRoot[0]!.includes("content-security-policy"),
    JSON.stringify(webRoot),
  );
  const hashed = failOne("hashed-asset", { status: 404 });
  check(
    "P2-196: hashed-asset failing in isolation → exactly its own problem",
    hashed.length === 1 && hashed[0]!.includes("hashed-asset") && hashed[0]!.includes("404"),
    JSON.stringify(hashed),
  );
  const dotfile = failOne("dotfile", { status: 200 });
  check(
    "P2-196: dotfile leaking through (200) failing in isolation → exactly its own problem",
    dotfile.length === 1 && dotfile[0]!.includes("dotfile"),
    JSON.stringify(dotfile),
  );
  const method = failOne("method-not-get", { status: 200 });
  check(
    "P2-196: DELETE answered 200 failing in isolation → exactly its own problem",
    method.length === 1 && method[0]!.includes("method-not-get"),
    JSON.stringify(method),
  );
  const rootUser = failOne("container-user", { user: "root" });
  check(
    "P2-196: container running as root → problem",
    rootUser.length === 1 && rootUser[0]!.includes("container-user") && rootUser[0]!.includes("root"),
    JSON.stringify(rootUser),
  );
  const emptyUser = failOne("container-user", { user: "  " });
  check(
    "P2-196: container user unreadable (empty) → problem (fail-closed)",
    emptyUser.length === 1 && emptyUser[0]!.includes("container-user"),
    JSON.stringify(emptyUser),
  );

  const many = imageSmokeVerdict([
    { name: "healthz", status: 500, body: "boom" },
    okProbes()[1]!,
    { name: "dotfile", status: 200 },
    { name: "container-user", user: "root" },
  ]);
  check(
    "P2-196: several probes failing → ALL problems at once (no short-circuit)",
    many.length === 3 &&
      many[0]!.includes("healthz") &&
      many[1]!.includes("dotfile") &&
      many[2]!.includes("container-user"),
    JSON.stringify(many),
  );

  const unknown = imageSmokeVerdict([...okProbes(), { name: "cpu-affinity", status: 200 }]);
  check(
    "P2-196: unknown probe name → problem",
    unknown.length === 1 && unknown[0]!.includes("unknown probe") && unknown[0]!.includes("cpu-affinity"),
    JSON.stringify(unknown),
  );
  check(
    "P2-196: empty probe list → problem",
    imageSmokeVerdict([]).length === 1 && imageSmokeVerdict([])[0]!.includes("no probes"),
  );

  // --- real-repo assertion: release.yml wires the smoke before the push ------
  const repoRoot = join(import.meta.dirname, "..");
  const release = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const jobStart = release.indexOf("\n  relay-image:");
  const jobEnd = release.indexOf("\n  release-feeds:");
  const job = jobStart === -1 || jobEnd === -1 || jobEnd < jobStart ? "" : release.slice(jobStart, jobEnd);
  const smokeAt = job.indexOf("Smoke the built image");
  const buildAt = job.indexOf("Build image (both references)");
  const pushAt = job.indexOf("Push both references");
  check(
    "P2-196: release.yml relay-image runs the smoke step between build and push",
    buildAt > -1 && smokeAt > buildAt && pushAt > smokeAt,
  );
  check(
    "P2-196: smoke step boots the built image detached, reads the container user and runs the smoke CLI",
    job.includes("docker run -d --name relay-smoke") &&
      job.includes("docker exec relay-smoke whoami") &&
      job.includes("scripts/relay-image-smoke.ts"),
  );
  check(
    "P2-196: smoke step declares shell: bash and always removes the container (trap on EXIT)",
    job.includes("shell: bash") && job.includes("docker rm -f relay-smoke"),
  );
  check(
    "P2-196: push stays opt-in fail-closed on PUBLISH_RELAY_IMAGE after the smoke",
    /Push both references[\s\S]*?if: vars\.PUBLISH_RELAY_IMAGE == 'true'/.test(job.slice(pushAt)) &&
      job.includes("if: vars.PUBLISH_RELAY_IMAGE == 'true'"),
  );
}


// --- P2-153: release-assets — expected/missing download assets ---------------
{
  const TAG = "v0.3.0";
  const complete = [
    "opencode-remote-v0.3.0.tar.gz", // source tarball never satisfies a platform slot
    "OpenCode Remote-0.3.0-arm64.dmg",
    "OpenCode Remote-0.3.0-x64.dmg",
    "OpenCode Remote-0.3.0-arm64.zip",
    "OpenCode Remote-0.3.0-x64.zip",
    "OpenCode Remote Setup 0.3.0.exe",
    "latest-mac.yml",
    "update-mac.json",
    "update-mac-arm64.json",
    "update-mac-x64.json",
    "latest.yml",
  ];
  check(
    "P2-153: complete release has no missing assets",
    missingAssets(expectedAssets(TAG), complete).length === 0,
  );
  check(
    "P2-153: expected assets are exactly 10 (per-arch dmg+zip, exe, 5 metadata files) — P2-191",
    expectedAssets(TAG).length === 10,
  );
  check(
    "P2-153: missing dmg is reported by label (both architectures since P2-191)",
    JSON.stringify(missingAssets(expectedAssets(TAG), complete.filter((n) => !n.endsWith(".dmg")))) ===
      JSON.stringify([
        "macOS DMG installer for Apple Silicon (*.dmg carrying 0.3.0 and arm64)",
        "macOS DMG installer for Intel (*.dmg carrying 0.3.0 and x64)",
      ]),
  );
  check(
    "P2-153: missing latest.yml is reported by label",
    JSON.stringify(missingAssets(expectedAssets(TAG), complete.filter((n) => n !== "latest.yml"))) ===
      JSON.stringify(["Windows update metadata (latest.yml)"]),
  );
  check(
    "P2-153: dmg named after a different version counts as missing (no substring leak: 9.9.9 ≠ 0.3.0)",
    JSON.stringify(missingAssets(expectedAssets(TAG), complete.map((n) => n.replace("0.3.0-arm64.dmg", "9.9.9-arm64.dmg")))) ===
      JSON.stringify(["macOS DMG installer for Apple Silicon (*.dmg carrying 0.3.0 and arm64)"]),
  );
  check(
    "P2-153: version boundaries hold (10.3.0 does not satisfy a 0.3.0 slot)",
    missingAssets(expectedAssets(TAG), complete.map((n) => n.replaceAll("0.3.0", "10.3.0"))).length === 5,
  );
  check(
    "P2-153: tag without the leading v is accepted (P2-151 style)",
    tagProblems("0.3.0").length === 0 && missingAssets(expectedAssets("0.3.0"), complete).length === 0,
  );
  check(
    "P2-153: non-semver tag is a problem",
    tagProblems("banana").length === 1 && tagProblems("banana")[0]!.includes("semver"),
  );
  check(
    "P2-153: empty tag is its own problem",
    tagProblems("").length === 1 && tagProblems("")[0]!.includes("empty"),
  );
}


// --- P2-153: release-assets CLI — stdin names, exit codes, fail-closed -------
{
  const repoRoot = join(import.meta.dirname, "..");
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(repoRoot, "scripts", "release-assets.ts");
  const run = (tag: string, input: string): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [tsxEntry, script, tag], { input, encoding: "utf8" });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const names = [
    "OpenCode Remote-0.3.0-arm64.dmg",
    "OpenCode Remote-0.3.0-x64.dmg",
    "OpenCode Remote-0.3.0-arm64.zip",
    "OpenCode Remote-0.3.0-x64.zip",
    "OpenCode Remote Setup 0.3.0.exe",
    "latest-mac.yml",
    "update-mac.json",
    "update-mac-arm64.json",
    "update-mac-x64.json",
    "latest.yml",
  ].join("\n");
  const ok = run("v0.3.0", `${names}\n`);
  check("P2-153: cli exits 0 listing every asset on a complete release", ok.code === 0 && ok.out.includes("release-assets: OK v0.3.0"), ok.out);
  const fail = run("v0.3.0", "");
  check(
    "P2-153: cli exits 1 printing ALL missing labels at once (fail-closed)",
    fail.code === 1 && fail.out.includes("release-assets: FAIL v0.3.0") && (fail.out.match(/  - missing: /g) ?? []).length === 10 && fail.out.includes("10 problem(s) found"),
    fail.out,
  );
  const badTag = run("nope", names);
  check("P2-153: cli rejects a non-semver tag with exit 1", badTag.code === 1 && badTag.out.includes("semver"), badTag.out);
}


// --- P2-153: real-repo assertion — release.yml wires the release-verify job ---
{
  const root = join(import.meta.dirname, "..");
  const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const start = release.indexOf("\n  release-verify:");
  const end = release.indexOf("\n  relay-image:");
  const block = start === -1 || end === -1 || end < start ? "" : release.slice(start, end);
  check(
    "P2-153: release.yml has a release-verify job on ubuntu-latest needing BOTH packaging jobs",
    block.includes("runs-on: ubuntu-latest") && block.includes("needs: [desktop-dmg, desktop-win]"),
  );
  check(
    "P2-153: release-verify deliberately does not need relay-image (opt-in publish, no download asset)",
    !block.includes("relay-image"),
  );
  check(
    "P2-153: release-verify feeds `gh release view --json assets` names into scripts/release-assets.ts",
    block.includes("gh release view") && block.includes("--json assets") && block.includes("scripts/release-assets.ts"),
  );
  check(
    "P2-153: release-verify declares shell: bash (P2-126 lesson)",
    block.includes("shell: bash"),
  );
}


// --- P2-191: macFeedPlan — one Squirrel.Mac feed per architecture ------------
{
  const SLUG = "caiovicentino/opencode-remote";
  const ARM64_ZIP = "OpenCode-Remote-0.3.0-arm64.zip";
  const X64_ZIP = "OpenCode-Remote-0.3.0-x64.zip";
  const META = { notes: "release notes", pubDate: "2026-09-01T12:00:00.000Z" };

  const both = macFeedPlan([ARM64_ZIP, X64_ZIP, "OpenCode-Remote-0.3.0-arm64.dmg", "latest-mac.yml"], "v0.3.0", SLUG, META);
  check(
    "P2-191: both zips present → two feed documents, each pointing at its own architecture's zip",
    both.problems.length === 0 &&
      both.feeds !== null &&
      both.feeds.arm64.url === `https://github.com/${SLUG}/releases/download/v0.3.0/${encodeURIComponent(ARM64_ZIP)}` &&
      both.feeds.x64.url === `https://github.com/${SLUG}/releases/download/v0.3.0/${encodeURIComponent(X64_ZIP)}`,
    JSON.stringify(both),
  );
  check(
    "P2-191: feed documents carry the Squirrel shape (name = bare tag version, notes/pub_date from meta)",
    both.feeds !== null &&
      both.feeds.arm64.name === "0.3.0" &&
      both.feeds.arm64.notes === "release notes" &&
      both.feeds.arm64.pub_date === "2026-09-01T12:00:00.000Z",
    JSON.stringify(both.feeds),
  );
  check(
    "P2-191: 3-argument call works (meta optional, defaults filled)",
    (() => {
      const plan = macFeedPlan([ARM64_ZIP, X64_ZIP], "v0.3.0", SLUG);
      return plan.feeds !== null && plan.feeds.arm64.notes === "" && plan.feeds.arm64.pub_date.length > 0;
    })(),
  );

  const noX64 = macFeedPlan([ARM64_ZIP], "v0.3.0", SLUG, META);
  check(
    "P2-191: x64 zip absent → problem, no feeds (fail-closed)",
    noX64.feeds === null && noX64.problems.length === 1 && noX64.problems[0]!.includes("x64"),
    JSON.stringify(noX64),
  );
  const noArm64 = macFeedPlan([X64_ZIP], "v0.3.0", SLUG, META);
  check(
    "P2-191: arm64 zip absent → problem, no feeds (fail-closed)",
    noArm64.feeds === null && noArm64.problems.length === 1 && noArm64.problems[0]!.includes("arm64"),
    JSON.stringify(noArm64),
  );
  const ambiguous = macFeedPlan([ARM64_ZIP, "OpenCode-Remote-0.3.0-arm64-2.zip", X64_ZIP], "v0.3.0", SLUG, META);
  check(
    "P2-191: two arm64 zips → ambiguous problem listing both names, no feeds",
    ambiguous.feeds === null &&
      ambiguous.problems.length === 1 &&
      ambiguous.problems[0]!.includes("ambiguous") &&
      ambiguous.problems[0]!.includes(ARM64_ZIP),
    JSON.stringify(ambiguous),
  );
  const emptyList = macFeedPlan([], "v0.3.0", SLUG, META);
  check(
    "P2-191: empty file list → problem, no feeds",
    emptyList.feeds === null && emptyList.problems.length === 1 && emptyList.problems[0]!.includes("*.zip"),
    JSON.stringify(emptyList),
  );
  const legacy = macFeedPlan(["OpenCode-Remote-0.3.0-mac.zip"], "v0.3.0", SLUG, META);
  check(
    "P2-191: a name without any architecture satisfies nothing — both arches reported missing",
    legacy.feeds === null &&
      legacy.problems.length === 2 &&
      legacy.problems.every((p) => p.includes("carrying")),
    JSON.stringify(legacy),
  );
  const emptyTag = macFeedPlan([ARM64_ZIP, X64_ZIP], "  ", SLUG, META);
  check(
    "P2-191: empty tag → problem, no feeds",
    emptyTag.feeds === null && emptyTag.problems.length === 1 && emptyTag.problems[0]!.includes("tag is empty"),
    JSON.stringify(emptyTag),
  );

  // Token-boundary discipline: an arch token must sit on a [-_.] boundary.
  check(
    "P2-191: archOfFileName boundaries — x86_64/arm64e/arch-less names match nothing",
    archOfFileName("toolchain-x86_64.zip") === null &&
      archOfFileName("OpenCode-Remote-0.3.0-arm64e.zip") === null &&
      archOfFileName("OpenCode-Remote-0.3.0-mac.zip") === null,
  );
  check(
    "P2-191: archOfFileName hits the real artifact names",
    archOfFileName(ARM64_ZIP) === "arm64" && archOfFileName(X64_ZIP) === "x64",
  );

  // The alias contract, exercised through the real CLI (what the release
  // workflow runs): update-mac.json must be a byte-a-byte alias of the arm64
  // document, and all three files must exist.
  const repoRoot = join(import.meta.dirname, "..");
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(repoRoot, "apps", "desktop", "scripts", "update-feed.mjs");
  const dir = mkdtempSync(join(tmpdir(), "update-feed-"));
  try {
    writeFileSync(join(dir, ARM64_ZIP), "zip");
    writeFileSync(join(dir, X64_ZIP), "zip");
    writeFileSync(join(dir, "latest-mac.yml"), "version: 0.3.0\nreleaseDate: '2026-09-01'\n");
    const cli = spawnSync(process.execPath, [script, "--dist", dir, "--tag", "v0.3.0"], { encoding: "utf8" });
    check(
      "P2-191: CLI writes update-mac-arm64.json, update-mac-x64.json and the update-mac.json alias",
      cli.status === 0 &&
        existsSync(join(dir, "update-mac-arm64.json")) &&
        existsSync(join(dir, "update-mac-x64.json")) &&
        existsSync(join(dir, "update-mac.json")),
      cli.stdout + cli.stderr,
    );
    const arm64Doc = readFileSync(join(dir, "update-mac-arm64.json"), "utf8");
    check(
      "P2-191: the legacy update-mac.json is a byte-a-byte alias of the arm64 document",
      arm64Doc === readFileSync(join(dir, "update-mac.json"), "utf8") && arm64Doc.endsWith("\n"),
    );
    check(
      "P2-191: CLI alias points at the arm64 zip, x64 file at the x64 zip",
      JSON.parse(arm64Doc).url.endsWith(`/${encodeURIComponent(ARM64_ZIP)}`) &&
        JSON.parse(readFileSync(join(dir, "update-mac-x64.json"), "utf8")).url.endsWith(`/${encodeURIComponent(X64_ZIP)}`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// --- P2-191: publicFeedUrl — the darwin feed follows the process architecture -
{
  const BASE = "https://github.com/caiovicentino/opencode-remote/releases/latest/download";
  check(
    "P2-191: darwin arm64 → update-mac-arm64.json",
    publicFeedUrl({}, true, "darwin", "arm64") === `${BASE}/update-mac-arm64.json`,
  );
  check(
    "P2-191: darwin x64 → update-mac-x64.json",
    publicFeedUrl({}, true, "darwin", "x64") === `${BASE}/update-mac-x64.json`,
  );
  check(
    "P2-191: darwin unknown architecture → legacy update-mac.json",
    publicFeedUrl({}, true, "darwin", "ppc64") === `${BASE}/update-mac.json`,
  );
  check(
    "P2-191: win32 → latest.yml regardless of architecture; linux → null",
    publicFeedUrl({}, true, "win32", "x64") === `${BASE}/latest.yml` &&
      publicFeedUrl({}, true, "win32", "arm64") === `${BASE}/latest.yml` &&
      publicFeedUrl({}, true, "linux", "x64") === null,
  );
  check(
    "P2-191: OCR_PUBLIC_UPDATE_FEED is an absolute override — wins over platform AND architecture",
    publicFeedUrl({ OCR_PUBLIC_UPDATE_FEED: "https://fork.dev/feed.json" }, true, "darwin", "arm64") === "https://fork.dev/feed.json" &&
      publicFeedUrl({ OCR_PUBLIC_UPDATE_FEED: "https://fork.dev/feed.json" }, true, "darwin", "x64") === "https://fork.dev/feed.json" &&
      publicFeedUrl({ OCR_PUBLIC_UPDATE_FEED: "https://fork.dev/feed.json" }, true, "win32", "arm64") === "https://fork.dev/feed.json" &&
      publicFeedUrl({ OCR_PUBLIC_UPDATE_FEED: "https://fork.dev/feed.json" }, true, "linux", "x64") === "https://fork.dev/feed.json",
  );
  check(
    "P2-191: unpackaged builds keep no public feed at all",
    publicFeedUrl({}, false, "darwin", "arm64") === null,
  );
}


// --- P2-191: release-assets — the Intel slots are mandatory ------------------
{
  const TAG = "v0.3.0";
  const complete = [
    "OpenCode-Remote-0.3.0-arm64.dmg",
    "OpenCode-Remote-0.3.0-x64.dmg",
    "OpenCode-Remote-0.3.0-arm64.zip",
    "OpenCode-Remote-0.3.0-x64.zip",
    "OpenCode-Remote-Setup-0.3.0.exe",
    "latest-mac.yml",
    "update-mac.json",
    "update-mac-arm64.json",
    "update-mac-x64.json",
    "latest.yml",
  ];
  check(
    "P2-191: complete two-arch release (real electron-builder names) → no problems",
    missingAssets(expectedAssets(TAG), complete).length === 0,
    JSON.stringify(missingAssets(expectedAssets(TAG), complete)),
  );
  const noIntelDmg = missingAssets(expectedAssets(TAG), complete.filter((n) => !n.includes("x64.dmg")));
  check(
    "P2-191: release without the Intel dmg → exactly the Intel dmg slot missing",
    noIntelDmg.length === 1 && noIntelDmg[0]!.includes("Intel") && noIntelDmg[0]!.includes("x64"),
    JSON.stringify(noIntelDmg),
  );
  const noIntelZip = missingAssets(expectedAssets(TAG), complete.filter((n) => !n.includes("x64.zip")));
  check(
    "P2-191: release without the Intel zip → exactly the Intel zip slot missing",
    noIntelZip.length === 1 && noIntelZip[0]!.includes("Intel") && noIntelZip[0]!.includes("x64"),
    JSON.stringify(noIntelZip),
  );
  check(
    "P2-191: release without update-mac-arm64.json → problem",
    (() => {
      const missing = missingAssets(expectedAssets(TAG), complete.filter((n) => n !== "update-mac-arm64.json"));
      return missing.length === 1 && missing[0]!.includes("update-mac-arm64.json");
    })(),
  );
  check(
    "P2-191: release without update-mac-x64.json → problem",
    (() => {
      const missing = missingAssets(expectedAssets(TAG), complete.filter((n) => n !== "update-mac-x64.json"));
      return missing.length === 1 && missing[0]!.includes("update-mac-x64.json");
    })(),
  );
  check(
    "P2-191: the legacy arch-less zip satisfies nothing (Intel download can never be faked)",
    missingAssets(expectedAssets(TAG), complete.map((n) => n.replace("-x64.zip", "-mac.zip"))).length === 1,
  );
}


// --- P2-191: real-repo assertion — the builder yml declares both arches -------
{
  const root = join(import.meta.dirname, "..");
  const ebYml = readFileSync(join(root, "apps", "desktop", "electron-builder.yml"), "utf8");
  const macBlock = ebYml.slice(ebYml.indexOf("\nmac:"), ebYml.indexOf("\ndmg:"));
  check(
    "P2-191: electron-builder.yml declares dmg with arch [arm64, x64]",
    /- target: dmg\s*\n\s*arch: \[arm64, x64\]/.test(macBlock),
    macBlock,
  );
  check(
    "P2-191: electron-builder.yml declares zip with arch [arm64, x64]",
    /- target: zip\s*\n\s*arch: \[arm64, x64\]/.test(macBlock),
    macBlock,
  );
  check(
    "P2-191: the dir target keeps no arch (dist:smoke stays host-arch and fast)",
    macBlock.includes("- target: dir") && !/- target: dir\s*\n\s*arch:/.test(macBlock),
    macBlock,
  );
  // The workflow must upload every feed file the CLI now writes, or the two
  // new release-verify slots could never be satisfied by a real release.
  const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  check(
    "P2-191: release.yml desktop-dmg uploads the per-arch feed files (update-mac*.json)",
    release.includes("apps/desktop/dist/update-mac*.json"),
  );
}


// --- P2-154: relay TLS pair preflight is fail-closed -------------------------
{
  // the readable probe is injected, so every scenario below stays pure —
  // no filesystem, no real paths
  const readableAll = () => true;
  const readableNone = () => false;

  const ok = tlsPlan({ RELAY_TLS_CERT: "/certs/relay.pem", RELAY_TLS_KEY: "/certs/relay.key" }, readableAll);
  check(
    "P2-154: cert+key defined and readable → mode tls with both paths resolved and zero problems",
    ok.mode === "tls" && ok.certPath === "/certs/relay.pem" && ok.keyPath === "/certs/relay.key" && ok.problems.length === 0,
  );

  const plain = tlsPlan({}, readableAll);
  check(
    "P2-154: empty env → plain without problems (provider TLS in front is the documented mode)",
    plain.mode === "plain" && plain.certPath === "" && plain.keyPath === "" && plain.problems.length === 0,
  );

  const onlyCert = tlsPlan({ RELAY_TLS_CERT: "/certs/relay.pem" }, readableAll);
  check(
    "P2-154: only RELAY_TLS_CERT defined is a problem citing the variable",
    onlyCert.mode !== "tls" && onlyCert.problems.length === 1 && onlyCert.problems[0]!.includes("RELAY_TLS_CERT"),
  );

  const onlyKey = tlsPlan({ RELAY_TLS_KEY: "/certs/relay.key" }, readableAll);
  check(
    "P2-154: only RELAY_TLS_KEY defined is a problem citing the variable",
    onlyKey.mode !== "tls" && onlyKey.problems.length === 1 && onlyKey.problems[0]!.includes("RELAY_TLS_KEY"),
  );

  const blankCert = tlsPlan({ RELAY_TLS_CERT: "   ", RELAY_TLS_KEY: "/certs/relay.key" }, readableAll);
  check(
    "P2-154: blank RELAY_TLS_CERT value is a problem, never silently ignored",
    blankCert.mode !== "tls" && blankCert.problems.some((p) => p.includes("RELAY_TLS_CERT")),
  );

  const blankKey = tlsPlan({ RELAY_TLS_CERT: "/certs/relay.pem", RELAY_TLS_KEY: "" }, readableAll);
  check(
    "P2-154: empty-string RELAY_TLS_KEY is a problem too (set-but-blank ≠ absent)",
    blankKey.mode !== "tls" && blankKey.problems.some((p) => p.includes("RELAY_TLS_KEY")),
  );

  const unreadable = tlsPlan(
    { RELAY_TLS_CERT: "/etc/secret/live/relay.pem", RELAY_TLS_KEY: "/etc/secret/live/relay.key" },
    readableNone,
  );
  check(
    "P2-154: unreadable files are two problems that cite each variable and NEVER leak the path",
    unreadable.mode !== "tls" &&
      unreadable.problems.length === 2 &&
      unreadable.problems.some((p) => p.includes("RELAY_TLS_CERT")) &&
      unreadable.problems.some((p) => p.includes("RELAY_TLS_KEY")) &&
      unreadable.problems.every((p) => !p.includes("/etc/secret")),
  );

  const halfUnreadable = tlsPlan(
    { RELAY_TLS_CERT: "/etc/secret/live/relay.pem", RELAY_TLS_KEY: "/etc/secret/live/relay.key" },
    (p) => p.endsWith(".key"),
  );
  check(
    "P2-154: only the failing side is blamed when one file is unreadable",
    halfUnreadable.problems.length === 1 && halfUnreadable.problems[0]!.includes("RELAY_TLS_CERT"),
  );
}


// --- desktop update recheck schedule (P2-155) --------------------------------
{
  const BASE = UPDATE_RECHECK_BASE_MS;
  const successStatuses = ["update-not-available", "update-available", "update-available-manual"] as const;
  const failureStatuses = ["feed-unreachable", "unrecognized-feed"] as const;
  const JITTER_MIN = BASE * (1 - UPDATE_RECHECK_JITTER); // 19_440_000 (5.4 h)
  const JITTER_MAX = BASE * (1 + UPDATE_RECHECK_JITTER); // 23_760_000 (6.6 h)

  // 1. all seven statuses
  check("P2-155: disabled → null (no surface, zero timers)", nextCheckDelayMs("disabled", 0, Math.random) === null);
  check(
    "P2-155: update-downloaded → null (consent already offered, only restart applies)",
    nextCheckDelayMs("update-downloaded", 0, Math.random) === null,
  );
  for (const s of successStatuses) {
    const d = nextCheckDelayMs(s, 0, Math.random);
    check(`P2-155: ${s} → base interval with jitter`, d !== null && d >= JITTER_MIN && d <= JITTER_MAX);
  }
  for (const s of failureStatuses) {
    const d = nextCheckDelayMs(s, 1, Math.random);
    check(`P2-155: ${s} → first backoff step (15 min)`, d === 900_000);
  }

  // 2. jitter bounds are exact
  for (const s of successStatuses) {
    check(
      `P2-155: ${s} with random()=0 → exactly 0.9 × base`,
      nextCheckDelayMs(s, 0, () => 0) === 19_440_000,
    );
    const d = nextCheckDelayMs(s, 0, () => 0.999999)!;
    check(
      `P2-155: ${s} with random()=0.999999 → just under 1.1 × base`,
      d > 23_759_000 && d < 23_760_001,
    );
  }

  // 3. exponential backoff grows per consecutive failure (no random read)
  for (const s of failureStatuses) {
    check(
      `P2-155: ${s} backoff 1/2/3 failures → 15/30/60 min`,
      nextCheckDelayMs(s, 1, Math.random) === 900_000 &&
        nextCheckDelayMs(s, 2, Math.random) === 1_800_000 &&
        nextCheckDelayMs(s, 3, Math.random) === 3_600_000,
    );
  }

  // 4. backoff saturates at the base interval
  for (const s of failureStatuses) {
    check(
      `P2-155: ${s} 10 and 50 failures cap at the 6 h base`,
      nextCheckDelayMs(s, 10, Math.random) === 21_600_000 && nextCheckDelayMs(s, 50, Math.random) === 21_600_000,
    );
  }

  // 5. hard floor: no random and no counter can go below 5 min
  const hostileRandoms = [() => 0, () => -1, () => 1, () => Number.NaN];
  for (const s of [...successStatuses, ...failureStatuses]) {
    for (const r of hostileRandoms) {
      const d = nextCheckDelayMs(s, 0, r);
      check(`P2-155: ${s} floor holds (random=${r.name || "anon"})`, d === null || d >= 300_000);
    }
  }
  check(
    "P2-155: random()=1 stays within the +10% ceiling (no runaway)",
    nextCheckDelayMs("update-not-available", 0, () => 1) === Math.round(JITTER_MAX),
  );

  // 6. the failure counter is normalized: negative/fractional/NaN → 0
  for (const bad of [-1, -99, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    check(
      `P2-155: consecutiveFailures=${bad} behaves as 0 (15 min first step)`,
      nextCheckDelayMs("feed-unreachable", bad, Math.random) === UPDATE_RECHECK_BACKOFF_START_MS,
    );
  }

  // 7. the real main.ts arms the timer from the resolved status and cleans up on quit
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const willQuitAt = mainSrc.indexOf('app.on("will-quit"');
  const willQuitHandler = willQuitAt >= 0 ? mainSrc.slice(willQuitAt, willQuitAt + 600) : "";
  check(
    "P2-155: main.ts schedules runUpdateCheck('scheduled') via a guarded setTimeout",
    mainSrc.includes("nextCheckDelayMs") &&
      mainSrc.includes('runUpdateCheck("scheduled")') &&
      /updateRecheckTimer = setTimeout\(/.test(mainSrc) &&
      mainSrc.includes("if (!updatesEnabled()) return;"),
  );
  check(
    "P2-155: will-quit clears the recheck timer before the daemon teardown",
    willQuitHandler.includes("clearTimeout(updateRecheckTimer)") &&
      willQuitHandler.indexOf("clearTimeout(updateRecheckTimer)") < willQuitHandler.indexOf("if (daemonStopped) return;") &&
      willQuitHandler.includes("updateRecheckTimer = null"),
  );
  check(
    "P2-155: schedule constants are 6 h base / 5 min floor / 15 min backoff start",
    BASE === 21_600_000 && UPDATE_RECHECK_MIN_MS === 300_000 && UPDATE_RECHECK_BACKOFF_START_MS === 900_000,
  );
}


// --- P2-156: relay close-code triage (pure classifier + floor/max rule) ------

{
  // 1. the five kinds with the exact codes/reasons apps/relay/src emits
  const busy = classifyRelayClose(1013, "server busy");
  const tooMany = classifyRelayClose(1013, "too many connections");
  const roomFull = classifyRelayClose(1013, "room full");
  check(
    "P2-156: all three 1013 reasons classify as capacity",
    busy.kind === "capacity" && tooMany.kind === "capacity" && roomFull.kind === "capacity",
  );
  check("P2-156: 4029 rate limited classifies as rate-limited", classifyRelayClose(4029, "rate limited").kind === "rate-limited");
  check("P2-156: 1001 shutdown classifies as draining", classifyRelayClose(1001, "server shutting down").kind === "draining");
  check("P2-156: 1000 classifies as normal", classifyRelayClose(1000, "").kind === "normal");
  check("P2-156: 1006 abrupt drop classifies as transient", classifyRelayClose(1006, "").kind === "transient");

  // 2. reason is corroboration only: empty/unknown still classify by code
  check("P2-156: 1013 with empty reason falls to capacity by code", classifyRelayClose(1013, "").kind === "capacity");
  check("P2-156: 1013 with unknown reason falls to capacity by code", classifyRelayClose(1013, "some other reason").kind === "capacity");
  check("P2-156: 4029 with empty reason falls to rate-limited by code", classifyRelayClose(4029, "").kind === "rate-limited");
  check("P2-156: 1001 with unknown reason falls to draining by code", classifyRelayClose(1001, "whatever").kind === "draining");
  check("P2-156: unknown code with any reason falls to transient", classifyRelayClose(4321, "server busy").kind === "transient");

  // 3. undefined code (abnormal death, no close frame) → transient
  check("P2-156: undefined code is transient", classifyRelayClose(undefined, "").kind === "transient");
  check("P2-156: undefined code has zero floor", classifyRelayClose(undefined).floorMs === 0);

  // 4. per-kind floors
  check(
    "P2-156: floors are 30s capacity / 60s rate-limited / 0 others",
    classifyRelayClose(1013).floorMs === 30_000 &&
      classifyRelayClose(4029).floorMs === 60_000 &&
      classifyRelayClose(1001).floorMs === 0 &&
      classifyRelayClose(1000).floorMs === 0 &&
      classifyRelayClose(1006).floorMs === 0,
  );

  // 5. hints are pt-BR operator copy: no paths, URLs, tokens or room ids
  const hints = [1013, 4029, 1001, 1000, 1006, undefined].map((c) => classifyRelayClose(c as number | undefined).hint);
  check(
    "P2-156: every kind ships a non-empty hint free of secrets",
    hints.every((h) => h.length > 0 && !h.includes("/") && !h.includes("ws") && !h.includes("room")),
  );

  // 6. max(floor, jitter): capacity never re-dials before 30s, transient = P2-129
  const capacityVerdict = classifyRelayClose(1013);
  check("P2-156: capacity floor dominates any jittered schedule", effectiveRetryDelayMs(0, capacityVerdict) === 30_000 && effectiveRetryDelayMs(30_000, capacityVerdict) === 30_000 && effectiveRetryDelayMs(120_000, capacityVerdict) === 120_000);
  const rateVerdict = classifyRelayClose(4029);
  check("P2-156: rate-limited floor dominates any jittered schedule", effectiveRetryDelayMs(0, rateVerdict) === 60_000 && effectiveRetryDelayMs(60_000, rateVerdict) === 60_000);
  const transientVerdict = classifyRelayClose(1006);
  check(
    "P2-156: transient defers entirely to the jittered P2-129 schedule",
    effectiveRetryDelayMs(0, transientVerdict) === 0 &&
      effectiveRetryDelayMs(2_000, transientVerdict) === 2_000 &&
      effectiveRetryDelayMs(30_000, transientVerdict) === 30_000,
  );
  for (const kind of ["draining", "normal"] as const) {
    const v = classifyRelayClose(kind === "draining" ? 1001 : 1000);
    check(`P2-156: ${kind} defers entirely to the jittered schedule`, effectiveRetryDelayMs(7_500, v) === 7_500);
  }
  // walk the real P2-129 curve with a pinned random: transient delays must be
  // byte-for-byte what the retry module alone would produce
  const withFloor = createRelayRetry({ random: () => 0.3 });
  const pure = createRelayRetry({ random: () => 0.3 });
  let identical = true;
  for (let i = 0; i < 10; i++) {
    identical &&= effectiveRetryDelayMs(withFloor.schedule(), transientVerdict) === pure.schedule();
  }
  check("P2-156: 10 retries under transient match the bare P2-129 curve", identical);
}


// --- P2-157: feed-consistency — update feeds point at this release's artifacts
{
  const TAG = "v0.3.0";
  const published = [
    "OpenCode Remote-0.3.0-arm64.dmg",
    "OpenCode Remote-0.3.0-mac.zip",
    "OpenCode Remote Setup 0.3.0.exe",
    "latest-mac.yml",
    "update-mac.json",
    "latest.yml",
  ];
  const goodZip = "OpenCode Remote-0.3.0-mac.zip";
  const goodExe = "OpenCode Remote Setup 0.3.0.exe";
  const json = (name: string, zip: string): string =>
    JSON.stringify({
      url: `https://github.com/caiovicentino/opencode-remote/releases/download/v0.3.0/${encodeURIComponent(zip)}`,
      name,
      notes: "release notes",
      pub_date: "2026-09-01T12:00:00.000Z",
    });
  const yml = (version: string, path: string): string =>
    `version: ${version}\nfiles:\n  - url: ${path}\n    sha512: abcd\n    size: 123\npath: '${path}'\nsha512: abcd\nreleaseName: ${version}\nreleaseDate: '2026-09-01'\n`;
  const goodJson = json("0.3.0", goodZip);
  const goodYml = yml("0.3.0", goodExe);

  check(
    "P2-157: coherent feed pair (json + yml pointing at this tag's artifacts) has no problems",
    feedProblems(TAG, goodJson, goodYml, published).length === 0,
  );
  check(
    "P2-157: tag without the leading v is accepted (P2-151 style)",
    feedProblems("0.3.0", goodJson, goodYml, published).length === 0,
  );

  const oldName = feedProblems(TAG, json("0.2.9", goodZip), goodYml, published);
  check(
    "P2-157: json \"name\" carrying an old version is a problem",
    oldName.length === 1 && oldName[0]!.includes("0.2.9"),
    JSON.stringify(oldName),
  );
  const missingZip = feedProblems(TAG, json("0.3.0", "OpenCode Remote-0.2.9-mac.zip"), goodYml, published);
  check(
    "P2-157: json \"url\" pointing at a file absent from the published list is a problem",
    missingZip.length === 1 && missingZip[0]!.includes("not published"),
    JSON.stringify(missingZip),
  );
  const ymlVersion = feedProblems(TAG, goodJson, yml("0.2.9", goodExe), published);
  check(
    "P2-157: yml \"version\" diverging from the tag is a problem",
    ymlVersion.length === 1 && ymlVersion[0]!.includes("0.2.9"),
    JSON.stringify(ymlVersion),
  );
  const ymlPath = feedProblems(TAG, goodJson, yml("0.3.0", "OpenCode Remote Setup 0.2.9.exe"), published);
  check(
    "P2-157: yml \"path\" absent from the published list is a problem",
    ymlPath.length === 1 && ymlPath[0]!.includes("not published"),
    JSON.stringify(ymlPath),
  );
  const malformed = feedProblems(TAG, "{not json", goodYml, published);
  check(
    "P2-157: malformed update-mac.json is a problem",
    malformed.length === 1 && malformed[0]!.includes("invalid JSON"),
    JSON.stringify(malformed),
  );
  const noVersion = feedProblems(TAG, goodJson, goodYml.replace(/^version: 0\.3\.0\n/, ""), published);
  check(
    "P2-157: latest.yml without a version field is a problem",
    noVersion.length === 1 && noVersion[0]!.includes("version"),
    JSON.stringify(noVersion),
  );
  const badTag = feedProblems("banana", goodJson, goodYml, published);
  check(
    "P2-157: non-semver tag is a problem",
    badTag.length === 1 && badTag[0]!.includes("semver"),
    JSON.stringify(badTag),
  );
  const emptyTag = feedProblems("", goodJson, goodYml, published);
  check(
    "P2-157: empty tag is its own problem",
    emptyTag.length === 1 && emptyTag[0]!.includes("empty"),
    JSON.stringify(emptyTag),
  );

  // P2-146 lesson: fail closed — ALL problems reported at once, not just the
  // first, so one CI round fixes everything.
  const all = feedProblems(
    TAG,
    json("0.2.9", "OpenCode Remote-0.2.9-mac.zip"),
    yml("0.2.9", "OpenCode Remote Setup 0.2.9.exe"),
    published,
  );
  check(
    "P2-157: every problem is reported at once (json name+url, yml version+path)",
    all.length === 4,
    JSON.stringify(all),
  );
}


// --- P2-157: feed-consistency CLI — feed files by path, names via stdin ------
{
  const repoRoot = join(import.meta.dirname, "..");
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(repoRoot, "scripts", "feed-consistency.ts");
  const dir = mkdtempSync(join(tmpdir(), "feed-consistency-"));
  const jsonPath = join(dir, "update-mac.json");
  const ymlPath = join(dir, "latest.yml");
  const arm64Path = join(dir, "update-mac-arm64.json");
  const x64Path = join(dir, "update-mac-x64.json");
  const squirrelDoc = (zip: string): string =>
    JSON.stringify({
      url: "https://github.com/caiovicentino/opencode-remote/releases/download/v0.3.0/" +
        encodeURIComponent(zip),
      name: "0.3.0",
      notes: "",
      pub_date: "2026-09-01T12:00:00.000Z",
    });
  // P2-191 shape: the alias is a byte-identical copy of the arm64 document.
  writeFileSync(jsonPath, squirrelDoc("OpenCode Remote-0.3.0-arm64.zip"));
  writeFileSync(ymlPath, "version: 0.3.0\npath: 'OpenCode Remote Setup 0.3.0.exe'\n");
  writeFileSync(arm64Path, squirrelDoc("OpenCode Remote-0.3.0-arm64.zip"));
  writeFileSync(x64Path, squirrelDoc("OpenCode Remote-0.3.0-x64.zip"));
  const names = [
    "OpenCode Remote-0.3.0-arm64.dmg",
    "OpenCode Remote-0.3.0-x64.dmg",
    "OpenCode Remote-0.3.0-arm64.zip",
    "OpenCode Remote-0.3.0-x64.zip",
    "OpenCode Remote Setup 0.3.0.exe",
    "latest-mac.yml",
    "update-mac.json",
    "update-mac-arm64.json",
    "update-mac-x64.json",
    "latest.yml",
  ].join("\n");
  const run = (tag: string, input: string): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [tsxEntry, script, tag, jsonPath, ymlPath, arm64Path, x64Path], {
        input,
        encoding: "utf8",
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const ok = run("v0.3.0", `${names}\n`);
  check(
    "P2-157: cli exits 0 when all four feeds point at the release's artifacts",
    ok.code === 0 && ok.out.includes("feed-consistency: OK v0.3.0"),
    ok.out,
  );
  const stale = run("v0.3.0", names.replace("0.3.0-arm64.zip", "0.2.9-arm64.zip"));
  check(
    "P2-157: cli exits 1 printing the stale-feed problem (fail-closed)",
    stale.code === 1 && stale.out.includes("feed-consistency: FAIL v0.3.0") && stale.out.includes("not published"),
    stale.out,
  );
  // P2-212: an unreadable feed never hides the other feeds' problems — every
  // problem prints in a single run (no short-circuit between feeds).
  let mixed: { code: number; out: string };
  try {
    const out = execFileSync(
      process.execPath,
      [tsxEntry, script, "v0.3.0", jsonPath, ymlPath, arm64Path, join(dir, "missing.json")],
      { input: names.replace("OpenCode Remote Setup 0.3.0.exe\n", ""), encoding: "utf8" },
    );
    mixed = { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    mixed = { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
  check(
    "P2-212: unreadable feed and the other feeds' problems all print at once",
    mixed.code === 1 &&
      mixed.out.includes("cannot read") &&
      mixed.out.includes("latest.yml") &&
      mixed.out.includes("not published") &&
      !mixed.out.includes("feed is empty"),
    mixed.out,
  );
  rmSync(dir, { recursive: true, force: true });
}


// --- P2-157: real-repo assertion — release.yml wires the release-feeds job ---
{
  const root = join(import.meta.dirname, "..");
  const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const start = release.indexOf("\n  release-feeds:");
  const block = start === -1 ? "" : release.slice(start);
  check(
    "P2-157: release.yml has a release-feeds job on ubuntu-latest needing BOTH packaging jobs",
    block.includes("runs-on: ubuntu-latest") && block.includes("needs: [desktop-dmg, desktop-win]"),
  );
  check(
    "P2-157: release-feeds downloads both feeds with gh release download",
    block.includes("gh release download") && block.includes("--pattern update-mac.json") && block.includes("--pattern latest.yml"),
  );
  check(
    "P2-157: release-feeds feeds `gh release view --json assets` names into scripts/feed-consistency.ts",
    block.includes("gh release view") && block.includes("--json assets") && block.includes("scripts/feed-consistency.ts"),
  );
  check(
    "P2-157: release-feeds declares shell: bash (P2-126 lesson)",
    block.includes("shell: bash"),
  );
}

// --- P2-212: feed-consistency covers both per-architecture mac feeds ---------
{
  const TAG = "v0.3.0";
  const published = [
    "OpenCode Remote-0.3.0-arm64.dmg",
    "OpenCode Remote-0.3.0-x64.dmg",
    "OpenCode Remote-0.3.0-arm64.zip",
    "OpenCode Remote-0.3.0-x64.zip",
    "OpenCode Remote-0.3.0-mac.zip",
    "OpenCode Remote Setup 0.3.0.exe",
    "latest-mac.yml",
    "update-mac.json",
    "update-mac-arm64.json",
    "update-mac-x64.json",
    "latest.yml",
  ];
  const doc = (name: string, zip: string): string =>
    JSON.stringify({
      url: `https://github.com/caiovicentino/opencode-remote/releases/download/v0.3.0/${encodeURIComponent(zip)}`,
      name,
      notes: "release notes",
      pub_date: "2026-09-01T12:00:00.000Z",
    });
  const ARM64_ZIP = "OpenCode Remote-0.3.0-arm64.zip";
  const X64_ZIP = "OpenCode Remote-0.3.0-x64.zip";
  const LEGACY_ZIP = "OpenCode Remote-0.3.0-mac.zip";
  const goodArm64 = doc("0.3.0", ARM64_ZIP);
  const goodX64 = doc("0.3.0", X64_ZIP);

  check(
    "P2-212: consistent per-arch feeds with an identical alias return zero problems",
    archFeedProblems(TAG, goodArm64, goodArm64, goodX64, published).length === 0,
  );
  check(
    "P2-212: arch token detection follows the P2-191 boundary discipline",
    archOfFileName(ARM64_ZIP) === "arm64" &&
      archOfFileName("OpenCode-Remote-0.3.0-x64.zip") === "x64" &&
      archOfFileName(LEGACY_ZIP) === null &&
      archOfFileName("OpenCode-Remote-0.3.0-arm64e.zip") === null,
  );

  const swapped = archFeedProblems(TAG, doc("0.3.0", X64_ZIP), doc("0.3.0", X64_ZIP), goodX64, published);
  check(
    "P2-212: arm64 feed pointing at the x64 zip is a problem",
    swapped.length === 1 && swapped[0]!.includes("update-mac-arm64.json") && swapped[0]!.includes("arm64 architecture"),
    JSON.stringify(swapped),
  );
  const swappedIntel = archFeedProblems(TAG, goodArm64, goodArm64, doc("0.3.0", ARM64_ZIP), published);
  check(
    "P2-212: x64 feed pointing at the arm64 zip is a problem",
    swappedIntel.length === 1 && swappedIntel[0]!.includes("update-mac-x64.json") && swappedIntel[0]!.includes("x64 architecture"),
    JSON.stringify(swappedIntel),
  );
  const legacyZip = archFeedProblems(TAG, doc("0.3.0", LEGACY_ZIP), doc("0.3.0", LEGACY_ZIP), goodX64, published);
  check(
    "P2-212: per-arch feed pointing at a legacy arch-less zip is a problem",
    legacyZip.length === 1 && legacyZip[0]!.includes("does not carry the arm64 architecture"),
    JSON.stringify(legacyZip),
  );

  const absentDoc = doc("0.3.0", "OpenCode Remote-0.2.9-arm64.zip");
  const absent = archFeedProblems(TAG, absentDoc, absentDoc, goodX64, published);
  check(
    "P2-212: per-arch feed url absent from the published list is a problem",
    absent.length === 1 && absent[0]!.includes("not published"),
    JSON.stringify(absent),
  );
  const wrongNameDoc = doc("0.2.9", ARM64_ZIP);
  const wrongName = archFeedProblems(TAG, wrongNameDoc, wrongNameDoc, goodX64, published);
  check(
    "P2-212: per-arch feed name diverging from the tag version is a problem",
    wrongName.length === 1 && wrongName[0]!.includes("0.2.9"),
    JSON.stringify(wrongName),
  );
  const malformed = archFeedProblems(TAG, "{not json", "{not json", goodX64, published);
  check(
    "P2-212: malformed per-arch feed is a problem",
    malformed.length === 1 && malformed[0]!.includes("update-mac-arm64.json") && malformed[0]!.includes("invalid JSON"),
    JSON.stringify(malformed),
  );
  const missing = archFeedProblems(TAG, goodArm64, "", goodX64, published);
  check(
    "P2-212: missing (empty) per-arch feed is an explicit problem, never a silent skip",
    missing.length === 1 && missing[0]!.includes("update-mac-arm64.json") && missing[0]!.includes("empty"),
    JSON.stringify(missing),
  );
  const emptyYml = feedProblems(TAG, goodArm64, "", published);
  check(
    "P2-212: empty latest.yml is an explicit problem, never a silent skip",
    emptyYml.length === 1 && emptyYml[0]!.includes("latest.yml") && emptyYml[0]!.includes("empty"),
    JSON.stringify(emptyYml),
  );
  const emptyAlias = archFeedProblems(TAG, "", goodArm64, goodX64, published);
  check(
    "P2-212: empty alias feed is an explicit problem, never a silent skip",
    emptyAlias.length === 1 && emptyAlias[0]!.includes("update-mac.json") && emptyAlias[0]!.includes("empty"),
    JSON.stringify(emptyAlias),
  );
  const aliasDrift = archFeedProblems(TAG, goodX64, goodArm64, goodX64, published);
  check(
    "P2-212: alias differing from the arm64 document is a problem",
    aliasDrift.length === 1 && aliasDrift[0]!.includes("update-mac.json") && aliasDrift[0]!.includes("update-mac-arm64.json"),
    JSON.stringify(aliasDrift),
  );

  // P2-146 lesson: fail closed — ALL problems reported at once, never just
  // the first feed's.
  const bothSwapped = archFeedProblems(
    TAG,
    doc("0.3.0", LEGACY_ZIP),
    doc("0.3.0", X64_ZIP),
    doc("0.3.0", ARM64_ZIP),
    published,
  );
  check(
    "P2-212: cross-wired arch feeds and a drifted alias are all reported at once",
    bothSwapped.length === 3 &&
      bothSwapped.some((p) => p.includes("update-mac-arm64.json")) &&
      bothSwapped.some((p) => p.includes("update-mac-x64.json")) &&
      bothSwapped.some((p) => p.includes("alias content differs")),
    JSON.stringify(bothSwapped),
  );

  const emptyPublished = archFeedProblems(TAG, goodArm64, goodArm64, goodX64, []);
  check(
    "P2-212: empty published list makes every per-arch feed a problem",
    emptyPublished.length === 2 && emptyPublished.every((p) => p.includes("not published")),
    JSON.stringify(emptyPublished),
  );

  const badTag = archFeedProblems("banana", goodArm64, goodArm64, goodX64, published);
  check(
    "P2-212: non-semver tag still short-circuits to a single tag problem",
    badTag.length === 1 && badTag[0]!.includes("semver"),
    JSON.stringify(badTag),
  );
  const emptyTag = archFeedProblems("", goodArm64, goodArm64, goodX64, published);
  check(
    "P2-212: empty tag still short-circuits to a single tag problem",
    emptyTag.length === 1 && emptyTag[0]!.includes("empty"),
    JSON.stringify(emptyTag),
  );
}

// --- P2-212: real-repo assertion — release-feeds downloads and checks all four
{
  const root = join(import.meta.dirname, "..");
  const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const start = release.indexOf("\n  release-feeds:");
  const next = release.indexOf("\n  release-publish:", start);
  const block = start === -1 || next === -1 ? "" : release.slice(start, next);
  check(
    "P2-212: release-feeds downloads the two per-architecture feed patterns",
    block.includes("--pattern update-mac-arm64.json") && block.includes("--pattern update-mac-x64.json"),
  );
  check(
    "P2-212: release-feeds passes all four feeds to scripts/feed-consistency.ts",
    block.includes("feeds/update-mac.json") &&
      block.includes("feeds/latest.yml") &&
      block.includes("feeds/update-mac-arm64.json") &&
      block.includes("feeds/update-mac-x64.json") &&
      block.includes("scripts/feed-consistency.ts"),
  );
  check(
    "P2-212: release-feeds declares shell: bash explicitly (P2-126/P2-164 lessons)",
    block.includes("shell: bash"),
  );
}

// --- P2-161: staged feed.json port resolved at serve time ---------------------
{
  const feed = (port: number) =>
    JSON.stringify({ version: "0.2.1", url: `http://127.0.0.1:${port}/__ocr/updates/0.2.1/OpenCode Remote-0.2.1-mac.zip`, name: "0.2.1", notes: "n", pub_date: "2026-01-01T00:00:00Z" });
  const stale = rewriteFeedPort(feed(8792), 8794);
  check(
    "P2-161: stale feed port rewritten to the actually-bound port",
    stale.rewritten === true && stale.body.includes("127.0.0.1:8794/__ocr/updates/0.2.1/OpenCode Remote-0.2.1-mac.zip") && !stale.body.includes(":8792/"),
    stale.body,
  );
  const raw = `{\n  "url": "http://127.0.0.1:8792/__ocr/updates/0.2.1/x.zip",\n  "name": "0.2.1"\n}`;
  const surg = rewriteFeedPort(raw, 8793);
  check(
    "P2-161: rewrite is surgical — rest of the document byte-for-byte",
    surg.rewritten === true && surg.body === raw.replace("8792", "8793"),
    surg.body,
  );
  const current = rewriteFeedPort(feed(8794), 8794);
  check(
    "P2-161: feed already on the bound port → not rewritten, body untouched",
    current.rewritten === false && current.body === feed(8794) && current.reason === "port-current",
  );
  const badJson = rewriteFeedPort("{not json", 8794);
  check(
    "P2-161: invalid JSON returned byte-for-byte (fail-closed)",
    badJson.rewritten === false && badJson.body === "{not json" && badJson.reason === "invalid-json",
  );
  const external = rewriteFeedPort(
    JSON.stringify({ url: "https://example.com/__ocr/updates/0.2.1/x.zip" }),
    8794,
  );
  check(
    "P2-161: external-host url preserved",
    external.rewritten === false && external.reason === "non-loopback" && external.body.includes("example.com"),
  );
  const otherRoute = rewriteFeedPort(
    JSON.stringify({ url: "http://127.0.0.1:8792/api/health" }),
    8794,
  );
  check(
    "P2-161: loopback url outside the updates route preserved",
    otherRoute.rewritten === false && otherRoute.reason === "foreign-path" && otherRoute.body.includes(":8792/api/health"),
  );
  const noUrl = rewriteFeedPort('{"version":"0.2.1"}', 8794);
  check(
    "P2-161: feed without url field preserved",
    noUrl.rewritten === false && noUrl.reason === "no-url" && noUrl.body === '{"version":"0.2.1"}',
  );
  const zero = rewriteFeedPort(feed(8792), 0);
  const negative = rewriteFeedPort(feed(8792), -1);
  const nan = rewriteFeedPort(feed(8792), Number.NaN);
  const huge = rewriteFeedPort(feed(8792), 65536);
  check(
    "P2-161: zero/invalid bound port → no rewrite",
    zero.rewritten === false && negative.rewritten === false && nan.rewritten === false && huge.rewritten === false && zero.reason === "invalid-port" && zero.body === feed(8792),
  );
}

// --- P2-180: JSON request-body ceiling (bodylimit.ts) --------------------------
{
  // fake reader: synchronous emit surface so tests drive data/end/error by hand
  const makeReader = () => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const on = (event: string, listener: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return undefined;
    };
    const emit = (event: string, ...args: unknown[]) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    };
    return { on, emit } as LimitedBodyReader & { emit(event: string, ...args: unknown[]): void };
  };

  // -- bodyLimit: env matrix ---------------------------------------------------
  const empty = bodyLimit({});
  check(
    "P2-180: missing env keeps the 1MB default with no problem",
    empty.limit === MAX_JSON_BODY_BYTES && MAX_JSON_BODY_BYTES === 1_000_000 && empty.problems.length === 0,
  );
  const blank = bodyLimit({ OCR_MAX_BODY_BYTES: "   " });
  check(
    "P2-180: blank env keeps the default with no problem",
    blank.limit === MAX_JSON_BODY_BYTES && blank.problems.length === 0,
  );
  const valid = bodyLimit({ OCR_MAX_BODY_BYTES: "2000000" });
  check(
    "P2-180: valid value resolves to the requested ceiling",
    valid.limit === 2_000_000 && valid.problems.length === 0,
  );
  const nonNumeric = bodyLimit({ OCR_MAX_BODY_BYTES: "abc" });
  check(
    "P2-180: non-numeric value is a problem",
    nonNumeric.problems.length === 1 && nonNumeric.problems[0]!.includes("OCR_MAX_BODY_BYTES"),
  );
  const negative = bodyLimit({ OCR_MAX_BODY_BYTES: "-1" });
  check("P2-180: negative value is a problem", negative.problems.length === 1);
  const zeroVal = bodyLimit({ OCR_MAX_BODY_BYTES: "0" });
  check("P2-180: zero is a problem", zeroVal.problems.length === 1);
  const fractional = bodyLimit({ OCR_MAX_BODY_BYTES: "1.5" });
  check("P2-180: fractional value is a problem", fractional.problems.length === 1);
  const aboveCeiling = bodyLimit({ OCR_MAX_BODY_BYTES: String(MAX_JSON_BODY_CEILING_BYTES + 1) });
  check("P2-180: above the documented ceiling is a problem", aboveCeiling.problems.length === 1);
  const atCeiling = bodyLimit({ OCR_MAX_BODY_BYTES: String(MAX_JSON_BODY_CEILING_BYTES) });
  check(
    "P2-180: exactly at the documented ceiling is accepted",
    atCeiling.limit === MAX_JSON_BODY_CEILING_BYTES && atCeiling.problems.length === 0,
  );

  // -- overLimit matrix ----------------------------------------------------------
  check(
    "P2-180: overLimit is strict — exactly at the limit fits, one byte over aborts",
    overLimit(MAX_JSON_BODY_BYTES, MAX_JSON_BODY_BYTES) === false &&
      overLimit(MAX_JSON_BODY_BYTES + 1, MAX_JSON_BODY_BYTES) === true &&
      overLimit(0, MAX_JSON_BODY_BYTES) === false,
  );

  // -- readLimitedBody with a fake reader ----------------------------------------
  await (async () => {
    const whole = makeReader();
    const wholeP = readLimitedBody(whole, 100);
    whole.emit("data", "hello ");
    whole.emit("data", Buffer.from("world", "utf8"));
    whole.emit("end");
    check("P2-180: within-limit body resolves whole (string + Buffer chunks)", (await wholeP) === "hello world");

    // multi-chunk body summed in BYTES, not characters: "áé" is 4 utf-8 bytes,
    // "í" is 2 — 6 bytes total crosses a 5-byte limit, 3 chars would not
    const bytewise = makeReader();
    const bytewiseP = readLimitedBody(bytewise, 5);
    bytewise.emit("data", "áé");
    bytewise.emit("data", "í");
    const bytewiseErr = await bytewiseP.then(
      () => null,
      (e) => e,
    );
    check(
      "P2-180: chunks are summed in bytes, not characters (6 bytes > 5 limit rejects)",
      isBodyLimitError(bytewiseErr) && bytewiseErr.bytes === 6 && bytewiseErr.limit === 5,
    );

    const multiOk = makeReader();
    const multiOkP = readLimitedBody(multiOk, 6);
    multiOk.emit("data", "áé");
    multiOk.emit("data", "í");
    multiOk.emit("end");
    check("P2-180: 6 utf-8 bytes at a 6 limit resolves intact", (await multiOkP) === "áéí");

    // a multi-byte char SPLIT across Buffer chunks survives (Buffer concat,
    // never string-append of raw chunks)
    const split = makeReader();
    const splitP = readLimitedBody(split, 10);
    const wholeChar = Buffer.from("á", "utf8");
    split.emit("data", wholeChar.subarray(0, 1));
    split.emit("data", wholeChar.subarray(1));
    split.emit("end");
    check("P2-180: a multi-byte char split across Buffer chunks resolves intact", (await splitP) === "á");

    // accumulation stops at the moment of refusal: chunks pushed after the
    // abort are never counted, and a later end cannot flip reject → resolve
    const stop = makeReader();
    const stopP = readLimitedBody(stop, 5);
    let stopSettled = false;
    let stopErr: unknown;
    let stopBody: string | undefined;
    stopP.then(
      (t) => {
        stopSettled = true;
        stopBody = t;
      },
      (e) => {
        stopSettled = true;
        stopErr = e;
      },
    );
    stop.emit("data", "áá"); // 4 bytes — fits
    stop.emit("data", "í"); // 6 > 5 → aborts here with bytes=6
    stop.emit("data", "!!!!!"); // post-abort: must be ignored
    stop.emit("end"); // post-abort: must not resolve
    await Promise.resolve();
    check(
      "P2-180: accumulation stops at the refusal point (later chunks ignored, still rejected)",
      stopSettled && isBodyLimitError(stopErr) && stopErr.bytes === 6 && stopBody === undefined,
    );

    const over = makeReader();
    const overP = readLimitedBody(over, MAX_JSON_BODY_BYTES);
    over.emit("data", Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 0x61));
    const overErr = await overP.then(
      () => null,
      (e) => e,
    );
    check(
      "P2-180: body above the default limit rejects with the recognizable limit error",
      isBodyLimitError(overErr) && overErr.bytes === MAX_JSON_BODY_BYTES + 1,
    );

    const boom = makeReader();
    const boomP = readLimitedBody(boom, 100);
    boom.emit("data", "partial");
    boom.emit("error", new Error("boom"));
    const boomErr = await boomP.then(
      (t) => t,
      (e) => e,
    );
    check(
      "P2-180: reader error propagates instead of resolving an empty/partial body",
      boomErr instanceof Error && boomErr.message === "boom",
    );
  })();

  // -- the real index.ts: upload route stays out of readBody ----------------------
  const daemonSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const uploadAt = daemonSrc.indexOf("/__ocr/upload/complete");
  const uploadEnd = daemonSrc.indexOf("resolve image attachments", uploadAt);
  const uploadSlice = uploadAt >= 0 && uploadEnd > uploadAt ? daemonSrc.slice(uploadAt, uploadEnd) : "";
  check(
    "P2-180: the upload route keeps its own OCR_UPLOAD_MAX_MB cap and never reads through readBody",
    uploadSlice.includes("OCR_UPLOAD_MAX_MB") && !uploadSlice.includes("readBody("),
  );
  check(
    "P2-180: readBody delegates to readLimitedBody with the boot-resolved ceiling",
    daemonSrc.includes("return readLimitedBody(req, bodyLimitResolution.limit)"),
  );
  check(
    "P2-180: boot is fail-closed — logs each problem and exits 1 before opening listeners",
    /for \(const problem of bodyLimitResolution\.problems\) log\("error", problem\)/.test(daemonSrc) &&
      /bodyLimitResolution\.problems\.length > 0[\s\S]{0,400}process\.exit\(1\)/.test(daemonSrc),
  );
}

// --- P2-181: chunk-staging ceilings (chunkstore.ts) -----------------------------
{
  // -- chunkStoreLimits: env matrix ---------------------------------------------
  const defaults = chunkStoreLimits({});
  check(
    "P2-181: missing env keeps today's defaults (200MB decoded, 8 ids, 100k index, 5min) with no problem",
    defaults.problems.length === 0 &&
      defaults.decodedBytes === DEFAULT_UPLOAD_MAX_MB * 1_000_000 &&
      DEFAULT_UPLOAD_MAX_MB === 200 &&
      defaults.maxStagedIds === DEFAULT_MAX_STAGED_IDS &&
      DEFAULT_MAX_STAGED_IDS === 8 &&
      defaults.maxChunkIndex === DEFAULT_MAX_CHUNK_INDEX &&
      DEFAULT_MAX_CHUNK_INDEX === 100_000 &&
      defaults.expirationMs === DEFAULT_EXPIRATION_MS &&
      DEFAULT_EXPIRATION_MS === 300_000,
  );
  const blank = chunkStoreLimits({ OCR_UPLOAD_MAX_MB: "   " });
  check(
    "P2-181: blank env keeps the defaults with no problem",
    blank.problems.length === 0 && blank.decodedBytes === DEFAULT_UPLOAD_MAX_MB * 1_000_000,
  );
  const valid = chunkStoreLimits({ OCR_UPLOAD_MAX_MB: "500" });
  check(
    "P2-181: valid value resolves the decoded ceiling and derives staging with the base64 slack + fixed margin",
    valid.problems.length === 0 &&
      valid.decodedBytes === 500_000_000 &&
      valid.stagingBytesPerId === stagingCapBytes(500_000_000) &&
      stagingCapBytes(500_000_000) === Math.ceil((500_000_000 * 4) / 3) + STAGING_MARGIN_BYTES,
  );
  check(
    "P2-181: default staging cap fits a legitimate 200MB upload's full base64 wire size",
    stagingCapBytes(200_000_000) >= 4 * Math.ceil(200_000_000 / 3),
  );
  const nonNumeric = chunkStoreLimits({ OCR_UPLOAD_MAX_MB: "abc" });
  check(
    "P2-181: non-numeric value is a problem",
    nonNumeric.problems.length === 1 && nonNumeric.problems[0]!.includes("OCR_UPLOAD_MAX_MB"),
  );
  const negative = chunkStoreLimits({ OCR_UPLOAD_MAX_MB: "-1" });
  check("P2-181: negative value is a problem", negative.problems.length === 1);
  const zeroVal = chunkStoreLimits({ OCR_UPLOAD_MAX_MB: "0" });
  check("P2-181: zero is a problem", zeroVal.problems.length === 1);
  const fractional = chunkStoreLimits({ OCR_UPLOAD_MAX_MB: "1.5" });
  check("P2-181: fractional value is a problem", fractional.problems.length === 1);
  const aboveCeiling = chunkStoreLimits({ OCR_UPLOAD_MAX_MB: String(UPLOAD_MAX_MB_CEILING + 1) });
  check("P2-181: above the documented ceiling is a problem", aboveCeiling.problems.length === 1);
  const atCeiling = chunkStoreLimits({ OCR_UPLOAD_MAX_MB: String(UPLOAD_MAX_MB_CEILING) });
  check(
    "P2-181: exactly at the documented ceiling is accepted",
    atCeiling.problems.length === 0 && atCeiling.decodedBytes === UPLOAD_MAX_MB_CEILING * 1_000_000,
  );

  // -- chunkIndexProblem matrix -------------------------------------------------
  check(
    "P2-181: chunkIndexProblem accepts 0 and the maximum index",
    chunkIndexProblem(0, DEFAULT_MAX_CHUNK_INDEX) === null &&
      chunkIndexProblem(DEFAULT_MAX_CHUNK_INDEX, DEFAULT_MAX_CHUNK_INDEX) === null,
  );
  check(
    "P2-181: chunkIndexProblem refuses negative, fractional, non-numeric and above-max indices",
    chunkIndexProblem(-1, DEFAULT_MAX_CHUNK_INDEX) !== null &&
      chunkIndexProblem(1.5, DEFAULT_MAX_CHUNK_INDEX) !== null &&
      chunkIndexProblem(Number.NaN, DEFAULT_MAX_CHUNK_INDEX) !== null &&
      chunkIndexProblem(Number.POSITIVE_INFINITY, DEFAULT_MAX_CHUNK_INDEX) !== null &&
      chunkIndexProblem("2", DEFAULT_MAX_CHUNK_INDEX) !== null &&
      chunkIndexProblem(DEFAULT_MAX_CHUNK_INDEX + 1, DEFAULT_MAX_CHUNK_INDEX) !== null,
  );

  // -- stagedOverLimit: strictly above, exactly at the cap still fits ------------
  check(
    "P2-181: stagedOverLimit is strict — exactly at the staging cap fits, one byte over refuses",
    stagedOverLimit(0, 10, 10) === false &&
      stagedOverLimit(5, 5, 10) === false &&
      stagedOverLimit(5, 6, 10) === true &&
      stagedOverLimit(0, 11, 10) === true,
  );

  // -- expiredKeys: only stale keys, never fresh ones, nothing mutated ----------
  {
    const now = 1_000_000;
    const entries = [
      { key: "stale", at: now - DEFAULT_EXPIRATION_MS - 1 },
      { key: "fresh", at: now - DEFAULT_EXPIRATION_MS + 1 },
      { key: "just-touched", at: now },
    ];
    const snapshot = JSON.stringify(entries);
    const keys = expiredKeys(entries, now, DEFAULT_EXPIRATION_MS);
    check(
      "P2-181: expiredKeys returns only the expired entries, never the recent ones, without mutating",
      keys.length === 1 &&
        keys[0] === "stale" &&
        !keys.includes("fresh") &&
        !keys.includes("just-touched") &&
        JSON.stringify(entries) === snapshot,
    );
    check("P2-181: expiredKeys over an empty map returns an empty list", expiredKeys([], now, DEFAULT_EXPIRATION_MS).length === 0);
  }

  // -- admitNewUpload: at the ceiling no new id fits ------------------------------
  check(
    "P2-181: admitNewUpload admits below the ceiling and refuses exactly at/above it",
    admitNewUpload(0, DEFAULT_MAX_STAGED_IDS) === true &&
      admitNewUpload(DEFAULT_MAX_STAGED_IDS - 1, DEFAULT_MAX_STAGED_IDS) === true &&
      admitNewUpload(DEFAULT_MAX_STAGED_IDS, DEFAULT_MAX_STAGED_IDS) === false &&
      admitNewUpload(DEFAULT_MAX_STAGED_IDS + 1, DEFAULT_MAX_STAGED_IDS) === false,
  );

  // -- the real index.ts: both chunk routes bounded, completion cap untouched ----
  const daemonSrc181 = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const stagerStart = daemonSrc181.indexOf("function stageChunk");
  const firstHandler = daemonSrc181.indexOf('"/__ocr/transcribe/chunk" && req.method === "POST"', stagerStart);
  const stager = stagerStart >= 0 && firstHandler > stagerStart ? daemonSrc181.slice(stagerStart, firstHandler) : "";
  const warnLogs = stager.match(/log\("warn", [^\n]+/g) ?? [];
  check(
    "P2-181: the shared stager validates the index and runs the expiration sweep before admitting",
    stager.includes("chunkIndexProblem(") &&
      stager.includes("expiredKeys(") &&
      stager.includes("stagedOverLimit(") &&
      stager.includes("admitNewUpload(") &&
      stager.indexOf("expiredKeys(") < stager.indexOf("admitNewUpload(") &&
      stager.indexOf("chunkIndexProblem(") < stager.indexOf("stagedOverLimit("),
  );
  check(
    "P2-181: stager refusal logs carry only the route and the refused size (never content or ids)",
    warnLogs.length === 2 &&
      warnLogs.every((line) => line.includes("{ route, bytes:") && !line.includes("id") && !line.includes("data")),
  );
  const transcribeChunkAt = daemonSrc181.indexOf('/__ocr/transcribe/chunk" && req.method === "POST"');
  const uploadChunkAt = daemonSrc181.indexOf('/__ocr/upload/chunk" && req.method === "POST"');
  check(
    "P2-181: BOTH chunk routes delegate to the bounded stager",
    transcribeChunkAt >= 0 &&
      uploadChunkAt > transcribeChunkAt &&
      daemonSrc181.includes('stageChunk(req, "/__ocr/transcribe/chunk")') &&
      daemonSrc181.includes('stageChunk(req, "/__ocr/upload/chunk")'),
  );
  const completeAt = daemonSrc181.indexOf("/__ocr/upload/complete");
  const completeEnd = daemonSrc181.indexOf("resolve image attachments", completeAt);
  const completeSlice = completeAt >= 0 && completeEnd > completeAt ? daemonSrc181.slice(completeAt, completeEnd) : "";
  check(
    "P2-181: the completion route keeps its own decoded OCR_UPLOAD_MAX_MB cap and 413",
    completeSlice.includes("OCR_UPLOAD_MAX_MB") && completeSlice.includes("413"),
  );
  check(
    "P2-181: boot is fail-closed for the chunk limits — logs each problem and exits 1",
    /for \(const problem of chunkLimits\.problems\) log\("error", problem\)/.test(daemonSrc181) &&
      /chunkLimits\.problems\.length > 0[\s\S]{0,400}process\.exit\(1\)/.test(daemonSrc181),
  );
}

// --- P2-159: Windows signing profile — own WIN_CSC_* secrets, never Apple CSC --
{
  const pEmpty = signingProfileWin({});
  check(
    "P2-159: empty env → unsigned with no problems",
    pEmpty.mode === "unsigned" && pEmpty.reasons.length === 0,
  );
  const pMissingSecrets = signingProfileWin({ WIN_CSC_LINK: "", WIN_CSC_KEY_PASSWORD: "" });
  check(
    "P2-159: blank-string secrets (Actions renders missing secrets as \"\") stay unsigned with no problems",
    pMissingSecrets.mode === "unsigned" && pMissingSecrets.reasons.length === 0,
  );

  const pPair = signingProfileWin({ WIN_CSC_LINK: "/certs/cert.p12", WIN_CSC_KEY_PASSWORD: "hunter2" });
  check(
    "P2-159: complete link+password pair → authenticode",
    pPair.mode === "authenticode" && pPair.reasons.length === 0,
  );

  const pLinkOnly = signingProfileWin({ WIN_CSC_LINK: "/certs/cert.p12" });
  check(
    "P2-159: link without password → fail-closed problem, unsigned",
    pLinkOnly.mode === "unsigned" &&
      pLinkOnly.reasons.length === 1 &&
      pLinkOnly.reasons[0].includes("WIN_CSC_KEY_PASSWORD"),
  );

  const pPasswordOnly = signingProfileWin({ WIN_CSC_KEY_PASSWORD: "hunter2" });
  check(
    "P2-159: password without link → fail-closed problem, unsigned",
    pPasswordOnly.mode === "unsigned" &&
      pPasswordOnly.reasons.length === 1 &&
      pPasswordOnly.reasons[0].includes("WIN_CSC_LINK"),
  );

  const pBlank = signingProfileWin({ WIN_CSC_LINK: "   ", WIN_CSC_KEY_PASSWORD: "hunter2" });
  check(
    "P2-159: whitespace-only value is a fail-closed problem (operator typo, not absence)",
    pBlank.mode === "unsigned" && pBlank.reasons.length > 0,
  );

  const pSubject = signingProfileWin({
    WIN_CSC_LINK: "/certs/cert.p12",
    WIN_CSC_KEY_PASSWORD: "hunter2",
    WIN_CSC_SUBJECT_NAME: "OpenCode Remote",
  });
  check(
    "P2-159: optional subject name does not change the mode",
    pSubject.mode === "authenticode" && pSubject.reasons.length === 0,
  );
  const pSubjectAlone = signingProfileWin({ WIN_CSC_SUBJECT_NAME: "OpenCode Remote" });
  check(
    "P2-159: subject name alone never signs (authenticode needs the full pair)",
    pSubjectAlone.mode === "unsigned" && pSubjectAlone.reasons.length === 0,
  );

  // Real-repo assertions: the desktop-win job must be wired to the WIN_CSC_*
  // secrets only — the Apple CSC_LINK/CSC_KEY_PASSWORD pair belongs to the
  // mac job, and the preflight step must declare shell: bash (P2-126).
  const root = join(import.meta.dirname, "..");
  const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const start = release.indexOf("\n  desktop-win:");
  const end = release.indexOf("\n  release-verify:");
  const block = start === -1 || end === -1 || end < start ? "" : release.slice(start, end);
  check("P2-159: release.yml still has the desktop-win job", block.length > 0);
  check(
    "P2-159: no desktop-win step references the Apple CSC secrets (WIN_CSC_* only)",
    !/(?<![A-Za-z0-9_])CSC_LINK/.test(block) && !/(?<![A-Za-z0-9_])CSC_KEY_PASSWORD/.test(block),
  );
  check(
    "P2-159: desktop-win resolves the profile via signing-profile-win.mjs before packaging",
    block.includes("signing-profile-win.mjs") && block.includes("steps.win-signing.outputs.mode"),
  );
  check(
    "P2-159: desktop-win preflight step declares shell: bash (P2-126 lesson)",
    block.includes("shell: bash"),
  );
}

// --- P2-160: sidecar log redactor — pairing credential never hits disk ----------
{
  const PAIR_URI =
    "opencode-remote://pair?v=2&relay=https%3A%2F%2Frelay.example%2Fwss&room=room-1&k=QUJD&vapid=VERF&name=macbook";
  const ANNOUNCE = "  Pair with the PWA by scanning this QR code:";
  const ESC = "\x1b";
  const QR = "\u2580\u2584\u2588"; // half-block glyphs the terminal QR renderer uses
  const qrLines = (withAnsi: boolean): string[] => [
    "",
    ANNOUNCE,
    "",
    withAnsi ? `  ${ESC}[7m ${QR}${QR} ${ESC}[0m` : `  ${QR}${QR} ${QR} `,
    withAnsi ? `  ${ESC}[7m ${QR}  ${ESC}[0m` : `   ${QR} `,
    "",
  ];

  // 1. whole URI in a single chunk
  {
    const f = createSidecarRedactor();
    const out = f(`  or paste: ${PAIR_URI}\n`);
    check(
      "P2-160: whole URI in one chunk → marker emitted, scheme gone",
      out.includes(REDACTED_MARKER) && !out.includes(PAIRING_SCHEME) && out.startsWith("  or paste: ") && out.endsWith("\n"),
    );
  }

  // 2. same URI split across two chunks — redacted only when the line closes
  {
    const f = createSidecarRedactor();
    const cut = PAIR_URI.indexOf("&room=");
    const out = f(`  or paste: ${PAIR_URI.slice(0, cut)}`) + f(`${PAIR_URI.slice(cut)}\n`);
    check(
      "P2-160: URI split across two chunks → redacted exactly once",
      !out.includes(PAIRING_SCHEME) && out.split(REDACTED_MARKER).length - 1 === 1 && out === `  or paste: ${REDACTED_MARKER}\n`,
    );
  }

  // 3+4. QR block suppressed whole; first normal line after it preserved+redacted
  {
    const f = createSidecarRedactor();
    const out = f([...qrLines(true), `  or paste: ${PAIR_URI}`, ""].map((l) => `${l}\n`).join(""));
    check(
      "P2-160: QR block (ANSI-wrapped) fully suppressed",
      !out.includes("\u2580") && !out.includes("\u2584") && !out.includes("\u2588") && !out.includes(ESC),
    );
    check(
      "P2-160: announce kept; or-paste line redacted and preserved",
      out.split("\n").includes(ANNOUNCE) && out.split("\n").includes(`  or paste: ${REDACTED_MARKER}`) && !out.includes(PAIRING_SCHEME),
    );
    const f2 = createSidecarRedactor();
    const out2 = f2([...qrLines(false), `  or paste: ${PAIR_URI}`].map((l) => `${l}\n`).join(""));
    check(
      "P2-160: bare QR block (no ANSI) fully suppressed",
      !out2.includes("\u2580") && out2.includes(`  or paste: ${REDACTED_MARKER}`),
    );
  }

  // 5. chunk without trailing newline: held, flushed next chunk, no byte lost
  {
    const f = createSidecarRedactor();
    const head = '{"ts":1,"msg":"half';
    const tail = ' of the line"}\n';
    check("P2-160: lineless chunk held in the partial buffer", f(head) === "");
    check("P2-160: held bytes flushed next chunk byte-identical", f(tail) === head + tail);
  }

  // 6. partial buffer cap: forced already-redacted flush, then drained
  {
    const f = createSidecarRedactor({ maxPartialBytes: 20 });
    const long = "y".repeat(50);
    check("P2-160: cap forces the lineless flush", f(long) === long);
    check("P2-160: buffer drained after the forced flush", f("next\n") === "next\n");
    const g = createSidecarRedactor({ maxPartialBytes: 10 });
    check("P2-160: forced flush is redacted too", g(`paste ${PAIR_URI} tail`) === `paste ${REDACTED_MARKER} tail`);
  }

  // 7. ordinary daemon JSONL passes byte-identical
  {
    const f = createSidecarRedactor();
    const line = '{"ts":1767000000,"level":"info","msg":"relay connected"}\n';
    check("P2-160: ordinary daemon JSONL passes byte-identical", f(line) === line);
    const withheld = "  Pairing QR withheld: fix RELAY_URL and restart the daemon.\n";
    check("P2-160: withheld-QR boot line (P2-139 branch) untouched", f(withheld) === withheld);
  }

  check("P2-160: default partial cap is bounded and small", SIDECAR_PARTIAL_MAX_BYTES === 4096);

  // tee integration: a boot fixture written through createSidecarTee leaves
  // zero pairing URIs on disk — the support-request guarantee
  {
    const userData = mkdtempSync(join(tmpdir(), "p2-160-tee-"));
    try {
      const tee = createSidecarTee(userData);
      const fixture = [
        "  opencode remote daemon (protocol v2)",
        ...qrLines(true),
        `  or paste: ${PAIR_URI}`,
        '{"ts":2,"level":"info","msg":"relay connected"}',
      ]
        .map((l) => `${l}\n`)
        .join("");
      tee(fixture);
      const raw = readFileSync(sidecarLogFile(userData), "utf8");
      check(
        "P2-160: tee'd boot fixture contains zero pairing URIs",
        !raw.includes(PAIRING_SCHEME) && raw.includes(REDACTED_MARKER),
      );
      check(
        "P2-160: tee'd JSONL after the QR survives",
        raw.includes('{"ts":2,"level":"info","msg":"relay connected"}\n'),
      );
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  }

  // the pairing capture path in daemon.ts must stay RAW (auto-pairing, VISION
  // stage 3.1): no redactor there, tee still called with the untouched chunk
  {
    const desktopSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "daemon.ts"), "utf8");
    check(
      "P2-160: daemon.ts capture path stays raw (no redactor, raw chunk to tee + PAIR_URL_RE)",
      !desktopSrc.includes("sidecar-redact") &&
        !desktopSrc.includes("createSidecarRedactor") &&
        desktopSrc.includes("teeSidecarChunk(chunk);") &&
        desktopSrc.includes("PAIR_URL_RE.exec(sidecar.stdoutTail)"),
    );
  }
}

// --- P2-162: bundle size budget gate -----------------------------------------
{
  const realSizes: BundleEntry[] = [
    { name: "apps/web/dist", bytes: 571_256 },
    { name: "apps/desktop/dist-daemon/index.js", bytes: 734_536 },
  ];
  check("P2-162: real-build sizes fit BUNDLE_BUDGETS with no problems", budgetProblems(realSizes).length === 0);
  check(
    "P2-162: BUNDLE_BUDGETS covers exactly the two shipped entries",
    JSON.stringify(Object.keys(BUNDLE_BUDGETS)) === JSON.stringify(["apps/web/dist", "apps/desktop/dist-daemon/index.js"]),
  );

  check(
    "P2-162: entry at exactly the ceiling passes",
    budgetProblems([{ name: "a.js", bytes: 100 }], { "a.js": 100 }).length === 0,
  );

  const over = budgetProblems([{ name: "a.js", bytes: 2048 }], { "a.js": 100 });
  check(
    "P2-162: over-budget entry cites measured value, ceiling and slack in KB",
    over.length === 1 &&
      over[0]!.startsWith("a.js:") &&
      over[0]!.includes("measured 2.0 KB") &&
      over[0]!.includes("0.1 KB budget") &&
      over[0]!.includes("slack -1.9 KB"),
    JSON.stringify(over),
  );

  const missing = budgetProblems([], { "a.js": 100 });
  check(
    "P2-162: expected entry missing from the list is a problem",
    missing.length === 1 && missing[0]!.startsWith("a.js:") && missing[0]!.includes("missing"),
    JSON.stringify(missing),
  );

  const negative = budgetProblems([{ name: "a.js", bytes: 10 }], { "a.js": -1 });
  check(
    "P2-162: negative budget is a problem",
    negative.length === 1 && negative[0]!.includes("negative"),
    JSON.stringify(negative),
  );

  const notNumber = budgetProblems([{ name: "a.js", bytes: 10 }], { "a.js": "big" as unknown as number });
  check(
    "P2-162: non-numeric budget is a problem",
    notNumber.length === 1 && notNumber[0]!.includes("not a number"),
    JSON.stringify(notNumber),
  );

  const nanBudget = budgetProblems([{ name: "a.js", bytes: 10 }], { "a.js": NaN });
  check("P2-162: NaN budget is a problem", nanBudget.length === 1 && nanBudget[0]!.includes("not a number"), JSON.stringify(nanBudget));

  const empty = budgetProblems([], BUNDLE_BUDGETS);
  check(
    "P2-162: empty measured list flags every budget key missing",
    empty.length === 2 && empty[0]!.includes("missing") && empty[1]!.includes("missing"),
    JSON.stringify(empty),
  );

  // the real workflow: budget step sits inside desktop-package, after Build,
  // before packaging, with an explicit bash shell (P2-126 lesson)
  const ciYml = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const jobStart = ciYml.indexOf("  desktop-package:");
  const buildStep = ciYml.indexOf("- name: Build", jobStart);
  const budgetStep = ciYml.indexOf("- name: Bundle budget", jobStart);
  const budgetRun = ciYml.indexOf("scripts/bundle-budget.ts", budgetStep);
  const packageStep = ciYml.indexOf("Package mac bundle", jobStart);
  check(
    "P2-162: ci.yml runs the budget inside desktop-package after Build and before packaging",
    jobStart > 0 &&
      buildStep > jobStart &&
      budgetStep > buildStep &&
      budgetRun > budgetStep &&
      budgetStep < packageStep,
    `job=${jobStart} build=${buildStep} budget=${budgetStep} pkg=${packageStep}`,
  );
  const stepBlock = budgetStep > 0 ? ciYml.slice(budgetStep, packageStep) : "";
  check("P2-162: budget step declares shell: bash (P2-126 lesson)", /^\s*shell:\s*bash\s*$/m.test(stepBlock), JSON.stringify(stepBlock));
}

// --- P2-164: real-repo assertion — desktop-win smoke-checks before upload ------
{
  // Same risk P2-130 closed on the mac side: a Windows bundle without
  // web-dist/index.html or daemon/index.js used to reach users as a
  // blank-opening installer because desktop-win went straight from NSIS
  // packaging to the release upload. The job must run dist:smoke in between.
  const root = join(import.meta.dirname, "..");
  const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const start = release.indexOf("\n  desktop-win:");
  const end = release.indexOf("\n  release-verify:");
  const block = start === -1 || end === -1 || end < start ? "" : release.slice(start, end);
  check("P2-164: release.yml still has the desktop-win job", block.length > 0);

  const packageStep = block.indexOf("- name: Build + package NSIS installer");
  const smokeStep = block.indexOf("- name: Smoke-check the packaged bundle");
  const uploadStep = block.indexOf("- name: Attach setup exe + update metadata to the GitHub release");
  check(
    "P2-164: desktop-win runs the smoke step between packaging and the release upload",
    packageStep > -1 && smokeStep > packageStep && uploadStep > smokeStep,
    `pkg=${packageStep} smoke=${smokeStep} upload=${uploadStep}`,
  );

  const smokeBlock = smokeStep > -1 && uploadStep > smokeStep ? block.slice(smokeStep, uploadStep) : "";
  check(
    "P2-164: desktop-win smoke step runs dist:smoke in the desktop workspace",
    smokeBlock.includes("run: npm run dist:smoke --workspace @ocr/desktop"),
    JSON.stringify(smokeBlock),
  );
  check(
    "P2-164: desktop-win smoke step declares shell: bash (P2-126 lesson)",
    /^\s*shell:\s*bash\s*$/m.test(smokeBlock),
    JSON.stringify(smokeBlock),
  );
}

// --- P2-171: relay tuning knobs resolve fail-closed ----------------------------
{
  const KNOB_NAMES = [
    "RELAY_RATE_PER_MIN",
    "RELAY_RATE_BURST",
    "RELAY_MAX_PER_IP",
    "RELAY_TRUST_PROXY_HOPS",
    "RELAY_PING_INTERVAL_S",
  ] as const;

  const empty = relayKnobs({});
  check(
    "P2-171: empty env → exactly the historical defaults (600/1000/20/0/30) with zero problems",
    empty.ratePerMin === 600 &&
      empty.rateBurst === 1000 &&
      empty.maxPerIp === 20 &&
      empty.trustProxyHops === 0 &&
      empty.pingIntervalS === 30 &&
      empty.problems.length === 0,
  );

  const blank = relayKnobs({
    RELAY_RATE_PER_MIN: "  ",
    RELAY_RATE_BURST: "",
    RELAY_MAX_PER_IP: " ",
    RELAY_TRUST_PROXY_HOPS: "",
    RELAY_PING_INTERVAL_S: "  ",
  });
  check(
    "P2-171: blank values are the only present-case that keeps the default without a problem",
    blank.problems.length === 0 &&
      blank.ratePerMin === 600 &&
      blank.rateBurst === 1000 &&
      blank.maxPerIp === 20 &&
      blank.trustProxyHops === 0 &&
      blank.pingIntervalS === 30,
  );

  const valid = relayKnobs({
    RELAY_RATE_PER_MIN: "120",
    RELAY_RATE_BURST: "500",
    RELAY_MAX_PER_IP: "50",
    RELAY_TRUST_PROXY_HOPS: "2",
    RELAY_PING_INTERVAL_S: "10",
  });
  check(
    "P2-171: valid values resolve verbatim with zero problems",
    valid.ratePerMin === 120 &&
      valid.rateBurst === 500 &&
      valid.maxPerIp === 50 &&
      valid.trustProxyHops === 2 &&
      valid.pingIntervalS === 10 &&
      valid.problems.length === 0,
  );

  // non-numeric: every knob refuses garbage (including Infinity via "1e400")
  for (const [name, value] of [
    ["RELAY_RATE_PER_MIN", "six hundred"],
    ["RELAY_RATE_BURST", "abc"],
    ["RELAY_MAX_PER_IP", "1e400"],
    ["RELAY_TRUST_PROXY_HOPS", "two"],
    ["RELAY_PING_INTERVAL_S", "soon"],
  ] as const) {
    const r = relayKnobs({ [name]: value } as Record<string, string>);
    check(
      `P2-171: non-numeric ${name} is a problem citing the variable`,
      r.problems.length === 1 && r.problems[0]!.includes(name),
      JSON.stringify(r.problems),
    );
  }

  // negative: every knob refuses it
  for (const name of KNOB_NAMES) {
    const r = relayKnobs({ [name]: "-1" } as Record<string, string>);
    check(
      `P2-171: negative ${name} is a problem citing the variable`,
      r.problems.length === 1 && r.problems[0]!.includes(name),
      JSON.stringify(r.problems),
    );
  }

  // zero: a problem in the four guard knobs (they can no longer be silently
  // disabled), the legitimate direct-exposure default in the proxy hops
  for (const name of KNOB_NAMES.filter((n) => n !== "RELAY_TRUST_PROXY_HOPS")) {
    const r = relayKnobs({ [name]: "0" } as Record<string, string>);
    check(
      `P2-171: zero ${name} is a problem citing the variable`,
      r.problems.length === 1 && r.problems[0]!.includes(name),
      JSON.stringify(r.problems),
    );
  }
  const hopsZero = relayKnobs({ RELAY_TRUST_PROXY_HOPS: "0" });
  check(
    "P2-171: zero RELAY_TRUST_PROXY_HOPS stays valid (direct exposure is the documented default)",
    hopsZero.trustProxyHops === 0 && hopsZero.problems.length === 0,
  );

  // fractional: every knob refuses it, hops included (a hop must be a whole entry)
  for (const name of KNOB_NAMES) {
    const r = relayKnobs({ [name]: "1.5" } as Record<string, string>);
    check(
      `P2-171: fractional ${name} is a problem citing the variable`,
      r.problems.length === 1 && r.problems[0]!.includes(name),
      JSON.stringify(r.problems),
    );
  }

  // above ceiling: refused; exactly at the ceiling: accepted
  const ceilings: Array<[string, number]> = [
    ["RELAY_RATE_PER_MIN", RATE_PER_MIN_CEILING],
    ["RELAY_RATE_BURST", RATE_BURST_CEILING],
    ["RELAY_MAX_PER_IP", MAX_PER_IP_CEILING],
    ["RELAY_TRUST_PROXY_HOPS", TRUST_PROXY_HOPS_CEILING],
    ["RELAY_PING_INTERVAL_S", PING_INTERVAL_S_CEILING],
  ];
  for (const [name, ceiling] of ceilings) {
    const over = relayKnobs({ [name]: String(ceiling + 1) } as Record<string, string>);
    check(
      `P2-171: ${name} above its ${ceiling} ceiling is a problem citing the variable`,
      over.problems.length === 1 && over.problems[0]!.includes(name),
      JSON.stringify(over.problems),
    );
    const at = relayKnobs({ [name]: String(ceiling) } as Record<string, string>);
    check(
      `P2-171: ${name} exactly at its ${ceiling} ceiling is accepted`,
      at.problems.length === 0,
      JSON.stringify(at.problems),
    );
  }

  // several bad knobs at once: every reason is collected in one list
  const many = relayKnobs({
    RELAY_RATE_PER_MIN: "abc",
    RELAY_RATE_BURST: "-5",
    RELAY_MAX_PER_IP: "0",
    RELAY_TRUST_PROXY_HOPS: "1.5",
    RELAY_PING_INTERVAL_S: String(PING_INTERVAL_S_CEILING + 1),
  });
  check(
    "P2-171: five invalid knobs at once produce five problems citing each variable",
    many.problems.length === 5 &&
      KNOB_NAMES.every((n) => many.problems.some((p) => p.includes(n))),
    JSON.stringify(many.problems),
  );

  // a problem never serves the raw value: the resolved knob falls back to the default
  const fallback = relayKnobs({ RELAY_RATE_PER_MIN: "abc" });
  check(
    "P2-171: a problem knob resolves to the documented default (the boot refuses anyway)",
    fallback.ratePerMin === 600,
  );
}

// --- P2-177: relay log level resolves fail-closed ------------------------------
{
  const empty = resolveLogLevel({});
  check(
    "P2-177: empty env → the historical default info with zero problems",
    empty.level === "info" && empty.level === LOG_LEVEL_DEFAULT && empty.problems.length === 0,
  );

  const blank = resolveLogLevel({ RELAY_LOG_LEVEL: "  " });
  const blank2 = resolveLogLevel({ RELAY_LOG_LEVEL: "" });
  check(
    "P2-177: blank values are the only present-case that keeps the default without a problem",
    blank.level === "info" &&
      blank2.level === "info" &&
      blank.problems.length === 0 &&
      blank2.problems.length === 0,
  );

  for (const level of LOG_LEVELS) {
    const r = resolveLogLevel({ RELAY_LOG_LEVEL: level });
    check(
      `P2-177: valid level "${level}" is accepted verbatim`,
      r.level === level && r.problems.length === 0,
      JSON.stringify(r.problems),
    );
  }

  for (const level of LOG_LEVELS) {
    const upper = resolveLogLevel({ RELAY_LOG_LEVEL: level.toUpperCase() });
    const mixed = resolveLogLevel({ RELAY_LOG_LEVEL: ` ${level[0]!.toUpperCase()}${level.slice(1)} ` });
    check(
      `P2-177: "${level.toUpperCase()}" and its padded mixed-case form resolve case-insensitively`,
      upper.level === level &&
        mixed.level === level &&
        upper.problems.length === 0 &&
        mixed.problems.length === 0,
      JSON.stringify([upper.problems, mixed.problems]),
    );
  }

  const unknown = resolveLogLevel({ RELAY_LOG_LEVEL: "verbose" });
  check(
    "P2-177: unknown level is a problem citing the variable (fail-closed, no silent default)",
    unknown.problems.length === 1 &&
      unknown.problems[0]!.includes("RELAY_LOG_LEVEL") &&
      unknown.level === LOG_LEVEL_DEFAULT,
    JSON.stringify(unknown.problems),
  );

  const notString = resolveLogLevel({ RELAY_LOG_LEVEL: 123 });
  const notString2 = resolveLogLevel({ RELAY_LOG_LEVEL: null });
  check(
    "P2-177: non-string value is a problem citing the variable",
    notString.problems.length === 1 &&
      notString.problems[0]!.includes("RELAY_LOG_LEVEL") &&
      notString.level === LOG_LEVEL_DEFAULT &&
      notString2.problems.length === 1 &&
      notString2.level === LOG_LEVEL_DEFAULT,
    JSON.stringify([notString.problems, notString2.problems]),
  );

  // full shouldLog matrix: an entry passes exactly when it is at least as
  // severe as the configured level (error < warn < info < debug verbosity)
  let matrixOk = true;
  for (const configured of LOG_LEVELS) {
    for (const entry of LOG_LEVELS) {
      const expected = LOG_LEVELS.indexOf(entry) <= LOG_LEVELS.indexOf(configured);
      if (shouldLog(configured, entry) !== expected) matrixOk = false;
    }
  }
  check(
    "P2-177: shouldLog matrix — error passes at any level, debug is suppressed at info, everything passes at debug",
    matrixOk &&
      !shouldLog("info", "debug") &&
      LOG_LEVELS.every((configured) => shouldLog(configured, "error")) &&
      LOG_LEVELS.every((entry) => shouldLog("debug", entry)),
  );

  // source pins against the real wiring: the per-frame line is debug-only,
  // the rejection lines keep their warn level, the listening line carries
  // the additive logLevel field and ev() gates on the resolved level.
  const relayIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "relay", "src", "index.ts"), "utf8");
  check(
    "P2-177: index.ts emits `frame in` at debug (never info) and keeps the rejection lines at warn",
    relayIndexSrc.includes('ev("debug", "frame in"') &&
      !relayIndexSrc.includes('ev("info", "frame in"') &&
        relayIndexSrc.includes('ev("warn", "connection rejected: per-IP cap exceeded"') &&
        relayIndexSrc.includes('ev("warn", "rate limited, dropping device"') &&
        relayIndexSrc.includes('ev("warn", "frame dropped: invalid room id"') &&
        relayIndexSrc.includes('ev("warn", "frame dropped: socket room cap exceeded"') &&
        relayIndexSrc.includes('ev("warn", "room capacity exceeded"'),
  );
  check(
    "P2-177: index.ts resolves the level at boot fail-closed, gates ev() on it and advertises logLevel on `relay listening`",
    relayIndexSrc.includes("const LOG = resolveLogLevel(process.env);") &&
      relayIndexSrc.includes("if (!shouldLog(LOG.level, level)) return;") &&
      relayIndexSrc.includes("logLevel: LOG.level,"),
  );

  // purity pin: the decision module imports nothing, so scripts can unit-test
  // it without any node/http/ws surface (same discipline as knobs.ts)
  const loglevelSrc = readFileSync(join(import.meta.dirname, "..", "apps", "relay", "src", "loglevel.ts"), "utf8");
  check("P2-177: loglevel.ts stays pure — zero imports", !/^import /m.test(loglevelSrc));
}

// --- P2-217: relay backpressure — send verdict + per-socket buffer cap --------
{
  const cap = BUFFER_CAP_DEFAULT;

  // -- sendVerdict: the full table -------------------------------------------

  // accumulated far below the cap → send, whatever the frame size
  const wellBelow: string[] = [];
  for (const [pending, frame] of [
    [0, 1],
    [0, cap],
    [1, 1],
    [Math.floor(cap / 2), Math.floor(cap / 2) - 1024],
    [cap - cap / 4, cap / 4 - 2048],
  ] as const) {
    wellBelow.push(sendVerdict(pending, frame, cap).action);
  }
  check(
    "P2-217: accumulated bytes well below the cap always send",
    wellBelow.every((a) => a === "send"),
    JSON.stringify(wellBelow),
  );

  // accumulated + frame landing EXACTLY on the cap is still a send — the
  // documented limit itself stays serviceable, only strictly above closes
  const atCap = sendVerdict(cap - 100, 100, cap);
  const atCapZeroFrame = sendVerdict(cap, 0, cap);
  check(
    "P2-217: accumulated + frame exactly at the cap sends (limit documented: pending+frame == cap is a send)",
    atCap.action === "send" && atCapZeroFrame.action === "send" && cap === BUFFER_CAP_DEFAULT,
  );

  // one byte over the cap → close-slow, with the documented reason
  const over = sendVerdict(cap - 99, 100, cap);
  check(
    "P2-217: accumulated + frame above the cap → close-slow with the fixed reason",
    over.action === "close-slow" && over.reason === SLOW_CONSUMER_CLOSE_REASON,
    JSON.stringify(over),
  );

  // already over the cap, tiny frame → still close-slow
  const alreadyOver = sendVerdict(cap + 1, 1, cap);
  const wayOver = sendVerdict(cap * 10, 0, cap);
  check(
    "P2-217: accumulated already above the cap closes even for a tiny frame",
    alreadyOver.action === "close-slow" && wayOver.action === "close-slow",
  );

  // fail-open by design: missing, negative and non-finite accumulated bytes
  // never close a (possibly healthy) connection
  const absent = sendVerdict(undefined, 100, cap);
  const negative = sendVerdict(-1, 100, cap);
  const notANumber = sendVerdict(NaN, 100, cap);
  const infinite = sendVerdict(Infinity, 100, cap);
  const nullPending = sendVerdict(null, 100, cap);
  check(
    "P2-217: missing, negative or non-finite accumulated bytes fail OPEN (send)",
    absent.action === "send" &&
      negative.action === "send" &&
      notANumber.action === "send" &&
      infinite.action === "send" &&
      nullPending.action === "send",
    JSON.stringify([absent, negative, notANumber, infinite, nullPending]),
  );

  // the verdict has exactly two outcomes — a blind relay never drops a frame
  const actions = new Set(
    [
      sendVerdict(0, 1, cap),
      sendVerdict(cap, 0, cap),
      sendVerdict(cap + 1, 0, cap),
      sendVerdict(NaN, cap, cap),
      sendVerdict(-5, 1, cap),
      sendVerdict(undefined, 1, cap),
    ].map((v) => v.action),
  );
  check(
    "P2-217: sendVerdict never drops — the only actions are send and close-slow",
    actions.size === 2 && actions.has("send") && actions.has("close-slow"),
  );

  // privacy: the generated reason carries no file path, URL scheme, room id
  // shape or secret material — a short fixed Portuguese sentence
  check(
    "P2-217: the close-slow reason has no path, no URL scheme and no room-id shape",
    !SLOW_CONSUMER_CLOSE_REASON.includes("/") &&
      !SLOW_CONSUMER_CLOSE_REASON.includes("://") &&
      !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(SLOW_CONSUMER_CLOSE_REASON) &&
      SLOW_CONSUMER_CLOSE_REASON.length < 100,
    SLOW_CONSUMER_CLOSE_REASON,
  );

  // -- parseBufferCap: the fail-closed table ---------------------------------

  const empty = parseBufferCap({});
  check(
    `P2-217: empty env → the documented default ${BUFFER_CAP_DEFAULT} with zero problems`,
    empty.cap === BUFFER_CAP_DEFAULT && empty.problems.length === 0,
    JSON.stringify(empty.problems),
  );

  const blank = parseBufferCap({ [BUFFER_CAP_ENV]: "   " });
  check(
    "P2-217: blank value keeps the documented default without a problem (same as knobs.ts)",
    blank.cap === BUFFER_CAP_DEFAULT && blank.problems.length === 0,
  );

  const valid = parseBufferCap({ [BUFFER_CAP_ENV]: String(BUFFER_CAP_CEILING) });
  const valid2 = parseBufferCap({ [BUFFER_CAP_ENV]: "12345678" });
  check(
    "P2-217: a valid whole byte count at or below the ceiling is accepted verbatim",
    valid.cap === BUFFER_CAP_CEILING &&
      valid.problems.length === 0 &&
      valid2.cap === 12345678 &&
      valid2.problems.length === 0,
  );

  const nonNumeric = parseBufferCap({ [BUFFER_CAP_ENV]: "abc" });
  check(
    "P2-217: non-numeric value is a problem citing the variable (fail-closed, no silent default)",
    nonNumeric.problems.length === 1 &&
      nonNumeric.problems[0]!.includes(BUFFER_CAP_ENV) &&
      nonNumeric.cap === BUFFER_CAP_DEFAULT,
    JSON.stringify(nonNumeric.problems),
  );

  const zero = parseBufferCap({ [BUFFER_CAP_ENV]: "0" });
  check(
    "P2-217: zero is a problem — it would disable the cap outright",
    zero.problems.length === 1 && zero.problems[0]!.includes(BUFFER_CAP_ENV),
  );

  const negCap = parseBufferCap({ [BUFFER_CAP_ENV]: "-5" });
  check(
    "P2-217: negative value is a problem citing the variable",
    negCap.problems.length === 1 && negCap.problems[0]!.includes(BUFFER_CAP_ENV),
  );

  const fractional = parseBufferCap({ [BUFFER_CAP_ENV]: "1.5" });
  check(
    "P2-217: fractional value is a problem citing the variable",
    fractional.problems.length === 1 && fractional.problems[0]!.includes(BUFFER_CAP_ENV),
  );

  const aboveCeiling = parseBufferCap({ [BUFFER_CAP_ENV]: String(BUFFER_CAP_CEILING + 1) });
  check(
    "P2-217: above-ceiling value is a problem citing the variable and the ceiling",
    aboveCeiling.problems.length === 1 &&
      aboveCeiling.problems[0]!.includes(BUFFER_CAP_ENV) &&
      aboveCeiling.problems[0]!.includes(String(BUFFER_CAP_CEILING)),
  );

  // every rule is checked independently: a value violating several rules
  // reports ALL its reasons at once, no short-circuit
  const many = parseBufferCap({ [BUFFER_CAP_ENV]: "-1.5" });
  check(
    "P2-217: several problems are returned at once without short-circuit",
    many.problems.length === 2 &&
      many.problems.every((p) => p.includes(BUFFER_CAP_ENV)) &&
      many.cap === BUFFER_CAP_DEFAULT,
    JSON.stringify(many.problems),
  );

  // -- purity + real-wiring pins ----------------------------------------------

  const backpressureSrc = readFileSync(
    join(import.meta.dirname, "..", "apps", "relay", "src", "backpressure.ts"),
    "utf8",
  );
  check(
    "P2-217: backpressure.ts stays pure — zero imports (no ws, node:net, node:http, node:fs)",
    !/^import /m.test(backpressureSrc),
  );

  const relayIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "relay", "src", "index.ts"), "utf8");
  const verdictAt = relayIndexSrc.indexOf("const verdict = sendVerdict(t.bufferedAmount");
  const sendAt = relayIndexSrc.indexOf("t.send(out)");
  const loopBody = verdictAt > -1 && sendAt > verdictAt ? relayIndexSrc.slice(verdictAt, sendAt) : "";
  check(
    "P2-217: index.ts consults sendVerdict (target's own bufferedAmount) before every send",
    verdictAt > -1 && sendAt > -1 && verdictAt < sendAt,
  );
  check(
    "P2-217: the only non-send path in the forwarding loop closes the slow socket — no silent frame drop",
    loopBody.includes('verdict.action === "close-slow"') &&
      (loopBody.match(/t\.close\(/g) ?? []).length === 1 &&
      loopBody.includes(`t.close(SLOW_CONSUMER_CLOSE_CODE, SLOW_CONSUMER_CLOSE_REASON)`) &&
      (relayIndexSrc.match(/t\.send\(/g) ?? []).length === 1,
    loopBody,
  );

  // the close is scoped to the slow target only; the counter is additive and
  // the warn line carries just the counter and the reason
  check(
    "P2-217: each slow-consumer close increments one new additive counter and logs one warn line with counter + reason only",
    (relayIndexSrc.match(/m\.slowConsumers\+\+/g) ?? []).length === 1 &&
      relayIndexSrc.includes('ev("warn", "slow consumer closed", { count: m.slowConsumers, reason: verdict.reason })'),
  );

  // both metric formats expose the new counter without renaming anything
  check(
    "P2-217: metrics route serves slow_consumers_total in JSON and relay_slow_consumers_total in Prometheus text",
    relayIndexSrc.includes("slow_consumers_total: m.slowConsumers,") &&
      relayIndexSrc.includes("# TYPE relay_slow_consumers_total counter") &&
      relayIndexSrc.includes("`relay_slow_consumers_total ${m.slowConsumers}`") &&
      relayIndexSrc.includes("relay_rate_limited_total") &&
      relayIndexSrc.includes("rate_limited_total: m.rateLimited"),
  );

  // boot resolves the knob fail-closed before anything listens, like every knob
  check(
    "P2-217: index.ts resolves the buffer cap fail-closed and advertises it on `relay listening`",
    relayIndexSrc.includes("const BUFFER_CAP = parseBufferCap(process.env);") &&
      relayIndexSrc.includes('ev("warn", "invalid relay buffer cap, refusing to start (fail-closed)"') &&
      relayIndexSrc.includes("bufferCapBytes,"),
  );
}

// --- P2-227: relay process-wide socket capacity — admission verdict + knob ------
{
  const cap = MAX_SOCKETS_GLOBAL_DEFAULT;

  // -- acceptVerdict: the full table -----------------------------------------

  // live counts well below the ceiling accept
  const wellBelow: string[] = [];
  for (const live of [0, 1, Math.floor(cap / 2), cap - 2]) {
    wellBelow.push(acceptVerdict(live, cap).action);
  }
  check(
    "P2-227: live counts well below the ceiling always accept",
    wellBelow.every((a) => a === "accept"),
    JSON.stringify(wellBelow),
  );

  // exactly one below the ceiling still accepts — the documented limit: a
  // live count AT the ceiling is the first refusal, cap-1 is the last admit
  const justUnder = acceptVerdict(cap - 1, cap);
  check(
    "P2-227: live count exactly one below the ceiling accepts (documented limit: cap-1 admits, cap refuses)",
    justUnder.action === "accept" && cap === MAX_SOCKETS_GLOBAL_DEFAULT,
  );

  // at and above the ceiling refuse, with the fixed reason
  const at = acceptVerdict(cap, cap);
  const above = acceptVerdict(cap + 1, cap);
  const wayAbove = acceptVerdict(cap * 10, cap);
  check(
    "P2-227: live count at or above the ceiling refuses with the fixed reason",
    at.action === "refuse" &&
      at.reason === CAPACITY_REFUSE_REASON &&
      above.action === "refuse" &&
      above.reason === CAPACITY_REFUSE_REASON &&
      wayAbove.action === "refuse",
    JSON.stringify([at, above, wayAbove]),
  );

  // ceiling of one with an empty process accepts (the first socket gets in)
  check(
    "P2-227: ceiling of one with an empty process accepts",
    acceptVerdict(0, 1).action === "accept",
  );

  // fail-open by design: a broken count never refuses a good connection
  const absent = acceptVerdict(undefined, cap);
  const negative = acceptVerdict(-1, cap);
  const notANumber = acceptVerdict(NaN, cap);
  const infinite = acceptVerdict(Infinity, cap);
  const nullCount = acceptVerdict(null, cap);
  check(
    "P2-227: missing, negative or non-finite live counts fail OPEN (accept)",
    absent.action === "accept" &&
      negative.action === "accept" &&
      notANumber.action === "accept" &&
      infinite.action === "accept" &&
      nullCount.action === "accept",
    JSON.stringify([absent, negative, notANumber, infinite, nullCount]),
  );

  // exactly two outcomes — a refusal never touches anything but this socket
  const actions = new Set(
    [acceptVerdict(0, cap), acceptVerdict(cap, cap), acceptVerdict(undefined, cap)].map((v) => v.action),
  );
  check(
    "P2-227: acceptVerdict has exactly two outcomes — accept and refuse",
    actions.size === 2 && actions.has("accept") && actions.has("refuse"),
  );

  // privacy: the reason is a fixed short Portuguese sentence with no path,
  // URL scheme or room-id shape
  check(
    "P2-227: the refusal reason has no path, no URL scheme and no room-id shape",
    !CAPACITY_REFUSE_REASON.includes("/") &&
      !CAPACITY_REFUSE_REASON.includes("://") &&
      !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(CAPACITY_REFUSE_REASON) &&
      CAPACITY_REFUSE_REASON.length < 100,
    CAPACITY_REFUSE_REASON,
  );

  // -- parseMaxSockets: the fail-closed table ---------------------------------

  const empty = parseMaxSockets({});
  check(
    `P2-227: empty env → the documented default ${MAX_SOCKETS_GLOBAL_DEFAULT} with zero problems`,
    empty.maxSockets === MAX_SOCKETS_GLOBAL_DEFAULT && empty.problems.length === 0,
    JSON.stringify(empty.problems),
  );

  const blank = parseMaxSockets({ [MAX_SOCKETS_GLOBAL_ENV]: "   " });
  check(
    "P2-227: blank value keeps the documented default without a problem (same as knobs.ts)",
    blank.maxSockets === MAX_SOCKETS_GLOBAL_DEFAULT && blank.problems.length === 0,
  );

  const valid = parseMaxSockets({ [MAX_SOCKETS_GLOBAL_ENV]: String(MAX_SOCKETS_GLOBAL_CEILING) });
  const valid2 = parseMaxSockets({ [MAX_SOCKETS_GLOBAL_ENV]: "500" });
  check(
    "P2-227: a valid whole count at or below the ceiling is accepted verbatim",
    valid.maxSockets === MAX_SOCKETS_GLOBAL_CEILING &&
      valid.problems.length === 0 &&
      valid2.maxSockets === 500 &&
      valid2.problems.length === 0,
  );

  const nonNumeric = parseMaxSockets({ [MAX_SOCKETS_GLOBAL_ENV]: "abc" });
  check(
    "P2-227: non-numeric value is a problem citing the variable (fail-closed, no silent default)",
    nonNumeric.problems.length === 1 &&
      nonNumeric.problems[0]!.includes(MAX_SOCKETS_GLOBAL_ENV) &&
      nonNumeric.maxSockets === MAX_SOCKETS_GLOBAL_DEFAULT,
    JSON.stringify(nonNumeric.problems),
  );

  const zero = parseMaxSockets({ [MAX_SOCKETS_GLOBAL_ENV]: "0" });
  check(
    "P2-227: zero is a problem — it would disable the capacity gate outright",
    zero.problems.length === 1 && zero.problems[0]!.includes(MAX_SOCKETS_GLOBAL_ENV),
  );

  const negativeKnob = parseMaxSockets({ [MAX_SOCKETS_GLOBAL_ENV]: "-5" });
  check(
    "P2-227: negative value is a problem citing the variable",
    negativeKnob.problems.length === 1 && negativeKnob.problems[0]!.includes(MAX_SOCKETS_GLOBAL_ENV),
  );

  const fractional = parseMaxSockets({ [MAX_SOCKETS_GLOBAL_ENV]: "1.5" });
  check(
    "P2-227: fractional value is a problem citing the variable",
    fractional.problems.length === 1 && fractional.problems[0]!.includes(MAX_SOCKETS_GLOBAL_ENV),
  );

  const aboveCeiling = parseMaxSockets({ [MAX_SOCKETS_GLOBAL_ENV]: String(MAX_SOCKETS_GLOBAL_CEILING + 1) });
  check(
    "P2-227: above-ceiling value is a problem citing the variable and the ceiling",
    aboveCeiling.problems.length === 1 &&
      aboveCeiling.problems[0]!.includes(MAX_SOCKETS_GLOBAL_ENV) &&
      aboveCeiling.problems[0]!.includes(String(MAX_SOCKETS_GLOBAL_CEILING)),
  );

  // every rule is checked independently: a value violating several rules
  // reports ALL its reasons at once, no short-circuit
  const many = parseMaxSockets({ [MAX_SOCKETS_GLOBAL_ENV]: "-1.5" });
  check(
    "P2-227: several problems are returned at once without short-circuit",
    many.problems.length === 2 &&
      many.problems.every((p) => p.includes(MAX_SOCKETS_GLOBAL_ENV)) &&
      many.maxSockets === MAX_SOCKETS_GLOBAL_DEFAULT,
    JSON.stringify(many.problems),
  );

  // -- purity + real-wiring pins ----------------------------------------------

  const capacitySrc = readFileSync(join(import.meta.dirname, "..", "apps", "relay", "src", "capacity.ts"), "utf8");
  check(
    "P2-227: capacity.ts stays pure — zero imports (no ws, node:net, node:http, node:fs)",
    !/^import /m.test(capacitySrc),
  );

  const capacityIndexSrc = readFileSync(
    join(import.meta.dirname, "..", "apps", "relay", "src", "index.ts"),
    "utf8",
  );
  // order pin: per-IP cap → capacity verdict → accepted connection
  const ipCapAt = capacityIndexSrc.indexOf("if (!ipCap.admit(ip))");
  const verdictAt = capacityIndexSrc.indexOf("const capacity = acceptVerdict(wss.clients.size");
  const acceptedAt = capacityIndexSrc.indexOf("socket.ip = ip;");
  check(
    "P2-227: index.ts consults acceptVerdict after the per-IP cap and before the connection is accepted",
    ipCapAt > -1 && verdictAt > ipCapAt && acceptedAt > verdictAt,
  );
  const branch = verdictAt > -1 && acceptedAt > verdictAt ? capacityIndexSrc.slice(verdictAt, acceptedAt) : "";
  check(
    "P2-227: the only effect of a capacity refusal is closing that one socket — no room touch, exactly one 1013 close",
    branch.includes("ipCap.release(ip)") &&
      (branch.match(/socket\.close\(/g) ?? []).length === 1 &&
      branch.includes('socket.close(1013, "server busy")') &&
      !branch.includes("leaveAll") &&
      !branch.includes("rooms"),
    branch,
  );

  // additive counter + one warn line carrying only the counter and the reason
  check(
    "P2-227: each refusal increments one new additive counter and logs one warn line with counter + reason only",
    (capacityIndexSrc.match(/m\.capacityRefused\+\+/g) ?? []).length === 1 &&
      capacityIndexSrc.includes(
        'ev("warn", "connection refused: process at socket capacity", { count: m.capacityRefused, reason: capacity.reason })',
      ),
  );

  // both metric formats expose the new counter without renaming anything
  check(
    "P2-227: metrics route serves capacity_refused_total in JSON and relay_capacity_refused_total in Prometheus text",
    capacityIndexSrc.includes("capacity_refused_total: m.capacityRefused,") &&
      capacityIndexSrc.includes("# TYPE relay_capacity_refused_total counter") &&
      capacityIndexSrc.includes("`relay_capacity_refused_total ${m.capacityRefused}`") &&
      capacityIndexSrc.includes("slow_consumers_total: m.slowConsumers"),
  );

  // boot resolves the knob fail-closed before anything listens, like every knob
  check(
    "P2-227: index.ts resolves the socket capacity fail-closed and advertises it on `relay listening`",
    capacityIndexSrc.includes("const CAPACITY = parseMaxSockets(process.env);") &&
      capacityIndexSrc.includes('ev("warn", "invalid relay socket capacity, refusing to start (fail-closed)"') &&
      capacityIndexSrc.includes("maxSocketsGlobal,"),
  );
}

// --- P2-230: join-deadline reaper — idleUnjoined + parseJoinDeadline -------------
{
  const now = 10_000_000;
  const peer = (openedAgoMs: number, joined = false): JoinDeadlinePeer => ({
    openedAt: now - openedAgoMs,
    joinedRoom: joined,
  });

  // -- idleUnjoined: the full verdict table -----------------------------------

  check(
    "P2-230: empty collection → empty list",
    idleUnjoined(now, [] as JoinDeadlinePeer[], JOIN_DEADLINE_MS_DEFAULT).length === 0,
  );

  // the threshold, explicit: a peer open exactly the documented default
  // deadline survives; one millisecond more is closed
  const atThreshold = idleUnjoined(now, [peer(JOIN_DEADLINE_MS_DEFAULT)], JOIN_DEADLINE_MS_DEFAULT);
  const pastThreshold = idleUnjoined(now, [peer(JOIN_DEADLINE_MS_DEFAULT + 1)], JOIN_DEADLINE_MS_DEFAULT);
  check(
    "P2-230: peer open exactly the deadline survives; one ms past it is closed (strict bound)",
    atThreshold.length === 0 && pastThreshold.length === 1,
  );

  const young = idleUnjoined(now, [peer(JOIN_DEADLINE_MS_DEFAULT - 1)], JOIN_DEADLINE_MS_DEFAULT);
  check("P2-230: peer open less than the deadline survives", young.length === 0);

  const ancient = idleUnjoined(now, [peer(JOIN_DEADLINE_MS_CEILING * 10, true)], JOIN_DEADLINE_MS_DEFAULT);
  check(
    "P2-230: peer that joined a room survives no matter how long ago it opened",
    ancient.length === 0,
  );

  const unstamped = idleUnjoined(now, [{}], JOIN_DEADLINE_MS_DEFAULT);
  check(
    "P2-230: peer without an open stamp survives (mid-admission prudence, same as liveness lastSeen)",
    unstamped.length === 0,
  );

  const disabled = idleUnjoined(now, [peer(JOIN_DEADLINE_MS_CEILING * 10)], JOIN_DEADLINE_MS_DISABLED);
  const disabledZero = idleUnjoined(now, [peer(JOIN_DEADLINE_MS_CEILING * 10)], 0);
  check(
    "P2-230: disabled deadline returns an empty list even with an old roomless peer",
    disabled.length === 0 && disabledZero.length === 0,
  );

  // order + identity: only expected items, in input order, all from the input
  const p1 = peer(1);
  const p2 = peer(JOIN_DEADLINE_MS_DEFAULT + 5_000);
  const p3 = peer(JOIN_DEADLINE_MS_DEFAULT + 6_000, true);
  const p4 = peer(JOIN_DEADLINE_MS_DEFAULT + 7_000);
  const p5: JoinDeadlinePeer = {};
  const input = [p1, p2, p3, p4, p5];
  const verdict = idleUnjoined(now, input, JOIN_DEADLINE_MS_DEFAULT);
  check(
    "P2-230: iteration order is preserved and every returned item is from the received collection",
    verdict.length === 2 && verdict[0] === p2 && verdict[1] === p4,
    JSON.stringify(verdict.map((p) => p.openedAt)),
  );

  // -- parseJoinDeadline: the fail-closed table --------------------------------

  const absent = parseJoinDeadline({});
  const blank = parseJoinDeadline({ [JOIN_DEADLINE_MS_ENV]: "   " });
  check(
    `P2-230: empty env → the documented default ${JOIN_DEADLINE_MS_DEFAULT} with zero problems (blank too)`,
    absent.deadlineMs === JOIN_DEADLINE_MS_DEFAULT &&
      absent.problems.length === 0 &&
      blank.deadlineMs === JOIN_DEADLINE_MS_DEFAULT &&
      blank.problems.length === 0,
    JSON.stringify([...absent.problems, ...blank.problems]),
  );

  const valid = parseJoinDeadline({ [JOIN_DEADLINE_MS_ENV]: "30000" });
  const atCeiling = parseJoinDeadline({ [JOIN_DEADLINE_MS_ENV]: String(JOIN_DEADLINE_MS_CEILING) });
  check(
    "P2-230: a valid whole deadline at or below the ceiling is accepted verbatim",
    valid.deadlineMs === 30_000 &&
      valid.problems.length === 0 &&
      atCeiling.deadlineMs === JOIN_DEADLINE_MS_CEILING &&
      atCeiling.problems.length === 0,
  );

  const off = parseJoinDeadline({ [JOIN_DEADLINE_MS_ENV]: String(JOIN_DEADLINE_MS_DISABLED) });
  check(
    "P2-230: the documented disable value is accepted verbatim (reaper off)",
    off.deadlineMs === JOIN_DEADLINE_MS_DISABLED && off.problems.length === 0,
  );

  const nonNumeric = parseJoinDeadline({ [JOIN_DEADLINE_MS_ENV]: "abc" });
  check(
    "P2-230: non-numeric value is a problem citing the variable (fail-closed, no silent default)",
    nonNumeric.problems.length === 1 &&
      nonNumeric.problems[0]!.includes(JOIN_DEADLINE_MS_ENV) &&
      nonNumeric.deadlineMs === JOIN_DEADLINE_MS_DEFAULT,
    JSON.stringify(nonNumeric.problems),
  );

  const zero = parseJoinDeadline({ [JOIN_DEADLINE_MS_ENV]: "0" });
  check(
    "P2-230: zero is a problem — it would close mid-admission sockets",
    zero.problems.length === 1 && zero.problems[0]!.includes(JOIN_DEADLINE_MS_ENV),
  );

  const negative = parseJoinDeadline({ [JOIN_DEADLINE_MS_ENV]: "-5" });
  check(
    "P2-230: a negative value other than the disable sentinel is a problem citing the variable",
    negative.problems.length === 1 && negative.problems[0]!.includes(JOIN_DEADLINE_MS_ENV),
  );

  const fractional = parseJoinDeadline({ [JOIN_DEADLINE_MS_ENV]: "1.5" });
  check(
    "P2-230: fractional value is a problem citing the variable",
    fractional.problems.length === 1 && fractional.problems[0]!.includes(JOIN_DEADLINE_MS_ENV),
  );

  const aboveCeiling = parseJoinDeadline({ [JOIN_DEADLINE_MS_ENV]: String(JOIN_DEADLINE_MS_CEILING + 1) });
  check(
    "P2-230: above-ceiling value is a problem citing the variable and the ceiling",
    aboveCeiling.problems.length === 1 &&
      aboveCeiling.problems[0]!.includes(JOIN_DEADLINE_MS_ENV) &&
      aboveCeiling.problems[0]!.includes(String(JOIN_DEADLINE_MS_CEILING)),
  );

  // every rule is checked independently: a value violating several rules
  // reports ALL its reasons at once, no short-circuit
  const many = parseJoinDeadline({ [JOIN_DEADLINE_MS_ENV]: "-1.5" });
  check(
    "P2-230: several problems are returned at once without short-circuit",
    many.problems.length === 2 &&
      many.problems.every((p) => p.includes(JOIN_DEADLINE_MS_ENV)) &&
      many.deadlineMs === JOIN_DEADLINE_MS_DEFAULT,
    JSON.stringify(many.problems),
  );

  // -- purity + policy constants ------------------------------------------------

  const deadlineSrc = readFileSync(join(import.meta.dirname, "..", "apps", "relay", "src", "joindeadline.ts"), "utf8");
  check(
    "P2-230: joindeadline.ts stays pure — zero imports (no ws, node:net, node:http, node:fs)",
    !/^import /m.test(deadlineSrc),
  );
  check(
    "P2-230: the policy close code/reason are fixed constants free of room/address/payload shapes",
    JOIN_UNJOINED_CLOSE_CODE >= 4000 &&
      JOIN_UNJOINED_CLOSE_CODE <= 4999 &&
      !JOIN_UNJOINED_CLOSE_REASON.includes("/") &&
      !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(JOIN_UNJOINED_CLOSE_REASON) &&
      JOIN_UNJOINED_CLOSE_REASON.length < 100,
    JOIN_UNJOINED_CLOSE_REASON,
  );
}

// --- P2-169: mac privacy preflight — mic/camera strings + device entitlements --

{
  const fullBuilder = `${BUILDER_LABEL} pair:\n  ${MIC_KEY}: "O OpenCode Remote usa o microfone para gravar e transcrever mensagens de voz no chat."\n  ${CAMERA_KEY}: "O OpenCode Remote usa a câmera para ler o QR code de pareamento."`;
  const fullPlist = `<plist><dict>\n    <key>com.apple.security.cs.allow-jit</key>\n    <true/>\n    <key>${AUDIO_ENTITLEMENT}</key>\n    <true/>\n    <key>${CAMERA_ENTITLEMENT}</key>\n    <true/>\n  </dict></plist>`;

  check(
    "P2-169: complete mic/camera pair → no problems",
    privacyProblems(fullPlist, fullBuilder).length === 0,
  );

  const micMissing = privacyProblems(fullPlist, `  ${CAMERA_KEY}: "câmera"`);
  check(
    "P2-169: missing microphone usage description → one problem citing the key",
    micMissing.length === 1 && micMissing[0].includes(MIC_KEY),
    JSON.stringify(micMissing),
  );

  const cameraMissing = privacyProblems(fullPlist, `  ${MIC_KEY}: "microfone"`);
  check(
    "P2-169: missing camera usage description → one problem citing the key",
    cameraMissing.length === 1 && cameraMissing[0].includes(CAMERA_KEY),
    JSON.stringify(cameraMissing),
  );

  const audioMissing = privacyProblems(fullPlist.replace(AUDIO_ENTITLEMENT, "com.apple.security.cs.allow-dyld-environment-variables"), fullBuilder);
  check(
    "P2-169: missing audio-input entitlement → one problem citing the entitlement",
    audioMissing.length === 1 && audioMissing[0].includes(AUDIO_ENTITLEMENT),
    JSON.stringify(audioMissing),
  );

  const cameraEntMissing = privacyProblems(fullPlist.replace(CAMERA_ENTITLEMENT, "com.apple.security.cs.other"), fullBuilder);
  check(
    "P2-169: missing camera entitlement → one problem citing the entitlement",
    cameraEntMissing.length === 1 && cameraEntMissing[0].includes(CAMERA_ENTITLEMENT),
    JSON.stringify(cameraEntMissing),
  );

  const blank = privacyProblems(fullPlist, fullBuilder.replace(`"O OpenCode Remote usa a câmera para ler o QR code de pareamento."`, '""'));
  check(
    "P2-169: present-but-empty usage description → problem citing the key and 'empty'",
    blank.length === 1 && blank[0].includes(CAMERA_KEY) && blank[0].includes("empty"),
    JSON.stringify(blank),
  );

  // every problem at once, never just the first (5 = 2 missing descriptions + 2 missing entitlements + 1 blank)
  const all = privacyProblems("<plist><dict/></plist>", "builder: yml");
  check(
    "P2-169: an empty pair reports all four problems at once",
    all.length === 4 && all.some((p) => p.includes(MIC_KEY)) && all.some((p) => p.includes(CAMERA_KEY)) && all.some((p) => p.includes(AUDIO_ENTITLEMENT)) && all.some((p) => p.includes(CAMERA_ENTITLEMENT)),
    JSON.stringify(all),
  );

  // commented-out keys in the yml count as absent; <false/> counts as absent
  const commented = privacyProblems(fullPlist, `# ${MIC_KEY}: "nada"\n  ${CAMERA_KEY}: "câmera"`);
  check(
    "P2-169: a usage description only inside a # comment counts as missing",
    commented.length === 1 && commented[0].includes(MIC_KEY),
    JSON.stringify(commented),
  );
  const falseEnt = fullPlist.replace(`<key>${CAMERA_ENTITLEMENT}</key>\n    <true/>`, `<key>${CAMERA_ENTITLEMENT}</key>\n    <false/>`);
  check(
    "P2-169: camera entitlement set to <false/> counts as missing",
    privacyProblems(falseEnt, fullBuilder).length === 1,
  );

  // real-repo assertion: the shipped pair is complete and carries the 4 new keys
  const root = join(import.meta.dirname, "..");
  const realPlist = readFileSync(join(root, "apps", "desktop", "build", "entitlements.mac.plist"), "utf8");
  const realBuilder = readFileSync(join(root, "apps", "desktop", "electron-builder.yml"), "utf8");
  check(
    "P2-169: real repo — plist has both device entitlements, yml has both usage descriptions, pair is complete",
    realPlist.includes(AUDIO_ENTITLEMENT) &&
      realPlist.includes(CAMERA_ENTITLEMENT) &&
      realBuilder.includes(`${MIC_KEY}:`) &&
      realBuilder.includes(`${CAMERA_KEY}:`) &&
      privacyProblems(realPlist, realBuilder).length === 0,
  );
}

// --- self-serve mission: mission.json spec, hash drift, generic gate profile ---
{
  const GH = "https://github.com/acme/widgets.git";
  // parsing / validation
  const both = parseMissionSpec(JSON.stringify({ v: 1, prompt: "  build a CLI  ", repoUrl: "https://github.com/acme/widgets", setAt: "2026-09-05T10:00:00Z" }));
  check(
    "mission: prompt + repoUrl parse, prompt trimmed, url normalized to .git",
    both?.v === 1 && both.prompt === "build a CLI" && both.repoUrl === GH && both.setAt === "2026-09-05T10:00:00Z",
    JSON.stringify(both),
  );
  const promptOnly = parseMissionSpec(JSON.stringify({ v: 1, prompt: "ship dark mode", setAt: "2026-09-05T10:00:00Z" }));
  check("mission: prompt-only spec is valid (repoUrl absent)", promptOnly?.prompt === "ship dark mode" && promptOnly.repoUrl === undefined);
  const repoOnly = parseMissionSpec(JSON.stringify({ v: 1, repoUrl: "https://github.com/acme/widgets.git/", setAt: "x" }));
  check("mission: repo-only spec is valid, trailing slash dropped, garbage setAt → empty", repoOnly?.repoUrl === GH && repoOnly.prompt === undefined && repoOnly.setAt === "");
  check("mission: empty repoUrl string is treated as absent", parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", repoUrl: "" }))?.repoUrl === undefined);
  check(
    "mission: neither prompt nor repoUrl → null",
    parseMissionSpec(JSON.stringify({ v: 1, prompt: "   ", setAt: "2026-09-05T10:00:00Z" })) === null &&
      parseMissionSpec(JSON.stringify({ v: 1, setAt: "2026-09-05T10:00:00Z" })) === null,
  );
  check(
    "mission: wrong/missing version → null",
    parseMissionSpec(JSON.stringify({ v: 2, prompt: "x" })) === null && parseMissionSpec(JSON.stringify({ prompt: "x" })) === null,
  );
  check(
    "mission: invalid repoUrl rejects the whole spec (never silently dropped)",
    ["http://github.com/acme/widgets", "https://gitlab.com/acme/widgets", "https://github.com/acme", "https://github.com/acme/widgets/tree/main", "https://github.com/../etc", "git@github.com:acme/widgets.git", "https://github.com/acme/wid gets"].every(
      (u) => parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", repoUrl: u })) === null,
    ),
  );
  check(
    "mission: garbage never throws → null",
    parseMissionSpec("{not json") === null && parseMissionSpec("[1,2]") === null && parseMissionSpec("") === null && parseMissionSpec(null) === null && parseMissionSpec("42") === null,
  );
  check("mission: over-long prompt → null", parseMissionSpec(JSON.stringify({ v: 1, prompt: "a".repeat(MISSION_PROMPT_MAX + 1) })) === null);
  check("mission: prompt at the cap is accepted", parseMissionSpec(JSON.stringify({ v: 1, prompt: "a".repeat(MISSION_PROMPT_MAX) }))?.prompt?.length === MISSION_PROMPT_MAX);

  // repo url shape
  check(
    "mission: repoSlug/validRepoUrl accept the documented shape only",
    JSON.stringify(repoSlug("https://github.com/acme/widgets")) === JSON.stringify({ org: "acme", repo: "widgets" }) &&
      JSON.stringify(repoSlug("https://github.com/acme/widgets.git")) === JSON.stringify({ org: "acme", repo: "widgets" }) &&
      validRepoUrl("https://github.com/a-b_c.d/e.f-g") &&
      !validRepoUrl("https://github.com/../x") &&
      !validRepoUrl("https://github.com/x/..") &&
      !validRepoUrl("https://github.com/x/.") &&
      !validRepoUrl(42) &&
      GITHUB_REPO_URL_RE.test("https://github.com/acme/widgets.git"),
  );
  check("mission: normalizeRepoUrl adds .git, null for invalid", normalizeRepoUrl("https://github.com/acme/widgets") === GH && normalizeRepoUrl("nope") === null);
  check("mission: workspace key is org--repo, null for this repo", missionWorkspaceKey(both) === "acme--widgets" && missionWorkspaceKey(promptOnly) === null && missionWorkspaceKey(null) === null);

  // hash tracking + drift (the self-reload trigger)
  const h1 = missionHash('{"v":1,"prompt":"a"}');
  const h2 = missionHash('{"v":1,"prompt":"b"}');
  check("mission hash: sha256 hex, stable, content-sensitive", /^[0-9a-f]{64}$/.test(h1!) && h1 === missionHash('{"v":1,"prompt":"a"}') && h1 !== h2);
  check("mission hash: absent file → undefined", missionHash(null) === undefined && missionHash(undefined) === undefined);
  check(
    "mission drift: absent→absent and same hash never drift; appear/vanish/change do",
    missionDrifted(undefined, undefined) === false &&
      missionDrifted(h1, h1) === false &&
      missionDrifted(undefined, h1) === true &&
      missionDrifted(h1, undefined) === true &&
      missionDrifted(h1, h2) === true,
  );

  // readMission: injectable reader, never throws
  const missing = readMission("/nope/mission.json", () => {
    throw new Error("ENOENT");
  });
  check("readMission: absent file → raw null, spec null, hash undefined", missing.raw === null && missing.spec === null && missing.hash === undefined);
  const rawOk = JSON.stringify({ v: 1, prompt: "go", setAt: "2026-09-05T10:00:00Z" });
  const present = readMission("/x/mission.json", () => rawOk);
  check("readMission: present file → parsed spec + hash of the raw text", present.spec?.prompt === "go" && present.hash === missionHash(rawOk));
  const invalid = readMission("/x/mission.json", () => "garbage");
  check("readMission: invalid file → spec null but hash still tracked (a fix later drifts)", invalid.spec === null && invalid.raw === "garbage" && invalid.hash === missionHash("garbage"));

  // atomic 0600 write (daemon.json contract) against a fake fs
  const fakeIo = () => {
    const files = new Map<string, string>();
    const modes: number[] = [];
    const renames: string[] = [];
    const unlinks: string[] = [];
    const io: MissionFileIo = {
      writeFileSync: (f, d, o) => {
        files.set(f, d);
        modes.push(o.mode);
      },
      renameSync: (a, b) => {
        renames.push(`${a}->${b}`);
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      unlinkSync: (f) => {
        unlinks.push(f);
        files.delete(f);
      },
    };
    return { io, files, modes, renames, unlinks };
  };
  const dest = "/m/mission.json";
  const okIo = fakeIo();
  const written = writeMissionSpec({ v: 1, prompt: "go", repoUrl: GH, setAt: "2026-09-05T10:00:00Z" }, dest, okIo.io);
  check(
    "writeMissionSpec: tmp created 0600, renamed over the destination, no tmp survives",
    okIo.modes.join() === String(0o600) && okIo.renames.join() === `${dest}.tmp->${dest}` && okIo.files.get(dest) === written && !okIo.files.has(`${dest}.tmp`),
  );
  check("writeMissionSpec: what lands parses back to the same spec", parseMissionSpec(written)?.repoUrl === GH && parseMissionSpec(written)?.prompt === "go");
  const badIo = fakeIo();
  badIo.io.renameSync = () => {
    throw new Error("EXDEV");
  };
  badIo.files.set(dest, "previous");
  let threw = false;
  try {
    writeMissionSpec({ v: 1, prompt: "go", setAt: "" }, dest, badIo.io);
  } catch {
    threw = true;
  }
  check("writeMissionSpec: failed rename rethrows, removes the tmp, keeps the old file", threw && badIo.files.get(dest) === "previous" && badIo.unlinks.join() === `${dest}.tmp`);
  const noneIo = fakeIo();
  let refused = false;
  try {
    writeMissionSpec({ v: 1, setAt: "" }, dest, noneIo.io);
  } catch {
    refused = true;
  }
  check("writeMissionSpec: invalid spec (no prompt, no repo) refused before any write", refused && noneIo.modes.length === 0);
  const mdir = mkdtempSync(join(tmpdir(), "ocr-mission-"));
  try {
    const mfile = join(mdir, "mission.json");
    writeMissionSpec({ v: 1, prompt: "real fs", setAt: "2026-09-05T10:00:00Z" }, mfile);
    check("writeMissionSpec: real fs lands 0600, round-trips, leaves no .tmp", (statSync(mfile).mode & 0o777) === 0o600 && readMission(mfile).spec?.prompt === "real fs" && readdirSync(mdir).join() === "mission.json");
  } finally {
    rmSync(mdir, { recursive: true, force: true });
  }

  // generic gate profile (in-repo mirror of the judge's builder)
  const gp = buildGenericProfile({ typecheck: "tsc", build: "vite build", test: "vitest", lint: "eslint .", "test:unit": "x", prepare: "evil", postinstall: "evil" });
  check(
    "generic profile: typecheck|build|test|lint only, allowlist order, npm run <name> --silent, 10min cap",
    gp.kind === "generic" &&
      gp.steps.map(([n]) => n).join(",") === "typecheck,build,test,lint" &&
      gp.steps.every(([n, c]) => c === `npm run ${n} --silent`) &&
      gp.stepTimeoutMin === GENERIC_STEP_TIMEOUT_MIN &&
      GENERIC_STEP_TIMEOUT_MIN === 10 &&
      GENERIC_GATE_SCRIPTS.join(",") === "typecheck,build,test,lint",
  );
  check("generic profile: absent/empty/non-string scripts skipped; garbage table → no steps", buildGenericProfile({ test: "", build: 3, lint: "eslint" }).steps.map(([n]) => n).join() === "lint" && buildGenericProfile(null).steps.length === 0 && buildGenericProfile("x").steps.length === 0);
  check("generic profile: never a pilot-only step (invariants/desktop/corpus)", !gp.steps.some(([n]) => ["invariants", "desktop-render", "desktop-flow", "corpus", "reconnect", "integration"].includes(n)));
  const pin = { prodCheckout: "/prod/opencode-remote", slotRoot: "/home/u/.opencode-remote/pilot" };
  const foreign = detectGateProfile("/ws/foreign", { ...pin, readPackageJson: () => ({ name: "someone", scripts: { test: "jest", lint: "eslint", start: "node ." } }) });
  check("detectGateProfile: foreign package.json → generic with only its allowlisted scripts", foreign.kind === "generic" && foreign.steps.map(([n]) => n).join(",") === "test,lint");
  // mission v2 (hardening a): the pilot profile is pinned to the PRODUCTION
  // CHECKOUT PATH (+ its slot clones), never to a package.json field
  const spoofByName = detectGateProfile("/home/u/.opencode-remote/pilot/mission/evil--repo/repo-1", { ...pin, readPackageJson: () => ({ name: "opencode-remote", scripts: { typecheck: "x", test: "evil" } }) });
  check("detectGateProfile: foreign repo named opencode-remote in a mission clone → generic (profile spoofing closed)", spoofByName.kind === "generic" && spoofByName.steps.map(([n]) => n).join(",") === "typecheck,test");
  const spoofByTree = detectGateProfile("/ws/spoof", { ...pin, readPackageJson: () => ({ name: "renamed", scripts: { test: "x" } }) });
  check("detectGateProfile: a foreign tree shipping apps/pilot/src/pipeline.ts does not earn the pilot battery", spoofByTree.kind === "generic");
  const pilotProd = detectGateProfile("/prod/opencode-remote/", { ...pin, readPackageJson: () => ({ name: "anything", scripts: {} }) });
  const pilotSlot = detectGateProfile("/home/u/.opencode-remote/pilot/repo-3", { ...pin, readPackageJson: () => null });
  check("detectGateProfile: production checkout + its slot clones keep the full battery by path (package.json irrelevant)", pilotProd.kind === "pilot" && pilotSlot.kind === "pilot" && pilotProd.steps.length === PILOT_GATE_STEPS.length);
  check(
    "isPilotCheckoutPath: prod (normalized), pilot/repo-N yes; mission clones, nested, sibling names, garbage no",
    isPilotCheckoutPath("/prod/opencode-remote", pin) &&
      isPilotCheckoutPath("/prod/x/../opencode-remote/", pin) &&
      isPilotCheckoutPath("/home/u/.opencode-remote/pilot/repo-1", pin) &&
      !isPilotCheckoutPath("/home/u/.opencode-remote/pilot/mission/acme--widgets/repo-1", pin) &&
      !isPilotCheckoutPath("/home/u/.opencode-remote/pilot/repo-1/sub", pin) &&
      !isPilotCheckoutPath("/home/u/.opencode-remote/pilot/repo-x", pin) &&
      !isPilotCheckoutPath("/home/u/.opencode-remote/pilot", pin) &&
      !isPilotCheckoutPath("", pin),
  );
  check("detectGateProfile: no package.json → unknown (fail closed)", detectGateProfile("/ws/none", { ...pin, readPackageJson: () => null }).kind === "unknown");

  // chat-side convention injected into daemon sessions
  const mblock = buildMissionPrompt();
  check(
    "mission prompt: marker, file hint, schema fields, url shape, atomic 0600 write, one-sentence confirmation — no per-session datum",
    mblock.includes(`[${MISSION_MARKER}]`) &&
      mblock.includes(MISSION_FILE_HINT) &&
      mblock.includes('"v":1') &&
      mblock.includes('"repoUrl"') &&
      mblock.includes('"setAt"') &&
      mblock.includes("https://github.com/<org>/<repo>(.git)?") &&
      mblock.includes("chmod 600") &&
      mblock.includes(".tmp") &&
      mblock.includes("próximo boot") &&
      !mblock.includes("ses_"),
  );
  // v2: generalist intent capture + model pins + clear path, all in the same constant block
  check(
    "mission prompt v2: composes the whole file (vague/link-only/rich), deduces repoUrl from any GitHub link, faithful prompt, models roles verified via `opencode models`, rm clear path",
    mblock.includes('"models"') &&
      mblock.includes(MISSION_MODEL_ROLES.join("|")) &&
      mblock.includes("opencode models") &&
      mblock.includes("provider/modelo") &&
      mblock.includes("/tree/") &&
      mblock.includes("Nunca invente") &&
      mblock.includes(`rm -f ${MISSION_FILE_HINT}`) &&
      mblock.includes("encerrar missão") &&
      mblock.includes("quais modelos?"),
  );
  const s1: { system?: string } = {};
  const s2: { system?: string } = { system: "SYS" };
  injectArtifactsSystem(s1);
  injectArtifactsSystem(s2);
  injectArtifactsSystem(s2);
  check(
    "mission prompt: rides the session injection once (dedupe), after the client prompt, byte-identical block across sessions",
    s1.system!.includes(mblock) &&
      s2.system!.startsWith("SYS") &&
      s2.system!.split(MISSION_MARKER).length - 1 === 1 &&
      s1.system === injectArtifactsSystem({} as { system?: string }).system,
  );
  const partial: { system?: string } = { system: `[${ARTIFACTS_MARKER}] já ensinado` };
  injectArtifactsSystem(partial);
  check("mission prompt: a system that only has the artifacts block gains the mission block (and not a second artifacts one)", partial.system!.includes(MISSION_MARKER) && partial.system!.split(ARTIFACTS_MARKER).length - 1 === 1);
  const agentsMd = readFileSync(join(import.meta.dirname, "..", "AGENTS.md"), "utf8");
  check("mission convention: this repo's AGENTS.md (which skips the injection) teaches the same file + shape", agentsMd.includes("mission.json") && agentsMd.includes('"v":1') && agentsMd.includes("chmod 600"));
  check(
    "mission convention v2: AGENTS.md mirrors models roles, `opencode models` verification and the rm clear path",
    agentsMd.includes('"models"') && agentsMd.includes(MISSION_MODEL_ROLES.join("|")) && agentsMd.includes("opencode models") && agentsMd.includes("rm -f ~/.opencode-remote/mission.json"),
  );

  // researcher prompt: stable prefix intact, mission appended as the tail
  const base = researcherPrompt();
  const withMission = researcherPrompt("build the best CLI");
  check(
    "researcherPrompt: default unchanged (no override block); mission rides the tail before the done marker",
    !base.includes("MISSION OVERRIDE") &&
      withMission.includes("MISSION OVERRIDE") &&
      withMission.includes("build the best CLI") &&
      withMission.startsWith(base.slice(0, base.indexOf("Your LAST line"))) &&
      withMission.trimEnd().endsWith("RESEARCHER:DONE"),
  );

  // i18n: en + pt for every new user-visible string
  for (const k of ["missionActive", "missionActiveNone", "missionSource", "missionSourcePrompt", "missionSourceRepo", "missionSetAt", "missionModels", "missionClear", "missionClearConfirm", "missionCleared", "missionClearFailed"]) {
    check(`i18n: ${k} in en and pt`, typeof (dict.en as Record<string, string>)[k] === "string" && typeof (dict.pt as Record<string, string>)[k] === "string");
  }
  check("mission card: models line renders role=model pairs, empty when absent", formatMissionModels({ builder: "glm52/glm-5.2", scribe: "opencode/big-pickle" }) === "builder=glm52/glm-5.2, scribe=opencode/big-pickle" && formatMissionModels(undefined) === "" && formatMissionModels({}) === "");

  // source pins: the loop routes mission drift through the pure seam, the
  // boot hash is captured once, and a foreign mission never deploys
  const pilotIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "index.ts"), "utf8");
  check(
    "mission: loop self-reload routed through missionDrifted(bootMissionHash, missionNow) on the same drift path",
    pilotIndexSrc.includes("missionDrifted(bootMissionHash, missionNow)") &&
      pilotIndexSrc.includes("const bootMissionHash = missionBoot.hash") &&
      pilotIndexSrc.includes("headDrifted(bootHead, headNow) ? \"head\" : missionDrifted(bootMissionHash, missionNow)"),
  );
  check(
    "mission: foreign repo gates both deploy paths (pending deploy + post-merge launch)",
    pilotIndexSrc.includes("!deployBusy && !foreignMission && state.deploys") && pilotIndexSrc.includes("if (foreignMission) {"),
  );
  check("mission: strategist/researcher take the chat-defined prompt", pilotIndexSrc.includes("activeMission?.prompt ?? STRATEGIST_MISSION") && pilotIndexSrc.includes("runResearcher(aux, state, activeMission?.prompt)"));
  check(
    "mission v2: per-mission state root + key + models are derived before the slot configs are cloned",
    pilotIndexSrc.indexOf("cfg.stateRoot = slotRoot") < pilotIndexSrc.indexOf("slotCfg.set(s, ensureSlotWorkspace(cfg, s, slotRoot))") &&
      pilotIndexSrc.includes("cfg.missionModels = activeMission?.models") &&
      pilotIndexSrc.includes("defaultPendingRefillFile(stateRoot)") &&
      pilotIndexSrc.includes('gateFailDir: join(stateRoot, "gate-fail")'),
  );
  check(
    "mission v2: infra starvation pins the counter at the cap BEFORE the block landing (dead remote cannot resurrect the task)",
    pilotIndexSrc.indexOf("state.taskAttempts[taskKey] = Math.max(") < pilotIndexSrc.indexOf("await blockAndPush(taskCfg, state, task, attempts, reason, true)"),
  );
  const daemonSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  check(
    "mission v2: DELETE /api/mission lives behind the shared /api auth gate and calls removeMissionFile",
    daemonSrc.indexOf('seg[1] === "mission" && !seg[2] && req.method === "DELETE"') > daemonSrc.indexOf("if (!authorized(req)) {\n    send401(res);\n    return true;\n  }\n  const op = ") &&
      daemonSrc.includes("const r = removeMissionFile();"),
  );
  const desktopMain = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  check("mission v2: desktop daemonApi allowlist admits GET pilot-mission and DELETE /api/mission only", desktopMain.includes("shot|mission)$/") && desktopMain.includes("/^\\/api\\/mission$/"));
}

// --- mission self-serve v2: models schema, dispatch override, catalog, starvation breaker, state namespace ---
{
  const GH = "https://github.com/acme/widgets.git";
  const at = "2026-09-05T10:00:00Z";
  // schema: optional models block, subset of roles, provider/model ids
  const withModels = parseMissionSpec(JSON.stringify({ v: 1, prompt: "fix the login bug", repoUrl: GH, models: { builder: "glm52/glm-5.2", reviewer: "anthropic/claude-opus-4-1" }, setAt: at }));
  check(
    "mission v2: models subset parses, other roles default (undefined)",
    withModels?.models?.builder === "glm52/glm-5.2" && withModels.models.reviewer === "anthropic/claude-opus-4-1" && missionModelFor(withModels, "scribe") === undefined && missionModelFor(withModels, "builder") === "glm52/glm-5.2",
  );
  check("mission v2: all five roles accepted", parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", models: Object.fromEntries(MISSION_MODEL_ROLES.map((r) => [r, "p/m"])), setAt: at }))?.models !== undefined && MISSION_MODEL_ROLES.join(",") === "strategist,researcher,builder,reviewer,scribe");
  check("mission v2: unknown role rejects the WHOLE spec (never silently dropped)", parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", models: { planner: "p/m" }, setAt: at })) === null && parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", models: { builder: "p/m", judge: "p/m" }, setAt: at })) === null);
  check(
    "mission v2: malformed model id rejects the spec (needs provider/model, safe charset, bounded length)",
    ["opus", "", " p/m", "p/m x", "p//m", "/m", "p/", "a".repeat(129), "p/$(rm)"].every((id) => parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", models: { builder: id }, setAt: at })) === null) &&
      validModelId("hpc-ai/deepseek/deepseek-v4-flash") &&
      validModelId("opencode/big-pickle") &&
      !validModelId(42),
  );
  check("mission v2: models absent/null/empty → no models field; array/string → invalid", parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", setAt: at }))?.models === undefined && parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", models: null, setAt: at }))?.models === undefined && parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", models: {}, setAt: at }))?.models === undefined && parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", models: ["p/m"], setAt: at })) === null && parseMissionSpec(JSON.stringify({ v: 1, prompt: "x", models: "p/m", setAt: at })) === null);
  const pm = parseMissionModels({ scribe: "p/m", oops: "p/m" });
  check("parseMissionModels: reason names the offending role and the valid list", !pm.ok && pm.reason.includes('"oops"') && pm.reason.includes(MISSION_MODEL_ROLES.join("|")));
  check("parseMissionModels: bad id reason names the role", (() => { const r = parseMissionModels({ builder: "nope" }); return !r.ok && r.reason.includes("builder"); })());
  // write round-trips models; a bad models block is refused before any write
  const files = new Map<string, string>();
  const io: MissionFileIo = {
    writeFileSync: (f, d) => void files.set(f, d),
    renameSync: (a, b) => { files.set(b, files.get(a)!); files.delete(a); },
    unlinkSync: (f) => void files.delete(f),
  };
  const text = writeMissionSpec({ v: 1, prompt: "go", models: { builder: "p/m" }, setAt: at }, "/m/mission.json", io);
  check("writeMissionSpec v2: models survive the round-trip", parseMissionSpec(text)?.models?.builder === "p/m" && parseMissionSpec(files.get("/m/mission.json"))?.models?.builder === "p/m");
  let refused = false;
  try {
    writeMissionSpec({ v: 1, prompt: "go", models: { builder: "not-an-id" }, setAt: at }, "/m/mission.json", io);
  } catch {
    refused = true;
  }
  check("writeMissionSpec v2: invalid models block refused, previous file intact", refused && parseMissionSpec(files.get("/m/mission.json"))?.models?.builder === "p/m");
  // clear path: unlink is the whole operation; ENOENT is the desired state, other errors surface
  const unlinked: string[] = [];
  check("removeMissionFile: removes and reports", removeMissionFile("/m/mission.json", { unlinkSync: (f) => void unlinked.push(f) }).removed === true && unlinked.join() === "/m/mission.json");
  check("removeMissionFile: absent file → removed:false, no throw", removeMissionFile("/m/none.json", { unlinkSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } }).removed === false);
  let rethrown = false;
  try {
    removeMissionFile("/m/x.json", { unlinkSync: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } });
  } catch {
    rethrown = true;
  }
  check("removeMissionFile: other fs errors rethrow (route answers 500, never lies)", rethrown);
  const rdir = mkdtempSync(join(tmpdir(), "ocr-mission-rm-"));
  try {
    const f = join(rdir, "mission.json");
    writeMissionSpec({ v: 1, prompt: "real", setAt: at }, f);
    check("removeMissionFile: real fs — file gone, hash drifts to undefined (pilot self-restarts to default)", removeMissionFile(f).removed && readMission(f).hash === undefined && !existsSync(f));
  } finally {
    rmSync(rdir, { recursive: true, force: true });
  }

  // catalog: provider/model ids exactly as `opencode models` prints them
  const catalog = parseProviderCatalog({ all: [{ id: "glm52", models: { "glm-5.2": {} } }, { id: "hpc-ai", models: { "deepseek/deepseek-v4-flash": {} } }, { id: "", models: { x: {} } }, null, { id: "nomodels" }, { id: "opencode", models: "garbage" }] });
  check("parseProviderCatalog: <provider.id>/<model key>, slashes in keys kept, garbage entries skipped", [...catalog].sort().join() === "glm52/glm-5.2,hpc-ai/deepseek/deepseek-v4-flash");
  check("parseProviderCatalog: non-catalog input → empty set", parseProviderCatalog(null).size === 0 && parseProviderCatalog({ all: "x" }).size === 0 && parseProviderCatalog("x").size === 0);
  // pure dispatch decision
  const models = { builder: "glm52/glm-5.2", scribe: "gone/model" };
  check("pickMissionModel: configured + available → mission", JSON.stringify(pickMissionModel(models, "builder", catalog)) === JSON.stringify({ model: "glm52/glm-5.2", source: "mission" }));
  const gone = pickMissionModel(models, "scribe", catalog);
  check("pickMissionModel: configured but not in the catalog → default + reason + wanted (warn log material)", gone.model === null && gone.source === "default" && gone.wanted === "gone/model" && /not available/.test(gone.reason ?? ""));
  const noCat = pickMissionModel(models, "builder", null);
  check("pickMissionModel: catalog unreachable → default with reason (cannot verify → never trust the file alone)", noCat.model === null && /unavailable/.test(noCat.reason ?? "") && noCat.wanted === "glm52/glm-5.2");
  check("pickMissionModel: role without a pin → default silently (no reason)", JSON.stringify(pickMissionModel(models, "reviewer", catalog)) === JSON.stringify({ model: null, source: "default" }) && pickMissionModel(undefined, "builder", catalog).model === null);
  // live catalog fetch: cached per TTL, failures never cached
  resetCatalogCache();
  let fetches = 0;
  const okFetch = (async () => {
    fetches++;
    return { ok: true, json: async () => ({ all: [{ id: "p", models: { m: {} } }] }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const c1 = await fetchAvailableModels({ url: "http://x", fetchImpl: okFetch, now: 1_000 });
  const c2 = await fetchAvailableModels({ url: "http://x", fetchImpl: okFetch, now: 1_000 + CATALOG_TTL_MS - 1 });
  const c3 = await fetchAvailableModels({ url: "http://x", fetchImpl: okFetch, now: 1_000 + CATALOG_TTL_MS + 1 });
  check("fetchAvailableModels: one fetch inside the TTL, refetch after it", c1?.has("p/m") === true && c2 === c1 && c3 !== c1 && fetches === 2);
  resetCatalogCache();
  const downFetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const emptyFetch = (async () => ({ ok: true, json: async () => ({ all: [] }) })) as unknown as typeof fetch;
  const notOk = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  check("fetchAvailableModels: network error / non-200 / empty catalog → null (cannot verify), nothing cached", (await fetchAvailableModels({ fetchImpl: downFetch })) === null && (await fetchAvailableModels({ fetchImpl: notOk })) === null && (await fetchAvailableModels({ fetchImpl: emptyFetch })) === null);
  resetCatalogCache();

  // dispatch override path: runAgentForRole → opencode run --model <id> only when the catalog lists it
  const seen: string[][] = [];
  const argvSpawn = ((_cmd: string, args: string[]) => {
    seen.push(args);
    return spawn(process.execPath, ["-e", "process.exit(0)"]);
  }) as unknown as typeof spawn;
  // substitutionsFile: the fallback path records into a file — keep it out of $HOME
  const substTmp = mkdtempSync(join(tmpdir(), "ocr-subst-dispatch-"));
  const base = { cwd: tmpdir(), timeoutMin: 1, label: "t", preflight: async () => true, spawnImpl: argvSpawn, substitutionsFile: join(substTmp, "model-substitutions.json") };
  await runAgentForRole("builder", "hello", { ...base, missionModels: { builder: "glm52/glm-5.2" }, catalog: async () => new Set(["glm52/glm-5.2"]) });
  check("runAgentForRole v2: mission model verified in the catalog → `opencode run --model <id> <prompt>` (one argv entry)", JSON.stringify(seen[0]) === JSON.stringify(["run", "--model", "glm52/glm-5.2", "hello"]));
  await runAgentForRole("builder", "hello", { ...base, missionModels: { builder: "glm52/glm-5.2" }, catalog: async () => new Set(["other/model"]) });
  check("runAgentForRole v2: mission model NOT in the catalog → tier default argv (no --model), slot alive", JSON.stringify(seen[1]) === JSON.stringify(["run", "hello"]));
  await runAgentForRole("reviewer", "hello", { ...base, missionModels: { builder: "glm52/glm-5.2" }, catalog: async () => { throw new Error("must not be called for an unpinned role"); } });
  check("runAgentForRole v2: unpinned role never consults the catalog and runs the default", JSON.stringify(seen[2]) === JSON.stringify(["run", "hello"]));
  await runAgentForRole("scribe", "hello", { ...base, missionModels: { scribe: "p/m" }, catalog: async () => null });
  check("runAgentForRole v2: catalog unreachable → default argv (fail closed to the default, never to the unverified id)", JSON.stringify(seen[3]) === JSON.stringify(["run", "hello"]));
  await runAgentForRole("builder", "hello", { ...base, missionModels: { builder: "p/m" }, models: { tierB: { builder: "opus" } }, catalog: async () => null });
  check("runAgentForRole v2: execution roles never route to tier B even if pilot.json names them", JSON.stringify(seen[4]) === JSON.stringify(["run", "hello"]));
  await runAgent("p", { ...base, sessionId: "ses_abc12345", model: "p/m" });
  check("runAgent: --model argv placement pinned (run [-s ses] --model id prompt)", seen.some((a) => JSON.stringify(a) === JSON.stringify(["run", "-s", "ses_abc12345", "--model", "p/m", "p"])));

  // per-mission state namespace (hardening c)
  check("attemptsKey: bare id for this repo, <key>/<id> for a foreign mission", attemptsKey(null, "P2-001") === "P2-001" && attemptsKey(undefined, "P2-001") === "P2-001" && attemptsKey("acme--widgets", "P2-001") === "acme--widgets/P2-001");
  const nsState = loadState("/nope/state.json");
  recordTaskFailure(nsState, attemptsKey("acme--widgets", "P2-001"), 4);
  check("state namespace: a foreign P2-001 failure never touches our P2-001 counter", nsState.taskAttempts["acme--widgets/P2-001"] === 1 && nsState.taskAttempts["P2-001"] === undefined);
  check("bareTaskId: strips the mission namespace, bare ids pass through", bareTaskId("acme--widgets/P2-001") === "P2-001" && bareTaskId("P2-001") === "P2-001");
  check("doctor: a foreign task under retry still protects its pilot/<id> branch (namespace stripped)", protectedBranchIds(nsState).has("P2-001") && !protectedBranchIds(nsState).has("acme--widgets/P2-001"));
  check("defaultPendingRefillFile: per-mission root, default unchanged", defaultPendingRefillFile("/r/mission/acme--widgets") === "/r/mission/acme--widgets/pending-refill.json" && defaultPendingRefillFile().endsWith(join(".opencode-remote", "pilot", "pending-refill.json")));
  check("gateFailFile: per-mission root, id charset still enforced", gateFailFile("/r/mission/k", "P2-001") === "/r/mission/k/gate-fail/P2-001.json" && gateFailFile("/r", "../x") === null);

  // starvation breaker (hardening b)
  const st = loadState("/nope/state.json");
  const key = "acme--widgets/P2-009";
  check("infra streak: same kind accumulates 1,2,3", recordTaskInfraStreak(st, key, "network") === 1 && recordTaskInfraStreak(st, key, "network") === 2 && recordTaskInfraStreak(st, key, "network") === 3 && st.infraStreaks?.[key]?.n === 3);
  check("infra streak: threshold is 3 consecutive identical failures", INFRA_STREAK_HARD_FAIL === 3 && !infraStreakExhausted(2) && infraStreakExhausted(3) && infraStreakExhausted(4));
  check("infra streak: a DIFFERENT kind restarts at 1 (signal = identical failure repeating)", recordTaskInfraStreak(st, key, "timeout") === 1 && st.infraStreaks?.[key]?.kind === "timeout");
  check("infra streak: per task key — another task starts at 1", recordTaskInfraStreak(st, "acme--widgets/P2-010", "network") === 1 && st.infraStreaks?.[key]?.n === 1);
  clearTaskInfraStreak(st, key);
  check("infra streak: cleared by a non-infra outcome; clearing an unknown key is a no-op", st.infraStreaks?.[key] === undefined && (clearTaskInfraStreak(st, "nope"), true));
  check("infra starvation reason: names the kind, the count and the hard-failure decision (no secrets)", /"network" failed 3x in a row/.test(infraStarvationReason("network", 3)) && infraStarvationReason("network", 3).includes("hard failure"));
  // streaks survive the midnight rollover and garbage is dropped on load
  const sdir = mkdtempSync(join(tmpdir(), "ocr-streak-"));
  try {
    const sf = join(sdir, "state.json");
    writeFileSync(sf, JSON.stringify({ date: "2000-01-01", tasks: 9, taskAttempts: {}, infraStreaks: { a: { kind: "network", n: 2 }, b: { kind: "", n: 1 }, c: { kind: "spawn", n: 0 }, d: "x", e: { kind: "timeout", n: 1.7 } } }));
    const loaded = loadState(sf);
    check("infra streaks: survive the daily rollover, garbage/zero/empty entries dropped, fractional floored", loaded.tasks === 0 && JSON.stringify(loaded.infraStreaks) === JSON.stringify({ a: { kind: "network", n: 2 }, e: { kind: "timeout", n: 1 } }));
  } finally {
    rmSync(sdir, { recursive: true, force: true });
  }
}

// --- P2-170: gatekeeper-verify — the packaged app must survive Gatekeeper before upload
{
  // Realistic tool outputs of a healthy Developer ID + notarized run on the
  // packaged app (codesign -v --verbose=2 prints "valid on disk", spctl says
  // accepted, stapler says the validate action worked).
  const healthy = {
    mode: "developer-id",
    notarizeRequested: true,
    codesign: "apps/desktop/dist/mac-arm64/OpenCode Remote.app: valid on disk\napps/desktop/dist/mac-arm64/OpenCode Remote.app: satisfies its Designated Requirement\n",
    spctl: "apps/desktop/dist/mac-arm64/OpenCode Remote.app: accepted\nsource=Developer ID: Application: Example (TEAM1234)\norigin=Developer ID: Application: Example (TEAM1234)\n",
    stapler: "The validate action worked for apps/desktop/dist/mac-arm64/OpenCode Remote.app\n",
  };

  check(
    "P2-170: developer-id + success outputs of all three tools → no problems",
    gatekeeperProblems(healthy).length === 0,
    JSON.stringify(gatekeeperProblems(healthy)),
  );

  // spctl rejecting a Developer ID build = Gatekeeper would block the app
  const rejected = gatekeeperProblems({
    ...healthy,
    spctl: "apps/desktop/dist/mac-arm64/OpenCode Remote.app: rejected (the code is valid but does not seem to be an applet)\n",
  });
  check(
    "P2-170: spctl rejected in developer-id mode → problem",
    rejected.some((p) => p.includes("spctl") && p.includes("rejected")),
    JSON.stringify(rejected),
  );

  // Notarization requested but the ticket never got stapled
  const unstapled = gatekeeperProblems({
    ...healthy,
    stapler: "apps/desktop/dist/mac-arm64/OpenCode Remote.app: The staple doesn't verify\n",
  });
  check(
    "P2-170: stapler without a ticket while notarization was requested → problem",
    unstapled.some((p) => p.includes("stapler") && p.includes("ticket")),
    JSON.stringify(unstapled),
  );

  // stapler's real unstapled wording (captured: `xcrun stapler validate` on a
  // real app prints "<path> does not have a ticket stapled to it.", exit 65)
  const noTicket = gatekeeperProblems({
    ...healthy,
    stapler: "apps/desktop/dist/mac-arm64/OpenCode Remote.app does not have a ticket stapled to it.\n",
  });
  check(
    "P2-170: stapler's real 'does not have a ticket stapled to it.' while notarization was requested → problem",
    noTicket.some((p) => p.includes("stapler") && p.includes("ticket")),
    JSON.stringify(noTicket),
  );

  // Broken signature
  const invalid = gatekeeperProblems({
    ...healthy,
    codesign: "code object is not signed at all\nIn subcomponent: apps/desktop/dist/mac-arm64/OpenCode Remote.app\n",
  });
  check(
    "P2-170: invalid codesign verification → problem",
    invalid.some((p) => p.startsWith("codesign:")),
    JSON.stringify(invalid),
  );

  // Empty output of each tool is fail-closed: the verdict was never produced
  for (const tool of ["codesign", "spctl", "stapler"] as const) {
    const problems = gatekeeperProblems({ ...healthy, [tool]: "" });
    check(
      `P2-170: empty ${tool} output → problem (fail-closed)`,
      problems.some((p) => p.startsWith(`${tool}:`) && p.includes("no output")),
      JSON.stringify(problems),
    );
  }

  // Unrecognizable output is fail-closed too (Apple rewording must fail loudly)
  const gibberish = gatekeeperProblems({ ...healthy, spctl: "computer says no\n" });
  check(
    "P2-170: unrecognizable spctl output → problem",
    gibberish.some((p) => p.startsWith("spctl:") && p.includes("unrecognizable")),
    JSON.stringify(gibberish),
  );

  // The documented no-secrets path: ad-hoc build, no notarization. spctl
  // rejecting (bare verdict, no reason in parens) and stapler's real
  // unstapled wording are EXPECTED there (right-click → Open).
  const adhoc = gatekeeperProblems({
    mode: "adhoc",
    notarizeRequested: false,
    codesign: healthy.codesign,
    spctl: "apps/desktop/dist/mac-arm64/OpenCode Remote.app: rejected\n",
    stapler: "apps/desktop/dist/mac-arm64/OpenCode Remote.app does not have a ticket stapled to it.\n",
  });
  check(
    "P2-170: ad-hoc mode without notarization → no problem at all",
    adhoc.length === 0,
    JSON.stringify(adhoc),
  );

  // A drifting signing profile must be caught, not guessed
  const drifted = gatekeeperProblems({ ...healthy, mode: "self-signed" });
  check(
    "P2-170: unknown signing-profile mode → problem",
    drifted.some((p) => p.includes("mode")),
    JSON.stringify(drifted),
  );

  // --- CLI: outputs by file path, all problems at once, exit 1 -----------------
  const repoRoot = join(import.meta.dirname, "..");
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(repoRoot, "scripts", "gatekeeper-verify.ts");
  const tmp = mkdtempSync(join("/tmp", "gatekeeper-verify-"));
  for (const [name, content] of [
    ["codesign.txt", healthy.codesign],
    ["spctl.txt", healthy.spctl],
    ["stapler.txt", healthy.stapler],
  ] as const) {
    writeFileSync(join(tmp, name), content);
  }
  const runCli = (args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [tsxEntry, script, ...args], { cwd: repoRoot, encoding: "utf8" });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const cliOk = runCli(["developer-id", "true", join(tmp, "codesign.txt"), join(tmp, "spctl.txt"), join(tmp, "stapler.txt")]);
  check(
    "P2-170: cli exits 0 on a healthy developer-id run",
    cliOk.code === 0 && cliOk.out.includes("gatekeeper-verify: OK"),
    cliOk.out,
  );
  const cliFail = runCli(["developer-id", "true", join(tmp, "codesign.txt"), join(tmp, "spctl.txt"), join(tmp, "codesign.txt")]);
  check(
    "P2-170: cli exits 1 listing every problem at once (stapler fed codesign's output)",
    cliFail.code === 1 &&
      cliFail.out.includes("gatekeeper-verify: FAIL") &&
      (cliFail.out.match(/  - /g) ?? []).length === 1 &&
      cliFail.out.includes("1 problem(s) found"),
    cliFail.out,
  );

  // --- real-repo assertion: the desktop-dmg job gates the upload on Gatekeeper
  const release = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const dmgStart = release.indexOf("\n  desktop-dmg:");
  const dmgEnd = release.indexOf("\n  desktop-win:");
  const dmg = dmgStart > -1 && dmgEnd > dmgStart ? release.slice(dmgStart, dmgEnd) : "";
  check("P2-170: release.yml still has the desktop-dmg job", dmg.length > 0);
  const smokeStep = dmg.indexOf("- name: Smoke-check the packaged bundle");
  const gatekeeperStep = dmg.indexOf("- name: Gatekeeper verification of the packaged app");
  const uploadStep = dmg.indexOf("- name: Attach DMG + update metadata to the GitHub release");
  check(
    "P2-170: desktop-dmg runs the Gatekeeper verification between the bundle smoke and the release upload",
    smokeStep > -1 && gatekeeperStep > smokeStep && uploadStep > gatekeeperStep,
    `smoke=${smokeStep} gatekeeper=${gatekeeperStep} upload=${uploadStep}`,
  );
  const gatekeeperBlock = gatekeeperStep > -1 && uploadStep > gatekeeperStep ? dmg.slice(gatekeeperStep, uploadStep) : "";
  check(
    "P2-170: Gatekeeper step declares shell: bash (P2-126 lesson)",
    /^\s*shell:\s*bash\s*$/m.test(gatekeeperBlock),
    JSON.stringify(gatekeeperBlock),
  );
  check(
    "P2-170: Gatekeeper step runs the three tools and feeds the CLI with the signing profile verdict",
    gatekeeperBlock.includes("codesign --verify --deep --strict") &&
      gatekeeperBlock.includes("spctl -a -vv -t exec") &&
      gatekeeperBlock.includes("xcrun stapler validate") &&
      gatekeeperBlock.includes("scripts/gatekeeper-verify.ts") &&
      gatekeeperBlock.includes("steps.signing.outputs.mode") &&
      gatekeeperBlock.includes("steps.signing.outputs.notarize"),
    JSON.stringify(gatekeeperBlock),
  );
}

// --- P2-174 relay ip tag: per-process derived identifier, never the raw address ---
{
  const saltA = new Uint8Array(32).map((_, i) => i);
  const saltB = new Uint8Array(32).map((_, i) => 255 - i);
  const tagA = makeIpTagger(saltA);
  const tagB = makeIpTagger(saltB);

  const t1 = tagA("203.0.113.7");
  check("ip-tag: same address + same salt produces the same tag", tagA("203.0.113.7") === t1 && tagA("203.0.113.7") === tagA("203.0.113.7"));
  check("ip-tag: different salts produce different tags for the same address", tagB("203.0.113.7") !== t1 && tagB("203.0.113.7") === tagB("203.0.113.7"));
  check("ip-tag: different addresses produce different tags with the same salt", tagA("203.0.113.8") !== t1 && tagA("::ffff:203.0.113.7") !== t1);
  check("ip-tag: tag is exactly 12 lowercase hex digits", t1.length === IP_TAG_LENGTH && /^[0-9a-f]{12}$/.test(t1));

  // spec pin: the tag IS the 12-hex-digit sha256 prefix of salt||address
  const expected = createHash("sha256").update(saltA).update("203.0.113.7", "utf8").digest("hex").slice(0, 12);
  check("ip-tag: tag matches sha256(salt||address) first 12 hex digits", t1 === expected);

  // empty/absent/unknown never hash the empty string — fixed recognizable tag
  check("ip-tag: empty, absent and unknown addresses produce the fixed tag", tagA("") === UNKNOWN_IP_TAG && tagA(undefined) === UNKNOWN_IP_TAG && tagA(null) === UNKNOWN_IP_TAG && tagA("unknown") === UNKNOWN_IP_TAG);
  check("ip-tag: fixed tag is not the hash of the empty string", UNKNOWN_IP_TAG !== tagA("__nonempty__") && UNKNOWN_IP_TAG !== createHash("sha256").digest("hex").slice(0, 12));

  // the salt is copied at tagger creation: caller-side mutation cannot flip tags mid-process
  const saltC = new Uint8Array(32).fill(7);
  const tagC = makeIpTagger(saltC);
  const before = tagC("198.51.100.1");
  saltC.fill(9);
  check("ip-tag: mutating the caller's salt after creation does not change tags", tagC("198.51.100.1") === before);

  // fail-closed: a predictable/short salt would make tags dictionary-invertible
  let threw = false;
  try {
    makeIpTagger(new Uint8Array(8));
  } catch {
    threw = true;
  }
  check("ip-tag: salt below 32 bytes is rejected at tagger creation", threw);

  // source pin: the real index.ts logs ipTag and no ev() call ever carries
  // the raw ip field (bare word `ip` inside a log payload, with no ipTag).
  const relayIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "relay", "src", "index.ts"), "utf8");
  const evPayloads: string[] = [];
  const evRe = /\bev\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = evRe.exec(relayIndexSrc)) !== null) {
    let depth = 1;
    let i = evRe.lastIndex;
    for (; i < relayIndexSrc.length && depth > 0; i++) {
      if (relayIndexSrc[i] === "(") depth++;
      else if (relayIndexSrc[i] === ")") depth--;
    }
    evPayloads.push(relayIndexSrc.slice(evRe.lastIndex, i));
  }
  check(
    "ip-tag: index.ts logs ipTag on rejection and no ev() payload carries the raw ip field",
    evPayloads.some((p) => p.includes("ipTag: tagIp(ip)")) &&
      evPayloads.filter((p) => /\bip\b/.test(p)).every((p) => p.includes("ipTag")) &&
      !relayIndexSrc.includes("{ ip }"),
  );
}


// --- P2-179: release-publish — a draft only goes public when complete --------
{
  const TAG = "v0.3.0";
  const complete = [
    "opencode-remote-v0.3.0.tar.gz",
    "OpenCode Remote-0.3.0-arm64.dmg",
    "OpenCode Remote-0.3.0-x64.dmg",
    "OpenCode Remote-0.3.0-arm64.zip",
    "OpenCode Remote-0.3.0-x64.zip",
    "OpenCode Remote Setup 0.3.0.exe",
    "latest-mac.yml",
    "update-mac.json",
    "update-mac-arm64.json",
    "update-mac-x64.json",
    "latest.yml",
  ];
  const ok = publishDecision(true, complete, TAG);
  check(
    "P2-179: draft with the complete asset list → publish true with no problems",
    ok.publish === true && ok.problems.length === 0,
    JSON.stringify(ok),
  );

  const noDmg = publishDecision(true, complete.filter((n) => !n.endsWith(".dmg")), TAG);
  check(
    "P2-179: draft without the DMG → one problem per architecture (P2-191)",
    noDmg.publish === false &&
      noDmg.problems.length === 2 &&
      noDmg.problems.every((p) => p.includes("macOS DMG installer")),
    JSON.stringify(noDmg),
  );

  const noIntelDmg = publishDecision(true, complete.filter((n) => !n.includes("x64.dmg")), TAG);
  check(
    "P2-179: draft without the Intel DMG → problem (a release without the x64 installer stays draft, P2-191)",
    noIntelDmg.publish === false &&
      noIntelDmg.problems.length === 1 &&
      noIntelDmg.problems[0]!.includes("Intel"),
    JSON.stringify(noIntelDmg),
  );

  const noExe = publishDecision(true, complete.filter((n) => !n.endsWith(".exe")), TAG);
  check(
    "P2-179: draft without the Windows installer → problem",
    noExe.publish === false && noExe.problems.length === 1 && noExe.problems[0]!.includes("Windows NSIS setup"),
    JSON.stringify(noExe),
  );

  const feedNames = ["latest-mac.yml", "update-mac.json", "update-mac-arm64.json", "update-mac-x64.json", "latest.yml"];
  const noFeeds = publishDecision(true, complete.filter((n) => !feedNames.includes(n)), TAG);
  check(
    "P2-179: draft without the feed files → one problem per missing feed",
    noFeeds.publish === false && noFeeds.problems.length === 5,
    JSON.stringify(noFeeds),
  );

  const published = publishDecision(false, [], TAG);
  check(
    "P2-179: already-published release → publish false with NO problems (idempotent re-run)",
    published.publish === false && published.problems.length === 0,
    JSON.stringify(published),
  );

  const empty = publishDecision(true, [], TAG);
  check(
    "P2-179: draft with an empty asset list → every required slot is a problem",
    empty.publish === false && empty.problems.length === 10,
    JSON.stringify(empty),
  );

  const notList = publishDecision(true, "opencode-remote-v0.3.0.tar.gz", TAG);
  check(
    "P2-179: non-list asset input → problem, publish false",
    notList.publish === false && notList.problems.length === 1 && notList.problems[0]!.includes("not a list"),
    JSON.stringify(notList),
  );

  // --- CLI: reads the gh release view JSON from a file path, all problems at once
  const repoRoot = join(import.meta.dirname, "..");
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(repoRoot, "scripts", "release-publish.ts");
  const dir = mkdtempSync(join(tmpdir(), "release-publish-"));
  const viewPath = join(dir, "view.json");
  const runCli = (p: string): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [tsxEntry, script, p], { cwd: repoRoot, encoding: "utf8" });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  writeFileSync(viewPath, JSON.stringify({ isDraft: true, tagName: TAG, assets: complete.map((name) => ({ name })) }));
  const cliOk = runCli(viewPath);
  check(
    "P2-179: cli exits 0 on a complete draft and orders the publish edit",
    cliOk.code === 0 && cliOk.out.includes("release-publish: OK v0.3.0"),
    cliOk.out,
  );
  writeFileSync(viewPath, JSON.stringify({ isDraft: true, tagName: TAG, assets: [{ name: complete[0] }] }));
  const cliFail = runCli(viewPath);
  check(
    "P2-179: cli exits 1 printing ALL missing labels at once (release stays draft)",
    cliFail.code === 1 &&
      cliFail.out.includes("release-publish: FAIL v0.3.0") &&
      (cliFail.out.match(/  - missing: /g) ?? []).length === 10 &&
      cliFail.out.includes("10 problem(s) found"),
    cliFail.out,
  );
  writeFileSync(viewPath, JSON.stringify({ isDraft: false, tagName: TAG, assets: [] }));
  const cliPublished = runCli(viewPath);
  check(
    "P2-179: cli skips an already-published release with exit 0 (idempotent)",
    cliPublished.code === 0 && cliPublished.out.includes("release-publish: SKIP v0.3.0"),
    cliPublished.out,
  );
  rmSync(dir, { recursive: true, force: true });

  // --- real-repo assertion: release.yml creates a draft, publishes via the
  // release-publish job, and the Formula pin no longer runs in the release job
  const release = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  check(
    "P2-179: gh release create runs with --draft",
    /gh release create[^\n]*--draft/.test(release),
  );
  const relStart = release.indexOf("\n  release:");
  const relEnd = release.indexOf("\n  desktop-dmg:");
  const releaseJob = relStart > -1 && relEnd > relStart ? release.slice(relStart, relEnd) : "";
  check(
    "P2-179: the Formula pin no longer runs in the release job",
    releaseJob.length > 0 && !releaseJob.includes("Formula/opencode-remote.rb"),
  );
  const pubStart = release.indexOf("\n  release-publish:");
  const publishJob = pubStart === -1 ? "" : release.slice(pubStart);
  check(
    "P2-179: release.yml has a release-publish job needing release-verify AND release-feeds",
    publishJob.includes("needs: [release-verify, release-feeds]"),
  );
  check(
    "P2-179: release-publish declares shell: bash (P2-126 lesson)",
    publishJob.includes("shell: bash"),
  );
  check(
    "P2-179: release-publish feeds the gh release view draft+assets JSON into scripts/release-publish.ts",
    publishJob.includes("gh release view") &&
      publishJob.includes("--json isDraft,tagName,assets") &&
      publishJob.includes("scripts/release-publish.ts"),
  );
  const cliAt = publishJob.indexOf("scripts/release-publish.ts");
  // P2-216: the guide step also runs `gh release edit` (its --notes-file
  // write), so the publish edit is anchored on --draft=false — the assertion's
  // intent is that the draft only flips public after the CLI verdict.
  const editAt = publishJob.indexOf("--draft=false");
  const pinAt = publishJob.indexOf("Formula/opencode-remote.rb");
  check(
    "P2-179: the unpublish edit runs after the CLI verdict, and the Formula pin (sha256 from the downloaded tarball) after publication",
    editAt > cliAt &&
      pinAt > editAt &&
      publishJob.includes("gh release download") &&
      publishJob.includes("shasum -a 256"),
  );
}

// --- P2-183: authenticode-verify — the packaged Windows installer must match its signing profile before upload
{
  // Realistic output of the workflow's PowerShell step on a healthy
  // Authenticode-signed installer (Status Valid + the signer certificate
  // subject).
  const healthy = {
    mode: "authenticode",
    signtool:
      "Status: Valid\nSubject: CN=Example Inc, OU=Software, O=Example, L=Sao Paulo, S=SP, C=BR\nStatusMessage: The signature is valid.\n",
  };

  check(
    "P2-183: authenticode mode + Valid status + certificate subject → no problems",
    authenticodeProblems(healthy).length === 0,
    JSON.stringify(authenticodeProblems(healthy)),
  );

  // Every non-Valid status is a problem in authenticode mode, the four named
  // classes being NotSigned, HashMismatch, NotTrusted and UnknownError.
  const brokenStatuses: Array<[string, string]> = [
    ["NotSigned", "not signed at all"],
    ["HashMismatch", "hash"],
    ["NotTrusted", "not trusted"],
    ["UnknownError", "unknown"],
  ];
  for (const [status, hint] of brokenStatuses) {
    const problems = authenticodeProblems({
      ...healthy,
      signtool: `Status: ${status}\nSubject: CN=Example Inc\nStatusMessage: ${status}\n`,
    });
    check(
      `P2-183: ${status} status in authenticode mode → problem`,
      problems.some((p) => p.includes("authenticode") && p.includes(status) && p.includes(hint)),
      JSON.stringify(problems),
    );
  }

  // A Valid signature whose certificate carries no subject is still a problem
  const noSubject = authenticodeProblems({
    ...healthy,
    signtool: "Status: Valid\nSubject: \nStatusMessage: The signature is valid.\n",
  });
  check(
    "P2-183: Valid status but no certificate subject → problem",
    noSubject.some((p) => p.includes("authenticode") && p.includes("subject")),
    JSON.stringify(noSubject),
  );

  // Empty output is fail-closed: the verdict was never produced
  const empty = authenticodeProblems({ ...healthy, signtool: "" });
  check(
    "P2-183: empty PowerShell output → problem (fail-closed)",
    empty.some((p) => p.includes("authenticode") && p.includes("no output")),
    JSON.stringify(empty),
  );

  // Unrecognizable output is fail-closed too (PowerShell rewording must fail loudly)
  const gibberish = authenticodeProblems({ ...healthy, signtool: "computer says no\n" });
  check(
    "P2-183: unrecognizable output → problem",
    gibberish.some((p) => p.includes("authenticode") && p.includes("unrecognizable")),
    JSON.stringify(gibberish),
  );

  // A drifting signing profile must be caught, not guessed
  const drifted = authenticodeProblems({ ...healthy, mode: "self-signed" });
  check(
    "P2-183: unknown signing-profile mode → problem",
    drifted.some((p) => p.includes("mode")),
    JSON.stringify(drifted),
  );

  // The documented no-secrets path: mode=unsigned produces NO problem for ANY
  // of the outputs above — the SmartScreen warning is the expected flow there.
  const unsignedOutputs = [
    healthy.signtool,
    "Status: NotSigned\nSubject: \nStatusMessage: NotSigned\n",
    "Status: Valid\nSubject: \nStatusMessage: The signature is valid.\n",
    "",
    "computer says no\n",
  ];
  for (const signtool of unsignedOutputs) {
    const problems = authenticodeProblems({ mode: "unsigned", signtool });
    check(
      "P2-183: unsigned mode never produces a problem",
      problems.length === 0,
      JSON.stringify(problems),
    );
  }

  // --- CLI: output by file path, all problems at once, exit 1 -----------------
  const repoRoot = join(import.meta.dirname, "..");
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(repoRoot, "scripts", "authenticode-verify.ts");
  const tmp = mkdtempSync(join(tmpdir(), "authenticode-verify-"));
  const signtoolPath = join(tmp, "signtool.txt");
  const runCli = (args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [tsxEntry, script, ...args], { cwd: repoRoot, encoding: "utf8" });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  writeFileSync(signtoolPath, healthy.signtool);
  const cliOk = runCli(["authenticode", signtoolPath]);
  check(
    "P2-183: cli exits 0 on a healthy authenticode run",
    cliOk.code === 0 && cliOk.out.includes("authenticode-verify: OK"),
    cliOk.out,
  );
  writeFileSync(signtoolPath, "Status: NotSigned\nSubject: \nStatusMessage: NotSigned\n");
  const cliFail = runCli(["authenticode", signtoolPath]);
  check(
    "P2-183: cli exits 1 listing every problem at once",
    cliFail.code === 1 &&
      cliFail.out.includes("authenticode-verify: FAIL") &&
      (cliFail.out.match(/  - /g) ?? []).length === 1 &&
      cliFail.out.includes("1 problem(s) found"),
    cliFail.out,
  );

  // --- real-repo assertion: desktop-win gates the upload on Authenticode ------
  const release = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const winStart = release.indexOf("\n  desktop-win:");
  const winEnd = release.indexOf("\n  release-verify:");
  const win = winStart > -1 && winEnd > winStart ? release.slice(winStart, winEnd) : "";
  check("P2-183: release.yml still has the desktop-win job", win.length > 0);
  const smokeStep = win.indexOf("- name: Smoke-check the packaged bundle");
  const authenticodeStep = win.indexOf("- name: Authenticode verification of the packaged installer");
  const uploadStep = win.indexOf("- name: Attach setup exe + update metadata to the GitHub release");
  check(
    "P2-183: desktop-win runs the Authenticode verification between the bundle smoke and the release upload",
    smokeStep > -1 && authenticodeStep > smokeStep && uploadStep > authenticodeStep,
    `smoke=${smokeStep} authenticode=${authenticodeStep} upload=${uploadStep}`,
  );
  const authenticodeBlock = authenticodeStep > -1 && uploadStep > authenticodeStep ? win.slice(authenticodeStep, uploadStep) : "";
  check(
    "P2-183: Authenticode step declares shell: bash (P2-126 lesson)",
    /^\s*shell:\s*bash\s*$/m.test(authenticodeBlock),
    JSON.stringify(authenticodeBlock),
  );
  check(
    "P2-183: Authenticode step runs the PowerShell verification and feeds the CLI with the signing profile verdict",
    authenticodeBlock.includes("powershell -NoProfile") &&
      authenticodeBlock.includes("Get-AuthenticodeSignature") &&
      authenticodeBlock.includes("scripts/authenticode-verify.ts") &&
      authenticodeBlock.includes("steps.win-signing.outputs.mode"),
    JSON.stringify(authenticodeBlock),
  );
}

// --- P2-186: release-checksums — every download asset ships its sha256 ------
{
  const TAG = "v0.3.0";
  const repoRoot = join(import.meta.dirname, "..");
  const hA = "aa".repeat(32);
  const hB = "bb".repeat(32);
  const hC = "cc".repeat(32);
  const hD = "dd".repeat(32);
  const hE = "ee".repeat(32);
  const hF = "12".repeat(32);
  const hG = "34".repeat(32);
  // The fixture is PINNED to the artifact names the workflow actually uploads:
  // apps/desktop/electron-builder.yml renders the dmg/zip/exe templates, and a
  // regression back to spaced names must fail here (the checksum rule would
  // otherwise deadlock every future release as a draft at tag time).
  const ebYml = readFileSync(join(repoRoot, "apps", "desktop", "electron-builder.yml"), "utf8");
  const macBlock = ebYml.slice(ebYml.indexOf("\nmac:"), ebYml.indexOf("\ndmg:"));
  const nsisBlock = ebYml.slice(ebYml.indexOf("\nnsis:"), ebYml.indexOf("\nlinux:"));
  const renderArtifact = (tpl: string, ext: string, arch = "arm64") =>
    tpl.replaceAll("${version}", "0.3.0").replaceAll("${arch}", arch).replaceAll("${ext}", ext);
  const macTpl = /^\s*artifactName: (.+)$/m.exec(macBlock)?.[1]?.trim() ?? "";
  const nsisTpl = /^\s*artifactName: (.+)$/m.exec(nsisBlock)?.[1]?.trim() ?? "";
  const REAL_DMG = renderArtifact(macTpl, "dmg");
  const REAL_ZIP = renderArtifact(macTpl, "zip");
  // P2-191: the release carries BOTH architectures — the Intel artifacts are
  // the same template rendered with ${arch} = x64.
  const REAL_DMG_X64 = renderArtifact(macTpl, "dmg", "x64");
  const REAL_ZIP_X64 = renderArtifact(macTpl, "zip", "x64");
  const REAL_EXE = renderArtifact(nsisTpl, "exe"); // nsis template ends in a literal .exe
  check(
    "P2-186: electron-builder.yml pins space-free dmg/zip/exe artifact names (manifest step cannot deadlock at tag time)",
    macTpl.length > 0 &&
      nsisTpl.length > 0 &&
      !macTpl.includes(" ") &&
      !nsisTpl.includes(" ") &&
      REAL_DMG === "OpenCode-Remote-0.3.0-arm64.dmg" &&
      REAL_ZIP === "OpenCode-Remote-0.3.0-arm64.zip" &&
      REAL_EXE === "OpenCode-Remote-Setup-0.3.0.exe",
    `${JSON.stringify(macTpl)} | ${JSON.stringify(nsisTpl)}`,
  );
  // Complete, valid list — the REAL asset names, lowercase 64-hex digests, one
  // entry per download asset (tarball included; the P2-153 required slots all
  // match by extension+version(+arch) or exact name).
  const complete = [
    { name: "opencode-remote-v0.3.0.tar.gz", hash: hF },
    { name: REAL_DMG, hash: hB },
    { name: REAL_ZIP, hash: hA },
    { name: REAL_DMG_X64, hash: hE },
    { name: REAL_ZIP_X64, hash: hD },
    { name: REAL_EXE, hash: hC },
    { name: "latest-mac.yml", hash: hD },
    { name: "update-mac.json", hash: hG },
    { name: "update-mac-arm64.json", hash: hB },
    { name: "update-mac-x64.json", hash: hA },
    { name: "latest.yml", hash: hE },
  ];
  // Canonical order, written out by hand (not computed) so a sorting bug in
  // checksumLines shows: byte-wise name order, and every line ends with the
  // two-space separator.
  const canonical = [
    `${hB}  ${REAL_DMG}`,
    `${hA}  ${REAL_ZIP}`,
    `${hE}  ${REAL_DMG_X64}`,
    `${hD}  ${REAL_ZIP_X64}`,
    `${hC}  ${REAL_EXE}`,
    `${hD}  latest-mac.yml`,
    `${hE}  latest.yml`,
    `${hF}  opencode-remote-v0.3.0.tar.gz`,
    `${hB}  update-mac-arm64.json`,
    `${hA}  update-mac-x64.json`,
    `${hG}  update-mac.json`,
  ].join("\n");

  check(
    "P2-186: complete list of REAL asset names (pinned to electron-builder.yml) → canonical sorted coreutils manifest, no problems",
    checksumProblems(complete, TAG).length === 0 && checksumLines(complete) === `${canonical}\n`,
    JSON.stringify(checksumProblems(complete, TAG)),
  );

  const shuffled = complete.slice(5).concat(complete.slice(0, 5));
  check(
    "P2-186: different input order → byte-identical manifest",
    checksumLines(shuffled) === checksumLines(complete) && checksumLines(complete).endsWith("\n") && !checksumLines(complete).includes("\r"),
  );

  const upper = complete.map((e) => (e.name === "latest.yml" ? { ...e, hash: hE.toUpperCase() } : e));
  check(
    "P2-186: uppercase hash → problem",
    checksumProblems(upper, TAG).length === 1 && checksumProblems(upper, TAG)[0]!.includes("latest.yml"),
    JSON.stringify(checksumProblems(upper, TAG)),
  );

  const short = complete.map((e) => (e.name === "latest.yml" ? { ...e, hash: hE.slice(0, 63) } : e));
  const long = complete.map((e) => (e.name === "latest.yml" ? { ...e, hash: `${hE}0` } : e));
  check(
    "P2-186: short and long hash → problem",
    checksumProblems(short, TAG).length === 1 && checksumProblems(long, TAG).length === 1,
    `${JSON.stringify(checksumProblems(short, TAG))} | ${JSON.stringify(checksumProblems(long, TAG))}`,
  );

  const dup = [...complete, { name: "latest.yml", hash: hD }];
  check(
    "P2-186: repeated name → problem",
    checksumProblems(dup, TAG).length === 1 && checksumProblems(dup, TAG)[0]!.includes("repeated"),
    JSON.stringify(checksumProblems(dup, TAG)),
  );

  const spaced = complete.map((e) => (e.name === REAL_DMG ? { ...e, name: REAL_DMG.replace("OpenCode-Remote", "OpenCode Remote") } : e));
  check(
    "P2-186: name with space → problem",
    checksumProblems(spaced, TAG).length === 1 && checksumProblems(spaced, TAG)[0]!.includes("space"),
    JSON.stringify(checksumProblems(spaced, TAG)),
  );

  const separator = complete.map((e) => (e.name === "opencode-remote-v0.3.0.tar.gz" ? { ...e, name: `sub/dir/${e.name}` } : e));
  check(
    "P2-186: name with path separator → problem",
    checksumProblems(separator, TAG).length === 1 && checksumProblems(separator, TAG)[0]!.includes("path separator"),
    JSON.stringify(checksumProblems(separator, TAG)),
  );

  const self = [...complete, { name: MANIFEST_NAME, hash: hD }];
  check(
    "P2-186: name equal to the manifest itself → problem",
    checksumProblems(self, TAG).length === 1 && checksumProblems(self, TAG)[0]!.includes(MANIFEST_NAME),
    JSON.stringify(checksumProblems(self, TAG)),
  );

  const noExe = complete.filter((e) => e.name !== REAL_EXE);
  check(
    "P2-186: required download asset absent → problem (P2-153 contract by import)",
    checksumProblems(noExe, TAG).length === 1 && checksumProblems(noExe, TAG)[0]!.includes("Windows NSIS setup"),
    JSON.stringify(checksumProblems(noExe, TAG)),
  );

  const empty = checksumProblems([], TAG);
  check(
    "P2-186: empty list → problem (plus every required slot missing)",
    empty.length === 11 && empty[0]!.includes("empty"),
    JSON.stringify(empty),
  );

  const notList = checksumProblems("opencode-remote-v0.3.0.tar.gz", TAG);
  check(
    "P2-186: non-list input → problem",
    notList.length === 1 && notList[0]!.includes("not a list"),
    JSON.stringify(notList),
  );

  // --- CLI: tag + entries JSON path + manifest out path, fail-closed ---------
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(repoRoot, "scripts", "release-checksums.ts");
  const dir = mkdtempSync(join(tmpdir(), "release-checksums-"));
  const entriesPath = join(dir, "entries.json");
  const outPath = join(dir, MANIFEST_NAME);
  const runCli = (args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [tsxEntry, script, ...args], { cwd: repoRoot, encoding: "utf8" });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  writeFileSync(entriesPath, JSON.stringify(complete));
  const cliOk = runCli([TAG, entriesPath, outPath]);
  const written = readFileSync(outPath, "utf8");
  check(
    "P2-186: cli exits 0 and writes the canonical manifest to the requested path",
    cliOk.code === 0 && cliOk.out.includes(`release-checksums: OK ${TAG}`) && written === `${canonical}\n`,
    `${cliOk.out}${written}`,
  );
  writeFileSync(entriesPath, JSON.stringify(spaced));
  const cliFail = runCli([TAG, entriesPath, join(dir, "never.txt")]);
  check(
    "P2-186: cli exits 1 printing every problem at once and writes no manifest",
    cliFail.code === 1 &&
      cliFail.out.includes(`release-checksums: FAIL ${TAG}`) &&
      (cliFail.out.match(/  - /g) ?? []).length === 1 &&
      cliFail.out.includes("1 problem(s) found") &&
      !existsSync(join(dir, "never.txt")),
    cliFail.out,
  );
  const cliUsage = runCli([]);
  check(
    "P2-186: cli without tag/entries/out prints usage and exits 1",
    cliUsage.code === 1 && cliUsage.out.includes("usage: tsx scripts/release-checksums.ts"),
    cliUsage.out,
  );
  rmSync(dir, { recursive: true, force: true });

  // --- real-repo assertion: release.yml wires the manifest step into the job
  const release = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const jobAt = release.indexOf("\n  release-publish:");
  const publishJob = jobAt > -1 ? release.slice(jobAt) : "";
  check(
    "P2-186: release.yml still has the release-publish job needing release-verify AND release-feeds",
    publishJob.includes("needs: [release-verify, release-feeds]"),
  );
  const checksumAt = publishJob.indexOf("- name: Attach the SHA-256 checksum manifest to the release");
  const publishAt = publishJob.indexOf("- name: Publish the draft release only when every required asset is attached");
  check(
    "P2-186: the checksum step sits inside release-publish, before the step that flips the draft public",
    checksumAt > -1 && publishAt > checksumAt,
    `checksum=${checksumAt} publish=${publishAt}`,
  );
  const block = checksumAt > -1 && publishAt > checksumAt ? publishJob.slice(checksumAt, publishAt) : "";
  check(
    "P2-186: checksum step declares shell: bash (P2-126 lesson)",
    /^\s*shell:\s*bash\s*$/m.test(block),
    JSON.stringify(block),
  );
  check(
    "P2-186: checksum step downloads the assets, hashes with node, feeds the CLI and uploads the manifest",
    block.includes("gh release download") &&
      block.includes("node -e") &&
      block.includes("sha256") &&
      block.includes("scripts/release-checksums.ts") &&
      block.includes("gh release upload") &&
      block.includes(MANIFEST_NAME),
    JSON.stringify(block),
  );
}

// --- P2-187: phone relay address configurable in the shell (fail-closed) ------

{
  // relayUrlProblems: the acceptance table
  check(
    "P2-187: wss on a public host is accepted",
    relayUrlProblems("wss://relay.example.com:8788").length === 0,
  );
  check(
    "P2-187: ws on loopback hosts is accepted (localhost, 127.x, [::1])",
    ["ws://localhost:8787", "ws://127.0.0.1:8787", "ws://127.255.255.254:8787", "ws://[::1]:8787"].every(
      (v) => relayUrlProblems(v).length === 0,
    ),
  );
  check("P2-187: ws on a public host is a problem", relayUrlProblems("ws://relay.example.com:8788").length > 0);
  check(
    "P2-187: ws on a nip.io-style wildcard is a problem (no loopback prefix games)",
    relayUrlProblems("ws://127.0.0.1.evil.com:8787").length > 0,
  );
  check(
    "P2-187: http and file schemes are problems",
    relayUrlProblems("http://relay.example.com").length > 0 &&
      relayUrlProblems("file:///etc/passwd").length > 0,
  );
  check(
    "P2-187: non-string values are problems",
    [42, null, {}, [], true, undefined].every((v) => relayUrlProblems(v).length > 0),
  );
  check(
    "P2-187: empty and whitespace-only strings are problems",
    relayUrlProblems("").length > 0 && relayUrlProblems("   ").length > 0,
  );
  check(
    "P2-187: malformed URLs are problems",
    relayUrlProblems("ws://").length > 0 && relayUrlProblems("not a url").length > 0,
  );
  check(
    "P2-187: embedded user/password credentials are a problem",
    relayUrlProblems("wss://user:pass@relay.example.com:8788").length > 0,
  );
  check(
    "P2-187: above the documented length ceiling is a problem",
    relayUrlProblems(`wss://relay.example.com/${"a".repeat(RELAY_URL_MAX_LEN)}`).length > 0,
  );
  check(
    "P2-187: at the documented length ceiling is accepted",
    relayUrlProblems(`wss://relay.example.com/${"a".repeat(RELAY_URL_MAX_LEN - "wss://relay.example.com/".length)}`)
      .length === 0,
  );
  check(
    "P2-187: uppercase scheme is the same scheme",
    relayUrlProblems("WSS://Relay.Example.com").length === 0,
  );
  check("P2-187: uppercase ws on a public host is still a problem", relayUrlProblems("WS://8.8.8.8").length > 0);
  check(
    "P2-187: problems never echo the raw value (credentials stay out of logs)",
    relayUrlProblems("wss://user:secret@relay.example.com").every((p) => !p.includes("secret") && !p.includes("user:")),
  );

  // loopback parity with the boot authority (apps/daemon/src/relayurl.ts)
  const parityHosts = [
    "localhost",
    "::1",
    "[::1]",
    "127.0.0.1",
    "127.255.255.254",
    "127.0.0.0",
    "127.0.0.1.evil.com",
    "127.attacker.com",
    "8.8.8.8",
    "relay.example.com",
    "localhost.evil.com",
    "::2",
    "[::2]",
    "127.1",
    "",
  ];
  check(
    "P2-187: loopback rule parity with relayurl.ts on the shared host table",
    parityHosts.every((h) => isLoopbackHostBoot(h) === isLoopbackHostSetting(h)),
  );

  // resolveRelayUrl matrix
  const envWins = resolveRelayUrl({ RELAY_URL: "wss://env.example.com:8788" }, "wss://stored.example.com:8788");
  check(
    "P2-187: env wins over a valid stored value",
    envWins.origin === "env" && envWins.url === "wss://env.example.com:8788",
  );
  check(
    "P2-187: env wins even when invalid (operator path, problems surfaced)",
    (() => {
      const r = resolveRelayUrl({ RELAY_URL: "http://env.example.com" }, null);
      return r.origin === "env" && r.url === "http://env.example.com" && r.problems.length > 0;
    })(),
  );
  const storedWins = resolveRelayUrl({}, "  wss://stored.example.com:8788  ");
  check(
    "P2-187: valid stored value wins over the default (and is trimmed)",
    storedWins.origin === "stored" && storedWins.url === "wss://stored.example.com:8788" && storedWins.problems.length === 0,
  );
  const plainDefault = resolveRelayUrl({}, null);
  check(
    "P2-187: nothing set → the historical loopback default, byte for byte",
    plainDefault.url === DEFAULT_RELAY_URL &&
      plainDefault.url === "ws://127.0.0.1:8787" &&
      plainDefault.origin === "default" &&
      plainDefault.problems.length === 0,
  );
  check(
    "P2-187: missing env key behaves like no env",
    resolveRelayUrl({}, undefined).origin === "default" && resolveRelayUrl({}, undefined).url === DEFAULT_RELAY_URL,
  );
  check(
    "P2-187: blank env value falls through to the stored/default resolution",
    resolveRelayUrl({ RELAY_URL: "" }, null).origin === "default",
  );
  check(
    "P2-187: invalid stored value → stored-invalid with problems, never the default",
    (() => {
      const r = resolveRelayUrl({}, "http://nope.example.com");
      return r.origin === "stored-invalid" && r.problems.length > 0 && r.url !== DEFAULT_RELAY_URL;
    })(),
  );
  check(
    "P2-187: invalid stored STRING keeps the raw value so the daemon preflight fails closed",
    resolveRelayUrl({}, "not a url").url === "not a url",
  );
  check(
    "P2-187: non-string stored value → stored-invalid with an empty url (never the default)",
    (() => {
      const r = resolveRelayUrl({}, 42);
      return r.origin === "stored-invalid" && r.url === "" && r.problems.length > 0;
    })(),
  );
  check(
    "P2-187: invalid stored value loses to a present env value (env still wins)",
    resolveRelayUrl({ RELAY_URL: "wss://env.example.com" }, "http://nope").origin === "env",
  );

  // relaystore round-trip against the real filesystem (0600 tmp+rename)
  const relayDir = mkdtempSync(join(tmpdir(), "p2-187-relay-"));
  try {
    const relayFile = relaySettingFile(relayDir);
    check(
      "P2-187: relay.json path sits beside window-state.json",
      relayFile === join(relayDir, "relay.json"),
    );
    check("P2-187: missing relay.json reads as not configured", readStoredRelayUrl(relayFile) === null);
    check(
      "P2-187: write + read round-trip",
      writeStoredRelayUrl(relayFile, "wss://relay.example.com:8788") &&
        readStoredRelayUrl(relayFile) === "wss://relay.example.com:8788",
    );
    check("P2-187: persisted file has mode 0600", (statSync(relayFile).mode & 0o777) === 0o600);
    check("P2-187: no .tmp leftover after a successful write", !existsSync(`${relayFile}.tmp`));
    check(
      "P2-187: null clears the setting ({} on disk)",
      writeStoredRelayUrl(relayFile, null) && readStoredRelayUrl(relayFile) === null,
    );
    writeFileSync(join(relayDir, "corrupt.json"), "{corrupted", { mode: 0o600 });
    check(
      "P2-187: corrupted JSON reads as not configured",
      readStoredRelayUrl(join(relayDir, "corrupt.json")) === null,
    );
    writeFileSync(join(relayDir, "wrongfield.json"), JSON.stringify({ url: 42 }), { mode: 0o600 });
    check(
      "P2-187: non-string url field reads as not configured",
      readStoredRelayUrl(join(relayDir, "wrongfield.json")) === null,
    );
  } finally {
    rmSync(relayDir, { recursive: true, force: true });
  }

  // real-source assertion: every sidecar spawn carries the resolved RELAY_URL
  const daemonSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "daemon.ts"), "utf8");
  const spawnSites = daemonSrc.split("spawn(entry.node").length - 1;
  check("P2-187: daemon.ts still has exactly one sidecar spawn site", spawnSites === 1, String(spawnSites));
  const spawnBody = daemonSrc.slice(daemonSrc.indexOf("spawn(entry.node"));
  check(
    "P2-187: the spawn env carries the resolved RELAY_URL",
    /RELAY_URL:\s*relayUrlForSpawn/.test(spawnBody),
  );
  check(
    "P2-187: spawn paths funnel through setSidecarRelayUrl (exported for main.ts)",
    daemonSrc.includes("export function setSidecarRelayUrl") && daemonSrc.includes("relayUrlForSpawn = url"),
  );
}

// --- P2-189: step one of the pairing journey — the address the phone opens ---

{
  // deriveWebAppUrl: the wss→https / ws→http mapping
  check(
    "P2-189: wss relay becomes https app address",
    deriveWebAppUrl("wss://relay.example.com:8788") === "https://relay.example.com:8788",
  );
  check(
    "P2-189: port is preserved through the mapping",
    deriveWebAppUrl("wss://relay.example.com:8788") === "https://relay.example.com:8788" &&
      deriveWebAppUrl("ws://10.0.0.7:9999") === "http://10.0.0.7:9999",
  );
  check(
    "P2-189: path and query are discarded",
    deriveWebAppUrl("wss://relay.example.com:8788/ws?token=secret") === "https://relay.example.com:8788" &&
      deriveWebAppUrl("wss://relay.example.com/some/deep/path") === "https://relay.example.com",
  );
  check(
    "P2-189: unparseable or non-ws relay addresses derive nothing",
    deriveWebAppUrl("not a url") === "" && deriveWebAppUrl("https://relay.example.com") === "",
  );

  // webAppUrlProblems: the acceptance table
  check(
    "P2-189: https on a public host is accepted",
    webAppUrlProblems("https://relay.example.com:8788").length === 0,
  );
  check(
    "P2-189: http on a loopback host is accepted",
    ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"].every(
      (v) => webAppUrlProblems(v).length === 0,
    ),
  );
  check(
    "P2-189: http on a public host is a problem (plain http over the network)",
    webAppUrlProblems("http://relay.example.com:8788").length > 0,
  );
  check(
    "P2-189: ws/wss and file schemes are problems (only http/https)",
    webAppUrlProblems("wss://relay.example.com:8788").length > 0 &&
      webAppUrlProblems("ws://relay.example.com:8788").length > 0 &&
      webAppUrlProblems("file:///etc/passwd").length > 0,
  );
  check(
    "P2-189: non-string values are problems",
    [42, null, {}, [], true, undefined].every((v) => webAppUrlProblems(v).length > 0),
  );
  check("P2-189: empty strings are problems", webAppUrlProblems("").length > 0 && webAppUrlProblems("  ").length > 0);
  check(
    "P2-189: malformed URLs are problems",
    webAppUrlProblems("https://").length > 0 && webAppUrlProblems("not a url").length > 0,
  );
  check(
    "P2-189: embedded user/password credentials are a problem",
    webAppUrlProblems("https://user:pass@relay.example.com:8788").length > 0,
  );
  check(
    "P2-189: above the documented length ceiling is a problem",
    webAppUrlProblems(`https://relay.example.com/${"a".repeat(WEB_APP_URL_MAX_LEN)}`).length > 0,
  );
  check(
    "P2-189: uppercase scheme is the same scheme (P2-178 lesson)",
    webAppUrlProblems("HTTPS://Relay.Example.com:8788").length === 0 &&
      webAppUrlProblems("HTTP://8.8.8.8").length > 0 &&
      webAppUrlProblems("HttpS://relay.example.com:8788").length === 0,
  );
  check(
    "P2-189: problems never echo the raw value (credentials stay out of logs)",
    webAppUrlProblems("https://user:secret@relay.example.com").every((p) => !p.includes("secret") && !p.includes("user:")),
  );

  // resolveWebAppUrl: stored beats derived; invalid stored never falls through
  const relayOk = { url: "wss://relay.example.com:8788", origin: "stored", problems: [] as string[] };
  const derived = resolveWebAppUrl(relayOk, null);
  check(
    "P2-189: no stored value → derived from the relay",
    derived.url === "https://relay.example.com:8788" && derived.origin === "derived" && derived.problems.length === 0,
  );
  const storedWins = resolveWebAppUrl(relayOk, "  https://app.example.com/app  ");
  check(
    "P2-189: stored value wins over the derived one (and is trimmed)",
    storedWins.url === "https://app.example.com/app" && storedWins.origin === "stored" && storedWins.problems.length === 0,
  );
  const storedInvalid = resolveWebAppUrl(relayOk, "wss://relay.example.com");
  check(
    "P2-189: invalid stored value returns problems and NEVER the derived url",
    storedInvalid.origin === "unavailable" &&
      storedInvalid.url === "" &&
      storedInvalid.problems.length > 0 &&
      storedInvalid.url !== derived.url,
  );
  const storedNonString = resolveWebAppUrl(relayOk, 42);
  check(
    "P2-189: non-string stored value → unavailable, never the derived url",
    storedNonString.origin === "unavailable" && storedNonString.url === "" && storedNonString.problems.length > 0,
  );
  const loopbackRelay = resolveWebAppUrl({ url: "ws://127.0.0.1:8787", origin: "default", problems: [] }, null);
  check(
    "P2-189: loopback relay → unavailable with an explicit reason (the phone can never reach it)",
    loopbackRelay.origin === "unavailable" &&
      loopbackRelay.url === "" &&
      loopbackRelay.problems.length > 0 &&
      loopbackRelay.problems[0].length > 20,
  );
  const localhostRelay = resolveWebAppUrl({ url: "ws://localhost:8787", origin: "default", problems: [] }, null);
  check(
    "P2-189: localhost relay is loopback too",
    localhostRelay.origin === "unavailable" && localhostRelay.url === "",
  );
  const publicWsRelay = resolveWebAppUrl({ url: "ws://relay.example.com:8788", origin: "stored", problems: [] }, null);
  check(
    "P2-189: ws on a public host → http app address WITH a problem (QR withheld by the caller)",
    publicWsRelay.url === "http://relay.example.com:8788" &&
      publicWsRelay.origin === "derived" &&
      publicWsRelay.problems.length > 0,
  );
  const brokenRelay = resolveWebAppUrl({ url: "not a url", origin: "stored-invalid", problems: ["x"] }, null);
  check(
    "P2-189: unusable relay address → unavailable with a reason, never a garbage url",
    brokenRelay.origin === "unavailable" && brokenRelay.url === "" && brokenRelay.problems.length > 0,
  );
  const emptyRelay = resolveWebAppUrl({ url: "", origin: "stored-invalid", problems: ["x"] }, null);
  check("P2-189: empty relay address → unavailable", emptyRelay.origin === "unavailable" && emptyRelay.url === "");

  // relaystore round-trip for the webAppUrl field (same 0600 tmp+rename file)
  const webAppDir = mkdtempSync(join(tmpdir(), "p2-189-webapp-"));
  try {
    const waFile = relaySettingFile(webAppDir);
    check("P2-189: missing relay.json reads the app address as not configured", readStoredWebAppUrl(waFile) === null);
    check(
      "P2-189: app address write + read round-trip",
      writeStoredWebAppUrl(waFile, "https://app.example.com") && readStoredWebAppUrl(waFile) === "https://app.example.com",
    );
    check("P2-189: persisted app address keeps the file mode 0600", (statSync(waFile).mode & 0o777) === 0o600);
    check(
      "P2-189: saving the relay address preserves the app address (independent fields)",
      writeStoredRelayUrl(waFile, "wss://relay.example.com:8788") &&
        readStoredWebAppUrl(waFile) === "https://app.example.com" &&
        readStoredRelayUrl(waFile) === "wss://relay.example.com:8788",
    );
    check(
      "P2-189: clearing the app address preserves the relay address",
      writeStoredWebAppUrl(waFile, null) &&
        readStoredWebAppUrl(waFile) === null &&
        readStoredRelayUrl(waFile) === "wss://relay.example.com:8788",
    );
    writeFileSync(join(webAppDir, "corrupt.json"), "{corrupted", { mode: 0o600 });
    check(
      "P2-189: corrupted JSON reads the app address as not configured",
      readStoredWebAppUrl(join(webAppDir, "corrupt.json")) === null,
    );
  } finally {
    rmSync(webAppDir, { recursive: true, force: true });
  }

  // real-source assertion: the shell wires step one end to end.
  // P2-197: webApp is no longer the LAST field — the additive `reach` rides
  // after it — so the regex now only pins `webApp,` inside the payload.
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  check(
    "P2-189: webApp travels in the ocr:pairing-state payload",
    /setPairingState\(\{[\s\S]*?webApp,[\s\S]*?\}\);/.test(mainSrc),
  );
  check(
    "P2-189: the web-app QR is minted by QRCode.toDataURL ONLY when the resolution is problem-free",
    /webAppRes\.url !== "" && webAppRes\.problems\.length === 0\s*\?\s*await QRCode\.toDataURL\(webAppRes\.url/.test(mainSrc),
  );
  check(
    "P2-189: a problem-bearing resolution carries the reason and qrDataUrl null",
    /reason: webAppRes\.problems\[0\] \?\? ""/.test(mainSrc) && /:\s*null,?\s*\n\s*\};/.test(mainSrc),
  );
  check(
    "P2-189: read/write IPC handlers registered beside the relay setting's",
    mainSrc.includes('ipcMain.handle("app:webAppUrl"') && mainSrc.includes('ipcMain.handle("app:setWebAppUrl"'),
  );
  check(
    "P2-189: writes are always validated in the main process (webAppUrlProblems)",
    mainSrc.includes("webAppUrlProblems(payload)"),
  );
  check(
    "P2-189: loopback rule parity with relaysetting.ts on the shared host table",
    [
      "localhost",
      "::1",
      "[::1]",
      "127.0.0.1",
      "127.255.255.254",
      "127.0.0.0",
      "127.0.0.1.evil.com",
      "8.8.8.8",
      "relay.example.com",
      "::2",
      "127.1",
      "",
    ].every((h) => isLoopbackHostSetting(h) === isLoopbackHostWebApp(h)),
  );
}

// --- P2-190: time-boxed bootstrap pairing window (pairwindow.ts) --------------

{
  const base = 1_700_000_000_000; // arbitrary fixed "now" anchor (pure: no clock reads)

  // bootstrapDecision matrix
  check(
    "P2-190: empty allowlist inside the window → allow",
    bootstrapDecision(0, base, base + 60_000) === "allow" &&
      bootstrapDecision(0, base, base + DEFAULT_PAIR_WINDOW_MS - 1) === "allow",
  );
  check(
    "P2-190: empty allowlist exactly at the ceiling → reject-expired (strict comparison)",
    bootstrapDecision(0, base, base + DEFAULT_PAIR_WINDOW_MS) === "reject-expired",
  );
  check(
    "P2-190: empty allowlist one ms past the ceiling → reject-expired",
    bootstrapDecision(0, base, base + DEFAULT_PAIR_WINDOW_MS + 1) === "reject-expired",
  );
  check(
    "P2-190: non-empty allowlist → reject-not-allowlisted inside AND outside the window",
    bootstrapDecision(1, base, base + 1) === "reject-not-allowlisted" &&
      bootstrapDecision(3, base, base + PAIR_WINDOW_CEILING_MS * 10) === "reject-not-allowlisted",
  );
  check(
    "P2-190: re-arm reopens the window (expired before, allow after a fresh openedAt)",
    bootstrapDecision(0, base, base + DEFAULT_PAIR_WINDOW_MS + 5_000) === "reject-expired" &&
      bootstrapDecision(0, base + DEFAULT_PAIR_WINDOW_MS + 5_000, base + DEFAULT_PAIR_WINDOW_MS + 6_000) ===
        "allow",
  );
  check(
    "P2-190: future open instant never widens the window (clock ahead → reject-expired)",
    bootstrapDecision(0, base + 60_000, base) === "reject-expired",
  );
  check(
    "P2-190: openedAt = 0 (window never opened) is fail-closed",
    bootstrapDecision(0, 0, base) === "reject-expired",
  );
  check(
    "P2-190: custom windowMs is honored (1s window)",
    bootstrapDecision(0, base, base + 999, 1_000) === "allow" &&
      bootstrapDecision(0, base, base + 1_000, 1_000) === "reject-expired",
  );

  // pairWindow env matrix — missing/blank are the ONLY no-problem cases
  check(
    "P2-190: missing OCR_PAIR_WINDOW_MS keeps the default with no problem",
    pairWindow({}).windowMs === DEFAULT_PAIR_WINDOW_MS && pairWindow({}).problems.length === 0,
  );
  check(
    "P2-190: blank OCR_PAIR_WINDOW_MS keeps the default with no problem",
    pairWindow({ OCR_PAIR_WINDOW_MS: "   " }).windowMs === DEFAULT_PAIR_WINDOW_MS &&
      pairWindow({ OCR_PAIR_WINDOW_MS: "   " }).problems.length === 0,
  );
  const invalidWindowValues: Array<[string, string]> = [
    ["non-numeric", "abc"],
    ["negative", "-1"],
    ["zero", "0"],
    ["fractional", "1.5"],
    ["above-ceiling", String(PAIR_WINDOW_CEILING_MS + 1)],
  ];
  for (const [why, raw] of invalidWindowValues) {
    const resolved = pairWindow({ OCR_PAIR_WINDOW_MS: raw });
    check(
      `P2-190: ${why} OCR_PAIR_WINDOW_MS (${raw}) is exactly one fail-closed problem`,
      resolved.problems.length === 1 && resolved.problems[0].includes("fail-closed"),
    );
  }
  check(
    "P2-190: a valid value inside the ceiling resolves without problems",
    pairWindow({ OCR_PAIR_WINDOW_MS: String(5 * 60_000) }).windowMs === 5 * 60_000 &&
      pairWindow({ OCR_PAIR_WINDOW_MS: String(5 * 60_000) }).problems.length === 0,
  );

  // real-source assertion: the empty-allowlist bootstrap branch in the REAL
  // index.ts must decide through bootstrapDecision — a hand-rolled
  // `allowlist.length === 0` bypass cannot sneak back in.
  const daemonIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const bootstrapAt = daemonIndexSrc.indexOf("const allowlist = readAllowlist();");
  check(
    "P2-190: the real bootstrap branch decides through bootstrapDecision(",
    bootstrapAt > -1 && daemonIndexSrc.slice(bootstrapAt, bootstrapAt + 800).includes("bootstrapDecision("),
  );
}

// --- P2-193: combined pair link (pairlink.ts) --------------------------------

{
  const okApp = { url: "https://relay.example.com", origin: "stored", problems: [] as string[] };
  const okUri = "opencode-remote://pair?v=2&relay=wss%3A%2F%2Frelay.example.com%3A8788&room=ab%2Bc%3D&k=de%2FAd%2B%3D%3D";
  const link = buildPairLink(okApp, okUri);
  const okQuery = okUri.slice(okUri.indexOf("?") + 1);

  check(
    "P2-193: the whole query moves into the #/pair fragment byte a byte",
    link.problems.length === 0 &&
      link.url === `https://relay.example.com${PAIR_LINK_HASH_ROUTE}${okQuery}` &&
      link.url.split("#")[1] === `/pair?${okQuery}`,
  );
  check(
    "P2-193: percent-encoding and + survive untouched (no URLSearchParams re-encoding)",
    buildPairLink(okApp, "opencode-remote://pair?v=2&k=de%2FAd%2B%3D%3D&r=a%20b").url.endsWith(
      "#/pair?v=2&k=de%2FAd%2B%3D%3D&r=a%20b",
    ),
  );
  check(
    "P2-193: origin unavailable → problem and fail-closed empty url",
    buildPairLink({ url: "", origin: "unavailable", problems: ["loopback relay"] }, okUri).problems.join(" ").includes("unavailable") &&
      buildPairLink({ url: "", origin: "unavailable", problems: [] }, okUri).problems.length > 0 &&
      buildPairLink({ url: "", origin: "unavailable", problems: [] }, okUri).url === "",
  );
  check(
    "P2-193: origin stored-invalid → problem and fail-closed empty url",
    buildPairLink({ url: "", origin: "stored-invalid", problems: ["bad stored value"] }, okUri).problems.length > 0 &&
      buildPairLink({ url: "", origin: "stored-invalid", problems: [] }, okUri).url === "" &&
      buildPairLink({ url: "", origin: "stored-invalid", problems: [] }, okUri).problems.length > 0,
  );
  check(
    "P2-193: app problems propagate (fail-closed even with a usable origin)",
    buildPairLink({ url: "https://relay.example.com", origin: "stored", problems: ["insecure"] }, okUri).problems.includes("insecure") &&
      buildPairLink({ url: "https://relay.example.com", origin: "stored", problems: ["insecure"] }, okUri).url === "",
  );
  check(
    "P2-193: OPENCODE-REMOTE://PAIR (uppercase scheme/host) is the same scheme — no problem",
    buildPairLink(okApp, "OPENCODE-REMOTE://PAIR?v=2&room=x&k=y").problems.length === 0,
  );
  check(
    "P2-193: URI without protocol version 2 → problem (missing and v=1)",
    buildPairLink(okApp, "opencode-remote://pair?room=x&k=y").problems.some((p) => p.includes("version 2")) &&
      buildPairLink(okApp, "opencode-remote://pair?v=1&room=x&k=y").url === "",
  );
  check(
    "P2-193: URI with its own fragment → problem (the query is never re-mounted over a fragment)",
    buildPairLink(okApp, "opencode-remote://pair?v=2&room=x#z").problems.some((p) => p.includes("fragment")) &&
      buildPairLink(okApp, "opencode-remote://pair?v=2&room=x#z").url === "",
  );
  check(
    "P2-193: URI that is not opencode-remote://pair → problem",
    buildPairLink(okApp, "opencode-remote://admin?v=2").problems.length > 0 &&
      buildPairLink(okApp, "https://evil.example.com/pair?v=2").url === "",
  );
  {
    const longQuery = `v=2&pad=${"x".repeat(5000)}`;
    const res = buildPairLink(okApp, `opencode-remote://pair?${longQuery}`);
    check(
      "P2-193: query above the documented 4KB ceiling → problem",
      res.problems.some((p) => p.includes("4096")) && res.url === "",
    );
    const padLen = PAIR_LINK_MAX_LEN - okApp.url.length - PAIR_LINK_HASH_ROUTE.length + 1;
    const overLink = buildPairLink(okApp, `opencode-remote://pair?v=2&pad=${"x".repeat(padLen)}`);
    check(
      "P2-193: final link above PAIR_LINK_MAX_LEN → problem (query still under 4KB)",
      overLink.problems.some((p) => p.includes(String(PAIR_LINK_MAX_LEN))) && overLink.url === "",
    );
  }
  check(
    "P2-193: non-string URI (null) → problem, empty url",
    buildPairLink(okApp, null).problems.length > 0 && buildPairLink(okApp, null).url === "",
  );

  // Real-source assertions: the combined QR may only exist when the link is
  // problem-free, and the hash route must consume itself via replaceState.
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const pairLinkAt = mainSrc.indexOf("const pairLink = {");
  check(
    "P2-193: the real main.ts mints the combined QR only with zero problems",
    pairLinkAt > -1 &&
      /pairLinkRes\.problems\.length === 0 && pairLinkRes\.url !== ""\s*\?\s*await QRCode\.toDataURL\(pairLinkRes\.url/.test(
        mainSrc.slice(pairLinkAt, pairLinkAt + 400),
      ),
  );
  const appSrc = readFileSync(join(import.meta.dirname, "..", "apps", "web", "src", "App.tsx"), "utf8");
  const pairRouteAt = appSrc.indexOf('h.startsWith("#/pair")');
  check(
    "P2-193: the real App.tsx #/pair branch consumes the fragment with history.replaceState(",
    pairRouteAt > -1 && appSrc.slice(pairRouteAt, pairRouteAt + 900).includes("history.replaceState("),
  );
  check(
    "P2-193: pairLinkTitle/pairLinkHint exist in en and pt",
    ["pairLinkTitle", "pairLinkHint"].every(
      (k) =>
        typeof (dict.en as Record<string, string>)[k] === "string" &&
        typeof (dict.pt as Record<string, string>)[k] === "string",
    ),
  );
}

// --- Product eval 2026-09-05: deploy budget / direction / nightly / model / first foreign repo ---
{
  const evalCfg = (repo: string): PilotConfig => ({
    repo,
    workspace: repo,
    slots: 1,
    maxTasksPerDay: 1,
    maxDeploysPerDay: 1,
    maxReviewRounds: 1,
    maxAttemptsPerTask: 1,
    taskTimeoutMin: 1,
    reviewTimeoutMin: 1,
    monitorMin: 1,
    digest: false,
    corpusEveryNMerges: 0,
    stateRoot: repo,
  });

  // (2) direction guard — pure verdict
  check("direction guard: descendant → null (proceed)", directionGuardDetail("a".repeat(40), "b".repeat(40), true) === null);
  const dgAhead = directionGuardDetail("a".repeat(40), "b".repeat(40), false) ?? "";
  check(
    "direction guard: prod ahead/diverged → skip text names both shas, rollback stays explicit",
    dgAhead.includes("not a descendant") && dgAhead.includes("aaaaaaa") && dgAhead.includes("bbbbbbb") && dgAhead.includes("quarantine/rollback"),
  );
  check("direction guard: failed probe fails closed (ancestry unknown)", (directionGuardDetail("a", "b", null) ?? "").includes("ancestry unknown"));

  // (1)+(2) real git: budget counts real attempts only, deploy never resets prod backward
  const ddir = mkdtempSync(join(tmpdir(), "ocr-deploy-direction-"));
  try {
    execSync("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: ddir });
    writeFileSync(join(ddir, "f.txt"), "one\n");
    execSync("git add f.txt && git commit -q -m c1", { cwd: ddir });
    const c1 = execSync("git rev-parse HEAD", { cwd: ddir, encoding: "utf8" }).trim();
    writeFileSync(join(ddir, "f.txt"), "two\n");
    execSync("git commit -qam c2", { cwd: ddir });
    const c2 = execSync("git rev-parse HEAD", { cwd: ddir, encoding: "utf8" }).trim();
    execSync(`git checkout -q -b side ${c1}`, { cwd: ddir });
    writeFileSync(join(ddir, "g.txt"), "side\n");
    execSync("git add g.txt && git commit -q -m c3", { cwd: ddir });
    const c3 = execSync("git rev-parse HEAD", { cwd: ddir, encoding: "utf8" }).trim();
    const verified = [c1, c2, c3].map((sha) => ({ sha, task: "T", at: "t" }));
    const cfgD = evalCfg(ddir);
    const events: Array<{ phase?: string; ok?: boolean }> = [];
    let notifies = 0;
    let attempts = 0;
    const opts = {
      verifiedMerges: verified,
      quarantine: [],
      probeFreeBytes: async () => 100 * GB,
      notify: async () => {
        notifies++;
        return true;
      },
      emitEvent: (_t: string, fields: { phase?: string; ok?: boolean }) => {
        events.push(fields);
      },
      onAttempt: () => {
        attempts++;
      },
    };
    // prod at c1, target c2 (descendant): every guard passes
    execSync(`git checkout -q ${c1}`, { cwd: ddir });
    check("deployPreflight: clean checkout + descendant target → null (a real attempt may start)", (await deployPreflight(cfgD, c2, { task: "E1" }, opts)) === null);
    // prod at c2, target c1 (prod ahead): refused, nothing touched
    execSync(`git checkout -q ${c2}`, { cwd: ddir });
    const back = await deploy(cfgD, c1, { task: "E1" }, opts);
    check(
      "deploy: prod ahead of the target → refused by the direction guard, not rolled back",
      back.ok === false && back.rolledBack === false && back.refused === "direction-guard" && back.detail.includes("not a descendant"),
    );
    check("deploy: direction refusal spent no attempt (onAttempt never fired)", attempts === 0);
    check("deploy: direction refusal emits direction-guard ok:false and no supervisor notify", events.at(-1)?.phase === "direction-guard" && events.at(-1)?.ok === false && notifies === 0);
    check("deploy: prod HEAD untouched after the direction refusal", execSync("git rev-parse HEAD", { cwd: ddir, encoding: "utf8" }).trim() === c2);
    // prod on a diverged branch (c3), target c2: not a descendant either
    execSync(`git checkout -q ${c3}`, { cwd: ddir });
    const div = await deploy(cfgD, c2, { task: "E1" }, opts);
    check("deploy: diverged prod → direction refusal, no attempt", div.refused === "direction-guard" && attempts === 0);
    // failed ancestry probe: fail-closed
    execSync(`git checkout -q ${c1}`, { cwd: ddir });
    const unknown = await deploy(cfgD, c2, { task: "E1" }, { ...opts, probeAncestor: () => null });
    check("deploy: ancestry probe failure → refused (fail-closed), no attempt", unknown.refused === "direction-guard" && unknown.detail.includes("ancestry unknown") && attempts === 0);
    // dirty tree: refused before the direction probe, no attempt
    writeFileSync(join(ddir, "f.txt"), "operator edit\n");
    const dirtyRef = await deploy(cfgD, c2, { task: "E1" }, opts);
    check("deploy: dirty-guard refusal carries refused:\"dirty-guard\" and spends no attempt", dirtyRef.refused === "dirty-guard" && attempts === 0);
    execSync("git checkout -q -- f.txt", { cwd: ddir });
    // sha guard: refused:"sha-guard"
    const shaRef = await deploy(cfgD, "9".repeat(40), { task: "E1" }, opts);
    check("deploy: unverified sha → refused:\"sha-guard\", no attempt", shaRef.refused === "sha-guard" && attempts === 0);
  } finally {
    rmSync(ddir, { recursive: true, force: true });
  }
  // the index.ts wiring: the daily counter lives ONLY inside the onAttempt hook
  const pilotIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "index.ts"), "utf8");
  check(
    "index.ts: state.deploys++ appears exactly once, inside countDeployAttempt (the onAttempt hook)",
    (pilotIndexSrc.match(/state\.deploys\+\+/g) ?? []).length === 1 &&
      /function countDeployAttempt\(\): void \{\s*state\.deploys\+\+;/.test(pilotIndexSrc) &&
      (pilotIndexSrc.match(/onAttempt: countDeployAttempt/g) ?? []).length === 2,
  );

  // (1) refusal backoff — pure
  const t0 = 1_000_000;
  check("deploy backoff: constants pinned (5 refusals, 30 min)", DEPLOY_REFUSAL_BACKOFF_AFTER === 5 && DEPLOY_REFUSAL_BACKOFF_MS === 30 * 60_000);
  let bo = noteDeployRefusal(null, "dirty-guard", t0);
  check("deploy backoff: first refusal counts, does not arm", bo?.count === 1 && bo?.until === 0 && deployBackoffRemaining(bo, t0) === 0);
  for (let i = 2; i <= 4; i++) bo = noteDeployRefusal(bo, "dirty-guard", t0 + i);
  check("deploy backoff: 4 same-kind refusals still free", bo?.count === 4 && deployBackoffRemaining(bo, t0 + 4) === 0);
  bo = noteDeployRefusal(bo, "dirty-guard", t0 + 5);
  check(
    "deploy backoff: 5th consecutive same-kind refusal arms a 30 min hold",
    bo?.count === 5 && bo?.until === t0 + 5 + DEPLOY_REFUSAL_BACKOFF_MS && deployBackoffRemaining(bo, t0 + 5) === DEPLOY_REFUSAL_BACKOFF_MS,
  );
  check("deploy backoff: hold expires after 30 min", deployBackoffRemaining(bo, t0 + 5 + DEPLOY_REFUSAL_BACKOFF_MS) === 0 && deployBackoffRemaining(bo, t0 + 5 + DEPLOY_REFUSAL_BACKOFF_MS - 1) === 1);
  check("deploy backoff: a different refusal kind restarts the streak", noteDeployRefusal(bo, "disk-guard", t0 + 6)?.count === 1);
  check("deploy backoff: sha-guard refusals never arm (fail-closed no-op, not a stuck environment)", noteDeployRefusal(bo, "sha-guard", t0 + 6) === null);
  check("deploy backoff: no streak → free", deployBackoffRemaining(null, t0) === 0);
  const short = noteDeployRefusal(noteDeployRefusal(null, "direction-guard", t0, { after: 2, backoffMs: 1_000 }), "direction-guard", t0 + 1, { after: 2, backoffMs: 1_000 });
  check("deploy backoff: threshold and window injectable (tests)", short?.until === t0 + 1 + 1_000 && deployBackoffRemaining(short, t0 + 1_001) === 0);

  // (3) nightly layer vs foreign mission
  check("nightly layer: foreign mission → off, idle or busy", nightlyLayer(true, 0) === "off" && nightlyLayer(true, 3) === "off");
  check("nightly layer: own repo → run when idle, busy otherwise", nightlyLayer(false, 0) === "run" && nightlyLayer(false, 1) === "busy");
  const nightlyAt = pilotIndexSrc.indexOf("const nightly = nightlyLayer(foreignMission, running.size);");
  check(
    "index.ts: maybeNightly only runs under nightlyLayer === \"run\" (foreign mission never reaches the red team)",
    nightlyAt > -1 &&
      /if \(nightly === "run"\) \{\s*try \{\s*await maybeNightly\(/.test(pilotIndexSrc.slice(nightlyAt, nightlyAt + 400)) &&
      (pilotIndexSrc.match(/await maybeNightly\(/g) ?? []).length === 1,
  );

  // (5a) default HEAD detection — injectable io
  const ioOf = (sym: { ok: boolean; output: string }, show: { ok: boolean; output: string }) => {
    const calls: string[] = [];
    return {
      calls,
      exec: (cmd: string) => {
        calls.push(cmd);
        return cmd.startsWith("git symbolic-ref") ? sym : show;
      },
    };
  };
  const ioMaster = ioOf({ ok: true, output: "origin/master\n" }, { ok: true, output: "should not be read" });
  const detMaster = detectDefaultBranch(ioMaster);
  check("default branch: origin/HEAD symbolic-ref wins (offline), remote show never called", detMaster.branch === "master" && detMaster.source === "symbolic-ref" && ioMaster.calls.length === 1);
  const ioShow = ioOf({ ok: false, output: "" }, { ok: true, output: "* remote origin\n  Fetch URL: x\n  HEAD branch: develop\n  Remote branches:\n" });
  const detShow = detectDefaultBranch(ioShow);
  check("default branch: no symbolic-ref → git remote show origin HEAD branch", detShow.branch === "develop" && detShow.source === "remote-show");
  const detFallback = detectDefaultBranch(ioOf({ ok: false, output: "" }, { ok: false, output: "" }));
  check("default branch: both probes down → main (fallback)", detFallback.branch === "main" && detFallback.source === "fallback");
  check("default branch: (unknown) HEAD and hostile names never pass", detectDefaultBranch(ioOf({ ok: true, output: "origin/evil name; rm -rf\n" }, { ok: true, output: "  HEAD branch: (unknown)\n" })).source === "fallback");
  check("parseSymbolicHead: full ref and short ref both strip to the branch; a bare name is not a remote ref", parseSymbolicHead("refs/remotes/origin/main\n") === "main" && parseSymbolicHead("origin/release/1.x") === "release/1.x" && parseSymbolicHead("main") === null && parseSymbolicHead("") === null);
  check("parseRemoteShowHead: only the HEAD branch line", parseRemoteShowHead("  HEAD branch: master\n  Remote branch:\n    master tracked") === "master" && parseRemoteShowHead("nothing") === null);
  // real git: a clone of a master-default repo reports master
  const bdir = mkdtempSync(join(tmpdir(), "ocr-default-branch-"));
  try {
    const src = join(bdir, "src");
    const clone = join(bdir, "clone");
    mkdirSync(src);
    execSync("git init -q -b master && git config user.email t@t && git config user.name t", { cwd: src });
    writeFileSync(join(src, "README.md"), "hi\n");
    execSync("git add README.md && git commit -q -m init", { cwd: src });
    execSync(`git clone -q ${JSON.stringify(src)} ${JSON.stringify(clone)}`);
    const realIo = {
      exec: (cmd: string) => {
        try {
          return { ok: true, output: execSync(cmd, { cwd: clone, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) };
        } catch {
          return { ok: false, output: "" };
        }
      },
    };
    const detReal = detectDefaultBranch(realIo);
    check("default branch (real git): master-default clone → master via symbolic-ref", detReal.branch === "master" && detReal.source === "symbolic-ref");
    check("default branch (real git): pinning main from origin/master works where origin/main does not exist", spawnSync("git", ["checkout", "-q", "-B", "main", `origin/${detReal.branch}`], { cwd: clone }).status === 0 && spawnSync("git", ["rev-parse", "--verify", "-q", "origin/main"], { cwd: clone }).status !== 0);
  } finally {
    rmSync(bdir, { recursive: true, force: true });
  }

  // (5b) BACKLOG.md skeleton for a fresh target repo
  check("backlog skeleton: needed for a missing file or one without ## Ready", needsBacklogSkeleton(null) && needsBacklogSkeleton("# x\n\n## Done\n") && !needsBacklogSkeleton("# x\n\n## Ready\n\n## Done\n"));
  check("backlog skeleton: carries the three sections every backlog edit relies on", ["## Ready", "## Blocked", "## Done"].every((s) => new RegExp(`^${s}$`, "m").test(BACKLOG_SKELETON)) && BACKLOG_SKELETON.indexOf("## Ready") < BACKLOG_SKELETON.indexOf("## Blocked") && BACKLOG_SKELETON.indexOf("## Blocked") < BACKLOG_SKELETON.indexOf("## Done"));
  check("backlog skeleton: parses as an empty queue", parseBacklog(BACKLOG_SKELETON).length === 0 && backlogSkeletonEdit(null) === BACKLOG_SKELETON && backlogSkeletonEdit("## Ready\n") === null);
  const userMd = "# My own backlog\n\n- keep this line\n\n## Done\n- [x] (P2-001) [P2] shipped — done\n";
  const merged = backlogSkeletonEdit(userMd) ?? "";
  check(
    "backlog skeleton: a user's own BACKLOG.md keeps its content and gains only the missing sections (no duplicate ## Done)",
    merged.startsWith("# My own backlog") && merged.includes("- keep this line") && /^## Ready$/m.test(merged) && /^## Blocked$/m.test(merged) && (merged.match(/^## Done$/gm) ?? []).length === 1,
  );
  const sdir = mkdtempSync(join(tmpdir(), "ocr-backlog-seed-"));
  try {
    check("seedBacklogSkeleton: creates the file, then keeps it", seedBacklogSkeleton(sdir) === "created" && seedBacklogSkeleton(sdir) === "kept" && readFileSync(join(sdir, "BACKLOG.md"), "utf8") === BACKLOG_SKELETON);
    check("seedBacklogSkeleton: seeded file accepts a refill line (no more \"missing\")", appendReadyLines(sdir, ["- [ ] (P2-001) [P2] First — spec: x (area: ui)"]) === "applied" && parseBacklog(readFileSync(join(sdir, "BACKLOG.md"), "utf8")).length === 1);
    writeFileSync(join(sdir, "BACKLOG.md"), userMd);
    check("seedBacklogSkeleton: user file → appended", seedBacklogSkeleton(sdir) === "appended" && appendReadyLines(sdir, ["- [ ] (P2-002) [P2] Second — spec: x (area: ui)"]) === "applied");
    // the refill landing seeds inside apply (after the rewind), so no clean/reset can eat it
    rmSync(join(sdir, "BACKLOG.md"));
    let seedPushes = 0;
    const seedIo: AuxPushIo = {
      exec: (cmd: string) => {
        if (cmd.includes(`git checkout -q -B ${META_BRANCH}`)) rmSync(join(sdir, "BACKLOG.md"), { force: true }); // the rewind: origin/main has no BACKLOG.md
        if (cmd.startsWith("git diff")) return { ok: true, output: "BACKLOG.md\n" };
        if (cmd.startsWith("git push")) {
          seedPushes++;
          return { ok: true, output: "" };
        }
        if (cmd.startsWith("git rev-parse")) return { ok: true, output: `${"d".repeat(40)}\n` };
        if (cmd.startsWith("gh ") && cmd.includes("pr view")) return { ok: true, output: JSON.stringify({ state: "MERGED", headRefOid: "d".repeat(40) }) };
        return { ok: true, output: "" };
      },
      sleep: () => Promise.resolve(),
    };
    check("appendCommitAndPush: without seedSkeleton a repo with no BACKLOG.md fails (the old forever-loop)", (await appendCommitAndPush(sdir, ["- [ ] (P2-003) [P2] Third — spec: x (area: ui)"], "m", seedIo)) === "failed" && seedPushes === 0);
    check("appendCommitAndPush: seedSkeleton lands skeleton + lines in one guarded push", (await appendCommitAndPush(sdir, ["- [ ] (P2-003) [P2] Third — spec: x (area: ui)"], "m", seedIo, 3, { seedSkeleton: true })) === "pushed" && seedPushes === 1 && parseBacklog(readFileSync(join(sdir, "BACKLOG.md"), "utf8")).some((t) => t.id === "P2-003"));
    // reland path threads the same option
    const pf = join(sdir, "pending-refill.json");
    savePendingRefill(pf, ["- [ ] (P2-004) [P2] Fourth — spec: x (area: ui)"], "m");
    const relandIo: AuxPushIo = { exec: (cmd) => (cmd.startsWith("git show") ? { ok: false, output: "" } : seedIo.exec(cmd)), sleep: () => Promise.resolve() };
    check("relandPendingRefill: seedSkeleton threads through to the landing", (await relandPendingRefill(sdir, pf, relandIo, { seedSkeleton: true })) === "pushed" && !existsSync(pf));
  } finally {
    rmSync(sdir, { recursive: true, force: true });
  }
  check("index.ts: strategist refill and reland seed the skeleton only on a foreign mission", (pilotIndexSrc.match(/seedSkeleton: foreignMission/g) ?? []).length === 2);

  // (4) model substitution must not be silent
  const mdir = mkdtempSync(join(tmpdir(), "ocr-model-subst-"));
  try {
    const mf = join(mdir, "model-substitutions.json");
    check("model subst: missing file → empty, never throws", readModelSubstitutions(mf).length === 0);
    check("model subst: record upserts by role", recordModelSubstitution(mf, { role: "builder", wanted: "glm52/glm-5.2", usedInstead: "tier-A default", reason: "not available", at: "t1" }) && recordModelSubstitution(mf, { role: "builder", wanted: "glm52/glm-5.2", usedInstead: "tier-A default", reason: "not available", at: "t2" }) && readModelSubstitutions(mf).length === 1 && readModelSubstitutions(mf)[0]?.at === "t2");
    check("model subst: invalid role / id refused (nothing written)", recordModelSubstitution(mf, { role: "planner", wanted: "p/m", usedInstead: "x", reason: "", at: "" }) === false && recordModelSubstitution(mf, { role: "scribe", wanted: "no slash", usedInstead: "x", reason: "", at: "" }) === false && readModelSubstitutions(mf).length === 1);
    check("model subst: file is private (0600)", (statSync(mf).mode & 0o777) === 0o600);
    recordModelSubstitution(mf, { role: "scribe", wanted: "gone/model", usedInstead: "tier-A default", reason: "r", at: "t" });
    const all = readModelSubstitutions(mf);
    check("model subst: only entries matching the ACTIVE pins surface (re-pinned/cleared missions show nothing)", activeModelSubstitutions({ builder: "glm52/glm-5.2", scribe: "other/model" }, all).map((e) => e.role).join() === "builder" && activeModelSubstitutions(undefined, all).length === 0 && activeModelSubstitutions({}, all).length === 0);
    check("model subst: clear drops the role, others stay", clearModelSubstitution(mf, "builder") && readModelSubstitutions(mf).map((e) => e.role).join() === "scribe" && clearModelSubstitution(mf, "builder"));
    writeFileSync(mf, "{ corrupt");
    check("model subst: corrupt file reads as empty and is overwritten by the next record", readModelSubstitutions(mf).length === 0 && recordModelSubstitution(mf, { role: "reviewer", wanted: "a/b", usedInstead: "tier-A default", reason: "x".repeat(500), at: "t" }) && readModelSubstitutions(mf)[0]?.reason.length === 200);
    check("model subst: one-line rendering (pilot + card agree)", formatModelSubstitutions([{ role: "builder", wanted: "a/b", usedInstead: "tier-A default", reason: "gone", at: "" }]) === "builder: a/b -> tier-A default (gone)" && formatModelSubstitutionsView([{ role: "builder", wanted: "a/b", usedInstead: "tier-A default" }]) === "builder: a/b -> tier-A default" && formatModelSubstitutionsView(undefined) === "" && formatModelSubstitutionsView([{ role: "x" } as unknown as { role: string; wanted: string; usedInstead: string }]) === "");
    // the dispatch path records the fallback and clears it when the pin dispatches again
    const argvSpawn2 = (() => spawn(process.execPath, ["-e", "process.exit(0)"])) as unknown as typeof spawn;
    const base2 = { cwd: tmpdir(), timeoutMin: 1, label: "t", preflight: async () => true, spawnImpl: argvSpawn2, substitutionsFile: mf };
    await runAgentForRole("builder", "hello", { ...base2, missionModels: { builder: "glm52/glm-5.2" }, catalog: async () => new Set(["other/model"]) });
    const rec = readModelSubstitutions(mf).find((e) => e.role === "builder");
    check("runAgentForRole: an unavailable mission model records the substitution with both ids", rec?.wanted === "glm52/glm-5.2" && rec?.usedInstead === "tier-A default" && /not available/.test(rec?.reason ?? ""));
    await runAgentForRole("builder", "hello", { ...base2, missionModels: { builder: "glm52/glm-5.2" }, catalog: async () => new Set(["glm52/glm-5.2"]) });
    check("runAgentForRole: the pin dispatching for real clears its substitution", !readModelSubstitutions(mf).some((e) => e.role === "builder"));
  } finally {
    rmSync(mdir, { recursive: true, force: true });
  }
  const runnerSrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "runner.ts"), "utf8");
  check("runner.ts: the fallback warn line carries wanted AND usedInstead", /logDispatch\("warn", "mission-model-fallback", \{ role, wanted: pick\.wanted, usedInstead, reason: pick\.reason/.test(runnerSrc));
  const daemonSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  check("daemon: GET /api/pilot-mission returns modelSubstitutions filtered by the active pins", daemonSrc.includes("send(200, { mission: spec?.prompt ?? legacy, spec, modelSubstitutions });") && daemonSrc.includes("activeModelSubstitutions(spec?.models, readModelSubstitutions(defaultModelSubstitutionsFile()))"));
  const mcvSrc = readFileSync(join(import.meta.dirname, "..", "apps", "web", "src", "components", "MissionControlView.tsx"), "utf8");
  check("Mission Control card: reads modelSubstitutions and renders the substituted line", mcvSrc.includes("json?.modelSubstitutions") && mcvSrc.includes('t("missionModelSubstituted")'));
  check(
    "i18n: missionModelSubstituted exists in en and pt, one line, no emoji",
    ["en", "pt"].every((l) => {
      const v = (dict[l as "en" | "pt"] as Record<string, string>).missionModelSubstituted;
      return typeof v === "string" && v.length > 0 && !v.includes("\n") && !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(v);
    }),
  );

  // (5c) mission protocol: the agent discloses how the fleet touches the user's repo
  const mproto = buildMissionPrompt();
  check("mission protocol: discloses PR-based work (squash merges) with this machine's gh credentials", /PRs/.test(mproto) && /squash/.test(mproto) && /credenciais do gh/.test(mproto) && /nada é commitado direto em main/.test(mproto));
  check("mission protocol: points the chat at modelSubstitutions for \"which model is running\"", mproto.includes("modelSubstitutions") && mproto.includes("/api/pilot-mission"));
}
// --- P2-194: device labels + last-seen touch (devicetouch.ts) -----------------

{
  const base = 1_700_000_000_000; // arbitrary fixed "now" anchor (pure: no clock reads)
  const iso = (t: number) => new Date(t).toISOString();

  // touchDecision matrix
  check(
    "P2-194: missing stamp (undefined/null/empty/blank) → write",
    touchDecision(undefined, base, DEVICE_TOUCH_INTERVAL_MS) === "write" &&
      touchDecision(null, base, DEVICE_TOUCH_INTERVAL_MS) === "write" &&
      touchDecision("", base, DEVICE_TOUCH_INTERVAL_MS) === "write" &&
      touchDecision("   ", base, DEVICE_TOUCH_INTERVAL_MS) === "write",
  );
  check(
    "P2-194: stamp inside the interval → skip (no daemon.json rewrite per frame)",
    touchDecision(iso(base - DEVICE_TOUCH_INTERVAL_MS + 1), base, DEVICE_TOUCH_INTERVAL_MS) === "skip" &&
      touchDecision(iso(base - 60_000), base, DEVICE_TOUCH_INTERVAL_MS) === "skip" &&
      touchDecision(iso(base), base, DEVICE_TOUCH_INTERVAL_MS) === "skip",
  );
  check(
    "P2-194: stamp at/after the interval → write",
    touchDecision(iso(base - DEVICE_TOUCH_INTERVAL_MS), base, DEVICE_TOUCH_INTERVAL_MS) === "write" &&
      touchDecision(iso(base - DEVICE_TOUCH_INTERVAL_MS - 5_000), base, DEVICE_TOUCH_INTERVAL_MS) ===
        "write",
  );
  check(
    "P2-194: future stamp (clock ahead) → skip, never a write loop",
    touchDecision(iso(base + 1), base, DEVICE_TOUCH_INTERVAL_MS) === "skip" &&
      touchDecision(iso(base + DEVICE_TOUCH_INTERVAL_MS * 10), base, DEVICE_TOUCH_INTERVAL_MS) === "skip",
  );
  check(
    "P2-194: non-string stamp (number/object/garbage string) → write (unreadable converges)",
    touchDecision(123, base, DEVICE_TOUCH_INTERVAL_MS) === "write" &&
      touchDecision({ t: base }, base, DEVICE_TOUCH_INTERVAL_MS) === "write" &&
      touchDecision("not-a-date", base, DEVICE_TOUCH_INTERVAL_MS) === "write",
  );

  // nextDeviceLabel
  check("P2-194: label for an empty list → Telefone 1", nextDeviceLabel([]) === "Telefone 1");
  check(
    "P2-194: label for a one-item list → next number",
    nextDeviceLabel(["Telefone 1"]) === "Telefone 2" && nextDeviceLabel(["first"]) === "Telefone 1",
  );
  check(
    "P2-194: label skips numbers already in use",
    nextDeviceLabel(["Telefone 1", "Telefone 2"]) === "Telefone 3" &&
      nextDeviceLabel(["Telefone 1", "Telefone 3"]) === "Telefone 2" &&
      nextDeviceLabel(["Telefone 1", "Telefone 2", "Telefone 3"]) === "Telefone 4",
  );
  check(
    "P2-194: label for a nine-item list → Telefone 10 (two digits)",
    nextDeviceLabel(["Telefone 1", "Telefone 2", "Telefone 3", "Telefone 4", "Telefone 5", "Telefone 6", "Telefone 7", "Telefone 8", "Telefone 9"]) ===
      "Telefone 10",
  );

  // old allowlist round trip: read without lastSeenAt, mutate in place the way
  // saveAllowlist does (raw.clients = parsed objects, only the field added),
  // re-serialize — no existing or unknown field may be lost.
  const oldJson = `{"room":"r","ecdhPub":"p","ecdhPriv":"k","vapid":{"publicKey":"a","privateKey":"b"},
    "clients":[{"pub":"PUB1","label":"first","addedAt":"2025-01-01T00:00:00.000Z","customUnknown":"keep-me"}]}`;
  const parsed = JSON.parse(oldJson);
  const client = (parsed.clients as Array<Record<string, unknown>>)[0];
  // legacy client has no lastSeenAt → touchDecision(undefined) === "write"
  check("P2-194: legacy client without lastSeenAt reads as never-seen → write", touchDecision(client.lastSeenAt, base, DEVICE_TOUCH_INTERVAL_MS) === "write");
  client.lastSeenAt = iso(base);
  const roundTripped = JSON.parse(JSON.stringify(parsed)).clients[0];
  check(
    "P2-194: old allowlist re-written with lastSeenAt loses no field (incl. unknown)",
    roundTripped.pub === "PUB1" &&
      roundTripped.label === "first" &&
      roundTripped.addedAt === "2025-01-01T00:00:00.000Z" &&
      roundTripped.customUnknown === "keep-me" &&
      roundTripped.lastSeenAt === iso(base),
  );

  // real-source assertion: the bootstrap branch in the REAL index.ts must label
  // through nextDeviceLabel( and never resurrect the fixed "first" string.
  const daemonIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const bootstrapLabelAt = daemonIndexSrc.indexOf("decision === \"allow\" && !client");
  check(
    "P2-194: the real bootstrap branch labels via nextDeviceLabel( and the fixed \"first\" is gone",
    bootstrapLabelAt > -1 &&
      daemonIndexSrc.slice(bootstrapLabelAt, bootstrapLabelAt + 600).includes("nextDeviceLabel(") &&
      !daemonIndexSrc.includes('label: "first"'),
  );
}

// --- P2-197: reach probe of the app address (webreach.ts) --------------------

{
  const base = { elapsedMs: 1, errorName: "", appMarker: false } as const;

  // probeVerdict matrix — one check per state
  const ok = probeVerdict({ ...base, status: 200, appMarker: true });
  check("P2-197: status 200 AND the app marker → ok", ok.state === "ok" && ok.message.length > 0);
  const notOurs = probeVerdict({ ...base, status: 200, appMarker: false });
  check("P2-197: status 200 without the app marker → not-our-app", notOurs.state === "not-our-app");
  const tls = probeVerdict({ status: null, elapsedMs: 1, errorName: "CERT_HAS_EXPIRED", appMarker: false });
  check("P2-197: certificate error name → tls-error", tls.state === "tls-error");
  const tlsLower = probeVerdict({ status: null, elapsedMs: 1, errorName: "unable_to_verify_leaf_signature", appMarker: false });
  check("P2-197: error names match case-insensitively (tls)", tlsLower.state === "tls-error");
  const dns = probeVerdict({ status: null, elapsedMs: 1, errorName: "ENOTFOUND", appMarker: false });
  check("P2-197: name-resolution error name → dns-error", dns.state === "dns-error");
  const abort = probeVerdict({ status: null, elapsedMs: 1, errorName: "AbortError", appMarker: false });
  check("P2-197: abort → timeout", abort.state === "timeout");
  const abortAlt = probeVerdict({ status: null, elapsedMs: 1, errorName: "TimeoutError", appMarker: false });
  check("P2-197: TimeoutError → timeout too", abortAlt.state === "timeout");
  const httpError = probeVerdict({ ...base, status: 503 });
  check("P2-197: 503 → http-error (never unreachable)", httpError.state === "http-error");
  const refused = probeVerdict({ status: null, elapsedMs: 1, errorName: "ECONNREFUSED", appMarker: false });
  check("P2-197: connection refused → unreachable", refused.state === "unreachable");
  check(
    "P2-197: a marker-less 2xx/3xx final answer (204) → not-our-app",
    probeVerdict({ ...base, status: 204 }).state === "not-our-app",
  );

  // every generated message: non-empty, no path separators, no URL scheme
  const verdicts = [ok, notOurs, tls, tlsLower, dns, abort, abortAlt, httpError, refused];
  check(
    "P2-197: every message is non-empty, path-free and scheme-free",
    verdicts.every(
      (v) =>
        v.message.length > 0 &&
        !v.message.includes("/") &&
        !v.message.includes("\\") &&
        !v.message.includes("http:") &&
        !v.message.includes("https:"),
    ),
  );

  // hasAppMarker against the REAL index.html markers and a stranger's page
  const realIndex = readFileSync(join(import.meta.dirname, "..", "apps", "web", "index.html"), "utf8");
  check(
    "P2-197: hasAppMarker is true for the real app shell and false for a stranger page",
    hasAppMarker(realIndex) === true && hasAppMarker("<h1>nginx</h1>") === false,
  );

  // real-source assertions over the REAL main.ts
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const helperAt = mainSrc.indexOf("async function probeWebAppReach(");
  const helperBody = helperAt > -1 ? mainSrc.slice(helperAt, helperAt + 1600) : "";
  check(
    "P2-197: the real main.ts probes the ORIGIN of webApp, never the credential-bearing pairLink",
    mainSrc.includes("probeWebAppReach(webAppRes.url)") &&
      mainSrc.includes("new URL(url).origin") &&
      !mainSrc.includes("probeWebAppReach(pairLink") &&
      !mainSrc.includes("probeWebAppReach(pairLinkRes"),
  );
  check(
    "P2-197: the probe request never carries a credential header",
    helperAt > -1 && !helperBody.includes("headers") && !helperBody.includes("authorization"),
  );
  check(
    "P2-197: the probe timeout reuses PROBE_TIMEOUT_MS (2s) and equals WEB_REACH_TIMEOUT_MS",
    /const PROBE_TIMEOUT_MS = 2_000;/.test(mainSrc) && WEB_REACH_TIMEOUT_MS === 2_000,
  );
  const setPairingAt = mainSrc.indexOf("setPairingState({");
  const payload = mainSrc.slice(setPairingAt, mainSrc.indexOf("});", setPairingAt));
  check(
    "P2-197: the additive reach field rides AFTER webApp in the pairing payload",
    payload.indexOf("webApp,") > -1 && payload.indexOf("reach,") > payload.indexOf("webApp,"),
  );
  check(
    "P2-197: the probe runs only under the QR guard and a problem-free address",
    /!quietLocal && \(!paired \|\| remotePairingRequested\) && webAppRes\.problems\.length === 0 && webAppRes\.url !== ""/.test(mainSrc),
  );
  check(
    "P2-197: the renderer treats an absent reach as unknown (optional chaining, no crash)",
    readFileSync(join(import.meta.dirname, "..", "apps", "web", "src", "components", "PairingOverlay.tsx"), "utf8").includes("{reach && ("),
  );
  check(
    "P2-197: pairReachOk/pairReachRetry/pairReachTesting exist in en and pt",
    ["pairReachOk", "pairReachRetry", "pairReachTesting"].every(
      (k) =>
        typeof (dict.en as Record<string, string>)[k] === "string" &&
        typeof (dict.pt as Record<string, string>)[k] === "string",
    ),
  );
}

// --- P2-199: daemon↔relay link verdict (relaylink.ts) -------------------------

{
  const facts = (over: Partial<RelayLinkFacts> = {}): RelayLinkFacts => ({
    relayConnected: true,
    relayOk: true,
    relayReason: null,
    attempt: 0,
    nextDelayMs: 0,
    lastCloseKind: null,
    localMode: false,
    ...over,
  });

  // one check per state
  const connected = linkVerdict(facts());
  check("P2-199: healthy relay link → connected", connected.state === "connected" && connected.message.length > 0);
  check(
    "P2-199: connected even with relayRetry null (the real connected shape)",
    linkVerdict(facts({ attempt: null, nextDelayMs: null, lastCloseKind: null })).state === "connected",
  );
  const local = linkVerdict(
    facts({ relayConnected: false, relayOk: false, relayReason: "recusado", attempt: 3, lastCloseKind: "capacity", localMode: true }),
  );
  check("P2-199: local mode wins over every other signal", local.state === "local");
  const dialing = linkVerdict(facts({ relayConnected: false, attempt: 2, nextDelayMs: 4_000, lastCloseKind: "transient" }));
  check("P2-199: backoff in progress (attempt >= 1) → dialing", dialing.state === "dialing" && dialing.message.length > 0);
  const firstDial = linkVerdict(facts({ relayConnected: false }));
  const refusedCapacity = linkVerdict(facts({ relayConnected: false, lastCloseKind: "capacity" }));
  const refusedRateLimited = linkVerdict(facts({ relayConnected: false, lastCloseKind: "rate-limited" }));
  check(
    "P2-199: first dial (no attempt yet) → dialing too",
    firstDial.state === "dialing",
  );
  check(
    "P2-199: refusal close capacity → refused",
    refusedCapacity.state === "refused",
  );
  check(
    "P2-199: refusal close rate-limited → refused",
    refusedRateLimited.state === "refused",
  );
  check(
    "P2-199: unknown/new close kind → dialing (never explodes, never accuses)",
    linkVerdict(facts({ relayConnected: false, lastCloseKind: "something-new" })).state === "dialing",
  );
  const misWithReason = linkVerdict(facts({ relayOk: false, relayReason: "prefiro não ecoar" }));
  const misNoReason = linkVerdict(facts({ relayOk: false, relayReason: null }));
  check(
    "P2-199: relayOk false → misconfigured, with or without a reason",
    misWithReason.state === "misconfigured" && misNoReason.state === "misconfigured",
  );
  check(
    "P2-199: relayOk false beats a refusal close (root cause first)",
    linkVerdict(facts({ relayOk: false, relayConnected: false, lastCloseKind: "capacity" })).state === "misconfigured",
  );
  const legacy = linkVerdict(
    facts({ relayConnected: null, relayOk: null, relayReason: null, attempt: null, nextDelayMs: null, lastCloseKind: null }),
  );
  check("P2-199: legacy payload (all null) → unknown", legacy.state === "unknown");
  check(
    "P2-199: the unknown wording is neutral — it never accuses failure",
    !/falha|erro|recus|inválid|quebrad/i.test(legacy.message),
  );

  // every generated message: non-empty, no path separators, no URL scheme
  const verdicts = [connected, local, dialing, firstDial, refusedCapacity, refusedRateLimited, misWithReason, misNoReason, legacy];
  check(
    "P2-199: every message is non-empty, path-free and scheme-free",
    verdicts.every(
      (v) =>
        v.message.length > 0 &&
        !v.message.includes("/") &&
        !v.message.includes("\\") &&
        !v.message.includes("http:") &&
        !v.message.includes("https:"),
    ),
  );

  // real-source assertions over the REAL main.ts
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  check(
    "P2-199: exactly ONE health call per tick in the real main.ts",
    (mainSrc.match(/fetchDaemonHealth\(/g) ?? []).length === 1,
  );
  check(
    "P2-199: relayLink is computed under the same overlay guard as the reach probe",
    /if \(!quietLocal && \(!paired \|\| remotePairingRequested\) && relay\) \{/.test(mainSrc) &&
      /relayLink = linkVerdict\(\{ \.\.\.relay, localMode: quietLocal \}\)/.test(mainSrc),
  );
  const setPairingAt = mainSrc.indexOf("setPairingState({");
  const payload = mainSrc.slice(setPairingAt, mainSrc.indexOf("});", setPairingAt));
  check(
    "P2-199: the additive relayLink field rides AFTER reach, which rides AFTER webApp",
    payload.indexOf("relayLink,") > payload.indexOf("reach,") && payload.indexOf("reach,") > payload.indexOf("webApp,"),
  );
  const overlaySrc = readFileSync(
    join(import.meta.dirname, "..", "apps", "web", "src", "components", "PairingOverlay.tsx"),
    "utf8",
  );
  check(
    "P2-199: the overlay renders the relay-link line and its comment states the QR is NEVER hidden",
    overlaySrc.includes("{relayLink && (") && overlaySrc.includes("NEVER hidden"),
  );
  check(
    "P2-199: the neutral unknown state renders discreet (same class as connected/local)",
    /relayLink\.state === "connected" \|\| relayLink\.state === "local" \|\| relayLink\.state === "unknown"/.test(overlaySrc),
  );
  check(
    "P2-199: pairRelayLinkOk/pairRelayLinkLocal exist in en and pt",
    ["pairRelayLinkOk", "pairRelayLinkLocal"].every(
      (k) =>
        typeof (dict.en as Record<string, string>)[k] === "string" &&
        typeof (dict.pt as Record<string, string>)[k] === "string",
    ),
  );
}

// --- P2-201: speech-to-text capability verdict (voicecap.ts) + wiring ----------

{
  const src = (rel: string[]) => readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");
  const indexSrc = src(["apps", "daemon", "src", "index.ts"]);
  const whisperSrc = src(["apps", "daemon", "src", "whisper.ts"]);
  const voicecapSrc = src(["apps", "daemon", "src", "voicecap.ts"]);
  const chatViewSrc = src(["apps", "web", "src", "components", "ChatView.tsx"]);
  const homeViewSrc = src(["apps", "web", "src", "components", "HomeView.tsx"]);

  // sttVerdict matrix
  check("P2-201: whisper-cpp with a model present is ready", sttVerdict("whisper-cpp", true).state === "ready");
  check(
    "P2-201: whisper-cpp without a model is missing-model (the case that used to collapse to null)",
    sttVerdict("whisper-cpp", false).state === "missing-model",
  );
  check(
    "P2-201: no tool at all is missing-binary (model presence is irrelevant)",
    sttVerdict(null, false).state === "missing-binary" && sttVerdict(null, true).state === "missing-binary",
  );
  check(
    "P2-201: mlx and openai are ready without requiring a model",
    sttVerdict("mlx", false).state === "ready" && sttVerdict("openai", false).state === "ready",
  );
  check(
    "P2-201: unknown tool type is missing-binary",
    sttVerdict("pocketsphinx", true).state === "missing-binary" &&
      sttVerdict("pocketsphinx", false).state === "missing-binary",
  );

  // message hygiene: short, actionable, no paths / script names / URL schemes
  const verdicts = [
    sttVerdict("whisper-cpp", true),
    sttVerdict("whisper-cpp", false),
    sttVerdict(null, false),
    sttVerdict("mlx", false),
    sttVerdict("openai", false),
  ];
  check(
    "P2-201: every verdict message is non-empty and free of paths, scripts and URL schemes",
    verdicts.every(
      (v) =>
        v.message.trim().length > 0 &&
        !/[\\/]/.test(v.message) &&
        !/https?:/i.test(v.message) &&
        !/script|setup|terminal|bash|\.bin\b|\.sh\b/i.test(v.message),
    ),
  );
  check(
    "P2-201: missing-model says the engine exists; missing-binary says nothing is installed",
    sttVerdict("whisper-cpp", false).message !== sttVerdict(null, false).message &&
      /modelo/i.test(sttVerdict("whisper-cpp", false).message) &&
      /instal/i.test(sttVerdict(null, false).message),
  );

  // voicecap stays pure: unit tests must never boot a daemon on import
  // (strip line comments first — the header prose names the banned modules)
  const voicecapCode = voicecapSrc.replace(/\/\/.*$/gm, "");
  check(
    "P2-201: voicecap.ts is pure (no node:fs/child_process/http/ws imports)",
    !/node:(fs|child_process|http|os|path)/.test(voicecapCode) && !/"ws"/.test(voicecapCode),
  );

  // real-repo assertion: the 501 body carries the verdict phrase, the English
  // script-path hint is gone, and a lost staged upload gets its own accurate
  // message instead of a capability claim
  check(
    "P2-201: the transcribe 501 body uses the verdict message and drops the English script hint",
    /status: 501, body: \{ error: sttStatus\(\)\.message \}/.test(indexSrc) &&
      !indexSrc.includes("setup-whisper.sh on the host"),
  );
  check(
    "P2-201: a missing staged upload no longer masquerades as a capability problem",
    /body: \{ error: "transcription upload not found" \}/.test(indexSrc),
  );
  check(
    "P2-201: GET /__ocr/voice/stt-status mirrors the tts-status route shape via sttStatus()",
    indexSrc.includes('/__ocr/voice/stt-status" && req.method === "GET"') &&
      /body: sttStatus\(\) \}/.test(indexSrc) &&
      /available: verdict\.state === "ready", state: verdict\.state, message: verdict\.message/.test(indexSrc),
  );
  check(
    "P2-201: OCR_STT_BLOCK=1 is the documented test hatch forcing missing-binary",
    indexSrc.includes('process.env.OCR_STT_BLOCK === "1"') &&
      /OCR_STT_BLOCK/.test(src(["README.md"])) &&
      /OCR_STT_BLOCK/.test(src(["README.pt-BR.md"])) &&
      /OCR_STT_BLOCK/.test(src(["docs", "troubleshooting.md"])),
  );

  // whisper.ts: raw detection exposed additively, detectWhisper signature intact
  check(
    "P2-201: whisper.ts exposes the raw detection (toolType + modelPresent) next to the usable tool",
    whisperSrc.includes("export interface WhisperDetection") &&
      whisperSrc.includes("toolType: WhisperKind | null") &&
      whisperSrc.includes("export async function detectWhisper(): Promise<WhisperTool | null>") &&
      whisperSrc.includes("export async function detectWhisperDetail(): Promise<WhisperDetection>"),
  );

  // both mics consult the verdict, fail open while unknown, and surface the phrase
  check(
    "P2-201: ChatView and HomeView probe stt-status and disable the mic only on a known non-ready verdict",
    chatViewSrc.includes("const stt = useSttStatus(request)") &&
      homeViewSrc.includes("const stt = useSttStatus(request)") &&
      (chatViewSrc.match(/sttBlocked/g) ?? []).length >= 3 &&
      (homeViewSrc.match(/sttBlocked/g) ?? []).length >= 3 &&
      src(["apps", "web", "src", "lib", "transcribe.ts"]).includes('request("GET", "/__ocr/voice/stt-status")'),
  );
}

// --- P2-210: model-readiness verdict (modelready.ts) + wiring ------------------

{
  const src = (rel: string[]) => readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");
  const modelreadySrc = src(["apps", "daemon", "src", "modelready.ts"]);
  const indexSrc = src(["apps", "daemon", "src", "index.ts"]);

  // verdict matrix
  check(
    "P2-210: one provider with at least one model is ready (zero-model peers do not block it)",
    modelReadyVerdict([{ id: "prov-a", models: 1 }]).state === "ready" &&
      modelReadyVerdict([
        { id: "prov-a", models: 0 },
        { id: "prov-b", models: 7 },
      ]).state === "ready",
  );
  check("P2-210: an empty provider list is no-provider", modelReadyVerdict([]).state === "no-provider");
  check(
    "P2-210: providers present with zero models is no-model",
    modelReadyVerdict([
      { id: "prov-a", models: 0 },
      { id: "prov-b", models: 0 },
    ]).state === "no-model",
  );
  check(
    "P2-210: a fetch-error indicator lands in unknown even with a good summary",
    modelReadyVerdict([{ id: "prov-a", models: 3 }], true).state === "unknown",
  );
  check(
    "P2-210: a missing summary lands in unknown",
    modelReadyVerdict(null).state === "unknown" && modelReadyVerdict(undefined).state === "unknown",
  );

  // message hygiene: no paths, no URL schemes, no provider identifiers, no secrets
  const ids = ["anthropic", "openai", "sk-secret-token-123", "my-machine"];
  const verdicts = [
    modelReadyVerdict([{ id: "anthropic", models: 5 }]),
    modelReadyVerdict([]),
    modelReadyVerdict([{ id: "anthropic", models: 0 }]),
    modelReadyVerdict([{ id: "anthropic", models: 0 }], true),
    modelReadyVerdict(null),
    modelReadyVerdict(undefined, true),
  ];
  check(
    "P2-210: every verdict message is non-empty, free of paths/URLs and never names a provider or secret",
    verdicts.every(
      (v) =>
        v.message.trim().length > 0 &&
        !/[\\/]/.test(v.message) &&
        !/https?:/i.test(v.message) &&
        ids.every((id) => !v.message.includes(id)),
    ),
  );
  check(
    "P2-210: the unknown phrase is neutral — it never accuses a failure",
    modelReadyVerdict(null).message !== modelReadyVerdict([]).message &&
      !/falh|erro|inválid/i.test(modelReadyVerdict(null).message),
  );

  // providerSummary derives from the SAME catalog shape the ruler caches
  const catalog = {
    all: [
      { id: "openai", models: { "gpt-1": {}, "gpt-2": {} } },
      { id: "offline", models: {} },
    ],
    connected: ["openai", "ghost", "offline"],
  };
  check(
    "P2-210: providerSummary counts models per connected provider from the cached catalog",
    JSON.stringify(providerSummary(catalog)) ===
      JSON.stringify([
        { id: "openai", models: 2 },
        { id: "ghost", models: 0 },
        { id: "offline", models: 0 },
      ]),
  );
  check(
    "P2-210: a catalog without the connected list cannot answer — null, never a guess",
    providerSummary({ all: [{ id: "openai", models: {} }] }) === null && providerSummary(null) === null,
  );
  check(
    "P2-210: a connected provider missing from all counts zero models (no-model)",
    modelReadyVerdict(providerSummary({ all: [], connected: ["openai"] })).state === "no-model",
  );

  // modelready.ts stays pure: unit tests must never boot a daemon on import
  // (strip line comments first — the header prose names the banned modules)
  const code = modelreadySrc.replace(/\/\/.*$/gm, "");
  check(
    "P2-210: modelready.ts is pure (no node:fs/child_process/http/ws imports)",
    !/node:(fs|child_process|http|os|path)/.test(code) && !/"ws"/.test(code),
  );

  // real-repo assertion: the route mirrors stt-status and consumes the cached
  // catalog — the route body never fires a fetch of its own
  const routeAt = indexSrc.indexOf('/__ocr/model/status" && req.method === "GET"');
  const routeBody = routeAt >= 0 ? indexSrc.slice(routeAt, indexSrc.indexOf("if (req.path", routeAt + 20)) : "";
  check(
    "P2-210: GET /__ocr/model/status mirrors the stt-status route shape",
    routeAt >= 0 && /body: modelStatus\(\) \}/.test(routeBody) && !routeBody.includes("fetch("),
  );
  check(
    "P2-210: the readiness summary comes only from fetches that already happen — the ruler refresh and the /provider passthrough",
    /providerWindows\.refresh\(catalog\);\s*\n\s*\/\/ P2-210/.test(indexSrc) &&
      indexSrc.includes("noteProviderCatalog(catalog, true)") &&
      indexSrc.includes("noteProviderCatalog(j, true)") &&
      /modelReadyVerdict\(modelCatalogSummary, modelCatalogFailed\)/.test(indexSrc),
  );

  // documented test hatch forcing no-provider for deterministic evidence
  check(
    "P2-210: OCR_MODEL_BLOCK=1 is the documented test hatch forcing no-provider",
    indexSrc.includes('process.env.OCR_MODEL_BLOCK === "1"') &&
      /OCR_MODEL_BLOCK/.test(src(["README.md"])) &&
      /OCR_MODEL_BLOCK/.test(src(["README.pt-BR.md"])) &&
      /OCR_MODEL_BLOCK/.test(src(["docs", "troubleshooting.md"])),
  );

  // both composers consult the verdict, show the calm hint and NEVER block
  // sending (fail open on purpose — no disabled= may depend on the hint)
  const chatViewSrc = src(["apps", "web", "src", "components", "ChatView.tsx"]);
  const homeViewSrc = src(["apps", "web", "src", "components", "HomeView.tsx"]);
  check(
    "P2-210: ChatView and HomeView probe model status, show the calm hint and never disable sending",
    chatViewSrc.includes("const modelStatus = useModelStatus(request)") &&
      homeViewSrc.includes("const modelStatus = useModelStatus(request)") &&
      (chatViewSrc.match(/modelHint/g) ?? []).length >= 2 &&
      (homeViewSrc.match(/modelHint/g) ?? []).length >= 2 &&
      src(["apps", "web", "src", "lib", "modelstatus.ts"]).includes('request("GET", "/__ocr/model/status")') &&
      !/disabled=\{[^}]*modelHint/.test(chatViewSrc) &&
      !/disabled=\{[^}]*modelHint/.test(homeViewSrc),
  );
  check(
    "P2-210: the fail-open reason is written in the code comment",
    /DELIBERATELY fail-open/.test(chatViewSrc) && /DELIBERATELY fail-open/.test(homeViewSrc),
  );
}

// --- P2-213: opencode version-readiness verdict (opencodever.ts) + wiring ------

{
  const src = (rel: string[]) => readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");
  const opencodeverSrc = src(["apps", "daemon", "src", "opencodever.ts"]);
  const indexSrc = src(["apps", "daemon", "src", "index.ts"]);
  const settingsSrc = src(["apps", "web", "src", "components", "SettingsView.tsx"]);

  // verdict matrix: equal → ok, greater → ok
  check(
    "P2-213: version equal to the minimum is ok and a greater version is ok",
    versionVerdict(MIN_OPENCODE_VERSION, MIN_OPENCODE_VERSION).state === "ok" &&
      versionVerdict("1.18.25", MIN_OPENCODE_VERSION).state === "ok" &&
      versionVerdict("2.0.0", MIN_OPENCODE_VERSION).state === "ok",
  );
  // each smaller significant segment is too-old
  check(
    "P2-213: a smaller patch, minor or major is too-old",
    versionVerdict("1.18.4", "1.18.5").state === "too-old" &&
      versionVerdict("1.17.9", MIN_OPENCODE_VERSION).state === "too-old" &&
      versionVerdict("0.99.99", MIN_OPENCODE_VERSION).state === "too-old",
  );
  // tolerance: letter-v prefix, pre-release suffix, extra segment, noise
  check(
    "P2-213: v prefix, pre-release suffix and extra segments are tolerated",
    versionVerdict(`v${MIN_OPENCODE_VERSION}`, MIN_OPENCODE_VERSION).state === "ok" &&
      versionVerdict("1.18.0-beta.1", MIN_OPENCODE_VERSION).state === "ok" &&
      versionVerdict("1.18.0.7", MIN_OPENCODE_VERSION).state === "ok" &&
      versionVerdict("v1.17.0-rc.2+build", MIN_OPENCODE_VERSION).state === "too-old",
  );
  check(
    "P2-213: noisy text around the version is still recognized",
    versionVerdict("opencode version v1.19.2 (build 8837)", MIN_OPENCODE_VERSION).state === "ok" &&
      versionVerdict("built on 2024 1.18.0 sha abc", MIN_OPENCODE_VERSION).state === "ok",
  );
  // missing / empty / unrecognizable → neutral unknown
  check(
    "P2-213: null, empty and number-free text all land in unknown",
    versionVerdict(null, MIN_OPENCODE_VERSION).state === "unknown" &&
      versionVerdict("", MIN_OPENCODE_VERSION).state === "unknown" &&
      versionVerdict("sem numeros aqui", MIN_OPENCODE_VERSION).state === "unknown" &&
      versionVerdict("42", MIN_OPENCODE_VERSION).state === "unknown",
  );
  check(
    "P2-213: parseVersion needs two or more dot-separated segments",
    JSON.stringify(parseVersion("v1.18.0-beta.2")) === JSON.stringify([1, 18, 0]) &&
      parseVersion("1") === null &&
      parseVersion(null) === null,
  );

  // message hygiene: no paths, no URL schemes, no command names, no secrets
  const verdicts = [
    versionVerdict(MIN_OPENCODE_VERSION, MIN_OPENCODE_VERSION),
    versionVerdict("0.0.1", MIN_OPENCODE_VERSION),
    versionVerdict(null, MIN_OPENCODE_VERSION),
  ];
  check(
    "P2-213: every verdict message is non-empty, free of paths/URLs/command names and distinct",
    verdicts.every(
      (v) =>
        v.message.trim().length > 0 &&
        !/[\\/]/.test(v.message) &&
        !/https?:/i.test(v.message) &&
        !/\b(npm|npx|brew|curl|wget|git|serve|install|upgrade|update|opencode)\b/i.test(v.message),
    ) && new Set(verdicts.map((v) => v.message)).size === verdicts.length,
  );
  check(
    "P2-213: the unknown phrase is neutral — it never accuses a failure",
    !/falh|erro|inválid|antigo/i.test(versionVerdict(null, MIN_OPENCODE_VERSION).message),
  );

  // opencodever.ts stays pure: unit tests must never boot a daemon on import
  // (strip line comments first — the header prose names the banned modules)
  const code = opencodeverSrc.replace(/\/\/.*$/gm, "");
  check(
    "P2-213: opencodever.ts is pure (no node:fs/child_process/http/os/path imports)",
    !/node:(fs|child_process|http|os|path)/.test(code) && !/"ws"/.test(code),
  );

  // real-repo assertion: the probe runs EXACTLY ONCE at boot, under the
  // binary-found guard, and no per-request call was introduced anywhere
  const probeCalls = indexSrc.match(/probeOpencodeVersion\(/g) ?? [];
  const bootAt = indexSrc.indexOf("refreshOpencodeBinary(true)");
  const hatchAt = indexSrc.indexOf('process.env.OCR_OPENCODE_OLD === "1"');
  check(
    "P2-213: the version probe is fired once at boot, guarded by a resolved binary",
    probeCalls.length === 2 &&
      bootAt >= 0 &&
      hatchAt > bootAt &&
      /else if \(binaryPick\.path !== null\) \{\s*\n\s*probeOpencodeVersion\(binaryPick\.path\);/.test(indexSrc),
  );
  check(
    "P2-213: the probe has a documented timeout, truncates output before the verdict and fails into unknown",
    /execFile\(binPath, \["--version"\], \{ timeout: VERSION_PROBE_TIMEOUT_MS \}/.test(indexSrc) &&
      /stdout\.slice\(0, VERSION_PROBE_MAX_BYTES\)/.test(indexSrc) &&
      /!err && !stderr && raw \? versionVerdict\(raw, MIN_OPENCODE_VERSION\) : versionVerdict\(null, MIN_OPENCODE_VERSION\)/.test(
        indexSrc,
      ),
  );

  // additive surfaces: the health opencode object and the existing settings read
  check(
    "P2-213: the health opencode object gains additive versionState/versionMessage",
    indexSrc.includes("versionState: opencodeVersion.state") &&
      indexSrc.includes("versionMessage: opencodeVersion.message"),
  );
  check(
    "P2-213: the existing /__ocr/settings read mirrors the verdict — no new route",
    // P2-215 grew the same object additively (`disk: diskStatus()`), so the
    // assertion matches the mirror prefix, not the exact closing brace.
    /body: \{ \.\.\.readSettings\(\), version: VERSION, opencodeVersion: opencodeVersion,/.test(indexSrc),
  );

  // the Settings machine section shows the phrase only for too-old and NEVER
  // gates any control on it (fail open on purpose)
  check(
    "P2-213: SettingsView renders the phrase only for too-old and never disables a control with it",
    settingsSrc.includes('opencodeVersion?.state === "too-old"') &&
      settingsSrc.includes("opencode-version-hint") &&
      !/disabled=\{[^}]*opencodeVersion/.test(settingsSrc) &&
      /deliberately fails open/i.test(settingsSrc),
  );

  // documented test hatch forcing too-old for deterministic visual evidence
  check(
    "P2-213: OCR_OPENCODE_OLD=1 is the documented test hatch forcing too-old",
    hatchAt >= 0 &&
      /OCR_OPENCODE_OLD/.test(src(["README.md"])) &&
      /OCR_OPENCODE_OLD/.test(src(["README.pt-BR.md"])) &&
      /OCR_OPENCODE_OLD/.test(src(["docs", "troubleshooting.md"])),
  );
}

// --- P2-215: disk-space readiness verdict (diskguard.ts) + wiring ---------------

{
  const src = (rel: string[]) => readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");
  const diskguardSrc = src(["apps", "daemon", "src", "diskguard.ts"]);
  const indexSrc = src(["apps", "daemon", "src", "index.ts"]);
  const settingsSrc = src(["apps", "web", "src", "components", "SettingsView.tsx"]);

  // exported thresholds are documented and ordered alert < warn
  check(
    "P2-215: thresholds are exported and ordered (alert stricter than warn, both rules)",
    DISK_ALERT_FREE_BYTES < DISK_WARN_FREE_BYTES && DISK_ALERT_FREE_FRACTION < DISK_WARN_FREE_FRACTION,
  );

  // verdict matrix
  check(
    "P2-215: a roomy volume is ok",
    diskVerdict(100 * DISK_WARN_FREE_BYTES, 400 * DISK_WARN_FREE_BYTES).state === "ok",
  );
  check(
    "P2-215: fraction below the warning is low even with roomy bytes",
    diskVerdict(8 * DISK_WARN_FREE_BYTES, 100 * DISK_WARN_FREE_BYTES).state === "low",
  );
  check(
    "P2-215: bytes below the warning is low even with a roomy fraction",
    diskVerdict(0.5 * DISK_WARN_FREE_BYTES, 4 * DISK_WARN_FREE_BYTES).state === "low",
  );
  check(
    "P2-215: fraction below the alert is critical",
    diskVerdict(3 * DISK_WARN_FREE_BYTES, 100 * DISK_WARN_FREE_BYTES).state === "critical",
  );
  check(
    "P2-215: bytes below the alert is critical",
    diskVerdict(0.1 * DISK_WARN_FREE_BYTES, DISK_WARN_FREE_BYTES).state === "critical",
  );
  check(
    "P2-215: when the bytes and fraction rules disagree the more severe state wins",
    diskVerdict(3 * DISK_WARN_FREE_BYTES, 100 * DISK_WARN_FREE_BYTES).state === "critical" && // bytes ok, fraction 3% critical
      diskVerdict(0.1 * DISK_WARN_FREE_BYTES, DISK_WARN_FREE_BYTES).state === "critical", // bytes critical, fraction 10% ok
  );

  // every degenerate reading lands in the neutral unknown
  check(
    "P2-215: a null reading is unknown",
    diskVerdict(null, null).state === "unknown" &&
      diskVerdict(null, 100 * DISK_WARN_FREE_BYTES).state === "unknown" &&
      diskVerdict(5 * DISK_WARN_FREE_BYTES, null).state === "unknown",
  );
  check(
    "P2-215: a zero total is unknown",
    diskVerdict(5 * DISK_WARN_FREE_BYTES, 0).state === "unknown",
  );
  check(
    "P2-215: negative values are unknown",
    diskVerdict(-1, 100 * DISK_WARN_FREE_BYTES).state === "unknown" &&
      diskVerdict(5 * DISK_WARN_FREE_BYTES, -100).state === "unknown",
  );
  check(
    "P2-215: non-finite values are unknown",
    diskVerdict(NaN, 100 * DISK_WARN_FREE_BYTES).state === "unknown" &&
      diskVerdict(Infinity, 100 * DISK_WARN_FREE_BYTES).state === "unknown" &&
      diskVerdict(5 * DISK_WARN_FREE_BYTES, NaN).state === "unknown",
  );

  // message hygiene: no paths, no URL schemes, no command names, no secrets
  const verdicts = [
    diskVerdict(100 * DISK_WARN_FREE_BYTES, 400 * DISK_WARN_FREE_BYTES),
    diskVerdict(0.5 * DISK_WARN_FREE_BYTES, 4 * DISK_WARN_FREE_BYTES),
    diskVerdict(0.1 * DISK_WARN_FREE_BYTES, DISK_WARN_FREE_BYTES),
    diskVerdict(null, null),
  ];
  check(
    "P2-215: every verdict message is non-empty, free of paths/URLs/command names and distinct",
    verdicts.every(
      (v) =>
        v.message.trim().length > 0 &&
        !/[\\/]/.test(v.message) &&
        !/https?:/i.test(v.message) &&
        !/\b(npm|npx|brew|curl|wget|git|rm|df|du|sudo)\b/i.test(v.message),
    ) && new Set(verdicts.map((v) => v.message)).size === verdicts.length,
  );
  check(
    "P2-215: the unknown phrase is neutral — it never accuses a failure",
    !/falh|erro|inválid|cheio/i.test(diskVerdict(null, null).message),
  );

  // diskguard.ts stays pure: unit tests must never boot a daemon on import
  // (strip line comments first — the header prose names the banned modules)
  const code = diskguardSrc.replace(/\/\/.*$/gm, "");
  check(
    "P2-215: diskguard.ts is pure (no node:fs/child_process/http/os/path imports)",
    !/node:(fs|child_process|http|os|path)/.test(code) && !/"ws"/.test(code),
  );

  // real-repo assertion: the reading fires once at boot, before the janitor
  // block, and then rides the SAME interval the P2-207 sweep already uses —
  // no new periodic timer was introduced anywhere in index.ts (baseline: the
  // five pre-existing setInterval( call sites). P2-228 taught that shared
  // interval to sweep uploads too — still exactly one timer, two janitors.
  const bootAt = indexSrc.indexOf("refreshDiskState();");
  const janitorAt = indexSrc.indexOf("if (artifactsSweepOn || uploadsSweepOn) {");
  check(
    "P2-215: the disk reading fires once at boot, before the janitor block",
    bootAt >= 0 && janitorAt > bootAt,
  );
  check(
    "P2-215: the reading rides the existing janitor interval and no new periodic timer exists",
    /const retentionTimer = setInterval\(\(\) => \{\s*\n\s*refreshDiskState\(\);\s*\n\s*if \(artifactsSweepOn\) sweepArtifactRetention\(\);\s*\n\s*if \(uploadsSweepOn\) sweepUploadRetention\(\);\s*\n\s*\}, RETENTION_INTERVAL_MS\)/.test(
      indexSrc,
    ) &&
      (indexSrc.match(/setInterval\(/g) ?? []).length === 5,
  );

  // additive surfaces: health fields and the settings mirror, no new route
  check(
    "P2-215: GET /api/health gains additive diskState/diskMessage",
    indexSrc.includes("diskState: disk.state") && indexSrc.includes("diskMessage: disk.message"),
  );
  check(
    "P2-215: the existing /__ocr/settings read mirrors the disk verdict — no new route",
    /disk: diskStatus\(\)/.test(indexSrc),
  );
  check(
    "P2-215: the health payload never carries a path or a raw byte count",
    !indexSrc.includes("diskBytes") && !/disk[A-Za-z]*:.*STATE_DIR/.test(indexSrc),
  );

  // documented test hatch forcing critical for deterministic visual evidence
  const hatchAt = indexSrc.indexOf('process.env.OCR_DISK_FULL === "1"');
  check(
    "P2-215: OCR_DISK_FULL=1 is the documented test hatch forcing critical",
    hatchAt >= 0 &&
      /OCR_DISK_FULL/.test(src(["README.md"])) &&
      /OCR_DISK_FULL/.test(src(["README.pt-BR.md"])) &&
      /OCR_DISK_FULL/.test(src(["docs", "troubleshooting.md"])),
  );

  // the Settings machine section shows the phrase only for low/critical and
  // NEVER gates any control on it (fail open on purpose)
  check(
    "P2-215: SettingsView renders the phrase only for low/critical and never disables a control with it",
    settingsSrc.includes('disk?.state === "low"') &&
      settingsSrc.includes('disk?.state === "critical"') &&
      settingsSrc.includes("disk-hint") &&
      !/disabled=\{[^}]*disk/.test(settingsSrc) &&
      /deliberately fails open/i.test(settingsSrc),
  );
}

// --- P2-204: packaged boot smoke — bootVerdict table + release.yml wiring ----

{
  const src = (rel: string[]) => readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");
  const verdictSrc = src(["apps", "desktop", "scripts", "packaged-boot-verdict.mjs"]);
  const bootSrc = src(["apps", "desktop", "scripts", "packaged-boot.mjs"]);

  const OK = { executableFound: true, loadFinished: true, rootEmpty: false, canarySeen: true, consoleErrors: [] as string[] };
  const v = (over: Partial<typeof OK>) => bootVerdict({ ...OK, ...over });

  // full verdict table
  check("P2-204: all facts good → ok with no reason", bootVerdict(OK).ok === true && bootVerdict(OK).reason === null);
  check(
    "P2-204: executable not found → binary-missing",
    v({ executableFound: false }).ok === false && v({ executableFound: false }).reason === "binary-missing",
  );
  check("P2-204: load not finished → load-failed", v({ loadFinished: false }).reason === "load-failed");
  check("P2-204: empty root → blank-window", v({ rootEmpty: true }).reason === "blank-window");
  check(
    "P2-204: canary not observed with an empty error list → console-capture-broken (never a vacuous pass)",
    v({ canarySeen: false }).reason === "console-capture-broken",
  );
  check("P2-204: captured console errors → console-error", v({ consoleErrors: ["boom"] }).reason === "console-error");
  check(
    "P2-204: binary-missing outranks everything else",
    v({ executableFound: false, loadFinished: false, rootEmpty: true, canarySeen: false, consoleErrors: ["boom"] }).reason ===
      "binary-missing",
  );
  check(
    "P2-204: blank-window outranks console-capture-broken (the blank window is the stronger, direct observation)",
    v({ rootEmpty: true, canarySeen: false }).reason === "blank-window",
  );
  check(
    "P2-204: console-capture-broken outranks console-error (an untrusted collector voids the error signal)",
    v({ canarySeen: false, consoleErrors: ["boom"] }).reason === "console-capture-broken",
  );

  // message hygiene: short pt-BR, no paths, URL schemes or secrets (P2-201 bar)
  const all = [bootVerdict(OK), v({ executableFound: false }), v({ loadFinished: false }), v({ rootEmpty: true }), v({ canarySeen: false }), v({ consoleErrors: ["boom"] })];
  check(
    "P2-204: every verdict message is non-empty and free of paths, URLs and secrets",
    all.every((x) => typeof x.message === "string" && x.message.trim().length > 0 && !/[\\/]/.test(x.message) && !/https?:/i.test(x.message)),
  );
  check(
    "P2-204: each failing reason carries a distinct message",
    new Set(all.map((x) => x.message)).size === all.length,
  );

  // the verdict module stays pure (P2-194 lesson): importing it must not boot I/O
  check(
    "P2-204: packaged-boot-verdict.mjs is pure (no node: fs/os/path/net/http imports)",
    !/node:(fs|os|path|net|http)/.test(verdictSrc.replace(/\/\/.*$/gm, "")),
  );

  // the driver script carries the hermetic contract of the P1-051 harness
  check(
    "P2-204: packaged-boot.mjs launches hermetically (temp userData, no sidecar, force-down, keeper leash, own session)",
    bootSrc.includes("OCR_USER_DATA_DIR") &&
      bootSrc.includes("OCR_DAEMON_ENTRY") &&
      bootSrc.includes("OCR_DAEMON_FORCE_DOWN") &&
      bootSrc.includes("OCR_KEEPER_PID") &&
      /OCR_DESKTOP_SESSION: `packaged-boot-/.test(bootSrc),
  );
  check(
    "P2-204: the driver injects the shared canary as a console.error after load",
    bootSrc.includes("CANARY") && /console\.error\('\$\{CANARY\}'\)/.test(bootSrc),
  );
  check(
    "P2-204: console collectors attach at window creation, not only after firstWindow resolves",
    bootSrc.includes('electronApp.on("window", collect)') && bootSrc.includes("const collected = new Set()"),
  );
  check(
    "P2-204: the driver fails closed when playwright-core is unavailable (exit 1, never a silent pass)",
    bootSrc.includes("playwright-core is not available") &&
      bootSrc.includes("refusing to pass vacuously") &&
      bootSrc.includes("process.exitCode = 1"),
  );
  check(
    "P2-204: the driver launches the PACKAGED binary via executablePath, not the electron npm package",
    bootSrc.includes("executablePath: executable") && bootSrc.includes('join(appPath, "Contents", "MacOS")'),
  );

  // real-repo assertion: release.yml boots the bundle in desktop-dmg, after
  // packaging and before the artifact upload, with shell: bash + own timeout
  const release = src([".github", "workflows", "release.yml"]);
  const dmgStart = release.indexOf("\n  desktop-dmg:");
  const dmgEnd = release.indexOf("\n  desktop-win:");
  const dmg = dmgStart > -1 && dmgEnd > dmgStart ? release.slice(dmgStart, dmgEnd) : "";
  const winStart = release.indexOf("\n  desktop-win:");
  const winEnd = release.indexOf("\n  release-verify:");
  const win = winStart > -1 && winEnd > winStart ? release.slice(winStart, winEnd) : "";
  const pkgAt = dmg.indexOf("Build + package DMG");
  const bootAt = dmg.indexOf("Smoke-boot the packaged app");
  const uploadAt = dmg.indexOf("Attach DMG + update metadata");
  const stepSlice = bootAt > -1 ? dmg.slice(bootAt, dmg.indexOf("\n      - name:", bootAt)) : "";
  check(
    "P2-204: release.yml desktop-dmg runs the boot smoke between packaging and upload",
    pkgAt > -1 && bootAt > pkgAt && uploadAt > bootAt,
  );
  check(
    "P2-204: the boot smoke step declares shell: bash and its own timeout",
    stepSlice.includes("shell: bash") && /timeout-minutes:/.test(stepSlice),
  );
  check(
    "P2-204: the step resolves the .app under apps/desktop/dist and runs packaged-boot.mjs",
    stepSlice.includes("find apps/desktop/dist") && stepSlice.includes("node apps/desktop/scripts/packaged-boot.mjs"),
  );
  check(
    "P2-208: desktop-win gets the boot smoke too (explicit out of scope only until P2-204)",
    win.includes("Smoke-boot the packaged app"),
  );
}

// --- P2-208: packaged boot layout — candidatePaths + desktop-win wiring -------

{
  const src = (rel: string[]) => readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");
  const layoutSrc = src(["apps", "desktop", "scripts", "packaged-boot-layout.mjs"]);
  const bootSrc = src(["apps", "desktop", "scripts", "packaged-boot.mjs"]);

  // full candidatePaths table
  check(
    "P2-208: classic macOS .app bundle → Contents/MacOS/<bundle name without .app>",
    JSON.stringify(candidatePaths("/tmp/dist/mac-arm64/OpenCode Remote.app", "darwin")) ===
      JSON.stringify(["/tmp/dist/mac-arm64/OpenCode Remote.app/Contents/MacOS/OpenCode Remote"]),
  );
  check(
    "P2-208: macOS bundle name keeps spaces and strips the .app suffix case-insensitively",
    JSON.stringify(candidatePaths("/dist/My App.APP", "darwin")) ===
      JSON.stringify(["/dist/My App.APP/Contents/MacOS/My App"]),
  );
  check(
    "P2-208: Windows path that already points at the executable passes through unchanged",
    JSON.stringify(candidatePaths("C:\\dist\\win-unpacked\\OpenCode Remote.exe", "win32")) ===
      JSON.stringify(["C:\\dist\\win-unpacked\\OpenCode Remote.exe"]),
  );
  check(
    "P2-208: Windows packaging output dir → same-name executable inside it",
    JSON.stringify(candidatePaths("C:\\dist\\win-unpacked", "win32")) ===
      JSON.stringify(["C:\\dist\\win-unpacked\\win-unpacked.exe"]),
  );
  check(
    "P2-208: Windows dir input keeps the caller's separator style (forward-slash paths stay forward-slash)",
    JSON.stringify(candidatePaths("/tmp/dist/win-unpacked", "win32")) ===
      JSON.stringify(["/tmp/dist/win-unpacked/win-unpacked.exe"]),
  );
  check(
    "P2-208: unknown platform → empty candidate list",
    candidatePaths("/dist/OpenCode Remote.app", "linux").length === 0 &&
      candidatePaths("/dist/OpenCode Remote.app", "").length === 0 &&
      candidatePaths("/dist/OpenCode Remote.app", undefined as unknown as string).length === 0,
  );
  check(
    "P2-208: traversal stems are refused — no candidate ever climbs out of the received root",
    candidatePaths("/dist/..", "win32").length === 0 &&
      candidatePaths("/dist/.", "win32").length === 0 &&
      candidatePaths("/dist/.app", "darwin").length === 0 &&
      candidatePaths("/dist/..app", "darwin").length === 0 &&
      candidatePaths("  ", "win32").length === 0,
  );
  {
    const table: Array<[string, string]> = [
      ["/tmp/dist/mac-arm64/OpenCode Remote.app", "darwin"],
      ["C:\\dist\\win-unpacked\\OpenCode Remote.exe", "win32"],
      ["C:\\dist\\win-unpacked", "win32"],
      ["win-unpacked", "win32"],
    ];
    check(
      "P2-208: every candidate descends from the received path — never a parent traversal",
      table.every(([p, plat]) =>
        candidatePaths(p, plat).every(
          (c) => c === p || (c.startsWith(p) && !/(^|[/\\])\.\.([/\\]|$)/.test(c.slice(p.length)))),
      ),
    );
  }

  // the layout module stays pure (P2-194/P2-204 lesson): importing it must
  // never boot I/O, and the driver consumes it with the disk fallback intact
  check(
    "P2-208: packaged-boot-layout.mjs is pure (no node: fs/os/path/net/http imports)",
    !/node:(fs|os|path|net|http)/.test(layoutSrc.replace(/\/\/.*$/gm, "")),
  );
  check(
    "P2-208: resolveExecutable consumes candidatePaths and keeps the executable-file fallback as the only disk point",
    bootSrc.includes("candidatePaths(appPath, process.platform)") &&
      bootSrc.includes('join(appPath, "Contents", "MacOS")') &&
      bootSrc.includes("readdirSync(scanDir)"),
  );

  // real-repo assertion: release.yml boots the bundle in desktop-win, after
  // packaging + signature verification and before the artifact upload
  const release = src([".github", "workflows", "release.yml"]);
  const winStart = release.indexOf("\n  desktop-win:");
  const winEnd = release.indexOf("\n  release-verify:");
  const win = winStart > -1 && winEnd > winStart ? release.slice(winStart, winEnd) : "";
  const pkgAt = win.indexOf("Build + package NSIS installer");
  const signAt = win.indexOf("Authenticode verification of the packaged installer");
  const bootAt = win.indexOf("Smoke-boot the packaged app");
  const uploadAt = win.indexOf("Attach setup exe + update metadata");
  const stepSlice = bootAt > -1 ? win.slice(bootAt, win.indexOf("\n      - name:", bootAt)) : "";
  check(
    "P2-208: release.yml desktop-win runs the boot smoke after packaging + signature verification, before upload",
    pkgAt > -1 && signAt > pkgAt && bootAt > signAt && uploadAt > bootAt,
  );
  check(
    "P2-208: the desktop-win boot smoke declares shell: bash and its own timeout (P2-126/P2-164 lessons)",
    stepSlice.includes("shell: bash") && /timeout-minutes:/.test(stepSlice),
  );
  check(
    "P2-208: the desktop-win boot smoke resolves the win-unpacked dir and runs packaged-boot.mjs",
    stepSlice.includes("win-unpacked") && stepSlice.includes("node apps/desktop/scripts/packaged-boot.mjs"),
  );
}

// --- P2-207: artifact retention janitor (artifactretention.ts) ----------------

{
  const ROOT = join(tmpdir(), "p2-207-artifacts-root");
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const NOW = 1_800_000_000_000; // arbitrary fixed "now" anchor (pure: no clock reads)

  const sessEntry = (session: string, bytes: number, ageMs: number, name = "report.pdf"): RetentionEntry => ({
    path: join(ROOT, session, name),
    bytes,
    mtime: NOW - ageMs,
  });
  const pathsOf = (plan: { paths: string[] }) => plan.paths.map((p) => p.split("/").slice(-2).join("/"));

  // empty input → empty plan
  check(
    "P2-207: empty entry list yields an empty plan",
    retentionPlan(ROOT, [], NOW).paths.length === 0 && retentionPlan(ROOT, [], NOW).bytes === 0,
  );

  // everything below every ceiling → nothing to do
  {
    const plan = retentionPlan(ROOT, [
      sessEntry("s1", 10, 1 * DAY),
      sessEntry("s2", 20, 5 * DAY),
      sessEntry("s3", 30, 10 * DAY),
      sessEntry("s4", 40, 20 * DAY),
    ], NOW);
    check(
      "P2-207: everything under the ceilings → empty plan",
      plan.paths.length === 0 && plan.bytes === 0,
    );
  }

  // grace period: a freshly written entry never enters the plan, even huge
  {
    const plan = retentionPlan(ROOT, [
      sessEntry("fresh", RETENTION_MAX_TOTAL_BYTES + 1, 1 * HOUR),
      sessEntry("fresh2", RETENTION_MAX_TOTAL_BYTES + 1, 2 * HOUR),
      sessEntry("fresh3", RETENTION_MAX_TOTAL_BYTES + 1, 3 * HOUR),
      sessEntry("old", 100, 40 * DAY),
    ], NOW);
    check(
      "P2-207: entry inside the grace period never enters the plan even with the total blown",
      !plan.paths.includes(join(ROOT, "fresh", "report.pdf")) &&
        !plan.paths.includes(join(ROOT, "fresh2", "report.pdf")) &&
        !plan.paths.includes(join(ROOT, "fresh3", "report.pdf")) &&
        plan.paths.length === 1,
    );
  }

  // the RETENTION_MIN_SESSIONS most recent session dirs survive, always
  {
    const allOld = [
      sessEntry("a", RETENTION_MAX_TOTAL_BYTES, 100 * DAY),
      sessEntry("b", RETENTION_MAX_TOTAL_BYTES, 101 * DAY),
      sessEntry("c", RETENTION_MAX_TOTAL_BYTES, 102 * DAY),
    ];
    const plan = retentionPlan(ROOT, allOld, NOW);
    check(
      "P2-207: the minimum count of most recent sessions survives even when all are old and over every ceiling",
      plan.paths.length === 0 && plan.bytes === 0,
    );
    const plan4 = retentionPlan(ROOT, [sessEntry("d", 5, 103 * DAY), ...allOld], NOW);
    check(
      "P2-207: with four sessions only the oldest one is planned (the newest three are preserved)",
      pathsOf(plan4).join(",") === ["d", "report.pdf"].join("/"),
    );
  }

  // byte ceiling: oldest deleted first until the total fits
  {
    const plan = retentionPlan(ROOT, [
      sessEntry("a", 600_000_000, 6 * DAY),
      sessEntry("b", 600_000_000, 5 * DAY),
      sessEntry("c", 600_000_000, 4 * DAY),
      sessEntry("e", 600_000_000, 2 * DAY + 1),
      sessEntry("f", 600_000_000, 2 * DAY + 1),
      sessEntry("g", 600_000_000, 2 * DAY + 1),
    ], NOW);
    // 3 newest (e,f,g) are preserved; the candidates a..c total 1.8GB: a and b
    // go from the oldest until the surviving total (0.6GB) fits under 1GB
    check(
      "P2-207: byte ceiling deletes from the oldest until the total fits",
      pathsOf(plan).join(",") === ["a", "report.pdf"].join("/") + "," + ["b", "report.pdf"].join("/") &&
        plan.bytes === 1_200_000_000,
    );
  }

  // age ceiling: only what is past the age limit goes
  {
    const plan = retentionPlan(ROOT, [
      sessEntry("young1", 10, 1 * DAY),
      sessEntry("young2", 10, 2 * DAY),
      sessEntry("young3", 10, 2 * DAY),
      sessEntry("m1", 100, 10 * DAY),
      sessEntry("m2", 200, 40 * DAY),
      sessEntry("m3", 400, 60 * DAY),
    ], NOW);
    // plan order is oldest → newest (spec): m3 (60d) before m2 (40d)
    check(
      "P2-207: age ceiling deletes only what passed the max age in days",
      pathsOf(plan).join(",") === ["m3", "report.pdf"].join("/") + "," + ["m2", "report.pdf"].join("/") &&
        plan.bytes === 600,
    );
  }

  // refusals: paths outside the root (including .. traversal) are never planned
  {
    const plan = retentionPlan(ROOT, [
      { path: join(tmpdir(), "elsewhere", "sess", "f.pdf"), bytes: RETENTION_MAX_TOTAL_BYTES * 10, mtime: NOW - 100 * DAY },
      { path: join(ROOT, "..", "uploads", "sess", "f.pdf"), bytes: RETENTION_MAX_TOTAL_BYTES * 10, mtime: NOW - 100 * DAY },
      { path: ROOT, bytes: RETENTION_MAX_TOTAL_BYTES * 10, mtime: NOW - 100 * DAY },
      { path: "", bytes: 1, mtime: NOW - 100 * DAY },
    ], NOW);
    check(
      "P2-207: paths outside the root (other dirs, .. traversal, the root itself, empty) are refused",
      plan.paths.length === 0 && plan.bytes === 0,
    );
  }

  // refusals: invalid segment names (the validSegment rule) are never planned
  {
    const plan = retentionPlan(ROOT, [
      { path: join(ROOT, ".hidden", "f.pdf"), bytes: RETENTION_MAX_TOTAL_BYTES * 10, mtime: NOW - 100 * DAY },
      { path: join(ROOT, "a..b", "f.pdf"), bytes: RETENTION_MAX_TOTAL_BYTES * 10, mtime: NOW - 100 * DAY },
      { path: join(ROOT, "ok sess", "f.pdf"), bytes: RETENTION_MAX_TOTAL_BYTES * 10, mtime: NOW - 100 * DAY },
      { path: join(ROOT, "sess", "sub", "f.pdf").replace("sub", "e..vil"), bytes: 1, mtime: NOW - 100 * DAY },
    ], NOW);
    check(
      "P2-207: invalid segment names (dot-leading, .. inside, spaces) are refused",
      plan.paths.length === 0 && plan.bytes === 0,
    );
  }

  // the documented kill switch: default on, off/0/false disables
  check(
    "P2-207: retention is enabled by default and only off/0/false disables it",
    retentionDisabled({}) === false &&
      retentionDisabled({ [RETENTION_DISABLE_ENV]: "on" }) === false &&
      retentionDisabled({ [RETENTION_DISABLE_ENV]: "off" }) === true &&
      retentionDisabled({ [RETENTION_DISABLE_ENV]: "0" }) === true &&
      retentionDisabled({ [RETENTION_DISABLE_ENV]: "FALSE" }) === true,
  );

  // documented ceilings stay conservative (a drift here is a doc change)
  check(
    "P2-207: documented ceilings are the conservative defaults",
    RETENTION_MAX_AGE_DAYS === 30 &&
      RETENTION_MAX_TOTAL_BYTES === 1_000_000_000 &&
      RETENTION_MIN_SESSIONS === 3 &&
      RETENTION_GRACE_MS === 48 * 3_600_000 &&
      RETENTION_INTERVAL_MS === 6 * 60 * 60_000,
  );

  // real-source assertion: the daemon sweep is called with ONLY the artifacts
  // root — uploads (user-requested downloads), clips and any other state dir
  // must never appear in the call arguments.
  const daemonIndexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const sweepAt = daemonIndexSrc.indexOf("retentionPlan(");
  const sweepCall = sweepAt > -1 ? daemonIndexSrc.slice(sweepAt, sweepAt + 200) : "";
  check(
    "P2-207: the real sweep calls retentionPlan with the artifacts root and nothing else",
    sweepAt > -1 &&
      sweepCall.includes("ARTIFACTS_ROOT") &&
      !sweepCall.includes("uploads") &&
      !sweepCall.includes("UPLOADS") &&
      !sweepCall.includes("clips") &&
      !sweepCall.includes("CLIPS"),
  );
  const scanAt = daemonIndexSrc.indexOf("function scanRetentionEntries");
  const scanBody = scanAt > -1 ? daemonIndexSrc.slice(scanAt, scanAt + 600) : "";
  check(
    "P2-207: the scanner reads only the artifacts root (never uploads/ or clips/)",
    scanBody.includes("readdirSync(ARTIFACTS_ROOT") &&
      !scanBody.includes("uploads") &&
      !scanBody.includes("clips"),
  );
}

// --- P2-228: uploads retention (uploadretention.ts) ---------------------------

{
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const NOW = 1_800_000_000_000; // arbitrary fixed "now" anchor (pure: no clock reads)
  const MB = 1_000_000;

  const file = (name: string, bytes: number, ageMs: number): UploadEntry => ({
    path: join(tmpdir(), "p2-228-uploads", name),
    bytes,
    mtime: NOW - ageMs,
  });
  const namesOf = (plan: { paths: string[] }) => plan.paths.map((p) => p.split("/").pop());

  // empty folder → empty plan
  check(
    "P2-228: empty entry list yields an empty plan",
    uploadRetentionPlan([], NOW).paths.length === 0 && uploadRetentionPlan([], NOW).bytes === 0,
  );

  // roomy recent folder: the 6-day-old candidate is neither past the age
  // ceiling nor part of a byte excess, so nothing is planned
  {
    const plan = uploadRetentionPlan([
      file("d1.pdf", 10, 1 * DAY),
      file("d2.pdf", 10, 2 * DAY),
      file("d3.pdf", 10, 3 * DAY),
      file("d4.pdf", 10, 4 * DAY),
      file("d5.pdf", 10, 5 * DAY),
      file("d6.pdf", 10, 6 * DAY),
    ], NOW);
    check(
      "P2-228: roomy, recent folder yields an empty plan",
      plan.paths.length === 0 && plan.bytes === 0,
    );
  }

  // rule order: grace outranks age — with grace 48 h and max age 24 h, files
  // 30 h and 47 h old are past the age ceiling but still inside the grace
  // period, so only the 100 h-old file is planned
  {
    const plan = uploadRetentionPlan([
      file("fresh3.mp4", 100, 10 * HOUR),
      file("fresh.mp4", 100, 30 * HOUR),
      file("fresh2.mp4", 100, 47 * HOUR),
      file("old.mp4", 100, 100 * HOUR),
    ], NOW, { graceMs: 48 * HOUR, maxAgeMs: 24 * HOUR, maxTotalBytes: 2_000_000_000, minFiles: 1 });
    check(
      "P2-228: file inside the grace period survives even past the max age",
      namesOf(plan).join(",") === "old.mp4" && plan.bytes === 100,
    );
  }

  // age ceiling with the documented defaults: past-age files go oldest-first;
  // a 29-day file is not yet deletable and survives next to the fresh ones
  {
    const plan = uploadRetentionPlan([
      file("p1.pdf", 10, 1 * DAY),
      file("p2.pdf", 10, 2 * DAY),
      file("p3.pdf", 10, 3 * DAY),
      file("p4.pdf", 10, 4 * DAY),
      file("p5.pdf", 10, 5 * DAY),
      file("young.mp4", 10, 29 * DAY),
      file("m1.mp4", 100, 31 * DAY),
      file("m2.mp4", 200, 40 * DAY),
    ], NOW);
    check(
      "P2-228: age ceiling deletes only what passed the max age in days, oldest first",
      namesOf(plan).join(",") === "m2.mp4,m1.mp4" && plan.bytes === 300,
    );
  }

  // byte ceiling with the documented defaults: the five most recent files
  // survive even with the folder above 2 GB; from the deletable pool the
  // oldest goes first, only until the pool fits, and no more than that
  {
    const plan = uploadRetentionPlan([
      file("c3.mp4", 900 * MB, 8 * DAY),
      file("c2.mp4", 900 * MB, 7 * DAY),
      file("c1.mp4", 900 * MB, 6 * DAY),
      file("p5.pdf", 10, 5 * DAY),
      file("p4.pdf", 10, 4 * DAY),
      file("p3.pdf", 10, 3 * DAY),
      file("p2.pdf", 10, 2 * DAY),
      file("p1.pdf", 10, 20 * HOUR),
    ], NOW);
    check(
      "P2-228: byte excess deletes the oldest candidates until the pool fits and the newest N always survive",
      namesOf(plan).join(",") === "c3.mp4" && plan.bytes === 900 * MB,
    );
  }

  // one single giant file is one of the N most recent: it survives even though
  // it alone blows the byte ceiling and the age ceiling
  {
    const plan = uploadRetentionPlan([file("huge.mp4", 3_000_000_000, 40 * DAY)], NOW);
    check(
      "P2-228: a single giant file survives for being one of the N most recent",
      plan.paths.length === 0 && plan.bytes === 0,
    );
  }

  // determinism: two candidates with the exact same mtime are ordered (and
  // deleted) by lexicographic path ascending, regardless of the input order
  {
    const thresholds = { graceMs: 1, maxAgeMs: 100 * DAY, maxTotalBytes: 2_000_000_000, minFiles: 1 };
    const base = (): UploadEntry[] => [
      file("newest.bin", 1, 1 * HOUR),
      file("b.bin", 1_500 * MB, 2 * DAY),
      file("a.bin", 1_500 * MB, 2 * DAY),
    ];
    const plan1 = uploadRetentionPlan(base(), NOW, thresholds);
    const plan2 = uploadRetentionPlan([...base()].reverse(), NOW, thresholds);
    check(
      "P2-228: mtime ties are broken deterministically by path, whichever the input order",
      namesOf(plan1).join(",") === "a.bin" &&
        namesOf(plan2).join(",") === "a.bin" &&
        plan1.bytes === 1_500 * MB,
    );
  }

  // the plan never contains a path that was not received
  {
    const inputs = [
      file("keep.bin", 10, 1 * HOUR),
      file("gone.bin", 2_000_000_000 + 1, 40 * DAY),
      file("gone2.bin", 100, 40 * DAY),
      { path: join(tmpdir(), "elsewhere", "x.mp4"), bytes: 10, mtime: NOW - 40 * DAY },
    ];
    const plan = uploadRetentionPlan(inputs, NOW, { ...UPLOAD_RETENTION_DEFAULTS, minFiles: 1 });
    check(
      "P2-228: no planned path is outside the received list",
      plan.paths.every((p) => inputs.some((e) => e.path === p)) && plan.paths.length === 3,
    );
  }

  // fail-safe: entries the module cannot reason about are never planned
  {
    const plan = uploadRetentionPlan([
      file("r1.bin", 10, 1 * DAY),
      file("r2.bin", 10, 2 * DAY),
      file("r3.bin", 10, 3 * DAY),
      file("r4.bin", 10, 4 * DAY),
      file("r5.bin", 10, 5 * DAY),
      file("ok.bin", 10, 40 * DAY),
      { path: join(tmpdir(), "p2-228-uploads", "nan.bin"), bytes: Number.NaN, mtime: NOW - 40 * DAY },
      { path: join(tmpdir(), "p2-228-uploads", "inf.bin"), bytes: 10, mtime: Number.POSITIVE_INFINITY },
    ], NOW);
    check(
      "P2-228: entries with non-finite bytes or mtime are never planned",
      namesOf(plan).join(",") === "ok.bin",
    );
  }

  // documented thresholds stay conservative (a drift here is a doc change)
  check(
    "P2-228: documented thresholds are the conservative defaults",
    UPLOAD_RETENTION_GRACE_HOURS === 24 &&
      UPLOAD_RETENTION_MAX_AGE_DAYS === 30 &&
      UPLOAD_RETENTION_MAX_TOTAL_BYTES === 2_000_000_000 &&
      UPLOAD_RETENTION_MIN_FILES === 5,
  );

  // parseUploadRetention: empty environment reproduces the documented defaults
  {
    const cfg = parseUploadRetention({});
    check(
      "P2-228: empty environment reproduces the documented defaults",
      !cfg.disabled &&
        cfg.problems.length === 0 &&
        cfg.thresholds.graceMs === UPLOAD_RETENTION_DEFAULTS.graceMs &&
        cfg.thresholds.maxAgeMs === UPLOAD_RETENTION_DEFAULTS.maxAgeMs &&
        cfg.thresholds.maxTotalBytes === UPLOAD_RETENTION_DEFAULTS.maxTotalBytes &&
        cfg.thresholds.minFiles === UPLOAD_RETENTION_DEFAULTS.minFiles,
    );
  }

  // the documented kill switch: default on, off/0/false disables
  check(
    "P2-228: retention is enabled by default and only off/0/false disables it",
    uploadRetentionDisabled({}) === false &&
      uploadRetentionDisabled({ [UPLOAD_RETENTION_DISABLE_ENV]: "on" }) === false &&
      uploadRetentionDisabled({ [UPLOAD_RETENTION_DISABLE_ENV]: "off" }) === true &&
      uploadRetentionDisabled({ [UPLOAD_RETENTION_DISABLE_ENV]: "0" }) === true &&
      uploadRetentionDisabled({ [UPLOAD_RETENTION_DISABLE_ENV]: "FALSE" }) === true,
  );

  // blank values are the only other no-problem case (missing keeps defaults)
  check(
    "P2-228: blank values keep the documented defaults with no problem",
    parseUploadRetention({ OCR_UPLOAD_RETENTION_GRACE_HOURS: "   " }).problems.length === 0 &&
      parseUploadRetention({ OCR_UPLOAD_RETENTION_GRACE_HOURS: "   " }).thresholds.graceMs ===
        UPLOAD_RETENTION_DEFAULTS.graceMs,
  );

  // fail-closed table: each bad shape is a problem, thresholds fall back
  check(
    "P2-228: non-numeric value is a fail-closed problem",
    parseUploadRetention({ OCR_UPLOAD_RETENTION_GRACE_HOURS: "abc" }).problems.length === 1 &&
      parseUploadRetention({ OCR_UPLOAD_RETENTION_GRACE_HOURS: "abc" }).thresholds.graceMs ===
        UPLOAD_RETENTION_DEFAULTS.graceMs,
  );
  check(
    "P2-228: zero, negative, fractional and above-ceiling values are problems",
    parseUploadRetention({ OCR_UPLOAD_RETENTION_MAX_AGE_DAYS: "0" }).problems.length === 1 &&
      parseUploadRetention({ OCR_UPLOAD_RETENTION_MAX_BYTES: "-5" }).problems.length === 1 &&
      parseUploadRetention({ OCR_UPLOAD_RETENTION_MIN_FILES: "1.5" }).problems.length === 1 &&
      parseUploadRetention({ OCR_UPLOAD_RETENTION_MAX_BYTES: String(UPLOAD_RETENTION_MAX_BYTES_CEILING + 1) })
        .problems.length === 1,
  );
  check(
    "P2-228: several bad variables return ALL problems at once (no short-circuit)",
    parseUploadRetention({
      OCR_UPLOAD_RETENTION_GRACE_HOURS: "abc",
      OCR_UPLOAD_RETENTION_MAX_BYTES: "-1",
      OCR_UPLOAD_RETENTION_MIN_FILES: "2.5",
    }).problems.length === 3,
  );
  {
    const cfg = parseUploadRetention({
      OCR_UPLOAD_RETENTION_GRACE_HOURS: "48",
      OCR_UPLOAD_RETENTION_MAX_AGE_DAYS: "60",
      OCR_UPLOAD_RETENTION_MAX_BYTES: "5000000000",
      OCR_UPLOAD_RETENTION_MIN_FILES: "10",
    });
    check(
      "P2-228: valid overrides are honored with no problem",
      cfg.problems.length === 0 &&
        cfg.thresholds.graceMs === 48 * HOUR &&
        cfg.thresholds.maxAgeMs === 60 * DAY &&
        cfg.thresholds.maxTotalBytes === 5_000_000_000 &&
        cfg.thresholds.minFiles === 10,
    );
  }

  // real-source assertions: the sweep rides the EXISTING janitor hook and no
  // new periodic timer exists anywhere in index.ts
  const daemonSrc228 = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const hookAt = daemonSrc228.indexOf("if (artifactsSweepOn || uploadsSweepOn) {");
  const hookEnd = hookAt > -1 ? daemonSrc228.indexOf("}, RETENTION_INTERVAL_MS)", hookAt) : -1;
  const hookBody = hookAt > -1 && hookEnd > -1 ? daemonSrc228.slice(hookAt, hookEnd) : "";
  check(
    "P2-228: the uploads sweep runs on the existing janitor hook with no new periodic timer",
    hookAt > -1 &&
      hookBody.includes("sweepUploadRetention()") &&
      hookBody.includes("setTimeout(sweepUploadRetention, 0)") &&
      (daemonSrc228.match(/setInterval\(/g) ?? []).length === 5,
  );
  const scanUpAt = daemonSrc228.indexOf("function scanUploadEntries");
  const scanUpBody = scanUpAt > -1 ? daemonSrc228.slice(scanUpAt, scanUpAt + 700) : "";
  check(
    "P2-228: the scanner reads only the uploads root (never artifacts, clips, staging, state or audit)",
    scanUpBody.includes("readdirSync(UPLOADS_ROOT") &&
      scanUpBody.includes("isFile") &&
      scanUpBody.includes('startsWith(".")') &&
      !scanUpBody.includes("ARTIFACTS_ROOT") &&
      !scanUpBody.includes("clips") &&
      !scanUpBody.includes("STATE_FILE") &&
      !scanUpBody.includes("audit"),
  );
  const sweepUpAt = daemonSrc228.indexOf("function sweepUploadRetention");
  const sweepUpBody = sweepUpAt > -1 ? daemonSrc228.slice(sweepUpAt, sweepUpAt + 800) : "";
  check(
    "P2-228: the sweep deletes exactly the planned flat files and logs one name-free line",
    sweepUpBody.includes("uploadRetentionPlan(scanUploadEntries()") &&
      sweepUpBody.includes("rmSync(path, { force: true })") &&
      !sweepUpBody.includes("recursive: true") &&
      sweepUpBody.includes("deleted: plan.paths.length, bytes: plan.bytes"),
  );
  check(
    "P2-228: a new additive counter joins the metrics block (existing ones untouched)",
    daemonSrc228.includes('metrics.inc("ocr_upload_retention_deleted_total", plan.paths.length)') &&
      daemonSrc228.includes('metrics.inc("ocr_artifact_retention_deleted_total", plan.paths.length)'),
  );

  // uploadretention.ts stays pure: unit tests must never boot a daemon on
  // import (strip line comments first — the header prose names banned modules)
  const uploadRetentionSrc = readFileSync(
    join(import.meta.dirname, "..", "apps", "daemon", "src", "uploadretention.ts"),
    "utf8",
  );
  const pureCode = uploadRetentionSrc.replace(/\/\/.*$/gm, "");
  check(
    "P2-228: uploadretention.ts is pure (no node:fs/path/child_process/http/os or fetch imports)",
    !/node:(fs|path|child_process|http|os)/.test(pureCode) && !/\bfetch\b/.test(pureCode),
  );
}

// --- P2-209: wake-from-sleep reaction plan (wakeplan.ts) ------------------------

{
  const plan = (over: Partial<WakePlanInput> = {}): WakePlanVerdict =>
    wakePlan({
      eventType: "resume",
      gaveUp: false,
      failures: 0,
      msUntilNextRespawn: null,
      daemonHealthy: false,
      msSinceLastHandled: null,
      ...over,
    });

  // rule 1 — a repeat inside the debounce window is ignored even when the
  // respawn budget is exhausted (the first event already acted)
  check(
    "P2-209: repeat inside the debounce window → ignore even with exhausted budget",
    plan({ msSinceLastHandled: WAKE_DEBOUNCE_MS - 1, gaveUp: true, failures: 5 }).action === "ignore",
  );
  check(
    "P2-209: exactly one ms past the debounce window is a new event again",
    plan({ msSinceLastHandled: WAKE_DEBOUNCE_MS, gaveUp: true }).action === "reset-and-respawn",
  );
  // rule 2 — event types outside the documented vocabulary
  check(
    "P2-209: unknown event type → ignore (suspend/lock-screen/empty)",
    plan({ eventType: "lock-screen" }).action === "ignore" &&
      plan({ eventType: "suspend" }).action === "ignore" &&
      plan({ eventType: "" }).action === "ignore",
  );
  check(
    "P2-209: unknown event type loses even against an exhausted budget",
    plan({ eventType: "on-battery", gaveUp: true }).action === "ignore",
  );
  // rule 3 — a daemon healthy at the last tick only needs confirmation
  check(
    "P2-209: daemon healthy at last tick → probe-now (confirmation only)",
    plan({ daemonHealthy: true }).action === "probe-now",
  );
  check(
    "P2-209: healthy beats an exhausted budget (rule order)",
    plan({ daemonHealthy: true, gaveUp: true, failures: 4, msUntilNextRespawn: 120_000 }).action === "probe-now",
  );
  // rule 4 — exhausted respawn budget
  check(
    "P2-209: exhausted budget → reset-and-respawn",
    plan({ gaveUp: true, failures: 4 }).action === "reset-and-respawn",
  );
  // rule 5 — respawn scheduled farther away than the documented ceiling
  check(
    "P2-209: long wait until the next respawn → reset-and-respawn (anticipate)",
    plan({ failures: 1, msUntilNextRespawn: RESPAWN_WAIT_CEILING_MS + 1 }).action === "reset-and-respawn",
  );
  check(
    "P2-209: a retry minutes away is anticipated too",
    plan({ failures: 2, msUntilNextRespawn: 20 * 60_000 }).action === "reset-and-respawn",
  );
  // rule 6 — everything else probes now
  check(
    "P2-209: short wait until the next respawn → probe-now (backoff covers it)",
    plan({ failures: 1, msUntilNextRespawn: RESPAWN_WAIT_CEILING_MS - 1 }).action === "probe-now",
  );
  check(
    "P2-209: exactly at the ceiling is still a probe-now (only beyond is anticipated)",
    plan({ failures: 1, msUntilNextRespawn: RESPAWN_WAIT_CEILING_MS }).action === "probe-now",
  );
  check(
    "P2-209: default case (unhealthy daemon, nothing pending) → probe-now",
    plan({}).action === "probe-now",
  );
  check(
    "P2-209: unlock-screen is part of the vocabulary and reaches the plan",
    plan({ eventType: "unlock-screen", daemonHealthy: true }).action === "probe-now",
  );
  check(
    "P2-209: isWakeEventType narrows exactly the documented vocabulary",
    WAKE_EVENT_TYPES.length === 2 &&
      isWakeEventType("resume") &&
      isWakeEventType("unlock-screen") &&
      !isWakeEventType("lock-screen") &&
      !isWakeEventType(""),
  );

  // every generated reason: non-empty, no file path, no URL scheme, no secrets
  const verdicts = [
    plan({ msSinceLastHandled: WAKE_DEBOUNCE_MS - 1, gaveUp: true }),
    plan({ eventType: "lock-screen" }),
    plan({ daemonHealthy: true }),
    plan({ gaveUp: true }),
    plan({ msUntilNextRespawn: RESPAWN_WAIT_CEILING_MS + 1, failures: 1 }),
    plan({ msUntilNextRespawn: 1_000, failures: 1 }),
    plan({}),
  ];
  check(
    "P2-209: every reason is non-empty, path-free and scheme-free",
    verdicts.every(
      (v) =>
        v.reason.length > 0 &&
        !v.reason.includes("/") &&
        !v.reason.includes("\\") &&
        !v.reason.includes("http:") &&
        !v.reason.includes("https:") &&
        !v.reason.includes("file:") &&
        !v.reason.includes(":~"),
    ),
  );

  // real-source assertions over the REAL main.ts
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  check(
    "P2-209: the real main.ts registers the OS wake events through wakePlan",
    mainSrc.includes("powerMonitor.on(") &&
      mainSrc.includes("WAKE_EVENT_TYPES") &&
      /wakePlan\(\{[\s\S]*?gaveUp: isDaemonDown\(\)/.test(mainSrc),
  );
  check(
    "P2-209: the registration is availability-guarded so signal-less platforms keep today's behavior",
    /typeof powerMonitor\?\.on !== "function"/.test(mainSrc),
  );
  const wakeAt = mainSrc.indexOf("// --- wake-from-sleep reaction");
  const wakeBlock = wakeAt >= 0 ? mainSrc.slice(wakeAt, mainSrc.indexOf("function appIcon", wakeAt)) : "";
  check(
    "P2-209: the wake block found in the real main.ts",
    wakeBlock.includes("function handleWakeEvent") && wakeBlock.includes("function registerWakeReaction"),
  );
  check(
    "P2-209: the wake reaction introduces no new periodic interval and no timer",
    !wakeBlock.includes("setInterval") && !wakeBlock.includes("setTimeout"),
  );
  check(
    "P2-209: the wake reaction only reuses existing paths (pairing probe + restart)",
    wakeBlock.includes("void refreshPairingState()") &&
      wakeBlock.includes("restartDaemon()") &&
      !wakeBlock.includes("fetch(") &&
      !wakeBlock.includes("healthOnce"),
  );
  const ignoreAt = mainSrc.indexOf('plan.action === "ignore"');
  const ignoreEnd = ignoreAt >= 0 ? mainSrc.indexOf("return;", ignoreAt) + "return;".length : -1;
  const ignoreBranch = ignoreAt >= 0 && ignoreEnd > ignoreAt ? mainSrc.slice(ignoreAt, ignoreEnd) : "";
  check(
    "P2-209: events dropped by the debounce write no log line",
    ignoreBranch.length > 0 && !ignoreBranch.includes("log(") && !ignoreBranch.includes("logError("),
  );

  // additive diagnostic in the REAL daemon.ts (backoff untouched)
  const daemonSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "daemon.ts"), "utf8");
  check(
    "P2-209: daemon.ts exports the additive ms-until-next-respawn diagnostic",
    daemonSrc.includes("export function nextRespawnInMs"),
  );
  check(
    "P2-209: the respawn schedule and attempt ceiling are untouched",
    daemonSrc.includes('?? "5000,15000,45000"') && daemonSrc.includes("RESPAWN_MAX_ATTEMPTS = 3"),
  );
}

// --- P2-211: install-location verdict (installloc.ts) + wiring -----------------

{
  // full truth table, rules applied in the documented order
  const v = (platform: string, path: string, inApps: boolean | null, packaged: boolean) =>
    installVerdict(platform, path, inApps, packaged);

  // 1. dev build always ok — even under a mounted volume
  check(
    "P2-211: dev build → ok even under a mounted volume",
    v("darwin", "/Volumes/Setup/App.app/Contents/MacOS/App", false, false).state === "ok",
  );
  // 2. non-macOS always ok (this task covers macOS only, documented in-module)
  check("P2-211: Windows packaged → ok", v("win32", "C:\\Users\\u\\Downloads\\App.exe", false, true).state === "ok");
  // 3. path under the volume mount point → dmg-volume
  check(
    "P2-211: path under the volume mount point → dmg-volume",
    v("darwin", "/Volumes/MeuDisco/App.app/Contents/MacOS/App", false, true).state === "dmg-volume",
  );
  // 4. quarantine translocation segment → translocated, beating the signal
  check(
    "P2-211: AppTranslocation segment → translocated (beats the apps-folder signal)",
    v("darwin", "/private/var/folders/x/T/AppTranslocation/abc/d/App.app/Contents/MacOS/App", false, true).state ===
      "translocated",
  );
  // 5. downloads ancestor with a false signal → downloads
  check(
    "P2-211: downloads ancestor + false apps-folder signal → downloads",
    v("darwin", "/Users/u/Downloads/App.app/Contents/MacOS/App", false, true).state === "downloads",
  );
  // 6. null signal → unknown; false signal with no other evidence → unknown too
  const unk = v("darwin", "/Applications/App.app/Contents/MacOS/App", null, true);
  check("P2-211: null apps-folder signal → unknown", unk.state === "unknown");
  check(
    "P2-211: false signal with no other evidence → unknown too",
    v("darwin", "/Applications/App.app/Contents/MacOS/App", false, true).state === "unknown",
  );
  // 7. true signal → ok
  check(
    "P2-211: true apps-folder signal → ok",
    v("darwin", "/Applications/App.app/Contents/MacOS/App", true, true).state === "ok",
  );
  check(
    "P2-211: the neutral unknown wording never accuses failure",
    !/falha|erro|quebrad|inválid/i.test(unk.message),
  );

  // every generated message: non-empty, no file path, no URL scheme
  const verdicts = [
    installVerdict("darwin", "/Volumes/D/App.app/x", false, true),
    installVerdict("darwin", "/private/var/folders/T/AppTranslocation/g/d/App.app/x", false, true),
    installVerdict("darwin", "/Users/u/Downloads/App.app/x", false, true),
    unk,
    installVerdict("darwin", "/Applications/App.app/x", true, true),
    installVerdict("darwin", "/Applications/App.app/x", false, false),
    installVerdict("win32", "C:\\x\\App.exe", false, true),
  ];
  check(
    "P2-211: every message is non-empty, path-free and scheme-free",
    verdicts.every(
      (x) =>
        x.message.length > 0 &&
        !x.message.includes("/") &&
        !x.message.includes("\\") &&
        !x.message.includes("http:") &&
        !x.message.includes("https:") &&
        !x.message.includes("file:"),
    ),
  );
  check(
    "P2-211: installMessage replays the same copy installVerdict ships",
    installMessage("dmg-volume") === installVerdict("darwin", "/Volumes/D/App.app/x", false, true).message,
  );

  // real-source assertions over the REAL main.ts
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  check(
    "P2-211: the verdict is computed exactly once (single installVerdict call site) in the real main.ts",
    (mainSrc.match(/installVerdict\(/g) ?? []).length === 1,
  );
  check(
    "P2-211: the verdict is computed at boot, before the first update check",
    mainSrc.indexOf("bootInstallLocation = ") < mainSrc.indexOf('runUpdateCheck("boot")'),
  );
  const bootAt = mainSrc.indexOf("bootInstallLocation = ");
  const bootBlock = bootAt >= 0 ? mainSrc.slice(bootAt, mainSrc.indexOf("log(`[desktop] install location:", bootAt)) : "";
  check(
    "P2-211: the boot computation introduces no timer and no request",
    bootBlock.length > 0 &&
      !bootBlock.includes("setInterval") &&
      !bootBlock.includes("setTimeout") &&
      !bootBlock.includes("fetch("),
  );
  check(
    "P2-211: the applications-folder signal is availability-guarded so signal-less platforms keep today's behavior",
    /typeof app\.isInApplicationsFolder === "function"/.test(mainSrc),
  );
  check(
    "P2-211: the documented test hatch forces dmg-volume",
    mainSrc.includes('process.env.OCR_DESKTOP_FORCE_DMG_VOLUME === "1"'),
  );
  check(
    "P2-211: the additive installLocation field rides AFTER relayLink in the pairing payload",
    (() => {
      const at = mainSrc.indexOf("setPairingState({");
      const pay = mainSrc.slice(at, mainSrc.indexOf("});", at));
      return pay.indexOf("installLocation: bootInstallLocation") > pay.indexOf("relayLink,");
    })(),
  );

  // real-source assertions over the REAL update.ts: the consent dialog is only
  // reachable after the verdict consultation
  const updateSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "update.ts"), "utf8");
  const offerAt = updateSrc.indexOf("async function offerInstall");
  const offerBlock = offerAt >= 0 ? updateSrc.slice(offerAt, updateSrc.indexOf("async", offerAt + 10)) : "";
  check(
    "P2-211: offerInstall consults the verdict before the consent dialog is reachable",
    offerBlock.includes("installBlocksUpdate(hooks.installLocation)") &&
      offerBlock.indexOf("installBlocksUpdate(hooks.installLocation)") < offerBlock.indexOf("askInstall"),
  );
  check(
    "P2-211: the skipped offer logs ONE line carrying the state and the verdict phrase",
    offerBlock.includes("hooks.log(`update install not offered (${verdict.state}): ${verdict.message}`)"),
  );
  check(
    "P2-211: the block is fail-open — only dmg-volume/translocated ever block",
    !installBlocksUpdate(null) &&
      !installBlocksUpdate(undefined) &&
      !installBlocksUpdate({ state: "unknown", message: "x" }) &&
      !installBlocksUpdate({ state: "ok", message: "x" }) &&
      !installBlocksUpdate({ state: "downloads", message: "x" }) &&
      installBlocksUpdate({ state: "dmg-volume", message: "x" }) &&
      installBlocksUpdate({ state: "translocated", message: "x" }),
  );

  // overlay renders the calm line below the relay-link line, never hides the QR
  const overlaySrc = readFileSync(
    join(import.meta.dirname, "..", "apps", "web", "src", "components", "PairingOverlay.tsx"),
    "utf8",
  );
  check(
    "P2-211: the overlay renders the install line below the relay-link line",
    overlaySrc.indexOf("{installLocation &&") > overlaySrc.indexOf("{relayLink && ("),
  );
  check(
    "P2-211: ok and unknown render nothing; the comment states the QR is NEVER hidden",
    overlaySrc.includes('installLocation.state !== "ok"') &&
      overlaySrc.includes('installLocation.state !== "unknown"') &&
      overlaySrc.includes("NEVER hidden"),
  );

  // diagnostics: one additive line, state only, never the path
  const diagSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "diagnostics.ts"), "utf8");
  check(
    "P2-211: the diagnostics bundle gains exactly one install-location line carrying the state only",
    (diagSrc.match(/install location:/g) ?? []).length === 1 && diagSrc.includes('d.installLocation ?? "unknown"'),
  );
}

// --- P2-214: clock-skew verdict (clockskew.ts) + wiring ------------------------

{
  // Known HTTP-date reference: 2026-01-01T12:00:00Z
  const header = "Thu, 01 Jan 2026 12:00:00 GMT";
  const headerMs = 1_767_268_800_000;

  // 1. clock equal to the server's → ok (offset 0)
  const equal = skewVerdict(headerMs, header, 0);
  check("P2-214: clock equal to the server's → ok", equal.state === "ok" && equal.skewMs === 0);
  // 2. skew below the threshold → ok
  check(
    "P2-214: skew below the threshold → ok",
    skewVerdict(headerMs + 60_000, header, 0).state === "ok",
  );
  // 3. positive skew above the threshold → ahead
  const ahead = skewVerdict(headerMs + 600_000, header, 0);
  check("P2-214: positive skew above the threshold → ahead", ahead.state === "ahead" && ahead.skewMs === 600_000);
  // 4. negative skew above the threshold → behind
  const behind = skewVerdict(headerMs - 600_000, header, 0);
  check("P2-214: negative skew above the threshold → behind", behind.state === "behind" && behind.skewMs === -600_000);
  // 5. skew slightly above the threshold with a slow probe → still ok (the
  //    latency tolerance is the base plus half the elapsed ms)
  check(
    "P2-214: a slow probe widens the tolerance — slightly-above-threshold skew stays ok",
    skewVerdict(headerMs + 120_500, header, 2_000).state === "ok" && 2_000 / 2 + CLOCK_SKEW_TOLERANCE_MS === 121_000,
  );
  // 6/7/8. missing, empty and non-date headers → unknown
  const unk = skewVerdict(headerMs, null, 0);
  check("P2-214: missing header → unknown", unk.state === "unknown" && unk.skewMs === null);
  check("P2-214: empty header → unknown", skewVerdict(headerMs, "   ", 0).state === "unknown");
  const junk = skewVerdict(headerMs, "not-a-date", 0);
  check("P2-214: unparseable header text → unknown", junk.state === "unknown");
  // 9. a valid HTTP-date header is interpreted at its exact instant
  //    (2025-01-15T09:30:00Z = 1736933400000; local 500ms behind → skew -500)
  const validDate = skewVerdict(1_736_933_399_500, "Wed, 15 Jan 2025 09:30:00 GMT", 0);
  check(
    "P2-214: a valid HTTP-date header is interpreted correctly",
    validDate.state === "ok" && validDate.skewMs === -500,
  );
  // the neutral unknown wording never accuses failure
  check(
    "P2-214: the neutral unknown wording never accuses failure",
    !/falha|erro|quebrad|inválid/i.test(unk.message),
  );

  // every generated message: non-empty, no file path, no URL scheme
  const verdicts = [equal, ahead, behind, unk, junk, skewVerdict(headerMs + 60_000, header, 0)];
  check(
    "P2-214: every message is non-empty, path-free and scheme-free",
    verdicts.every(
      (v) =>
        v.message.length > 0 &&
        !v.message.includes("/") &&
        !v.message.includes("\\") &&
        !v.message.includes("http:") &&
        !v.message.includes("https:") &&
        !v.message.includes("file:"),
    ),
  );
  check(
    "P2-214: clockSkewMessage replays the same copy skewVerdict ships",
    clockSkewMessage("ahead") === ahead.message && clockSkewMessage("behind") === behind.message,
  );

  // real-source assertions over the REAL main.ts
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  check(
    "P2-214: exactly ONE reach probe per tick in the real main.ts",
    (mainSrc.match(/await probeWebAppReach\(/g) ?? []).length === 1,
  );
  const guardAt = mainSrc.search(/if \(!quietLocal && \(!paired \|\| remotePairingRequested\) && webAppRes\.problems\.length === 0 && webAppRes\.url !== ""\) \{/);
  const guardBlock = guardAt > -1 ? mainSrc.slice(guardAt, guardAt + 900) : "";
  check(
    "P2-214: the clock verdict is computed under the same overlay guard as the reach probe",
    guardBlock.includes("await probeWebAppReach(webAppRes.url)") && guardBlock.includes("skewVerdict("),
  );
  check(
    "P2-214: the clock verdict introduces no new request — it reuses the probe's own answer",
    guardBlock.length > 0 && !guardBlock.includes("fetch(") && !guardBlock.includes("new URL("),
  );
  const probeBodyAt = mainSrc.indexOf("async function probeWebAppReach(");
  const probeBody =
    probeBodyAt > -1
      ? mainSrc.slice(probeBodyAt, mainSrc.indexOf("async function refreshPairingState", probeBodyAt))
      : "";
  check(
    "P2-214: the probe still makes exactly one request (no second fetch for the clock)",
    (probeBody.match(/fetch\(/g) ?? []).length === 1,
  );
  const setPairingAt = mainSrc.indexOf("setPairingState({");
  const payload = mainSrc.slice(setPairingAt, mainSrc.indexOf("});", setPairingAt));
  check(
    "P2-214: the additive clock field rides AFTER installLocation in the pairing payload",
    payload.indexOf("installLocation: bootInstallLocation") > -1 && payload.indexOf("clock: clock") > payload.indexOf("installLocation: bootInstallLocation"),
  );
  check(
    "P2-214: the documented test hatch forces behind",
    mainSrc.includes('process.env.OCR_DESKTOP_FORCE_CLOCK_BEHIND === "1"') && mainSrc.includes('clockSkewMessage("behind")'),
  );
  check(
    "P2-214: the diagnostics bundle is fed from the last clock verdict",
    mainSrc.includes("clockSkew: lastClockSkew"),
  );

  // overlay renders the calm line below the install-location line, never hides the QR
  const overlaySrc = readFileSync(
    join(import.meta.dirname, "..", "apps", "web", "src", "components", "PairingOverlay.tsx"),
    "utf8",
  );
  check(
    "P2-214: the overlay renders the clock line below the install-location line",
    overlaySrc.indexOf("{clock &&") > overlaySrc.indexOf("{installLocation &&"),
  );
  check(
    "P2-214: ok and unknown render nothing; the comment states the QR is NEVER hidden",
    overlaySrc.includes('clock.state !== "ok"') &&
      overlaySrc.includes('clock.state !== "unknown"') &&
      overlaySrc.includes("NEVER hidden"),
  );

  // diagnostics: one additive line, state + rounded seconds, never the machine time
  const diagSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "diagnostics.ts"), "utf8");
  check(
    "P2-214: the diagnostics bundle gains exactly one clock-skew line (state + seconds only)",
    (diagSrc.match(/clock skew:/g) ?? []).length === 1 &&
      diagSrc.includes("d.clockSkew?.state") &&
      diagSrc.includes("d.clockSkew?.skewSeconds") &&
      !diagSrc.includes("toLocaleTimeString") &&
      !diagSrc.includes("new Date("),
  );
}

// --- P2-218: login-item auto-enable (loginitem.ts + startupstore.ts) + wiring --

{
  // full truth table, rules applied in the documented order
  const plan = (packaged: boolean, platform: string, alreadyEnabled: boolean, ownerDecided: boolean) =>
    loginItemPlan({ packaged, platform, alreadyEnabled, ownerDecided });

  // 1. dev build always leaves the OS setting alone — even with no decision
  check(
    "P2-218: dev build → leave even with no recorded decision",
    plan(false, "darwin", false, false).action === "leave",
  );
  // 2. platform outside macOS/Windows → leave (the API is a no-op there)
  check("P2-218: platform outside macOS/Windows → leave", plan(true, "linux", false, false).action === "leave");
  // 3. recorded decision wins in BOTH directions — off stays off forever
  check(
    "P2-218: recorded decision with the toggle OFF → leave (the owner's choice is never reverted)",
    plan(true, "darwin", false, true).action === "leave",
  );
  check(
    "P2-218: recorded decision with the toggle ON → leave",
    plan(true, "darwin", true, true).action === "leave",
  );
  // 4. already enabled without a decision → nothing to do
  check("P2-218: already enabled with no decision → leave", plan(true, "darwin", true, false).action === "leave");
  // 5. first packaged boot without a decision → enable (the whole point)
  check(
    "P2-218: first packaged macOS boot without a decision → enable",
    plan(true, "darwin", false, false).action === "enable",
  );
  check(
    "P2-218: first packaged Windows boot without a decision → enable",
    plan(true, "win32", false, false).action === "enable",
  );

  // every generated reason: non-empty, no file path, no URL scheme, no secret
  const verdicts = [
    plan(false, "darwin", false, false),
    plan(true, "linux", false, false),
    plan(true, "darwin", false, true),
    plan(true, "darwin", true, true),
    plan(true, "darwin", true, false),
    plan(true, "darwin", false, false),
    plan(true, "win32", false, false),
  ];
  const clean = (s: string): boolean =>
    s.length > 0 &&
    !s.includes("/") &&
    !s.includes("\\") &&
    !s.includes("http:") &&
    !s.includes("https:") &&
    !s.includes("file:") &&
    !s.includes("Users") &&
    !s.includes("~");
  check(
    "P2-218: every reason is non-empty, path-free and scheme-free",
    verdicts.every((v) => clean(v.reason)),
  );
  check(
    "P2-218: the overlay copy is non-empty, path-free and scheme-free for both actions",
    clean(loginItemMessage("enable")) && clean(loginItemMessage("leave")),
  );

  // --- store table (startupstore.ts): tolerant read, atomic private write ----
  const dir = mkdtempSync(join(tmpdir(), "startupstore-"));
  const file = join(dir, "startup.json");
  check("P2-218: missing file → not decided", readStartupDecided(file) === false);
  writeFileSync(file, "{not json at all", { mode: 0o600 });
  check("P2-218: corrupted JSON → not decided (never an exception)", readStartupDecided(file) === false);
  writeFileSync(file, '{"decided":"sim"}', { mode: 0o600 });
  check("P2-218: wrong field type → not decided", readStartupDecided(file) === false);
  check(
    "P2-218: write → read round-trip records the owner decision",
    writeStartupDecided(file, true) === true && readStartupDecided(file) === true,
  );
  check("P2-218: the decision file is private (0600)", (statSync(file).mode & 0o777) === 0o600);
  check("P2-218: the store names the file startup.json under userData", startupSettingFile("/d").endsWith("startup.json"));
  rmSync(dir, { recursive: true, force: true });

  // --- real-source assertions over the REAL main.ts --------------------------
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  check(
    "P2-218: the plan is consulted exactly once in the real main.ts",
    (mainSrc.match(/loginItemPlan\(/g) ?? []).length === 1,
  );
  check(
    "P2-218: the plan is consulted at boot, before the first update check",
    mainSrc.indexOf("bootStartup = ") < mainSrc.indexOf('runUpdateCheck("boot")'),
  );
  const bootAt = mainSrc.indexOf("bootStartup = ");
  const bootBlock = bootAt >= 0 ? mainSrc.slice(bootAt, mainSrc.indexOf('runUpdateCheck("boot")')) : "";
  check(
    "P2-218: the boot consultation introduces no new timer and no new request",
    bootBlock.length > 0 && !bootBlock.includes("setInterval(") && !bootBlock.includes("fetch("),
  );
  check(
    "P2-218: app.setLoginItemSettings has exactly ONE caller — the shared helper",
    (mainSrc.match(/app\.setLoginItemSettings\(/g) ?? []).length === 1,
  );
  const helperAt = mainSrc.indexOf("function setLoginItemEnabled");
  const helperBlock = helperAt >= 0 ? mainSrc.slice(helperAt, helperAt + 500) : "";
  check(
    "P2-218: the shared helper records the owner decision",
    helperBlock.includes("writeStartupDecided("),
  );
  const trayAt = mainSrc.indexOf("function trayMenuItems");
  const trayBlock = trayAt >= 0 ? mainSrc.slice(trayAt, mainSrc.indexOf("return items;", trayAt)) : "";
  check(
    "P2-218: the tray click goes through the helper — turning it off is definitive",
    trayBlock.includes("click: (item) => setLoginItemEnabled(item.checked)") && !trayBlock.includes("setLoginItemSettings"),
  );
  check(
    "P2-218: no new periodic timer was introduced",
    (mainSrc.match(/setInterval\(/g) ?? []).length === 2,
  );
  const setPairingAt = mainSrc.indexOf("setPairingState({");
  const payload = mainSrc.slice(setPairingAt, mainSrc.indexOf("});", setPairingAt));
  check(
    "P2-218: the additive startup field rides AFTER clock in the pairing payload",
    payload.indexOf("clock: clock") > -1 && payload.indexOf("startup:") > payload.indexOf("clock: clock"),
  );
  const hatchAt = mainSrc.indexOf('process.env.OCR_DESKTOP_FORCE_LOGIN_ITEM === "1"');
  const guardedAt = mainSrc.indexOf('bootStartup.action === "enable" && process.env.OCR_DESKTOP_FORCE_LOGIN_ITEM !== "1"');
  check(
    "P2-218: the documented test hatch exists and the enable call is guarded against it (the dev machine is never touched)",
    hatchAt > -1 && guardedAt > hatchAt,
  );

  // overlay renders the calm announce below the clock line, never hides the QR
  const overlaySrc = readFileSync(
    join(import.meta.dirname, "..", "apps", "web", "src", "components", "PairingOverlay.tsx"),
    "utf8",
  );
  check(
    "P2-218: the overlay renders the startup line below the clock line",
    overlaySrc.indexOf("{startup &&") > overlaySrc.indexOf("{clock &&"),
  );
  check(
    "P2-218: only the enable state renders; the comment states the QR is NEVER hidden",
    overlaySrc.includes('startup.state === "enable"') && overlaySrc.includes("NEVER hidden"),
  );

  // diagnostics: one additive line, state + reason only, never the path
  const diagSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "diagnostics.ts"), "utf8");
  check(
    "P2-218: the diagnostics bundle gains exactly one login-item line (state + reason only)",
    (diagSrc.match(/login item:/g) ?? []).length === 1 && diagSrc.includes("d.startup?.state") && diagSrc.includes("d.startup?.reason"),
  );
}

// --- P2-216: release-notes — the download guide a stage-5 user can follow ----
{
  const TAG = "v0.3.0";
  const DMG_ARM = "OpenCode Remote-0.3.0-arm64.dmg";
  const DMG_X64 = "OpenCode Remote-0.3.0-x64.dmg";
  const EXE = "OpenCode Remote Setup 0.3.0.exe";
  const complete = [
    DMG_ARM,
    DMG_X64,
    "OpenCode Remote-0.3.0-arm64.zip",
    "OpenCode Remote-0.3.0-x64.zip",
    EXE,
    "latest-mac.yml",
    "update-mac.json",
    "update-mac-arm64.json",
    "update-mac-x64.json",
    "latest.yml",
    "checksums.txt",
  ];

  const ok = downloadGuide(TAG, complete);
  check(
    "P2-216: complete release → zero problems",
    ok.problems.length === 0,
    JSON.stringify(ok.problems),
  );
  check(
    "P2-216: guide carries one line per audience with the exact file name from the list",
    ok.guide.includes("**Mac com Apple Silicon:**") &&
      ok.guide.includes(`\`${DMG_ARM}\``) &&
      ok.guide.includes("**Mac com Intel:**") &&
      ok.guide.includes(`\`${DMG_X64}\``) &&
      ok.guide.includes("**Windows:**") &&
      ok.guide.includes(`\`${EXE}\``),
    ok.guide,
  );
  check(
    "P2-216: guide explains the first-open warning and the checksums.txt check",
    ok.guide.includes("Primeira abertura no macOS") && ok.guide.includes("checksums.txt"),
    ok.guide,
  );

  // Never an invented name: every backticked installer token in the guide must
  // be a name the caller handed in.
  const downloadNames = [...ok.guide.matchAll(/`([^`]+\.(?:dmg|zip|exe))`/g)].map((m) => m[1]!);
  check(
    "P2-216: no file name appears in the guide without being in the received list",
    downloadNames.length === 3 && downloadNames.every((name) => complete.includes(name)),
    JSON.stringify(downloadNames),
  );

  const noIntel = downloadGuide(TAG, complete.filter((n) => n !== DMG_X64));
  check(
    "P2-216: missing Intel DMG → problem naming the Intel audience, no invented name in the guide",
    noIntel.problems.length === 1 &&
      noIntel.problems[0]!.includes("Mac com Intel") &&
      !noIntel.guide.includes(DMG_X64) &&
      noIntel.guide.includes(DMG_ARM),
    JSON.stringify(noIntel.problems),
  );

  const noArm = downloadGuide(TAG, complete.filter((n) => n !== DMG_ARM));
  check(
    "P2-216: missing Apple Silicon DMG → problem",
    noArm.problems.length === 1 && noArm.problems[0]!.includes("Mac com Apple Silicon"),
    JSON.stringify(noArm.problems),
  );

  const noExe = downloadGuide(TAG, complete.filter((n) => n !== EXE));
  check(
    "P2-216: missing Windows installer → problem",
    noExe.problems.length === 1 && noExe.problems[0]!.includes("Windows"),
    JSON.stringify(noExe.problems),
  );

  const noChecksums = downloadGuide(TAG, complete.filter((n) => n !== "checksums.txt"));
  check(
    "P2-216: missing checksums.txt → problem and the guide stops announcing it",
    noChecksums.problems.length === 1 &&
      noChecksums.problems[0]!.includes("checksums.txt") &&
      !noChecksums.guide.includes("Conferindo o download"),
    JSON.stringify(noChecksums.problems),
  );

  const several = downloadGuide(TAG, complete.filter((n) => n !== DMG_X64 && n !== EXE && n !== "checksums.txt"));
  check(
    "P2-216: several problems returned at once (no short-circuit)",
    several.problems.length === 3 &&
      several.problems.some((p) => p.includes("Mac com Intel")) &&
      several.problems.some((p) => p.includes("Windows")) &&
      several.problems.some((p) => p.includes("checksums.txt")),
    JSON.stringify(several.problems),
  );

  const empty = downloadGuide(TAG, []);
  check(
    "P2-216: empty asset list → empty-list problem plus one per audience and checksums, all at once",
    empty.problems.length === 5 && empty.problems[0]!.includes("asset list is empty"),
    JSON.stringify(empty.problems),
  );

  const badTag = downloadGuide("0.3", complete);
  check(
    "P2-216: invalid tag → problem in the release-assets format (audience slots match nothing)",
    badTag.problems.length === 4 &&
      badTag.problems[0]!.includes("is not a semver version"),
    JSON.stringify(badTag.problems),
  );

  // --- applyGuide: insert above / replace in place, byte-preserving -----------
  const body = "## What's Changed\n\n* pilot(P2-215): clock skew (#488)\n";
  const once = applyGuide(body, ok.guide);
  check(
    "P2-216: body without the block → guide above the original text, preserved byte-by-byte",
    once.startsWith(`${GUIDE_START}\n${ok.guide}\n${GUIDE_END}\n\n`) &&
      once.endsWith(body) &&
      once.indexOf(GUIDE_END) < once.indexOf("## What's Changed"),
    once,
  );

  const oldBlock = `${GUIDE_START}\nguia antigo\n${GUIDE_END}\n\n${body}`;
  const replaced = applyGuide(oldBlock, ok.guide);
  check(
    "P2-216: body with an old block → only the block is replaced, surroundings intact",
    replaced === `${GUIDE_START}\n${ok.guide}\n${GUIDE_END}\n\n${body}` && replaced.includes("What's Changed"),
    replaced,
  );

  check(
    "P2-216: applying twice in a row yields identical text (idempotent)",
    applyGuide(once, ok.guide) === once && applyGuide(replaced, ok.guide) === replaced,
  );

  // --- CLI: reads tag/assets/body from files, rewrites the body on success ----
  const repoRoot = join(import.meta.dirname, "..");
  const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(repoRoot, "scripts", "release-notes.ts");
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  const assetsPath = join(dir, "assets.txt");
  const bodyPath = join(dir, "body.md");
  const runCli = (): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [tsxEntry, script, TAG, assetsPath, bodyPath], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  writeFileSync(assetsPath, `${complete.join("\n")}\n`);
  writeFileSync(bodyPath, body);
  const cliOk = runCli();
  const rewritten = readFileSync(bodyPath, "utf8");
  check(
    "P2-216: cli exits 0 on a complete release and rewrites the body file with the guide applied",
    cliOk.code === 0 &&
      cliOk.out.includes(`release-notes: OK ${TAG}`) &&
      rewritten === once,
    cliOk.out,
  );
  writeFileSync(assetsPath, `${DMG_ARM}\n`);
  const cliFail = runCli();
  check(
    "P2-216: cli exits 1 printing every problem at once and leaves the body untouched",
    cliFail.code === 1 &&
      cliFail.out.includes(`release-notes: FAIL ${TAG}`) &&
      (cliFail.out.match(/  - missing: /g) ?? []).length === 3 &&
      cliFail.out.includes("3 problem(s) found") &&
      readFileSync(bodyPath, "utf8") === rewritten,
    cliFail.out,
  );
  rmSync(dir, { recursive: true, force: true });

  // --- real-repo assertion: the guide step exists in release-publish, after
  // the checksum upload and before the publish step, with shell: bash ---------
  const release = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const pubAt = release.indexOf("\n  release-publish:");
  const publishJob = pubAt === -1 ? "" : release.slice(pubAt);
  const stepName = "- name: Write the download guide into the release body";
  const stepAt = publishJob.indexOf(stepName);
  const stepBlock = stepAt === -1 ? "" : publishJob.slice(stepAt, publishJob.indexOf("\n      - name:", stepAt));
  const checksumUploadAt = publishJob.indexOf('checksums.txt --clobber');
  const publishStepAt = publishJob.indexOf("scripts/release-publish.ts");
  check(
    "P2-216: release.yml runs the guide step in release-publish, after the checksum upload and before the publish step",
    stepAt > -1 &&
      checksumUploadAt > -1 &&
      publishStepAt > -1 &&
      checksumUploadAt < stepAt &&
      stepAt < publishStepAt,
    `checksum=${checksumUploadAt} guide=${stepAt} publish=${publishStepAt}`,
  );
  check(
    "P2-216: the guide step declares shell: bash and drives scripts/release-notes.ts with gh-provided assets + body",
    stepBlock.includes("shell: bash") &&
      stepBlock.includes("scripts/release-notes.ts") &&
      stepBlock.includes("gh release view") &&
      stepBlock.includes("--json assets") &&
      stepBlock.includes("--json body") &&
      stepBlock.includes("--notes-file"),
    stepBlock,
  );
}

// --- P2-219: real-repo assertion — ci.yml exercises the Windows dir pack ------

{
  const ci = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const winStart = ci.indexOf("\n  desktop-package-win:");
  const win = winStart > -1 ? ci.slice(winStart) : "";
  const macStart = ci.indexOf("\n  desktop-package:");
  const macEnd = winStart > macStart ? winStart : ci.length;
  const mac = macStart > -1 ? ci.slice(macStart, macEnd) : "";
  // Steps are indented with 6 spaces; slice per step for per-step invariants.
  const winSteps = win.split("\n      - name:");

  check("P2-219: ci.yml has the desktop-package-win job on windows-latest", winStart > -1 && win.includes("runs-on: windows-latest"));
  check(
    "P2-219: desktop-package-win needs scope and uses the same desktop indicator as the mac job",
    win.includes("needs: scope") &&
      win.includes("if: needs.scope.outputs.desktop == 'true'") &&
      mac.includes("if: needs.scope.outputs.desktop == 'true'"),
  );
  check(
    "P2-219: checkout, node 22 and npm ci mirror the mac desktop-package job",
    ["actions/checkout@v4", "node-version: 22", "cache: npm", "run: npm ci"].every((needle) => win.includes(needle) && mac.includes(needle)),
  );
  const pkgAt = win.indexOf("Package Windows bundle");
  const pkgStep = pkgAt > -1 ? win.slice(pkgAt, win.indexOf("\n      - name:", pkgAt)) : "";
  check(
    "P2-219: the packaging step requests the Windows dir target, never the NSIS installer",
    pkgAt > -1 &&
      pkgStep.includes("npm run dist --workspace @ocr/desktop -- --win --dir") &&
      !pkgStep.toLowerCase().includes("nsis") &&
      pkgStep.includes("CSC_IDENTITY_AUTO_DISCOVERY: false"),
    pkgStep,
  );
  const smokeAt = win.indexOf("dist:smoke --workspace @ocr/desktop -- --no-installer");
  check(
    "P2-219: the deterministic bundle smoke runs after packaging with installer checks skipped",
    pkgAt > -1 && smokeAt > pkgAt,
  );
  check(
    "P2-219: no step of the new job uploads artifacts or publishes anything",
    !win.includes("actions/upload-artifact") &&
      !win.includes("gh release") &&
      !win.includes("upload-artifact:") &&
      !win.includes("ghr"),
  );
  check(
    "P2-219: every run step of the new job declares shell: bash (P2-126 lesson)",
    winSteps.length > 1 && winSteps.every((step) => !step.includes("run:") || step.includes("shell: bash")),
  );
  check(
    "P2-219: every run step of the new job carries its own timeout",
    winSteps.every((step) => !step.includes("run:") || step.includes("timeout-minutes:")),
  );
  check(
    "P2-219: the mac desktop-package job is still present and unchanged in its steps",
    mac.includes("runs-on: macos-14") &&
      mac.includes("npx tsx scripts/bundle-budget.ts") &&
      mac.includes("npm run dist --workspace @ocr/desktop -- --mac --dir") &&
      mac.includes("CSC_IDENTITY_AUTO_DISCOVERY: false") &&
      mac.includes("dist:smoke --workspace @ocr/desktop -- --no-installer"),
  );
}

// --- P2-221: quit confirmation (quithint.ts + quitstore.ts) + wiring ------------

{
  // full truth table, rules applied in the documented order
  const verdict = (packaged: boolean, harnessSession: boolean, daemonHealthy: boolean, phonePaired: boolean, dontAskAgain: boolean) =>
    quitVerdict({ packaged, harnessSession, daemonHealthy, phonePaired, dontAskAgain });

  // 1. harness test session always quits silently — even with every other
  //    condition begging for a confirmation (the gate must never see a modal).
  check(
    "P2-221: harness session → quit even when all other conditions ask for confirmation",
    verdict(true, true, true, true, false).action === "quit",
  );
  check(
    "P2-221: harness session beats every other rule (reason names the session)",
    verdict(true, true, true, true, true).reason.includes("harness"),
  );
  // 2. dev build always quits silently
  check("P2-221: unpackaged build → quit", verdict(false, false, true, true, false).action === "quit");
  // 3. recorded "don't ask again" always quits silently
  check("P2-221: recorded dont-ask request → quit", verdict(true, false, true, true, true).action === "quit");
  // 4. unhealthy daemon → quit (no remote access left to lose)
  check("P2-221: unhealthy daemon → quit", verdict(true, false, false, true, false).action === "quit");
  // 5. no paired phone → quit (same reason)
  check("P2-221: no paired phone → quit", verdict(true, false, true, false, false).action === "quit");
  // 6. the whole point: packaged + healthy daemon + paired phone + no request
  check(
    "P2-221: packaged + healthy daemon + paired phone + no request → confirm",
    verdict(true, false, true, true, false).action === "confirm",
  );

  // every generated reason: non-empty, no file path, no URL scheme, no secret
  const verdicts = [
    verdict(true, true, true, true, false),
    verdict(false, false, true, true, false),
    verdict(true, false, true, true, true),
    verdict(true, false, false, true, false),
    verdict(true, false, true, false, false),
    verdict(true, false, true, true, false),
  ];
  const clean = (s: string): boolean =>
    s.length > 0 &&
    !s.includes("/") &&
    !s.includes("\\") &&
    !s.includes("http:") &&
    !s.includes("https:") &&
    !s.includes("file:") &&
    !s.includes("Users") &&
    !s.includes("~");
  check(
    "P2-221: every reason is non-empty, path-free and scheme-free",
    verdicts.every((v) => clean(v.reason)),
  );
  const dialogCopy = [QUIT_DIALOG_TITLE, QUIT_DIALOG_MESSAGE, QUIT_DIALOG_DETAIL, QUIT_BUTTON_QUIT, QUIT_BUTTON_STAY, QUIT_BUTTON_NEVER];
  check("P2-221: dialog copy is non-empty, path-free and scheme-free", dialogCopy.every(clean));
  check(
    "P2-221: the dialog offers exactly the three documented buttons in the fixed order",
    QUIT_BUTTON_INDEX.quit === 0 && QUIT_BUTTON_INDEX.stay === 1 && QUIT_BUTTON_INDEX.never === 2,
  );

  // --- store table (quitstore.ts): tolerant read, atomic private write -------
  const dir = mkdtempSync(join(tmpdir(), "quitstore-"));
  const file = join(dir, "quit-ask.json");
  check("P2-221: missing file → no request recorded", readQuitDontAsk(file) === false);
  writeFileSync(file, "{not json at all", { mode: 0o600 });
  check("P2-221: corrupted JSON → no request recorded (never an exception)", readQuitDontAsk(file) === false);
  writeFileSync(file, '{"dontAsk":"sim"}', { mode: 0o600 });
  check("P2-221: wrong field type → no request recorded", readQuitDontAsk(file) === false);
  check(
    "P2-221: write → read round-trip records the dont-ask request",
    writeQuitDontAsk(file, true) === true && readQuitDontAsk(file) === true,
  );
  check("P2-221: the decision file is private (0600)", (statSync(file).mode & 0o777) === 0o600);
  check("P2-221: the store names the file quit-ask.json under userData", quitAskFile("/d").endsWith("quit-ask.json"));
  rmSync(dir, { recursive: true, force: true });

  // --- real-source assertions over the REAL main.ts --------------------------
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const quithintSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "quithint.ts"), "utf8");
  const menuSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "menu.ts"), "utf8");
  check(
    "P2-221: the verdict is consulted exactly once in the real main.ts",
    (mainSrc.match(/quitVerdict\(/g) ?? []).length === 1,
  );
  const quitAt = mainSrc.indexOf("async function explicitQuit");
  const trayFnAt = mainSrc.indexOf("function trayMenuItems");
  const explicitBlock = quitAt >= 0 && trayFnAt > quitAt ? mainSrc.slice(quitAt, trayFnAt) : "";
  check(
    "P2-221: the verdict (with the first-rule harness session) precedes any dialog opening",
    explicitBlock.includes("quitVerdict(") &&
      explicitBlock.indexOf("quitVerdict(") < explicitBlock.indexOf("askQuitDialog()"),
  );
  check(
    "P2-221: the explicit path quits only through realQuit — no direct app.quit()",
    explicitBlock.length > 0 && !explicitBlock.includes("app.quit()"),
  );
  check(
    "P2-221: the verdict receives the harness-session indicator (HERMETIC_E2E)",
    explicitBlock.includes("harnessSession: HERMETIC_E2E"),
  );
  check(
    "P2-221: quithint.ts is pure — no electron, no node:fs, no fetch",
    !/from\s+"electron"/.test(quithintSrc) &&
      !/from\s+"node:fs"/.test(quithintSrc) &&
      !quithintSrc.includes("fetch("),
  );
  check(
    "P2-221: the harness rule is the FIRST one in quithint.ts (documented contract)",
    quithintSrc.indexOf("input.harnessSession") > -1 &&
      quithintSrc.indexOf("input.harnessSession") < quithintSrc.indexOf("input.packaged") &&
      quithintSrc.indexOf("input.packaged") < quithintSrc.indexOf("input.dontAskAgain"),
  );
  // The will-quit hook stays byte-for-byte in charge of the sidecar cleanup.
  const willQuitAt = mainSrc.indexOf('app.on("will-quit"');
  const willQuitBlock = willQuitAt >= 0 ? mainSrc.slice(willQuitAt, mainSrc.indexOf("});", willQuitAt)) : "";
  check(
    "P2-221: the will-quit hook is unchanged — recheck cleanup + sidecar stop, no verdict, no dialog",
    willQuitBlock.includes("clearTimeout(updateRecheckTimer)") &&
      willQuitBlock.includes("stopDaemonSidecar()") &&
      !willQuitBlock.includes("quitVerdict") &&
      !willQuitBlock.includes("showMessageBox"),
  );
  check(
    "P2-221: explicitQuit never touches the sidecar cleanup or the signal ladder",
    explicitBlock.length > 0 && !explicitBlock.includes("stopDaemonSidecar") && !explicitBlock.includes("will-quit"),
  );
  check(
    "P2-221: no new periodic timer was introduced",
    (mainSrc.match(/setInterval\(/g) ?? []).length === 2,
  );
  const trayAt = mainSrc.indexOf("function trayMenuItems");
  const trayBlock = trayAt >= 0 ? mainSrc.slice(trayAt, mainSrc.indexOf("return items;", trayAt)) : "";
  check(
    "P2-221: the tray Quit item goes through the explicit-quit path",
    trayBlock.includes("void explicitQuit()"),
  );
  check(
    "P2-221: the menu quit item is id-wired (no bare quit role) with the Cmd+Q accelerator kept",
    menuSrc.includes('{ id: "app-quit", label: "Encerrar OpenCode Remote", accelerator: "CmdOrCtrl+Q" }') &&
      !menuSrc.includes('role: "quit"'),
  );
  check(
    "P2-221: the menu quit handler wires app-quit to the explicit-quit path",
    mainSrc.includes('"app-quit": () => void explicitQuit()'),
  );
  check(
    "P2-221: both documented test hatches exist in main.ts",
    mainSrc.includes("OCR_DESKTOP_FORCE_QUIT_CONFIRM") && mainSrc.includes("OCR_DESKTOP_QUIT_DIALOG_ANSWER"),
  );
  check(
    "P2-221: the never-ask request is written through the store on the never choice",
    explicitBlock.includes("writeQuitDontAsk(quitAskFile(app.getPath(\"userData\")), true)"),
  );
  // diagnostics: one additive line, action + reason only, never the path
  const diagSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "diagnostics.ts"), "utf8");
  check(
    "P2-221: the diagnostics bundle gains exactly one quit-confirm line (action + reason only)",
    (diagSrc.match(/quit confirm:/g) ?? []).length === 1 &&
      diagSrc.includes("d.quitConfirm?.state") &&
      diagSrc.includes("d.quitConfirm?.reason"),
  );
}

// --- P2-223: hang watch (hangwatch.ts) + wiring ---------------------------------

{
  const verdict = (
    harnessSession: boolean,
    unresponsiveMs: number,
    reloadBudgetExhausted: boolean,
    alreadyWarned: boolean,
  ) => hangVerdict({ harnessSession, unresponsiveMs, reloadBudgetExhausted, alreadyWarned });

  // 1. harness session — FIRST rule: even a long freeze with an exhausted
  //    budget only logs, because a modal box would hang the gate (P2-221).
  check(
    "P2-223: harness session + long hang + exhausted budget → log only",
    verdict(true, 60_000, true, false).action === "log",
  );
  // 2. below the exported warn threshold a normal GC spike only logs.
  check(
    "P2-223: hang below the warn threshold → log only",
    verdict(false, HANG_WARN_THRESHOLD_MS - 1, false, false).action === "log",
  );
  // 3. a freeze still going past the dialog threshold outside the harness
  //    offers the native box.
  check(
    "P2-223: long hang above the threshold outside harness → dialog",
    verdict(false, HANG_DIALOG_THRESHOLD_MS + 1, false, false).action === "dialog",
  );
  // 4. one user-facing warning per episode: after the tip, stay quiet.
  check(
    "P2-223: warning already shown in this episode → log only",
    verdict(false, HANG_WARN_THRESHOLD_MS + 1, false, true).action === "log",
  );
  // 5. exhausted budget in a harness session still only logs (harness first).
  check(
    "P2-223: exhausted budget in a harness session → log only",
    verdict(true, 0, true, false).action === "log",
  );
  // 6. exhausted budget outside the harness offers the box — the definitive
  //    white screen gets the escape hatch.
  check(
    "P2-223: exhausted budget outside harness → dialog",
    verdict(false, 0, true, false).action === "dialog",
  );
  // the warn action is real: a fresh freeze past the tip threshold, still
  // under the dialog beat, warns without a modal.
  check(
    "P2-223: fresh freeze past the tip threshold → warn without a box",
    verdict(false, HANG_WARN_THRESHOLD_MS + 1, false, false).action === "warn",
  );

  // every generated phrase: non-empty, no file path, no URL scheme, no secret
  const all = [
    verdict(true, 60_000, true, false),
    verdict(false, HANG_WARN_THRESHOLD_MS - 1, false, false),
    verdict(false, HANG_DIALOG_THRESHOLD_MS + 1, false, false),
    verdict(false, HANG_WARN_THRESHOLD_MS + 1, false, true),
    verdict(false, HANG_WARN_THRESHOLD_MS + 1, false, false),
    verdict(true, 0, true, false),
    verdict(false, 0, true, false),
  ];
  const clean = (s: string): boolean =>
    s.length > 0 &&
    !s.includes("/") &&
    !s.includes("\\") &&
    !s.includes("http:") &&
    !s.includes("https:") &&
    !s.includes("file:") &&
    !s.includes("Users") &&
    !s.includes("~");
  check(
    "P2-223: every verdict phrase is non-empty, path-free and scheme-free",
    all.every((v) => clean(v.log) && clean(v.tray) && clean(v.dialog)),
  );
  check(
    "P2-223: notification + dialog copy is non-empty, path-free and scheme-free",
    [HANG_NOTIFY_TITLE, HANG_DIALOG_TITLE, HANG_BUTTON_RELOAD, HANG_BUTTON_WAIT].every(clean),
  );
  check(
    "P2-223: the dialog offers exactly Recarregar/Aguardar in the fixed order",
    HANG_BUTTON_INDEX.reload === 0 && HANG_BUTTON_INDEX.wait === 1,
  );

  // real-source assertions over the REAL main.ts / hangwatch.ts
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const hangwatchSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "hangwatch.ts"), "utf8");
  check(
    "P2-223: main.ts registers both the unresponsive and the responsive listeners",
    mainSrc.includes('win.webContents.on("unresponsive"') && mainSrc.includes('win.webContents.on("responsive"'),
  );
  check(
    "P2-223: each hang listener is registered exactly once (no double-fire merge artifact)",
    (mainSrc.match(/win\.webContents\.on\("unresponsive"/g) ?? []).length === 1 &&
      (mainSrc.match(/win\.webContents\.on\("responsive"/g) ?? []).length === 1,
  );
  check(
    "P2-223: the harness-session rule is the FIRST one in hangVerdict (documented contract)",
    hangwatchSrc.indexOf("input.harnessSession") > -1 &&
      hangwatchSrc.indexOf("input.harnessSession") < hangwatchSrc.indexOf("input.unresponsiveMs") &&
      hangwatchSrc.indexOf("input.unresponsiveMs") < hangwatchSrc.indexOf("input.alreadyWarned"),
  );
  check(
    "P2-223: hangwatch.ts is pure — no electron, no node:fs, no fetch",
    !/from\s+"electron"/.test(hangwatchSrc) &&
      !/from\s+"node:fs"/.test(hangwatchSrc) &&
      !hangwatchSrc.includes("fetch("),
  );
  check(
    "P2-223: the white-screen path feeds the same verdict (budget-exhausted hook in main.ts)",
    mainSrc.includes("onReloadBudgetExhausted(hangEpisode, hangContext)"),
  );

  // diagnostics: one additive line, duration + outcome only, never the path
  const diagSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "diagnostics.ts"), "utf8");
  check(
    "P2-223: the diagnostics bundle gains exactly one last-hang line (duration + outcome only)",
    (diagSrc.match(/last hang:/g) ?? []).length === 1 && diagSrc.includes("d.lastHang"),
  );
}

// --- P2-222: ci-scope — touchesRelayImage, PR relay-image scope classifier ----
{
  check("P2-222: touchesRelayImage — path under apps/relay", touchesRelayImage(["apps/relay/src/index.ts"]));
  check("P2-222: touchesRelayImage — the relay Dockerfile itself", touchesRelayImage(["deploy/relay/Dockerfile"]));
  check("P2-222: touchesRelayImage — root .dockerignore (docker context exclusion)", touchesRelayImage([".dockerignore"]));
  check("P2-222: touchesRelayImage — root package-lock.json", touchesRelayImage(["package-lock.json"]));
  check("P2-222: touchesRelayImage — bare relay dir entry counts", touchesRelayImage(["apps/relay"]));
  check("P2-222: touchesRelayImage — apps/desktop path is not the relay surface", !touchesRelayImage(["apps/desktop/src/main.ts"]));
  check("P2-222: touchesRelayImage — docs path is not the relay surface", !touchesRelayImage(["docs/PILOT.md"]));
  check("P2-222: touchesRelayImage — empty diff", !touchesRelayImage([]));
  check(
    "P2-222: touchesRelayImage — windows-style separators normalize like forward ones",
    touchesRelayImage(["apps\\relay\\src\\index.ts"]) &&
      touchesRelayImage(["deploy\\relay\\Dockerfile"]) &&
      touchesRelayImage(["apps\\relay\\src\\index.ts"]) === touchesRelayImage(["apps/relay/src/index.ts"]),
  );
  check(
    "P2-222: touchesRelayImage — ./ prefix and whitespace normalize",
    touchesRelayImage([" ./apps/relay/src/index.ts"]) && touchesRelayImage(["./package-lock.json"]),
  );
  check(
    "P2-222: touchesRelayImage — app-sounding paths outside the surface don't count",
    !touchesRelayImage(["apps/relay-tests/x.ts", "src/apps/relay-mock.ts"]),
  );
  check(
    "P2-222: touchesDesktop keeps today's table intact (relay surface never trips it)",
    touchesDesktop(["apps/desktop/src/main.ts"]) &&
      touchesDesktop(["apps/web/src/lib/viewState.ts"]) &&
      touchesDesktop(["package-lock.json"]) &&
      touchesDesktop(["apps\\desktop\\src\\main.ts"]) &&
      !touchesDesktop(["apps/relay/src/index.ts", "deploy/relay/Dockerfile", ".dockerignore", "docs/PILOT.md"]),
  );
}

// --- P2-222: real-repo assertion — ci.yml wires relay-image to the new scope --
{
  const root = join(import.meta.dirname, "..");
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const relayJobStart = ci.indexOf("\n  relay-image:");
  check("P2-222: ci.yml declares the relay-image job", relayJobStart !== -1);
  const rest = ci.slice(relayJobStart + 1);
  const nextJob = rest.match(/\n  [a-zA-Z0-9_-]+:/);
  const relayJob = nextJob && nextJob.index !== undefined ? rest.slice(0, nextJob.index) : rest;
  check(
    "P2-222: relay-image runs on ubuntu-latest, needs scope, gated ONLY on the relay-image output",
    relayJob.includes("runs-on: ubuntu-latest") &&
      relayJob.includes("needs: scope") &&
      relayJob.includes("if: needs.scope.outputs.relay-image == 'true'") &&
      !relayJob.includes("outputs.desktop"),
  );
  check(
    "P2-222: scope job exposes both indicators (desktop unchanged + relay-image)",
    ci.includes("desktop: ${{ steps.scope.outputs.desktop }}") &&
      ci.includes("relay-image: ${{ steps.scope.outputs.relay-image }}"),
  );
  check(
    "P2-222: relay-image builds from deploy/relay/Dockerfile with an ephemeral local tag",
    relayJob.includes("docker build -f deploy/relay/Dockerfile") && relayJob.includes("relay-smoke:pr"),
  );
  const buildIdx = relayJob.indexOf("docker build");
  const runIdx = relayJob.indexOf("docker run -d");
  const smokeIdx = relayJob.indexOf("scripts/relay-image-smoke.ts");
  check(
    "P2-222: boot + smoke run AFTER the build, with the release wait ceiling (30 attempts) and cleanup",
    buildIdx !== -1 && runIdx !== -1 && smokeIdx !== -1 &&
      buildIdx < runIdx && runIdx < smokeIdx &&
      relayJob.includes("seq 1 30") &&
      relayJob.includes("docker rm -f relay-smoke"),
  );
  check(
    "P2-222: no step in the whole ci.yml logs in to a registry, pushes an image or reads secrets",
    !ci.includes("docker/login-action") &&
      !ci.includes("docker login") &&
      !ci.includes("docker push") &&
      !ci.includes("ghcr.io") &&
      !ci.includes("secrets."),
  );
  const steps = relayJob.split(/\n      - /).slice(1);
  const runSteps = steps.filter((step) => step.includes("run:"));
  check(
    "P2-222: every run step of relay-image declares shell: bash (P2-126/P2-164 lessons)",
    runSteps.length >= 2 && runSteps.every((step) => step.includes("shell: bash")),
  );
  check(
    "P2-222: heavy relay-image steps carry their own timeout",
    runSteps.length >= 2 && runSteps.every((step) => step.includes("timeout-minutes:")),
  );
  check(
    "P2-222: the two desktop packaging jobs remain present, still gated on the desktop output",
    ci.includes("desktop-package:") &&
      ci.includes("desktop-package-win:") &&
      ci.includes("if: needs.scope.outputs.desktop == 'true'") &&
      ci.includes("-- --mac --dir") &&
      ci.includes("-- --win --dir") &&
      (ci.match(/dist:smoke --workspace @ocr\/desktop -- --no-installer/g) ?? []).length === 2,
  );
}

// --- P2-224: portable (Windows-safe) unit suite --------------------------------

{
  check("P2-224: the real PORTABLE_TESTS list validates clean", portableSuitePlan(PORTABLE_TESTS).length === 0);

  check(
    "P2-224: every file in PORTABLE_TESTS exists on disk under scripts/",
    PORTABLE_TESTS.length > 0 && PORTABLE_TESTS.every((f) => existsSync(join(import.meta.dirname, f))),
  );

  check(
    "P2-224: package.json exposes test:unit-win pointing at the portable CLI",
    (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts[
      "test:unit-win"
    ] === "tsx scripts/portable-suite.ts",
  );

  const good = portableSuitePlan(["bubble-merge.test.ts", "desktop-log.test.ts", "sidecar-log.test.ts"]);
  check("P2-224: portableSuitePlan accepts a well-formed list with no problem", good.length === 0, JSON.stringify(good));

  const badExt = portableSuitePlan(["portable-suite.ts"]);
  check(
    "P2-224: a non-.test.ts item is one problem naming the extension rule",
    badExt.length === 1 && badExt[0].includes(".test.ts"),
    JSON.stringify(badExt),
  );

  const dup = portableSuitePlan(["a.test.ts", "b.test.ts", "a.test.ts"]);
  check(
    "P2-224: a duplicate item is one problem naming the file twice-listed",
    dup.length === 1 && dup[0].includes("a.test.ts") && dup[0].includes("twice"),
    JSON.stringify(dup),
  );

  const outside = portableSuitePlan(["../apps/evil.test.ts"]);
  check(
    "P2-224: an item outside scripts/ is one problem naming the directory rule",
    outside.length === 1 && outside[0].includes("outside scripts"),
    JSON.stringify(outside),
  );

  const empty = portableSuitePlan([]);
  check(
    "P2-224: an empty list is one problem (the battery would run nothing)",
    empty.length === 1 && empty[0].includes("empty"),
    JSON.stringify(empty),
  );

  const both = portableSuitePlan(["..\\evil.ts"]);
  check(
    "P2-224: two simultaneous causes yield two problems in the established order (extension, then directory)",
    both.length === 2 && both[0].includes(".test.ts") && both[1].includes("outside scripts"),
    JSON.stringify(both),
  );

  // Real-repo assertion over the workflow: the verify-win job must exist,
  // mirror the scope gating and never become a publishing path.
  const ciWin = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const winStart = ciWin.indexOf("\n  verify-win:\n");
  const winEnd = ciWin.indexOf("\n  relay-image:");
  const winJob = winStart > -1 && winEnd > winStart ? ciWin.slice(winStart, winEnd) : "";

  check("P2-224: ci.yml has the verify-win job on windows-latest", winStart > -1 && winJob.includes("runs-on: windows-latest"));

  check(
    "P2-224: verify-win depends on scope and is conditioned on the desktop output (P2-219 indicator)",
    winJob.includes("needs: scope") && winJob.includes("if: needs.scope.outputs.desktop == 'true'"),
  );

  const typecheckAt = winJob.indexOf("run: npm run typecheck");
  const portableAt = winJob.indexOf("run: npm run test:unit-win");
  check(
    "P2-224: verify-win runs typecheck and then test:unit-win, in that order",
    typecheckAt > -1 && portableAt > typecheckAt,
  );

  // Steps are indented with 6 spaces; slice per step for per-step invariants.
  const winSteps = winJob.split(/\n      - /).slice(1);
  const winRunSteps = winSteps.filter((step) => step.includes("run:"));
  check(
    "P2-224: every run step of verify-win declares shell: bash (P2-126/P2-164 lessons)",
    winRunSteps.length >= 3 && winRunSteps.every((step) => step.includes("shell: bash")),
  );
  check(
    "P2-224: every heavy verify-win step carries its own timeout",
    winRunSteps.length >= 3 && winRunSteps.every((step) => step.includes("timeout-minutes:")),
  );
  check(
    "P2-224: verify-win uploads nothing, reads no secrets and logs in to no registry",
    !winJob.includes("actions/upload-artifact") &&
      !winJob.includes("secrets.") &&
      !winJob.includes("docker/login-action") &&
      !winJob.includes("ghcr.io"),
  );

  check(
    "P2-224: no step of the whole ci.yml logs in to a registry or pushes an image",
    !ciWin.includes("docker login") &&
      !ciWin.includes("docker push") &&
      !ciWin.includes("docker/login-action") &&
      !ciWin.includes("ghcr.io") &&
      !ciWin.includes("secrets."),
  );

  const verifyStart = ciWin.indexOf("\n  verify:\n");
  const verifyEnd = ciWin.indexOf("\n  scope:");
  const verifyJob = verifyStart > -1 && verifyEnd > verifyStart ? ciWin.slice(verifyStart, verifyEnd) : "";
  check(
    "P2-224: the ubuntu verify job keeps its original steps on ubuntu-latest, untouched",
    verifyJob.includes("runs-on: ubuntu-latest") &&
      verifyJob.includes("npx eslint apps packages scripts --quiet") &&
      verifyJob.includes("run: npm run typecheck") &&
      verifyJob.includes("run: npm run test:unit") &&
      verifyJob.includes("run: npm run build") &&
      verifyJob.includes("scripts/smoke.ts") &&
      verifyJob.includes("scripts/integration.ts") &&
      !verifyJob.includes("test:unit-win"),
  );
}

// --- P2-237: portable-suite coverage guard --------------------------------------

{
  check("P2-237: empty lists and no existing files yield zero problems", portableCoverage([], [], []).length === 0);

  const r1 = portableCoverage(["brand-new.test.ts"], [], []);
  check(
    "P2-237: an existing test file in neither list is one fail-closed problem naming the file",
    r1.length === 1 && r1[0].includes("brand-new.test.ts") && r1[0].includes("neither"),
    JSON.stringify(r1),
  );

  const r2 = portableCoverage(["both.test.ts"], ["both.test.ts"], [{ file: "both.test.ts", cause: "electron" }]);
  check(
    "P2-237: a file declared in both lists at the same time is one problem naming the file",
    r2.length === 1 && r2[0].includes("both.test.ts"),
    JSON.stringify(r2),
  );

  const r3p = portableCoverage([], ["ghost.test.ts"], []);
  check(
    "P2-237: a portable entry missing from disk is one problem naming the file",
    r3p.length === 1 && r3p[0].includes("ghost.test.ts"),
    JSON.stringify(r3p),
  );

  const r3e = portableCoverage([], [], [{ file: "ghost.test.ts", cause: "electron" }]);
  check(
    "P2-237: an exclusion entry missing from disk is one problem naming the file",
    r3e.length === 1 && r3e[0].includes("ghost.test.ts"),
    JSON.stringify(r3e),
  );

  const r4 = portableCoverage(["odd.test.ts"], [], [{ file: "odd.test.ts", cause: "vibes" }]);
  check(
    "P2-237: an exclusion cause outside the documented set is one problem naming the file and the cause",
    r4.length === 1 && r4[0].includes("odd.test.ts") && r4[0].includes("vibes"),
    JSON.stringify(r4),
  );

  const r5 = portableCoverage(["dup.test.ts"], [], [
    { file: "dup.test.ts", cause: "electron" },
    { file: "dup.test.ts", cause: "chmod" },
  ]);
  check(
    "P2-237: a repeated exclusion is one problem naming the file",
    r5.length === 1 && r5[0].includes("dup.test.ts"),
    JSON.stringify(r5),
  );

  const two = portableCoverage([], [], [{ file: "ghost.test.ts", cause: "vibes" }]);
  check(
    "P2-237: two simultaneous causes yield two problems, never one merged verdict",
    two.length === 2 && two[0].includes("ghost.test.ts") && two[1].includes("vibes"),
    JSON.stringify(two),
  );

  const stableA = portableCoverage(
    ["a.test.ts", "b.test.ts"],
    ["c.test.ts"],
    [{ file: "d.test.ts", cause: "electron" }, { file: "d.test.ts", cause: "electron" }],
  );
  const stableB = portableCoverage(
    ["a.test.ts", "b.test.ts"],
    ["c.test.ts"],
    [{ file: "d.test.ts", cause: "electron" }, { file: "d.test.ts", cause: "electron" }],
  );
  check("P2-237: problem order is stable across calls with the same input", JSON.stringify(stableA) === JSON.stringify(stableB));

  check(
    "P2-237: no problem text contains an absolute file path",
    [...r1, ...r2, ...r3p, ...r3e, ...r4, ...r5, ...two, ...stableA].every(
      (p) => !p.startsWith("/") && !/^[A-Za-z]:[\\]/.test(p) && !p.includes(import.meta.dirname),
    ),
  );

  check(
    "P2-237: every PORTABLE_EXCLUSIONS entry uses a documented cause",
    PORTABLE_EXCLUSIONS.every((e) => Object.prototype.hasOwnProperty.call(PORTABLE_EXCLUSION_CAUSES, e.cause)),
  );

  check(
    "P2-237: no PORTABLE_EXCLUSIONS entry has an empty file name",
    PORTABLE_EXCLUSIONS.every((e) => typeof e.file === "string" && e.file.trim().length > 0),
  );

  // Real-repo assertion: the scripts directory itself is fully classified —
  // creating a new test file without classifying it fails the gate right here,
  // not months later on a user's Windows machine.
  const onDiskTests = readdirSync(import.meta.dirname).filter((f) => f.endsWith(".test.ts")).sort();
  const realCoverage = portableCoverage(onDiskTests, PORTABLE_TESTS, PORTABLE_EXCLUSIONS);
  check("P2-237: the real scripts/ directory is fully classified (zero coverage problems)", realCoverage.length === 0, JSON.stringify(realCoverage));

  // The portable CLI must run this guard before executing any test and must
  // derive the real file list from a directory read, not a second hand-written list.
  const portableSuiteSrc = readFileSync(join(import.meta.dirname, "portable-suite.ts"), "utf8");
  const guardAt = portableSuiteSrc.indexOf("portableCoverage(");
  const execAt = portableSuiteSrc.indexOf("spawnSync(");
  check(
    "P2-237: portable-suite.ts runs the coverage guard before executing any test",
    guardAt > -1 && execAt > -1 && guardAt < execAt,
  );
  const dirListVar = portableSuiteSrc.match(/const (\w+) = readdirSync\(/)?.[1];
  check(
    "P2-237: portable-suite.ts builds the test-file list from a directory read, not a second hand-written list",
    typeof dirListVar === "string" && portableSuiteSrc.includes(`portableCoverage(${dirListVar},`),
  );
}

// --- P2-225: boot-time asset integrity for the relay's static entry document ---
// indexAssetPlan: full truth table of the text scan.
check(
  "P2-225: indexAssetPlan — script with a src yields one item",
  JSON.stringify(indexAssetPlan('<html><body><script src="/assets/app.js"></script></body></html>')) ===
    JSON.stringify(["/assets/app.js"]),
);
check(
  "P2-225: indexAssetPlan — stylesheet link yields one item",
  JSON.stringify(indexAssetPlan('<link rel="stylesheet" href="/assets/app.css">')) ===
    JSON.stringify(["/assets/app.css"]),
);
check(
  "P2-225: indexAssetPlan — modulepreload link yields one item",
  JSON.stringify(indexAssetPlan('<link rel="modulepreload" href="/assets/chunk.js" crossorigin>')) ===
    JSON.stringify(["/assets/chunk.js"]),
);
check(
  "P2-225: indexAssetPlan — icon (and other non-asset) links are ignored",
  JSON.stringify(
    indexAssetPlan(
      '<link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="preconnect" href="/x">',
    ),
  ) === JSON.stringify([]),
);
check(
  "P2-225: indexAssetPlan — repeated reference appears once, order of appearance preserved",
  JSON.stringify(
    indexAssetPlan(
      '<script src="/b.js"></script><script src="/a.js"></script><script src="/b.js"></script>' +
        '<link rel="stylesheet" href="/a.css"><link rel="modulepreload" href="/a.js">',
    ),
  ) === JSON.stringify(["/b.js", "/a.js", "/a.css"]),
);
check(
  "P2-225: indexAssetPlan — explicit scheme ignored",
  JSON.stringify(
    indexAssetPlan('<script src="https://cdn.example/x.js"></script><script src="data:text/javascript,1"></script>'),
  ) === JSON.stringify([]),
);
check(
  "P2-225: indexAssetPlan — protocol-relative reference ignored",
  JSON.stringify(indexAssetPlan('<script src="//cdn.example/x.js"></script>')) === JSON.stringify([]),
);
check(
  "P2-225: indexAssetPlan — pure anchor ignored",
  JSON.stringify(indexAssetPlan('<script src="#local"></script>')) === JSON.stringify([]),
);
check(
  "P2-225: indexAssetPlan — single and double quotes give the same result",
  JSON.stringify(indexAssetPlan("<script src='/a.js'></script><link rel='stylesheet' href='/b.css'>")) ===
    JSON.stringify(indexAssetPlan('<script src="/a.js"></script><link rel="stylesheet" href="/b.css">')) &&
    JSON.stringify(indexAssetPlan("<script src='/a.js'>")) === JSON.stringify(["/a.js"]),
);
check(
  "P2-225: indexAssetPlan — attribute order inside the tag does not matter",
  JSON.stringify(indexAssetPlan('<link href="/a.css" rel="stylesheet">')) === JSON.stringify(["/a.css"]),
);
check("P2-225: indexAssetPlan — empty text yields an empty list", indexAssetPlan("").length === 0);
check(
  "P2-225: indexAssetPlan — text without any tag yields an empty list",
  indexAssetPlan("hello world, no tags here").length === 0,
);

// assetIntegrityPlan: full truth table of the boot probe.
const probeOk: (p: string) => AssetProbe = () => "ok";
check(
  "P2-225: assetIntegrityPlan — every asset readable yields no problems",
  assetIntegrityPlan(["/assets/app.js", "/assets/app.css"], "/srv/web", probeOk).length === 0,
);
const missingProblems = assetIntegrityPlan(["/assets/app.js"], "/srv/web", () => "missing");
check(
  "P2-225: assetIntegrityPlan — one missing asset yields exactly one problem",
  missingProblems.length === 1 && missingProblems[0]?.includes("/assets/app.js"),
);
check(
  "P2-225: assetIntegrityPlan — two missing assets yield two problems in index order",
  JSON.stringify(
    assetIntegrityPlan(["/assets/one.js", "/assets/two.js"], "/srv/web", () => "missing").map((p) =>
      ["/assets/one.js", "/assets/two.js"].findIndex((ref) => p.includes(ref)),
    ),
  ) === JSON.stringify([0, 1]),
);
check(
  "P2-225: assetIntegrityPlan — unreadable asset yields a problem",
  assetIntegrityPlan(["/assets/app.js"], "/srv/web", () => "unreadable").length === 1,
);
check(
  "P2-225: assetIntegrityPlan — document-relative references (the real vite shape) resolve against the root",
  assetIntegrityPlan(["./assets/index-AbCdE123.js", "assets/x.css"], "/srv/web", (p) =>
    p.endsWith(".js") || p.endsWith(".css") ? "ok" : "missing",
  ).length === 0 &&
    assetIntegrityPlan(["./assets/index-AbCdE123.js"], "/srv/web", () => "missing").length === 1,
);
check(
  "P2-225: assetIntegrityPlan — path escaping the root is refused even though the probe would pass",
  assetIntegrityPlan(["/assets/../../etc/passwd"], "/srv/web", probeOk).length === 1 &&
    assetIntegrityPlan(["../secret.js"], "/srv/web", probeOk).length === 1,
);
check(
  "P2-225: assetIntegrityPlan — a throwing probe becomes a problem instead of killing the boot",
  assetIntegrityPlan(["/assets/app.js"], "/srv/web", () => {
    throw new Error("boom");
  }).length === 1,
);
check(
  "P2-225: assetIntegrityPlan — problems appear in index order across causes",
  JSON.stringify(
    assetIntegrityPlan(
      ["/gone.js", "../bad.js", "/secret.js"],
      "/srv/web",
      (p) => (p.endsWith("gone.js") ? "missing" : p.endsWith("secret.js") ? "unreadable" : "ok"),
    ).map((p) => (p.includes("/gone.js") ? "missing" : p.includes("../bad.js") ? "rigid" : "unreadable")),
  ) === JSON.stringify(["missing", "rigid", "unreadable"]),
);
check("P2-225: the boot ceiling for the entry document is 512 KiB", WEB_INDEX_MAX_BYTES === 512 * 1024);

// Real-source assertions: the relay boot applies both plans inside the same
// fail-closed web-root block, before any listener can open.
const relayIndexSrc = readFileSync(new URL("../apps/relay/src/index.ts", import.meta.url), "utf8");
const webRootAt = relayIndexSrc.indexOf("webRootPlan(");
const idxPlanAt = relayIndexSrc.indexOf("indexAssetPlan(");
const assetPlanAt = relayIndexSrc.indexOf("assetIntegrityPlan(");
const webRefusalAt = relayIndexSrc.indexOf("invalid relay web root, refusing to start");
const listenAt = relayIndexSrc.indexOf("server.listen(");
check(
  "P2-225: relay boot applies indexAssetPlan + assetIntegrityPlan to the entry document",
  webRootAt > -1 && idxPlanAt > webRootAt && assetPlanAt > webRootAt,
);
check(
  "P2-225: asset problems join the same fail-closed web-root block (exit 1, one line per cause)",
  relayIndexSrc.includes("WEB.problems.push") && webRefusalAt > assetPlanAt,
);
check(
  "P2-225: the asset check completes before the listener opens",
  listenAt > webRefusalAt && listenAt > assetPlanAt,
);
check(
  "P2-225: the boot-time index.html read is capped and overflow is a problem",
  relayIndexSrc.includes("WEB_INDEX_MAX_BYTES") &&
    relayIndexSrc.includes("stat.size > WEB_INDEX_MAX_BYTES") &&
    relayIndexSrc.includes("Buffer.byteLength(text) > WEB_INDEX_MAX_BYTES"),
);
const webrootSrc = readFileSync(new URL("../apps/relay/src/webroot.ts", import.meta.url), "utf8");
const webrootImports = webrootSrc
  .split("\n")
  .filter((l) => l.trim().startsWith("import "))
  .join("\n");
check(
  "P2-225: webroot.ts stays pure (no node:fs/node:http/node:ws imports) and the new functions stay blind",
  !/node:(fs|http|ws)/.test(webrootImports) &&
    webrootImports.includes("node:path") &&
    webrootSrc.includes("no plaintext, no key material, no room ids"),
);

// --- P2-229: global reopen hotkey (hotkey.ts) ------------------------------------

{
  const plan = (over: Partial<Parameters<typeof hotkeyPlan>[0]> = {}) =>
    hotkeyPlan({
      harnessSession: false,
      env: {},
      userAccelerator: undefined,
      platform: "darwin",
      ...over,
    });

  // rule 1 — the harness-session rule is FIRST: a valid accelerator and a
  // favorable environment still register nothing in a test session
  const harness = plan({ harnessSession: true, userAccelerator: "Alt+Shift+R" });
  check(
    "P2-229: harness session with a valid accelerator and favorable env → not registered",
    !harness.register && harness.accelerator === null && harness.reason.length > 0,
  );
  check(
    "P2-229: harness session also refuses with a kill-switch-free, accelerator-free env",
    !plan({ harnessSession: true, platform: "win32" }).register,
  );

  // rule 2 — the documented kill switch, outside harness
  check(
    "P2-229: the documented kill switch outside harness → not registered",
    !plan({ env: { [HOTKEY_DISABLE_ENV]: "1" }, userAccelerator: "Alt+Shift+R" }).register,
  );
  check(
    "P2-229: only the exact value 1 disables — anything else keeps the hotkey alive",
    plan({ env: { [HOTKEY_DISABLE_ENV]: "0" } }).register && plan({ env: { [HOTKEY_DISABLE_ENV]: "yes" } }).register,
  );

  // rule 3 — an invalid owner accelerator refuses WITHOUT falling back to the
  // default (fail-closed: the reason travels, silence would lie)
  const invalid = plan({ userAccelerator: "Ctrl++" });
  check(
    "P2-229: invalid owner accelerator → not registered with a reason, never a silent default",
    !invalid.register && invalid.accelerator === null && invalid.reason.length > 0,
  );

  // rule 4 — empty environment → the documented platform default
  check(
    "P2-229: empty environment → the documented platform default, registered",
    plan({}).register && plan({}).accelerator === defaultHotkeyFor("darwin"),
  );

  // rule 5 — Windows and macOS each return their own documented default
  check(
    "P2-229: Windows and macOS defaults are distinct and honored per platform",
    defaultHotkeyFor("win32") !== defaultHotkeyFor("darwin") &&
      plan({ platform: "win32" }).accelerator === defaultHotkeyFor("win32") &&
      plan({ platform: "darwin" }).accelerator === defaultHotkeyFor("darwin") &&
      plan({ platform: "win32" }).accelerator !== plan({ platform: "darwin" }).accelerator,
  );

  // rule 6 — a valid owner accelerator beats the platform default
  const owner = plan({ userAccelerator: "Alt+Shift+R" });
  check(
    "P2-229: a valid owner accelerator wins over the platform default",
    owner.register && owner.accelerator === "Alt+Shift+R" && owner.accelerator !== defaultHotkeyFor("darwin"),
  );

  // every generated phrase: static, non-empty, no file path, no URL scheme
  const reasons = [
    plan({ harnessSession: true }).reason,
    plan({ env: { [HOTKEY_DISABLE_ENV]: "1" } }).reason,
    plan({ userAccelerator: "Ctrl++" }).reason,
    plan({ userAccelerator: "Alt+Shift+R" }).reason,
    plan({}).reason,
    plan({ platform: "win32" }).reason,
  ];
  check(
    "P2-229: every hotkey phrase is non-empty, path-free and scheme-free",
    reasons.every(
      (r) =>
        r.length > 0 &&
        !r.includes("/") &&
        !r.includes("\\") &&
        !r.includes("://") &&
        !r.includes("http:") &&
        !r.includes("file:") &&
        !r.includes(":~"),
    ),
  );

  // -- acceleratorProblem: the full fail-closed table -------------------------

  check(
    "P2-229: acceleratorProblem — empty text is a problem",
    typeof acceleratorProblem("") === "string" && typeof acceleratorProblem("   ") === "string",
  );
  check(
    "P2-229: acceleratorProblem — a wrong-type value is a problem",
    [undefined, null, 42, ["Ctrl+A"], {}].every((v) => typeof acceleratorProblem(v) === "string"),
  );
  check(
    "P2-229: acceleratorProblem — a bare key without modifier is a problem (keyjacking is hostile)",
    typeof acceleratorProblem("A") === "string" &&
      typeof acceleratorProblem("Space") === "string" &&
      typeof acceleratorProblem("F5") === "string",
  );
  check(
    "P2-229: acceleratorProblem — a token outside the allowlist is a problem",
    typeof acceleratorProblem("Ctrl+Emoji") === "string" &&
      typeof acceleratorProblem("Cat+A") === "string" &&
      typeof acceleratorProblem("Ctrl++") === "string",
  );
  check(
    "P2-229: acceleratorProblem — above the documented ceiling is a problem",
    acceleratorProblem(`Ctrl+${"A".repeat(HOTKEY_MAX_LEN)}`) !== null &&
      acceleratorProblem(`Ctrl+Shift+${"A".repeat(HOTKEY_MAX_LEN)}`) !== null,
  );
  check(
    "P2-229: acceleratorProblem — valid combinations across modifier/key shapes pass with no problem",
    ["Ctrl+Shift+O", "Command+Shift+O", "CommandOrControl+Shift+O", "Alt+F9", "Ctrl+Space", "ctrl+shift+o"].every(
      (a) => acceleratorProblem(a) === null,
    ),
  );

  // -- the menu surfaces the plan's truth (P2-229 × P2-176 contract) ----------

  const helpItemsOf = (p: Parameters<typeof menuSpec>[3]) => {
    const spec = menuSpec("darwin", null, false, p);
    return spec.find((i) => i.label === "Ajuda")?.submenu ?? [];
  };
  const hotkeyItem = (p: ReturnType<typeof hotkeyPlan>) => helpItemsOf(p).find((i) => i.id === "help-hotkey");
  const activeItem = hotkeyItem(plan({}));
  const refusedItem = hotkeyItem(plan({ harnessSession: true }));
  check(
    "P2-229: Help menu shows the active accelerator as a disabled informational item",
    activeItem?.label === HOTKEY_MENU_LABEL &&
      activeItem?.accelerator === defaultHotkeyFor("darwin") &&
      activeItem?.enabled === false,
  );
  check(
    "P2-229: Help menu shows the plan's reason instead of a lying combination when refused",
    refusedItem?.label === plan({ harnessSession: true }).reason &&
      refusedItem?.accelerator === undefined &&
      refusedItem?.enabled === false,
  );
  check(
    "P2-229: three-arg menuSpec calls (the P2-176 contract) still produce no hotkey item",
    !helpItemsOf(undefined).some((i) => i.id === "help-hotkey"),
  );

  // -- real-source assertions over the REAL main.ts ---------------------------

  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  // registration goes through the plan, once, after the app is ready
  check(
    "P2-229: the real main.ts resolves hotkeyPlan and registers through the plan verdict",
    mainSrc.includes("hotkeyPlan({") &&
      mainSrc.includes("globalShortcut.register(hotkey.accelerator, showMainWindow)") &&
      /if \(!hotkey\?\.register \|\| !hotkey\.accelerator\) return;/.test(mainSrc),
  );
  // the harness-session rule is the first input consulted: HERMETIC_E2E leads
  // the plan call, and the pure plan checks it before env/accelerator shapes
  check(
    "P2-229: the real main.ts feeds the harness flag first into the plan call",
    /hotkeyPlan\(\{\s*\n\s*harnessSession: HERMETIC_E2E,/.test(mainSrc),
  );
  const hotkeySrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "hotkey.ts"), "utf8");
  const planBody = hotkeySrc.slice(hotkeySrc.indexOf("export function hotkeyPlan"));
  check(
    "P2-229: in the pure plan the harness rule is the first consulted, before env and accelerator shape",
    planBody.includes("input.harnessSession") &&
      planBody.indexOf("input.harnessSession") < planBody.indexOf("HOTKEY_DISABLE_ENV") &&
      planBody.indexOf("HOTKEY_DISABLE_ENV") < planBody.indexOf("acceleratorProblem("),
  );
  // everything is unregistered in will-quit
  const willQuitAt = mainSrc.indexOf('app.on("will-quit"');
  const willQuitBlock = willQuitAt >= 0 ? mainSrc.slice(willQuitAt, willQuitAt + 700) : "";
  check(
    "P2-229: the real main.ts unregisters every shortcut in will-quit",
    willQuitBlock.includes("globalShortcut.unregisterAll()"),
  );
  // no new timer anywhere in the hotkey block
  const hotkeyBlockAt = mainSrc.indexOf("// --- global reopen hotkey");
  const hotkeyBlock =
    hotkeyBlockAt >= 0
      ? mainSrc.slice(hotkeyBlockAt, mainSrc.indexOf("function buildTray", hotkeyBlockAt))
      : "";
  check(
    "P2-229: the hotkey block introduces no timer (no setInterval, no setTimeout)",
    hotkeyBlock.length > 0 && !hotkeyBlock.includes("setInterval") && !hotkeyBlock.includes("setTimeout"),
  );

  // hotkey.ts stays pure: unit tests must never boot electron on import
  // (strip line comments first — the header prose names the banned modules)
  const hotkeyCode = hotkeySrc.replace(/\/\/.*$/gm, "");
  check(
    "P2-229: hotkey.ts is pure — zero imports (no electron, no node:fs, no fetch, no I/O)",
    !/^import /m.test(hotkeyCode) && !hotkeyCode.includes("node:") && !/\bfetch\b/.test(hotkeyCode),
  );
}

// --- P2-231: document→PDF conversion capability (doccap.ts) + wiring ----------

{
  const src = (rel: string[]) => readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");
  const doccapSrc = src(["apps", "daemon", "src", "doccap.ts"]);
  const indexSrc = src(["apps", "daemon", "src", "index.ts"]);
  const doc2pdfSrc = src(["tools", "doc2pdf.mjs"]);

  const FULL = { soffice: true, textutil: true, cupsfilter: true };
  const NATIVE_ONLY = { soffice: false, textutil: true, cupsfilter: true };
  const NOTHING = { soffice: false, textutil: false, cupsfilter: false };

  // verdict matrix — full fidelity wins, everywhere
  const fullMac = docConvertVerdict("darwin", FULL);
  const fullWin = docConvertVerdict("win32", FULL);
  check(
    "P2-231: full-fidelity converter on macOS is complete with every documented extension",
    fullMac.state === "complete" &&
      JSON.stringify(fullMac.exts) === JSON.stringify(SOFFICE_EXTS) &&
      SOFFICE_EXTS.join(" ") === "docx doc rtf html csv xlsx pptx",
  );
  check(
    "P2-231: full-fidelity converter on Windows is complete too",
    fullWin.state === "complete" && fullWin.exts.length === SOFFICE_EXTS.length,
  );
  check(
    "P2-231: both candidates present picks full fidelity by the documented order",
    docConvertVerdict("darwin", FULL).state === "complete" && CONVERTER_PREFERENCE[0] === "soffice",
  );

  // native-only: partial with the exact covered list, nothing more
  const nativeMac = docConvertVerdict("darwin", NATIVE_ONLY);
  check(
    "P2-231: native-only on macOS is partial with exactly the native extensions",
    nativeMac.state === "partial" &&
      JSON.stringify(nativeMac.exts) === JSON.stringify(NATIVE_EXTS) &&
      !nativeMac.exts.includes("xlsx") &&
      !nativeMac.exts.includes("pptx"),
  );

  // native declared off macOS is ignored (that pipeline does not exist there)
  check(
    "P2-231: native declared on Windows is ignored and the verdict is unavailable",
    docConvertVerdict("win32", NATIVE_ONLY).state === "unavailable" &&
      docConvertVerdict("win32", NATIVE_ONLY).exts.length === 0,
  );
  check(
    "P2-231: half a native pipeline is not a usable converter",
    docConvertVerdict("darwin", { soffice: false, textutil: true, cupsfilter: false }).state === "unavailable" &&
      docConvertVerdict("darwin", { soffice: false, textutil: false, cupsfilter: true }).state === "unavailable",
  );

  // nothing: unavailable with the install phrase
  const none = docConvertVerdict("linux", NOTHING);
  check(
    "P2-231: no candidate is unavailable with an install phrase",
    none.state === "unavailable" && /instal/i.test(none.message) && none.exts.length === 0,
  );

  // extension lists: documented order, no repetitions
  check(
    "P2-231: every verdict extension list is ordered and repetition-free",
    [fullMac.exts, fullWin.exts, nativeMac.exts, none.exts].every(
      (exts) => new Set(exts).size === exts.length,
    ),
  );

  // message hygiene: short, actionable, no absolute path, no URL scheme
  const verdicts = [
    docConvertVerdict("darwin", FULL),
    docConvertVerdict("win32", FULL),
    nativeMac,
    docConvertVerdict("win32", NATIVE_ONLY),
    none,
  ];
  check(
    "P2-231: every verdict message is non-empty and free of paths and URL schemes",
    verdicts.every(
      (v) =>
        v.message.trim().length > 0 &&
        !/[\\/]/.test(v.message) &&
        !/[A-Za-z]:/.test(v.message) &&
        !/https?:/i.test(v.message),
    ),
  );

  // probe helper injects the existence check (pure module, I/O stays outside)
  check(
    "P2-231: probe reads the platform's own list and takes an injected exists()",
    docConvertProbe("darwin", (p) => p === "/usr/bin/textutil").textutil === true &&
      docConvertProbe("win32", () => true).textutil === false &&
      docConvertProbe("win32", () => true).soffice === true,
  );

  // known-location lists: Windows default + macOS paths present, no empty entries
  const allPaths = Object.values(SOFFICE_PATHS)
    .concat(Object.values(TEXTUTIL_PATHS))
    .concat(Object.values(CUPSFILTER_PATHS))
    .flat();
  check(
    "P2-231: path lists carry the macOS app-bundle path and the Windows default install path",
    SOFFICE_PATHS.darwin.includes("/Applications/LibreOffice.app/Contents/MacOS/soffice") &&
      SOFFICE_PATHS.win32.includes("C:\\Program Files\\LibreOffice\\program\\soffice.exe") &&
      allPaths.every((p) => typeof p === "string" && p.trim().length > 0),
  );
  check(
    "P2-231: the native pipeline is declared macOS-only in the path lists",
    TEXTUTIL_PATHS.darwin.length > 0 &&
      TEXTUTIL_PATHS.win32.length === 0 &&
      CUPSFILTER_PATHS.win32.length === 0,
  );

  // doccap stays pure: unit tests must never boot a daemon on import
  // (strip line comments first — the header prose names the banned modules)
  const doccapCode = doccapSrc.replace(/\/\/.*$/gm, "");
  check(
    "P2-231: doccap.ts is pure (no node:fs/child_process/path/os/fetch imports)",
    !/node:(fs|child_process|path|os|http)/.test(doccapCode) && !/\bfetch\(/.test(doccapCode),
  );

  // real-repo assertion: the daemon probes ONCE, on the existing boot readiness
  // hook (next to whisper/edge-tts), with no periodic timer and no per-request
  // probing — failures degrade to unavailable instead of throwing.
  check(
    "P2-231: the daemon probes doc conversion exactly once, inside main()'s readiness hook",
    (indexSrc.match(/docConvertProbe\(/g) || []).length === 1 &&
      indexSrc.includes("probeDocConvert();") &&
      indexSrc.indexOf("async function main") < indexSrc.indexOf("probeDocConvert();"),
  );
  check(
    "P2-231: no periodic doc-conversion timer was introduced",
    indexSrc
      .split("\n")
      .filter((l) => l.includes("setInterval"))
      .every((l) => !/docconvert/i.test(l)),
  );
  check(
    "P2-231: /api/health carries the additive docConvert readiness block",
    indexSrc.includes("docConvertState: docConvert.state") &&
      indexSrc.includes("docConvertMessage: docConvert.message") &&
      indexSrc.includes("docConvertExts: docConvert.exts"),
  );

  // real-repo assertion: the tool consumes doccap's lists (no local copy) and
  // fails with the pt-BR verdict phrase instead of the old English dead end.
  check(
    "P2-231: doc2pdf.mjs consumes the doccap lists and keeps no own path list",
    /apps\/daemon\/src\/doccap\.ts/.test(doc2pdfSrc) &&
      !doc2pdfSrc.includes("/Applications/LibreOffice.app") &&
      !doc2pdfSrc.includes("/usr/bin/textutil") &&
      !/const (SOFFICE|TEXTUTIL|CUPSFILTER)_PATHS\s*=/.test(doc2pdfSrc),
  );
  check(
    "P2-231: doc2pdf.mjs failure is the pt-BR verdict phrase, not the English terminal error",
    !doc2pdfSrc.includes("no converter available") &&
      /docConvertVerdict\(process\.platform/.test(doc2pdfSrc),
  );
}

// --- P2-234: identity-file boot verdict (identityfile.ts) + wiring ----------

{
  const src = (rel: string[]) => readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");
  const identitySrc = src(["apps", "daemon", "src", "identityfile.ts"]);
  const indexSrc = src(["apps", "daemon", "src", "index.ts"]);

  const VALID =
    '{"room":"abc","ecdhPub":"pub","ecdhPriv":"priv","vapid":{"publicKey":"a","privateKey":"b"},"clients":[]}';

  // full verdict table — [exists, content, readFailure, expected plan]
  const table: Array<[boolean, string | null, string | null, IdentityVerdict["plan"]]> = [
    [false, null, null, "first-run"], // missing file → first run (unchanged path)
    [true, "", null, "first-run"], // existing but empty → first run
    [true, "  \n\t ", null, "first-run"], // whitespace-only → first run
    [true, "isto não é json {", null, "refuse"], // unparseable text
    [true, "[]", null, "refuse"], // JSON list
    [true, "42", null, "refuse"], // JSON number
    [true, '"texto"', null, "refuse"], // JSON string
    [true, '{"foo":1}', null, "refuse"], // object with no documented identity field
    [true, VALID, null, "use"], // valid identity object
    [true, null, "EACCES", "refuse"], // read failure with the file present
    [false, null, "EBUSY", "refuse"], // read failure with the file absent — NEVER first-run
  ];

  const verdicts = table.map(([ex, c, fail]) => identityVerdict(ex, c, fail));
  check(
    "P2-234: verdict table — every row lands on the documented plan",
    verdicts.every((v, i) => v.plan === table[i][3]),
  );
  check(
    "P2-234: a read failure is evaluated first — never first-run, never quarantine",
    identityVerdict(true, null, "EACCES").plan === "refuse" &&
      identityVerdict(true, null, "EACCES").quarantine === false &&
      identityVerdict(false, null, "EBUSY").plan === "refuse" &&
      identityVerdict(false, null, "EBUSY").quarantine === false,
  );
  check(
    "P2-234: only unreadable content asks for the quarantine move",
    identityVerdict(true, "{", null).quarantine === true &&
      identityVerdict(true, "[]", null).quarantine === true &&
      identityVerdict(true, '{"foo":1}', null).quarantine === true &&
      identityVerdict(false, null, null).quarantine === false &&
      identityVerdict(true, VALID, null).quarantine === false,
  );

  // message hygiene: static, short, no path, no URL scheme, never content
  const hostile = '{"ecdhPub":"MUITO-SECRETO-1234567890","vapid":{"privateKey":"CHAVE-PRIVADA-ABCD"}}';
  const allVerdicts = [
    ...verdicts,
    identityVerdict(true, hostile, null),
    identityVerdict(true, hostile.slice(0, 7), null),
    identityVerdict(true, null, "EACCES"),
  ];
  check(
    "P2-234: every message is non-empty and free of paths and URL schemes",
    allVerdicts.every(
      (v) =>
        v.message.trim().length > 0 &&
        !/[\\/]/.test(v.message) &&
        !/[A-Za-z]:/.test(v.message) &&
        !v.message.includes("://"),
    ),
  );
  check(
    "P2-234: no message ever echoes a fragment of the file content (private key)",
    allVerdicts.every(
      (v) =>
        !v.message.includes("MUITO-SECRETO") &&
        !v.message.includes("CHAVE-PRIVADA") &&
        !v.message.includes("ecdhPub") &&
        !v.message.includes("ecdhPriv") &&
        !v.message.includes("vapid"),
    ),
  );
  check(
    "P2-234: messages are the static exported phrases",
    verdicts.every((v, i) => {
      const expected =
        v.plan === "refuse"
          ? table[i][2] !== null
            ? IDENTITY_REFUSE_READ_MESSAGE
            : IDENTITY_REFUSE_CONTENT_MESSAGE
          : v.plan === "first-run"
            ? IDENTITY_FIRST_RUN_MESSAGE
            : IDENTITY_USE_MESSAGE;
      return v.message === expected;
    }),
  );

  // quarantineName: derivation, uniqueness, chronological order, never original
  const t1 = new Date("2026-09-06T03:04:05.123Z");
  const t2 = new Date("2026-09-06T03:04:05.124Z");
  const t3 = new Date("2026-12-31T23:59:59.999Z");
  const q1 = quarantineName("daemon.json", t1);
  const q2 = quarantineName("daemon.json", t2);
  const q3 = quarantineName("daemon.json", t3);
  check(
    "P2-234: quarantine name derives from the original plus a sortable stamp",
    q1.startsWith("daemon.json.") &&
      q1.endsWith(".quarantine") &&
      q1.includes("20260906T030405123Z"),
  );
  check("P2-234: two different stamps never collide", q1 !== q2 && q2 !== q3 && q1 !== q3);
  check(
    "P2-234: quarantine names sort chronologically as plain strings",
    [q1, q2, q3].every((q, i, arr) => i === 0 || arr[i - 1] < q) &&
      JSON.stringify([q3, q1, q2].sort()) === JSON.stringify([q1, q2, q3]),
  );
  check(
    "P2-234: quarantine name never equals the original and is never empty",
    ["daemon.json", "x", "", "   "].every(
      (n) => quarantineName(n, t1) !== n.trim() && quarantineName(n, t1).trim().length > 0,
    ),
  );

  // purity: unit tests must never boot a daemon on import
  // (strip line comments first — the header prose names the banned modules)
  const identityCode = identitySrc.replace(/\/\/.*$/gm, "");
  check(
    "P2-234: identityfile.ts is pure (no node:fs/crypto/child_process/path/os/fetch imports)",
    !/node:(fs|crypto|child_process|path|os|http)/.test(identityCode) && !/\bfetch\(/.test(identityCode),
  );

  // real-repo wiring: the identity read goes through the verdict, exactly once
  // at boot; the refuse path moves and never deletes, never recreates the
  // identity, and no periodic timer was introduced.
  const refuseAt = indexSrc.indexOf('verdict.plan === "refuse"');
  const exitAt = indexSrc.indexOf("process.exit(78)");
  const refuseBlock = refuseAt >= 0 && exitAt > refuseAt ? indexSrc.slice(refuseAt, exitAt) : "";
  check(
    "P2-234: the daemon reads the identity through the verdict, exactly once at boot",
    (indexSrc.match(/identityVerdict\(/g) || []).length === 1 &&
      indexSrc.indexOf("async function loadIdentity") < indexSrc.indexOf("identityVerdict(") &&
      indexSrc.includes('quarantineName(basename(STATE_FILE'),
  );
  check(
    "P2-234: the refuse path moves the file to quarantine and never deletes it",
    refuseBlock.includes("quarantineName(") &&
      refuseBlock.includes("renameSync(") &&
      refuseBlock.includes("chmodSync(") &&
      refuseBlock.includes('audit("identity.unreadable"') &&
      refuseBlock.includes('log("error", verdict.message') &&
      !/unlink|rmsync|rm\(/i.test(refuseBlock),
  );
  check(
    "P2-234: the refuse path never recreates the identity and exits with the documented code",
    !refuseBlock.includes("newIdentity") &&
      !refuseBlock.includes("writeStateAtomic") &&
      indexSrc.includes("process.exit(78)"),
  );
  check(
    "P2-234: no periodic identity timer was introduced",
    indexSrc
      .split("\n")
      .filter((l) => l.includes("setInterval"))
      .every((l) => !/identity/i.test(l)),
  );
}


// --- P2-235: right-click context menu (ctxmenu.ts) ---------------------------
{
  const allow = externalOpenDecision("https://example.com/docs");
  const refuse = externalOpenDecision("file:///etc/passwd");
  const base: Parameters<typeof contextMenuSpec>[3] = {
    editable: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canSelectAll: false,
    selectionText: "",
    linkUrl: "",
    misspelledWord: "",
    suggestions: [],
  };
  const spec = (
    harnessSession: boolean,
    packaged: boolean,
    decision: ReturnType<typeof externalOpenDecision>,
    over: Partial<typeof base> = {},
  ) => contextMenuSpec(harnessSession, packaged, decision, { ...base, ...over });

  // rule 1 — the harness-session rule is FIRST: selection, editable field,
  // link, misspelling and dev mode together still produce an empty list.
  check(
    "P2-235: harness session with selection and link → empty list",
    spec(true, false, allow, { selectionText: "trecho", canCopy: true, linkUrl: "https://example.com/x" }).length === 0,
  );
  check(
    "P2-235: harness session is empty even fully loaded in a dev build",
    spec(true, false, allow, {
      editable: true,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
      selectionText: "x",
      linkUrl: "https://example.com/x",
      misspelledWord: "errro",
      suggestions: ["erro"],
    }).length === 0,
  );

  // rule 2 — packaged NEVER renders Inspect Element; dev (unpackaged,
  // non-harness) does.
  check(
    "P2-235: packaged never renders Inspecionar elemento",
    spec(false, true, allow, { editable: true, canPaste: true }).every((i) => i.id !== "ctx-inspect"),
  );
  const devOnly = spec(false, false, allow, {});
  check(
    "P2-235: unpackaged outside harness renders Inspecionar elemento",
    devOnly.length === 1 && devOnly[0]?.id === "ctx-inspect" && devOnly[0]?.label === "Inspecionar elemento",
  );

  // editable field: paste flag on → Colar; paste flag off → no Colar at all
  const editablePaste = spec(false, true, allow, {
    editable: true,
    canCut: true,
    canCopy: true,
    canPaste: true,
    canSelectAll: true,
  });
  check(
    "P2-235: editable with canPaste renders Colar",
    editablePaste.some((i) => i.id === "ctx-paste" && i.label === "Colar"),
  );
  const editableNoPaste = spec(false, true, allow, {
    editable: true,
    canCut: true,
    canCopy: true,
    canSelectAll: true,
  });
  check(
    "P2-235: editable with canPaste off renders no Colar",
    editableNoPaste.every((i) => i.id !== "ctx-paste"),
  );

  // selection outside an editable field: Copiar, never Colar
  const sel = spec(false, true, allow, { canCopy: true, selectionText: "trecho selecionado" });
  check(
    "P2-235: selection outside editable renders Copiar and never Colar",
    sel.some((i) => i.id === "ctx-copy" && i.label === "Copiar") && sel.every((i) => i.id !== "ctx-paste"),
  );

  // nothing selected, not editable, packaged: only the documented items (none)
  check(
    "P2-235: nothing selected and not editable renders no edit items",
    spec(false, true, allow, {}).every(
      (i) => !["ctx-cut", "ctx-copy", "ctx-paste", "ctx-select-all"].includes(i.id ?? ""),
    ),
  );

  // link actions follow the extlink verdict: approved → open + copy address,
  // refused → at most copy address, never open.
  const openLink = spec(false, true, allow, { linkUrl: "https://example.com/docs" });
  check(
    "P2-235: approved link renders Abrir link + Copiar endereço do link",
    openLink.some((i) => i.id === "ctx-open-link" && i.label === "Abrir link") &&
      openLink.some((i) => i.id === "ctx-copy-link" && i.label === "Copiar endereço do link"),
  );
  const refusedLink = spec(false, true, refuse, { linkUrl: "file:///etc/passwd" });
  check(
    "P2-235: refused link renders only copy address, never open",
    refusedLink.some((i) => i.id === "ctx-copy-link") && refusedLink.every((i) => i.id !== "ctx-open-link"),
  );

  // spelling suggestions: capped at the documented ceiling, never above;
  // an empty suggestion list renders no suggestion item at all.
  const capped = spec(false, true, allow, {
    misspelledWord: "errro",
    suggestions: ["erro", "terra", "erros", "terro", "retro", "erro3"],
  });
  const spellItems = capped.filter((i) => (i.id ?? "").startsWith("ctx-spell-"));
  check(
    "P2-235: suggestions are capped at the documented ceiling",
    spellItems.length === SPELLING_SUGGESTIONS_MAX && spellItems.length < 6,
  );
  check(
    "P2-235: empty suggestion list renders no suggestion item",
    spec(false, true, allow, { misspelledWord: "errro", suggestions: [] }).every(
      (i) => !(i.id ?? "").startsWith("ctx-spell-"),
    ),
  );

  // stable ordering between two calls with the same input
  const stable: Parameters<typeof contextMenuSpec>[3] = {
    editable: true,
    canCut: true,
    canCopy: true,
    canPaste: true,
    canSelectAll: true,
    selectionText: "x",
    linkUrl: "https://example.com/x",
    misspelledWord: "errro",
    suggestions: ["erro", "terra"],
  };
  check(
    "P2-235: item order is stable between two calls with the same input",
    JSON.stringify(contextMenuSpec(false, false, allow, stable)) ===
      JSON.stringify(contextMenuSpec(false, false, allow, stable)),
  );

  // copy discipline: short pt-BR labels, no emoji (P2-118/P2-107), no absolute
  // file path, no URL scheme in any label
  const kitchen = contextMenuSpec(false, false, allow, stable);
  const BANNED = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2500}-\u{25FF}\u{FE0F}]/u;
  check(
    "P2-235: labels are path-free, scheme-free and emoji-free",
    kitchen
      .filter((i) => typeof i.label === "string")
      .every(
        (i) =>
          (i.label as string).length > 0 &&
          !i.label!.includes("/") &&
          !i.label!.includes("\\") &&
          !i.label!.includes("://") &&
          !i.label!.includes("file:") &&
          !i.label!.includes("http:") &&
          !BANNED.test(i.label as string),
      ),
  );
  check(
    "P2-235: no dangling separator and none as first or last item",
    (() => {
      const kinds = kitchen.map((i) => (i.type === "separator" ? "sep" : "item"));
      return kinds[0] === "item" && kinds[kinds.length - 1] === "item" && kinds.every((k, i) => k === "item" || kinds[i - 1] === "item");
    })(),
  );

  // module purity: same hygiene as menu.ts/hotkey.ts (no electron, no node
  // builtins, no I/O, no timers — comments stripped before the check)
  const ctxSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "ctxmenu.ts"), "utf8");
  const ctxCode = ctxSrc.replace(/\/\/.*$/gm, "");
  check(
    "P2-235: ctxmenu.ts is pure — no electron/node builtins/timers",
    !/electron|node:|require\(|setInterval|setTimeout|\bfetch\(/.test(ctxCode),
  );

  // the scheme verdict type comes from the existing extlink module
  check(
    "P2-235: ctxmenu.ts takes the link verdict from extlink.ts (P2-178)",
    ctxCode.includes('from "./extlink"'),
  );

  // real main.ts: ONE context-menu listener, harness flag consulted first, the
  // verdict from extlink, an empty list meaning no menu, and no new timer or
  // IPC channel anywhere in the block.
  const mainSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  check(
    "P2-235: main.ts registers exactly one context-menu listener",
    (mainSrc.match(/on\("context-menu"/g) ?? []).length === 1,
  );
  check(
    "P2-235: main.ts feeds HERMETIC_E2E (harness session) as the first spec input",
    /win\.webContents\.on\("context-menu", \(_event, params\) => \{[\s\S]*?contextMenuSpec\(HERMETIC_E2E, app\.isPackaged, decision,/.test(mainSrc),
  );
  check(
    "P2-235: main.ts resolves the context-menu link verdict through externalOpenDecision",
    mainSrc.includes("externalOpenDecision(params.linkURL)"),
  );
  check(
    "P2-235: main.ts shows no menu when the spec list is empty",
    mainSrc.includes("if (items.length === 0) return;"),
  );
  const ctxListenerAt = mainSrc.indexOf('win.webContents.on("context-menu"');
  const ctxListenerBlock = ctxListenerAt >= 0 ? mainSrc.slice(ctxListenerAt, ctxListenerAt + 2400) : "";
  check(
    "P2-235: the context-menu block introduces no timer and no IPC channel",
    ctxListenerBlock.length > 0 &&
      !ctxListenerBlock.includes("setInterval") &&
      !ctxListenerBlock.includes("setTimeout") &&
      !ctxListenerBlock.includes("ipcMain"),
  );

  // in the pure module the harness rule is literally the first consulted rule,
  // before the packaged rule and before any label is emitted
  const specBody = ctxSrc.slice(ctxSrc.indexOf("export function contextMenuSpec"));
  check(
    "P2-235: in the pure spec the harness-session rule is the first consulted",
    specBody.indexOf("if (harnessSession) return [];") >= 0 &&
      specBody.indexOf("if (harnessSession) return [];") < specBody.indexOf("packaged ?") &&
      specBody.indexOf("if (harnessSession) return [];") < specBody.indexOf("Recortar"),
  );
}

// --- P2-236: routine run lease (routinelease.ts) + wiring -------------------

{
  const src = (rel: string[]) => readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");
  const leaseSrc = src(["apps", "daemon", "src", "routinelease.ts"]);
  const routinesSrc = src(["apps", "daemon", "src", "routines.ts"]);
  const daemonIndexSrc = src(["apps", "daemon", "src", "index.ts"]);

  // --- parseRunLease table -------------------------------------------------

  check(
    "P2-236: parseRunLease — an empty env keeps the documented default with no problem",
    parseRunLease({}).leaseMs === DEFAULT_RUN_LEASE_MS &&
      parseRunLease({}).problems.length === 0 &&
      parseRunLease({ OCR_RUN_LEASE_MS: "   " }).leaseMs === DEFAULT_RUN_LEASE_MS &&
      parseRunLease({ OCR_RUN_LEASE_MS: "   " }).problems.length === 0,
  );
  check(
    "P2-236: parseRunLease — a valid whole positive ms value is accepted as-is",
    parseRunLease({ OCR_RUN_LEASE_MS: "3600000" }).leaseMs === 3_600_000 &&
      parseRunLease({ OCR_RUN_LEASE_MS: "3600000" }).problems.length === 0,
  );
  check(
    "P2-236: parseRunLease — the documented off keyword disables the lease",
    parseRunLease({ OCR_RUN_LEASE_MS: "off" }).leaseMs === RUN_LEASE_OFF_MS &&
      parseRunLease({ OCR_RUN_LEASE_MS: "off" }).problems.length === 0 &&
      parseRunLease({ OCR_RUN_LEASE_MS: " OFF " }).leaseMs === RUN_LEASE_OFF_MS,
  );
  const badLeases: Array<[string, string]> = [
    ["abc", "non-numeric"],
    ["0", "zero"],
    ["-5", "negative"],
    ["1500.5", "fractional"],
    [String(RUN_LEASE_CEILING_MS + 1), "above ceiling"],
  ];
  check(
    "P2-236: parseRunLease — non-numeric, zero, negative, fractional and above-ceiling are all problems",
    badLeases.every(
      ([raw]) =>
        parseRunLease({ OCR_RUN_LEASE_MS: raw }).problems.length === 1 &&
        parseRunLease({ OCR_RUN_LEASE_MS: raw }).leaseMs === DEFAULT_RUN_LEASE_MS,
    ),
  );
  check(
    "P2-236: parseRunLease — several problems accumulate from one value without short-circuit",
    parseRunLease({ OCR_RUN_LEASE_MS: "-2.5" }).problems.length === 2,
  );

  // --- leaseVerdict table --------------------------------------------------

  const LEASE = DEFAULT_RUN_LEASE_MS; // the documented 2 h default, explicit here
  const NOW = 1_000_000_000_000;

  check("P2-236: leaseVerdict — an empty list yields nothing to do", leaseVerdict(NOW, LEASE, []).length === 0);

  const scenarios: Array<[string, RoutineRunFacts, string]> = [
    ["not in flight with an ancient start stamp survives", { id: "r", inFlight: false, startedAt: NOW - LEASE * 10 }, "none"],
    ["in flight within the lease survives", { id: "r", inFlight: true, startedAt: NOW - LEASE + 1 }, "none"],
    // the documented threshold: a run exactly at the lease boundary is NOT killed
    ["in flight exactly at the lease threshold survives", { id: "r", inFlight: true, startedAt: NOW - LEASE }, "none"],
    ["in flight strictly older than the lease is killed", { id: "r", inFlight: true, startedAt: NOW - LEASE - 1 }, "kill"],
    ["in flight without a start stamp is stamped", { id: "r", inFlight: true }, "stamp"],
  ];
  check(
    "P2-236: leaseVerdict — the full plan table lands on the documented plan",
    scenarios.every(([, facts, plan]) => leaseVerdict(NOW, LEASE, [facts])[0].plan === plan),
  );

  const pass1 = leaseVerdict(1000, LEASE, [{ id: "r1", inFlight: true }])[0];
  const pass2 = leaseVerdict(1000 + LEASE + 1, LEASE, [{ id: "r1", inFlight: true, startedAt: 1000 }])[0];
  check(
    "P2-236: leaseVerdict — the same routine is killed only on a later pass, after stamp + lease",
    pass1.plan === "stamp" && pass2.plan === "kill",
  );
  check(
    "P2-236: leaseVerdict — a stamped run is never killed in the same pass it got the stamp",
    leaseVerdict(1000, LEASE, [{ id: "r1", inFlight: true }]).every((v) => v.plan !== "kill"),
  );
  check(
    "P2-236: leaseVerdict — a disabled lease returns nothing to do even for an ancient in-flight run",
    leaseVerdict(NOW, RUN_LEASE_OFF_MS, [
      { id: "old", inFlight: true, startedAt: NOW - LEASE * 10 },
      { id: "nostamp", inFlight: true },
      { id: "idle", inFlight: false },
    ]).every((v) => v.plan === "none"),
  );

  const mixed: RoutineRunFacts[] = [
    { id: "a", inFlight: true, startedAt: NOW - LEASE - 1 },
    { id: "b", inFlight: false, startedAt: NOW - LEASE * 10 },
    { id: "c", inFlight: true },
    { id: "d", inFlight: true, startedAt: NOW },
  ];
  check(
    "P2-236: leaseVerdict — iteration order is preserved and every id comes from the input list",
    JSON.stringify(leaseVerdict(NOW, LEASE, mixed)) ===
      JSON.stringify([
        { id: "a", plan: "kill" },
        { id: "b", plan: "none" },
        { id: "c", plan: "stamp" },
        { id: "d", plan: "none" },
      ]) &&
      leaseVerdict(NOW, LEASE, mixed).every((v) => mixed.some((m) => m.id === v.id)),
  );

  // --- kill phrase hygiene --------------------------------------------------

  check(
    "P2-236: the kill phrase is static, short, path-free, URL-scheme-free and session-free",
    RUN_LEASE_KILL_MESSAGE.length > 0 &&
      RUN_LEASE_KILL_MESSAGE.length <= 200 &&
      RUN_LEASE_KILL_MESSAGE === RUN_LEASE_KILL_MESSAGE.trim() &&
      !/[\\/]/.test(RUN_LEASE_KILL_MESSAGE) &&
      !/[A-Za-z]:/.test(RUN_LEASE_KILL_MESSAGE) &&
      !/https?:/i.test(RUN_LEASE_KILL_MESSAGE) &&
      !/\bses[a-z0-9]{6,}/i.test(RUN_LEASE_KILL_MESSAGE),
  );

  // --- purity + real-repo wiring --------------------------------------------

  // strip block + line comments first — the header prose names the banned modules
  const leaseCode = leaseSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check(
    "P2-236: routinelease.ts is pure (no node:fs/child_process/path/os/http imports, no fetch)",
    !/node:(fs|child_process|path|os|http)/.test(leaseCode) && !/\bfetch\(/.test(leaseCode),
  );
  check(
    "P2-236: Routine gains runStartedAt additively — the on-disk marker fields are untouched",
    routinesSrc.includes("runStartedAt?: number;") &&
      routinesSrc.includes("lastSessionID?: string;") &&
      routinesSrc.includes("lastStatus?:") &&
      routinesSrc.includes("lastError?:"),
  );

  const fireAt = daemonIndexSrc.indexOf("async function fireRoutine");
  const stampAt = daemonIndexSrc.indexOf("r.runStartedAt = Date.now();");
  check(
    "P2-236: the run start is stamped where the in-flight marker is written (fireRoutine, all modes)",
    stampAt > fireAt && stampAt < fireAt + 800 && daemonIndexSrc.includes("r.lastSessionID = created.id;"),
  );

  const sweepAt = daemonIndexSrc.indexOf("function checkRoutines");
  const sweepEnd = daemonIndexSrc.indexOf("setInterval(checkRoutines");
  check(
    "P2-236: the lease verdict is consulted inside the existing periodic sweep",
    sweepAt >= 0 &&
      sweepEnd > sweepAt &&
      daemonIndexSrc.indexOf("leaseVerdict(") > sweepAt &&
      daemonIndexSrc.indexOf("leaseVerdict(") < sweepEnd,
  );

  const releaseAt = daemonIndexSrc.indexOf("function releaseStuckRun");
  const releaseBlock = releaseAt >= 0 ? daemonIndexSrc.slice(releaseAt, sweepAt) : "";
  check(
    "P2-236: the release path clears the in-flight marker and never deletes the routine",
    releaseBlock.includes("pendingRuns.delete(") &&
      releaseBlock.includes("r.lastSessionID = undefined;") &&
      releaseBlock.includes('r.lastError = RUN_LEASE_KILL_MESSAGE;') &&
      releaseBlock.includes("saveRoutines(routines);") &&
      !/splice|\.filter\(|\.pop\(/.test(releaseBlock),
  );

  const mainAt = daemonIndexSrc.indexOf("async function main");
  check(
    "P2-236: an invalid OCR_RUN_LEASE_MS refuses the boot next to the other knobs (fail-closed)",
    daemonIndexSrc.includes("const runLease = parseRunLease(process.env);") &&
      mainAt >= 0 &&
      daemonIndexSrc.indexOf("if (runLease.problems.length > 0)") > mainAt,
  );
  check(
    "P2-236: no periodic lease timer was introduced",
    daemonIndexSrc
      .split("\n")
      .filter((l) => l.includes("setInterval"))
      .every((l) => !/lease|stuck/i.test(l)),
  );
}

// --- P2-239: the real service-worker policy, loaded in an isolated VM -------

// The policy module is a classic script: no import/export, no fetch, no
// caches, no listeners, no mutable global state — decisions only.
import vm from "node:vm";

const swPolicySrc = readFileSync(
  new URL("../apps/web/public/sw-policy.js", import.meta.url),
  "utf8",
);
const swSrc = readFileSync(new URL("../apps/web/public/sw.js", import.meta.url), "utf8");

const swSandbox: Record<string, unknown> = {};
swSandbox.self = swSandbox;
vm.createContext(swSandbox);
vm.runInContext(swPolicySrc, swSandbox, { filename: "apps/web/public/sw-policy.js" });
const swPolicy = swSandbox as unknown as {
  precacheTargets: (rootDocument: string) => string[];
  strategyFor: (path: string, method?: string) => string;
  offlineDocument: () => string;
  staleEntries: (cachedPaths: string[], currentTargets: string[]) => string[];
};

const htmlDoc = (head: string) =>
  `<!doctype html><html><head>${head}</head><body><div id="root"></div></body></html>`;
const VITE_JS = "/assets/index-B3iKfWlp.js";
const VITE_CSS = "/assets/index-DiSUPidX.css";
const LEGACY_ASSET = "/assets/vendor.a1b2c3d4.css";

check(
  "P2-239: precacheTargets — empty document -> empty list, never throws",
  JSON.stringify(swPolicy.precacheTargets("")) === "[]" &&
    JSON.stringify(swPolicy.precacheTargets(undefined as unknown as string)) === "[]",
);

check(
  "P2-239: precacheTargets — document without references -> empty list",
  JSON.stringify(swPolicy.precacheTargets(htmlDoc("<meta charset=\"utf-8\"><p>hello</p>"))) === "[]",
);

check(
  "P2-239: precacheTargets — two versioned assets in stable order of appearance",
  JSON.stringify(
    swPolicy.precacheTargets(
      htmlDoc(`<link rel="stylesheet" href="${VITE_CSS}"><script type="module" src="${VITE_JS}"></script>`),
    ),
  ) === JSON.stringify([VITE_CSS, VITE_JS]),
);

check(
  "P2-239: precacheTargets — a repeated reference appears exactly once",
  JSON.stringify(
    swPolicy.precacheTargets(htmlDoc(`<link href="${VITE_CSS}"><link href="${VITE_CSS}">`)),
  ) === JSON.stringify([VITE_CSS]),
);

check(
  "P2-239: precacheTargets — other origins and protocol-relative addresses ignored",
  JSON.stringify(
    swPolicy.precacheTargets(
      htmlDoc(
        `<link href="https://evil.example/x.js"><script src="//cdn.example/y.js"></script><link href="${VITE_CSS}">`,
      ),
    ),
  ) === JSON.stringify([VITE_CSS]),
);

check(
  "P2-239: precacheTargets — data: URIs and anchors ignored",
  JSON.stringify(
    swPolicy.precacheTargets(
      htmlDoc(
        `<img src="data:image/png;base64,AAAA"><a href="#top">t</a><link href="${VITE_CSS}#map">`,
      ),
    ),
  ) === JSON.stringify([VITE_CSS]),
);

check(
  "P2-239: strategyFor — versioned assets are cache-first (Vite and legacy hash styles)",
  swPolicy.strategyFor(VITE_JS) === "cache-first" &&
    swPolicy.strategyFor(LEGACY_ASSET) === "cache-first",
);

check(
  "P2-239: strategyFor — plain words and counters never read as hashes",
  swPolicy.strategyFor("/manual-download.pdf") === "network-first-nosave" &&
    swPolicy.strategyFor("/icon-512.png") === "network-first-nosave" &&
    swPolicy.strategyFor("/recorder-worklet.js") === "network-first-nosave",
);

check(
  "P2-239: strategyFor — the navigation document is network-first",
  swPolicy.strategyFor("/") === "network-first" &&
    swPolicy.strategyFor("/index.html") === "network-first",
);

check(
  "P2-239: strategyFor — unknown paths are network-first without recording",
  swPolicy.strategyFor("/settings") === "network-first-nosave" &&
    swPolicy.strategyFor("/manifest.webmanifest") === "network-first-nosave",
);

check(
  "P2-239: strategyFor — non-GET always goes to the network without recording, even versioned",
  swPolicy.strategyFor(VITE_JS, "POST") === "network-first-nosave" &&
    swPolicy.strategyFor("/", "HEAD") === "network-first-nosave" &&
    swPolicy.strategyFor(LEGACY_ASSET, "PUT") === "network-first-nosave",
);

check(
  "P2-239: staleEntries — leftovers of an earlier publication are returned, order preserved",
  JSON.stringify(
    swPolicy.staleEntries(
      ["/assets/old-Aaaaaaa1.js", "/", VITE_JS, "/assets/old-Bbbbbbb2.css", "/icon.svg"],
      [VITE_JS],
    ),
  ) === JSON.stringify(["/assets/old-Aaaaaaa1.js", "/assets/old-Bbbbbbb2.css"]),
);

check(
  "P2-239: staleEntries — current targets are never returned, neither is the root document",
  JSON.stringify(swPolicy.staleEntries(["/", "/index.html", VITE_JS], [VITE_JS, "/index.html"])) ===
    "[]" &&
    JSON.stringify(swPolicy.staleEntries(["/"], [])) === "[]",
);

check(
  "P2-239: staleEntries — never returns a path outside the received list",
  swPolicy
    .staleEntries(["/assets/old-Ccccccc3.js"], ["/assets/other-Dddddd4.js"])
    .every((p) => p === "/assets/old-Ccccccc3.js"),
);

check(
  "P2-239: decisions are stable across repeated calls with the same input",
  JSON.stringify(swPolicy.precacheTargets(htmlDoc(`<script src="${VITE_JS}"></script>`))) ===
    JSON.stringify(swPolicy.precacheTargets(htmlDoc(`<script src="${VITE_JS}"></script>`))) &&
    swPolicy.strategyFor(VITE_JS) === swPolicy.strategyFor(VITE_JS) &&
    JSON.stringify(swPolicy.staleEntries([VITE_CSS], [])) ===
      JSON.stringify(swPolicy.staleEntries([VITE_CSS], [])),
);

const offlineHtml = swPolicy.offlineDocument();
check(
  "P2-239: offlineDocument — static, Portuguese, short and self-contained",
  offlineHtml === swPolicy.offlineDocument() &&
    offlineHtml.includes("<!doctype html>") &&
    /conexão/i.test(offlineHtml) &&
    !offlineHtml.includes("://") &&
    !/https?:/i.test(offlineHtml) &&
    !/href=|src=/i.test(offlineHtml) &&
    !/\/(Users|home|var|tmp)\//.test(offlineHtml) &&
    !/session|sessid|token/i.test(offlineHtml),
);

// Source pins on the two real public files: the worker must orchestrate only.
const swCode = swSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const policyCode = swPolicySrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check(
  "P2-239: importScripts of the policy is the first instruction of sw.js",
  swCode.trim().startsWith('importScripts("/sw-policy.js")'),
);

check(
  "P2-239: none of the five decisions is reimplemented inside sw.js",
  swSrc.includes("self.precacheTargets(") &&
    swSrc.includes("self.strategyFor(url.pathname, event.request.method)") &&
    swSrc.includes("self.offlineDocument()") &&
    swSrc.includes("self.staleEntries(") &&
    !swSrc.includes("[A-Za-z0-9") &&
    !swSrc.includes("(?:") &&
    !/<!doctype|<html/i.test(swSrc),
);

check(
  "P2-239: the cache name moved on so the new publication inherits nothing",
  swSrc.includes('const CACHE = "ocr-shell-v3"') && !swSrc.includes("ocr-shell-v2"),
);

check(
  "P2-239: sw-policy.js is a pure classic script and the only home of the decisions",
  !/^\s*(import|export)\b/m.test(policyCode) &&
    !policyCode.includes("fetch(") &&
    !policyCode.includes("caches") &&
    !policyCode.includes("addEventListener") &&
    !/\b(let|var)\b/.test(policyCode) &&
    ["precacheTargets", "strategyFor", "offlineDocument", "staleEntries"].every((fn) =>
      policyCode.includes(`self.${fn} = ${fn};`),
    ) &&
    policyCode.includes('"cache-first"') &&
    policyCode.includes('"network-first"') &&
    policyCode.includes('"network-first-nosave"'),
);

// --- P2-240: honest queue view (backlogview.ts) ---------------------------------
{
  const s = (text: string) => backlogSections(text);

  // backlogSections — full table
  check("P2-240: backlogSections — empty text yields no sections without throwing", JSON.stringify(s("")) === "[]");
  check(
    "P2-240: backlogSections — text without any heading yields no sections",
    JSON.stringify(s("just prose\nmore prose\n- [ ] (P9-9) [P2] not a section\n")) === "[]",
  );
  check(
    "P2-240: backlogSections — a section ends at the NEXT heading of the same level",
    (() => {
      const r = s("# Top\nintro\n## Ready\n- [ ] (P1-1) [P1] a — t\n### deep\nstill ready\n## Blocked\n- [ ] (P1-2) [P1] b — t\n# Tail\ntail body");
      return (
        r.length === 5 &&
        r[0]!.heading === "Top" && r[0]!.level === 1 && JSON.stringify(r[0]!.lines) === JSON.stringify(["intro", "## Ready", "- [ ] (P1-1) [P1] a — t", "### deep", "still ready", "## Blocked", "- [ ] (P1-2) [P1] b — t"]) &&
        r[1]!.heading === "Ready" && r[1]!.level === 2 && JSON.stringify(r[1]!.lines) === JSON.stringify(["- [ ] (P1-1) [P1] a — t", "### deep", "still ready"]) &&
        r[2]!.heading === "deep" && r[2]!.level === 3 &&
        r[3]!.heading === "Blocked" && r[3]!.level === 2 && JSON.stringify(r[3]!.lines) === JSON.stringify(["- [ ] (P1-2) [P1] b — t", "# Tail", "tail body"]) &&
        r[4]!.heading === "Tail" && r[4]!.level === 1 && JSON.stringify(r[4]!.lines) === JSON.stringify(["tail body"])
      );
    })(),
  );
  check(
    "P2-240: backlogSections — repeated same-level headings each start their own section, read order preserved",
    (() => {
      const r = s("## Blocked\none\n## Blocked\ntwo\n## Done\nx");
      return (
        r.length === 3 &&
        r[0]!.heading === "Blocked" && JSON.stringify(r[0]!.lines) === JSON.stringify(["one"]) &&
        r[1]!.heading === "Blocked" && JSON.stringify(r[1]!.lines) === JSON.stringify(["two"]) &&
        r[2]!.heading === "Done" && r[2]!.lines.length === 1
      );
    })(),
  );

  // queueView — full table
  const q = (text: string) => queueView(text);
  check("P2-240: queueView — empty text yields empty lists without throwing", q("").ready.length === 0 && q("").blocked.length === 0 && q("").misplaced === 0);
  check(
    "P2-240: queueView — text without any heading yields empty lists (all unmarked lines are misplaced ground)",
    (() => {
      const r = q("loose\n- [ ] (P9-1) [P2] orphan — t\n");
      return r.ready.length === 0 && r.blocked.length === 0 && r.misplaced === 1;
    })(),
  );
  check(
    "P2-240: queueView — empty Ready with a full Blocked section yields zero ready",
    (() => {
      const r = q("## Ready\n\n## Blocked\n- [ ] (P2-109) [P2] parked — spec: x (area: web)\n");
      return r.ready.length === 0 && r.blocked.length === 1 && r.blocked[0]!.id === "P2-109" && r.blocked[0]!.area === "web";
    })(),
  );
  check(
    "P2-240: queueView — three repeated Blocked sections sum every line exactly once",
    (() => {
      const r = q("## Ready\n\n## Blocked\n- [ ] (P1-1) [P2] a — t\n\n## Blocked\n- [ ] (P1-2) [P2] b — t\n\n## Blocked\n- [ ] (P1-3) [P2] c — t\n");
      return (
        r.ready.length === 0 &&
        r.blocked.length === 3 &&
        JSON.stringify(r.blocked.map((x) => x.id)) === JSON.stringify(["P1-1", "P1-2", "P1-3"])
      );
    })(),
  );
  check(
    "P2-240: queueView — unmarked line inside Done stays out of both lists and counts as misplaced",
    (() => {
      const r = q("## Ready\n\n## Done\n- [ ] (P0-9) [P1] ghost line quoted in a done spec — t\n");
      return r.ready.length === 0 && r.blocked.length === 0 && r.misplaced === 1;
    })(),
  );
  check(
    "P2-240: queueView — a done-marked line never enters either list",
    (() => {
      const r = q("## Ready\n- [x] (P1-1) [P1] finished — t\n## Blocked\n- [x] (P1-2) [P1] also done — t\n");
      return r.ready.length === 0 && r.blocked.length === 0 && r.misplaced === 0;
    })(),
  );
  check(
    "P2-240: queueView — a line without an area tag yields an empty area",
    (() => {
      const r = q("## Ready\n- [ ] (P2-5) [P2] no tag here — t\n");
      return r.ready.length === 1 && r.ready[0]!.area === "";
    })(),
  );
  check(
    "P2-240: queueView — a line that does not match the format degrades without throwing",
    (() => {
      const r = q("## Ready\n- [ ] free-form line nobody can parse\n");
      return r.ready.length === 1 && r.ready[0]!.id === "?" && r.ready[0]!.title === "- [ ] free-form line nobody can parse" && r.ready[0]!.area === "";
    })(),
  );
  check(
    "P2-240: queueView — read order is preserved in both lists",
    (() => {
      const r = q("## Ready\n- [ ] (P1-9) [P1] first — t\n- [ ] (P1-2) [P1] second — t\n## Blocked\n- [ ] (P1-8) [P2] third — t\n- [ ] (P1-3) [P2] fourth — t\n");
      return (
        JSON.stringify(r.ready.map((x) => x.id)) === JSON.stringify(["P1-9", "P1-2"]) &&
        JSON.stringify(r.blocked.map((x) => x.id)) === JSON.stringify(["P1-8", "P1-3"])
      );
    })(),
  );
  check(
    "P2-240: queueView — the same identifier never appears in both lists (first occurrence wins)",
    (() => {
      const r = q("## Ready\n- [ ] (P1-1) [P1] live — t\n## Blocked\n- [ ] (P1-1) [P1] same id again — t\n- [ ] (P1-2) [P1] blocked — t\n## Ready\n- [ ] (P1-2) [P1] echo — t\n");
      return (
        r.ready.length === 1 && r.ready[0]!.id === "P1-1" &&
        r.blocked.length === 1 && r.blocked[0]!.id === "P1-2"
      );
    })(),
  );
  check(
    "P2-240: queueView — stable result across two calls with the same input",
    (() => {
      const text = "## Ready\n- [ ] (P1-1) [P1] a — t (area: daemon)\n## Blocked\n- [ ] (P1-2) [P2] b — t\n## Done\n- [ ] ghost\n";
      return JSON.stringify(q(text)) === JSON.stringify(q(text));
    })(),
  );

  // Real-repo assertions against today's BACKLOG.md: the panel must never
  // again report a ready task that lives outside ## Ready.
  const backlogText = readFileSync(new URL("../BACKLOG.md", import.meta.url), "utf8");
  const backlog = q(backlogText);
  const readyIds = new Set(backlog.ready.map((t) => t.id));
  check(
    "P2-240: real BACKLOG.md — no identifier appears in both lists at once",
    backlog.ready.every((t) => !backlog.blocked.some((b) => b.id === t.id)) &&
      new Set([...backlog.ready, ...backlog.blocked].map((t) => t.id)).size === backlog.ready.length + backlog.blocked.length,
  );
  check(
    "P2-240: real BACKLOG.md — no line living under ## Done leaks into ready",
    (() => {
      const doneIdx = backlogText.split("\n").lastIndexOf("## Done");
      if (doneIdx < 0) return true;
      const doneIds = new Set(
        backlogText
          .split("\n")
          .slice(doneIdx)
          .filter((l) => l.startsWith("- [x]"))
          .map((l) => l.match(/\(([P\d][\w.-]*)\)/)?.[1]),
      );
      return backlog.ready.every((t) => !doneIds.has(t.id)) && !readyIds.has("?");
    })(),
  );

  // Source pins on the real route: section-aware module, unchanged body, no new timers.
  const backlogViewSrc = readFileSync(new URL("../apps/daemon/src/backlogview.ts", import.meta.url), "utf8");
  const routeSrc = readFileSync(new URL("../apps/daemon/src/index.ts", import.meta.url), "utf8");
  check(
    "P2-240: backlogview stays pure — no node: builtins, no child_process, no fetch",
    !backlogViewSrc.includes("node:") && !backlogViewSrc.includes("child_process") && !backlogViewSrc.includes("fetch("),
  );
  check(
    "P2-240: the route consumes the module and no longer slices the file by heading",
    routeSrc.includes("const view = queueView(md);") &&
      !routeSrc.includes('md.split("\\n## Ready\\n")') &&
      !routeSrc.includes('md.split("## Ready\\n")') &&
      !routeSrc.includes('md.split("\\n## Blocked\\n")'),
  );
  check(
    "P2-240: the response body is byte-identical in shape ({ ready, blocked } of { id, title, area })",
    routeSrc.includes("send(200, { ready, blocked });") && !routeSrc.includes("view.misplaced"),
  );
  check(
    "P2-240: no new periodic timer was introduced by the route change",
    (routeSrc.match(/setInterval\(/g) || []).length === 5,
  );
}

// --- P2-242: boot-smoke parity — CI boots the real package like release -----

{
  const wfJob = (name: string, platform: string, steps: WorkflowStep[]): WorkflowJob => ({ name, platform, steps });
  const wfStep = (run: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
    name: extra.name ?? "step",
    run,
    shell: extra.shell ?? null,
    timeoutMinutes: extra.timeoutMinutes ?? null,
  });
  const pkg = wfStep("npm run dist --workspace @ocr/desktop -- --mac --dir", { name: "Package mac bundle" });
  const boot = (extra: Partial<WorkflowStep> = {}): WorkflowStep =>
    wfStep('node apps/desktop/scripts/packaged-boot.mjs "$APP"', { name: "Smoke-boot the packaged app", shell: "bash", timeoutMinutes: 10, ...extra });

  // parseWorkflowJobs — the full table.
  check("P2-242: parseWorkflowJobs — empty text yields an empty job list", parseWorkflowJobs("").length === 0 && parseWorkflowJobs("   \n\n").length === 0);
  check(
    "P2-242: parseWorkflowJobs — text with a jobs key but no job, and text without a jobs key, both yield an empty list",
    parseWorkflowJobs("jobs:\n").length === 0 && parseWorkflowJobs("name: CI\non:\n  push:\n    branches: [main]\n").length === 0,
  );
  const twoSteps = parseWorkflowJobs(
    [
      "name: T",
      "on: push",
      "jobs:",
      "  verify:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: First",
      "        run: echo one",
      "      - name: Second",
      "        shell: bash",
      "        timeout-minutes: 5",
      "        run: |",
      "          echo two",
          "          echo three",
      "",
    ].join("\n"),
  );
  check(
    "P2-242: parseWorkflowJobs — a job with two steps returns both in order with name, platform, command, shell and timeout",
    twoSteps.length === 1 &&
      twoSteps[0].name === "verify" &&
      twoSteps[0].platform === "ubuntu-latest" &&
      twoSteps[0].steps.length === 2 &&
      twoSteps[0].steps[0].name === "First" &&
      twoSteps[0].steps[0].run === "echo one" &&
      twoSteps[0].steps[0].shell === null &&
      twoSteps[0].steps[0].timeoutMinutes === null &&
      twoSteps[0].steps[1].name === "Second" &&
      twoSteps[0].steps[1].run === "echo two\necho three" &&
      twoSteps[0].steps[1].shell === "bash" &&
      twoSteps[0].steps[1].timeoutMinutes === 5,
    JSON.stringify(twoSteps),
  );
  check(
    "P2-242: parseWorkflowJobs — a step without shell and timeout reports both fields as absent",
    twoSteps[0]?.steps[0]?.shell === null && twoSteps[0]?.steps[0]?.timeoutMinutes === null,
  );
  check(
    "P2-242: parseWorkflowJobs — malformed text never throws and degrades to a recognizable partial structure",
    (() => {
      const samples = [
        "jobs:",
        "  :::",
        "    - ]]]",
        " broken: {{",
        "jobs:\n  a:\n   steps:\n    - run: |",
        "jobs: [\n  broken",
        "\tjobs:\n\t x: y",
        "jobs:\n  bad key: {",
      ];
      try {
        return samples.every((s) => Array.isArray(parseWorkflowJobs(s)));
      } catch {
        return false;
      }
    })(),
  );

  // bootSmokeParity — the full table.
  check("P2-242: bootSmokeParity — two empty job lists yield zero problems", bootSmokeParity([], []).length === 0);
  const noBoot = bootSmokeParity([wfJob("desktop-package", "macos-14", [pkg])], []);
  check(
    "P2-242: bootSmokeParity — a packaging job without the real boot yields one problem naming the job",
    noBoot.length === 1 && noBoot[0].includes('"desktop-package"') && noBoot[0].includes("never boots the real package"),
    noBoot.join(" | "),
  );
  const bootFirst = bootSmokeParity([wfJob("j", "ubuntu-latest", [boot(), pkg])], []);
  check(
    "P2-242: bootSmokeParity — a real boot positioned before the packaging step yields the position problem",
    bootFirst.length === 1 && bootFirst[0].includes("before the packaging step"),
    bootFirst.join(" | "),
  );
  const noShell = bootSmokeParity([wfJob("j", "ubuntu-latest", [pkg, boot({ shell: null })])], []);
  check(
    "P2-242: bootSmokeParity — a boot step without shell: bash yields the shell problem",
    noShell.length === 1 && noShell[0].includes("without declaring shell: bash"),
    noShell.join(" | "),
  );
  const noTimeout = bootSmokeParity([wfJob("j", "ubuntu-latest", [pkg, boot({ timeoutMinutes: null })])], []);
  check(
    "P2-242: bootSmokeParity — a boot step without its own timeout yields the timeout problem",
    noTimeout.length === 1 && noTimeout[0].includes("without its own timeout-minutes"),
    noTimeout.join(" | "),
  );
  const twoCauses = bootSmokeParity([wfJob("j", "ubuntu-latest", [pkg, boot({ shell: null, timeoutMinutes: null })])], []);
  check(
    "P2-242: bootSmokeParity — two simultaneous causes yield two problems, never one merged verdict",
    twoCauses.length === 2 && twoCauses.some((p) => p.includes("shell: bash")) && twoCauses.some((p) => p.includes("timeout-minutes")),
    twoCauses.join(" | "),
  );
  const nonPackaging = bootSmokeParity(
    [
      wfJob("verify", "ubuntu-latest", [wfStep("npm run build", { name: "Build" }), wfStep("npm run test:unit", { name: "Unit tests" })]),
      wfJob("smoke-only", "ubuntu-latest", [wfStep("npm run dist:smoke --workspace @ocr/desktop -- --no-installer", { name: "Smoke" })]),
    ],
    [],
  );
  check(
    "P2-242: bootSmokeParity — a job that packages nothing (including a dist:smoke-only job) never generates a problem",
    nonPackaging.length === 0,
    nonPackaging.join(" | "),
  );
  const happyCi = [wfJob("desktop-package", "macos-14", [wfStep("npm ci", { name: "Install" }), pkg, boot()])];
  const happyRelease = [wfJob("desktop-dmg", "macos-14", [pkg, boot()])];
  check("P2-242: bootSmokeParity — packaging jobs with a proper boot after packaging yield zero problems", bootSmokeParity(happyCi, happyRelease).length === 0);
  const stableA = bootSmokeParity(happyCi, [wfJob("desktop-win", "windows-latest", [pkg, boot({ shell: null, timeoutMinutes: null })])]);
  const stableB = bootSmokeParity(happyCi, [wfJob("desktop-win", "windows-latest", [pkg, boot({ shell: null, timeoutMinutes: null })])]);
  check(
    "P2-242: bootSmokeParity — the problem order is stable between two calls with the same input",
    JSON.stringify(stableA) === JSON.stringify(stableB) && stableA.length === 2,
    stableA.join(" | "),
  );
  const withProblems = [...noBoot, ...bootFirst, ...noShell, ...noTimeout, ...twoCauses];
  check(
    "P2-242: bootSmokeParity — no problem text contains an absolute file path",
    withProblems.every((p) => !p.startsWith("/") && !p.includes("/Users/") && !p.includes("/home/") && !p.includes("C:\\")),
  );

  // Real-repo assertion: the actual ci.yml and release.yml parse clean and
  // both packaging jobs of ci.yml carry the boot step with the release
  // contract — zero problems across both workflows.
  const ciJobs = parseWorkflowJobs(readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8"));
  const releaseJobs = parseWorkflowJobs(readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "release.yml"), "utf8"));
  check(
    "P2-242: the real workflows parse into the expected job set",
    ["verify", "scope", "desktop-package", "desktop-package-win", "verify-win", "relay-image"].every((n) => ciJobs.some((j) => j.name === n)) &&
      ["release", "desktop-dmg", "desktop-win", "release-verify", "release-feeds", "release-publish"].every((n) => releaseJobs.some((j) => j.name === n)),
  );
  const parity = bootSmokeParity(ciJobs, releaseJobs);
  check("P2-242: real ci.yml + release.yml through both modules — zero boot-smoke parity problems", parity.length === 0, parity.join(" | "));
  const macJob = ciJobs.find((j) => j.name === "desktop-package");
  const winJob = ciJobs.find((j) => j.name === "desktop-package-win");
  for (const [label, job, packagingRun] of [
    ["mac", macJob, "npm run dist --workspace @ocr/desktop -- --mac --dir"],
    ["windows", winJob, "npm run dist --workspace @ocr/desktop -- --win --dir"],
  ] as const) {
    const steps = job?.steps ?? [];
    const bootIdx = steps.findIndex((s) => /packaged-boot\.mjs/.test(s.run));
    const pkgIdx = steps.findIndex((s) => s.run === packagingRun);
    const smokeIdx = steps.findIndex((s) => s.run.includes("dist:smoke --workspace @ocr/desktop -- --no-installer"));
    const bootStep = bootIdx > -1 ? steps[bootIdx] : null;
    check(
      `P2-242: ci.yml ${label} packaging job — the real boot runs after packaging and after the inspection smoke, with shell: bash and its own timeout`,
      pkgIdx > -1 &&
        smokeIdx > pkgIdx &&
        bootIdx > smokeIdx &&
        bootStep?.shell === "bash" &&
        typeof bootStep?.timeoutMinutes === "number" &&
        (bootStep?.timeoutMinutes ?? 0) > 0,
      JSON.stringify(steps.map((s) => ({ name: s.name, shell: s.shell, timeout: s.timeoutMinutes }))),
    );
  }
  check(
    "P2-242: ci.yml — the boot step resolves the dir-target bundle per platform (.app on macOS, win-unpacked on Windows)",
    (macJob?.steps.find((s) => /packaged-boot\.mjs/.test(s.run))?.run ?? "").includes("-name '*.app'") &&
      (winJob?.steps.find((s) => /packaged-boot\.mjs/.test(s.run))?.run ?? "").includes("win-unpacked"),
  );
  check(
    "P2-242: ci.yml — no packaging-job step uploads artifacts, publishes, signs or notarizes",
    [macJob, winJob].every(
      (j) =>
        j &&
        j.steps.every((s) => !/upload-artifact|gh release|ghr|--publish|notariz/i.test(s.run)) &&
        j.steps.some((s) => s.run.includes("packaged-boot.mjs")),
    ),
  );
  check(
    "P2-242: ci.yml — the pre-existing steps of both packaging jobs are still present",
    (macJob?.steps.map((s) => s.name) ?? []).join("\n").includes("Install dependencies") &&
      (macJob?.steps.map((s) => s.name) ?? []).join("\n").includes("Bundle budget") &&
      (macJob?.steps.map((s) => s.name) ?? []).some((n) => n.startsWith("Package mac bundle")) &&
      (macJob?.steps.map((s) => s.name) ?? []).some((n) => n.startsWith("Smoke-check the packaged bundle")) &&
      (winJob?.steps.map((s) => s.name) ?? []).join("\n").includes("Install dependencies") &&
      (winJob?.steps.map((s) => s.name) ?? []).some((n) => n.startsWith("Package Windows bundle")) &&
      (winJob?.steps.map((s) => s.name) ?? []).some((n) => n.startsWith("Smoke-check the packaged bundle")),
    JSON.stringify({ mac: macJob?.steps.map((s) => s.name), win: winJob?.steps.map((s) => s.name) }),
  );
  check(
    "P2-242: release.yml — both release packaging jobs still boot the real package (parity baseline)",
    ["desktop-dmg", "desktop-win"].every((name) => {
      const job = releaseJobs.find((j) => j.name === name);
      const bootStep = job?.steps.find((s) => /packaged-boot\.mjs/.test(s.run));
      return job && bootStep && bootStep.shell === "bash" && typeof bootStep.timeoutMinutes === "number";
    }),
  );
}

// --- download plan (P2-241) ---------------------------------------------------
// The whole verdict table is pinned by contract: rule 1 = harness session,
// rule 2 = refused scheme (the P2-178 extlink verdict), rule 3 = invalid
// name, rule 4 = announced size above the documented ceiling.

const dlLimits = { nameMax: DOWNLOAD_NAME_MAX, bytesMax: DOWNLOAD_MAX_BYTES };
const dlHttps = externalOpenDecision("https://example.com/file.pdf");

const dlOk = downloadVerdict({ harnessSession: false, schemeVerdict: dlHttps, announcedName: "file.pdf", announcedBytes: 1024, limits: dlLimits });
check("downloadVerdict saves a valid http(s) download", dlOk.action === "salvar");
check("downloadVerdict save plan carries the sanitized name", dlOk.action === "salvar" && dlOk.name === "file.pdf");
check("downloadVerdict save plan carries the static save phrase", dlOk.action === "salvar" && dlOk.reason === DOWNLOAD_PHRASES.save);
check("DOWNLOAD_LIMITS carries the documented constants", DOWNLOAD_LIMITS.nameMax === DOWNLOAD_NAME_MAX && DOWNLOAD_LIMITS.bytesMax === DOWNLOAD_MAX_BYTES);

// Rule 1 by contract: a harness session refuses before any scheme, name or
// size consideration — the P2-221/P2-235/P2-238 lesson, first rule stays first.
const dlHarness = downloadVerdict({ harnessSession: true, schemeVerdict: dlHttps, announcedName: "file.pdf", announcedBytes: 1024, limits: dlLimits });
check("downloadVerdict refuses in a harness session even with allowed scheme and valid name", dlHarness.action === "recusar");
check("downloadVerdict harness refusal carries no name", dlHarness.action === "recusar" && dlHarness.name === "");
check("downloadVerdict harness refusal is the harness phrase", dlHarness.action === "recusar" && dlHarness.reason === DOWNLOAD_PHRASES.harness);

// Rule order: harness and refused scheme hold simultaneously — the harness
// reason wins, because rule 1 is consulted first.
const dlOrder = downloadVerdict({ harnessSession: true, schemeVerdict: externalOpenDecision("file:///etc/passwd"), announcedName: "evil.txt", announcedBytes: 1024, limits: dlLimits });
check("downloadVerdict rule order — harness beats refused scheme", dlOrder.action === "recusar" && dlOrder.reason === DOWNLOAD_PHRASES.harness);

// Rule 2: whatever the extlink verdict refuses, the download refuses.
for (const [scheme, url] of [
  ["file", "file:///etc/passwd"],
  ["javascript", "javascript:alert(1)"],
  ["data", "data:text/plain,hi"],
  ["blob", "blob:https://example.com/uuid"],
  ["unknown", "smb://server/share"],
] as Array<[string, string]>) {
  const plan = downloadVerdict({ harnessSession: false, schemeVerdict: externalOpenDecision(url), announcedName: "ok-name.txt", announcedBytes: 1024, limits: dlLimits });
  check(`downloadVerdict refuses ${scheme} scheme outside harness`, plan.action === "recusar" && plan.reason === DOWNLOAD_PHRASES.scheme && plan.name === "");
}

// Rule 3: the full invalid-name table (fail-closed, through the verdict).
for (const [label, badName] of [
  ["empty string", ""],
  ["spaces only", "   "],
  ["slash", "a/b.txt"],
  ["backslash", "a\\b.txt"],
  ["dot dot", "a..b.txt"],
  ["colon", "a:b.txt"],
  ["control char", "a\tb.txt"],
  ["windows reserved", "CON.txt"],
  ["name above the ceiling", "x".repeat(DOWNLOAD_NAME_MAX + 1)],
  ["non-string", 42],
  ["null", null],
  ["absent", undefined],
] as Array<[string, unknown]>) {
  const plan = downloadVerdict({ harnessSession: false, schemeVerdict: dlHttps, announcedName: badName, announcedBytes: 1024, limits: dlLimits });
  check(`downloadVerdict refuses invalid name (${label})`, plan.action === "recusar" && plan.reason === DOWNLOAD_PHRASES.name && plan.name === "");
}
check("downloadVerdict accepts the name at the exact documented ceiling", safeDownloadName("x".repeat(DOWNLOAD_NAME_MAX)) === "x".repeat(DOWNLOAD_NAME_MAX));

// Rule 4: announced size above the ceiling refuses; the boundary itself and
// every unknown shape never refuse on their own.
check(
  "downloadVerdict refuses announced size above the ceiling",
  downloadVerdict({ harnessSession: false, schemeVerdict: dlHttps, announcedName: "file.iso", announcedBytes: DOWNLOAD_MAX_BYTES + 1, limits: dlLimits }).action === "recusar",
);
check(
  "downloadVerdict saves the announced size at the exact ceiling boundary",
  downloadVerdict({ harnessSession: false, schemeVerdict: dlHttps, announcedName: "file.iso", announcedBytes: DOWNLOAD_MAX_BYTES, limits: dlLimits }).action === "salvar",
);
for (const [label, size] of [
  ["zero (unknown)", 0],
  ["negative (unknown)", -1],
  ["null", null],
  ["undefined", undefined],
  ["string", "1024"],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
] as Array<[string, unknown]>) {
  const plan = downloadVerdict({ harnessSession: false, schemeVerdict: dlHttps, announcedName: "file.bin", announcedBytes: size, limits: dlLimits });
  check(`downloadVerdict unknown size never refuses on its own (${label})`, plan.action === "salvar" && plan.name === "file.bin");
}

// Determinism: the same input yields a byte-identical plan twice.
check(
  "downloadVerdict is stable across two calls with the same input",
  JSON.stringify(downloadVerdict({ harnessSession: false, schemeVerdict: dlHttps, announcedName: "file.pdf", announcedBytes: 1024, limits: dlLimits })) ===
    JSON.stringify(dlOk),
);

// Phrase hygiene: every static phrase is free of absolute paths and URL
// schemes — no colon and no slash of any kind can appear.
for (const [key, phrase] of Object.entries(DOWNLOAD_PHRASES)) {
  check(`downloadVerdict phrase ${key} has no absolute path or URL scheme`, !phrase.includes("/") && !phrase.includes("\\") && !phrase.includes(":"));
}

// safeDownloadName directly: extension preserved, trimming, reserved names.
check("safeDownloadName preserves the extension when it exists", safeDownloadName("relatório final.pdf") === "relatório final.pdf");
check("safeDownloadName trims surrounding spaces", safeDownloadName("  file.zip  ") === "file.zip");
check("safeDownloadName refuses a bare reserved name without extension", safeDownloadName("NUL") === null);
check("safeDownloadName refuses an uppercase reserved name", safeDownloadName("lpt3.zip") === null);
check("safeDownloadName allows ordinary names through unchanged", safeDownloadName("nota-fiscal 2026.pdf") === "nota-fiscal 2026.pdf");

// uniqueDownloadName: never overwrites an existing file.
check("uniqueDownloadName returns the plain name in an empty folder", uniqueDownloadName("a.txt", []) === "a.txt");
check("uniqueDownloadName avoids one existing name", uniqueDownloadName("a.txt", ["a.txt"]) === "a (1).txt");
check("uniqueDownloadName avoids two existing names", uniqueDownloadName("a.txt", ["a.txt", "a (1).txt"]) === "a (2).txt");
check("uniqueDownloadName handles extensionless names", uniqueDownloadName("README", ["README"]) === "README (1)");
check("uniqueDownloadName keeps dotfile stems extensionless", uniqueDownloadName(".hidden", [".hidden"]) === ".hidden (1)");
check("uniqueDownloadName never returns a name already present", ["a.txt", "a (1).txt", "a (2).txt"].every((taken) => uniqueDownloadName("a.txt", [taken, "other.bin"]) !== taken));

// Module purity: same hygiene as extlink.ts / hotkey.ts — no electron, no
// node builtins, no I/O of any kind.
const dlModuleSrc = readFileSync(new URL("../apps/desktop/src/downloadplan.ts", import.meta.url), "utf8");
check(
  "P2-241: downloadplan stays pure — no electron import, no node: builtins, no fetch",
  !dlModuleSrc.includes('from "electron"') && !dlModuleSrc.includes("node:") && !dlModuleSrc.includes("fetch("),
);

// Source pins on the real main.ts: exactly one listener, harness rule first,
// reveal-not-execute, one notification, no new timer, no save dialog.
const dlMainSrc = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
const dlIdx = dlMainSrc.indexOf('session.defaultSession.on("will-download"');
const dlEndMarker = dlMainSrc.indexOf("// P2-184:", dlIdx);
const dlBlock = dlMainSrc.slice(dlIdx, dlEndMarker > dlIdx ? dlEndMarker : dlIdx + 4000);
check("P2-241: main.ts registers exactly one will-download listener", (dlMainSrc.match(/\.on\("will-download"/g) || []).length === 1);
check("P2-241: the handler consults the pure verdict before anything else", dlBlock.includes("const plan = downloadVerdict({") && dlBlock.indexOf("const plan = downloadVerdict({") < dlBlock.indexOf("item.cancel()") && dlBlock.indexOf("const plan = downloadVerdict({") < dlBlock.indexOf("item.setSavePath("));
check("P2-241: the harness-session rule is the first input consulted", /const plan = downloadVerdict\(\{\s*harnessSession: HERMETIC_E2E,/.test(dlBlock));
check("P2-241: the handler consumes the P2-178 extlink verdict", dlBlock.includes("schemeVerdict: externalOpenDecision(item.getURL())"));
check("P2-241: the refuse plan cancels the item", dlBlock.includes("item.cancel()"));
check("P2-241: the save plan sets the path without any dialog", dlBlock.includes("item.setSavePath(") && !dlBlock.includes("showSaveDialog") && !dlBlock.includes("showMessageBox"));
check("P2-241: the done path reveals the file and never executes or opens it", dlBlock.includes("shell.showItemInFolder(") && !/shell\.openItem|shell\.openPath|shell\.openExternal|\.exec\(|spawn\(/.test(dlBlock));
check("P2-241: at most one notification is sent per download", (dlBlock.match(/new Notification\(/g) || []).length === 1);
check("P2-241: no new periodic timer was introduced by the handler", !dlBlock.includes("setInterval(") && !dlBlock.includes("setTimeout("));

if (failures > 0) {
  console.error(`UNIT TESTS FAILED: ${failures}`);
  process.exit(1);
}

console.log("UNIT TESTS PASSED");

process.exit(0);