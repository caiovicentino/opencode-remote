/**
 * Bug 1 (silent crypto death) unit tests: the daemon's pure reauth module,
 * the client's framegate/reauth decisions, the storage-wipe scope, the i18n
 * keys and the source pins that keep the wiring honest.
 * Run: npx tsx scripts/reauth.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTH_FAILURE_LEDGER_CAP,
  AUTH_FAILURE_WINDOW_MS,
  AuthFailureLedger,
  classifyAuthFailure,
  deviceIdOf,
  keyExpiredVerdict,
  reauthControl,
  reauthReplyDecision,
  REAUTH_CONTROL_TYPE,
  REAUTH_REPLY_MIN_INTERVAL_MS,
} from "../apps/daemon/src/reauth";
import { classifyFrame, readClearControl, REAUTH_CLEAR_TYPE } from "../apps/web/src/lib/framegate";
import {
  identityStorageKeys,
  isIdentityStorageKey,
  reauthVerdict,
  REAUTH_ERROR,
  REAUTH_STRIKES,
} from "../apps/web/src/lib/reauth";
import { translate } from "../apps/web/src/lib/i18n";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

// --- wire type is shared by both sides ---------------------------------------
check("daemon and client agree on the control type", REAUTH_CONTROL_TYPE === REAUTH_CLEAR_TYPE);
check("control type is the documented literal", REAUTH_CONTROL_TYPE === "session-reauth-required");
check("REAUTH_ERROR mirrors the wire type (App matches the rejected connect)", REAUTH_ERROR === REAUTH_CONTROL_TYPE);

// --- daemon: pure module hygiene ------------------------------------------------
const daemonReauth = src("apps/daemon/src/reauth.ts");
check(
  "daemon reauth.ts is pure (no fs/http/crypto/ws/fetch imports or calls)",
  !/^import .*(node:fs|node:http|node:crypto|"ws")/m.test(daemonReauth) && !/\bfetch\(/.test(daemonReauth),
);

// --- daemon: device id + attribution ---------------------------------------------
const pubA = "A".repeat(40);
const pubB = "B".repeat(40);
check("deviceIdOf is the 16-char prefix, never the full key", deviceIdOf(pubA) === "A".repeat(16));
check("deviceIdOf null on empty/non-string", deviceIdOf("") === null && deviceIdOf(undefined) === null && deviceIdOf(42) === null);
check("classifyAuthFailure known-stale when the pub is allowlisted", classifyAuthFailure([pubA, pubB], pubA) === "known-stale");
check("classifyAuthFailure unknown when the pub is not allowlisted", classifyAuthFailure([pubA], pubB) === "unknown");
check("classifyAuthFailure unknown on a null pub", classifyAuthFailure([pubA], null) === "unknown");
check("classifyAuthFailure unknown on an empty allowlist", classifyAuthFailure([], pubA) === "unknown");

// --- daemon: control frame body ----------------------------------------------------
const ctl = reauthControl(pubA);
check("reauthControl carries the type + short deviceId", ctl.type === REAUTH_CONTROL_TYPE && ctl.deviceId === "A".repeat(16));
check("reauthControl deviceId null for an unknown sender", reauthControl(null).deviceId === null);
check("reauthControl never leaks the full key", !JSON.stringify(ctl).includes(pubA));

// --- daemon: per-sender throttle -----------------------------------------------------
const now = 1_000_000;
check("reply throttle: first reply always goes out", reauthReplyDecision(undefined, now, REAUTH_REPLY_MIN_INTERVAL_MS) === "reply");
check("reply throttle: suppress inside the interval", reauthReplyDecision(now - 1, now, REAUTH_REPLY_MIN_INTERVAL_MS) === "suppress");
check("reply throttle: reply exactly at the interval", reauthReplyDecision(now - REAUTH_REPLY_MIN_INTERVAL_MS, now, REAUTH_REPLY_MIN_INTERVAL_MS) === "reply");
check("reply throttle: NaN lastReplyAt counts as never", reauthReplyDecision(Number.NaN, now, 2000) === "reply");
let threw = false;
try {
  reauthReplyDecision(0, Number.NaN, 2000);
} catch {
  threw = true;
}
check("reply throttle: non-finite now is refused", threw);

// --- daemon: ledger + 24h verdict ----------------------------------------------------
const ledger = new AuthFailureLedger(3);
check("ledger: unknown pub has no failure", ledger.lastFailureAt(pubA) === undefined);
ledger.record(pubA, now);
check("ledger: records the stamp", ledger.lastFailureAt(pubA) === now);
ledger.record(pubA, now + 5);
check("ledger: re-record keeps the newest stamp", ledger.lastFailureAt(pubA) === now + 5 && ledger.size === 1);
ledger.record("c", now + 1);
ledger.record("d", now + 2);
ledger.record("e", now + 3);
check("ledger: bounded — oldest (by insertion) evicts at the cap", ledger.size === 3 && ledger.lastFailureAt(pubA) === undefined);
ledger.record("", now);
check("ledger: ignores an empty pub", ledger.size === 3);
check("ledger default cap is 256", AUTH_FAILURE_LEDGER_CAP === 256);
check("AUTH_FAILURE_WINDOW_MS is 24h", AUTH_FAILURE_WINDOW_MS === 86_400_000);

check("keyExpiredVerdict: no failure → not expired, no extra fields", JSON.stringify(keyExpiredVerdict(undefined, now, AUTH_FAILURE_WINDOW_MS)) === JSON.stringify({ keyExpired: false }));
const fresh = keyExpiredVerdict(now - 60_000, now, AUTH_FAILURE_WINDOW_MS);
check("keyExpiredVerdict: failure inside the window → expired + stamp + phrase", fresh.keyExpired && fresh.authFailedAt === new Date(now - 60_000).toISOString() && !!fresh.keyPhrase);
check("keyExpiredVerdict: phrase is the pt-BR hint without key/label/secret", /Chave expirada/.test(fresh.keyPhrase ?? "") && !/[A-Za-z0-9+/]{20,}/.test(fresh.keyPhrase ?? ""));
check("keyExpiredVerdict: exactly at the window is still expired", keyExpiredVerdict(now - AUTH_FAILURE_WINDOW_MS, now, AUTH_FAILURE_WINDOW_MS).keyExpired);
check("keyExpiredVerdict: strictly above the window → not expired", !keyExpiredVerdict(now - AUTH_FAILURE_WINDOW_MS - 1, now, AUTH_FAILURE_WINDOW_MS).keyExpired);
check("keyExpiredVerdict: future stamp counts as just-now (clock ahead)", keyExpiredVerdict(now + 3_600_000, now, AUTH_FAILURE_WINDOW_MS).keyExpired);
threw = false;
try {
  keyExpiredVerdict(now, Number.NaN, AUTH_FAILURE_WINDOW_MS);
} catch {
  threw = true;
}
check("keyExpiredVerdict: non-finite now is refused", threw);

// --- daemon: wiring pins on index.ts ------------------------------------------------
const daemonIndex = src("apps/daemon/src/index.ts");
const undecryptableAt = daemonIndex.indexOf('"undecryptable frame (auth failure)"');
check("daemon still logs the auth-failure line", undecryptableAt > -1);
const undecryptableBlock = daemonIndex.slice(undecryptableAt - 600, undecryptableAt + 600);
check("undecryptable frame answers with the reauth control", undecryptableBlock.includes("sendReauthRequired(ws, frame.from, session.pub)"));
check("undecryptable frame records the ledger", undecryptableBlock.includes("authFailures.record(session.pub"));
const handshakeFailAt = daemonIndex.indexOf('"handshake failed"');
const handshakeBlock = daemonIndex.slice(handshakeFailAt - 900, handshakeFailAt + 500);
check("refused hello answers with the reauth control", handshakeBlock.includes("sendReauthRequired(ws, frame.from"));
check("refused hello only stamps a KNOWN device", handshakeBlock.includes('kind === "known-stale") authFailures.record(helloPub'));
check("both devices routes carry the additive key verdict", (daemonIndex.match(/\.\.\.keyExpiredVerdict\(authFailures\.lastFailureAt\(client\.pub\), now, AUTH_FAILURE_WINDOW_MS\)/g) ?? []).length === 2);
check("reauth reply is a clear frame from the daemon room", /reauthControl\(pub\)/.test(daemonIndex) && daemonIndex.includes("from: daemon.room,\n      payload: b64(Buffer.from(JSON.stringify(reauthControl(pub))))"));
check("replay-rejected frames are NOT auth failures", !daemonIndex.slice(daemonIndex.indexOf('"replay rejected"'), undecryptableAt).includes("sendReauthRequired"));

// --- client: framegate --------------------------------------------------------------
const gateFrame = { from: "roomx", self: "client1", room: "roomx", clearType: null as string | null, status: "paired" };
check("readClearControl reads the reauth control", readClearControl({ type: REAUTH_CLEAR_TYPE }) === REAUTH_CLEAR_TYPE);
check("readClearControl still tolerates junk", readClearControl({ type: "session-reauth" }) === null);
check("classifyFrame routes a paired reauth to reauth", classifyFrame({ ...gateFrame, clearType: REAUTH_CLEAR_TYPE }) === "reauth");
check("classifyFrame routes a connecting reauth to reauth (hello refused)", classifyFrame({ ...gateFrame, status: "connecting", clearType: REAUTH_CLEAR_TYPE }) === "reauth");
check("classifyFrame ignores a reauth from outside the daemon room", classifyFrame({ ...gateFrame, from: "attacker", clearType: REAUTH_CLEAR_TYPE }) === "ignore");
check("classifyFrame ignores a self-sourced reauth", classifyFrame({ ...gateFrame, from: "client1", clearType: REAUTH_CLEAR_TYPE }) === "ignore");
check("classifyFrame: reconnect while connecting is still confirm (unchanged)", classifyFrame({ ...gateFrame, status: "connecting", clearType: "reconnect" }) === "confirm");

// --- client: reauth verdict -------------------------------------------------------------
check("REAUTH_STRIKES is 2", REAUTH_STRIKES === 2);
check("paired → verify (never wipe, never rehandshake directly)", reauthVerdict("paired", 0, true) === "verify");
check("paired ignores the strike count", reauthVerdict("paired", 5, false) === "verify");
check("connecting after hello, first strike → retry", reauthVerdict("connecting", 0, true) === "retry");
check("connecting after hello, second strike → expired", reauthVerdict("connecting", 1, true) === "expired");
check("connecting before any hello → ignore", reauthVerdict("connecting", 1, false) === "ignore");
check("closed/rejected/expired → ignore", ["closed", "rejected", "expired"].every((s) => reauthVerdict(s, 1, true) === "ignore"));

// --- client: wipe scope -------------------------------------------------------------------
const keys = [
  "ocr.pairings.v2",
  "ocr.active.room",
  "ocr.pairing.v2",
  "ocr.archived",
  "ocr.permission.auto",
  "ocr_unread",
  "ocr_daemon_seen",
  "ocr_welcome_done",
  "ocr_lang",
  "ocr_theme",
  "ocr_font",
  "ocr_model",
  "ocr_agent",
  "ocr_voice",
  "ocr-tts-on",
  "someOtherApp",
];
const wiped = identityStorageKeys(keys);
check("wipe removes every dotted ocr.* pairing key", ["ocr.pairings.v2", "ocr.active.room", "ocr.pairing.v2", "ocr.archived", "ocr.permission.auto"].every((k) => wiped.includes(k)));
check("wipe removes the pairing-bound flat flags", ["ocr_unread", "ocr_daemon_seen", "ocr_welcome_done"].every((k) => wiped.includes(k)));
check("wipe KEEPS personal preferences (lang/theme/font/model/agent/voice/tts)", ["ocr_lang", "ocr_theme", "ocr_font", "ocr_model", "ocr_agent", "ocr_voice", "ocr-tts-on"].every((k) => !wiped.includes(k)));
check("wipe never touches keys of other apps", !wiped.includes("someOtherApp") && !isIdentityStorageKey("foo"));
check("wipe preserves input order", wiped.join(",") === "ocr.pairings.v2,ocr.active.room,ocr.pairing.v2,ocr.archived,ocr.permission.auto,ocr_unread,ocr_daemon_seen,ocr_welcome_done");

// --- client: source pins on client.ts -------------------------------------------------------
const clientSource = src("apps/web/src/lib/client.ts");
check("Status carries the terminal expired state", clientSource.includes('| "expired"'));
check("client.ts still calls rehandshake() from exactly one place", (clientSource.match(/this\.rehandshake\(\)/g) ?? []).length === 1);
check("reauth path never calls rehandshake directly (verify → hint timer)", /action === "verify"\) \{\s*this\.verifyHint\(\);/.test(clientSource));
check("expire() rejects pending ops with REAUTH_ERROR and stops reconnects", /private expire\(\)[\s\S]*intentionalClose = true[\s\S]*p\.reject\(new Error\(REAUTH_ERROR\)\)[\s\S]*setStatus\("expired"\)/.test(clientSource));
check("a confirmed handshake resets the strikes", /if \(s === "paired"\) \{[\s\S]{0,200}this\.reauthStrikes = 0;/.test(clientSource));
check("every dial marks helloSent (initial local, initial relay, reconnect)", (clientSource.match(/helloSent = true/g) ?? []).length === 3);
check("wipeLocalIdentity deletes the identity database", /wipeLocalIdentity[\s\S]*indexedDB\.deleteDatabase\(IDB_NAME\)/.test(clientSource));
check("wipeLocalIdentity uses the pure key filter", /wipeLocalIdentity[\s\S]*identityStorageKeys\(Object\.keys\(localStorage\)\)/.test(clientSource));

// --- App + desktop wiring pins --------------------------------------------------------------
const appSource = src("apps/web/src/App.tsx");
check("App renders the expired card before every other surface", appSource.indexOf("if (expired) {") < appSource.indexOf("if (showWelcome) {"));
check("App's pair-again wipes THEN re-enters the pairing flow", /async function pairAgain\(\)[\s\S]*await wipeLocalIdentity\(\);[\s\S]*setPhase\("unpaired"\);[\s\S]*tryAutoPair\(\);/.test(appSource));
check("App flips expired on the status callback and on the rejected connect", appSource.includes('if (s === "expired") setExpired(true);') && appSource.includes("if (message === REAUTH_ERROR) {"));
const mainSource = src("apps/desktop/src/main.ts");
check("desktop forwards keyExpired per device", mainSource.includes("keyExpired: d.keyExpired === true"));
const overlaySource = src("apps/web/src/components/PairingOverlay.tsx");
check("desktop Celular pane renders the key-expired hint through t()", overlaySource.includes('t("pairDeviceKeyExpired")'));

// --- i18n: every key resolves per locale, no emoji, pt-BR reads Portuguese ----------------
const keysI18n = ["reauthTitle", "reauthBody", "reauthAction", "pairDeviceKeyExpired"];
for (const lang of ["en", "pt"] as const) {
  check(`i18n ${lang}: reauth keys resolve (no raw-key fallback)`, keysI18n.every((k) => translate(lang, k) !== k && translate(lang, k).trim() !== ""));
}
check("pt: expired card reads Portuguese", translate("pt", "reauthTitle") === "Conexão expirada" && translate("pt", "reauthAction") === "Parear novamente");
check("pt: device hint is the operator's phrase", translate("pt", "pairDeviceKeyExpired") === "chave expirada — pareie de novo");
check("en: expired card reads English", translate("en", "reauthTitle") === "Connection expired" && translate("en", "reauthAction") === "Pair again");
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{2500}-\u{25FF}\u{FE0F}]/u;
check("reauth copy has no emoji", (["en", "pt"] as const).every((l) => keysI18n.every((k) => !EMOJI.test(translate(l, k)))));

// --- CSS: the card and its motion respect reduced motion --------------------------------------
const css = src("apps/web/src/index.css");
check("reauth card animates only outside reduced motion", css.includes(".reauth-card {") && /prefers-reduced-motion: reduce\)[\s\S]*\.reauth-card/.test(css));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall reauth checks passed");
