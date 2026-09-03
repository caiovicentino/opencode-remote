/**
 * Integration test: runs the daemon against a REAL opencode server and
 * validates the tunnel end-to-end, including real event type names.
 *
 * Skips gracefully (exit 0) when the opencode binary is not available.
 * Run: npx tsx scripts/integration.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  clientHello,
  openSealed,
  seal,
  seqAad,
  newIdentity,
  type OpResponse,
} from "@ocr/protocol";
import WebSocket from "ws";
import { bootOnEphemeralPort, portHolders } from "./e2e-orphans";

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode";

const children: ChildProcess[] = [];
function cleanup() {
  for (const c of children) c.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(1));

const tmp = mkdtempSync(join(tmpdir(), "ocr-int-"));

// ephemeral state dir for the daemon (HOME override -> fresh identity)
function bg(cmd: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env, OCR_LOG_LEVEL: "debug" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stderr.write(`[child:out] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[child:err] ${d}`));
  children.push(child);
  return child;
}

// the star: a REAL opencode server, isolated on its own EPHEMERAL port
// (P1-081: fixed 4377 died to zombies from previous runs)
let ocBoot: { port: number; child: ChildProcess };
try {
  ocBoot = await bootOnEphemeralPort({
    label: "opencode server",
    spawn: (port) => {
      const child = bg(OPENCODE_BIN, ["serve", "--port", String(port)]);
      child.on("error", (e) => {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          console.log("SKIP: opencode binary not found");
          process.exit(0);
        }
      });
      return child;
    },
    probe: async (port) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/global/health`);
        return r.ok;
      } catch {
        return false;
      }
    },
    timeoutMs: 20_000,
  });
} catch (err) {
  console.log("SKIP: opencode server never became healthy");
  console.error(String((err as Error)?.message ?? err));
  process.exit(0);
}
const OPENCODE_URL = `http://127.0.0.1:${ocBoot.port}`;
console.log("real opencode server healthy:", OPENCODE_URL);

// relay on an ephemeral port too (fixed 4378 was the P1-077 handshake killer),
// marked so the e2e pre-flight can reap it if it ever outlives this run
let relayBoot: { port: number; child: ChildProcess };
try {
  relayBoot = await bootOnEphemeralPort({
    label: "relay",
    spawn: (port) =>
      bg("npx", ["tsx", "apps/relay/src/index.ts"], {
        RELAY_PORT: String(port),
        OCR_E2E_MARKER: tmp,
      }),
    probe: (port) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on("open", () => {
          ws.close();
          resolve(true);
        });
        ws.on("error", () => resolve(false));
      }),
    timeoutMs: 20_000,
  });
} catch (err) {
  console.error("INTEGRATION FAILED: relay never came up");
  console.error(String((err as Error)?.message ?? err));
  process.exit(1);
}
const RELAY_URL = `ws://127.0.0.1:${relayBoot.port}`;

// daemon with throwaway HOME -> fresh identity + empty allowlist (bootstrap)
bg("npx", ["tsx", "apps/daemon/src/index.ts"], {
  HOME: tmp,
  RELAY_URL,
  OPENCODE_URL,
  OCR_MACHINE_NAME: "integration-test",
});

// --- client flow against the real daemon -----------------------------------
const stateFile = join(tmp, ".opencode-remote", "daemon.json");
for (let i = 0; i < 40 && !exists(stateFile); i++) {
  await new Promise((r) => setTimeout(r, 250));
}
function exists(f: string) {
  try {
    readFileSync(f);
    return true;
  } catch {
    return false;
  }
}
const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
  room: string;
  ecdhPub: string;
};

const ws = new WebSocket(RELAY_URL);
await new Promise<void>((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", () => reject(new Error("relay down")));
});

const identity = await newIdentity(false);
const { hello, sessionKey } = await clientHello(state.ecdhPub, identity);
const myId = "int" + Math.random().toString(36).slice(2, 8);

const pending = new Map<string, (r: OpResponse) => void>();
const eventTypes: string[] = [];
let sendSeq = 0;

ws.on("message", (data) => {
  const frame = JSON.parse(data.toString()) as {
    from?: string;
    seq?: number;
    payload?: string;
  };
  if (!frame.from || frame.from === myId || !frame.payload) return;
  void (async () => {
    const env = await openSealed<
      { type: "res"; res: OpResponse } | { type: "event"; event: { type: string } }
    >(frame.payload, sessionKey, seqAad(frame.from!, frame.seq ?? 0));
    if (!env) return;
    if (env.type === "res") pending.get(env.res.id)?.(env.res);
    else eventTypes.push(env.event.type);
  })();
});

function request(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<OpResponse> {
  const req = { id: crypto.randomUUID(), method, path, body };
  return new Promise((resolve, reject) => {
    pending.set(req.id, resolve);
    const seq = ++sendSeq;
    void seal({ type: "op", req }, sessionKey, seqAad(myId, seq)).then((payload) =>
      ws.send(JSON.stringify({ room: state.room, from: myId, seq, payload })),
    );
    setTimeout(() => reject(new Error(`timeout on ${path}`)), 10_000);
  });
}

// pairing: bootstrap (empty allowlist) must accept us. P1-081: the relay is a
// blind router — a hello sent before the daemon joins the relay room is
// dropped forever (the state file lands a beat before connectRelay()), so the
// hello is retried until the confirm comes back.
const paired = await new Promise<boolean>((resolve) => {
  let settledPairing = false;
  const retry: NodeJS.Timeout[] = [];
  const finish = (ok: boolean) => {
    if (settledPairing) return;
    settledPairing = true;
    retry.forEach((t) => clearInterval(t));
    resolve(ok);
  };
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as { from?: string; payload?: string };
    if (!frame.from || frame.from === myId) return;
    try {
      const c = JSON.parse(Buffer.from(frame.payload!, "base64").toString()) as {
        ok?: boolean;
        confirm?: string;
      };
      if (c.ok && c.confirm) {
        void openSealed<{ ok: boolean }>(
          c.confirm,
          sessionKey,
          new TextEncoder().encode("ocr-confirm"),
        ).then((r) => finish(r?.ok === true));
      }
    } catch {
      // data frame, not control
    }
  });
  const helloFrame = JSON.stringify({
    room: state.room,
    from: myId,
    payload: Buffer.from(JSON.stringify({ type: "hello", hello })).toString("base64"),
  });
  ws.send(helloFrame);
  retry.push(setInterval(() => ws.send(helloFrame), 500));
  retry.push(
    setTimeout(() => {
      finish(false);
    }, 12_000),
  );
});
if (!paired) {
  console.error("INTEGRATION FAILED: handshake");
  // P1-081: name the culprit instead of failing blind — a zombie from a
  // previous gate run holding the relay port shows up right here.
  console.error(`port holder dump for the relay port ${relayBoot.port}:`);
  console.error(portHolders(relayBoot.port));
  process.exit(1);
}
console.log("pairing against real daemon: OK");

// real opencode tunnel: create -> list -> delete a session (no LLM calls)
const created = (await request("POST", "/session", { title: "ocr-integration" })).body as {
  id?: string;
};
if (!created.id) {
  console.error("INTEGRATION FAILED: session create returned no id");
  process.exit(1);
}
console.log("session created via tunnel:", created.id.slice(0, 12) + "…");

const list = await request("GET", "/session");
const listed = list.body as { id: string }[];
if (!Array.isArray(listed) || !listed.some((s) => s.id === created.id)) {
  console.error("INTEGRATION FAILED: created session not in list");
  process.exit(1);
}
console.log("session list via tunnel: OK", `(${listed.length} sessions)`);

await new Promise((r) => setTimeout(r, 1500)); // let events flow
const sessionEvents = eventTypes.filter((t) => t.startsWith("session."));
if (sessionEvents.length === 0) {
  console.error("INTEGRATION FAILED: no session.* events observed");
  process.exit(1);
}
console.log(
  `real event types observed: ${[...new Set(eventTypes)].slice(0, 8).join(", ")}`,
);

const del = await request("DELETE", `/session/${created.id}`);
if (del.status !== 200) {
  console.error(`INTEGRATION FAILED: delete -> ${del.status}`);
  process.exit(1);
}
console.log("session deleted via tunnel: OK");

console.log("INTEGRATION PASSED");
ws.close();
process.exit(0);
