/**
 * P3-101 — hermetic proof driver for the nightly explorer (P3-052).
 *
 * Runs the REAL explorer flow end-to-end without touching production:
 * real agent spawn, real desktop-app harness drive (fresh OCR_DESKTOP_SESSION),
 * real shots in ~/.opencode-remote/pilot/shots/explorer/ and real events in
 * the pilot's events.jsonl — but every git write lands on a THROWAWAY bare
 * origin (mkdtemp + bare origin + clone, P1-036 lesson) and the state save is
 * injected as a spy, never touching the production state.json.
 *
 * The scratch workspace gets a full COPY of node_modules (round-3 review):
 * the agent runs with bash/edit allowed, so a shared tree (symlink) would let
 * an accidental `npm ci`/install in the scratch follow straight into the real
 * dependency tree — a copy keeps every write inside the throwaway dir.
 * All interpolated shell values go through shq + SHA validation. On success
 * the scratch is removed; on failure it is kept for inspection (path printed).
 *
 * Usage: node --import tsx/esm scripts/explorer-proof.ts
 * Prints a PROOF line per assertion and exits non-zero on any failure.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explorerShotsDir, runExplorer } from "../apps/pilot/src/explorer";
import { readEvents } from "../apps/pilot/src/events";
import { nowLocalISO } from "../apps/pilot/src/log";
import type { PilotConfig, PilotState } from "../apps/pilot/src/state";

const REPO = join(import.meta.dirname, "..");
let failures = 0;
function proof(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PROOF" : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** POSIX single-quote escape (JSON.stringify is NOT shell quoting). */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** Only a validated full sha may be interpolated into a git command. */
const SHA_RE = /^[0-9a-f]{40}$/;

const tmp = mkdtempSync(join(tmpdir(), "explorer-proof-"));
const origin = join(tmp, "origin.git");
const ws = join(tmp, "ws");
const today = nowLocalISO().slice(0, 10);
const startedAt = new Date().toISOString();
const sh = (c: string) => execSync(c, { encoding: "utf8" }).trim();

// throwaway bare origin + scratch workspace on main (mirrors production shape)
sh(`git clone --bare -q ${shq(`${REPO}/.git`)} ${shq(origin)}`);
sh(`git -C ${shq(origin)} update-ref refs/heads/main HEAD`);
const baseSha = sh(`git -C ${shq(origin)} rev-parse main`);
sh(`git clone -q ${shq(origin)} ${shq(ws)} -b main`);
writeFileSync(
  join(ws, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      permission: { edit: "allow", bash: "allow", external_directory: "allow", webfetch: "allow" },
    },
    null,
    2,
  ),
);
// deps (full copy — see header) + prebuilt dists so the agent spends its
// budget exploring, not building
cpSync(join(REPO, "node_modules"), join(ws, "node_modules"), { recursive: true });
for (const d of ["apps/web/dist", "apps/desktop/dist-electron"]) {
  if (existsSync(join(REPO, d))) cpSync(join(REPO, d), join(ws, d), { recursive: true });
}

const saved: string[] = [];
const scratch: PilotState = { date: "scratch", tasks: 0, deploys: 0, failures: 0, merges: 0, taskAttempts: {} };
await runExplorer({ workspace: ws } as PilotConfig, scratch, {
  save: (st) => {
    saved.push(st.explorerLast ?? "");
  },
});

proof("claim persisted before the run", saved.length === 1 && saved[0] === today, `explorerLast=${saved[0] ?? "none"}`);
const events = readEvents(50).filter((e) => e.task === "explorer" && e.ts >= startedAt);
proof(
  "task:explorer done event in events.jsonl",
  events.some((e) => e.phase === "done" && e.ok),
  events.map((e) => e.phase).join(","),
);
const digits = today.replace(/[^0-9]/g, "");
const shots = existsSync(explorerShotsDir())
  ? readdirSync(explorerShotsDir()).filter((f) => f.includes(digits) && f.endsWith(".png"))
  : [];
proof("fresh shots on disk", shots.length >= 1, shots.join(" ").slice(0, 200));

if (!SHA_RE.test(baseSha)) {
  proof("origin main sha is a validated 40-hex sha", false, baseSha.slice(0, 12));
} else {
  const headNow = sh(`git -C ${shq(origin)} rev-parse main`);
  if (!SHA_RE.test(headNow)) {
    proof("origin main sha is a validated 40-hex sha", false, headNow.slice(0, 12));
  } else {
    execSync(`git -C ${shq(origin)} cat-file -e ${shq(`${headNow}^{commit}`)}`);
    if (headNow !== baseSha) {
      const msg = sh(`git -C ${shq(origin)} log -1 --format=%s main`);
      const filed = events.some((e) => e.phase === "filed");
      proof("findings commit resolves on throwaway origin/main", msg.startsWith("pilot(explorer):") && filed, `${headNow.slice(0, 7)} ${msg}`);
    } else {
      proof("run completed with no findings filed (origin main unchanged)", true, baseSha.slice(0, 7));
    }
  }
}
if (failures === 0) {
  rmSync(tmp, { recursive: true, force: true }); // success = throwaway proven, keep disk clean
  console.log("PROOF all assertions green — scratch removed");
} else {
  console.log(`PROOF scratch kept for inspection: ${tmp}`);
}
process.exit(failures === 0 ? 0 : 1);
