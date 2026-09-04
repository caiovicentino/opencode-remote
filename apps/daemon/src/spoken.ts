// Spoken-number normalization for TTS replies: digits like "45/200", "98%",
// "15:10" or "P2-153" read as robot gibberish in a speech renderer, so they
// are rewritten as natural words in the voice language before synthesis.
// Pure module — no I/O — so the unit chain can pin every reading rule.
export type SpeechLang = "pt-BR" | "en-US" | "es-ES";

export const SPEECH_LANGS: SpeechLang[] = ["pt-BR", "en-US", "es-ES"];

/** Allowlist an untrusted lang value; anything unknown falls back to pt-BR. */
export function normalizeLang(value: unknown): SpeechLang {
  return SPEECH_LANGS.includes(value as SpeechLang) ? (value as SpeechLang) : "pt-BR";
}

type Tables = {
  zero: string;
  units: string[]; // 1..19
  tens: string[]; // index 2..9
  hundred: string; // 100 exactly ("cem"/"cien")
  hundredJoin: string; // between hundred and rest: "cento e cinco"
  hundreds?: string[]; // pt/es irregular hundreds (index 1..9); en builds "X hundred"
  tensJoin: string; // between tens and units: "e"/"y"/""
  scale: string[][]; // per group index (1=thousands): [singular, plural]
  below100?: (n: number, tb: Tables) => string; // es veinti- override
};

function below100(n: number, tb: Tables): string {
  if (n < 20) return tb.units[n - 1]!;
  if (tb.below100) return tb.below100(n, tb);
  const t = tb.tens[Math.floor(n / 10)]!;
  const u = n % 10;
  return u ? `${t}${tb.tensJoin}${tb.units[u - 1]!}` : t;
}

function below1000(n: number, tb: Tables): string {
  if (n < 100) return below100(n, tb);
  if (n === 100) return tb.hundred;
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const head = tb.hundreds ? tb.hundreds[h]! : `${tb.units[h - 1]!} hundred`;
  return rest ? `${head}${tb.hundredJoin}${below100(rest, tb)}` : head;
}

/** 1234 → "mil duzentos e trinta e quatro" (pt) / "one thousand two hundred thirty four" (en). */
export function numberWords(value: number, lang: SpeechLang): string {
  const tb = lang === "pt-BR" ? PT : lang === "en-US" ? EN : ES;
  const n = Math.floor(Math.abs(value));
  if (!isFinite(n)) return String(value);
  if (n === 0) return tb.zero;
  if (n > 999_999_999_999_999) return String(value);
  const groups: number[] = [];
  let rest = n;
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (!g) continue;
    if (i === 0) {
      parts.push(below1000(g, tb));
    } else if (i === 1 && g === 1 && lang !== "en-US") {
      parts.push("mil");
    } else if (g === 1) {
      // "one thousand" / "um milhão" / "un millón"
      parts.push(`${scaleUnit(tb.units[0]!)}${tb.scale[i]![0]!}`);
    } else {
      const head = below1000(g, tb);
      const sc = tb.scale[i]!;
      parts.push(i === 1 ? `${scaleUnit(head)}${sc[0]!}` : `${scaleUnit(head)}${sc[1]!}`);
    }
  }
  const last = groups[0];
  // pt reads the final small group with "e": "dois mil e vinte e seis" —
  // en and es do not ("two thousand twenty six", "dos mil veintiséis")
  if (parts.length > 1 && last && (last < 100 || last % 100 === 0) && lang === "pt-BR") {
    parts[parts.length - 1] = `e ${parts[parts.length - 1]}`;
  }
  return parts.join(" ");
}

/** es contraction before a scale word: "veintiuno mil" → "veintiún mil". */
function scaleUnit(words: string): string {
  return words.replace(/veintiuno$/, "veintiún").replace(/uno$/, "un");
}

const PT: Tables = {
  zero: "zero",
  units: ["um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"],
  tens: ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"],
  hundred: "cem",
  hundredJoin: " e ",
  hundreds: ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"],
  tensJoin: " e ",
  scale: [[], [" mil", " mil"], [" milhão", " milhões"], [" bilhão", " bilhões"]],
};

