/**
 * eval-10 (PWA mobile UX round, 2026-09-27): regression battery for the
 * phone-experience fixes. Every block pins a failure reproduced on main in a
 * hermetic stack (fake opencode + relay + daemon + built PWA, playwright at
 * 390x844): a short agent error crashed the whole app (React #31), a turn
 * longer than 60 s sent the prompt twice, the daemon's artifacts-path line
 * leaked into the user bubble, the home composer kept the text it had just
 * sent, approvals asked during a reconnect gap (or left pending under
 * AutoMode) never became visible, and approval failures painted raw JSON.
 * Run: npx tsx scripts/pwa-mobile-ux.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentErrorMessage, humanizeError } from "../apps/web/src/lib/errors";
import { dict, translate } from "../apps/web/src/lib/i18n";
import {
  INJECTED_PATH_MARKER,
  isInjectedPart,
  keepInflight,
  rowsToBubbles,
  type Bubble,
  type HistoryRow,
} from "../apps/web/src/lib/bubbleMerge";
import { previewFromEvents } from "../apps/web/src/lib/sessionPreview";
import { consumeSendOnOpen, getDraft, markSendOnOpen, setDraft } from "../apps/web/src/lib/drafts";
import { SEND_TIMEOUT_MS, sendFailurePlan } from "../apps/web/src/lib/sendfail";
import {
  AUTO_APPROVED_EVENT,
  AUTO_APPROVE_GRACE_MS,
  AUTO_FAILED_EVENT,
  collectPermissionAsks,
  reconcilePermissionCards,
  staleAutoAsks,
} from "../apps/web/src/lib/permissionCards";
import { ARTIFACTS_PATH_MARKER, buildArtifactsPathLine } from "../apps/daemon/src/sessionctx";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("   ", detail);
  }
}

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const chatSrc = read("apps/web/src/components/ChatView.tsx");
const tPt = (k: string, v?: Record<string, string | number>) => translate("pt", k, v);
const tEn = (k: string, v?: Record<string, string | number>) => translate("en", k, v);

// --- 1. agent errors never crash the app nor paint raw JSON ------------------
{
  // opencode `session.error` payloads, byte-for-byte shapes (UnknownError is
  // ~100 chars: short enough for the old 200-char cut to stay valid JSON)
  const short = { sessionID: "ses_x", error: { name: "UnknownError", data: { message: "boom: provider exploded" } } };
  const long = {
    sessionID: "ses_seed_recent",
    error: {
      name: "ProviderAuthError",
      data: {
        providerID: "anthropic",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits. request_id=req_011CUxxxxxxxxxxxxxxxxxxxx",
      },
    },
  };
  // the legacy producer (JSON.stringify(props).slice(0, 200)) — kept as input:
  // any old string still in flight must render safely too
  const legacyShort = humanizeError(`agent error: ${JSON.stringify(short).slice(0, 200)}`, tPt);
  check(
    "agent error (legacy short payload): humanizeError returns a string, never the parsed object (React #31)",
    typeof legacyShort === "string",
    `got ${typeof legacyShort}`,
  );
  check(
    "agent error (legacy short payload): localized copy carries the provider message",
    legacyShort === tPt("errAgentFailed", { message: "boom: provider exploded" }),
    String(legacyShort),
  );
  const legacyLong = humanizeError(`agent error: ${JSON.stringify(long).slice(0, 200)}`, tPt);
  check(
    "agent error (legacy truncated payload): no raw JSON fragment on screen",
    typeof legacyLong === "string" && !legacyLong.includes('{"') && legacyLong.includes("Your credit balance"),
    String(legacyLong),
  );
  // the new producer: ChatView sends `agent error: {"error":"<message>"}`
  const produced = `agent error: ${JSON.stringify({ error: agentErrorMessage(short) })}`;
  check(
    "agent error (new producer): pt copy",
    humanizeError(produced, tPt) === "O agente parou com um erro: boom: provider exploded",
    humanizeError(produced, tPt),
  );
  check(
    "agent error (new producer): en copy",
    humanizeError(produced, tEn) === "The agent stopped with an error: boom: provider exploded",
    humanizeError(produced, tEn),
  );
  check(
    "agent error: a provider message mentioning 'network' is not misread as a queued message",
    humanizeError(`agent error: ${JSON.stringify({ error: "network timeout talking to provider" })}`, tPt).includes(
      "network timeout talking to provider",
    ),
  );
  check(
    "agent error: nothing readable → generic localized copy",
    humanizeError(`agent error: ${JSON.stringify({ error: agentErrorMessage({}) })}`, tPt) === tPt("errAgentFailedGeneric"),
  );
  check("agentErrorMessage: data.message wins", agentErrorMessage(short) === "boom: provider exploded");
  check("agentErrorMessage: string error", agentErrorMessage({ error: "plain" }) === "plain");
  check("agentErrorMessage: error.message", agentErrorMessage({ error: { message: "m" } }) === "m");
  check("agentErrorMessage: name fallback", agentErrorMessage({ error: { name: "APIError" } }) === "APIError");
  check("agentErrorMessage: empty payloads", agentErrorMessage(undefined) === "" && agentErrorMessage({ error: 42 }) === "");
  check(
    "agentErrorMessage: capped to one short line",
    agentErrorMessage({ error: { data: { message: "x".repeat(2000) } } }).length <= 300,
  );
  check(
    "ChatView: the stream builds the agent error through agentErrorMessage (no 200-char cut of the payload)",
    chatSrc.includes("JSON.stringify({ error: agentErrorMessage(evt.properties) })") &&
      !chatSrc.includes("JSON.stringify(evt.properties).slice(0, 200)"),
  );
  const boundary = read("apps/web/src/components/ErrorBoundary.tsx");
  check(
    "ErrorBoundary: localized fallback, no hardcoded English",
    boundary.includes('translate(lang, "crashTitle")') && !boundary.includes(">Something broke<") && !boundary.includes("Try again\n"),
  );
}

// --- 2. a long turn is never re-sent -----------------------------------------
{
  check("sendFailurePlan: echoed prompt → delivered (never resend)", sendFailurePlan({ echoed: true, hasText: true }) === "delivered");
  check("sendFailurePlan: echoed attachment-only prompt → delivered", sendFailurePlan({ echoed: true, hasText: false }) === "delivered");
  check("sendFailurePlan: no echo + text → queue (offline path kept)", sendFailurePlan({ echoed: false, hasText: true }) === "queue");
  check("sendFailurePlan: no echo + nothing re-sendable → error", sendFailurePlan({ echoed: false, hasText: false }) === "error");
  check("SEND_TIMEOUT_MS outlives long agent turns (≥ 10 min)", SEND_TIMEOUT_MS >= 10 * 60_000);
  const sends = chatSrc.match(/request\("POST", `\/session\/\$\{sessionId\}\/message`, body[^)]*\)/g) ?? [];
  check(
    "ChatView: both prompt POSTs (first try + 410 retry) carry SEND_TIMEOUT_MS",
    sends.length === 2 && sends.every((s) => s.includes("SEND_TIMEOUT_MS")),
    sends.join(" | "),
  );
  check(
    "ChatView: the send failure path consults sendFailurePlan with the echo flag",
    chatSrc.includes("sendFailurePlan({ echoed: echo.echoed, hasText: !!text })") &&
      chatSrc.includes("if (firstSight && promptEchoRef.current) promptEchoRef.current.echoed = true;"),
  );
}

// --- 3. r4 PR-B1: the injected artifacts-path line never reaches a bubble -----
{
  check(
    "marker mirror: INJECTED_PATH_MARKER === [ARTIFACTS_PATH_MARKER] of the daemon",
    INJECTED_PATH_MARKER === `[${ARTIFACTS_PATH_MARKER}]`,
  );
  const pathLine = buildArtifactsPathLine("ses_abc");
  const rows: HistoryRow[] = [
    { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "Oi! Lista os arquivos." }, { type: "text", text: pathLine }] },
    { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: `Vi a linha ${INJECTED_PATH_MARKER} no prompt.` }] },
    { info: { id: "m3", role: "user" }, parts: [{ type: "text", text: "Resume" }, { type: "text", text: "Called the Read tool…", synthetic: true }] },
    {
      info: { id: "m4", role: "user" },
      parts: [
        { type: "file", filename: "relatorio.pdf", url: "data:application/pdf;base64,AAAA" },
        { type: "text", text: "Called the Read tool with the following input…", synthetic: true },
      ],
    },
  ];
  const bubbles = rowsToBubbles(rows);
  check("user bubble keeps only what the user typed", bubbles[0]?.text === "Oi! Lista os arquivos.", JSON.stringify(bubbles[0]?.text));
  check("no bubble mentions the machine's artifacts dir", !bubbles.some((b) => b.text.includes(".opencode-remote/artifacts")));
  check("assistant text quoting the marker is kept verbatim", bubbles[1]?.text.includes(INJECTED_PATH_MARKER) === true);
  check("opencode synthetic parts are skipped in user bubbles", bubbles[2]?.text === "Resume");
  check("document-only turn keeps a bubble named after the file", bubbles[3]?.text === "[file relatorio.pdf]", JSON.stringify(bubbles[3]));
  check("isInjectedPart: plain user text is not injected", !isInjectedPart({ type: "text", text: "oi" }, "user"));
  const preview = previewFromEvents([
    { type: "message.part.updated", properties: { sessionID: "s1", part: { type: "text", text: "Resposta pronta" } } },
    { type: "message.part.updated", properties: { sessionID: "s1", part: { type: "text", text: pathLine } } },
  ]);
  check("⌘K preview never shows the injected path line", preview.s1 === "Resposta pronta", JSON.stringify(preview));
}

// --- 4. the home composer's sent text does not stay in the chat composer ------
{
  setDraft("ses_home", "Oi! Lista os arquivos.");
  markSendOnOpen("Oi! Lista os arquivos.");
  const sent = consumeSendOnOpen("ses_home");
  check("consumeSendOnOpen returns the flagged text", sent === "Oi! Lista os arquivos.");
  check("consumeSendOnOpen clears the opened session's draft", getDraft("ses_home") === "");
  setDraft("ses_other", "rascunho meu");
  markSendOnOpen("outra coisa");
  check(
    "consumeSendOnOpen never touches a draft that is not the flagged text",
    consumeSendOnOpen("ses_other") === null && getDraft("ses_other") === "rascunho meu",
  );
  check(
    "ChatView consumes the send-on-open flag through consumeSendOnOpen",
    chatSrc.includes("const auto = consumeSendOnOpen(sessionId);") && !chatSrc.includes("takeSendOnOpen("),
  );
}

// --- 4b. a history read racing the first send never eats the user bubble ------
{
  const inflight: Bubble = { role: "user", text: "Oi! Lista os arquivos.", pending: true };
  check("empty history (read before the POST was stored) keeps the in-flight bubble", keepInflight([], [inflight]).length === 1);
  const stored: Bubble[] = [
    { role: "user", text: "Oi! Lista os arquivos.", messageID: "m1" },
    { role: "assistant", text: "Tudo certo.", messageID: "m2" },
  ];
  check("history that already holds the prompt wins (no duplicate)", keepInflight(stored, [inflight]).length === 2);
  check(
    "older history without the new prompt keeps it at the tail",
    keepInflight([{ role: "user", text: "antes", messageID: "m0" }], [inflight]).at(-1)?.text === "Oi! Lista os arquivos.",
  );
  check("queued (offline) bubbles are left to the reconnect flush", keepInflight([], [{ ...inflight, pending: "queued" }]).length === 0);
  check("settled or id-carrying bubbles never survive a history replace", keepInflight([], [{ ...inflight, pending: false }, { ...inflight, messageID: "m9" }]).length === 0);
  check("ChatView's history load goes through keepInflight", chatSrc.includes("setBubbles((cur) => keepInflight(out, cur));"));
}

// --- 5. approvals never sit invisible ----------------------------------------
{
  const daemonSrc = read("apps/daemon/src/index.ts");
  // the daemon names the events through constants (eval-12 automode.ts) or
  // literals (main) — either way the exact strings must appear there, and the
  // PWA's comparisons keep the same literals
  const daemonAuto = (() => {
    try {
      return read("apps/daemon/src/automode.ts");
    } catch {
      return "";
    }
  })();
  const daemonText = daemonSrc + daemonAuto;
  check(
    "AutoMode contract: the PWA constants match the daemon's event names",
    daemonText.includes(`"${AUTO_APPROVED_EVENT}"`) && daemonText.includes(`"${AUTO_FAILED_EVENT}"`),
  );
  const cardsSrc = read("apps/web/src/lib/permissionCards.ts");
  check(
    "AutoMode contract: PWA comparisons use the same event names",
    cardsSrc.includes(`type === "${AUTO_APPROVED_EVENT}"`) &&
      cardsSrc.includes(`type === "${AUTO_FAILED_EVENT.toLowerCase()}"`) &&
      chatSrc.includes(`"${AUTO_APPROVED_EVENT}"`) &&
      chatSrc.includes(`"${AUTO_FAILED_EVENT}"`),
  );
  const seen = new Map([["p1", 1_000]]);
  check(
    "staleAutoAsks: inside the grace → not stale",
    staleAutoAsks(seen, ["p1"], 1_000 + AUTO_APPROVE_GRACE_MS - 1).size === 0,
  );
  check("staleAutoAsks: at the grace → stale", staleAutoAsks(seen, ["p1"], 1_000 + AUTO_APPROVE_GRACE_MS).has("p1"));
  check("staleAutoAsks: never-seen id is never stale", staleAutoAsks(seen, ["p2"], 10 ** 12).size === 0);
  check("AUTO_APPROVE_GRACE_MS leaves the daemon's 2-attempt budget room (5–30 s)", AUTO_APPROVE_GRACE_MS >= 5_000 && AUTO_APPROVE_GRACE_MS <= 30_000);

  const ask = { permissionID: "p1", label: "bash" };
  const stale = new Set(["p1"]);
  const staleBoard = reconcilePermissionCards([], [ask], new Set(), true, stale);
  check(
    "AutoMode + pending past the grace → 1 manual card flagged autoStale",
    staleBoard.actionable.length === 1 && staleBoard.actionable[0]?.autoStale === true,
    JSON.stringify(staleBoard),
  );
  check(
    "AutoMode suppression unchanged inside the grace (no stale set)",
    reconcilePermissionCards([], [ask], new Set(), true).actionable.length === 0,
  );
  check(
    "manual mode ignores the stale set (plain card, no autoStale flag)",
    reconcilePermissionCards([], [ask], new Set(), false, stale).actionable[0]?.autoStale === undefined,
  );
  check(
    "a locally answered ask never resurfaces as stale",
    reconcilePermissionCards([], [ask], new Set(["p1"]), true, stale).actionable.length === 0,
  );
  const failed = collectPermissionAsks(
    [
      { type: "permission.updated", properties: { sessionID: "s1", permissionID: "p1", type: "bash" } },
      { type: AUTO_FAILED_EVENT, properties: { sessionID: "s1", permissionID: "p1", action: "bash" } },
    ],
    "s1",
  );
  const failedBoard = reconcilePermissionCards(failed, [ask], new Set(), true, stale);
  check(
    "a recorded auto-failure keeps its own flag (autoFailed, not autoStale)",
    failedBoard.actionable[0]?.autoFailed === true && failedBoard.actionable[0]?.autoStale === undefined,
  );
  const replied = collectPermissionAsks(
    [
      { type: "permission.asked", properties: { sessionID: "s1", id: "p9", type: "bash" } },
      { type: "permission.replied", properties: { sessionID: "s1", permissionID: "p9", response: "once" } },
    ],
    "s1",
  );
  check("resolved line keeps the real label after a type-less reply event", replied[0]?.label === "bash", JSON.stringify(replied));
  // opencode 1.18.32 wire shapes, read from the binary's schema:
  // PermissionRequest {id, sessionID, permission, patterns, metadata, always,
  // tool?: {messageID, callID}} and permission.replied {sessionID, requestID,
  // reply} — no `type` anywhere, so every event-derived card read "action"
  // (eval-12: 370 production auto-approvals logged action "action")
  const real = collectPermissionAsks(
    [
      {
        type: "permission.asked",
        properties: { id: "per_1", sessionID: "s1", permission: "bash", patterns: ["rm -rf build"], metadata: {}, always: [], tool: { messageID: "msg_1", callID: "c1" } },
      },
      { type: "ocr.permission.auto", properties: { sessionID: "s1", permissionID: "per_1", action: "action" } },
      { type: "permission.replied", properties: { sessionID: "s1", requestID: "per_1", reply: "once" } },
    ],
    "s1",
  );
  check(
    "opencode 1.18 permission.asked: the tool name comes from `permission`",
    real.length === 1 && real[0]?.label === "bash",
    JSON.stringify(real),
  );
  check("opencode 1.18 permission.asked: messageID comes from tool.messageID (diff scoping)", real[0]?.messageID === "msg_1");
  check("opencode 1.18 permission.asked: preview comes from patterns", real[0]?.preview === "rm -rf build");
  check("the daemon's \"action\" fallback never overwrites a real tool name", real[0]?.label === "bash");
  check(
    "opencode's trailing permission.replied keeps the AutoMode origin (resolved line says auto-approved)",
    real[0]?.auto === true && reconcilePermissionCards(real, [], new Set(), true).resolved[0]?.origin === "auto",
    JSON.stringify(real),
  );

  const resync = chatSrc.slice(chatSrc.indexOf("P1-061 stream resync"), chatSrc.indexOf("P1-061 stream resync") + 2_400);
  check(
    "reconnect resync re-reads pending approvals AND questions (events are never replayed)",
    resync.includes("void fetchPendingPermissions();") && resync.includes("void fetchPendingQuestions();"),
  );
  check(
    "ChatView feeds the stale set to the reconciler only under AutoMode",
    chatSrc.includes("staleAutoAsks(askSeenRef.current, persistedAsks.map((a) => a.permissionID), askClock)"),
  );
  check(
    "permission re-fetch is keyed on the newest permission event, not a buffer count",
    chatSrc.includes("}, [permEventKey]);") && !chatSrc.includes("permEventCount"),
  );
}

// --- 6. copy: localized, body-free action errors -----------------------------
{
  const keys = [
    "errAgentFailed",
    "errAgentFailedGeneric",
    "errApproveFailed",
    "errDenyFailed",
    "errAnswerFailed",
    "errRevertFailed",
    "errUnrevertFailed",
    "errExportFailed",
    "errHandoffFailed",
    "errStopFailed",
    "autoStale",
    "diffBtn",
    "crashTitle",
    "crashBody",
    "crashRetry",
    "crashDetails",
  ];
  const en = dict.en as Record<string, string>;
  const pt = dict.pt as Record<string, string>;
  // diffBtn is the one deliberate twin (same short word in both locales)
  const missing = keys.filter((k) => !en[k]?.trim() || !pt[k]?.trim() || (en[k] === pt[k] && k !== "diffBtn"));
  check("new copy exists in en AND pt, translated", missing.length === 0, missing.join(", "));
  for (const raw of ["approve failed (", "answer failed (", "revert failed (", "unrevert failed (", "export failed:", "handoff failed:"]) {
    check(`ChatView no longer paints \`${raw}…\``, !chatSrc.includes("setError(`" + raw));
  }
  check("diff button label rides the dict", chatSrc.includes('{t("diffBtn")}') && !chatSrc.includes(">diff</button>"));
  check(
    "label-less permission fallback is localized (never a bare English \"action\" in pt)",
    translate("pt", "permGenericAction") === "ação" &&
      chatSrc.includes('t("autoApproved", { action: permLabel(askLabel(p.permissionID, p.action)) })') &&
      chatSrc.includes("permLabel(r.label)") &&
      chatSrc.includes("permLabel(p.label)") &&
      !chatSrc.includes('p.action ?? "action"'),
  );
  check("Stop goes through stopAgent (failure is surfaced)", chatSrc.includes("onClick={() => void stopAgent()}"));
}

// --- 7. question options are real 44px rows ----------------------------------
{
  const css = read("apps/web/src/index.css");
  const at = css.indexOf(".q-opt {");
  const rule = css.slice(at, css.indexOf("}", at));
  check("CSS: .q-opt is a 44px flex row", at >= 0 && rule.includes("display: flex") && rule.includes("min-height: 44px"));
  check(
    "CSS: the option control escapes the global 100% input width",
    /\.q-opt input\[type="radio"\],\s*\.q-opt input\[type="checkbox"\] \{[^}]*width: 20px/.test(css),
  );
  check("ChatView: options render as .q-opt labels", chatSrc.includes('<label key={o.label} className="q-opt">'));
  // opencode 1.18 QuestionInfo: `custom` is optional with default TRUE — an
  // absent field must still offer the free-text answer
  check(
    "question card: the custom answer box follows opencode's default (custom !== false)",
    (chatSrc.match(/q\.custom !== false/g) ?? []).length === 3 && !/q\.custom &&/.test(chatSrc),
  );
  check(
    "CSS: the rewind chip gets a 44px-tall invisible hit area",
    chatSrc.includes('className="muted msg-rewind"') && /\.msg-rewind::before \{[^}]*inset: -11px -4px/.test(css),
  );
}

// --- 8. phone surfaces that were English-only ------------------------------------
{
  const share = read("apps/web/src/components/SendToAgentView.tsx");
  const files = read("apps/web/src/components/FilesView.tsx");
  const picker = read("apps/web/src/components/MachinePicker.tsx");
  for (const lit of [">Send to agent<", ">Shared content<", "+ New session & send", "…or send to an existing session:", ">sending…<", '"Shared from phone"', "send failed ("]) {
    check(`share target: no hardcoded \`${lit}\``, !share.includes(lit));
  }
  check("share target: the prompt POST carries SEND_TIMEOUT_MS", share.includes("SEND_TIMEOUT_MS,"));
  for (const lit of ["No files yet.", "Files on {\"\"}this machine", "list failed (", "no preview for "]) {
    check(`files pane: no hardcoded \`${lit}\``, !files.includes(lit));
  }
  // the machine picker's English close label stays: desktop-flow's P2-124 beat
  // selects the button by it (localizing it needs that selector moved first)
  void picker;
  const en = dict.en as Record<string, string>;
  const pt = dict.pt as Record<string, string>;
  const keys = ["shareContent", "shareEmpty", "shareExtraPlaceholder", "shareNewSession", "shareOrExisting", "shareSending", "shareSessionTitle", "shareSendFailed", "shareListFailed", "filesTitle", "filesEmpty", "filesListFailed", "filesNoPreview"];
  const missing = keys.filter((k) => !en[k]?.trim() || !pt[k]?.trim() || en[k] === pt[k]);
  check("share/files copy exists in en AND pt, translated", missing.length === 0, missing.join(", "));
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall pwa-mobile-ux checks passed");
