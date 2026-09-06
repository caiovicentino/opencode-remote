/**
 * P2-247: load-failure plan tests (apps/desktop/src/loadfail.ts) — the
 * portable twin of the unit.test.ts block. Pure node: no Electron, no
 * sockets, no chmod, no spawn; the only fs use is reading the real main.ts
 * source for the wiring assertions, via a URL relative to this file
 * (Windows-safe).
 * Run: npx tsx scripts/loadfail.test.ts
 */
import { readFileSync } from "node:fs";
import {
  CHROMIUM_ERR_ABORTED,
  LOAD_FAIL_MAX_ATTEMPTS,
  LOAD_FAIL_RETRY_DELAY_MS,
  LOAD_FAILURE_ZEROED,
  loadFailMessage,
  loadFailVerdict,
  sanitizeLoadFailure,
} from "../apps/desktop/src/loadfail";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const now = 1_700_000_000_000;
const json = (v: unknown) => JSON.stringify(v);
const noSlash = (s: string) => !s.includes("/") && !s.includes("://") && !s.includes("\\");
const rec = (code = -6, description = "ERR_FILE_NOT_FOUND", address = "file:///App/resources/index.html", isMainFrame = true) =>
  sanitizeLoadFailure({ code, description, address, isMainFrame });

// --- sanitizeLoadFailure ---------------------------------------------------------
{
  check("sanitize: absent input becomes the zeroed record", json(sanitizeLoadFailure(undefined)) === json(LOAD_FAILURE_ZEROED) && json(sanitizeLoadFailure(null)) === json(LOAD_FAILURE_ZEROED));
  check("sanitize: non-object input becomes zeroed", json(sanitizeLoadFailure("boom")) === json(LOAD_FAILURE_ZEROED) && json(sanitizeLoadFailure(42)) === json(LOAD_FAILURE_ZEROED));
  check("sanitize: a text error code becomes zeroed", json(sanitizeLoadFailure({ code: "-6", description: "E", address: "file:///a", isMainFrame: true })) === json(LOAD_FAILURE_ZEROED));
  check(
    "sanitize: non-finite codes become zeroed",
    json(sanitizeLoadFailure({ code: Number.NaN, description: "E", address: "file:///a", isMainFrame: true })) === json(LOAD_FAILURE_ZEROED) &&
      json(sanitizeLoadFailure({ code: Number.POSITIVE_INFINITY, description: "E", address: "file:///a", isMainFrame: true })) === json(LOAD_FAILURE_ZEROED),
  );
  check("sanitize: a wrong-typed description becomes zeroed", json(sanitizeLoadFailure({ code: -6, description: 6, address: "file:///a", isMainFrame: true })) === json(LOAD_FAILURE_ZEROED));
  check(
    "sanitize: a missing or empty address becomes zeroed",
    json(sanitizeLoadFailure({ code: -6, description: "E", isMainFrame: true })) === json(LOAD_FAILURE_ZEROED) &&
      json(sanitizeLoadFailure({ code: -6, description: "E", address: "", isMainFrame: true })) === json(LOAD_FAILURE_ZEROED),
  );
  const missingFrame = sanitizeLoadFailure({ code: -6, description: "ERR_FAILED", address: "https://localhost:5173" });
  check("sanitize: a missing frame field is treated as a secondary frame", missingFrame.ok === true && missingFrame.isMainFrame === false);
  const good = rec();
  check("sanitize: a valid main-frame failure passes through with the scheme only", good.ok === true && good.isMainFrame === true && good.scheme === "file" && good.code === -6);
  check(
    "sanitize: a schemeless or garbage address carries no scheme",
    sanitizeLoadFailure({ code: -6, description: "E", address: "C:\\Users\\x\\app", isMainFrame: true }).scheme === "" &&
      sanitizeLoadFailure({ code: -6, description: "E", address: "://broken", isMainFrame: true }).scheme === "",
  );
}

