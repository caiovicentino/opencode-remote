// Spoken-brief selection shared by the PWA (client sends only the brief to
// /__ocr/voice/tts) and the daemon (session.idle pre-warms the mp3 cache with
// the same function — both sides must produce byte-identical briefs or the
// cache would never hit).

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
