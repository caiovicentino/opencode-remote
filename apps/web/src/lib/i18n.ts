// tiny i18n: localStorage-backed language, module-level store with listeners.
// usage: const t = useT(); t("search") — components re-render on change.

import { useSyncExternalStore } from "react";

export type Lang = "en" | "pt";

const KEY = "ocr_lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY) as Lang | null;
    if (saved === "en" || saved === "pt") return saved;
    return navigator.language.toLowerCase().startsWith("pt") ? "pt" : "en";
  } catch {
    return "en";
  }
}

let lang: Lang = detect();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang) {
  lang = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {}
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useT() {
  useSyncExternalStore(subscribe, getLang);
  return (key: string, vars?: Record<string, string | number>) => {
    let s = (dict[lang] as Record<string, string>)[key] ?? (dict.en as Record<string, string>)[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  };
}

const dict = {
  en: {
    // sessions board
    search: "Search conversations…",
    filterAll: "All",
    filterWithBadge: "With badge",
    filterNoBadge: "No badge",
    loadingSessions: "Loading conversations…",
    noSessions: "No conversations yet.",
    ready: "ready",
    working: "working…",
    waitingApproval: "waiting for your approval",
    askedQuestion: "asked a question",
    errored: "errored",
    newConversation: "+ New conversation",
    creating: "Creating…",
    unpair: "Unpair",
    pushOn: "Push ✓",
    pushEnable: "Enable push",
    renamePrompt: "New name:",
    deleteConfirm: "Delete this conversation?",
    machines: "Machines",
    forget: "Forget",
    activity: "Activity",
    // chat
    stop: "Stop",
    emptyTitle: "Start the conversation 👋",
    emptyHint: "Send an audio, photo or text — your agent is ready.",
    agentWorking: "agent is working…",
    queued: "{n} message(s) queued — will send when reconnected",
    exported: "Conversation exported ✔",
    openedOnMac: "Opened on your Mac — the conversation continues there",
    rewindBtn: "back to here",
    rewindConfirm:
      "Take the conversation back to this point? Everything after it is undone — including code changes. You can redo later.",
    rewound: "Conversation rewound",
    unrevert: "Redo (undo the rewind)",
    unreverted: "Back to the present",
    autoApproved: "AutoMode approved: {action}",
    exportBtn: "Export conversation",
    handoffBtn: "Continue on the Mac",
    copyPath: "Copy path",
    copied: "Copied ✓",
    copyFailed: "Could not copy the path",
    answer: "Answer",
    skip: "Skip",
    customAnswer: "or type your own answer…",
    approve: "Approve",
    deny: "Deny",
    // settings
    settingsMachine: "Machine",
    settingsNotifications: "Notifications",
    notifPermission: "Permission requests",
    notifIdle: "Agent finished",
    autoMode: "AutoMode",
    autoModeLabel: "Approve everything automatically",
    autoModeHint:
      "The agent runs without approval prompts on this machine. Every auto-approved action is recorded in the audit log and (if enabled) pushed as a notification.",
    language: "Language",
    mcp: "MCP",
    mcpHint: "Tool connectors ({file}). Changes apply to new conversations.",
    mcpNone: "No connectors.",
    mcpAdd: "+ Add connector",
    mcpName: "name",
    mcpCommand: "command (e.g. npx -y some-mcp-server)",
    mcpUrl: "https://your-server-url",
    mcpAddBtn: "Add",
    saved: "saved",
    saveError: "error: {msg}",
    pairedDevices: "Paired devices ({n})",
    audit: "Audit",
    noAudit: "no events yet",
    voice: "Voice",
    voiceAutoSend: "Auto-send after transcription",
    versionMismatch:
      " — version mismatch: refresh the PWA (pull-to-refresh) or update the daemon",
    // tab bar
    tabSessions: "Chats",
    tabFiles: "Files",
    tabSettings: "Settings",
    // errors
    retry: "Retry",
    errAgentCrashed: "The agent crashed mid-answer — it usually comes back on retry.",
    errAttachmentExpired: "Attachment expired — reattach it and send again.",
    errConversationGone: "This conversation no longer exists on the machine.",
    errRefused: "The agent refused the request (HTTP {status}).",
    errConnectionLost: "Connection lost — your message is queued and will go out automatically.",
    errNotPaired: "Not paired yet — reopen the app or pair again.",
    errCreateFailed: "Could not create the conversation — try again.",
    // session cards
    justNow: "now",
    // first-run pairing overlay (desktop, P2-007)
    pairOverlayTitle: "Pair your phone",
    pairOverlayHint:
      "Scan this QR code with the OpenCode Remote app to control this machine from your phone. Traffic is end-to-end encrypted.",
    pairOverlayAlt: "Pairing QR code",
    pairOverlayLater: "Pair later",
    // daemon sidecar gave up (desktop, P2-017) — P1-053: the copy points to the
    // in-banner recovery button; the reconnecting state is the active variant.
    daemonDown: "Local daemon is down — the app stopped retrying.",
    reconnectNow: "Reconnect now",
    reconnecting: "Reconnecting to daemon… ({n})",
  },
  pt: {
    search: "Buscar conversas…",
    filterAll: "Todas",
    filterWithBadge: "Com badge",
    filterNoBadge: "Sem badge",
    loadingSessions: "Carregando conversas…",
    noSessions: "Nenhuma conversa ainda.",
    ready: "pronto",
    working: "trabalhando…",
    waitingApproval: "esperando sua aprovação",
    askedQuestion: "fez uma pergunta",
    errored: "deu erro",
    newConversation: "+ Nova conversa",
    creating: "Criando…",
    unpair: "Desconectar",
    pushOn: "Notificações ✓",
    pushEnable: "Ativar notificações",
    renamePrompt: "Novo nome:",
    deleteConfirm: "Apagar esta conversa?",
    machines: "Máquinas",
    forget: "Esquecer",
    activity: "Atividade",
    stop: "Parar",
    emptyTitle: "Comece a conversa 👋",
    emptyHint: "Mande um áudio, foto ou texto — seu agente tá pronto.",
    agentWorking: "agente trabalhando…",
    queued: "{n} mensagem(s) na fila — enviam ao reconectar",
    exported: "Conversa exportada ✔",
    openedOnMac: "Aberto no Mac — a conversa continua lá",
    rewindBtn: "⏪ voltar pra cá",
    rewindConfirm:
      "Voltar a conversa pra este ponto? Tudo o que veio depois é desfeito — inclusive as mudanças no código. Dá pra refazer depois.",
    rewound: "Conversa voltou pra trás",
    unrevert: "Refazer (desfazer o voltar)",
    unreverted: "De volta pro presente",
    autoApproved: "AutoMode aprovou: {action}",
    exportBtn: "Exportar conversa",
    handoffBtn: "Continuar no Mac",
    copyPath: "Copiar caminho",
    copied: "Copiado ✓",
    copyFailed: "Não deu pra copiar o caminho",
    answer: "Responder",
    skip: "Pular",
    customAnswer: "ou escreva sua resposta…",
    approve: "Aprovar",
    deny: "Negar",
    settingsMachine: "Máquina",
    settingsNotifications: "Notificações",
    notifPermission: "Pedidos de permissão",
    notifIdle: "Agente terminou",
    autoMode: "AutoMode",
    autoModeLabel: "Aprovar tudo automaticamente",
    autoModeHint:
      "O agente roda sem pedir aprovação nesta máquina. Tudo fica registrado no audit log e (se ativado) vira notificação.",
    language: "Idioma",
    mcp: "MCP",
    mcpHint: "Conectores de ferramentas ({file}). Mudanças valem para novas conversas.",
    mcpNone: "Nenhum conector.",
    mcpAdd: "+ Adicionar conector",
    mcpName: "nome",
    mcpCommand: "comando (ex: npx -y servidor-mcp)",
    mcpUrl: "https://url-do-servidor",
    mcpAddBtn: "Adicionar",
    saved: "salvo",
    saveError: "erro: {msg}",
    pairedDevices: "Dispositivos pareados ({n})",
    audit: "Auditoria",
    noAudit: "nenhum evento ainda",
    voice: "Voz",
    voiceAutoSend: "Enviar sozinho após transcrição",
    versionMismatch:
      " — versões diferentes: atualize o PWA (puxe pra recarregar) ou o daemon",
    // tab bar
    tabSessions: "Chats",
    tabFiles: "Arquivos",
    tabSettings: "Config",
    // errors
    retry: "Tentar de novo",
    errAgentCrashed: "O agente caiu no meio da resposta — geralmente volta ao tentar de novo.",
    errAttachmentExpired: "O anexo expirou — anexe de novo e envie.",
    errConversationGone: "Essa conversa não existe mais na máquina.",
    errRefused: "O agente recusou o pedido (HTTP {status}).",
    errConnectionLost: "Conexão caiu — sua mensagem tá na fila e sai sozinha quando voltar.",
    errNotPaired: "Sem pareamento ativo — reabra o app ou pareie de novo.",
    errCreateFailed: "Não deu pra criar a conversa — tenta de novo.",
    // session cards
    justNow: "agora",
    // first-run pairing overlay (desktop, P2-007)
    pairOverlayTitle: "Pareie seu celular",
    pairOverlayHint:
      "Escaneie este QR code com o app OpenCode Remote para controlar esta máquina do celular. O tráfego é criptografado ponta a ponta.",
    pairOverlayAlt: "QR code de pareamento",
    pairOverlayLater: "Parear depois",
    // daemon sidecar gave up (desktop, P2-017) — P1-053: o copy aponta pro botão
    // de recuperação no próprio banner; reconectando é a variante ativa.
    daemonDown: "Daemon local caiu — o app parou de tentar reiniciar.",
    reconnectNow: "Reconectar agora",
    reconnecting: "Reconectando ao daemon… ({n})",
  },
} satisfies Record<Lang, Record<string, string>>;
