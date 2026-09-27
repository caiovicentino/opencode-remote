/**
 * packages/protocol crypto battery — eval 14 (protocol & crypto review).
 *
 * 1. RT-390 follow-up: the hello nonce is the daemon's replay-dedupe key
 *    (apps/daemon/src/helloguard.ts keys HelloSeen on the RAW nonce string).
 *    `fromB64` tolerates base64url/whitespace/missing padding and `atob`
 *    drops non-zero trailing bits, so the same salt had many spellings: a
 *    recorded hello re-sent with its nonce re-spelled derived the SAME
 *    session key and passed the dedupe as a "new" nonce — the session came
 *    back with lastSeq = 0 and the recorded op frames re-opened. serverAccept
 *    now admits only the canonical spelling (helloNonce).
 * 2. Property/fuzz checks (seeded, reproducible) for the frame metadata and
 *    the AAD: frameSeq, seqAad injectivity and domain separation from the
 *    handshake labels, seal/openSealed tamper resistance, direction binding,
 *    handshake label separation, and a mutation fuzz of serverAccept.
 *
 * Seed: OCR_FUZZ_SEED=<uint32> reproduces a run (printed at start).
 * Run: npx tsx scripts/protocol-crypto.test.ts
 */
import {
  acceptPayload,
  b64,
  clientHello,
  frameSeq,
  fromB64,
  helloNonce,
  HELLO_NONCE_BYTES,
  newIdentity,
  openSealed,
  rejectPayload,
  seal,
  seqAad,
  serverAccept,
  type DaemonHello,
} from "@ocr/protocol";
import { HelloSeen, helloFreshness, helloVerdict } from "../apps/daemon/src/helloguard";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// mulberry32 — tiny deterministic PRNG so every fuzz run is reproducible
const seed = Number(process.env.OCR_FUZZ_SEED ?? Date.now() % 2 ** 32) >>> 0;
console.log(`seed: ${seed} (OCR_FUZZ_SEED=${seed} reproduces this run)`);
let state = seed;
function rand(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (n: number) => Math.floor(rand() * n);
const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)]!;
const bytes = (n: number) => Uint8Array.from({ length: n }, () => int(256));
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const daemon = await newIdentity(true);
const client = await newIdentity(false);

// --- 1. RT-390 follow-up: one spelling per hello nonce ------------------------