// --- loadFailVerdict ---------------------------------------------------------------
{
  const secondary = loadFailVerdict(rec(-6, "E", "file:///a", false), 99, now);
  check("verdict: a secondary frame always ignores and accumulates nothing", secondary.plan === "ignore" && secondary.count === 99);
  check("verdict: the zeroed record ignores (it is never a main frame)", loadFailVerdict(LOAD_FAILURE_ZEROED, 2, now).plan === "ignore");
  const aborted = loadFailVerdict(rec(CHROMIUM_ERR_ABORTED, "ERR_ABORTED"), LOAD_FAIL_MAX_ATTEMPTS + 5, now);
  check("verdict: rule order proven — abort and above-ceiling count at once still ignore", aborted.plan === "ignore" && aborted.count === LOAD_FAIL_MAX_ATTEMPTS + 5);
  const first = loadFailVerdict(rec(), 0, now);
  check(
    "verdict: the first failure retries, counts one and schedules the documented wait",
    first.plan === "retry" && first.count === 1 && first.waitMs === LOAD_FAIL_RETRY_DELAY_MS && first.retryAtMs === now + LOAD_FAIL_RETRY_DELAY_MS,
  );
  check(`verdict: a count exactly at the ceiling (${LOAD_FAIL_MAX_ATTEMPTS}) gives up with the warning`, loadFailVerdict(rec(), LOAD_FAIL_MAX_ATTEMPTS, now).plan === "giveup");
  check("verdict: a count above the ceiling gives up as well", loadFailVerdict(rec(), LOAD_FAIL_MAX_ATTEMPTS + 1, now).plan === "giveup");
  const walk: string[] = [];
  for (let done = 0; done <= LOAD_FAIL_MAX_ATTEMPTS; done++) walk.push(loadFailVerdict(rec(), done, now).plan);
  check("verdict: every count below the ceiling retries, only the ceiling gives up", walk.every((plan, i) => (i < LOAD_FAIL_MAX_ATTEMPTS ? plan === "retry" : plan === "giveup")));
  check("verdict: the returned count is never negative", loadFailVerdict(rec(), -4, now).count >= 0);
  check("verdict: stable between two calls with the same input", json(loadFailVerdict(rec(), 1, now)) === json(loadFailVerdict(rec(), 1, now)));
  check("verdict: every reason is path-free and scheme-free", [secondary.reason, aborted.reason, first.reason].every(noSlash));
}

// --- loadFailMessage -----------------------------------------------------------------
{
  const leaked = "file:///Users/caio/App/resources/index.html";
  const msg = loadFailMessage(rec(-6, "ERR_FILE_NOT_FOUND", leaked));
  check("message: the user phrase and the log line are non-empty", msg.user.length > 0 && msg.log.length > 0);
  check(
    "message: no absolute path, no full address and no secret in either phrase",
    [msg.user, msg.log].every(
      (phrase) => !phrase.includes(leaked) && !phrase.includes("file:///") && !phrase.includes("/Users") && !phrase.includes("index.html") && !phrase.includes("://"),
    ),
  );
  check("message: only the scheme may appear from the address", msg.log.includes("esquema file") && !msg.log.includes("file:"));
  const unknown = loadFailMessage(sanitizeLoadFailure({ code: -12, description: "E", address: "weird\\raw\\path", isMainFrame: true }));
  check("message: an unknown scheme degrades to a fixed word without leaking the address", unknown.log.includes("esquema desconhecido") && !unknown.log.includes("weird"));
  check("message: stable between two calls with the same input", json(msg) === json(loadFailMessage(rec(-6, "ERR_FILE_NOT_FOUND", leaked))));
}

// --- the real main.ts wiring -----------------------------------------------------------
{
  const src = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  check("wiring: exactly one did-fail-load listener", (src.match(/on\("did-fail-load"/g) ?? []).length === 1);
  const failAt = src.indexOf('win.webContents.on("did-fail-load"');
  const finishAt = src.indexOf('win.webContents.on("did-finish-load"');
  check("wiring: the listener is bound to the main window's webContents", failAt >= 0);
  check("wiring: the counter resets on every successful load", finishAt > failAt && src.slice(finishAt, finishAt + 200).includes("loadFailAttempts = 0"));
  check("wiring: the retry reloads through the same webContents.reload() path", src.slice(failAt, src.indexOf("loadUi(win)", failAt)).includes("win.webContents.reload()"));
  const lines = src.split("\n").filter((l) => l.includes("loadFail") || l.includes("load watch") || l.includes("did-fail-load"));
  check("wiring: no periodic timer in the load-fail lines", lines.every((l) => !l.includes("setInterval")));
}

console.log(failures === 0 ? "\nloadfail tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
