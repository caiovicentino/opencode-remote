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
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOURNEY_STEPS,
  explorerShotsDir,
  journeyShotName,
  runExplorer,
  commitAndPushFindings,
} from "../apps/pilot/src/explorer";
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

// Fake gh shim (P1-076 R4/R6): landings go through the pilot/meta PR whose
// merge is only confirmed via `gh pr view` — against a throwaway local origin
// the real gh can never work, so the shim emulates the full PR lifecycle: no
// PR until `pr create`, OPEN with the real branch head as headRefOid until a
// merge is armed, then MERGED with the same head (the landing only reports
// success when the merged head is its own commit). On PATH it covers both the
// agent-phase landing and the deterministic beat below; a hostile gh call
// inside the scratch stays harmless by construction.
const fakeGhBin = join(tmp, "bin");
const fakeGhState = join(tmp, "fake-gh-merged");
const fakeGhCreated = join(tmp, "fake-gh-created");
writeFileSync(
  join(fakeGhBin, "gh"),
  `#!/bin/bash\nstate=${shq(fakeGhState)}\ncreated=${shq(fakeGhCreated)}\nws=${shq(ws)}\ncase "$1 $2" in\n  "pr view")\n    if [ ! -f "$created" ]; then echo "no pull requests" >&2; exit 1; fi\n    head=$(git -C "$ws" rev-parse origin/pilot/meta 2>/dev/null || echo "")\n    if [ -f "$state" ]; then echo "{\\"state\\":\\"MERGED\\",\\"headRefOid\\":\\"$head\\"}"; else echo "{\\"state\\":\\"OPEN\\",\\"headRefOid\\":\\"$head\\"}"; fi\n    ;;\n  "pr create") touch "$created" ;;\n  "pr merge") touch "$state" ;;\n  *) : ;;\nesac\n`,
  { mode: 0o755 },
);
process.env.PATH = `${fakeGhBin}:${process.env.PATH ?? ""}`;

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
// P2-105: the closed product-review loop — the six stable journey shots must
// exist and the fable pass must have emitted its product-review event.
const missingShots = JOURNEY_STEPS.filter((step) => !existsSync(join(explorerShotsDir(), journeyShotName(step, today))));
proof(
  "6 stable journey shots on disk (first-boot/pairing/chat/artifact/browser/mission-control)",
  missingShots.length === 0,
  missingShots.length ? `missing: ${missingShots.join(",")}` : JOURNEY_STEPS.map((s) => journeyShotName(s, today)).join(" "),
);
proof(
  "fable product-review event in events.jsonl",
  events.some((e) => e.phase === "product-review" && e.ok),
  events.map((e) => e.phase).join(","),
);

if (!SHA_RE.test(baseSha)) {
  proof("origin main sha is a validated 40-hex sha", false, baseSha.slice(0, 12));
} else {
  const headNow = sh(`git -C ${shq(origin)} rev-parse main`);
  if (!SHA_RE.test(headNow)) {
    proof("origin main sha is a validated 40-hex sha", false, headNow.slice(0, 12));
  } else {
    execSync(`git -C ${shq(origin)} cat-file -e ${shq(`${headNow}^{commit}`)}`);
    // P1-076 R4: findings land via the pilot/meta PR — main itself must never
    // move (post-merge, branch protection rejects direct pushes).
    proof("landing never touches origin/main directly", headNow === baseSha, `${baseSha.slice(0, 7)} -> ${headNow.slice(0, 7)}`);
    // Agent-phase evidence (conditional: the nightly agent may file nothing)
    // — snapshotted before the deterministic beat below force-pushes the
    // shared pilot/meta branch with its own landing.
    const agentMeta = sh(`git -C ${shq(origin)} rev-parse --verify -q refs/heads/pilot/meta || true`);
    if (SHA_RE.test(agentMeta)) {
      const agentSubject = sh(`git -C ${shq(origin)} log -1 --format=%s pilot/meta`);
      proof(
        // P2-105: the last agent-phase landing may be the explorer's findings
        // or the fable product review — both are valid agent-phase subjects.
        "agent landing keeps a pilot(explorer|fable) subject on pilot/meta",
        agentSubject.startsWith("pilot(explorer):") || agentSubject.startsWith("pilot(fable):"),
        agentSubject,
      );
      proof(
        "agent landing fired the filed event (fake gh confirms the merge)",
        events.some((e) => e.phase === "filed" && e.ok) || events.some((e) => e.phase === "product-review-filed" && e.ok),
        events.map((e) => e.phase).join(","),
      );
    } else {
      proof("run completed with no findings filed (no pilot/meta landing)", true, baseSha.slice(0, 7));
    }
    // Deterministic landing beat (P1-076 R4): the real commitAndPushFindings
    // against the throwaway origin, with the fake gh confirming the squash —
    // a broken landing now fails the proof even when the agent filed nothing
    // (the old driver passed vacuously on an unchanged main).
    const landed = await commitAndPushFindings(
      ws,
      [
        {
          title: "proof landing",
          severity: "low",
          area: "infra",
          shot: "proof.png",
          detail: "deterministic proof beat for the P1-076 landing path",
        },
      ],
      `pilot(explorer): proof landing ${today}`,
      {
        exec: (cmd) => {
          try {
            return { ok: true, output: execSync(cmd, { cwd: ws, stdio: "pipe" }).toString() };
          } catch {
            return { ok: false, output: "" };
          }
        },
        sleep: () => Promise.resolve(),
      },
    );
    proof("deterministic landing reports pushed (merge confirmed via fake gh)", landed === true, String(landed));
    const metaSha = sh(`git -C ${shq(origin)} rev-parse --verify -q refs/heads/pilot/meta || true`);
    if (!SHA_RE.test(metaSha)) {
      proof("pilot/meta ref exists on the throwaway origin", false, metaSha || "(missing)");
    } else {
      const subject = sh(`git -C ${shq(origin)} log -1 --format=%s pilot/meta`);
      proof("landed subject keeps the pilot(explorer) prefix on pilot/meta", subject.startsWith("pilot(explorer):"), subject);
      const backlog = sh(`git -C ${shq(origin)} show pilot/meta:BACKLOG.md`);
      proof("landed finding is in BACKLOG.md on pilot/meta", backlog.includes("[explorer]"), "");
      const mainAfter = sh(`git -C ${shq(origin)} rev-parse main`);
      proof("origin/main still untouched after the deterministic landing", mainAfter === baseSha, `${baseSha.slice(0, 7)} -> ${mainAfter.slice(0, 7)}`);
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