/** Every re-spelling of `nonce` that the tolerant decoder maps to the same salt. */
function respellings(nonce: string): string[] {
  const out = new Set<string>();
  out.add(nonce.replace(/=+$/, "")); // padding stripped
  out.add(nonce.replace(/=$/, "")); // half the padding
  out.add(`${nonce} `);
  out.add(` ${nonce}`);
  out.add(`${nonce}\n`);
  for (const ws of [" ", "\n", "\t", "\r"]) {
    const at = 1 + int(nonce.length - 2);
    out.add(nonce.slice(0, at) + ws + nonce.slice(at));
  }
  out.add(nonce.replace(/\+/g, "-").replace(/\//g, "_")); // base64url alphabet
  // non-canonical trailing bits: 16 bytes = 21 full chars + one char carrying
  // 2 data bits; the other 3 characters sharing those 2 bits decode the same
  const last = B64.indexOf(nonce[21]!);
  for (let low = 0; low < 16; low++) {
    const alt = B64[(last & 0b110000) | low]!;
    if (alt !== nonce[21]) out.add(`${nonce.slice(0, 21)}${alt}==`);
  }
  out.delete(nonce);
  return [...out];
}

// canonical nonces from clientHello are always admitted
{
  let ok = true;
  for (let i = 0; i < 64; i++) {
    const { hello } = await clientHello(daemon.publicKey, client);
    const salt = helloNonce(hello.nonce);
    if (!salt || salt.length !== HELLO_NONCE_BYTES || b64(salt) !== hello.nonce) ok = false;
  }
  check("helloNonce: every clientHello nonce is canonical and admitted (64 hellos)", ok);
}

// a hello whose nonce contains + and / so the base64url spelling differs
async function helloWithUrlChars(): Promise<{ hello: DaemonHello; sessionKey: CryptoKey }> {
  for (;;) {
    const h = await clientHello(daemon.publicKey, client);
    if (/[+/]/.test(h.hello.nonce)) return h;
  }
}
const victim = await helloWithUrlChars();
const variants = respellings(victim.hello.nonce);
check("respellings: the attack class is real (≥ 20 spellings)", variants.length >= 20, `${variants.length}`);
{
  const salt = fromB64(victim.hello.nonce);
  const same = variants.filter((v) => {
    try {
      return hex(fromB64(v)) === hex(salt);
    } catch {
      return false;
    }
  });
  check(
    "respellings: the tolerant decoder maps every spelling to the SAME salt",
    same.length === variants.length,
    `${same.length}/${variants.length}`,
  );
  check("helloNonce: every re-spelling refused", variants.every((v) => helloNonce(v) === null));
}

// serverAccept: the original hello is accepted, every re-spelled replay refused
{
  const original = await serverAccept(victim.hello, daemon);
  check("serverAccept: original hello accepted", original !== null && original.clientPub === client.publicKey);
  const frame = await seal({ type: "op", req: { id: "x" } }, victim.sessionKey, seqAad("victim", 1));
  check(
    "serverAccept: accepted key opens the client's sealed frame",
    original !== null && (await openSealed(frame, original.sessionKey, seqAad("victim", 1))) !== null,
  );
  let refused = 0;
  for (const v of variants) {
    if ((await serverAccept({ ...victim.hello, nonce: v }, daemon)) === null) refused++;
  }
  check(
    "serverAccept: every re-spelled nonce refused (replay can no longer re-derive the key)",
    refused === variants.length,
    `${refused}/${variants.length}`,
  );
}

// composition with the daemon's real dedupe (pure helloguard module)
{
  const seen = new HelloSeen();
  const now = 1_800_000_000_000;
  const { hello } = await clientHello(daemon.publicKey, client, now);
  const verdictOf = async (h: DaemonHello, at: number) => {
    const accepted = await serverAccept(h, daemon);
    if (!accepted) return "refused-by-serverAccept";
    return helloVerdict(helloFreshness(accepted.ts, at), () => seen.admit(h.nonce, at));
  };
  check("dedupe: first hello accepted", (await verdictOf(hello, now)) === "accept");
  check("dedupe: identical replay refused", (await verdictOf(hello, now + 1000)) === "replay");
  const replays = await Promise.all(respellings(hello.nonce).map((n) => verdictOf({ ...hello, nonce: n }, now + 2000)));
  check(
    "dedupe: no re-spelled replay ever reaches accept",
    replays.every((v) => v !== "accept"),
    replays.filter((v) => v === "accept").length + " accepted",
  );
}

// wrong shapes and lengths
{
  const salt12 = b64(bytes(12));
  const salt32 = b64(bytes(32));
  const bad: unknown[] = ["", salt12, salt32, "A".repeat(24), "@".repeat(24), 16, null, undefined, {}, [], true];
  check("helloNonce: wrong lengths/types refused", bad.every((v) => helloNonce(v) === null));
}

// --- 2. frameSeq / seqAad properties -----------------------------------------

{
  const samples: unknown[] = [
    undefined, null, 0, 1, 2 ** 53 - 1, 2 ** 53, -1, 1.5, NaN, Infinity, -Infinity, "1", "0", true, false, {}, [], [1], 1n,
  ];
  for (let i = 0; i < 2000; i++) {
    samples.push(
      pick([
        () => int(2 ** 31),
        () => rand() * 2 ** 60,
        () => -int(1000),
        () => int(1000) + rand(),
        () => String(int(1000)),
        () => ({ seq: int(10) }),
      ])(),
    );
  }
  let ok = true;
  let detail = "";
  for (const s of samples) {
    const r = frameSeq(s);
    const expected =
      s === undefined || s === null ? 0 : typeof s === "number" && Number.isSafeInteger(s) && s >= 0 ? s : null;
    if (r !== expected) {
      ok = false;
      detail = `frameSeq(${String(s)}) = ${r}, expected ${expected}`;
      break;
    }
    // seqAad never accepts what frameSeq refuses
    if (typeof s === "number" && expected === null) {
      let threw = false;
      try {
        seqAad("x", s);
      } catch (e) {
        threw = e instanceof RangeError;
      }
      if (!threw) {
        ok = false;
        detail = `seqAad accepted seq=${s}`;
        break;
      }
    }
  }
  check(`frameSeq/seqAad: fail-closed on ${samples.length} fuzzed values`, ok, detail);
}

{
  // injectivity: short alphabets force many same-length/near-collision pairs
  const seen = new Map<string, string>();
  let collision = "";
  const froms = ["", "a", "b", "ab", "ba", "a\u0000", "\u0000a", "room", "é", "é"];
  for (let i = 0; i < 5000 && !collision; i++) {
    const from = rand() < 0.5 ? pick(froms) : Array.from({ length: int(4) }, () => pick(["a", "b", "\u0000"])).join("");
    const seq = pick([0, 1, 255, 256, 65535, 65536, 2 ** 32, 2 ** 53 - 1, int(2 ** 20)]);
    const key = hex(seqAad(from, seq));
    const id = JSON.stringify([from, seq]);
    const prev = seen.get(key);
    if (prev !== undefined && prev !== id) collision = `${prev} vs ${id}`;
    seen.set(key, id);
  }
  check("seqAad: injective over 5000 fuzzed (from, seq) pairs", collision === "", collision);
}

{
  // domain separation: a data-frame AAD ends in an 8-byte seq < 2^53, so its
  // first seq byte is 0x00 — none of the handshake labels can be spelled as
  // seqAad(from, validSeq) for ANY from.
  const labels = ["ocr-hello", "ocr-confirm", "ocr-reject"];
  const verdicts = labels.map((label) => {
    const raw = new TextEncoder().encode(label);
    if (raw.length < 8) return true;
    const seq = new DataView(raw.buffer, raw.length - 8, 8).getBigUint64(0);
    return seq > BigInt(Number.MAX_SAFE_INTEGER);
  });
  check("seqAad: can never collide with the hello/confirm/reject AAD labels", verdicts.every(Boolean));
}

// --- 3. seal/openSealed properties -------------------------------------------

const { sessionKey: key } = await clientHello(daemon.publicKey, client);
const { sessionKey: otherKey } = await clientHello(daemon.publicKey, client);

function randomJson(depth = 0): unknown {
  const kind = int(depth > 2 ? 4 : 6);
  if (kind === 0) return int(1e6);
  if (kind === 1) return String.fromCharCode(...Array.from({ length: int(12) }, () => 32 + int(0x2000)));
  if (kind === 2) return rand() < 0.5;
  if (kind === 3) return null;
  if (kind === 4) return Array.from({ length: int(4) }, () => randomJson(depth + 1));
  return Object.fromEntries(Array.from({ length: int(4) }, (_, i) => [`k${i}`, randomJson(depth + 1)]));
}

{
  let roundTrip = true;
  let tamper = true;
  let wrongContext = true;
  let detail = "";
  for (let i = 0; i < 60; i++) {
    const obj = randomJson();
    const from = pick(["room", "client1", "a"]);
    const seq = 1 + int(1000);
    const payload = await seal(obj, key, seqAad(from, seq));
    const back = await openSealed(payload, key, seqAad(from, seq));
    if (JSON.stringify(back) !== JSON.stringify(obj)) {
      roundTrip = false;
      detail = JSON.stringify(obj).slice(0, 80);
    }
    // flip one random bit anywhere in nonce || ciphertext || tag
    const raw = fromB64(payload);
    const at = int(raw.length);
    raw[at] = raw[at]! ^ (1 << int(8));
    if ((await openSealed(b64(raw), key, seqAad(from, seq))) !== null) tamper = false;
    // same payload, any other context: seq±1, other sender, other key, no AAD
    const others = [
      await openSealed(payload, key, seqAad(from, seq + 1)),
      await openSealed(payload, key, seqAad(from, seq - 1)),
      await openSealed(payload, key, seqAad(`${from}x`, seq)),
      await openSealed(payload, otherKey, seqAad(from, seq)),
      await openSealed(payload, key),
    ];
    if (others.some((o) => o !== null)) wrongContext = false;
  }
  check("seal/open: round-trips 60 fuzzed JSON values", roundTrip, detail);
  check("seal/open: any flipped bit is refused", tamper);
  check("seal/open: refused under any other (seq, from, key, AAD) context", wrongContext);
}

{
  // garbage never throws, always null
  let ok = true;
  for (let i = 0; i < 300; i++) {
    const g = pick([
      () => "",
      () => "%%%",
      () => b64(bytes(int(28))), // shorter than nonce + tag
      () => b64(bytes(28 + int(64))),
      () => Array.from({ length: int(40) }, () => String.fromCharCode(int(128))).join(""),
    ])();
    try {
      if ((await openSealed(g, key, seqAad("room", 1))) !== null) ok = false;
    } catch {
      ok = false;
    }
  }
  check("openSealed: 300 garbage payloads → null, never a throw", ok);
}

{
  // direction binding: both directions share the session key; the AAD sender
  // id (client `from` vs daemon room) is what keeps a reflected frame closed
  const up = await seal({ type: "op", req: { id: "r" } }, key, seqAad("client1", 7));
  const down = await seal({ type: "pong" }, key, seqAad("room", 7));
  check(
    "direction: a client frame reflected as a daemon frame (and back) never opens",
    (await openSealed(up, key, seqAad("room", 7))) === null &&
      (await openSealed(down, key, seqAad("client1", 7))) === null,
  );
}

{
  // IV freshness smoke: random 96-bit nonces never repeat in practice
  const ivs = new Set<string>();
  for (let i = 0; i < 4000; i++) ivs.add(hex(fromB64(await seal(i, key)).slice(0, 12)));
  check("seal: 4000 seals → 4000 distinct IVs", ivs.size === 4000, `${ivs.size}`);
}

// --- 4. handshake label separation -------------------------------------------

{
  const { hello, sessionKey } = await clientHello(daemon.publicKey, client);
  const accepted = await serverAccept(hello, daemon);
  const confirm = await acceptPayload(accepted!.sessionKey, { transcribe: true });
  const reject = await rejectPayload(accepted!.sessionKey, "not-allowed");
  const te = new TextEncoder();
  check(
    "labels: the hello token never opens as a confirm/reject (reflection)",
    (await openSealed(hello.token, sessionKey, te.encode("ocr-confirm"))) === null &&
      (await openSealed(hello.token, sessionKey, te.encode("ocr-reject"))) === null,
  );
  check(
    "labels: a confirm never opens as a hello token or a reject",
    (await openSealed(confirm.confirm, sessionKey, te.encode("ocr-hello"))) === null &&
      (await openSealed(confirm.confirm, sessionKey, te.encode("ocr-reject"))) === null,
  );
  check(
    "labels: confirm/reject open only under their own label",
    (await openSealed<{ ok: boolean }>(confirm.confirm, sessionKey, te.encode("ocr-confirm")))?.ok === true &&
      (await openSealed<{ reason: string }>(reject.reject, sessionKey, te.encode("ocr-reject")))?.reason === "not-allowed",
  );
  const next = await clientHello(daemon.publicKey, client);
  check(
    "labels: a confirm from an earlier handshake never opens under a new session key",
    (await openSealed(confirm.confirm, next.sessionKey, te.encode("ocr-confirm"))) === null,
  );
  const stranger = await newIdentity(true);
  check("serverAccept: a hello for another daemon identity is refused", (await serverAccept(hello, stranger)) === null);
  check(
    "serverAccept: swapping the clear clientPub is refused",
    (await serverAccept({ ...hello, clientPub: stranger.publicKey }, daemon)) === null,
  );
}

// --- 5. serverAccept mutation fuzz --------------------------------------------

{
  const { hello } = await clientHello(daemon.publicKey, client);
  const fields = ["clientPub", "nonce", "token"] as const;
  let threw = "";
  // The only admissible mutation is one that keeps the exact dedupe key
  // (nonce) and the token-bound clientPub — e.g. whitespace inside the token,
  // which the tolerant decoder strips. Such a hello is still the SAME nonce
  // string, so the daemon's dedupe refuses it as a replay.
  let admittedWithNewKey = 0;
  for (let i = 0; i < 200 && !threw; i++) {
    const h: Record<string, unknown> = { ...hello };
    const f = pick(fields);
    const original = hello[f];
    h[f] = pick([
      () => undefined,
      () => null,
      () => 42,
      () => [original],
      () => ({ v: original }),
      () => original.slice(0, int(original.length)),
      () => original + pick(["=", "A", " ", "\n", "-"]),
      () => original.replace(/./, (c) => (c === "A" ? "B" : "A")),
      () => b64(bytes(int(64))),
    ])();
    try {
      const r = await serverAccept(h as unknown as DaemonHello, daemon);
      if (r !== null && (h.nonce !== hello.nonce || h.clientPub !== hello.clientPub)) admittedWithNewKey++;
    } catch (e) {
      threw = `${f}: ${(e as Error).message}`;
    }
  }
  check("serverAccept: 200 mutated hellos never throw", threw === "", threw);
  check(
    "serverAccept: no mutated hello is admitted under a different dedupe key",
    admittedWithNewKey === 0,
    `${admittedWithNewKey} admitted`,
  );
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall protocol-crypto checks passed");
