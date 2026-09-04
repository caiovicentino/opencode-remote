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

// ─── spoken-number normalization (apps/daemon/src/spoken.ts) ───────────────
import { normalizeLang, numberWords, spokenNumbers } from "../apps/daemon/src/spoken";
import { resolveVoice } from "../apps/daemon/src/edgetts";

// pt-BR core readings
check("pt ratio", spokenNumbers("Temos 45/200 tarefas.", "pt-BR") === "Temos quarenta e cinco de duzentos tarefas.", spokenNumbers("45/200", "pt-BR"));
check("pt percent", spokenNumbers("98% de sucesso", "pt-BR") === "noventa e oito por cento de sucesso", spokenNumbers("98%", "pt-BR"));
check("pt percent decimal", spokenNumbers("aceitação 3.2%", "pt-BR") === "aceitação três vírgula dois por cento", spokenNumbers("3.2%", "pt-BR"));
check("pt clock", spokenNumbers("às 15:10", "pt-BR") === "às quinze e dez", spokenNumbers("15:10", "pt-BR"));
check("pt duration clock", spokenNumbers("levou 42:31", "pt-BR") === "levou quarenta e dois, trinta e um", spokenNumbers("42:31", "pt-BR"));
check("pt task id", spokenNumbers("P2-153 mergeada", "pt-BR") === "P dois, cento e cinquenta e três mergeada", spokenNumbers("P2-153", "pt-BR"));
check("pt thousands", spokenNumbers("1.234 arquivos", "pt-BR") === "mil duzentos e trinta e quatro arquivos", spokenNumbers("1.234", "pt-BR"));
check("pt money", spokenNumbers("custou R$ 100", "pt-BR") === "custou cem reais", spokenNumbers("R$ 100", "pt-BR"));
check("pt gigabytes", spokenNumbers("2 GB livres", "pt-BR") === "dois gigabytes livres", spokenNumbers("2 GB", "pt-BR"));
check("pt iso date", spokenNumbers("deploy 2026-09-04", "pt-BR") === "deploy quatro de setembro de dois mil e vinte e seis", spokenNumbers("2026-09-04", "pt-BR"));
check("pt big year", numberWords(2026, "pt-BR") === "dois mil e vinte e seis", numberWords(2026, "pt-BR"));
check("pt million", numberWords(2_000_000, "pt-BR") === "dois milhões", numberWords(2_000_000, "pt-BR"));

// en-US
check("en ratio", spokenNumbers("45/200 tasks done", "en-US") === "forty five of two hundred tasks done", spokenNumbers("45/200", "en-US"));
check("en percent", spokenNumbers("98% uptime", "en-US") === "ninety eight percent uptime", spokenNumbers("98%", "en-US"));
check("en thousands", spokenNumbers("1,234 files", "en-US") === "one thousand two hundred thirty four files", spokenNumbers("1,234", "en-US"));
check("en decimal", spokenNumbers("latency 0.8s ok", "en-US") === "latency zero point eight s ok", spokenNumbers("0.8", "en-US"));
check("en clock", spokenNumbers("at 15:10 sharp", "en-US") === "at fifteen ten sharp", spokenNumbers("15:10", "en-US"));

// es-ES
check("es percent", spokenNumbers("98% de éxito", "es-ES") === "noventa y ocho por ciento de éxito", spokenNumbers("98%", "es-ES"));
check("es ratio", spokenNumbers("45/200 tareas", "es-ES") === "cuarenta y cinco de doscientos tareas", spokenNumbers("45/200", "es-ES"));
check("es veintiun mil", numberWords(21000, "es-ES") === "veintiún mil", numberWords(21000, "es-ES"));

// URL/email tokens survive untouched
check("url untouched", spokenNumbers("veja https://x.com/10 e 5 GB", "pt-BR") === "veja https://x.com/10 e cinco gigabytes", spokenNumbers("https://x.com/10", "pt-BR"));

// lang allowlist falls back to pt-BR
check("unknown lang falls back", normalizeLang("fr") === "pt-BR" && normalizeLang(undefined) === "pt-BR");
check("voice allowlist", resolveVoice("en-US").voice === "en-US-AndrewNeural" && resolveVoice("garbage").voice.startsWith("pt-BR"));

process.exit(failures ? 1 : 0);
