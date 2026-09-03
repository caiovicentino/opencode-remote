/**
 * Unit tests for the e2e pre-flight (P1-081): the orphan-killer kill decision
 * must be SYMMETRIC — argv marker alone never kills; every marker (daemon,
 * relay, desktop) requires the env second factor. Also covers settled()
 * treating signal deaths as settled (the port-thief guard) and the
 * bootOnEphemeralPort anti-thief re-check.
 * Run: npx tsx scripts/e2e-orphans.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import {
  bootOnEphemeralPort,
  collectCandidates,
  envHasTempMarker,
  E2E_ARGV_MARKERS,
  killOrphans,
  readProcessEnv,
  settled,
  type OrphanCandidate,
} from "./e2e-orphans";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const TMP = tmpdir();

// --- settled(): a signal-killed child is settled even with exitCode === null --
check("settled: running child is not settled", !settled({ exitCode: null, signalCode: null, killed: false }));
check("settled: normal exit is settled", settled({ exitCode: 0, signalCode: null, killed: false }));
check("settled: signal death is settled (signalCode, exitCode stays null)", settled({ exitCode: null, signalCode: "SIGKILL", killed: false }));
check("settled: our own kill() marks it settled", settled({ exitCode: null, signalCode: null, killed: true }));

// --- envHasTempMarker ---------------------------------------------------------
const realHomeEnv: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/Users/operator",
  SHELL: "/bin/zsh",
  USER: "operator",
  TMPDIR: join(TMP, "T/"),
  LANG: "pt-BR.UTF-8",
};
check("envHasTempMarker: real operator env dump → false", envHasTempMarker(realHomeEnv, TMP) === false);
check(
  "envHasTempMarker: any env value under <tmpdir>/ocr- → true",
  envHasTempMarker({ ...realHomeEnv, HOME: join(TMP, "ocr-int-XYZ123") }, TMP) === true,
);
for (const key of ["OCR_E2E_MARKER", "OCR_DESKTOP_SESSION", "OCR_USER_DATA_DIR"]) {
  check(
    `envHasTempMarker: presence of ${key} → true`,
    envHasTempMarker({ ...realHomeEnv, [key]: join(TMP, "whatever") }, TMP) === true,
  );
}
check(
  "envHasTempMarker: empty hatch value does not count as set",
  envHasTempMarker({ ...realHomeEnv, OCR_E2E_MARKER: "" }, TMP) === false,
);
check("envHasTempMarker: clean empty env → false", envHasTempMarker({}, TMP) === false);

// --- collectCandidates --------------------------------------------------------
const psFixture = [
  "  101 /usr/sbin/cron",
  "  202 npx tsx apps/daemon/src/index.ts",
  " 303 /Applications/Electron.app/Contents/MacOS/Electron /repo/apps/desktop --no-sandbox",
  "  404 node /srv/relay/src/index.ts",
  "  505 npx tsx apps/relay/src/index.ts",
  "garbage line without pid",
].join("\n");
const candidates = collectCandidates(psFixture);
check(
  "collectCandidates: matches exactly the three e2e argv shapes",
  candidates.length === 3 &&
    candidates[0].pid === 202 &&
    candidates[0].marker === "daemon" &&
    candidates[1].pid === 303 &&
    candidates[1].marker === "desktop" &&
    candidates[2].pid === 505 &&
    candidates[2].marker === "relay",
  JSON.stringify(candidates),
);

// --- killOrphans: the symmetry rule (P1-081 re-raise) --------------------------
// For EACH of the three markers: same argv, different env ⇒ different verdict.
const markedEnv = { HOME: join(TMP, "ocr-flow-abc"), PATH: "/usr/bin" };
for (const marker of E2E_ARGV_MARKERS) {
  const c: OrphanCandidate = { pid: 4242, command: marker.argvMarker, marker: marker.label };
  const kills: string[] = [];
  const report = await killOrphans({
    candidates: [c],
    readEnv: () => ({ ...realHomeEnv }),
    envMarked: (env) => envHasTempMarker(env, TMP),
    isAlive: () => false,
    kill: (pid, signal) => void kills.push(`${pid}:${signal}`),
    graceMs: 10,
  });
  check(
    `killOrphans (${marker.label}): argv matches but clean env is SPARED (operator's real app)`,
    report.killed.length === 0 && report.spared.length === 1 && kills.length === 0,
  );
  const report2 = await killOrphans({
    candidates: [c],
    readEnv: () => ({ ...markedEnv }),
    envMarked: (env) => envHasTempMarker(env, TMP),
    isAlive: () => false,
    kill: (pid, signal) => void kills.push(`${pid}:${signal}`),
    graceMs: 10,
  });
  check(
    `killOrphans (${marker.label}): argv + hermetic env is KILLED via SIGTERM`,
    report2.killed.length === 1 && !report2.killed[0].forced && kills.join() === `4242:SIGTERM`,
  );
}

check(
  "killOrphans: unreadable env is spared (fail-safe, never guess-kill)",
  (
    await killOrphans({
      candidates: [{ pid: 1, command: "x", marker: "relay" }],
      readEnv: () => null,
      envMarked: () => true,
      isAlive: () => false,
      kill: () => {},
      graceMs: 10,
    })
  ).spared.length === 1,
);
const survivorKills: string[] = [];
check(
  "killOrphans: SIGTERM survivor gets SIGKILL",
  (
    await killOrphans({
      candidates: [{ pid: 7, command: "x", marker: "relay" }],
      readEnv: () => ({ OCR_E2E_MARKER: "1" }),
      envMarked: (env) => envHasTempMarker(env, TMP),
      isAlive: () => true,
      kill: (pid, signal) => void survivorKills.push(`${pid}:${signal}`),
      graceMs: 10,
    })
  ).killed[0].forced === true && survivorKills.join() === "7:SIGTERM,7:SIGKILL",
);

// --- bootOnEphemeralPort -------------------------------------------------------
function fakeChild(shape: { exitCode: number | null; signalCode: string | null; killed: boolean }): ChildProcess {
  return { kill: () => true, ...shape } as unknown as ChildProcess;
}

// happy path: a REAL listener plays the child; the probe dials TCP like the
// relay readiness probe does.
const fakeServer = createServer();
const boot = await bootOnEphemeralPort({
  label: "test-server",
  spawn: (port) => {
    fakeServer.listen(port, "127.0.0.1");
    return fakeChild({ exitCode: null, signalCode: null, killed: false });
  },
  probe: (port) =>
    new Promise<boolean>((resolve) => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    }),
  timeoutMs: 5_000,
});
check("bootOnEphemeralPort: happy path boots and returns the port", boot.port > 0);
fakeServer.close();

// anti-thief guard: the child dies from an external signal MID-BOOT while a
// thief answers the probe — the answer must NOT be trusted (P1-081 finding).
let thiefProbes = 0;
const thiefError = await (async () => {
  try {
    await bootOnEphemeralPort({
      label: "thief-victim",
      spawn: () =>
        ({
          exitCode: null,
          get signalCode() {
            return thiefProbes > 0 ? "SIGKILL" : null;
          },
          killed: false,
        }) as unknown as ChildProcess,
      probe: async () => {
        thiefProbes++;
        return true; // the thief answers eagerly
      },
      timeoutMs: 5_000,
    });
    return null; // boot unexpectedly succeeded
  } catch (err) {
    return err as Error;
  }
})();
check(
  "bootOnEphemeralPort: a readiness answer after the child was signal-killed is rejected as a port thief",
  thiefError !== null && thiefError.message.includes("port thief"),
  thiefError?.message,
);

// dead-before-first-probe: immediate "died mid-boot" with the port in the message
const deadBoot = await (async () => {
  try {
    await bootOnEphemeralPort({
      label: "dead-child",
      spawn: () => fakeChild({ exitCode: null, signalCode: "SIGTERM", killed: false }),
      probe: async () => true,
      timeoutMs: 5_000,
    });
    return null;
  } catch (err) {
    return err as Error;
  }
})();
check(
  "bootOnEphemeralPort: signal-dead child fails the boot with a diagnostic",
  deadBoot !== null && deadBoot.message.includes("died mid-boot"),
  deadBoot?.message,
);

// never-answering child hits the timeout with the lsof diagnostic
const timeoutBoot = await (async () => {
  try {
    await bootOnEphemeralPort({
      label: "silent-child",
      spawn: () => fakeChild({ exitCode: null, signalCode: null, killed: false }),
      probe: async () => false,
      timeoutMs: 900,
    });
    return null;
  } catch (err) {
    return err as Error;
  }
})();
check(
  "bootOnEphemeralPort: timeout names the port holder (lsof diagnostic)",
  timeoutBoot !== null && timeoutBoot.message.includes("never came up") && timeoutBoot.message.includes("lsof"),
  timeoutBoot?.message,
);

if (process.platform === "darwin" || process.platform === "linux") {
  const decoy = spawn(
    process.execPath,
    [
      "-e",
      "setInterval(()=>{},1000)",
      "FOO=notenv",
      "OCR_E2E_MARKER=1",
      join(TMP, "ocr-int-FAKE", "path"),
      "apps/relay/src/index.ts",
    ],
    { stdio: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/Users/operator" } },
  );
  await new Promise((r) => setTimeout(r, 400));
  check("poisoned decoy is running", decoy.pid !== undefined && !decoy.killed);
  const env = readProcessEnv(decoy.pid!);
  check(
    "readProcessEnv: argv KEY=VALUE tokens never become env entries",
    env !== null && env.FOO === undefined && env.OCR_E2E_MARKER === undefined,
    JSON.stringify(env),
  );
  check(
    "readProcessEnv: an <tmpdir>/ocr- path in ARGV does not mark the env (spare direction)",
    env !== null && envHasTempMarker(env, TMP) === false,
    JSON.stringify(env),
  );
  check(
    "readProcessEnv: genuine env keys still parse (PATH present)",
    env !== null && typeof env.PATH === "string" && env.PATH.length > 0,
  );
  // end-to-end through the kill decision: the poisoned argv alone must NOT kill
  const kills: number[] = [];
  const report = await killOrphans({
    candidates: [{ pid: decoy.pid!, command: "node ... apps/relay/src/index.ts", marker: "relay" }],
    readEnv: readProcessEnv,
    envMarked: (e) => envHasTempMarker(e, TMP),
    isAlive: () => true,
    kill: (pid) => void kills.push(pid),
    graceMs: 10,
  });
  check(
    "killOrphans: poisoned-argv process with clean env is SPARED end-to-end",
    report.spared.length === 1 && report.killed.length === 0 && kills.length === 0,
  );
  decoy.kill("SIGKILL");
}

console.log(failures === 0 ? "\ne2e-orphans tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
