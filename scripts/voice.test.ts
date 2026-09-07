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

// voice-recap convention: a section after a --- divider is spoken alone,
// with a wider budget — the chat body is not spoken
{
  const withRecap = "Resposta técnica concisa, com detalhes de código.\n---\nResumo falado amplificado, contado em linguagem natural pra ouvir sem ler.";
  check("divider: recap spoken alone", speakBrief(withRecap) === "Resumo falado amplificado, contado em linguagem natural pra ouvir sem ler.");
  const longBody = "corpo ".repeat(200) + "\n---\n" + "recap amplificado. ";
  const recapBrief = speakBrief(longBody);
  check("divider: body ignored", recapBrief.startsWith("recap amplificado."), recapBrief.slice(0, 40));
  check("divider: recap budget is 900", recapBrief.length <= 900);
  check("no divider keeps old behavior", speakBrief("Só uma resposta curta.") === "Só uma resposta curta.");
}

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

// ─── P2-298: spoken-reply capability verdict (apps/daemon/src/ttscap.ts) ───
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAbsoluteToolPath, ttsVerdict } from "../apps/daemon/src/ttscap";

const repoSrc = (rel: string[]) => readFileSync(join(import.meta.dirname, "..", ...rel), "utf8");

// full verdict table: null, empty and non-textual input → missing-tool
check("tts null input is missing-tool", ttsVerdict(null, "posix").state === "missing-tool");
check("tts empty input is missing-tool", ttsVerdict("", "windows").state === "missing-tool");
check("tts blank input is missing-tool", ttsVerdict("   ", "posix").state === "missing-tool");
check(
  "tts non-textual input is missing-tool",
  ttsVerdict(42, "posix").state === "missing-tool" &&
    ttsVerdict(undefined, "windows").state === "missing-tool" &&
    ttsVerdict({}, "posix").state === "missing-tool",
);

// POSIX absolute path → ready on posix
check("tts posix absolute path is ready", ttsVerdict("/usr/local/bin/edge-tts", "posix").state === "ready");

// Windows drive-letter path → ready on windows, rejected on posix
check(
  "tts windows drive-letter path ready on windows, rejected on posix",
  ttsVerdict("C:\\Tools\\edge-tts.exe", "windows").state === "ready" &&
    ttsVerdict("C:\\Tools\\edge-tts.exe", "posix").state === "missing-tool",
);
// Windows UNC path (two leading backslashes) → ready on windows
check("tts UNC path ready on windows", ttsVerdict("\\\\server\\share\\edge-tts.exe", "windows").state === "ready");

// relative path rejected on both platforms
check(
  "tts relative path rejected on both platforms",
  ttsVerdict("edge-tts", "posix").state === "missing-tool" &&
    ttsVerdict("edge-tts", "windows").state === "missing-tool" &&
    ttsVerdict("bin/edge-tts", "posix").state === "missing-tool",
);

// unknown platform falls into the POSIX rule
check(
  "tts unknown platform is judged by the posix rule",
  ttsVerdict("/usr/bin/edge-tts", "sunos").state === "ready" &&
    ttsVerdict("C:\\x\\edge-tts", "sunos").state === "missing-tool",
);

// rule order proven: non-textual input AND unknown platform at the same time
// still lands missing-tool with the missing-tool phrase (no crash, no ready)
check(
  "tts rule order: non-textual + unknown platform is missing-tool",
  ttsVerdict(42, "atari").state === "missing-tool" &&
    ttsVerdict(42, "atari").message === ttsVerdict(null, "posix").message,
);

// each verdict carries exactly state + message
{
  const ready = ttsVerdict("/usr/bin/edge-tts", "posix");
  const missing = ttsVerdict(null, "posix");
  check(
    "tts verdict is exactly state + message",
    Object.keys(ready).length === 2 &&
      Object.keys(missing).length === 2 &&
      ready.state === "ready" &&
      missing.state === "missing-tool" &&
      typeof ready.message === "string" &&
      typeof missing.message === "string",
  );
  check(
    "tts phrases differ between verdicts",
    ready.message !== missing.message && /instal/i.test(missing.message),
  );
}

