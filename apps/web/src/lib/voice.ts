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

/** Strip the parts of a markdown answer that read badly aloud: fenced code
 * blocks, inline code, markdown emphasis and link URLs. */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)[*_~#>]+/g, "$1");
}

/**
 * Pick the spoken brief of an answer: the first sentences up to maxChars,
 * cutting at a sentence boundary when there is one, else at a word boundary.
 */
export function speakBrief(text: string, maxChars = 280): string {
  const clean = stripForSpeech(text).replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]?/g) ?? [];
  let brief = "";
  for (const s of sentences) {
    const next = brief ? `${brief} ${s.trim()}` : s.trim();
    if (next.length > maxChars) break;
    brief = next;
  }
  if (brief) return brief;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
