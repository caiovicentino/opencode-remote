/**
 * eval-02 — opencode session retention against a fake opencode server, the
 * retention CLI end to end (temp HOME), and deploy/rotate-logs.sh.
 *
 * The fake reproduces the contract verified on a hermetic `opencode serve`
 * 1.18.32 (2026-09-27): `GET /session?directory=D` lists only D's sessions,
 * newest first, 100 by default unless `limit` is passed; `scope=project`
 * would widen it to every clone of the same repository (the owner's own
 * sessions included); `DELETE /session/<id>` answers `true`, cascades the
 * children, ignores `directory` entirely, 404s an unknown id and 500s a
 * malformed one.
 * Run: npx tsx scripts/retention.test.ts
 */
import "./testhome"; // throwaway HOME before any pilot module loads (testhome.ts)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETENTION_MAX_CONSECUTIVE_FAILURES, runSessionRetention } from "../apps/pilot/src/retention";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const ROOT = join(import.meta.dirname, "..");
const DAY = 24 * 60 * 60_000;
const NOW = Date.now();

interface Row {
  id: string;
  directory: string;
  parentID?: string;
  title: string;
  time: { created: number; updated: number };
}
const row = (id: string, directory: string, daysAgo: number, parentID?: string): Row => ({
  id,
  directory,
  title: `t-${id}`,
  time: { created: NOW - daysAgo * DAY, updated: NOW - daysAgo * DAY },
  ...(parentID ? { parentID } : {}),
});

interface Fake {
  url: string;
  requests: { method: string; path: string; query: URLSearchParams }[];
  rows: Map<string, Row>;
  boom: Set<string>;
  listStatus: Map<string, number>;
  close: () => Promise<void>;
}

