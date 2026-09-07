// tiny i18n: localStorage-backed language, module-level store with listeners.
// usage: const t = useT(); t("search") — components re-render on change.

import { useSyncExternalStore } from "react";
import { INSTALL_HINT_MESSAGE } from "./installhint";

export type Lang = "en" | "pt";

const KEY = "ocr_lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY) as Lang | null;
    if (saved === "en" || saved === "pt") return saved;
    return navigator.language.toLowerCase().startsWith("pt") ? "pt" : "en";
  } catch {
    return "en";
  }
}

let lang: Lang = detect();
const listeners = new Set<() => void>();

// P2-276: the native shell (menu bar + tray) follows the language chosen
// here — a one-way push over the existing preload bridge, same pattern as
// the unread badge (lib/unread.ts). Absent in plain browsers; any bridge
// failure is swallowed — the push is cosmetic and must never break the UI.
function publishLangToShell(l: Lang): void {
  try {
    const bridge = (window as unknown as { ocrDesktop?: { sendLang?: (lang: string) => void } }).ocrDesktop;
    bridge?.sendLang?.(l);
  } catch {
    // no shell, or the bridge rejected — the shell keeps its current language
  }
}

publishLangToShell(lang);

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang) {
  lang = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {}
  publishLangToShell(l);
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * P2-118: resolve copy for an explicit lang from the same dictionary useT
 * reads — for code outside React (tests, plain callbacks) so every screen
 * resolves to one locale, never a mix.
 */
export function translate(l: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = (dict[l] as Record<string, string>)[key] ?? (dict.en as Record<string, string>)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function useT() {
  useSyncExternalStore(subscribe, getLang);
  return (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);
}

export const dict = {
  en: {
    // sessions board
    search: "Search conversations…",
    filterAll: "All",
    filterWithBadge: "With badge",
    filterNoBadge: "No badge",
    // P2-108: search-attached filter menu trigger
    filterTitle: "Filter",
    loadingSessions: "Loading conversations…",
    noSessions: "No conversations yet.",
    ready: "ready",
    working: "working…",
    waitingApproval: "waiting for your approval",
    askedQuestion: "asked a question",
    errored: "errored",
    newConversation: "+ New conversation",
    creating: "Creating…",
    // P2-124: Claude-level sidebar shell
    newShort: "+ New",
    navConversations: "Conversations",
    navArtifacts: "Artifacts",
    navBrowser: "Browser",
    navFiles: "Files",
    navPhone: "Phone",
    navMission: "Mission Control",
    navSettings: "Settings",
    planLocal: "Local · this machine",
    planRemote: "Remote · paired",
    accountSwitch: "Switch machine",
    unpair: "Unpair",
    pushOn: "Push enabled",
    pushEnable: "Enable push",
    renamePrompt: "New name:",
    deleteConfirm: "Delete this conversation?",
    machines: "Machines",
    forget: "Forget",
    activity: "Activity",
    // chat
    stop: "Stop",
    emptyTitle: "Start the conversation",
    emptyHint: "Send an audio, photo or text — your agent is ready.",
    agentWorking: "agent is working…",
    queued: "{n} message(s) queued — will send when reconnected",
    exported: "Conversation exported",
    openedOnMac: "Opened on your Mac — the conversation continues there",
    rewindBtn: "back to here",
    rewindConfirm:
      "Take the conversation back to this point? Everything after it is undone — including code changes. You can redo later.",
    rewound: "Conversation rewound",
    unrevert: "Redo (undo the rewind)",
    unreverted: "Back to the present",
    autoApproved: "AutoMode approved: {action}",
    autoFailed: "AutoMode couldn't approve: {action} — manual review needed",
    alreadyResolved: "Permission already resolved",
    permResolvedLine: "resolved",
    permAutoLine: "auto-approved",
    autoBadge: "AutoMode — actions approved automatically",
    exportBtn: "Export conversation",
    handoffBtn: "Continue on the Mac",
    copyPath: "Copy path",
    copied: "Copied",
    copyFailed: "Could not copy the path",
    answer: "Answer",
    skip: "Skip",
    customAnswer: "or type your own answer…",
    approve: "Approve",
    deny: "Deny",
    // settings
    settingsMachine: "Machine",
    settingsNotifications: "Notifications",
    notifPermission: "Permission requests",
    notifIdle: "Agent finished",
    autoMode: "AutoMode",
    autoModeLabel: "Approve everything automatically",
    autoModeHint:
      "The agent runs without approval prompts on this machine. Every auto-approved action is recorded in the audit log and (if enabled) pushed as a notification.",
    language: "Language",
    mcp: "MCP",
    mcpHint: "Tool connectors ({file}). Changes apply to new conversations.",
    mcpNone: "No connectors.",
    mcpAdd: "+ Add connector",
    mcpName: "name",
    mcpCommand: "command (e.g. npx -y some-mcp-server)",
    mcpUrl: "https://your-server-url",
    mcpAddBtn: "Add",
    saved: "saved",
    saveError: "error: {msg}",
    pairedDevices: "Paired devices ({n})",
    lastSeen: "last seen {when}",
    neverSeen: "never seen",
    audit: "Audit",
    noAudit: "no events yet",
    voice: "Voice",
    voiceAutoSend: "Auto-send after transcription",
    versionMismatch:
      " — version mismatch: refresh the PWA (pull-to-refresh) or update the daemon",
    connLocal: "Connection: direct (local)",
    connRelay: "Connection: via relay",
    // tab bar
    tabSessions: "Chats",
    tabFiles: "Files",
    tabSettings: "Settings",
    // errors
    retry: "Retry",
    errAgentCrashed: "The agent crashed mid-answer — it usually comes back on retry.",
    errAttachmentExpired: "Attachment expired — reattach it and send again.",
    errConversationGone: "This conversation no longer exists on the machine.",
    errRefused: "The agent refused the request (HTTP {status}).",
    errConnectionLost: "Connection lost — your message is queued and will go out automatically.",
    errNotPaired: "Not paired yet — reopen the app or pair again.",
    errCreateFailed: "Could not create the conversation — try again.",
    // session cards
    justNow: "now",
    // first-run pairing overlay (desktop, P2-007)
    pairOverlayTitle: "Pair your phone",
    pairOverlayHint:
      "Scan this QR code with the OpenCode Remote app to control this machine from your phone. Traffic is end-to-end encrypted.",
    pairOverlayAlt: "Pairing QR code",
    pairOverlayLater: "Pair later",
    // first-run splash (desktop, P1-050): promise the first value in <60s
    splashValue: "Control this machine from your phone. Your agent, your code — end-to-end encrypted.",
    splashUnder: "First value in under a minute.",
    pairDevicesCount: "Paired devices ({n}): ",
    // diagnostics (desktop settings, P1-050)
    diagTitle: "Diagnostics",
    diagCopy: "Copy diagnostic",
    diagCopied: "Diagnostic copied — paste it into your support message",
    // daemon sidecar gave up (desktop, P2-017) — P1-053: the copy points to the
    // in-banner recovery button; the reconnecting state is the active variant.
    daemonDown: "Local daemon is down — the app stopped retrying.",
    reconnectNow: "Reconnect now",
    reconnecting: "Reconnecting to daemon… ({n})",
    // version mismatch banner (desktop, P3-054): healthy but stale daemon.
    // Key is daemonMismatch: versionMismatch already names the PWA copy above.
    daemonMismatch: "Daemon v{d} · app v{a} — restart the daemon.",
    // explicit remote-pairing entry + local auto-connect (desktop, P1-070)
    pairRemoteTitle: "Pair a phone (remote device)",
    pairRemoteHint:
      "Show the pairing QR to control this machine from your phone — traffic is end-to-end encrypted.",
    pairRemoteAction: "Show pairing QR",
    // phone relay address (desktop settings, P2-187)
    relayTitle: "Phone relay",
    relayHint:
      "Relay your phone dials for remote pairing. The built-in local relay only serves this machine — for another device, point the app at a hosted relay.",
    relaySave: "Save",
    relayReset: "Use local relay",
    relayInvalid: "Invalid relay address — use wss://relay.example.com:8788 (or ws:// only to a host on this machine).",
    relayOriginEnv: "Address set by the RELAY_URL environment variable — it wins over this setting.",
    relayOriginStored: "Saved on this machine.",
    relayOriginDefault: "Local default — only works on this machine.",
    relayOriginInvalid: "The saved address is invalid — fix it or go back to the local relay.",
    // pairing step one + app address setting (desktop, P2-189)
    pairStepOne: "Step 1 — open the app on your phone",
    pairStepTwo: "Step 2 — pair this machine",
    pairWebAppTitle: "Open this address on your phone",
    pairWebAppAlt: "App address QR code",
    pairWebAppCopy: "Copy address",
    pairWebAppCopied: "Copied",
    pairWebAppUnavailable:
      "The local relay only serves this machine, so there is no address the phone can reach yet. Point the app at a hosted relay in Settings → Phone relay, then come back here.",
    // combined pair link (desktop, P2-193): one QR, credential in the fragment
    pairLinkTitle: "Scan with your phone's camera",
    pairLinkHint:
      "One code is all it takes — the camera opens the app on your phone already paired. The pairing credential rides in the URL fragment, which no browser sends to any server.",
    // reach probe of the app address (desktop, P2-197): calm line below the QR
    pairReachOk: "The app address answered — the QR is ready for your phone.",
    pairReachRetry: "Test again",
    pairReachTesting: "Testing again…",
    // daemon↔relay link (desktop, P2-199): quiet line below the reach line
    pairRelayLinkOk: "The app is talking to the relay — the room is ready for your phone.",
    pairRelayLinkLocal: "Local mode — your phone pairs directly on this machine's network, no relay needed.",
    webAppTitle: "App address (phone)",
    webAppHint:
      "Where the phone opens the app — derived from the phone relay (wss:// becomes https://, same host and port) unless you save one here.",
    webAppInvalid: "Invalid app address — use https://relay.example.com:8788 (or http:// only to a host on this machine).",
    webAppOriginStored: "Saved on this machine.",
    webAppOriginDerived: "Derived from the phone relay — same host and port, wss:// becomes https://.",
    webAppOriginUnavailable: "No usable address — the local relay only serves this machine.",
    webAppReset: "Use the address from the relay",
    localConnecting: "Connecting to the local daemon…",
    // degraded first-boot journey (desktop, P2-112): a dead daemon on first
    // boot is never a dead end — calm status, visible auto-retry, minimal
    // local data, and the manual pairing screen one click away.
    firstContactTitle: "Connecting for the first time…",
    firstContactHint:
      "Conversations, files and artifacts sync as soon as the local daemon answers. Nothing is lost — this screen keeps trying on its own.",
    degradedRetrying: "Retrying automatically…",
    degradedDownHint:
      "Automatic retries stopped. Use Reconnect now — or just wait: the app reconnects by itself when the daemon is back.",
    degradedLocalTitle: "Available offline",
    degradedLocalHint: "Language and theme live on this machine — they work right now.",
    degradedPairManually: "Pair another device manually",
    // P2-138: upstream (opencode) notice inside the calm card + the Settings
    // help section it links to. Four classifier states, honest and calm — the
    // daemon's own reason/hint render below as secondary text detail.
    upstreamUnreachableTitle: "Agent server not found",
    upstreamUnreachableAction: "Check that opencode is installed and running on this machine (opencode serve).",
    upstreamUnauthorizedTitle: "Agent password changed",
    upstreamUnauthorizedAction: "Update the agent credential — the app reconnects by itself afterwards.",
    upstreamTimeoutTitle: "Agent server is slow to answer",
    upstreamTimeoutAction: "Restart opencode on this machine if this persists.",
    upstreamUnhealthyTitle: "Agent server answered unwell",
    upstreamUnhealthyAction: "Restart opencode on this machine and check the server version.",
    upstreamHelpAction: "Open setup help",
    upstreamHelpTitle: "Agent server help",
    // P2-140: why the local daemon died — inside the same calm degraded card.
    // Honest, actionable, one surface; no paths, tokens or secrets in copy.
    sidecarPortBusyTitle: "Another app took the daemon's port",
    sidecarPortBusyAction:
      "Close the program using the daemon's local port (or restart the machine) and reopen the app.",
    sidecarEntryMissingTitle: "Daemon files are missing",
    sidecarEntryMissingAction: "Reinstall the app to restore the installation, then reopen it.",
    sidecarRuntimeErrorTitle: "The daemon failed to start",
    sidecarRuntimeErrorAction: "Reopen the app; if it persists, send the diagnostic from Settings → Help.",
    sidecarKilledTitle: "The system shut the daemon down",
    sidecarKilledAction:
      "Reopen the app — it reconnects by itself; if this keeps happening, close other heavy programs.",
    sidecarUnknownTitle: "The daemon exited unexpectedly",
    sidecarUnknownAction: "Reopen the app; if it persists, send the diagnostic from Settings → Help.",
    // P2-148: first-run welcome — three steps, shown once, skippable at any
    // time. Calm, plain sentences; step 2 reuses the degraded-journey copy.
    welcomeStepOf: "Step {n} of 3",
    welcomeStep1Title: "Control this machine from your phone",
    welcomeStep1Body:
      "OpenCode Remote runs your AI agent on this machine and pairs it with your phone — end-to-end encrypted.",
    welcomeStart: "Get started",
    welcomeSkip: "Skip",
    welcomeNext: "Next",
    welcomeStep2Title: "Your local agent",
    welcomeAgentOk: "Local agent running",
    welcomeStep3Title: "Pair a phone (optional)",
    welcomeStep3Body:
      "You can scan the pairing code anytime from Settings — or do it now and control this machine from anywhere.",
    welcomeLater: "Do this later",
    welcomeDone: "Done",
    welcomePairedTitle: "Phone paired",
    welcomePairedHint: "The phone is already talking to this machine — you can close and start using it.",
    welcomeQrWait: "Generating QR…",
    reconnectTrying: "Trying…",
    reconnectStarted: "Daemon restart started — the app reconnects on its own.",
    reconnectFailed: "Could not restart the daemon — try again in a moment.",
    // command palette (desktop, P1-046)
    palettePlaceholder: "Search conversations and actions…",
    paletteEmpty: "No matches",
    paletteNewChat: "New conversation",
    paletteOpenArtifacts: "Open Artifacts",
    paletteOpenBrowser: "Open Browser",
    paletteOpenFiles: "Open Files",
    paletteOpenSettings: "Open Settings",
    paletteKindAction: "action",
    paletteKindSession: "conversation",
    // mission control (desktop, P2-048)
    paletteOpenMission: "Open Mission Control",
    missionDesktopOnly: "Mission Control reads the pilot's local records — open the app on the host machine.",
    missionLoading: "Loading agent sessions…",
    missionEmpty: "No agent sessions recorded yet.",
    missionSelect: "Select a session to open its forensic timeline.",
    missionSt_running: "running",
    missionSt_merged: "merged",
    missionSt_failed: "failed",
    missionEffort: "effort",
    missionRounds: "{n} round(s)",
    missionEta: "ETA",
    missionGateFails: "{n} gate fail(s)",
    missionF_all: "all",
    missionF_decision: "decisions",
    missionF_gate: "gate",
    missionF_review: "review",
    missionF_deploy: "deploy",
    missionTakeover: "Take over",
    missionTakenOver: "Terminal opened on the host, attached to the agent's session.",
    missionNoEntries: "No forensic entries for this filter.",
    missionShots: "Post-deploy shots",
    missionLiveShot: "Live dashboard shot",
    missionLive: "Live",
    unitMin: "min",
    // pairing screen (P2-049). P1-070: local-first wording — the desktop
    // auto-connects to the daemon on the same machine, no code needed there.
    // P2-106: one sentence — the ceremony sections below carry the detail.
    pairIntro:
      "OpenCode Remote pairs with the daemon on this machine automatically — to connect from another device, scan the daemon's QR or paste a pairing code.",
    // P2-106: the two pairing directions get titled sections (client / host).
    pairConnectTitle: "Connect to another machine",
    pairHostTitle: "Pair a phone with this machine",
    scanQr: "Scan QR code",
    orPaste: "— or paste manually —",
    // QR scanner state machine (P2-117): looking → preview → unavailable
    scanTitle: "Scan pairing code",
    scanBack: "Back",
    scanLooking: "Looking for a camera…",
    scanHint: "Point the camera at the pairing code shown by the daemon.",
    scanPasteCta: "Paste pairing code instead",
    "scanErr_permission": "Camera permission denied. Allow camera access for this app and try again.",
    "scanErr_no-device": "No camera found on this device.",
    "scanErr_busy": "Camera is in use by another app. Close it and try again.",
    "scanErr_interrupted": "Camera was interrupted. Try again.",
    "scanErr_no-signal": "The camera has no signal — capture devices without input show this. Paste the pairing code instead.",
    "scanErr_generic": "Camera unavailable.",
    orScan: "— or scan the QR —",
    pairBtn: "Pair",
    connecting: "Connecting…",
    invalidCode: "Invalid pairing code",
    // P2-106: inline recovery helper under the invalid-code error — shows the
    // shape of a well-formed pairing URI so the fix is obvious.
    invalidCodeHint:
      "Expected format: opencode-remote://pair?v=2&relay=… — copy the whole code, exactly as the other machine shows it.",
    // chat composer + header (P2-049)
    send: "Send",
    messagePlaceholder: "Message the agent…",
    recording: "recording…",
    streamingWait: "Agent is streaming — wait or Stop",
    thinkingLive: "Thinking…",
    thoughtFor: "Thought for {n}s",
    thoughtLabel: "Thought",
    attachFile: "Attach file",
    micNeedsPermission: "Microphone unavailable — allow access to record voice",
    modelSelector: "Agent and model",
    defaultModel: "default model",
    stopRecording: "Stop recording",
    recordVoice: "Record voice",
    missionDash: "Live dashboard",
    missionForensic: "Timeline",
    missionActive: "Active mission",
    missionActiveNone: "No mission set. Define one in the chat: describe what you want and, optionally, paste a GitHub repo link.",
    missionSource: "source",
    missionSourcePrompt: "prompt",
    missionSourceRepo: "repo",
    missionSetAt: "set at",
    missionModels: "models",
    missionModelSubstituted: "model unavailable, running the default instead",
    missionClear: "End mission",
    missionClearConfirm: "Confirm: end mission",
    missionCleared: "Mission ended. The fleet returns to its own repo on the next boot.",
    missionClearFailed: "Could not end the mission.",
    voiceReply: "Speak replies",
    voiceReplyOn: "Replies are spoken — click to mute",
    stopSpeaking: "Stop speaking",
    voiceReplyUnavailable: "Spoken replies unavailable on this host",
    voiceOutLang: "Reply voice",
    toolActivity: "tool activity",
    noToolCalls: "no tool calls observed yet",
    refreshTools: "Refresh tool history",
    agentMode: "Agent mode",
    agentOption: "agent",
    model: "Model",
    openArtifact: "Open artifact",
    trimStart: "Trim start (s)",
    trimEnd: "Trim end (s)",
    attach: "Attach",
    full: "Full",
    removeImage: "Remove image",
    olderMessages: "{n} older messages",
    loadingDiff: "loading diff…",
    changesFor: "changes for {action}",
    noChanges: "no file changes yet for this request",
    close: "Close",
    back: "Back",
    queuedTitle: "queued — will send when back online",
    connTitle: "connection: {status}",
    sessionFallback: "session",
    ctxGauge: "Context usage",
    ctxGaugeDetail: "Context: {pct}% of the model window ({tokens} of {window} tokens)",
    recapLabel: "Recap",
    recapDetail: "Where the conversation left off",
    jumpToEnd: "Go to end",
    resizeSplit: "Resize artifact preview",
    // a11y (P2-049)
    rename: "Rename",
    delete: "Delete",
    // chat history paging + session list grouping (P1-064)
    loadMore: "Load older messages",
    historyRetry: "Could not load the conversation history.",
    pilotGroup: "Pilot sessions ({n})",
    // temporal grouping + archive (P3-084)
    groupToday: "Today",
    groupYesterday: "Yesterday",
    groupEarlier: "Earlier",
    groupArchived: "Archived ({n})",
    archive: "Archive",
    restore: "Restore",
    // QR scanner (in-app camera, P2-118) — connection screen copy must follow
    // the app locale like the daemon banners around it.
    scanPairingTitle: "Scan pairing code",
    scanPointCamera: "Point the camera at the QR code shown by the daemon.",
    scanBackManual: "Back to manual pairing",
    camDenied:
      "Camera permission denied. Allow camera access for this site (Settings → Safari → Camera) and try again.",
    camNotFound: "No camera found on this device.",
    camBusy: "Camera is in use by another app. Close it and try again.",
    camInterrupted:
      "Camera was interrupted. Tap Scan again — iOS sometimes aborts the first attempt.",
    camUnavailable: "camera unavailable",
    // desktop home screen (P2-123): greeting, central composer and the ideas
    // section. {name} is the lowercased machine name.
    homeGreeting: "Back in action, {name}",
    homeGreetingAnon: "Back in action",
    homePlaceholder: "How can I help you today?",
    homeIdeasTitle: "Ideas for you",
    homeIdea1Label: "Pick up where we left off",
    homeIdea1Prompt:
      "Pick up the work on my latest project: list what is still pending and suggest the next step.",
    homeIdea2Label: "Explain a piece of code",
    homeIdea2Prompt: "Explain in plain words what this code snippet does and where it might break:\n",
    homeIdea3Label: "Recap my recent sessions",
    homeIdea3Prompt: "Summarize my recent conversations, with the next step for each one.",
    homeStartError: "Couldn't start the conversation. Check the connection and try again.",
    // P2-220: iOS install hint above the conversation list (iPhone/iPad,
    // regular tab, saved pairing). Dismissal is definitive — documented.
    installHintBody:
      "Add the app to your Home Screen to keep this pairing saved — in the browser, tap the Share button and choose Add to Home Screen.",
    installHintDismiss: "Dismiss",
    // P2-266: update-ready strip — one calm line + explicit action; the
    // button is the only path that swaps the waiting worker in.
    swUpdateReady: "A new version of the app is ready.",
    swUpdateAction: "Update now",
    // P2-232: machine-state section (Settings) — labels resolve per locale;
    // the rows' phrases themselves come from the daemon, never from here.
    machineStateTitle: "Machine state",
    machineStateEmpty: "Nothing to show yet — the machine hasn't reported its state.",
    machineStateAllOkTitle: "Everything is fine on this machine.",
    machineStateAttentionTitle: "One or more items need attention on this machine.",
    machineStateUnavailableTitle: "Something is unavailable on this machine.",
    machineLabelRelay: "Remote connection",
    machineLabelAgent: "Agent server",
    machineLabelVersion: "Agent version",
    machineLabelDisk: "Disk space",
    machineLabelDocs: "Document conversion",
    // P2-275: the remaining Settings sections ride the dict — SettingsView no
    // longer carries literal JSX copy. Product names (MCP, AutoMode) stay.
    aboutTitle: "About",
    aboutVersions: "app {app} · daemon {daemon}",
    save: "Save",
    machineNamePlaceholder: "machine name",
    remove: "Remove",
    mcpTypeLocal: "local",
    mcpTypeRemote: "remote",
    voiceInLang: "Language",
    voiceLangAuto: "Auto-detect",
    voiceLangEn: "English",
    voiceLangPt: "Portuguese",
    voiceLangEs: "Spanish",
    voiceLangFr: "French",
    ttsVoicePt: "Portuguese (Antonio)",
    ttsVoiceEn: "English (Andrew)",
    ttsVoiceEs: "Spanish (Alvaro)",
    captionStyleTitle: "Caption style (clips)",
    captionFont: "Font (e.g. Helvetica Bold)",
    captionFontSize: "Size",
    captionPrimary: "Primary color (&H..)",
    captionHighlight: "Highlight color (&H..)",
    captionOutline: "Outline color (&H..)",
    captionMargin: "Bottom margin",
    captionSave: "Save style",
    captionSaved: "caption style saved",
    appearanceTitle: "Appearance",
    themeLabel: "Theme",
    themeSystem: "System",
    themeDark: "Dark",
    themeLight: "Light",
    fontLabel: "Font size",
    fontSmall: "Small",
    fontNormal: "Normal",
    fontLarge: "Large",
    pushTitle: "Push notifications",
    pushSendTest: "Send test notification",
    pushSending: "Sending…",
    pushResubscribe: "Re-subscribe",
    pushSubscribed: "subscribed",
    pushNoDevices: "no device subscribed — tap Re-subscribe",
    pushSentOk: "sent OK — check the phone",
    pushSubsCount: "{n} device(s) subscribed · iOS: app must be on the Home Screen",
    shareTitle: "Share to agent",
    shareAndroidLabel: "Android/desktop",
    shareAndroidBody: "the system share sheet offers \"OpenCode Remote\" directly.",
    shareIosLabel: "iOS",
    shareIosBody:
      "copy the link anywhere, open the app, long-press the message field → Paste, add your instruction and send. Or create a Shortcut (Shortcuts app) that copies the shared text and opens \"OpenCode Remote\".",
    skillsTitle: "Skills (1-tap prompts)",
    skillLabelPlaceholder: "label (e.g. Daily report)",
    skillPromptPlaceholder: "prompt sent to the agent on tap",
    skillAdd: "Add skill",
    skillAdded: "skill added",
    skillRejected: "skill rejected — label and prompt required",
    routinesTitle: "Scheduled routines",
    routineEveryDay: "Every day",
    routineSpecificDays: "Specific days",
    routineLoop: "Loop every N min",
    routineModeLabel: "Schedule mode",
    routineIntervalLabel: "Interval in minutes",
    routineNamePlaceholder: "name",
    routineIntervalHint: "runs immediately, then every N minutes while the daemon is up (min 5)",
    routinePromptPlaceholder: "prompt for the agent (e.g. summarize crypto news and save a report)",
    routineAdd: "Add routine",
    routineAdded: "routine added",
    routineRejected: "routine rejected — check fields",
    routineEvery: "every {n}m",
    routineDaily: "daily {time}",
    routineLastError: "last error: {err}",
    routineLastOk: "last run: ok",
    routineNeverRan: "never ran",
    daySun: "Sun",
    dayMon: "Mon",
    dayTue: "Tue",
    dayWed: "Wed",
    dayThu: "Thu",
    dayFri: "Fri",
    daySat: "Sat",
    dayLetter0: "S",
    dayLetter1: "M",
    dayLetter2: "T",
    dayLetter3: "W",
    dayLetter4: "T",
    dayLetter5: "F",
    dayLetter6: "S",
    deviceFallback: "device",
    revoke: "Revoke",
    securityLog: "Security log",
  },
  pt: {
    search: "Buscar conversas…",
    filterAll: "Todas",
    filterWithBadge: "Com badge",
    filterNoBadge: "Sem badge",
    filterTitle: "Filtrar",
    loadingSessions: "Carregando conversas…",
    noSessions: "Nenhuma conversa ainda.",
    ready: "pronto",
    working: "trabalhando…",
    waitingApproval: "esperando sua aprovação",
    askedQuestion: "fez uma pergunta",
    errored: "deu erro",
    newConversation: "+ Nova conversa",
    creating: "Criando…",
    // P2-124: shell de sidebar nível Claude
    newShort: "+ Novo",
    navConversations: "Conversas",
    navArtifacts: "Artifacts",
    navBrowser: "Browser",
    navFiles: "Arquivos",
    navPhone: "Celular",
    navMission: "Mission Control",
    navSettings: "Configurações",
    planLocal: "Local · esta máquina",
    planRemote: "Remoto · pareado",
    accountSwitch: "Trocar de máquina",
    unpair: "Desconectar",
    pushOn: "Notificações ativadas",
    pushEnable: "Ativar notificações",
    renamePrompt: "Novo nome:",
    deleteConfirm: "Apagar esta conversa?",
    machines: "Máquinas",
    forget: "Esquecer",
    activity: "Atividade",
    stop: "Parar",
    emptyTitle: "Comece a conversa",
    emptyHint: "Mande um áudio, foto ou texto — seu agente tá pronto.",
    agentWorking: "agente trabalhando…",
    queued: "{n} mensagem(s) na fila — enviam ao reconectar",
    exported: "Conversa exportada",
    openedOnMac: "Aberto no Mac — a conversa continua lá",
    rewindBtn: "Voltar pra cá",
    rewindConfirm:
      "Voltar a conversa pra este ponto? Tudo o que veio depois é desfeito — inclusive as mudanças no código. Dá pra refazer depois.",
    rewound: "Conversa voltou pra trás",
    unrevert: "Refazer (desfazer o voltar)",
    unreverted: "De volta pro presente",
    autoApproved: "AutoMode aprovou: {action}",
    autoFailed: "AutoMode não conseguiu aprovar: {action} — aprove manualmente",
    alreadyResolved: "Permissão já resolvida",
    permResolvedLine: "resolvida",
    permAutoLine: "auto-aprovada",
    autoBadge: "AutoMode — ações aprovadas automaticamente",
    exportBtn: "Exportar conversa",
    handoffBtn: "Continuar no Mac",
    copyPath: "Copiar caminho",
    copied: "Copiado",
    copyFailed: "Não deu pra copiar o caminho",
    answer: "Responder",
    skip: "Pular",
    customAnswer: "ou escreva sua resposta…",
    approve: "Aprovar",
    deny: "Negar",
    settingsMachine: "Máquina",
    settingsNotifications: "Notificações",
    notifPermission: "Pedidos de permissão",
    notifIdle: "Agente terminou",
    autoMode: "AutoMode",
    autoModeLabel: "Aprovar tudo automaticamente",
    autoModeHint:
      "O agente roda sem pedir aprovação nesta máquina. Tudo fica registrado no audit log e (se ativado) vira notificação.",
    language: "Idioma",
    mcp: "MCP",
    mcpHint: "Conectores de ferramentas ({file}). Mudanças valem para novas conversas.",
    mcpNone: "Nenhum conector.",
    mcpAdd: "+ Adicionar conector",
    mcpName: "nome",
    mcpCommand: "comando (ex: npx -y servidor-mcp)",
    mcpUrl: "https://url-do-servidor",
    mcpAddBtn: "Adicionar",
    saved: "salvo",
    saveError: "erro: {msg}",
    pairedDevices: "Dispositivos pareados ({n})",
    lastSeen: "visto {when}",
    neverSeen: "nunca visto",
    audit: "Auditoria",
    noAudit: "nenhum evento ainda",
    voice: "Voz",
    voiceAutoSend: "Enviar sozinho após transcrição",
    versionMismatch:
      " — versões diferentes: atualize o PWA (puxe pra recarregar) ou o daemon",
    connLocal: "Conexão: direta (local)",
    connRelay: "Conexão: via relay",
    // tab bar
    tabSessions: "Chats",
    tabFiles: "Arquivos",
    tabSettings: "Config",
    // errors
    retry: "Tentar de novo",
    errAgentCrashed: "O agente caiu no meio da resposta — geralmente volta ao tentar de novo.",
    errAttachmentExpired: "O anexo expirou — anexe de novo e envie.",
    errConversationGone: "Essa conversa não existe mais na máquina.",
    errRefused: "O agente recusou o pedido (HTTP {status}).",
    errConnectionLost: "Conexão caiu — sua mensagem tá na fila e sai sozinha quando voltar.",
    errNotPaired: "Sem pareamento ativo — reabra o app ou pareie de novo.",
    errCreateFailed: "Não deu pra criar a conversa — tenta de novo.",
    // session cards
    justNow: "agora",
    // first-run pairing overlay (desktop, P2-007)
    pairOverlayTitle: "Pareie seu celular",
    pairOverlayHint:
      "Escaneie este QR code com o app OpenCode Remote para controlar esta máquina do celular. O tráfego é criptografado ponta a ponta.",
    pairOverlayAlt: "QR code de pareamento",
    pairOverlayLater: "Parear depois",
    // first-run splash (desktop, P1-050): promessa do 1º valor em <60s
    splashValue: "Controle esta máquina do celular. Seu agente, seu código — criptografia ponta a ponta.",
    splashUnder: "Primeiro valor em menos de 1 minuto.",
    pairDevicesCount: "Celulares pareados ({n}): ",
    // diagnostics (desktop settings, P1-050)
    diagTitle: "Diagnóstico",
    diagCopy: "Copiar diagnóstico",
    diagCopied: "Diagnóstico copiado — cole na sua mensagem de suporte",
    // daemon sidecar gave up (desktop, P2-017) — P1-053: o copy aponta pro botão
    // de recuperação no próprio banner; reconectando é a variante ativa.
    daemonDown: "Daemon local caiu — o app parou de tentar reiniciar.",
    reconnectNow: "Reconectar agora",
    reconnecting: "Reconectando ao daemon… ({n})",
    // banner de mismatch de versão (desktop, P3-054): daemon vivo, mas velho.
    daemonMismatch: "Daemon v{d} · app v{a} — reinicie o daemon.",
    // entrada explícita de pareamento remoto + auto-conexão local (P1-070)
    pairRemoteTitle: "Parear um celular (dispositivo remoto)",
    pairRemoteHint:
      "Mostra o QR de pareamento para controlar esta máquina do celular — tráfego criptografado ponta a ponta.",
    pairRemoteAction: "Mostrar QR de pareamento",
    // endereço do relay do celular (ajustes do desktop, P2-187)
    relayTitle: "Relay do celular",
    relayHint:
      "Relay com o qual o celular se conecta no pareamento remoto. O relay local embutido só serve esta máquina — para outro dispositivo, aponte o app para um relay hospedado.",
    relaySave: "Salvar",
    relayReset: "Usar relay local",
    relayInvalid: "Endereço de relay inválido — use wss://relay.exemplo.com:8788 (ou ws:// apenas para um host nesta máquina).",
    relayOriginEnv: "Endereço definido pela variável de ambiente RELAY_URL — ela vence este ajuste.",
    relayOriginStored: "Salvo nesta máquina.",
    relayOriginDefault: "Padrão local — só funciona nesta máquina.",
    relayOriginInvalid: "O endereço salvo é inválido — corrija-o ou volte ao relay local.",
    // passo 1 do pareamento + endereço do app (desktop, P2-189)
    pairStepOne: "Passo 1 — abra o app no celular",
    pairStepTwo: "Passo 2 — pareie esta máquina",
    pairWebAppTitle: "Abra este endereço no celular",
    pairWebAppAlt: "QR code do endereço do app",
    pairWebAppCopy: "Copiar endereço",
    pairWebAppCopied: "Copiado",
    pairWebAppUnavailable:
      "O relay local só atende esta máquina, então ainda não existe endereço que o celular alcance. Aponte o app para um relay hospedado em Config → Relay do celular e volte aqui.",
    // link de pareamento combinado (desktop, P2-193): um QR só, credencial no fragmento
    pairLinkTitle: "Escaneie com a câmera do celular",
    pairLinkHint:
      "Um código só — a câmera abre o app no celular já pareado. A credencial de pareamento viaja no fragmento da URL, que nenhum navegador envia a servidor.",
    // sonda de alcance do endereço do app (desktop, P2-197): linha calma abaixo do QR
    pairReachOk: "O endereço do app respondeu — o QR está pronto para o celular.",
    pairReachRetry: "Testar de novo",
    pairReachTesting: "Testando de novo…",
    // elo daemon↔relay (desktop, P2-199): linha discreta abaixo da linha de alcance
    pairRelayLinkOk: "O app está falando com o relay — a sala está pronta para o celular.",
    pairRelayLinkLocal: "Modo local — o celular pareia direto na rede desta máquina, sem relay.",
    webAppTitle: "Endereço do app (celular)",
    webAppHint:
      "Onde o celular abre o app — derivado do relay do celular (wss:// vira https://, mesmo host e porta), a menos que você salve um aqui.",
    webAppInvalid: "Endereço de app inválido — use https://relay.exemplo.com:8788 (ou http:// apenas para um host nesta máquina).",
    webAppOriginStored: "Salvo nesta máquina.",
    webAppOriginDerived: "Derivado do relay do celular — mesmo host e porta, wss:// vira https://.",
    webAppOriginUnavailable: "Sem endereço utilizável — o relay local só atende esta máquina.",
    webAppReset: "Usar o endereço do relay",
    localConnecting: "Conectando ao daemon local…",
    // jornada degradada no primeiro boot (desktop, P2-112): daemon morto no
    // primeiro contato nunca vira beco sem saída — status calmo, retry
    // automático visível, dados locais mínimos e o pareamento a um clique.
    firstContactTitle: "Conectando pela primeira vez…",
    firstContactHint:
      "Conversas, arquivos e artifacts sincronizam assim que o daemon local responder. Nada se perde — esta tela segue tentando sozinha.",
    degradedRetrying: "Tentando sozinho…",
    degradedDownHint:
      "As tentativas automáticas pararam. Use Reconectar agora — ou espere: quando o daemon voltar, o app reconecta sozinho.",
    degradedLocalTitle: "Disponível offline",
    degradedLocalHint: "Idioma e tema ficam nesta máquina — funcionam agora.",
    degradedPairManually: "Parear outro dispositivo manualmente",
    // P2-138: aviso do upstream (opencode) dentro do card calmo + seção de
    // ajuda das Configurações. Quatro states do classificador, tom honesto e
    // calmo — reason/hint do daemon entram só como detalhe secundário em texto.
    upstreamUnreachableTitle: "Servidor do agente não encontrado",
    upstreamUnreachableAction: "Confira se o opencode está instalado e rodando nesta máquina (opencode serve).",
    upstreamUnauthorizedTitle: "A senha do agente mudou",
    upstreamUnauthorizedAction: "Atualize a credencial do agente — o app reconecta sozinho depois.",
    upstreamTimeoutTitle: "Servidor do agente demora a responder",
    upstreamTimeoutAction: "Se persistir, reinicie o opencode nesta máquina.",
    upstreamUnhealthyTitle: "Servidor do agente respondeu mal",
    upstreamUnhealthyAction: "Reinicie o opencode nesta máquina e confira a versão do servidor.",
    upstreamHelpAction: "Abrir ajuda da configuração",
    upstreamHelpTitle: "Ajuda do servidor de agente",
    // P2-140: por que o daemon local morreu — dentro do mesmo card calmo.
    // Tom honesto e acionável, uma superfície só; sem caminhos nem segredos.
    sidecarPortBusyTitle: "Outro programa ocupou a porta do daemon",
    sidecarPortBusyAction:
      "Feche o programa que usa a porta do daemon (ou reinicie a máquina) e reabra o app.",
    sidecarEntryMissingTitle: "Arquivos do daemon não encontrados",
    sidecarEntryMissingAction: "Reinstale o aplicativo para restaurar a instalação e reabra.",
    sidecarRuntimeErrorTitle: "O daemon falhou ao iniciar",
    sidecarRuntimeErrorAction: "Reabra o app; se persistir, envie o diagnóstico em Configurações → Ajuda.",
    sidecarKilledTitle: "O sistema encerrou o daemon",
    sidecarKilledAction: "Reabra o app — ele reconecta sozinho; se repetir, feche outros programas pesados.",
    sidecarUnknownTitle: "O daemon saiu de forma inesperada",
    sidecarUnknownAction: "Reabra o app; se persistir, envie o diagnóstico em Configurações → Ajuda.",
    // P2-148: boas-vindas de primeira execução — três passos, mostrados uma
    // vez, puláveis a qualquer momento. Frases simples e calmas; o passo 2
    // reusa a copy da jornada degradada.
    welcomeStepOf: "Passo {n} de 3",
    welcomeStep1Title: "Controle esta máquina pelo celular",
    welcomeStep1Body:
      "O OpenCode Remote roda seu agente de IA nesta máquina e pareia com o seu celular — criptografado ponta a ponta.",
    welcomeStart: "Começar",
    welcomeSkip: "Pular",
    welcomeNext: "Avançar",
    welcomeStep2Title: "Seu agente local",
    welcomeAgentOk: "Agente local em execução",
    welcomeStep3Title: "Parear um celular (opcional)",
    welcomeStep3Body:
      "Dá para escanear o código de pareamento quando quiser nas Configurações — ou fazer agora e controlar esta máquina de longe.",
    welcomeLater: "Fazer isso depois",
    welcomeDone: "Pronto",
    welcomePairedTitle: "Celular pareado",
    welcomePairedHint: "O celular já está falando com esta máquina — pode fechar e usar.",
    welcomeQrWait: "Gerando QR…",
    reconnectTrying: "Tentando…",
    reconnectStarted: "Reinício do daemon iniciado — o app reconecta sozinho.",
    reconnectFailed: "Não deu pra reiniciar o daemon agora — tente de novo em instantes.",
    // command palette (desktop, P1-046)
    palettePlaceholder: "Buscar conversas e ações…",
    paletteEmpty: "Nada encontrado",
    paletteNewChat: "Nova conversa",
    paletteOpenArtifacts: "Abrir Artifacts",
    paletteOpenBrowser: "Abrir Browser",
    paletteOpenFiles: "Abrir Arquivos",
    paletteOpenSettings: "Abrir Configurações",
    paletteKindAction: "ação",
    paletteKindSession: "conversa",
    // mission control (desktop, P2-048)
    paletteOpenMission: "Abrir Mission Control",
    missionDesktopOnly: "O Mission Control lê os registros locais do pilot — abra o app na máquina host.",
    missionLoading: "Carregando sessões de agente…",
    missionEmpty: "Nenhuma sessão de agente registrada ainda.",
    missionSelect: "Selecione uma sessão para abrir a timeline forense.",
    missionSt_running: "rodando",
    missionSt_merged: "merged",
    missionSt_failed: "falhou",
    missionEffort: "esforço",
    missionRounds: "{n} rodada(s)",
    missionEta: "ETA",
    missionGateFails: "{n} falha(s) de gate",
    missionF_all: "tudo",
    missionF_decision: "decisões",
    missionF_gate: "gate",
    missionF_review: "review",
    missionF_deploy: "deploy",
    missionTakeover: "Assumir",
    missionTakenOver: "Terminal aberto no host, anexado à sessão do agente.",
    missionNoEntries: "Sem registros forenses para este filtro.",
    missionShots: "Shots pós-deploy",
    missionLiveShot: "Shot ao vivo do dashboard",
    missionLive: "Ao vivo",
    unitMin: "min",
    // pairing screen (P2-049). P1-070: copy local-first — o desktop se conecta
    // sozinho ao daemon da mesma máquina, sem código aqui.
    // P2-106: uma frase — as seções abaixo carregam o detalhe.
    pairIntro:
      "O OpenCode Remote se conecta sozinho ao daemon desta máquina — para conectar outro dispositivo, escaneie o QR do daemon ou cole um código de pareamento.",
    // P2-106: as duas direções do pareamento viram seções tituladas (cliente/host).
    pairConnectTitle: "Conectar a outra máquina",
    pairHostTitle: "Parear um celular com esta máquina",
    scanQr: "Escanear QR code",
    orPaste: "— ou cole manualmente —",
    // QR scanner state machine (P2-117): looking → preview → unavailable
    scanTitle: "Escanear código de pareamento",
    scanBack: "Voltar",
    scanLooking: "Procurando câmera…",
    scanHint: "Aponte a câmera pro código de pareamento mostrado pelo daemon.",
    scanPasteCta: "Colar código de pareamento",
    "scanErr_permission": "Permissão de câmera negada. Libere o acesso pra este app e tente de novo.",
    "scanErr_no-device": "Nenhuma câmera encontrada neste dispositivo.",
    "scanErr_busy": "A câmera está em uso por outro app. Feche-o e tente de novo.",
    "scanErr_interrupted": "A câmera foi interrompida. Tente de novo.",
    "scanErr_no-signal": "A câmera não tem sinal — dispositivos de captura sem entrada mostram isso. Cole o código de pareamento no lugar.",
    "scanErr_generic": "Câmera indisponível.",
    orScan: "— ou escaneie o QR —",
    pairBtn: "Parear",
    connecting: "Conectando…",
    invalidCode: "Código de pareamento inválido",
    // P2-106: helper inline sob o erro de código inválido — mostra o formato
    // esperado pra correção ser óbvia.
    invalidCodeHint:
      "Formato esperado: opencode-remote://pair?v=2&relay=… — copie o código inteiro, exatamente como a outra máquina mostra.",
    // chat composer + header (P2-049)
    send: "Enviar",
    messagePlaceholder: "Mensagem pro agente…",
    recording: "gravando…",
    streamingWait: "Agente respondendo — espere ou Pare",
    thinkingLive: "Pensando…",
    thoughtFor: "Pensou por {n}s",
    thoughtLabel: "Pensou",
    attachFile: "Anexar arquivo",
    micNeedsPermission: "Microfone indisponível — permita o acesso pra gravar voz",
    modelSelector: "Agente e modelo",
    defaultModel: "modelo padrão",
    stopRecording: "Parar gravação",
    recordVoice: "Gravar voz",
    missionDash: "Dashboard ao vivo",
    missionForensic: "Linha do tempo",
    missionActive: "Missão ativa",
    missionActiveNone: "Nenhuma missão definida. Defina no chat: descreva o que você quer e, se quiser, cole o link de um repo do GitHub.",
    missionSource: "origem",
    missionSourcePrompt: "prompt",
    missionSourceRepo: "repo",
    missionSetAt: "definida em",
    missionModels: "modelos",
    missionModelSubstituted: "modelo indisponível, rodando o padrão no lugar",
    missionClear: "Encerrar missão",
    missionClearConfirm: "Confirmar: encerrar missão",
    missionCleared: "Missão encerrada. A frota volta ao repo dela no próximo boot.",
    missionClearFailed: "Não foi possível encerrar a missão.",
    voiceReply: "Falar respostas",
    voiceReplyOn: "Respostas faladas — clique pra silenciar",
    stopSpeaking: "Parar fala",
    voiceReplyUnavailable: "Respostas faladas indisponíveis neste host",
    voiceOutLang: "Voz das respostas",
    toolActivity: "atividade de tools",
    noToolCalls: "nenhuma tool chamada ainda",
    refreshTools: "Atualizar histórico de tools",
    agentMode: "Modo do agente",
    agentOption: "agente",
    model: "Modelo",
    openArtifact: "Abrir artifact",
    trimStart: "Início do corte (s)",
    trimEnd: "Fim do corte (s)",
    attach: "Anexar",
    full: "Completo",
    removeImage: "Remover imagem",
    olderMessages: "{n} mensagens anteriores",
    loadingDiff: "carregando diff…",
    changesFor: "mudanças de {action}",
    noChanges: "sem mudanças de arquivos neste pedido",
    close: "Fechar",
    back: "Voltar",
    queuedTitle: "na fila — envia quando voltar a conexão",
    connTitle: "conexão: {status}",
    sessionFallback: "sessão",
    ctxGauge: "Uso de contexto",
    ctxGaugeDetail: "Contexto: {pct}% da janela do modelo ({tokens} de {window} tokens)",
    recapLabel: "Recap",
    recapDetail: "Onde a conversa parou",
    jumpToEnd: "Ir pro fim",
    resizeSplit: "Redimensionar preview do artifact",
    // a11y (P2-049)
    rename: "Renomear",
    delete: "Apagar",
    // chat history paging + session list grouping (P1-064)
    loadMore: "Carregar mensagens anteriores",
    historyRetry: "Não deu pra carregar o histórico da conversa.",
    pilotGroup: "Sessões do pilot ({n})",
    // agrupamento temporal + arquivo (P3-084)
    groupToday: "Hoje",
    groupYesterday: "Ontem",
    groupEarlier: "Anteriores",
    groupArchived: "Arquivadas ({n})",
    archive: "Arquivar",
    restore: "Restaurar",
    // scanner de QR (câmera in-app, P2-118)
    scanPairingTitle: "Escanear código de pareamento",
    scanPointCamera: "Aponte a câmera pro QR code mostrado pelo daemon.",
    scanBackManual: "Voltar ao pareamento manual",
    camDenied:
      "Permissão de câmera negada. Permita o acesso pra este site (Ajustes → Safari → Câmera) e tente de novo.",
    camNotFound: "Nenhuma câmera encontrada neste dispositivo.",
    camBusy: "A câmera está em uso por outro app. Feche-o e tente de novo.",
    camInterrupted:
      "A câmera foi interrompida. Toque em Escanear de novo — o iOS às vezes aborta a primeira tentativa.",
    camUnavailable: "câmera indisponível",
    // home do desktop (P2-123): greeting, composer central e seção de ideias.
    homeGreeting: "De volta à ação, {name}",
    homeGreetingAnon: "De volta à ação",
    homePlaceholder: "Como posso ajudar você hoje?",
    homeIdeasTitle: "Ideias para você",
    homeIdea1Label: "Continuar de onde parei",
    homeIdea1Prompt:
      "Retome o trabalho no meu último projeto: liste o que ficou pendente e sugira o próximo passo.",
    homeIdea2Label: "Explicar um trecho de código",
    homeIdea2Prompt: "Explique de forma simples o que este trecho de código faz e onde ele pode quebrar:\n",
    homeIdea3Label: "Resumo das conversas recentes",
    homeIdea3Prompt: "Resuma minhas conversas recentes, com o próximo passo de cada uma.",
    homeStartError: "Não deu pra iniciar a conversa. Verifique a conexão e tente de novo.",
    // P2-220: aviso de instalação acima da lista de conversas (iPhone/iPad,
    // aba comum, pareamento salvo). Dispensar é definitivo — documentado.
    // EXATAMENTE a frase do módulo puro (afirmado por scripts/unit.test.ts).
    installHintBody: INSTALL_HINT_MESSAGE,
    installHintDismiss: "Dispensar",
    // P2-266: faixa de versão nova — uma linha calma + ação explícita; o
    // botão é o único caminho que troca o worker esperado.
    swUpdateReady: "Uma versão nova do app está pronta.",
    swUpdateAction: "Atualizar agora",
    // P2-232: seção Estado da máquina (Configurações) — rótulos por idioma;
    // as frases das linhas vêm da própria máquina, nunca daqui.
    machineStateTitle: "Estado da máquina",
    machineStateEmpty: "Nada a mostrar ainda — a máquina ainda não informou o estado.",
    machineStateAllOkTitle: "Tudo certo nesta máquina.",
    machineStateAttentionTitle: "Um ou mais itens pedem atenção nesta máquina.",
    machineStateUnavailableTitle: "Algo está indisponível nesta máquina.",
    machineLabelRelay: "Conexão remota",
    machineLabelAgent: "Servidor do agente",
    machineLabelVersion: "Versão do agente",
    machineLabelDisk: "Espaço em disco",
    machineLabelDocs: "Conversão de documentos",
    // P2-275: seções restantes das Configurações no dicionário — o SettingsView
    // não tem mais copy literal no JSX. Nomes de produto (MCP, AutoMode) ficam.
    aboutTitle: "Sobre",
    aboutVersions: "app {app} · daemon {daemon}",
    save: "Salvar",
    machineNamePlaceholder: "nome da máquina",
    remove: "Remover",
    mcpTypeLocal: "local",
    mcpTypeRemote: "remoto",
    voiceInLang: "Idioma",
    voiceLangAuto: "Detectar automaticamente",
    voiceLangEn: "Inglês",
    voiceLangPt: "Português",
    voiceLangEs: "Espanhol",
    voiceLangFr: "Francês",
    ttsVoicePt: "Português (Antonio)",
    ttsVoiceEn: "Inglês (Andrew)",
    ttsVoiceEs: "Espanhol (Alvaro)",
    captionStyleTitle: "Estilo de legenda (clips)",
    captionFont: "Fonte (ex: Helvetica Bold)",
    captionFontSize: "Tamanho",
    captionPrimary: "Cor primária (&H..)",
    captionHighlight: "Cor de destaque (&H..)",
    captionOutline: "Cor do contorno (&H..)",
    captionMargin: "Margem inferior",
    captionSave: "Salvar estilo",
    captionSaved: "estilo de legenda salvo",
    appearanceTitle: "Aparência",
    themeLabel: "Tema",
    themeSystem: "Sistema",
    themeDark: "Escuro",
    themeLight: "Claro",
    fontLabel: "Tamanho da fonte",
    fontSmall: "Pequena",
    fontNormal: "Normal",
    fontLarge: "Grande",
    pushTitle: "Notificações push",
    pushSendTest: "Enviar notificação de teste",
    pushSending: "Enviando…",
    pushResubscribe: "Reinscrever",
    pushSubscribed: "inscrito",
    pushNoDevices: "nenhum dispositivo inscrito — toque em Reinscrever",
    pushSentOk: "enviado — confira o celular",
    pushSubsCount: "{n} dispositivo(s) inscrito(s) · iOS: o app precisa estar na Tela de Início",
    shareTitle: "Compartilhar com o agente",
    shareAndroidLabel: "Android/desktop",
    shareAndroidBody: "a folha de compartilhamento do sistema oferece \"OpenCode Remote\" direto.",
    shareIosLabel: "iOS",
    shareIosBody:
      "copie o link em qualquer lugar, abra o app, segure o campo de mensagem → Colar, escreva sua instrução e envie. Ou crie um Atalho (app Atalhos) que copia o texto compartilhado e abre \"OpenCode Remote\".",
    skillsTitle: "Skills (prompts de 1 toque)",
    skillLabelPlaceholder: "rótulo (ex: Relatório diário)",
    skillPromptPlaceholder: "prompt enviado ao agente ao tocar",
    skillAdd: "Adicionar skill",
    skillAdded: "skill adicionada",
    skillRejected: "skill recusada — rótulo e prompt são obrigatórios",
    routinesTitle: "Rotinas agendadas",
    routineEveryDay: "Todos os dias",
    routineSpecificDays: "Dias específicos",
    routineLoop: "Repetir a cada N min",
    routineModeLabel: "Modo de agendamento",
    routineIntervalLabel: "Intervalo em minutos",
    routineNamePlaceholder: "nome",
    routineIntervalHint: "roda imediatamente e depois a cada N minutos enquanto o daemon estiver no ar (mín. 5)",
    routinePromptPlaceholder: "prompt para o agente (ex: resumir notícias de cripto e salvar um relatório)",
    routineAdd: "Adicionar rotina",
    routineAdded: "rotina adicionada",
    routineRejected: "rotina recusada — confira os campos",
    routineEvery: "a cada {n} min",
    routineDaily: "todo dia {time}",
    routineLastError: "último erro: {err}",
    routineLastOk: "última execução: ok",
    routineNeverRan: "nunca executou",
    daySun: "Dom",
    dayMon: "Seg",
    dayTue: "Ter",
    dayWed: "Qua",
    dayThu: "Qui",
    dayFri: "Sex",
    daySat: "Sáb",
    dayLetter0: "D",
    dayLetter1: "S",
    dayLetter2: "T",
    dayLetter3: "Q",
    dayLetter4: "Q",
    dayLetter5: "S",
    dayLetter6: "S",
    deviceFallback: "dispositivo",
    revoke: "Revogar",
    securityLog: "Registro de segurança",
  },
} satisfies Record<Lang, Record<string, string>>;