const EN: Tables = {
  zero: "zero",
  units: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"],
  tens: ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"],
  hundred: "one hundred",
  hundredJoin: " ",
  tensJoin: " ",
  scale: [[], [" thousand", " thousand"], [" million", " million"], [" billion", " billion"]],
};

const ES: Tables = {
  zero: "cero",
  units: ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve"],
  tens: ["", "", "veinte", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"],
  hundred: "cien",
  hundredJoin: " ",
  hundreds: ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"],
  tensJoin: " y ",
  scale: [[], [" mil", " mil"], [" millón", " millones"], [" billón", " billones"]],
  // 21-29 are the veinti- words; 30+ use "y" ("treinta y uno")
  below100: (n, tb) => {
    if (n >= 21 && n < 30) {
      const base = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"][n - 20]!;
      return `veinti${base === "uno" ? "uno" : base === "dos" ? "dós" : base === "tres" ? "trés" : base === "seis" ? "séis" : base}`;
    }
    const t = tb.tens[Math.floor(n / 10)]!;
    const u = n % 10;
    return u ? `${t} y ${tb.units[u - 1]!}` : t;
  },
};

const MONTHS: Record<SpeechLang, string[]> = {
  "pt-BR": ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
  "en-US": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  "es-ES": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
};

/** Per-language readings: percent, decimal joiner, "A of B", clock, units. */
const READ = {
  "pt-BR": {
    percent: "por cento",
    decimal: "vírgula",
    of: " de ",
    clockJoin: " e ",
    money: { BRL: "reais", BRL1: "real", USD: "dólares" },
    degrees: "graus",
    units: { GB: "gigabytes", MB: "megabytes", KB: "quilobytes", TB: "terabytes", kg: "quilos", km: "quilômetros", ms: "milissegundos", min: "minutos" },
  },
  "en-US": {
    percent: "percent",
    decimal: "point",
    of: " of ",
    clockJoin: " ",
    money: { BRL: "reais", BRL1: "real", USD: "dollars" },
    degrees: "degrees",
    units: { GB: "gigabytes", MB: "megabytes", KB: "kilobytes", TB: "terabytes", kg: "kilograms", km: "kilometers", ms: "milliseconds", min: "minutes" },
  },
  "es-ES": {
    percent: "por ciento",
    decimal: "coma",
    of: " de ",
    clockJoin: " y ",
    money: { BRL: "reales", BRL1: "real", USD: "dólares" },
    degrees: "grados",
    units: { GB: "gigabytes", MB: "megabytes", KB: "kilobytes", TB: "terabytes", kg: "kilos", km: "kilómetros", ms: "milisegundos", min: "minutos" },
  },
} as const;

function decWords(intPart: string, frac: string, lang: SpeechLang): string {
  const r = READ[lang];
  const digits = frac.split("").map((d) => numberWords(Number(d), lang)).join(" ");
  return `${numberWords(Number(intPart), lang)} ${r.decimal} ${digits}`;
}

/**
 * Rewrite digits as natural spoken words. URL/email tokens are stashed and
 * restored untouched. Rules run in a fixed order so each pattern is consumed
 * at most once ("3.2%" is percent, never decimal + bare).
 */
export function spokenNumbers(text: string, langInput: SpeechLang | string): string {
  const lang = normalizeLang(langInput);
  const r = READ[lang];
  // stash URLs/emails as single PUA chars so digit rules never touch them
  const stash: string[] = [];
  let out = text.replace(/(https?:\/\/\S+|www\.\S+|\S+@\S+)/g, (m) => {
    const idx = stash.push(m) - 1;
    return `\uE000${String.fromCharCode(0xe100 + idx)}\uE001`;
  });
  const w = (n: number | string) => numberWords(typeof n === "string" ? Number(n) : n, lang);

  // ISO dates: 2026-09-04 → "quatro de setembro de dois mil e vinte e seis"
  out = out.replace(/\b(20\d{2})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => {
    const month = MONTHS[lang][Number(mo) - 1];
    if (!month || Number(d) < 1 || Number(d) > 31) return m;
    return lang === "en-US" ? `${month} ${w(d)}, ${w(y)}` : `${w(d)} de ${month} de ${w(y)}`;
  });

  // Money: R$ 100 → "cem reais"; US$ 5 → "cinco dólares"
  out = out.replace(/R\$\s?(\d[\d.,]*)/g, (m, num: string) => {
    const n = Number(num.replace(/\./g, "").replace(",", "."));
    if (!isFinite(n)) return m;
    return `${w(Math.floor(n))} ${n === 1 ? r.money.BRL1 : r.money.BRL}`;
  });
  out = out.replace(/US\$\s?(\d[\d.,]*)/g, (m, num: string) => {
    const n = Number(num.replace(/,/g, ""));
    if (!isFinite(n)) return m;
    return `${w(n)} ${r.money.USD}`;
  });

  // Clock 15:10 → "quinze e dez" (durations read as two plain numbers)
  out = out.replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h: string, mi: string) => {
    if (Number(h) <= 23 && Number(mi) <= 59) return `${w(Number(h))}${r.clockJoin}${w(Number(mi))}`;
    return `${w(Number(h))}, ${w(Number(mi))}`;
  });

  // Percent: 98% / 3,2% → "noventa e oito por cento"
  out = out.replace(/(\d+(?:[.,]\d+)?)\s?%/g, (m, num: string) => {
    const dot = num.indexOf(".");
    const cm = num.indexOf(",");
    if (dot === -1 && cm === -1) return `${w(num)} ${r.percent}`;
    const [ip = "0", fp = "0"] = num.split(/[.,]/);
    return `${decWords(ip, fp, lang)} ${r.percent}`;
  });

  // Degrees: 3°C → "três graus"
  out = out.replace(/(\d+(?:[.,]\d+)?)\s?°?C\b/g, (m, num: string) => {
    const dot = num.indexOf(".");
    const cm = num.indexOf(",");
    if (dot === -1 && cm === -1) return `${w(num)} ${r.degrees}`;
    const [ip = "0", fp = "0"] = num.split(/[.,]/);
    return `${decWords(ip, fp, lang)} ${r.degrees}`;
  });

  // Units: 2 GB, 10 min, 300 ms…
  out = out.replace(/\b(\d+(?:[.,]\d+)?)\s?(GB|MB|KB|TB|kg|km|ms|min)\b/g, (m, num: string, unit: string) => {
    const dot = num.indexOf(".");
    const cm = num.indexOf(",");
    const head = dot === -1 && cm === -1 ? w(num) : decWords(...(num.split(/[.,]/) as [string, string]), lang);
    return `${head} ${r.units[unit as keyof typeof r.units]}`;
  });

  // Task IDs: P2-153 → "P dois, cento e cinquenta e três"
  out = out.replace(/\b([A-Za-z])(\d+)-(\d+)\b/g, (m, letter: string, a: string, b: string) => `${letter} ${w(a)}, ${w(b)}`);

  // Ratios: 45/200 → "quarenta e cinco de duzentos"
  out = out.replace(/\b(\d+)\s?\/\s?(\d+)\b/g, (m, a: string, b: string) => `${w(a)}${r.of}${w(b)}`);

  // Thousands groups: pt/es "1.234.567" / en "1,234,567"
  const sep = lang === "en-US" ? "," : "\\.";
  out = out.replace(new RegExp(`\\b\\d{1,3}(?:${sep}\\d{3})+\\b`, "g"), (m) => w(m.replace(new RegExp(sep, "g"), "")));

  // Decimals: 3.2 → "três vírgula dois" (fraction digits read one by one);
  // a decimal glued to a letter ("0.8s") gains a space so words don't fuse
  out = out.replace(/\b(\d+)[.,](\d+)(?=[a-zA-Z])/g, (m, ip: string, fp: string) => `${decWords(ip, fp, lang)} `);
  out = out.replace(/\b(\d+)[.,](\d+)/g, (m, ip: string, fp: string) => decWords(ip, fp, lang));

  // Bare integers
  out = out.replace(/\b\d+\b/g, (m) => w(m));

  return out.replace(/\uE000([\uE100-\uE2FF])\uE001/g, (m, c) => stash[c.charCodeAt(0) - 0xe100] ?? m);
}