async function fakeOpencode(initial: Row[]): Promise<Fake> {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const requests: Fake["requests"] = [];
  const boom = new Set<string>();
  const listStatus = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    requests.push({ method: req.method ?? "", path: u.pathname, query: u.searchParams });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && u.pathname === "/session") {
      const dir = u.searchParams.get("directory") ?? "";
      const forced = listStatus.get(dir);
      if (forced) return json(forced, { name: "UnknownError" });
      const limit = Number(u.searchParams.get("limit") ?? 100);
      const all = [...rows.values()]
        .filter((r) => (u.searchParams.get("scope") === "project" ? true : r.directory === dir || r.directory.startsWith(`${dir}#leak`)))
        .sort((a, b) => b.time.updated - a.time.updated);
      return json(200, all.slice(0, limit));
    }
    const m = /^\/session\/([^/]+)$/.exec(u.pathname);
    if (req.method === "DELETE" && m) {
      const id = decodeURIComponent(m[1]!);
      if (!/^ses/.test(id) || boom.has(id)) return json(500, { name: "UnknownError", data: { message: "Unexpected server error" } });
      if (!rows.has(id)) return json(404, { name: "NotFoundError", data: { message: `Session not found: ${id}` } });
      const drop = (x: string) => {
        rows.delete(x);
        for (const r of [...rows.values()]) if (r.parentID === x) drop(r.id);
      };
      drop(id);
      return json(200, true);
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    rows,
    boom,
    listStatus,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const HOME_DIR = "/Users/op/.opencode-remote/pilot";
const SLOT1 = `${HOME_DIR}/repo-1`;
const SLOT2 = `${HOME_DIR}/repo-2`;
const OWNER = "/Volumes/SSD Major/Major/opencode-remote"; // same git project, the owner's own clone

function fixture(): Row[] {
  return [
    row("ses_aaa1", SLOT1, 20),
    row("ses_aaa1kid", SLOT1, 20, "ses_aaa1"),
    row("ses_aaa2", SLOT1, 30),
    row("ses_aaa3", SLOT1, 2), // recent
    row("ses_bbb1", SLOT2, 40),
    row("ses_owner1", OWNER, 90), // must never be touched
  ];
}

// ── dry-run: plans, never deletes ────────────────────────────────────────────
{
  const fake = await fakeOpencode(fixture());
  try {
    const r = await runSessionRetention({ baseUrl: fake.url, dirs: [SLOT1, SLOT2], maxAgeDays: 14, maxDeletes: 100, apply: false, now: NOW, pauseMs: 0 });
    check("dry-run: candidates = old pilot roots, oldest first", r.plan.candidates.map((c) => c.id).join() === "ses_bbb1,ses_aaa2,ses_aaa1", r.plan.candidates.map((c) => c.id).join());
    check("dry-run: zero DELETE requests", fake.requests.every((q) => q.method !== "DELETE"));
    check("dry-run: listings pass a large limit (the default 100 hides the oldest)", fake.requests.filter((q) => q.method === "GET").every((q) => Number(q.query.get("limit")) >= 10_000));
    check("dry-run: never lists with scope=project (would include the owner's clone)", fake.requests.every((q) => q.query.get("scope") === null));
    check("dry-run: nothing deleted server-side", fake.rows.size === 6);
  } finally {
    await fake.close();
  }
}

// ── apply: deletes exactly the plan, audits every action ─────────────────────
{
  const fake = await fakeOpencode(fixture());
  const audit: Record<string, unknown>[] = [];
  try {
    const r = await runSessionRetention({ baseUrl: fake.url, dirs: [SLOT1, SLOT2], maxAgeDays: 14, maxDeletes: 100, apply: true, now: NOW, audit: (a) => audit.push(a), pauseMs: 0 });
    check("apply: every candidate deleted", r.deleted.join() === "ses_bbb1,ses_aaa2,ses_aaa1" && r.failed.length === 0);
    check("apply: the child went with its root (server-side cascade), never requested itself", !fake.rows.has("ses_aaa1kid") && !fake.requests.some((q) => q.path.endsWith("ses_aaa1kid")));
    check("apply: the recent pilot session and the owner's session survive", fake.rows.has("ses_aaa3") && fake.rows.has("ses_owner1"));
    const dels = fake.requests.filter((q) => q.method === "DELETE");
    check("apply: DELETE carries the owning directory (documentation only — the server ignores it)", dels.every((q) => q.query.get("directory") === SLOT1 || q.query.get("directory") === SLOT2));
    check("apply: one audit record per delete with outcome + title + age", audit.length === 3 && audit.every((a) => a.event === "session-delete" && a.outcome === "deleted" && typeof a.updatedAt === "string" && typeof a.title === "string"));
  } finally {
    await fake.close();
  }
}

// ── the server leaks a foreign row into a pilot listing: never trusted ──────
{
  const leak = row("ses_leak", `${SLOT1}#leak-owner`, 99);
  const fake = await fakeOpencode([...fixture(), leak]);
  try {
    const r = await runSessionRetention({ baseUrl: fake.url, dirs: [SLOT1], maxAgeDays: 14, maxDeletes: 100, apply: true, now: NOW, pauseMs: 0 });
    check("ownership: a row whose directory is not exactly the pilot dir is kept", fake.rows.has("ses_leak") && r.plan.kept.foreign === 1 && !r.deleted.includes("ses_leak"));
  } finally {
    await fake.close();
  }
}

// ── 404 is `gone`, repeated 5xx stops the run ────────────────────────────────
{
  const rows: Row[] = [];
  for (let k = 0; k < 9; k++) rows.push(row(`ses_old${k}`, SLOT1, 30 + k));
  const fake = await fakeOpencode(rows);
  try {
    // ses_old8 is the oldest → first; make it vanish between list and delete
    const origDelete = fake.rows.delete.bind(fake.rows);
    let listed = false;
    fake.requests.length = 0;
    for (let k = 0; k < 8; k++) fake.boom.add(`ses_old${k}`);
    const audit: Record<string, unknown>[] = [];
    const p = runSessionRetention({
      baseUrl: fake.url,
      dirs: [SLOT1],
      maxAgeDays: 14,
      maxDeletes: 100,
      apply: true,
      now: NOW,
      pauseMs: 0,
      audit: (a) => audit.push(a),
      fetchImpl: async (url, init) => {
        if (!listed && String(url).includes("/session?")) {
          listed = true;
          const res = await fetch(url, init);
          origDelete("ses_old8"); // gone before its DELETE arrives
          return res;
        }
        return fetch(url, init);
      },
    });
    const r = await p;
    check("errors: an id already gone (404) is `gone`, not a failure", r.gone.join() === "ses_old8");
    check(
      `errors: ${RETENTION_MAX_CONSECUTIVE_FAILURES} consecutive failures stop the run`,
      r.stoppedEarly && r.failed.length === RETENTION_MAX_CONSECUTIVE_FAILURES && r.failed.every((f) => f.status === 500),
      JSON.stringify(r.failed),
    );
    check("errors: failures are audited too", audit.filter((a) => a.outcome === "failed").length === RETENTION_MAX_CONSECUTIVE_FAILURES);
  } finally {
    await fake.close();
  }
}

// ── listing problems: truncation and HTTP errors ─────────────────────────────
{
  const rows: Row[] = [];
  for (let k = 0; k < 5; k++) rows.push(row(`ses_trunc${k}`, SLOT1, 20 + k));
  const fake = await fakeOpencode(rows);
  fake.listStatus.set(SLOT2, 500);
  try {
    const r = await runSessionRetention({ baseUrl: fake.url, dirs: [SLOT1, SLOT2], maxAgeDays: 14, maxDeletes: 2, apply: false, now: NOW, listLimit: 5, pauseMs: 0 });
    check("listing: a listing that hits the limit is reported truncated", r.truncatedDirs.join() === SLOT1);
    check("listing: an HTTP error is reported and plans nothing for that dir", r.listErrors.length === 1 && r.listErrors[0]!.includes("HTTP 500"));
    check("listing: the per-run cap holds (2 of 5 planned, oldest first)", r.plan.candidates.map((c) => c.id).join() === "ses_trunc4,ses_trunc3" && r.plan.kept.capped === 3);
  } finally {
    await fake.close();
  }
}

// ── CLI end to end, temp HOME ────────────────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), "retention-cli-"));
  const pilot = join(home, ".opencode-remote", "pilot");
  mkdirSync(join(pilot, "repo-1"), { recursive: true });
  mkdirSync(join(pilot, "gate-ws"), { recursive: true });
  const slot = join(pilot, "repo-1");
  const fake = await fakeOpencode([row("ses_cli1", slot, 20), row("ses_cli2", slot, 1), row("ses_own", OWNER, 60)]);
  const env = { ...process.env, HOME: home };
  try {
    // async spawn: the fake server lives in THIS process — a spawnSync would
    // block its event loop and deadlock the child's first request
    const run = (args: string[]) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx/esm", "apps/pilot/src/retention.ts", ...args, "--url", fake.url], { cwd: ROOT, env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += String(d)));
        child.stderr.on("data", (d) => (stderr += String(d)));
        const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.on("close", (status) => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr });
        });
      });
    const dry = await run(["sessions", "--days", "14"]);
    const dryOut = dry.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const summary = dryOut.find((l) => l.summary)?.summary as Record<string, unknown> | undefined;
    check("cli: dry-run by default — plans 1, deletes 0, exit 0", dry.status === 0 && summary?.mode === "dry-run" && summary?.candidates === 1 && summary?.deleted === 0, dry.stdout + dry.stderr);
    check("cli: dry-run writes no audit file", !existsSync(join(pilot, "retention-audit.jsonl")));
    check("cli: only the pilot's own clones are listed (gate-ws is not a session dir)", fake.requests.filter((q) => q.method === "GET").map((q) => q.query.get("directory")).join() === slot);
    const apply = await run(["sessions", "--days", "14", "--apply"]);
    check("cli: --apply deletes the old pilot session only", apply.status === 0 && !fake.rows.has("ses_cli1") && fake.rows.has("ses_cli2") && fake.rows.has("ses_own"), apply.stdout + apply.stderr);
    const trail = readFileSync(join(pilot, "retention-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    check("cli: audit trail = one delete record + one run summary", trail.length === 2 && trail[0]!.event === "session-delete" && trail[0]!.id === "ses_cli1" && trail[1]!.event === "session-retention");
    check("cli: the machine audit.log gets a pilot-retention record", readFileSync(join(home, ".opencode-remote", "audit.log"), "utf8").includes('"event":"pilot-retention"'));
    const bad = await run(["sessions", "--days", "0"]);
    check("cli: --days below 1 is refused", bad.status === 2);
  } finally {
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  }
}

