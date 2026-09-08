// P2-276: the language of the native shell — menu bar and tray. The web UI
// has had a language selector since P2-118 (apps/web/src/lib/i18n.ts stores
// en | pt), but the OS surfaces never knew: menu.ts wrote its labels in
// pt-BR and traystatus.ts phrased its tooltips in pt-BR no matter what the
// user picked. This module is the single decision + vocabulary point both
// surfaces now share.
//
// Same module hygiene as tray.ts / badge.ts / traystatus.ts / boothealth.ts:
// NO electron, NO node:fs, NO node:path, no I/O of any kind — pure data in,
// pure data out, so scripts/unit.test.ts (and the portable twin
// scripts/shelllang.test.ts) can exercise every branch in plain Node.
//
// Rule order for shellLang — evaluated exactly in this order:
//   1. A saved preference that is missing, empty, non-textual or outside the
//      documented supported list is DISCARDED — never guessed, never
//      normalized into something it is not.
//   2. A supported preference ALWAYS wins and is never overridden by the
//      system language.
//   3. Without a preference, a system language that starts with the
//      documented Portuguese prefix ("pt", case-insensitive — "pt" and
//      "pt-BR" alike) becomes pt.
//   4. Every other case becomes en — the safe default, because en is the
//      language with the widest reach for the signed installer (stages 3 and
//      5 of docs/VISION.md ship to Mac and Windows worldwide). Labels never
//      come out empty.
//   5. Deterministic: the same inputs produce the same result on every call.
//
// Like every shell copy (P2-140/P2-182 lessons): no emoji (P2-107), no file
// path, no volume name, no address, no port, no secret. Product names the UI
// itself keeps untranslated ("OpenCode Remote", "Artifacts", "Browser",
// "Mission Control") stay exactly as they are in both tables.

/** The two languages the app and the shell speak. */
export type ShellLang = "en" | "pt";

/** Where the decision came from — a short, static label, never prose. */
export type ShellLangOrigin =
  /** Rule 2: the renderer's saved choice, inside the supported list. */
  | "preference"
  /** Rule 3: no usable preference — the OS locale decided. */
  | "system"
  /** Rule 4: neither — the safe default. */
  | "default";

/** The documented supported list. The shell speaks exactly what the app
 * (apps/web/src/lib/i18n.ts) has spoken since P2-118. */
export const SUPPORTED_SHELL_LANGS: readonly ShellLang[] = ["en", "pt"];

/** The documented Portuguese prefix (rule 3): any system language whose
 * lowercased code starts with it counts as Portuguese. */
export const PT_LANG_PREFIX = "pt";

export interface ShellLangDecision {
  /** The resolved shell language. */
  lang: ShellLang;
  /** Short static label of which rule produced it. */
  origin: ShellLangOrigin;
}

/**
 * Resolve the shell language from (1) the preference the renderer published,
 * (2) the language the OS declares and (3) the documented supported list.
 * Rules 1-5 in the header apply in order; the function is pure and
 * deterministic.
 */
export function shellLang(
  preference: unknown,
  systemLang: unknown,
  supported: readonly string[] = SUPPORTED_SHELL_LANGS,
): ShellLangDecision {
  // Rule 1 + 2: only an exact textual match against the supported list is a
  // preference — anything else (absent, empty, a number, an object, a code
  // outside the list) is discarded, never guessed.
  if (typeof preference === "string" && (supported as readonly string[]).includes(preference)) {
    return { lang: preference as ShellLang, origin: "preference" };
  }
  // Rule 3: the OS locale ("pt", "pt-BR", "pt-PT"…) starts with the
  // documented prefix. Case-insensitive by construction; a non-text system
  // language simply never matches.
  const sys = typeof systemLang === "string" ? systemLang.toLowerCase() : "";
  if (sys.startsWith(PT_LANG_PREFIX)) return { lang: "pt", origin: "system" };
  // Rule 4: the safe default — widest installer reach, never an empty label.
  return { lang: "en", origin: "default" };
}

// --- the vocabulary -------------------------------------------------------------

/** Every menu-bar label the shell renders, plus the tray's phrases. Product
 * names stay untranslated in both tables by design. */
export interface ShellMenuLabels {
  /** macOS application-menu title (product name, untranslated). */
  appTitle: string;
  quit: string;
  go: string;
  view: string;
  help: string;
  /** P2-229: the Help-menu line that carries the registered reopen hotkey. */
  hotkeyLine: string;
  zoomReset: string;
  zoomIn: string;
  zoomOut: string;
  checkUpdates: string;
  openLogs: string;
  copyDiagnostics: string;
  wipeData: string;
  newChat: string;
  commandPalette: string;
  paneConversations: string;
  /** Product name, untranslated. */
  paneArtifacts: string;
  /** Product name, untranslated. */
  paneBrowser: string;
  paneFiles: string;
  paneSettings: string;
  /** Product name, untranslated. */
  paneMission: string;
}

/** One tray state: the icon tooltip and the disabled status line that leads
 * the tray's context menu. Both fit under TRAY_TIP_MAX_CHARS. */
export interface ShellTrayPhrase {
  tooltip: string;
  menuLine: string;
}