// message boundary: no slash, backslash, dollar, colon+digit or script extension
check(
  "tts phrases leak no path/tool/port/script",
  [
    ttsVerdict(null, "posix").message,
    ttsVerdict("/usr/local/bin/edge-tts", "posix").message,
    ttsVerdict(null, "windows").message,
    ttsVerdict("C:\\Tools\\edge-tts.exe", "windows").message,
    ttsVerdict(42, "atari").message,
  ].every(
    (m) =>
      !m.includes("/") &&
      !m.includes("\\") &&
      !m.includes("$") &&
      !/:\d/.test(m) &&
      !/\.(sh|ps1|bat|cmd|js|mjs|py)\b/i.test(m),
  ),
);

// determinism: same input twice → identical result
check(
  "tts verdict is deterministic",
  JSON.stringify(ttsVerdict("/usr/bin/edge-tts", "posix")) === JSON.stringify(ttsVerdict("/usr/bin/edge-tts", "posix")) &&
    JSON.stringify(ttsVerdict(null, "windows")) === JSON.stringify(ttsVerdict(null, "windows")),
);

// the pure path-form rule, exercised directly (portable-suite surface)
check(
  "path rule: posix form",
  isAbsoluteToolPath("/usr/bin/edge-tts", "posix") === true &&
    isAbsoluteToolPath("edge-tts", "posix") === false,
);
check(
  "path rule: windows forms",
  isAbsoluteToolPath("C:\\Tools\\edge-tts.exe", "windows") === true &&
    isAbsoluteToolPath("C:/Tools/edge-tts.exe", "windows") === true &&
    isAbsoluteToolPath("\\\\srv\\share\\edge-tts.exe", "windows") === true &&
    isAbsoluteToolPath("Tools\\edge-tts.exe", "windows") === false,
);
check(
  "path rule: unknown platform judged posix",
  isAbsoluteToolPath("/usr/bin/edge-tts", "sunos") === true &&
    isAbsoluteToolPath("C:\\Tools\\edge-tts.exe", "sunos") === false,
);

// real-repo assertions: routes serve the module verdict; purity holds
{
  // strip line comments first — the header prose names the banned modules
  const ttscapCode = repoSrc(["apps", "daemon", "src", "ttscap.ts"]).replace(/\/\/.*$/gm, "");
  const indexSrc = repoSrc(["apps", "daemon", "src", "index.ts"]);
  check(
    "P2-298: ttscap.ts is pure (no node:fs/child_process/os/http imports, no fetch)",
    !/node:(fs|child_process|os|http)/.test(ttscapCode) && !/\bfetch\b/.test(ttscapCode),
  );
  check(
    "P2-298: the tts 501 refusal carries the verdict phrase; the raw English hint is gone",
    /status: 501, body: \{ error: ttsStatus\(\)\.message \}/.test(indexSrc) &&
      !indexSrc.includes("install edge-tts on the host"),
  );
  check(
    "P2-298: tts-status keeps available/voice/voices/langs unchanged and adds state+message from the verdict",
    /available: !!edgeTtsBin, voice: resolveVoice\("pt-BR", TTS_PT_VOICE\)\.voice, voices: TTS_VOICES, langs: SPEECH_LANGS, state: tts\.state, message: tts\.message/.test(
      indexSrc,
    ),
  );
  check(
    "P2-298: the refusal and the status route read the verdict through ttsStatus()",
    indexSrc.includes("ttsVerdict(edgeTtsBin") && (indexSrc.match(/ttsStatus\(\)/g) ?? []).length >= 3,
  );
  check(
    "P2-298: lazy re-probe runs at the refusal and the status route; no new periodic timer",
    (indexSrc.match(/maybeReprobeTts\(\);/g) ?? []).length >= 2 &&
      !/setInterval\([^)]*tts/i.test(indexSrc),
  );
  check(
    "P2-298: OCR_TTS_BLOCK=1 is the documented hatch forcing the missing-tool verdict",
    indexSrc.includes('process.env.OCR_TTS_BLOCK === "1"') &&
      /OCR_TTS_BLOCK/.test(repoSrc(["README.md"])) &&
      /OCR_TTS_BLOCK/.test(repoSrc(["README.pt-BR.md"])) &&
      /OCR_TTS_BLOCK/.test(repoSrc(["docs", "troubleshooting.md"])),
  );
}

process.exit(failures ? 1 : 0);