// ── deploy/rotate-logs.sh ────────────────────────────────────────────────────
if (spawnSync("zsh", ["-c", "true"]).status !== 0) {
  console.log("SKIP rotate-logs.sh (zsh not available on this host)");
} else {
  const script = join(ROOT, "deploy", "rotate-logs.sh");
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "rotate-"));
    const logs = join(home, ".opencode-remote", "logs");
    mkdirSync(logs, { recursive: true });
    return { home, logs };
  };
  const rotate = (home: string) => spawnSync("zsh", [script], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000 });
  const big = 11 * 1024 * 1024;

  {
    const { home, logs } = setup();
    const content = "line\n".repeat(Math.ceil(big / 5) + 1);
    writeFileSync(join(logs, "pilot.log"), content);
    writeFileSync(join(logs, "small.log"), "tiny\n");
    for (let k = 1; k <= 7; k++) {
      const f = join(logs, `relay.log.2026090${k}-030700`);
      writeFileSync(f, `r${k}\n`);
      const t = new Date(Date.UTC(2026, 8, k));
      utimesSync(f, t, t);
    }
    const daemonArchive = join(logs, "daemon.log.20260923-030700");
    writeFileSync(daemonArchive, "d\n");
    const t23 = new Date(Date.UTC(2026, 8, 23));
    utimesSync(daemonArchive, t23, t23);
    const r = rotate(home);
    const names = readdirSync(logs).sort();
    const gz = names.find((n) => /^pilot\.log\.\d{8}-\d{6}\.gz$/.test(n));
    check("rotate: a >10MB log is archived gzip-compressed and truncated", r.status === 0 && !!gz && readFileSync(join(logs, "pilot.log")).length === 0, r.stdout + r.stderr);
    const round = gz ? spawnSync("gzip", ["-dc", join(logs, gz)], { maxBuffer: 64 * 1024 * 1024 }).stdout.length : 0;
    check("rotate: the archive round-trips to the original bytes", round === content.length, `${round} vs ${content.length}`);
    check("rotate: a small log is left alone", readFileSync(join(logs, "small.log"), "utf8") === "tiny\n");
    check("rotate: legacy plain archives get compressed", names.includes("daemon.log.20260923-030700.gz") && !names.includes("daemon.log.20260923-030700"));
    const relay = names.filter((n) => n.startsWith("relay.log."));
    check(
      "rotate: prune is per log — the 5 newest relay archives stay AND the newer daemon archive survives (old `sort -r` deleted it)",
      relay.length === 5 && !relay.some((n) => n.startsWith("relay.log.20260901") || n.startsWith("relay.log.20260902")) && names.includes("daemon.log.20260923-030700.gz"),
      names.join(" "),
    );
    rmSync(home, { recursive: true, force: true });
  }

  if (process.getuid?.() === 0) {
    console.log("SKIP rotate unreadable-log case (root ignores file modes)");
  } else {
    const { home, logs } = setup();
    const a = join(logs, "a.log");
    writeFileSync(a, Buffer.alloc(big));
    chmodSync(a, 0o000);
    writeFileSync(join(logs, "z.log"), Buffer.alloc(big));
    const r = rotate(home);
    chmodSync(a, 0o644);
    const names = readdirSync(logs);
    check("rotate: one unarchivable log no longer aborts the run — the next log still rotates (old `set -e` + cp stopped here)", names.some((n) => /^z\.log\.\d{8}-\d{6}\.gz$/.test(n)) && readFileSync(join(logs, "z.log")).length === 0, r.stdout);
    check("rotate: the unarchivable log is left intact and the run reports it (exit 1)", readFileSync(a).length === big && r.status === 1 && r.stdout.includes("rotate FAILED"));
    rmSync(home, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall retention checks passed");
