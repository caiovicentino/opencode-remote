/**
 * P1-072: auto-preview — pure helpers on both sides of the wire.
 * Run: npx tsx scripts/preview.test.ts
 */
import { extractLocalUrls, previewsFromEvent, PreviewDedupe } from "../apps/daemon/src/preview";
import { normalizeHttpUrl, previewFromEvent } from "../apps/web/src/lib/preview";
import { buildArtifactsPrompt, ARTIFACTS_MARKER } from "../apps/daemon/src/sessionctx";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// --- extractLocalUrls ---------------------------------------------------------

{
  const urls = extractLocalUrls("suba http://localhost:3000 e http://127.0.0.1:5173/x");
  check(
    "spec pin: two loopback URLs in order (canonicalized)",
    urls.length === 2 && urls[0] === "http://localhost:3000/" && urls[1] === "http://127.0.0.1:5173/x",
    JSON.stringify(urls),
  );
  check(
    "https://example.com and portless http://localhost never match",
    extractLocalUrls("veja https://example.com e http://localhost ok?").length === 0,
  );
  check(
    "the daemon's own port 8792 is ignored (no self-preview)",
    extractLocalUrls("dashboard http://127.0.0.1:8792/dashboard").length === 0,
  );
  check(
    "https on loopback is allowed",
    JSON.stringify(extractLocalUrls("abra https://localhost:4321")) === JSON.stringify(["https://localhost:4321/"]),
  );
  check(
    "invalid ports (0, >65535) are ignored",
    extractLocalUrls("http://localhost:0 http://localhost:99999 http://localhost:65536").length === 0,
  );
  check(
    "port 65535 is valid",
    JSON.stringify(extractLocalUrls("limite http://localhost:65535")) === JSON.stringify(["http://localhost:65535/"]),
  );
  check(
    "trailing punctuation is not part of the URL",
    JSON.stringify(extractLocalUrls("suba em http://localhost:3000.")) === JSON.stringify(["http://localhost:3000/"]),
  );
  const many = extractLocalUrls(
    "1 http://localhost:1 2 http://localhost:2 3 http://localhost:3 4 http://localhost:4 5 http://localhost:5",
  );
  check("max 4 URLs per call", many.length === 4, JSON.stringify(many));
  check(
    "repeated URL inside one call is emitted once",
    extractLocalUrls("http://localhost:3000 e de novo http://localhost:3000").length === 1,
  );
  const long = `http://localhost:3000/${"a".repeat(2100)}`;
  check("URL longer than 2048 chars is ignored", extractLocalUrls(long).length === 0);
  check("empty/garbage input is safe", extractLocalUrls("").length === 0 && extractLocalUrls(undefined as unknown as string).length === 0);
}

// --- PreviewDedupe ------------------------------------------------------------

{
  const dedupe = new PreviewDedupe();
  check("first emission of sessionID:url passes", dedupe.firstSeen("s1", "http://localhost:3000/", 1000) === true);
  check(
    "same sessionID:url within the TTL is dropped",
    dedupe.firstSeen("s1", "http://localhost:3000/", 1000 + 9_999) === false,
  );
  check(
    "same url on a DIFFERENT session passes",
    dedupe.firstSeen("s2", "http://localhost:3000/", 1000 + 9_999) === true,
  );
  check(
    "same sessionID:url after the 10min TTL passes again",
    dedupe.firstSeen("s1", "http://localhost:3000/", 1000 + 10 * 60_000) === true,
  );
  const capped = new PreviewDedupe(10_000, 2);
  capped.firstSeen("a", "u1");
  capped.firstSeen("a", "u2");
  check("cap evicts the oldest entry", capped.firstSeen("b", "u3") === true);
  check("cap: evicted entry can be emitted again", capped.firstSeen("a", "u1") === true);
}

// --- previewsFromEvent (stream wiring, round-2 findings) -----------------------

