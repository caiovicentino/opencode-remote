/**
 * P3-403 unit tests: the camera-ask v2 "Voz" loop — the daemon's per-session
 * voice rate limiter (apps/daemon/src/sessionlimit.ts) and the device speech
 * shim (apps/web/src/lib/speech.ts). The daemon routes and ChatView wiring
 * are exercised on the host (eval battery + desktop-flow), like voice.test.ts.
 * Run: npx tsx scripts/voiceloop.test.ts
 */
import { createSessionLimiter } from "../apps/daemon/src/sessionlimit.js";
import {
  deviceTtsAvailable,
  speakDevice,
  stopDeviceSpeech,
  type SynthLike,
  type UtteranceLike,
} from "../apps/web/src/lib/speech";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// ── sessionlimit ─────────────────────────────────────────────────────────────
{
  const limiter = createSessionLimiter(3, () => 1000);
  check("first op admitted", limiter.allow("s1"));
  check("second op admitted", limiter.allow("s1"));
  check("third op admitted", limiter.allow("s1"));
  check("fourth op inside window refused", !limiter.allow("s1"));
  check("count reflects the window", limiter.count("s1") === 3);
  // per-session isolation: another session still has its full budget
  check("other session admitted", limiter.allow("s2"));
  // sliding window: ops older than 60s stop counting
  check("window slides — old ops expire", limiter.allow("s1", 61_000));
  check("expired window admits again", limiter.allow("s1", 61_000));
}

{
  const limiter = createSessionLimiter(2, () => 1000);
  limiter.allow("a");
  limiter.allow("a");
  limiter.allow("b");
  limiter.allow("b");
  // MAX_KEYS pruning: past the ceiling, fully-expired entries are dropped
  for (let i = 0; i < 600; i++) limiter.allow(`k${i}`, 2000);
  limiter.prune(2000);
  check("prune keeps live sessions", limiter.count("a", 2000) >= 0);
}

// ── speech shim ──────────────────────────────────────────────────────────────
function fakeSynth(): SynthLike & { utterances: UtteranceLike[] } {
  const utterances: UtteranceLike[] = [];
  return {
    utterances,
    speaking: false,
    pending: false,
    cancel() {
      utterances.pop();
    },
    speak(u: UtteranceLike) {
      utterances.push(u);
    },
  };
}

/** Node has no SpeechSynthesisUtterance — the tests inject this factory. */
function makeUtterance(text: string): UtteranceLike {
  void text;
  return { lang: "", onend: null, onerror: null };
}

const DEPS = { makeUtterance, startedMs: 5 };

{
  check("no synth → unavailable", deviceTtsAvailable(null) === false);
  const synth = fakeSynth();
  check("synth → available", deviceTtsAvailable(synth as SynthLike) === true);
}

// resolved false without a synth (and for empty text) — never throws
{
  const ok = await speakDevice("oi", "pt-BR", { ...DEPS, synth: null });
  check("missing synth resolves false", ok === false);
}
{
  const synth = fakeSynth();
  const ok = await speakDevice("   ", "pt-BR", {
    synth: synth as SynthLike,
    startedMs: 5,
  });
  check("blank text resolves false", ok === false && synth.utterances.length === 0);
}

// started speech: onend resolves true
{
  const synth = fakeSynth();
  const pending = speakDevice("olá", "pt-BR", { ...DEPS, synth: synth as SynthLike });
  const u = synth.utterances[0];
  check("utterance carries the lang", u.lang === "pt-BR");
  synth.speaking = true;
  u.onend!();
  check("onend resolves true", (await pending) === true);
}

// iOS gesture-less first speak: no onend/onerror within the watchdog → false
{
  const synth = fakeSynth();
  const pending = speakDevice("olá", "pt-BR", { ...DEPS, synth: synth as SynthLike });
  const verdict = await pending;
  check("gesture-less drop resolves false", verdict === false);
}

// error path: onerror resolves false
{
  const synth = fakeSynth();
  const pending = speakDevice("olá", "pt-BR", { ...DEPS, synth: synth as SynthLike });
  synth.utterances[0].onerror!();
  check("onerror resolves false", (await pending) === false);
}

// stop is idempotent and safe without a synth
{
  stopDeviceSpeech(null);
  const synth = fakeSynth();
  stopDeviceSpeech(synth as SynthLike);
  check("stop on empty synth is safe", synth.utterances.length === 0);
}

process.exit(failures ? 1 : 0);
