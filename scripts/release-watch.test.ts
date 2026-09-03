/**
 * P2-100: opencode release watcher — fetch-mocked unit tests.
 * Run: npx tsx scripts/release-watch.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, checkRelease, FETCH_TIMEOUT_MS, normalizeVersion, readStateRaw } from "./opencode-release-watch";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const root = mkdtempSync(join(tmpdir(), "ocr-release-watch-"));
const stateFile = join(root, "state.json");
const eventsFile = join(root, "events.jsonl");

function apiRelease(tag: string, publishedAt = "2026-09-02T12:00:00Z") {
  return {
    ok: true,
    status: 200,
    json: async () => ({ tag_name: tag, published_at: publishedAt }),
  } as unknown as Response;
}

function deps(opts: {
  fetchImpl?: typeof fetch;
  runVersion?: () => string | null;
  stateFile?: string;
  eventsFile?: string;
  logs?: string[];
}) {
  return {
    fetchImpl: opts.fetchImpl,
    runVersion: opts.runVersion ?? (() => "1.18.25"),
    stateFile: opts.stateFile ?? stateFile,
    eventsFile: opts.eventsFile ?? eventsFile,
    log: (msg: string) => opts.logs?.push(msg),
  };
}

function eventLines(): string[] {
  if (!existsSync(eventsFile)) return [];
  return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
}

function reset(state: Record<string, unknown> = { date: "2026-09-03" }) {
  writeFileSync(stateFile, JSON.stringify(state));
  rmSync(eventsFile, { force: true });
}

// --- normalizeVersion ---------------------------------------------------------

check("normalizeVersion: plain semver", normalizeVersion("1.18.27") === "1.18.27");
check("normalizeVersion: v-prefix strip", normalizeVersion("v1.18.27") === "1.18.27");
check("normalizeVersion: version embedded in CLI banner", normalizeVersion("opencode 1.18.27") === "1.18.27");
check("normalizeVersion: prerelease kept", normalizeVersion("v2.0.0-rc.1") === "2.0.0-rc.1");
check("normalizeVersion: garbage is null", normalizeVersion("n/a") === null);

// --- new tag ⇒ state recorded + event emitted --------------------------------

{
  reset({ date: "2026-09-03", merges: 2, taskAttempts: {} });
  const logs: string[] = [];
  const outcome = await checkRelease(deps({ fetchImpl: async () => apiRelease("v1.18.27"), runVersion: () => "1.18.25", logs }));
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  const events = eventLines().map((l) => JSON.parse(l) as { type: string; detail: string });
  check("new tag: outcome is diverged", outcome === "diverged", outcome);
  check(
    "new tag: lastOpencodeRelease recorded with {tag, publishedAt}",
    JSON.stringify(state.lastOpencodeRelease) === JSON.stringify({ tag: "v1.18.27", publishedAt: "2026-09-02T12:00:00Z" }),
    JSON.stringify(state.lastOpencodeRelease),
  );
  check("new tag: existing state fields preserved", state.merges === 2 && state.date === "2026-09-03");
  check("new tag: exactly one event appended", events.length === 1, JSON.stringify(events));
  check(
    "new tag: event is an audit line carrying the chip keyword",
    events[0]!.type === "audit" && events[0]!.detail.includes("runtime desatualizado") && events[0]!.detail.includes("v1.18.27"),
    events[0]?.detail ?? "no event",
  );
  check("new tag: a human-readable warn is logged", logs.length === 1 && logs[0]!.includes("desatualizado"), JSON.stringify(logs));
}

// --- same tag as local ⇒ no-op ------------------------------------------------

{
  reset({ date: "2026-09-03", merges: 2 });
  const outcome = await checkRelease(
    deps({ fetchImpl: async () => apiRelease("v1.18.25"), runVersion: () => "1.18.25" }),
  );
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  check("fresh runtime: outcome is fresh", outcome === "fresh", outcome);
  check("fresh runtime: no field recorded", state.lastOpencodeRelease === undefined, JSON.stringify(state));
  check("fresh runtime: no event emitted", eventLines().length === 0);
}

// --- fresh runtime drops a stale divergence record ----------------------------

{
  reset({ date: "2026-09-03", lastOpencodeRelease: { tag: "v1.18.20", publishedAt: "old" } });
  const outcome = await checkRelease(
    deps({ fetchImpl: async () => apiRelease("v1.18.25"), runVersion: () => "1.18.25" }),
  );
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  check("fresh with stale record: outcome is fresh", outcome === "fresh", outcome);
  check("fresh with stale record: stale field removed, rest preserved", state.lastOpencodeRelease === undefined && state.date === "2026-09-03");
  check("fresh with stale record: no event emitted", eventLines().length === 0);
}

// --- local caught up to the recorded latest tag ⇒ record cleared (chip unlit) ---

{
  // the exact regression the round-1 review caught: recorded.tag == latest.tag
  // short-circuited to "unchanged" BEFORE the fresh-cleanup, so a runtime that
  // upgraded to the recorded release kept the stale "desatualizado" record
  reset({ date: "2026-09-03", lastOpencodeRelease: { tag: "v1.18.27", publishedAt: "2026-09-02T12:00:00Z" } });
  const logs: string[] = [];
  const outcome = await checkRelease(
    deps({ fetchImpl: async () => apiRelease("v1.18.27"), runVersion: () => "1.18.27", logs }),
  );
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  check("caught up: outcome is fresh (not unchanged)", outcome === "fresh", outcome);
  check("caught up: stale record removed", state.lastOpencodeRelease === undefined, JSON.stringify(state));
  check("caught up: no event emitted", eventLines().length === 0);
  check("caught up: no log noise", logs.length === 0, JSON.stringify(logs));
}

// --- rerun with the same diverged tag ⇒ no duplicate event --------------------

{
  reset();
  const fetchCalls: RequestInfo[] = [];
  const d = deps({ fetchImpl: async (url) => { fetchCalls.push(url); return apiRelease("v1.18.27"); }, runVersion: () => "1.18.25" });
  const first = await checkRelease(d);
  const linesAfterFirst = eventLines().length;
  const second = await checkRelease(d);
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { lastOpencodeRelease?: { tag: string } };
  check("first diverged run records", first === "diverged" && linesAfterFirst === 1);
  check("second run with the same tag is a no-op", second === "unchanged", second);
  check("second run emits no duplicate event", eventLines().length === 1);
  check("second run keeps the recorded tag", state.lastOpencodeRelease?.tag === "v1.18.27");
  check("fetch hits the exact GitHub endpoint", fetchCalls.length === 2 && fetchCalls.every((u) => u === "https://api.github.com/repos/anomalyco/opencode/releases/latest"));
}

// --- event append fails ⇒ state NOT recorded (signal never dies) ----------------

{
  reset();
  const logs: string[] = [];
  const unwritable = join(root, "no-such-dir", "events.jsonl");
  const outcome = await checkRelease(
    deps({ fetchImpl: async () => apiRelease("v1.18.27"), runVersion: () => "1.18.25", eventsFile: unwritable, logs }),
  );
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  check("append failure: outcome is still diverged", outcome === "diverged", outcome);
  check("append failure: state left unrecorded so the next run retries", state.lastOpencodeRelease === undefined, JSON.stringify(state));
  check("append failure: warn logged", logs.some((l) => l.includes("failed to append event")), JSON.stringify(logs));
  const retry = await checkRelease(
    deps({ fetchImpl: async () => apiRelease("v1.18.27"), runVersion: () => "1.18.25" }),
  );
  check("append failure: a healthy rerun retries the full diverged path", retry === "diverged" && eventLines().length === 1);
}

// --- API down ⇒ warn without crash --------------------------------------------

{
  reset({ date: "2026-09-03", merges: 7 });
  const logs: string[] = [];
  const outcome = await checkRelease(
    deps({ fetchImpl: async () => { throw new Error("ENOTRENDING"); }, logs }),
  );
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  check("API down: outcome is api-down", outcome === "api-down", outcome);
  check("API down: warn logged", logs.some((l) => l.includes("unreachable")), JSON.stringify(logs));
  check("API down: state untouched", state.merges === 7 && state.lastOpencodeRelease === undefined);
  check("API down: no event emitted", eventLines().length === 0);
  const httpFail = await checkRelease(
    deps({ fetchImpl: async () => ({ ok: false, status: 503 } as Response) }),
  );
  check("API 503: also api-down without crash", httpFail === "api-down");
}

// --- malformed payload ⇒ warn, no write ----------------------------------------

{
  reset();
  const badBody = async () => ({ ok: true, status: 200, json: async () => ({ html_url: "x" }) }) as unknown as Response;
  const outcome = await checkRelease(deps({ fetchImpl: badBody }));
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  check("malformed payload: api-malformed", outcome === "api-malformed", outcome);
  check("malformed payload: no field recorded", state.lastOpencodeRelease === undefined);
  check("malformed payload: no event", eventLines().length === 0);
}

// --- local version unknown ⇒ warn, no write -------------------------------------

{
  reset();
  const outcome = await checkRelease(
    deps({ fetchImpl: async () => apiRelease("v1.18.27"), runVersion: () => null }),
  );
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  check("local unknown: outcome is local-unknown", outcome === "local-unknown", outcome);
  check("local unknown: no field recorded", state.lastOpencodeRelease === undefined);
  check("local unknown: no event", eventLines().length === 0);
}

// --- corrupt state.json is never clobbered ---------------------------------------

{
  reset();
  writeFileSync(stateFile, "{corrupt");
  const before = readFileSync(stateFile, "utf8");
  const outcome = await checkRelease(
    deps({ fetchImpl: async () => apiRelease("v1.18.27"), runVersion: () => "1.18.25" }),
  );
  check("corrupt state: outcome is state-corrupt", outcome === "state-corrupt", outcome);
  check("corrupt state: file left untouched", readFileSync(stateFile, "utf8") === before);
  check("corrupt state: no event", eventLines().length === 0);
}

// --- fetch hygiene: User-Agent set, no auth, 10s timeout --------------------------

{
  reset();
  let capturedInit: RequestInit | undefined;
  await checkRelease(
    deps({
      fetchImpl: async (_url, init) => {
        capturedInit = init;
        return apiRelease("v1.18.25");
      },
      runVersion: () => "1.18.25",
    }),
  );
  const headers = new Headers(capturedInit?.headers);
  check("fetch sets a User-Agent", (headers.get("User-Agent") ?? "").length > 0);
  check("fetch sends no auth (public endpoint, read-only)", headers.get("Authorization") === null);
  check("fetch carries an abort timeout", capturedInit?.signal instanceof AbortSignal);
  check("fetch timeout is the spec's 10s", FETCH_TIMEOUT_MS === 10_000, String(FETCH_TIMEOUT_MS));
}

// --- appendEvent keeps the feed bounded -------------------------------------------

{
  const feed = join(root, "feed.jsonl");
  for (let i = 0; i < 405; i++) appendEvent(feed, { i });
  const lines = readFileSync(feed, "utf8").split("\n").filter(Boolean);
  check("event feed is trimmed to 400 lines", lines.length === 400, String(lines.length));
  check("trim keeps the newest lines", JSON.parse(lines[lines.length - 1]!).i === 404);
}

// --- readStateRaw tolerances --------------------------------------------------------

check("readStateRaw: missing file is null", readStateRaw(join(root, "absent.json")) === null);
writeFileSync(join(root, "arr.json"), "[1,2,3]");
check("readStateRaw: array root is null (not an object shape)", readStateRaw(join(root, "arr.json")) === null);

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "release-watch: all green" : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
