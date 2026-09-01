/**
 * PILOT INVARIANTS — the machine-checkable constitution.
 * Every change must pass this suite before merge and after deploy.
 * A FAIL here blocks the pipeline unconditionally; no agent can waive it.
 *
 * Usage: npx tsx scripts/invariants.ts [--live]
 *   (offline checks always run; --live adds checks against the running daemon)
 */
import { readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";
import { clientHello, openSealed, seal, seqAad, newIdentity, type OpResponse } from "@ocr/protocol";
import { stdlibShadowHits } from "./stdlib-shadow";

const ROOT = process.env.OCR_PILOT_REPO ?? process.cwd();
let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) fails++;
  console.log(`${mark}  invariant: ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── offline: repo content invariants ──────────────────────────────────────────
try {
  // crypto: replay protection must stay bound to seq+from via AAD
  const proto = readFileSync(join(ROOT, "packages/protocol/src/crypto.ts"), "utf8");
  check(
    "protocol: seqAad binds (from, seq) into AAD",
    /export function seqAad/.test(proto) && /additionalData/.test(proto),
  );

  // relay stays blind + frame cap
  const relay = readFileSync(join(ROOT, "apps/relay/src/index.ts"), "utf8");
  check("relay: MAX_FRAME cap present", /MAX_FRAME\s*=\s*[\d_]+/.test(relay));
  check("relay: no crypto deps (blind router)", !/aes-|crypto\.subtle|AES-GCM/i.test(relay.replace(/\/\/[^\n]*/g, "")));

  // daemon guards
  const daemon = readFileSync(join(ROOT, "apps/daemon/src/index.ts"), "utf8");
  check("daemon: SAFE_PAYLOAD 413 guard present", /SAFE_PAYLOAD/.test(daemon));
  check("daemon: path traversal allowlist present", /uploads|Desktop|Downloads|Documents/.test(daemon));

  // web: no raw HTML injection
  const webFiles = (() => {
    try {
      return exec("grep -rl . apps/web/src --include='*.tsx' --include='*.ts'").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  })();
  const joined = webFiles.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
  check("web: no dangerouslySetInnerHTML", !joined.includes("dangerouslySetInnerHTML"));

  // desktop: Electron shell must be sandboxed (added by P1-D01; additive check)
  const desktopMain = readFileSync(join(ROOT, "apps/desktop/src/main.ts"), "utf8");
  check(
    "desktop: sandboxed webPreferences (contextIsolation, no nodeIntegration)",
    /contextIsolation:\s*true/.test(desktopMain) &&
      /nodeIntegration:\s*false/.test(desktopMain) &&
      /sandbox:\s*true/.test(desktopMain),
  );

  // desktop: daemon sidecar wired (added by P1-D02; additive check —
  // justification lives in the pilot(P1-D02) commit message per rule #3)
  const desktopSidecar = readFileSync(join(ROOT, "apps/desktop/src/daemon.ts"), "utf8");
  check(
    "desktop: daemon sidecar (spawn, /api/health wait, quit cleanup)",
    /startDaemonSidecar/.test(desktopMain) &&
      /waitForDaemonHealth/.test(desktopMain) &&
      /will-quit/.test(desktopMain) &&
      /stopDaemonSidecar/.test(desktopMain) &&
      /\/api\/health/.test(desktopSidecar) &&
      /SIGTERM/.test(desktopSidecar) &&
      // the child must run plain Node, not a second Electron runtime
      /ELECTRON_RUN_AS_NODE:\s*"1"/.test(desktopSidecar) &&
      // health gate: only an authenticated 200 proves identity (no 401 leniency);
      // a null token is rejected outright and the reuse short-circuit is blocked
      // when there is no token (round-3 fix; behavioral coverage in
      // scripts/desktop-sidecar.test.ts "200-anywhere" assertions)
      /res\.status === 200/.test(desktopSidecar) &&
      /token === null\) return false/.test(desktopSidecar) &&
      /sidecar\.token !== null/.test(desktopSidecar),
  );

  // desktop: packaged app ships the daemon bundle (added by P2-006; additive
  // check — justification lives in the pilot(P2-006) commit message per rule #3.
  // Behavioral coverage (the gate executes the bundled artifact and probes
  // /api/health + /dashboard through it) lives in scripts/desktop-sidecar.test.ts)
  const builderYml = readFileSync(join(ROOT, "apps/desktop/electron-builder.yml"), "utf8");
  const bundleScript = readFileSync(join(ROOT, "apps/desktop/scripts/bundle-daemon.mjs"), "utf8");
  check(
    "desktop: packaged app ships daemon bundle (extraResources → daemon/index.js)",
    /from:\s*dist-daemon/.test(builderYml) &&
        /to:\s*daemon/.test(builderYml) &&
        /dashboard\.html/.test(builderYml) &&
        /bundle:\s*true/.test(bundleScript) &&
        /format:\s*"cjs"/.test(bundleScript) &&
        /dist-daemon/.test(bundleScript) &&
        /dashboard\.html/.test(bundleScript) &&
        // resolveEntry must keep looking where electron-builder ships the bundle
        /"daemon",\s*"index\.js"/.test(desktopSidecar),
  );

  // no committed secrets
  const secretPatterns = [/BEGIN [A-Z ]*PRIVATE KEY/, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /sk-[A-Za-z0-9]{20,}/];
  const gitFiles = exec("git -C . ls-files");
  let secretHit = "";
  for (const f of gitFiles.split("\n").filter(Boolean)) {
    if (/\.(png|jpg|jpeg|webp|ico|icns|woff2?)$/i.test(f)) continue;
    let buf: string;
    try {
      buf = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    for (const re of secretPatterns) {
      if (re.test(buf)) secretHit = `${f}: ${re.source}`;
    }
  }
  check("repo: no committed secrets", secretHit === "", secretHit);

  // module-shadowing defense (P2-014): agent-hijack chains (embracethered
  // 26/08/2026) make the agent extract an untrusted archive and run code inside
  // it, so a root-level struct.py/os.py/... shadows runtime stdlib for every
  // later Python in the workspace. Additive check — justification lives in the
  // pilot(P2-014) commit message per rule #3. Fail-closed: if the merge diff
  // cannot be computed, this check FAILS instead of skipping.
  const shadowName = "repo: merge diff shadows no runtime stdlib at workspace root";
  try {
    let base = "";
    for (const ref of ["origin/main", "main"]) {
      try {
        exec(`git rev-parse --verify -q ${ref}^{commit}`);
        base = ref;
        break;
      } catch {}
    }
    if (!base) {
      check(shadowName, false, "cannot resolve main to compute the merge diff");
    } else {
      const hits = stdlibShadowHits(exec(`git diff --name-status ${base}...HEAD`));
      check(
        shadowName,
        hits.length === 0,
        hits.length
          ? `${hits.join(", ")} introduced by merge diff at workspace root — remove or rename (stdlib shadowing)`
          : "",
      );
    }
  } catch (err) {
    check(shadowName, false, `merge diff unavailable: ${String(err).slice(0, 200)}`);
  }

  // state file perms (production daemon state, if present)
  try {
    const st = join(homedir(), ".opencode-remote", "daemon.json");
    const mode = statSync(st).mode & 0o777;
    check("state: daemon.json is 0600", mode === 0o600, `mode=${mode.toString(8)}`);
  } catch {
    console.log("SKIP  invariant: state: daemon.json (file not found)");
  }
} catch (err) {
  check("offline invariants crashed", false, String(err));
}

// ── live: handshake + replay + guards against the running daemon ─────────────
if (process.argv.includes("--live")) {
  const f = join(homedir(), ".opencode-remote", "daemon.json");
  const st = JSON.parse(readFileSync(f, "utf8"));
  const id = await newIdentity(false);
  process.on("exit", () => {
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      j.clients = (j.clients ?? []).filter((c: any) => c.pub !== id.publicKey);
      writeState(f, j);
    } catch {}
  });
  st.clients = [
    ...(st.clients ?? []).filter((c: any) => c.pub !== id.publicKey),
    { pub: id.publicKey, addedAt: new Date().toISOString(), label: "pilot-invariants" },
  ];
  writeState(f, st);

  const ws = new WebSocket(process.env.RELAY_URL!);
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  const { hello, sessionKey } = await clientHello(st.ecdhPub, id);
  const myId = "invariant" + Date.now().toString(36);
  let seq = 0;
  let resCount = 0;
  const pending = new Map<string, (r: OpResponse) => void>();
  ws.on("message", (d) => {
    const fr = JSON.parse(d.toString());
    if (fr.from === myId) return;
    void (async () => {
      const env = await openSealed<{ type: "res"; res: OpResponse }>(fr.payload, sessionKey, seqAad(fr.from, fr.seq ?? 0));
      if (env?.type === "res") {
        resCount++;
        pending.get(env.res.id)?.(env.res);
        pending.delete(env.res.id);
      }
    })();
  });
  ws.send(
    JSON.stringify({
      room: st.room,
      from: myId,
      payload: Buffer.from(JSON.stringify({ type: "hello", hello })).toString("base64"),
    }),
  );
  await new Promise((r) => setTimeout(r, 1500));
  async function op(method: string, path: string, body?: unknown) {
    const req = { id: crypto.randomUUID(), method, path, body };
    return new Promise<OpResponse>((resolve) => {
      pending.set(req.id, resolve);
      const s = ++seq;
      void seal({ type: "op", req }, sessionKey, seqAad(myId, s)).then((payload) =>
        ws.send(JSON.stringify({ from: myId, seq: s, payload, room: st.room })),
      );
      setTimeout(() => pending.delete(req.id), 30_000);
    });
  }

  // E2E: opencode API reachable through the encrypted tunnel
  const health = await op("GET", "/global/health");
  check("live: tunnel op (global/health)", health.status === 200);

  // replaying the exact same sealed frame must not yield a second response
  resCount = 0;
  const s1 = seq + 1;
  const payload = await seal(
    { type: "op", req: { id: crypto.randomUUID(), method: "GET", path: "/global/health" } },
    sessionKey,
    seqAad(myId, s1),
  );
  for (let i = 0; i < 2; i++) {
    ws.send(JSON.stringify({ from: myId, seq: s1, payload, room: st.room }));
    await new Promise((r) => setTimeout(r, 800));
  }
  check("live: replay yields exactly one response", resCount === 1, `got ${resCount}`);
  seq = s1; // resync counter for future ops
  ws.close();
}

function writeState(f: string, j: unknown) {
  writeFileSync(f, JSON.stringify(j, null, 2));
  chmodSync(f, 0o600);
}

function exec(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8" });
}

if (fails > 0) {
  console.log(`INVARIANTS FAILED (${fails})`);
  process.exit(1);
}
console.log("INVARIANTS OK");
process.exit(process.argv.includes("--live") ? 0 : 0);
