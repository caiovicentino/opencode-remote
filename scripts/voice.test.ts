/**
 * P2-125 unit tests: the spoken-brief helper for voice replies (pure logic
 * from apps/web/src/lib/voice.ts). The TTS binary itself is exercised on the
 * host — the daemon route is a thin spawn wrapper.
 * Run: npx tsx scripts/voice.test.ts
 */
import { speakBrief, stripForSpeech } from "../apps/web/src/lib/voice";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// short answer passes through untouched
check("short text passes through", speakBrief("Olá, tudo bem?") === "Olá, tudo bem?");

// whitespace collapses
check("whitespace collapses", speakBrief("linha 1\n\nlinha   2\t!") === "linha 1 linha 2 !");

// two short sentences both kept
check("two sentences kept", speakBrief("Primeira frase. Segunda frase.") === "Primeira frase. Segunda frase.");

// long text: cut at a sentence boundary within the budget
{
  const long = "Primeira frase curta. " + "palavra ".repeat(120) + "Fim.";
  const brief = speakBrief(long);
  check("long text is clipped to budget", brief.length <= 280, `len=${brief.length}`);
  check("long clip ends at sentence boundary", /[.!?:…]$/.test(brief), brief.slice(-30));
  check("long clip keeps the first sentence", brief.startsWith("Primeira frase curta."));
}

// dense single sentence: word-boundary cut with ellipsis
{
  const wall = "palavra ".repeat(100).trim();
  const brief = speakBrief(wall);
  check("no-boundary text cut at word edge with ellipsis", brief.endsWith("…") && brief.length <= 280);
}

// code blocks never get spoken
check(
  "fenced code is stripped",
  speakBrief("Veja:\n```\nconst x = 1;\n```\nPronto.") === "Veja: Pronto.",
);
check("inline code keeps its content", stripForSpeech("use `npm run build` logo") === "use npm run build logo");
check("link keeps the label", stripForSpeech("veja [docs](https://x.com) aí") === "veja docs aí");

// empty input stays empty
check("empty stays empty", speakBrief("   ") === "");

process.exit(failures ? 1 : 0);
