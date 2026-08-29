/**
 * Scheduled-routine eval: creates a routine due in ~1 minute, waits for the
 * daemon to fire it, and verifies the result file lands in uploads + push
 * delivery. Run: RELAY_URL=wss://host:8788 npx tsx scripts/routines.test.ts
 */
import { readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";
import { clientHello, openSealed, seal, seqAad, newIdentity, type OpResponse } from "@ocr/protocol";

const f = join(homedir(), ".opencode-remote", "daemon.json");
const st = JSON.parse(readFileSync(f, "utf8"));
const id = await newIdentity(false);
process.on("exit", () => {
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.clients = (j.clients ?? []).filter((c) => c.pub !== id.publicKey);
    writeFileSync(f, JSON.stringify(j, null, 2));
    chmodSync(f, 0o600);
  } catch {}
});
st.clients = [...(st.clients ?? []).filter((c: any) => c.pub !== id.publicKey), { pub: id.publicKey, addedAt: new Date().toISOString(), label: "rout-eval" }];
writeFileSync(f, JSON.stringify(st, null, 2));

const ws = new WebSocket(process.env.RELAY_URL!);
await new Promise((r) => ws.on("open", r));
const { hello, sessionKey } = await clientHello(st.ecdhPub, id);
const myId = "rtn" + Date.now().toString(36);
let seq = 0;
const pending = new Map<string, (r: OpResponse) => void>();
ws.on("message", (d) => {
  const fr = JSON.parse(d.toString());
  if (fr.from === myId) return;
  void (async () => {
    const env = await openSealed<{ type: "res"; res: OpResponse }>(fr.payload, sessionKey, seqAad(fr.from, fr.seq ?? 0));
    if (env?.type === "res") pending.get(env.res.id)?.(env.res);
  })();
});
ws.send(JSON.stringify({ room: st.room, from: myId, payload: Buffer.from(JSON.stringify({ type: "hello", hello })).toString("base64") }));
await new Promise((r) => setTimeout(r, 8000));

async function op(method: string, path: string, body?: unknown) {
  const req = { id: crypto.randomUUID(), method, path, body };
  return new Promise<OpResponse>((resolve) => {
    pending.set(req.id, resolve);
    const s = ++seq;
    void seal({ type: "op", req }, sessionKey, seqAad(myId, s)).then((payload) =>
      ws.send(JSON.stringify({ room: st.room, from: myId, seq: s, payload })),
    );
    setTimeout(() => resolve({ id: req.id, status: 599, body: "timeout" }), 15_000);
  });
}

const due = new Date(Date.now() + 70_000); // next minute, 10s margin
const created = await op("POST", "/__ocr/routines", {
  name: "eval-routine",
  prompt: "reply with exactly: ROUTINE-OK",
  hour: due.getHours(),
  minute: due.getMinutes(),
});
console.log("created:", created.status);
if (created.status !== 200) process.exit(1);

let found = false;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 5_000));
  const files = await op("GET", "/__ocr/files");
  const list = ((files.body as { files?: { name: string }[] }).files ?? []).filter((x) =>
    x.name.includes("eval-routine"),
  );
  if (list.length) {
    found = true;
    console.log("result file:", list[0].name);
    break;
  }
}
console.log(found ? "RESULT FILE OK" : "RESULT FILE MISSING");

const status = await op("GET", "/__ocr/push/status");
const last = (status.body as { last?: { results?: { ok: boolean }[] } }).last;
console.log("push after routine:", JSON.stringify(last?.results ?? []));

await op("DELETE", "/__ocr/routines", { id: (created.body as { routine: { id: string } }).routine.id });
console.log("routine deleted");
process.exit(found ? 0 : 1);