/** The full tray journey vocabulary (mirrors traystatus.ts's rule table). */
export interface ShellTrayLabels {
  down: ShellTrayPhrase;
  refused: ShellTrayPhrase;
  misconfigured: ShellTrayPhrase;
  dialing: ShellTrayPhrase;
  unknown: ShellTrayPhrase;
  /** Connected, zero paired phones — the invite-to-pair phrase. */
  invite: ShellTrayPhrase;
  /** Local mode with phones — the local-network phrase. */
  local: ShellTrayPhrase;
  /** Connected with phones — the all-ready phrase. */
  ready: ShellTrayPhrase;
}

export interface ShellLabels {
  menu: ShellMenuLabels;
  tray: ShellTrayLabels;
}

const EN: ShellLabels = {
  menu: {
    appTitle: "OpenCode Remote",
    quit: "Quit OpenCode Remote",
    go: "Go",
    view: "View",
    help: "Help",
    hotkeyLine: "Global shortcut to reopen the window",
    zoomReset: "Actual size",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    checkUpdates: "Check for updates",
    openLogs: "Open logs folder",
    copyDiagnostics: "Copy diagnostic",
    wipeData: "Erase app data…",
    newChat: "New conversation",
    commandPalette: "Command palette",
    paneConversations: "Conversations",
    paneArtifacts: "Artifacts",
    paneBrowser: "Browser",
    paneFiles: "Files",
    paneSettings: "Settings",
    paneMission: "Mission Control",
  },
  tray: {
    down: {
      tooltip: "OpenCode Remote — local process is down: no phone reaches this machine",
      menuLine: "Local process is down — no phone reaches this machine right now",
    },
    refused: {
      tooltip: "OpenCode Remote — the relay refused the connection: the phone does not reach this machine",
      menuLine: "The relay refused the connection — the phone does not reach this machine right now",
    },
    misconfigured: {
      tooltip: "OpenCode Remote — relay address refused at startup: check the settings",
      menuLine: "Relay address refused at startup — check the settings",
    },
    dialing: {
      tooltip: "OpenCode Remote — connecting to the relay: hang on a moment",
      menuLine: "Connecting to the relay — hang on a moment",
    },
    unknown: {
      tooltip: "OpenCode Remote — no news from the relay for now",
      menuLine: "No news from the relay for now — pairing can go on as usual",
    },
    invite: {
      tooltip: "OpenCode Remote — no phone paired yet: scan the code with your phone",
      menuLine: "No phone paired yet — scan the code with your phone to begin",
    },
    local: {
      tooltip: "OpenCode Remote — the phone reaches this machine over the local network, no relay",
      menuLine: "The phone reaches this machine over the local network, no relay",
    },
    ready: {
      tooltip: "OpenCode Remote — all set: the phone reaches this machine",
      menuLine: "All set — the phone reaches this machine",
    },
  },
};

/** The pt table carries the exact phrases the shell has always spoken since
 * P2-176/P2-252 — byte-identical, so a pt user sees nothing change. */
const PT: ShellLabels = {
  menu: {
    appTitle: "OpenCode Remote",
    quit: "Encerrar OpenCode Remote",
    go: "Ir",
    view: "Visualizar",
    help: "Ajuda",
    hotkeyLine: "Atalho global para reabrir a janela",
    zoomReset: "Tamanho padrão",
    zoomIn: "Ampliar",
    zoomOut: "Reduzir",
    checkUpdates: "Verificar atualizações",
    openLogs: "Abrir pasta de logs",
    copyDiagnostics: "Copiar diagnóstico",
    wipeData: "Apagar dados do app…",
    newChat: "Nova conversa",
    commandPalette: "Paleta de comandos",
    paneConversations: "Conversas",
    paneArtifacts: "Artifacts",
    paneBrowser: "Browser",
    paneFiles: "Arquivos",
    paneSettings: "Configurações",
    paneMission: "Mission Control",
  },
  tray: {
    down: {
      tooltip: "OpenCode Remote — processo local fora do ar: nenhum telefone alcança esta máquina",
      menuLine: "Processo local fora do ar — nenhum telefone alcança esta máquina agora",
    },
    refused: {
      tooltip: "OpenCode Remote — o relay recusou a conexão: o celular não alcança a máquina",
      menuLine: "O relay recusou a conexão — o celular não alcança a máquina agora",
    },
    misconfigured: {
      tooltip: "OpenCode Remote — endereço do relay recusado na partida: confira as configurações",
      menuLine: "Endereço do relay recusado na partida — confira as configurações",
    },
    dialing: {
      tooltip: "OpenCode Remote — conectando ao relay: aguarde um instante",
      menuLine: "Conectando ao relay — aguarde um instante",
    },
    unknown: {
      tooltip: "OpenCode Remote — sem informação do relay por enquanto",
      menuLine: "Sem informação do relay por enquanto — o pareamento pode seguir normalmente",
    },
    invite: {
      tooltip: "OpenCode Remote — nenhum telefone pareado: escaneie o código no celular",
      menuLine: "Nenhum telefone pareado — escaneie o código no celular para começar",
    },
    local: {
      tooltip: "OpenCode Remote — o celular alcança esta máquina pela rede local, sem relay",
      menuLine: "O celular alcança esta máquina pela rede local, sem relay",
    },
    ready: {
      tooltip: "OpenCode Remote — tudo pronto: o celular alcança esta máquina",
      menuLine: "Tudo pronto — o celular alcança esta máquina",
    },
  },
};

/**
 * The complete static label table for the resolved shell language. Pure and
 * deterministic: pt for "pt", en for anything else (rule 4's safe default —
 * a table is always returned, never an empty label).
 */
export function shellLabels(lang: ShellLang): ShellLabels {
  return lang === "pt" ? PT : EN;
}