{
  const text = "suba em http://localhost:3000";
  const roles = new Map<string, string>([["msg_a", "assistant"], ["msg_u", "user"]]);
  const partEvent = (messageID: string, extra: Record<string, unknown> = {}) => ({
    type: "message.part.updated",
    properties: { part: { type: "text", text, messageID, ...extra } },
  });

  check(
    "wiring: assistant part emits with the PART-level sessionID (SDK TextPart source)",
    JSON.stringify(previewsFromEvent(partEvent("msg_a", { sessionID: "ses_part" }), roles)) ===
      JSON.stringify([{ sessionID: "ses_part", url: "http://localhost:3000/" }]),
  );
  check(
    "wiring: properties.sessionID is the fallback when the part carries none",
    previewsFromEvent(
      { type: "message.part.updated", properties: { sessionID: "ses_top", part: { type: "text", text, messageID: "msg_a" } } },
      roles,
    )[0]?.sessionID === "ses_top",
  );
  check(
    "wiring: part.sessionID wins over properties.sessionID",
    previewsFromEvent(
      { type: "message.part.updated", properties: { sessionID: "ses_top", part: { type: "text", text, messageID: "msg_a", sessionID: "ses_part" } } },
      roles,
    )[0]?.sessionID === "ses_part",
  );
  check(
    "wiring: fail closed — unknown/evicted role emits NOTHING",
    previewsFromEvent(partEvent("msg_unknown"), roles).length === 0,
  );
  check(
    "wiring: user part emits NOTHING",
    previewsFromEvent(partEvent("msg_u"), roles).length === 0,
  );
  check(
    "wiring: empty sessionID drops the candidate (no cross-session dedupe key)",
    previewsFromEvent(partEvent("msg_a", { sessionID: "" }), roles).length === 0,
  );
  check(
    "wiring: non-text part and foreign event type emit NOTHING",
    previewsFromEvent(
      { type: "message.part.updated", properties: { part: { type: "tool", messageID: "msg_a", sessionID: "s" } } },
      roles,
    ).length === 0 && previewsFromEvent({ type: "session.idle", properties: {} }, roles).length === 0,
  );

  // full stream order: user echo tagged, assistant pinned, then the parts
  // (real parts always carry sessionID — the SDK TextPart guarantee)
  const streamRoles = new Map<string, string>();
  streamRoles.set("m1", "user");
  streamRoles.set("m2", "assistant");
  const userPart = { type: "message.part.updated", properties: { part: { type: "text", text: "http://localhost:1111", messageID: "m1", sessionID: "ses_x" } } };
  const assistantPart = { type: "message.part.updated", properties: { part: { type: "text", text: "http://localhost:2222", messageID: "m2", sessionID: "ses_x" } } };
  check(
    "wiring: streamed user echo suppressed, assistant part emitted",
    previewsFromEvent(userPart, streamRoles).length === 0 &&
      previewsFromEvent(assistantPart, streamRoles)[0]?.url === "http://localhost:2222/",
  );
}

// --- previewFromEvent (client-side envelope parse) -----------------------------

{
  const evt = { type: "ocr.preview", properties: { sessionID: "ses_1", url: "http://localhost:3000" } };
  const parsed = previewFromEvent(evt);
  check(
    "spec pin: ocr.preview envelope parses to {sessionID, url}",
    parsed?.sessionID === "ses_1" && parsed?.url === "http://localhost:3000/",
    JSON.stringify(parsed),
  );
  check("non-preview events are rejected", previewFromEvent({ type: "session.idle", properties: {} }) === null);
  check("missing envelope is rejected", previewFromEvent(null) === null);
  check(
    "missing url is rejected",
    previewFromEvent({ type: "ocr.preview", properties: { sessionID: "s" } }) === null,
  );
  check(
    "non-http url is rejected",
    previewFromEvent({ type: "ocr.preview", properties: { sessionID: "s", url: "file:///etc" } }) === null,
  );
}

// --- normalizeHttpUrl ---------------------------------------------------------

{
  check("normalizeHttpUrl keeps https", normalizeHttpUrl("https://example.com/x") === "https://example.com/x");
  check("normalizeHttpUrl rejects ftp/file", normalizeHttpUrl("file:///etc/passwd") === null);
  check("normalizeHttpUrl rejects garbage", normalizeHttpUrl("not a url") === null);
}

// --- session prompt pin (spec acceptance 5) -----------------------------------

{
  const prompt = buildArtifactsPrompt();
  check(
    "prompt still carries the artifacts marker",
    prompt.includes(ARTIFACTS_MARKER),
  );
  check(
    "P1-072: prompt now PERMITS http.server and asks the agent to mention http://localhost:<porta>",
    prompt.includes("http.server") && prompt.includes("http://localhost:<porta>"),
    prompt,
  );
  check(
    "P1-072: the old prohibition is gone",
    !prompt.includes("Nunca sirva preview"),
  );
}

if (failures > 0) {
  console.error(`\npreview tests: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\npreview tests: all green");
