/**
 * @ocr/sdk battery — eval 14. Drives the SDK against an in-process fake of
 * the daemon's local API (fetchImpl) that reproduces the REAL semantics:
 *   - POST /api/session is the Bearer→cookie exchange since P1-057
 *     ({ ok, expiresAt }, no id) — session creation lives at
 *     POST /api/session/new;
 *   - GET /api/session/:id/messages?limit=N answers rows.slice(-N), so the
 *     row COUNT stops growing once a session holds N messages;
 *   - opencode writes one assistant message per step ("tool-calls" steps,
 *     then a final step with time.completed + finish "stop");
 *   - POST /api/session/:id/message relays opencode's STREAMING prompt route:
 *     it answers 202 { accepted, opencode: <final assistant message> } only
 *     when the turn ends ("sync"); an "async" mode (202 at once) covers a
 *     daemon that switches to prompt_async.
 * Every regression below failed on the pre-eval SDK: createSession returned
 * no id, sendAndWait timed out on a 200+ message session and returned a
 * tool-calls preamble as the "reply", and a non-JSON error body surfaced as a
 * SyntaxError.
 * Run: npx tsx scripts/sdk.test.ts
 */
import * as sdk from "@ocr/sdk";
import type { HistoryRow } from "@ocr/sdk";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}
const code = (e: unknown) => ((e as { name?: string })?.name === "OcrError" ? (e as { code?: string }).code : `raw ${(e as Error)?.name}`);
const TOKEN = "t0k";

// --- fake daemon ---------------------------------------------------------------

type Mode = "sync" | "async";
interface Turn {
  /** assistant steps appended after the user message, in order */
  steps: { text: string; finish?: string; completed?: boolean; error?: HistoryRow["info"]["error"]; legacy?: boolean }[];
  /** ms between steps (async mode) / before answering (sync mode) */
  stepMs: number;
}

let seq = 0;
const nextId = (p: string) => `${p}_${String(++seq).padStart(6, "0")}`;

function fakeDaemon(opts: { mode: Mode; turn: Turn; history?: HistoryRow[]; sessionRoute?: boolean }) {
  const rows: HistoryRow[] = [...(opts.history ?? [])];
  const calls: string[] = [];
  const assistant = (s: Turn["steps"][number], parentID: string): HistoryRow => ({
    info: s.legacy
      ? { id: nextId("msg"), role: "assistant" }
      : {
          id: nextId("msg"),
          role: "assistant",
          parentID,
          time: s.completed === false ? { created: Date.now() } : { created: Date.now(), completed: Date.now() },
          ...(s.finish ? { finish: s.finish } : {}),
          ...(s.error ? { error: s.error } : {}),
        },
    parts: [{ type: "text", text: s.text }],
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (init?.signal?.aborted) throw init.signal.reason;
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized" });
    const seg = url.pathname.split("/").filter(Boolean);
    if (method === "POST" && url.pathname === "/api/session") return json(200, { ok: true, expiresAt: Date.now() + 1 });
    if (method === "POST" && url.pathname === "/api/session/new") {
      if (opts.sessionRoute === false) return json(400, { error: "bad session id" });
      const body = JSON.parse(String(init?.body ?? "{}")) as { title?: string };
      return json(200, { id: "ses_created01", title: body.title ?? "" });
    }
    if (seg[2] === "ses_html") return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 });
    if (method === "GET" && seg[3] === "messages") {
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return json(200, rows.slice(-limit));
    }
    if (method === "POST" && seg[3] === "message") {
      const { text } = JSON.parse(String(init?.body)) as { text: string };
      const user: HistoryRow = { info: { id: nextId("msg"), role: "user" }, parts: [{ type: "text", text }] };
      rows.push(user);
      const steps = opts.turn.steps.map((s) => assistant(s, user.info.id!));
      if (opts.mode === "async") {
        steps.forEach((s, i) => setTimeout(() => rows.push(s), opts.turn.stepMs * (i + 1)));
        return json(202, { accepted: true });
      }
      // a real fetch rejects as soon as its signal aborts — so does the fake
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.turn.stepMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(init.signal!.reason);
        });
      });
      rows.push(...steps);
      return json(202, { accepted: true, opencode: steps[steps.length - 1] });
    }
    if (method === "GET" && seg[1] === "session" && seg[2]) return json(200, { id: decodeURIComponent(seg[2]) });
    return json(404, { error: "unknown route" });
  }) as typeof fetch;
  return { rows, calls, fetchImpl };
}

