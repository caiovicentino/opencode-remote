// P3-403 camera-ask v2 "Voz": device-side spoken answers for the session
// voice mode, built on the Web Speech API — synthesis happens on the phone
// itself, so the loop never pays a daemon round-trip (or a daemon mp3) to
// read an answer aloud. Structurally-typed shims keep the functions
// unit-testable: the battery injects a fake synth instead of a browser.

export interface UtteranceLike {
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

export interface SynthLike {
  speaking: boolean;
  pending: boolean;
  cancel(): void;
  speak(u: UtteranceLike): void;
}

function defaultSynth(): SynthLike | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  return window.speechSynthesis as unknown as SynthLike;
}

function defaultUtterance(text: string): UtteranceLike {
  return new SpeechSynthesisUtterance(text) as unknown as UtteranceLike;
}

/** True when this device can synthesize speech at all. Without it the
 * "responder em voz" toggle never appears (P3-403). */
export function deviceTtsAvailable(synth: SynthLike | null = defaultSynth()): boolean {
  return !!synth;
}

/**
 * Speak `text` on the device. Resolves true once playback started (ends or is
 * still speaking), false when the utterance never began. The false path is the
 * iOS-standalone contract: the very first speak() outside a user gesture is
 * silently dropped, so the answer card's play button is the reliable fallback.
 */
export function speakDevice(
  text: string,
  lang: string,
  deps?: {
    synth?: SynthLike | null;
    makeUtterance?: (t: string) => UtteranceLike;
    /** watchdog before the "never started" verdict; tests shrink it */
    startedMs?: number;
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    const synth = deps && "synth" in deps ? (deps.synth ?? null) : defaultSynth();
    const make = deps?.makeUtterance ?? defaultUtterance;
    if (!synth || !text.trim()) {
      resolve(false);
      return;
    }
    // one voice at a time: a queued tail behind a stale utterance would delay
    // the next answer by the whole previous one
    try {
      synth.cancel();
    } catch {}
    const u = make(text);
    u.lang = lang;
    let done = false;
    const finish = (started: boolean) => {
      if (done) return;
      done = true;
      resolve(started);
    };
    u.onend = () => finish(true);
    u.onerror = () => finish(false);
    synth.speak(u);
    // iOS standalone drops a gesture-less first speak with NO onend/onerror —
    // if nothing is audible shortly after the call, report "not started" and
    // let the play button take the gesture.
    setTimeout(() => finish(synth.speaking || synth.pending), deps?.startedMs ?? 1500);
  });
}

/** Stop any in-flight device speech (idempotent, safe without a synth). */
export function stopDeviceSpeech(synth: SynthLike | null = defaultSynth()): void {
  if (!synth) return;
  try {
    synth.cancel();
  } catch {}
}
