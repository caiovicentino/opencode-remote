// P2-125 voice replies: the spoken version of an assistant answer must be
// brief — at most a couple of sentences, and only slightly more when the
// answer is dense. The full text always stays visible in the chat.

/** Voice languages the daemon can speak (mirrors daemon spoken.ts). */
export const TTS_LANGS = ["pt-BR", "en-US", "es-ES"] as const;
export type TtsLang = (typeof TTS_LANGS)[number];
const TTS_LANG_KEY = "ocr-tts-lang";

export function getTtsLang(): TtsLang {
  try {
    const v = localStorage.getItem(TTS_LANG_KEY);
    return (TTS_LANGS as readonly string[]).includes(v ?? "") ? (v as TtsLang) : "pt-BR";
  } catch {
    return "pt-BR";
  }
}

export function setTtsLang(lang: TtsLang): void {
  try {
    localStorage.setItem(TTS_LANG_KEY, lang);
  } catch {}
}

// Speech-brief selection moved to @ocr/protocol so the daemon warms its mp3
// cache with the exact same brief the client asks for (latency: P2-125 follow-up).
export { stripForSpeech, speakBrief } from "@ocr/protocol";