const oldHistory = (n: number): HistoryRow[] =>
  Array.from({ length: n }, (_, i) => ({
    info: {
      id: nextId("msg"),
      role: i % 2 ? "assistant" : "user",
      ...(i % 2 ? { time: { created: 1, completed: 2 }, finish: "stop" } : {}),
    },
    parts: [{ type: "text", text: `old ${i}` }],
  }));

const finalTurn: Turn = {
  stepMs: 40,
  steps: [
    { text: "Vou olhar o arquivo de autenticação primeiro.", finish: "tool-calls" },
    { text: "", finish: "tool-calls" },
    { text: "O módulo valida o token e renova a sessão.", finish: "stop" },
  ],
};

// --- 1. createSession never returns a session without an id --------------------
{
  const d = fakeDaemon({ mode: "sync", turn: finalTurn });
  const ocr = sdk.createClient({ token: TOKEN, fetchImpl: d.fetchImpl });
  let created: { id?: unknown } | undefined;
  try {
    created = await ocr.createSession("review");
  } catch (e) {
    created = { id: `threw ${code(e)}` };
  }
  check("createSession: returns the new session id (POST /api/session/new)", created?.id === "ses_created01", JSON.stringify(created));
  check("createSession: never calls the P1-057 cookie exchange", !d.calls.includes("POST /api/session"), d.calls.join(", "));
}
{
  const d = fakeDaemon({ mode: "sync", turn: finalTurn, sessionRoute: false });
  const ocr = sdk.createClient({ token: TOKEN, fetchImpl: d.fetchImpl });
  let err: unknown = null;
  try {
    await ocr.createSession();
  } catch (e) {
    err = e;
  }
  check(
    "createSession: a daemon without the route fails loudly (OcrError http 400), never a silent id-less object",
    code(err) === "http" && (err as { status?: number }).status === 400,
    String(err),
  );
}

// --- 2. sendAndWait on a session already holding ≥ 200 messages ------------------
{
  const d = fakeDaemon({ mode: "async", turn: finalTurn, history: oldHistory(250) });
  const ocr = sdk.createClient({ token: TOKEN, fetchImpl: d.fetchImpl });
  let reply = "";
  try {
    reply = await ocr.sendAndWait("ses_long0001", "explique a autenticação", { timeoutMs: 2_000, pollMs: 15 });
  } catch (e) {
    reply = `threw ${code(e)}: ${(e as Error).message}`;
  }
  check("sendAndWait: 250-message session gets the final reply (anchor by id, not by count)", reply === "O módulo valida o token e renova a sessão.", reply);
}

// --- 3. a tool-calls preamble is never returned as the reply --------------------
{
  const slowTools: Turn = { ...finalTurn, stepMs: 120 };
  const d = fakeDaemon({ mode: "async", turn: slowTools });
  const ocr = sdk.createClient({ token: TOKEN, fetchImpl: d.fetchImpl });
  let reply = "";
  try {
    reply = await ocr.sendAndWait("ses_tools001", "explique a autenticação", { timeoutMs: 3_000, pollMs: 15 });
  } catch (e) {
    reply = `threw ${code(e)}`;
  }
  check("sendAndWait: waits past tool-calls steps for the final step", reply === "O módulo valida o token e renova a sessão.", reply);
}

// --- 4. sync daemon: the relayed final message is the reply, no polling ---------
{
  const d = fakeDaemon({ mode: "sync", turn: finalTurn });
  const ocr = sdk.createClient({ token: TOKEN, fetchImpl: d.fetchImpl });
  const reply = await ocr.sendAndWait("ses_sync0001", "oi", { timeoutMs: 3_000, pollMs: 15 }).catch((e) => `threw ${code(e)}`);
  const polls = d.calls.filter((c) => c.includes("/messages")).length;
  check("sendAndWait (sync daemon): reply taken from the relayed final message", reply === "O módulo valida o token e renova a sessão.", reply);
  check("sendAndWait (sync daemon): only the anchor read, no history polling", polls === 1, `${polls} history reads`);
}

