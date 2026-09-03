/**
 * P3-085 unit tests: the collapsible "Pensou por Xs" thinking block state —
 * the pure reducer that folds reasoning/thinking stream events (lib/thinking)
 * plus the history extraction (rowsToBubbles) that renders it post-hoc.
 * Run: npx tsx scripts/thinking.test.ts
 */
import { reduceThinking, thinkingExpanded, thinkingSeconds, type ThinkingState } from "../apps/web/src/lib/thinking";
import { rowsToBubbles, type HistoryRow } from "../apps/web/src/lib/bubbleMerge";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const SID = "ses-thinking";
const reasoningEvt = (text: string) => ({
  type: "message.part.updated",
  properties: { sessionID: SID, part: { type: "reasoning", text, messageID: "msg-1" } },
});
const textEvt = (text: string) => ({
  type: "message.part.updated",
  properties: { sessionID: SID, part: { type: "text", text, messageID: "msg-1" } },
});

// a reasoning part opens the block expanded, with the event's timestamp
const s1 = reduceThinking(null, reasoningEvt("Vou analisar o diff"), SID, 1_000);
check("reasoning part creates an expanded state", !!s1 && thinkingExpanded(s1) === true, JSON.stringify(s1));
check("first reasoning part anchors startedAt", !!s1 && s1.startedAt === 1_000, JSON.stringify(s1));

// parts are snapshots: latest wins, startedAt is preserved
const s2 = reduceThinking(s1, reasoningEvt("Vou analisar o diff e o build"), SID, 2_500);
check(
  "latest reasoning snapshot wins, startedAt preserved",
  !!s2 && s2.text === "Vou analisar o diff e o build" && s2.startedAt === 1_000,
  JSON.stringify(s2),
);

// the answer text arriving freezes the duration -> collapsed by default
const s3 = reduceThinking(s2, textEvt("Aqui está a resposta"), SID, 4_000);
check("answer text freezes the thinking window (collapsed)", !!s3 && thinkingExpanded(s3) === false, JSON.stringify(s3));
check("endedAt pinned at the first text part", !!s3 && s3.endedAt === 4_000, JSON.stringify(s3));

// more reasoning after the answer: the model is thinking again — reopen
const s4 = reduceThinking(s3, reasoningEvt("Segunda passada"), SID, 5_000);
check("reasoning after text reopens the block (endedAt reset)", !!s4 && thinkingExpanded(s4) === true, JSON.stringify(s4));

// idle freezes again (e.g. a turn that never produced answer text)
const s5 = reduceThinking(s4, { type: "session.idle", properties: { sessionID: SID } }, SID, 9_000);
check("session.idle freezes the window (collapsed)", !!s5 && thinkingExpanded(s5) === false, JSON.stringify(s5));

// seconds: rounded, never 0
check("seconds round to whole values (5s window)", thinkingSeconds({ text: "x", startedAt: 0, endedAt: 5_000 }) === 5);
check("seconds floor at 1 (sub-second thinking)", thinkingSeconds({ text: "x", startedAt: 0, endedAt: 400 }) === 1);
check("seconds round up (2.5s -> 3)", thinkingSeconds({ text: "x", startedAt: 0, endedAt: 2_500 }) === 3);

// events from other sessions must not touch the state
const s6 = reduceThinking(null, reasoningEvt("outra sessão"), "ses-other", 1_000);
check("events of other sessions are ignored", s6 === null);

// empty/absent reasoning text is a no-op (tool parts, file parts…)
check("tool part creates no thinking state", reduceThinking(null, { type: "message.part.updated", properties: { sessionID: SID, part: { type: "tool", callID: "c1" } } }, SID, 1_000) === null);
check("empty reasoning snapshot is ignored", reduceThinking(null, { type: "message.part.updated", properties: { sessionID: SID, part: { type: "reasoning", text: "" } } }, SID, 1_000) === null);

// reviewer round 2: with a live thinking state, tool/file/step parts stream
// mid-turn — they must NOT freeze the window (only answer text or idle does)
const midTurn = reduceThinking(null, reasoningEvt("Pensando entre tool calls"), SID, 1_000);
const toolMidTurn = reduceThinking(midTurn, { type: "message.part.updated", properties: { sessionID: SID, part: { type: "tool", callID: "c1", state: { status: "running" } } } }, SID, 2_000);
check("tool part mid-turn does NOT freeze the window (stays expanded)", !!toolMidTurn && thinkingExpanded(toolMidTurn) === true, JSON.stringify(toolMidTurn));
check("tool part mid-turn leaves endedAt untouched", !!toolMidTurn && toolMidTurn.endedAt === undefined, JSON.stringify(toolMidTurn));
const fileMidTurn = reduceThinking(midTurn, { type: "message.part.updated", properties: { sessionID: SID, part: { type: "file", url: "data:image/png;base64,x" } } }, SID, 3_000);
check("file part mid-turn does NOT freeze the window", !!fileMidTurn && thinkingExpanded(fileMidTurn) === true, JSON.stringify(fileMidTurn));
// reasoning after the tool result still anchors at the ORIGINAL startedAt
const resumed = reduceThinking(toolMidTurn, reasoningEvt("Voltando a pensar"), SID, 4_000);
check("reasoning after a tool part keeps the original startedAt", !!resumed && resumed.startedAt === 1_000 && thinkingExpanded(resumed) === true, JSON.stringify(resumed));
// and the text part STILL freezes after tool parts — no stale collapse
const textAfterTools = reduceThinking(resumed, textEvt("Resposta"), SID, 5_000);
check("answer text freezes the window even after mid-turn tool parts", !!textAfterTools && thinkingExpanded(textAfterTools) === false && textAfterTools.endedAt === 5_000, JSON.stringify(textAfterTools));

// collapsed-state unit: a fresh block starts collapsed when rendering from
// history (streaming=false) and expanded only while live-thinking — the
// aria-expanded default the desktop-flow gate asserts.
const histRows: HistoryRow[] = [
  {
    info: { id: "msg-1", role: "assistant" },
    parts: [
      { type: "reasoning", text: "Pensou de verdade" },
      { type: "text", text: "Resposta" },
    ],
  },
  {
    info: { id: "msg-2", role: "user" },
    parts: [{ type: "text", text: "pergunta" }],
  },
];
const bubbles = rowsToBubbles(histRows);
check("history: reasoning renders as the thinking block above the answer", bubbles.length === 2 && bubbles[0]?.thinking?.text === "Pensou de verdade", JSON.stringify(bubbles));
check("history: user rows never carry thinking", bubbles[1]?.thinking === undefined);
check("history: thinking block starts collapsed (no secs in history)", bubbles[0]?.thinking?.secs === undefined);
const live: ThinkingState = { text: "ao vivo", startedAt: 0 };
check("live: active thinking is expanded", thinkingExpanded(live) === true);
check("live: finalized thinking is collapsed", thinkingExpanded({ ...live, endedAt: 2_000 }) === false);
check("no thinking at all: collapsed decision is false (null-safe)", thinkingExpanded(null) === false);

if (failures > 0) {
  console.error(`FAILURES: ${failures}`);
  process.exit(1);
}
console.log("thinking state: all green");
