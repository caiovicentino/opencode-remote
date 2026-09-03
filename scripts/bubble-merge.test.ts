/**
 * P1-089 unit tests: mergeBubbles — the id-keyed history+stream merge that
 * keeps "switch conversation and come back" from re-rendering messages.
 * Run: npx tsx scripts/bubble-merge.test.ts
 */
import { mergeBubbles, type Bubble } from "../apps/web/src/lib/bubbleMerge";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const b = (messageID: string, text: string, role: Bubble["role"] = "assistant"): Bubble => ({
  role,
  text,
  messageID,
});

// spec acceptance 1: hist(a1..a4) + [a4'(id=a1), u1(id-less), a5] collapses to
// 5 unique ids in the order a1..a4,u1,a5 — the repeat id replaces IN PLACE.
const hist = [b("m1", "a1"), b("m2", "a2"), b("m3", "a3"), b("m4", "a4")];
const incoming = [b("m1", "a4-prime"), { role: "user" as const, text: "u1" }, b("m5", "a5")];
const merged = mergeBubbles(hist, incoming);
check(
  "acceptance 1: repeat id replaces in place, id-less appended (5 unique ids)",
  merged.length === 6 &&
    merged.map((x) => x.messageID ?? "-").join(",") === "m1,m2,m3,m4,-,m5" &&
    new Set(merged.map((x) => x.messageID).filter(Boolean)).size === 5,
  JSON.stringify(merged),
);
check(
  "acceptance 1: order a1..a4,u1,a5 with the replacement at a1's slot",
  merged[0]?.text === "a4-prime" &&
    merged[1]?.text === "a2" &&
    merged[4]?.role === "user" &&
    merged[4]?.text === "u1" &&
    merged[5]?.text === "a5",
  JSON.stringify(merged),
);
check(
  "acceptance 1: existing list is not mutated (pure merge)",
  hist.length === 4 && hist[0]?.text === "a1",
);

// spec acceptance 1: replaying the same incoming list twice is a no-op
const replayed = mergeBubbles(merged, incoming);
check(
  "acceptance 1: replay is idempotent",
  JSON.stringify(replayed) === JSON.stringify(merged),
  JSON.stringify(replayed),
);

// replay of a full event buffer after a reconnect resync: history replace +
// stream finalize must converge to one bubble per id, both orders
const streamedFirst = mergeBubbles([], [b("m7", "live tail"), b("m8", "live 2")]);
const historyAfter = mergeBubbles(streamedFirst, [b("m7", "history tail"), b("m8", "history 2")]);
check(
  "resync: history entries replace streamed versions in place",
  historyAfter.length === 2 && historyAfter[0]?.text === "history tail",
  JSON.stringify(historyAfter),
);

// assistant message with several text parts: history joins with \n, the
// stream saw only the last part — same id must stay ONE bubble
const multiPart = mergeBubbles(
  [b("m9", "part one\npart two")],
  [b("m9", "part two")],
);
check(
  "multi-part message collapses to one bubble",
  multiPart.length === 1 && multiPart[0]?.messageID === "m9",
  JSON.stringify(multiPart),
);

// two DIFFERENT id-less bubbles with the same role+text are deduped on replay
// but two distinct id-less user messages both land (drafts are distinct texts)
const optimistic = mergeBubbles([{ role: "user", text: "hello" }], [{ role: "user", text: "hello" }]);
check(
  "id-less replay: identical optimistic bubble is not duplicated",
  optimistic.length === 1,
  JSON.stringify(optimistic),
);
const distinct = mergeBubbles([{ role: "user", text: "hello" }], [{ role: "user", text: "world" }]);
check(
  "id-less: distinct optimistic user messages both survive",
  distinct.length === 2,
  JSON.stringify(distinct),
);

// images-only bubbles keep their identity through the merge: an id NOT in the
// incoming list is preserved as-is, and a fetched replacement carries its own
// images (rowsToBubbles builds them from the same row)
const keptImages = mergeBubbles(
  [{ role: "assistant", text: "", images: ["data:image/png;base64,x"], messageID: "m10" }],
  [b("m11", "newer")],
);
check(
  "images-only history bubble survives when its id is not in incoming",
  keptImages.length === 2 && keptImages[0]?.images?.length === 1,
  JSON.stringify(keptImages),
);
const replacedImages = mergeBubbles(
  [{ role: "assistant", text: "", images: ["data:image/png;base64,old"], messageID: "m10" }],
  [{ role: "assistant", text: "now with caption", images: ["data:image/png;base64,new"], messageID: "m10" }],
);
check(
  "fetched page version replaces a same-id bubble in place (with its own images)",
  replacedImages.length === 1 &&
    replacedImages[0]?.text === "now with caption" &&
    replacedImages[0]?.images?.[0] === "data:image/png;base64,new",
  JSON.stringify(replacedImages),
);

if (failures > 0) {
  console.error(`FAILURES: ${failures}`);
  process.exit(1);
}
console.log("bubble merge: all green");