// --- 5. a concurrent turn of another client is never mistaken for ours ----------
{
  const d = fakeDaemon({ mode: "async", turn: { stepMs: 60, steps: [{ text: "minha resposta", finish: "stop" }] } });
  const ocr = sdk.createClient({ token: TOKEN, fetchImpl: d.fetchImpl });
  const pending = ocr.sendAndWait("ses_shared01", "pergunta do script", { timeoutMs: 3_000, pollMs: 10 });
  // another device's turn lands first: user message + its final answer
  setTimeout(() => {
    const other: HistoryRow = { info: { id: nextId("msg"), role: "user" }, parts: [{ type: "text", text: "pergunta do celular" }] };
    d.rows.push(other, {
      info: { id: nextId("msg"), role: "assistant", parentID: other.info.id, time: { created: 1, completed: 2 }, finish: "stop" },
      parts: [{ type: "text", text: "resposta do celular" }],
    });
  }, 20);
  const reply = await pending.catch((e) => `threw ${code(e)}`);
  check("sendAndWait: attributes the reply to its own prompt (parentID)", reply === "minha resposta", reply);
}

// --- 6. failures are typed, never a raw SyntaxError/TypeError --------------------
{
  const d = fakeDaemon({ mode: "sync", turn: finalTurn });
  const ocr = sdk.createClient({ token: TOKEN, fetchImpl: d.fetchImpl });
  const e1 = await ocr.session("ses_html").then(() => null, (e) => e);
  check(
    "errors: a non-JSON 502 body → OcrError http 502 carrying the raw text",
    code(e1) === "http" && e1?.status === 502 && String(e1?.body).includes("Bad Gateway"),
    String(e1),
  );
  const broken = sdk.createClient({
    token: TOKEN,
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  const e2 = await broken.health().then(() => null, (e) => e);
  check("errors: connection failure → OcrError network", code(e2) === "network", String(e2));
  const slow = fakeDaemon({ mode: "sync", turn: { ...finalTurn, stepMs: 300 } });
  const e3 = await sdk
    .createClient({ token: TOKEN, fetchImpl: slow.fetchImpl })
    .send("ses_slow0001", "oi", { timeoutMs: 50 })
    .then(() => null, (e) => e);
  check("errors: send honors its timeoutMs → OcrError timeout", code(e3) === "timeout", String(e3));
  const failing = fakeDaemon({
    mode: "async",
    turn: { stepMs: 20, steps: [{ text: "", finish: "error", error: { name: "ProviderAuthError", data: { message: "invalid api key" } } }] },
  });
  const e4 = await sdk
    .createClient({ token: TOKEN, fetchImpl: failing.fetchImpl })
    .sendAndWait("ses_fail0001", "oi", { timeoutMs: 2_000, pollMs: 10 })
    .then(() => null, (e) => e);
  check("errors: a failed turn → OcrError agent with the provider reason", code(e4) === "agent" && /invalid api key/.test(String(e4?.message)), String(e4));
  const never = fakeDaemon({ mode: "async", turn: { stepMs: 10_000, steps: [{ text: "tarde demais", finish: "stop" }] } });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60);
  const e5 = await sdk
    .createClient({ token: TOKEN, fetchImpl: never.fetchImpl })
    .sendAndWait("ses_abort001", "oi", { timeoutMs: 5_000, pollMs: 10, signal: ac.signal })
    .then(() => null, (e) => e);
  check("errors: the caller's AbortSignal stops sendAndWait → OcrError aborted", code(e5) === "aborted", String(e5));
  const e6 = await sdk
    .createClient({ token: TOKEN, fetchImpl: never.fetchImpl })
    .sendAndWait("ses_late0001", "oi", { timeoutMs: 150, pollMs: 10 })
    .then(() => null, (e) => e);
  check("errors: sendAndWait deadline → OcrError timeout", code(e6) === "timeout", String(e6));
}

// --- 7. ids are path segments, never path syntax ---------------------------------
{
  const d = fakeDaemon({ mode: "sync", turn: finalTurn });
  const ocr = sdk.createClient({ token: TOKEN, fetchImpl: d.fetchImpl });
  await ocr.session("ses_a/../b?x=1").catch(() => null);
  check("paths: session ids are URL-encoded", d.calls.some((c) => c.startsWith("GET /api/session/ses_a%2F..%2Fb%3Fx%3D1")), d.calls.join(", "));
}

// --- 8. legacy agent servers without time/finish stamps still resolve ------------
{
  const d = fakeDaemon({ mode: "async", turn: { stepMs: 20, steps: [{ text: "resposta antiga", legacy: true }] } });
  const ocr = sdk.createClient({ token: TOKEN, fetchImpl: d.fetchImpl });
  const reply = await ocr.sendAndWait("ses_legacy01", "oi", { timeoutMs: 2_000, pollMs: 10 }).catch((e) => `threw ${code(e)}`);
  check("sendAndWait: legacy rows fall back to the two-poll text stability rule", reply === "resposta antiga", reply);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall sdk checks passed");
