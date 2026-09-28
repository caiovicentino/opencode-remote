# desktop-flow — histórico de beats e notas de infra do gate

Movido verbatim do `AGENTS.md` em 2026-09-27 (eval-18, eficiência de tokens):
o opencode injeta o `AGENTS.md` no prompt de sistema de todo turno de todo
agente deste repo, e este histórico (~19 KB, ~5 mil tokens) viajava em cada
um desses turnos sem ser instrução. Aqui ele segue consultável sob demanda —
a fonte de verdade dos beats continua sendo `scripts/desktop-flow.test.ts`.

## O que cada tarefa acrescentou ao `npm run test:desktop-flow`

P1-070 adicionou o bloco "local boot" com daemon
hermético real; P1-080 adicionou o repro de overflow do chat: bolha com diff
longo em janela estreita, nada pode sair do viewport; P1-089 adicionou o beat
queue→flush→reentrada com segundo boot hermético contra um fake de opencode:
fila offline drena no reboot, o burst de >500 eventos re-dispara idle antigo e
o count de bolhas fica estável em 3 re-entradas; ids de sessão do gate são
curtos de propósito — path de unix socket no macOS trunca em 104 chars;
P2-069 adicionou o beat de instância única: um segundo Electron real é
spawnado no MESMO userData do keeper e deve sair limpo (lock de instância
única, linha explicando no desktop.log compartilhado) enquanto a primeira
instância mantém exatamente 1 janela; o `open` do harness reporta o userData
minted no JSON de resposta e injeta `OCR_KEEPER_PID` — o app observa o pid do
keeper e sai sozinho (com `app.exit` de graça após 4s) quando o keeper morre,
então keeper SIGKILLado nunca mais vira zumbi de horas;
P2-090 adicionou o beat de auto-abertura de artifact: o daemon emite
`session.artifact` ao detectar escrita em artifacts, o pane abre no idle e
não sobrepõe escolha manual nem o browser pane; P2-091 adicionou a navegação
de artifacts: card do chat → split-pane ao lado, item da lista global → volta
pra Conversas com split-pane (full-screen só em janela estreita), grupos da
lista por título da conversa (daemon resolve id→titulo); P2-092 adicionou o
beat do pane Browser: página de teste colorida carregada no pane real deve
ocupar o bounding box do pane (elemento + viewport do guest), inclusive após
mudança de largura (maximizar); P3-084 adicionou os beats de agrupamento
temporal (Hoje/Ontem/Anteriores) e do switcher ⌘K com preview da última
mensagem — o fake backend serve sessões com `time.updated`; P3-085 adicionou
o beat do bloco de thinking (resposta longa simulada: reasoning expande e
colapsa "Pensou por Xs", caret de streaming, pill ↓ flutuante, autoscroll
que não briga com o leitor); P3-087 adicionou o beat do motion pass: três
evidências — duas 1440x900 com `prefers-reduced-motion` off/on e uma 390x844
(via novo comando
`motion` do harness, Playwright emulateMedia) provando que a media query
global zera toda animação (`animation-name` computado vira `none`); a UI
usa animações 150–300ms ease-out (slide-in/out do painel de artifact com
backdrop, entrada de mensagens, hover da sidebar, transições de pane) e
NADA anima em dados tabulares/auditoria (Mission Control/CSV); P3-407
adicionou o beat de salvar diagnóstico em arquivo: com o hatch
OCR_DESKTOP_DIAG_SAVE_PATH (só vale sob OCR_DESKTOP_SESSION — lição P1-081)
o clique no botão do Settings grava o bundle num caminho temporário e o
arquivo provado sem a URI de pareamento plantada no desktop.log hermético e
com o toast de sucesso em estado terminal; P2-124
adicionou o beat do shell de sidebar nível Claude ("+ Novo" e nav de seções
no topo da coluna de 280px, zero emoji na sidebar, footer de conta abrindo o
seletor de máquina); P2-112
adicionou a jornada degradada do primeiro boot sem daemon (card de status
calmo "conectando pela primeira vez…" no lugar do alerta vermelho, retry
automático visível, feedback real do "Reconectar agora" com spinner+toast e
o hatch de pareamento manual); P3-363 adicionou ao mesmo card a escalada do
retry silencioso: depois de 60s acumulados tentando sozinho, um bloco de
diagnóstico nomeia o daemon local que não responde e abre a seção de
ajuda/diagnósticos (o laço paciente nunca vira um congelamento
indistinguível; P3-394: o detalhe da escalada segue a superfície — no desktop
aponta o botão de diagnósticos do próprio app, no celular manda conferir o
computador ou parear outro dispositivo, nunca um terminal); P2-140 adicionou ao mesmo card calmo o
porquê da morte do daemon local (classificador puro `sidecarexit.ts`
recebe code/signal/cauda de stderr, veredito port-busy/entry-missing/
runtime-error/killed/unknown via `sidecarExit` no `ocr:pairing-state`,
copy acionável sem caminhos nem segredos; o harness honra um
`OCR_DAEMON_ENTRY` real apontado pro script fake que morre com EADDRINUSE);
P3-328 adicionou o beat do aviso no portão de pareamento: o clique real num
item de painel do menu Go (go-pane-artifacts) com o app não pareado agora
mostra o toast "Pareie com sua máquina primeiro…" (`.pair-gate-hint`, acima
do `.pair-overlay`) no próprio portão, em vez de a ação sumir sem feedback;
P3-367 transformou o toast em caminho de saída: um "Parear agora" inline
(`.pair-gate-hint-action`) pula direto pro ceremony manual de pareamento
(`setPairManual(true)`) — no "adicionar máquina" o toast segue sem ação, pois
o ceremony já está na tela; o beat P3-367 do desktop-flow rearma o hint, clica
de verdade no "Parear agora" e prova a saída (toast dispensado + ceremony
manual visível) — probes em `join('|')` porque `JSON.stringify` dentro do
`ipc` volta com escape `\"` do harness e false-faila no regex;
P3-411 deu exit sempre visível ao ceremony manual: o "Voltar" (`.pair-back`)
saiu do fim do fluxo (embaixo do mapa de panes, abaixo da dobra em 1440x900)
e virou controle fixo no topo esquerdo do header de marca sticky — nunca
sai de tela, nem rolando;
P3-362 acabou com o toast genérico e circular do portão: o menu Go agora abre
na tela de portão os mesmos panes offline que o rail já abre (P3-365:
Mission Control, Artifacts, Browser, Settings — `GATE_SHELL_PANES`), em vez de
exigir pareamento com um QR que o próprio daemon caído teria que gerar; nos
demais casos o toast nomeia o que foi pedido ("Pareie com sua máquina primeiro
para abrir Artifacts." — `pairFirstHintFor` com `{pane}`), e um só veredito
`gateShellUp` decide menu e render pra nunca divergirem;
P3-360 deu compositor ao card calmo: a fila offline da primeira mensagem
(`.degraded-queue`, lib `gatequeue.ts` com chave `ocr_gate_queue`) deixa o
primeiro boot digitar de verdade — o texto salvo vira a primeira mensagem da
primeira conversa quando o shell pareia (App consome a fila em `phase ===
"paired"` via `markSendOnOpen` + `createSession(prefill)` e só apaga após a
criação bem-sucedida), então "nada se perde" deixa de ser só copy;
P3-366 estendeu a regra paste-first do desktop (P2-117) ao escape manual do
degradado: o PairingView alcançado por "Parear outro dispositivo manualmente"
(e pelo escape do wizard) recebe `preferPaste={!!desktopBridge()}` — "Parear"
é o botão primário verde e "Escanear QR code" a opção secundária nesse caminho
também (o celular segue scan-first); o beat `P3-366` do desktop-flow prova a
hierarquia de classes pós-clique em `.degraded-manual`;
P3-441 compôs o ceremony manual pro desktop: em 1440px ele renderizava a
coluna de celular (~420px) com ~70% da janela vazia e a lista "Antes de
parear" cortada na dobra (Configurações raspando o fim) — o PairingView agora
separa o conteúdo em duas colunas (`.pair-main` com intro + seções + erro e
`.pair-side` com o mapa de panes) dentro de `.pair-columns`, que o media
query `min-width: 1024px` (mesma fronteira do `isDesktop` do shell) transforma
em grid — abaixo dela os wrappers são blocos transparentes e o fluxo de
coluna única do celular segue idêntico; o header de marca continua filho
direto de `.pair-screen` (fora da composição) para o sticky da P3-423
preservar o scroll container como containing block, e o beat do desktop-flow
provou a composição (largura ≥700, coluna de suporte à direita, mapa inteiro
acima da dobra em 1440x900 e a coluna de celular ≤420 de volta em 390);

## Infra do gate e notas de e2e

Infra do gate (side-fix que chegou pela fila do P3-372, fora do escopo da
tarefa): o reaper ganhou um terceiro fator, escopo por checkout — os slots do
pipeline rodam gates concorrentes na mesma máquina e o pre-flight de um slot
estava SIGKILLando as instâncias herméticas do slot vizinho (mesmos markers
argv+env; a morte silenciosa derrubava o gate com "Target page … has been
closed"). Só morre processo DESTE repo: caminho absoluto do repo no argv ou
`PWD` igual à raiz do repo; PWD ausente/estrangeiro poupa (fail-safe).
P3-345: restart de daemon em e2e espera o `exit` REAL do processo velho via
`waitForChildExit` (`scripts/daemonrestart.ts`, escalando para SIGKILL após
grace) — nunca sleep fixo, senão dois daemons dividem a sala do relay e o
relay roteia frames pro processo morto; e retry de op e2e (`send`) só vale
para as rotas de chunk — op que consome estado no servidor
(`upload/complete`, `POST /session/*/message`) não se reenvia.
P2-117 adicionou os beats da tela Scan-QR: boot camera-blocked
(`OCR_DESKTOP_CAMERA_BLOCK=1`) prova o estado indisponível com CTA de colar
código e boot com câmera fake (`OCR_DESKTOP_MEDIA_FAKE=1`, switches
`--use-fake-device-for-media-stream` no harness) prova preview ativo em 390px
e feed morto → "NO SIGNAL" → indisponível. P2-312 reaproveita o mesmo hatch
pro veredito de microfone: o IPC `app:micAccess` (módulo puro
`apps/desktop/src/micaccess.ts`, lido a cada pedido, nunca no boot) responde
`denied` quando o hatch está ligado, e o ChatView troca o conselho de iOS pela
frase estática em português do veredito com a ação "Abrir ajustes do sistema"
— o alvo do painel (macOS `x-apple.systempreferences:` / Windows
`ms-settings:`) abre pelo mesmo portão de link externo de `extlink.ts`, que
agora admite esses dois esquemas inertes de ajustes do sistema. P2-319 estende
o mesmo veredito pra câmera do scanner de pareamento: o IPC `app:camAccess`
(módulo puro `apps/desktop/src/camaccess.ts`, mesma leitura a cada pedido)
substitui a frase estática de permissão negada pela frase acionável do
veredito com a ação "Abrir ajustes do sistema" quando a ponte do shell está
presente — no telefone a frase do dicionário segue intacta. P3-404 acrescenta o
screen-peek "Ver a tela": o botão de monitor do composer abre o card "Tela da
máquina" no PWA — um único frame por pedido explícito (nunca streaming), com
timestamp, "Atualizar" e "Perguntar sobre a tela", que manda o frame pelo
pipeline de anexo existente (attachImage → ocr-upload://) com a pergunta como
text part; a captura acontece sempre no shell desktop (contexto responsável do
TCC — `app:captureScreen`/`app:listScreens`/`app:screenAccess` sob demanda,
com o veredito puro de `apps/desktop/src/screenaccess.ts` espelhando
camaccess.ts, sessão hermética responde frame sintético fixo antes de
qualquer captura real, regra P2-326), o daemon só casa pedido→frame em memória
(`/__ocr/screen/request|frames|frame|failed`, frame único com TTL de 30min,
eventos `screen.capture-requested`/`screen.frame`/`screen.capture-failed`), o
shell acusa a captura num flash de indicador com picker de telas/janelas em
multi-display, e o card no telefone escapa com instrução nomeada quando o app
desktop não responde. P2-321 fecha a
cega de supervisionamento que sobrava: um daemon que trava VIVO (porta ligada,
event loop preso) nunca sai, então o handler de saída nunca dispara respawn —
depois do primeiro boot saudável o próprio filho passa a ser sondado
(`healthOnce`, mesmo endpoint loopback, zero porta/rota/ouvinte novo) e o
veredito puro de `sidecarwedge.ts` (observe/degraded/restart/give-up, teto de
1 recuperação consecutiva, contador zerado na primeira sonda saudável) manda
parar via `sidecarstop`/respawn existentes; o veredito viaja no campo aditivo
`sidecarWedge` do `ocr:pairing-state` e no desktop.log (o hatch
`OCR_DAEMON_WEDGE_PROBE_MS` encurta o intervalo em teste). P2-335 fecha a
cega equivalente no laço de reconexão do relay: um relay hospedado atualizado
de forma incompatível (fio `RELAY_WIRE_PROTOCOL` diferente) era
indistinguível de relay temporariamente fora do ar e deixava a máquina
reconectando para sempre — agora o laço consulta o plano puro de
`relayprotocol.ts` (sem rede/fs/timer; consulta só dentro do caminho de retry
existente, zero timer/rota/ouvinte novo) e, depois de 3 ciclos de discagem
falhos consecutivos, fora da janela de throttle de 10min e sem mismatch já
conhecido, faz UMA requisição best-effort ao `/healthz` derivado do endereço
ws/wss (5s de timeout, corpo limitado a 4KB, qualquer erro degrada para
unknown) comparando o campo `protocol` da P2-331 com a constante importada de
`@ocr/protocol`; o campo aditivo `relayProtocol` em `/api/health` (ao lado de
`relayConnected`/`relayRetry`) carrega o conjunto fechado ok/mismatch/legacy/
unknown com uma frase estática curta sem URL/host/IP/porta/número de versão,
uma única linha de log por transição de estado — só mismatch é veredito duro,
todo o resto preserva o comportamento de hoje byte a byte (um frame entregue
pelo relay encerra o streak e suplanta um mismatch velho, então consertar o
relay se auto-cura). P2-338: a fatia de UI consome o campo — o shell desktop
sanitiza `relayProtocol.state` para o conjunto fechado em
`apps/desktop/src/relaylink.ts` (`sanitizeRelayProtocolState`, fail-closed
para nulo: ausente/nulo/fora do conjunto/objeto sem `state` degradam a nulo),
e `linkVerdict` sozinho não muda nenhum veredito de hoje: `local` vence tudo,
payload legado sem `relayConnected` continua `unknown`, `misconfigured`
continua antes, um link VIVO vence um mismatch velho (o daemon se auto-cura)
e só então um mismatch gravado vira o estado aditivo `incompatible` —
"o relay hospedado fala um protocolo de fio diferente deste app — atualize o
app ou o relay hospedado e aguarde a reconexão" — antes de `refused` e
`dialing`, com ok/legacy/unknown mantendo o comportamento byte a byte. A
linha do PairingOverlay e a bandeja (`traystatus.ts` trata `incompatible`
como aviso igual a `refused`, sem item de menu novo) param de dizer
"reconectando, aguarde e rescaneie" — a espera infinita tem nome.
relay se auto-cura). A fatia de UI que consome o campo vem depois. P2-339 dá
dente ao veredito: com mismatch gravado, um piso documentado de 5 minutos
entra no MESMO max do `retryInMs` no close handler (`relayProtocolDialFloorMs`
puro em relayprotocol.ts; ok/legacy/unknown/valor fora do conjunto = piso
zero), `relayRetryFloorSource` ganha o valor aditivo `protocol-mismatch`
exposto como `relayRetry.floorSource` em `/api/health` sem chave nova
(relay-close mantém prioridade sobre ele), e a rota de redial da P2-327 pode
antecipar a espera protocol-mismatch — o clique humano de reconectar depois
de atualizar app ou relay — respeitando o throttle de 10s, enquanto
relay-close segue nunca antecipável. P2-337 deu saída ao aviso de
indisponibilidade do overlay de pareamento: numa instalação nova o relay é
loopback, `pairWebAppUnavailable` era só texto dentro do diálogo modal e o
usuário de primeiro minuto tinha que fechar tudo e caçar Config → Relay do
celular; o PairingOverlay agora carrega uma ação inline "Abrir Config"
(`.pair-webapp-openconfig`, padrão P3-367) renderizada SOMENTE quando o App
entrega o manipulador — o telefone e as superfícies sem pane (unpaired
clássico, adicionar máquina) seguem só de texto; App.tsx é o único dono
(lição P3-398): o clique dispensa o overlay (mesmo contrato do "Parear
depois"), chama o `openPane("settings")` existente e registra um pedido de
foco de seção de uso único (`relayFocusTick`/`onRelayFocusConsumed`, mesmo
contrato do focusQueueTick da P3-406); o SettingsView marca o bloco de relay
com `data-relay-setting` (atributo independente de copy, lição P3-421),
segura o pedido pendente até o card existir (a leitura desktop-only resolve
um instante depois do mount), rola o bloco até a área visível respeitando
prefers-reduced-motion (helper `scrollBehavior` compartilhado em
lib/motion.ts) e põe o caret no campo do endereço uma única vez, avisando o
consumo por callback — o App zera o tick, então remount nunca repete o bump.
P2-346 deu nome ao primeiro boot numa pasta de dados sem escrita: uma
instalação nova com userData sem permissão (ou volume read-only ou disco
cheio) deixava o sidecar falhando em silêncio e o cartão calmo prometendo
"Tentando sozinho…" para sempre — o módulo puro novo
`apps/desktop/src/storageprobe.ts` (sem node:fs, sem timer, sem import)
classifica o resultado de UMA sonda injetada (grava e apaga um arquivo
temporário pequeno dentro do userData, em `onReady` ANTES de iniciar o
sidecar) no conjunto fechado ok/no-permission/read-only/disk-full/unknown com
frase estática curta em pt-BR (sem caminho, sem nome de usuário, sem errno
crua); o main.ts grava uma única linha `storage probe:` no desktop.log e o
veredito viaja no campo aditivo `storage` do `ocr:pairing-state` (as quatro
variantes de payload: daemon-down, reconnecting, tick saudável e fallback do
wedge); no apps/web, `sanitizeStorageVerdict` em `lib/degraded.ts`
(fail-closed ao padrão P2-338: ausente/nulo/fora do conjunto/objeto
malformado/mensagem vazia → nulo e o comportamento de hoje byte a byte) e o
cartão degradado troca a linha de retry pela frase do veredito SOMENTE com
estado não-ok (`.degraded-storage`, tom warn — P3-371: estado fala warn, a
ação fica no accent); a paridade do conjunto fechado entre desktop e web é
pinada por teste que lê as duas fontes reais, e a asserção de fonte prova uma
sonda só no boot e nenhum setInterval novo.
P2-355 transformou a caça a olho do explorer (cabeçalho da marca cisalhado,
linhas da sidebar chegando tarde, mapa de panes saltando) em guarda
determinística pela Layout Instability API — a técnica do post do Claude
(how we made claude.ai faster): o módulo puro `apps/web/src/lib/shiftgate.ts`
(sem React, sem DOM no import) classifica cada entrada como valor — regras
nesta ordem: entrada malformada ignora em falha fechada, `hadRecentInput`
ignora, valor abaixo do limiar documentado (`SHIFT_THRESHOLD = 0.001`,
escala medida: sidebar inteira andando ~5px ≈ 0.001, card empurrado por
chegada tardia ≈ 0.005 — transform-only e entrada de novo conteúdo nunca
produzem entrada) ignora, região fora da lista (`SHIFT_REGIONS`:
brand-header/sidebar/pane-map, atribuída via `data-region` nos contêineres
que o explorer caçou, paridade pinada por teste contra as fontes reais) vira
unnamed, e só então shift nomeado; o beat P2-355 do desktop-flow instala um
PerformanceObserver com `buffered: true` logo após o open (entradas da carga
voltam do buffer do browser), espera o estado assentado (buffer quieto por
duas sondas seguidas), lê o buffer UMA vez, roda o classificador em cada
entrada e prova zero shifts nomeados no main de hoje — unnamed impresso como
aviso, falha fechada apenas quando o observador não instala; a atribuição de
região acontece QUANDO a entrada dispara (data-region ou seletor curto do nó
vivo — só nome e valor entram no buffer, nunca um nó atravessando o IPC) e o
observador desconecta na leitura, para o remount de 390px nunca poluir o
buffer; asserção em scripts/unit.test.ts lê o beat real e prova a ordem
open < install < settle < read < shots.
