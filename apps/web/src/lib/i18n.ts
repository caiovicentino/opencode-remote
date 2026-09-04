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

/**
 * P2-118: resolve copy for an explicit lang from the same dictionary useT
 * reads — for code outside React (tests, plain callbacks) so every screen
 * resolves to one locale, never a mix.
 */
export function translate(l: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = (dict[l] as Record<string, string>)[key] ?? (dict.en as Record<string, string>)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function useT() {
  useSyncExternalStore(subscribe, getLang);
  return (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);
}

export const dict = {
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
    autoFailed: "AutoMode couldn't approve: {action} — manual review needed",
    alreadyResolved: "Permission already resolved",
    permResolvedLine: "resolved",
    permAutoLine: "auto-approved",
    autoBadge: "AutoMode — actions approved automatically",
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
    connLocal: "Connection: direct (local)",
    connRelay: "Connection: via relay",
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
    // first-run splash (desktop, P1-050): promise the first value in <60s
    splashValue: "Control this machine from your phone. Your agent, your code — end-to-end encrypted.",
    splashStep1: "Open OpenCode Remote on your phone",
    splashStep2: "Scan this pairing code",
    splashStep3: "Send your first message — audio, photo or text",
    splashUnder: "First value in under a minute.",
    // diagnostics (desktop settings, P1-050)
    diagTitle: "Diagnostics",
    diagCopy: "Copy diagnostic",
    diagCopied: "Diagnostic copied — paste it into your support message",
    // daemon sidecar gave up (desktop, P2-017) — P1-053: the copy points to the
    // in-banner recovery button; the reconnecting state is the active variant.
    daemonDown: "Local daemon is down — the app stopped retrying.",
    reconnectNow: "Reconnect now",
    reconnecting: "Reconnecting to daemon… ({n})",
    // version mismatch banner (desktop, P3-054): healthy but stale daemon.
    // Key is daemonMismatch: versionMismatch already names the PWA copy above.
    daemonMismatch: "Daemon v{d} · app v{a} — restart the daemon.",
    // explicit remote-pairing entry + local auto-connect (desktop, P1-070)
    pairRemoteTitle: "Pair a phone (remote device)",
    pairRemoteHint:
      "Show the pairing QR to control this machine from your phone — traffic is end-to-end encrypted.",
    pairRemoteAction: "Show pairing QR",
    localConnecting: "Connecting to the local daemon…",
    // degraded first-boot journey (desktop, P2-112): a dead daemon on first
    // boot is never a dead end — calm status, visible auto-retry, minimal
    // local data, and the manual pairing screen one click away.
    firstContactTitle: "Connecting for the first time…",
    firstContactHint:
      "Conversations, files and artifacts sync as soon as the local daemon answers. Nothing is lost — this screen keeps trying on its own.",
    degradedRetrying: "Retrying automatically…",
    degradedDownHint:
      "Automatic retries stopped. Use Reconnect now — or just wait: the app reconnects by itself when the daemon is back.",
    degradedLocalTitle: "Available offline",
    degradedLocalHint: "Language and theme live on this machine — they work right now.",
    degradedPairManually: "Pair another device manually",
    reconnectTrying: "Trying…",
    reconnectStarted: "Daemon restart started — the app reconnects on its own.",
    reconnectFailed: "Could not restart the daemon — try again in a moment.",
    // command palette (desktop, P1-046)
    palettePlaceholder: "Search conversations and actions…",
    paletteEmpty: "No matches",
    paletteNewChat: "New conversation",
    paletteOpenArtifacts: "Open Artifacts",
    paletteOpenBrowser: "Open Browser",
    paletteOpenFiles: "Open Files",
    paletteOpenSettings: "Open Settings",
    paletteKindAction: "action",
    paletteKindSession: "conversation",
    // mission control (desktop, P2-048)
    paletteOpenMission: "Open Mission Control",
    missionDesktopOnly: "Mission Control reads the pilot's local records — open the app on the host machine.",
    missionLoading: "Loading agent sessions…",
    missionEmpty: "No agent sessions recorded yet.",
    missionSelect: "Select a session to open its forensic timeline.",
    missionSt_running: "running",
    missionSt_merged: "merged",
    missionSt_failed: "failed",
    missionEffort: "effort",
    missionRounds: "{n} round(s)",
    missionEta: "ETA",
    missionGateFails: "{n} gate fail(s)",
    missionF_all: "all",
    missionF_decision: "decisions",
    missionF_gate: "gate",
    missionF_review: "review",
    missionF_deploy: "deploy",
    missionTakeover: "Take over",
    missionTakenOver: "Terminal opened on the host, attached to the agent's session.",
    missionNoEntries: "No forensic entries for this filter.",
    missionShots: "Post-deploy shots",
    missionLiveShot: "Live dashboard shot",
    missionLive: "Live",
    unitMin: "min",
    // pairing screen (P2-049). P1-070: local-first wording — the desktop
    // auto-connects to the daemon on the same machine, no code needed there.
    pairIntro:
      "OpenCode Remote pairs with the daemon on this machine automatically — no code needed here. To connect from another device, scan the daemon's QR or paste a pairing code. Traffic is end-to-end encrypted; the relay cannot read it.",
    scanQr: "Scan QR code",
    orPaste: "— or paste manually —",
    pairBtn: "Pair",
    connecting: "Connecting…",
    invalidCode: "Invalid pairing code",
    // chat composer + header (P2-049)
    send: "Send",
    messagePlaceholder: "Message the agent…",
    recording: "recording…",
    streamingWait: "Agent is streaming — wait or Stop",
    thinkingLive: "Thinking…",
    thoughtFor: "Thought for {n}s",
    thoughtLabel: "Thought",
    attachFile: "Attach file",
    micNeedsPermission: "Microphone unavailable — allow access to record voice",
    modelSelector: "Agent and model",
    defaultModel: "default model",
    stopRecording: "Stop recording",
    recordVoice: "Record voice",
    voiceReply: "Speak replies",
    voiceReplyOn: "Replies are spoken — click to mute",
    stopSpeaking: "Stop speaking",
    voiceReplyUnavailable: "Spoken replies unavailable on this host",
    toolActivity: "tool activity",
    noToolCalls: "no tool calls observed yet",
    refreshTools: "Refresh tool history",
    agentMode: "Agent mode",
    agentOption: "agent",
    model: "Model",
    openArtifact: "Open artifact",
    trimStart: "Trim start (s)",
    trimEnd: "Trim end (s)",
    attach: "Attach",
    full: "Full",
    removeImage: "Remove image",
    olderMessages: "{n} older messages",
    loadingDiff: "loading diff…",
    changesFor: "changes for {action}",
    noChanges: "no file changes yet for this request",
    close: "Close",
    queuedTitle: "queued — will send when back online",
    connTitle: "connection: {status}",
    sessionFallback: "session",
    ctxGauge: "Context usage",
    ctxGaugeDetail: "Context: {pct}% of the model window ({tokens} of {window} tokens)",
    recapLabel: "Recap",
    recapDetail: "Where the conversation left off",
    jumpToEnd: "Go to end",
    resizeSplit: "Resize artifact preview",
    // a11y (P2-049)
    rename: "Rename",
    delete: "Delete",
    // chat history paging + session list grouping (P1-064)
    loadMore: "Load older messages",
    historyRetry: "Could not load the conversation history.",
    pilotGroup: "Pilot sessions ({n})",
    // temporal grouping + archive (P3-084)
    groupToday: "Today",
    groupYesterday: "Yesterday",
    groupEarlier: "Earlier",
    groupArchived: "Archived ({n})",
    archive: "Archive",
    restore: "Restore",
    // QR scanner (in-app camera, P2-118) — connection screen copy must follow
    // the app locale like the daemon banners around it.
    scanPairingTitle: "Scan pairing code",
    scanPointCamera: "Point the camera at the QR code shown by the daemon.",
    scanBackManual: "Back to manual pairing",
    camDenied:
      "Camera permission denied. Allow camera access for this site (Settings → Safari → Camera) and try again.",
    camNotFound: "No camera found on this device.",
    camBusy: "Camera is in use by another app. Close it and try again.",
    camInterrupted:
      "Camera was interrupted. Tap Scan again — iOS sometimes aborts the first attempt.",
    camUnavailable: "camera unavailable",
    // desktop empty state (P2-118): same shell as the daemon banners — copy
    // must not mix locales. {machine} is ", <name>" or "".
    deskGreeting: "hello{machine}!",
    deskEmptyHint: "Select a conversation in the sidebar",
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
    autoFailed: "AutoMode não conseguiu aprovar: {action} — aprove manualmente",
    alreadyResolved: "Permissão já resolvida",
    permResolvedLine: "resolvida",
    permAutoLine: "auto-aprovada",
    autoBadge: "AutoMode — ações aprovadas automaticamente",
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
    connLocal: "Conexão: direta (local)",
    connRelay: "Conexão: via relay",
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
    // first-run splash (desktop, P1-050): promessa do 1º valor em <60s
    splashValue: "Controle esta máquina do celular. Seu agente, seu código — criptografia ponta a ponta.",
    splashStep1: "Abra o OpenCode Remote no celular",
    splashStep2: "Escaneie este código de pareamento",
    splashStep3: "Mande a primeira mensagem — áudio, foto ou texto",
    splashUnder: "Primeiro valor em menos de 1 minuto.",
    // diagnostics (desktop settings, P1-050)
    diagTitle: "Diagnóstico",
    diagCopy: "Copiar diagnóstico",
    diagCopied: "Diagnóstico copiado — cole na sua mensagem de suporte",
    // daemon sidecar gave up (desktop, P2-017) — P1-053: o copy aponta pro botão
    // de recuperação no próprio banner; reconectando é a variante ativa.
    daemonDown: "Daemon local caiu — o app parou de tentar reiniciar.",
    reconnectNow: "Reconectar agora",
    reconnecting: "Reconectando ao daemon… ({n})",
    // banner de mismatch de versão (desktop, P3-054): daemon vivo, mas velho.
    daemonMismatch: "Daemon v{d} · app v{a} — reinicie o daemon.",
    // entrada explícita de pareamento remoto + auto-conexão local (P1-070)
    pairRemoteTitle: "Parear um celular (dispositivo remoto)",
    pairRemoteHint:
      "Mostra o QR de pareamento para controlar esta máquina do celular — tráfego criptografado ponta a ponta.",
    pairRemoteAction: "Mostrar QR de pareamento",
    localConnecting: "Conectando ao daemon local…",
    // jornada degradada no primeiro boot (desktop, P2-112): daemon morto no
    // primeiro contato nunca vira beco sem saída — status calmo, retry
    // automático visível, dados locais mínimos e o pareamento a um clique.
    firstContactTitle: "Conectando pela primeira vez…",
    firstContactHint:
      "Conversas, arquivos e artifacts sincronizam assim que o daemon local responder. Nada se perde — esta tela segue tentando sozinha.",
    degradedRetrying: "Tentando sozinho…",
    degradedDownHint:
      "As tentativas automáticas pararam. Use Reconectar agora — ou espere: quando o daemon voltar, o app reconecta sozinho.",
    degradedLocalTitle: "Disponível offline",
    degradedLocalHint: "Idioma e tema ficam nesta máquina — funcionam agora.",
    degradedPairManually: "Parear outro dispositivo manualmente",
    reconnectTrying: "Tentando…",
    reconnectStarted: "Reinício do daemon iniciado — o app reconecta sozinho.",
    reconnectFailed: "Não deu pra reiniciar o daemon agora — tente de novo em instantes.",
    // command palette (desktop, P1-046)
    palettePlaceholder: "Buscar conversas e ações…",
    paletteEmpty: "Nada encontrado",
    paletteNewChat: "Nova conversa",
    paletteOpenArtifacts: "Abrir Artifacts",
    paletteOpenBrowser: "Abrir Browser",
    paletteOpenFiles: "Abrir Arquivos",
    paletteOpenSettings: "Abrir Configurações",
    paletteKindAction: "ação",
    paletteKindSession: "conversa",
    // mission control (desktop, P2-048)
    paletteOpenMission: "Abrir Mission Control",
    missionDesktopOnly: "O Mission Control lê os registros locais do pilot — abra o app na máquina host.",
    missionLoading: "Carregando sessões de agente…",
    missionEmpty: "Nenhuma sessão de agente registrada ainda.",
    missionSelect: "Selecione uma sessão para abrir a timeline forense.",
    missionSt_running: "rodando",
    missionSt_merged: "merged",
    missionSt_failed: "falhou",
    missionEffort: "esforço",
    missionRounds: "{n} rodada(s)",
    missionEta: "ETA",
    missionGateFails: "{n} falha(s) de gate",
    missionF_all: "tudo",
    missionF_decision: "decisões",
    missionF_gate: "gate",
    missionF_review: "review",
    missionF_deploy: "deploy",
    missionTakeover: "Assumir",
    missionTakenOver: "Terminal aberto no host, anexado à sessão do agente.",
    missionNoEntries: "Sem registros forenses para este filtro.",
    missionShots: "Shots pós-deploy",
    missionLiveShot: "Shot ao vivo do dashboard",
    missionLive: "Ao vivo",
    unitMin: "min",
    // pairing screen (P2-049). P1-070: copy local-first — o desktop se conecta
    // sozinho ao daemon da mesma máquina, sem código aqui.
    pairIntro:
      "O OpenCode Remote se conecta sozinho ao daemon desta máquina — nenhum código é necessário aqui. Para conectar de outro dispositivo, escaneie o QR do daemon ou cole um código de pareamento. O tráfego é criptografado ponta a ponta; o relay não consegue lê-lo.",
    scanQr: "Escanear QR code",
    orPaste: "— ou cole manualmente —",
    pairBtn: "Parear",
    connecting: "Conectando…",
    invalidCode: "Código de pareamento inválido",
    // chat composer + header (P2-049)
    send: "Enviar",
    messagePlaceholder: "Mensagem pro agente…",
    recording: "gravando…",
    streamingWait: "Agente respondendo — espere ou Pare",
    thinkingLive: "Pensando…",
    thoughtFor: "Pensou por {n}s",
    thoughtLabel: "Pensou",
    attachFile: "Anexar arquivo",
    micNeedsPermission: "Microfone indisponível — permita o acesso pra gravar voz",
    modelSelector: "Agente e modelo",
    defaultModel: "modelo padrão",
    stopRecording: "Parar gravação",
    recordVoice: "Gravar voz",
    voiceReply: "Falar respostas",
    voiceReplyOn: "Respostas faladas — clique pra silenciar",
    stopSpeaking: "Parar fala",
    voiceReplyUnavailable: "Respostas faladas indisponíveis neste host",
    toolActivity: "atividade de tools",
    noToolCalls: "nenhuma tool chamada ainda",
    refreshTools: "Atualizar histórico de tools",
    agentMode: "Modo do agente",
    agentOption: "agente",
    model: "Modelo",
    openArtifact: "Abrir artifact",
    trimStart: "Início do corte (s)",
    trimEnd: "Fim do corte (s)",
    attach: "Anexar",
    full: "Completo",
    removeImage: "Remover imagem",
    olderMessages: "{n} mensagens anteriores",
    loadingDiff: "carregando diff…",
    changesFor: "mudanças de {action}",
    noChanges: "sem mudanças de arquivos neste pedido",
    close: "Fechar",
    queuedTitle: "na fila — envia quando voltar a conexão",
    connTitle: "conexão: {status}",
    sessionFallback: "sessão",
    ctxGauge: "Uso de contexto",
    ctxGaugeDetail: "Contexto: {pct}% da janela do modelo ({tokens} de {window} tokens)",
    recapLabel: "Recap",
    recapDetail: "Onde a conversa parou",
    jumpToEnd: "Ir pro fim",
    resizeSplit: "Redimensionar preview do artifact",
    // a11y (P2-049)
    rename: "Renomear",
    delete: "Apagar",
    // chat history paging + session list grouping (P1-064)
    loadMore: "Carregar mensagens anteriores",
    historyRetry: "Não deu pra carregar o histórico da conversa.",
    pilotGroup: "Sessões do pilot ({n})",
    // agrupamento temporal + arquivo (P3-084)
    groupToday: "Hoje",
    groupYesterday: "Ontem",
    groupEarlier: "Anteriores",
    groupArchived: "Arquivadas ({n})",
    archive: "Arquivar",
    restore: "Restaurar",
    // scanner de QR (câmera in-app, P2-118)
    scanPairingTitle: "Escanear código de pareamento",
    scanPointCamera: "Aponte a câmera pro QR code mostrado pelo daemon.",
    scanBackManual: "Voltar ao pareamento manual",
    camDenied:
      "Permissão de câmera negada. Permita o acesso pra este site (Ajustes → Safari → Câmera) e tente de novo.",
    camNotFound: "Nenhuma câmera encontrada neste dispositivo.",
    camBusy: "A câmera está em uso por outro app. Feche-o e tente de novo.",
    camInterrupted:
      "A câmera foi interrompida. Toque em Escanear de novo — o iOS às vezes aborta a primeira tentativa.",
    camUnavailable: "câmera indisponível",
    // estado vazio do desktop (P2-118): mesma tela dos banners de daemon.
    deskGreeting: "olá{machine}!",
    deskEmptyHint: "Selecione uma conversa na barra lateral",
  },
} satisfies Record<Lang, Record<string, string>>;
