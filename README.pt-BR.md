# OpenCode Remote

[🇧🇷 Português](README.pt-BR.md) | 🇬🇧 [English](README.md)

Controle o agente [opencode](https://opencode.ai) da sua máquina pelo celular,
de qualquer lugar. **Sua máquina, seu código, suas chaves** — nada sai do seu
hardware; o relay é um tubo cego que não consegue ler o tráfego.

```
[PWA (celular)] ⇄ [Relay] ⇄ [Daemon] ⇄ [opencode serve]
   passkey+QR      cego       E2E          localhost
```

<p align="center">
  <a href="assets/demo.mp4"><img src="assets/demo-poster.jpg" width="300" alt="Demo do OpenCode Remote — clique pra assistir"></a>
</p>

## Por que existe

Claude Code, Codex e companhia rodam o agente no cloud *deles*. O OpenCode
Remote roda na **sua** máquina — filesystem completo, terminal de verdade,
suas chaves, qualquer modelo — e entrega um cockpit no celular com
criptografia ponta a ponta. O relay nunca vê plaintext: mesmo um relay
hospedado continua privado. Esse é o produto: **poder local, controle
remoto, zero confiança**.

## O que você ganha

- **Chat completo** com streaming, markdown, imagens e histórico de ferramentas;
  o header do chat mostra o título da conversa (o genérico "session" enquanto
  a sessão ainda não tem título); conversa nova mostra um empty state de
  boas-vindas com dicas rápidas (áudio, foto ou texto). A conversa só acompanha
  a mensagem nova automaticamente quando você já está no fim — ao rolar pra
  cima, um botão ↓ aparece pra voltar ao fim sem roubar a leitura; se a conexão
  cair, um banner fino com o contador de tentativas de reconexão substitui o
  antigo dot do header. Blocos de código e linhas longas nunca cortam na borda
  direita: texto e URLs quebram linha e blocos largos de código/diff rolam
  horizontalmente dentro do próprio bloco — nada sai do viewport (chat, modal
  de diff e painel de artifact)
- **AutoMode** — o agente roda solto; toda aprovação automática vira auditoria
  (e notificação, se você quiser). Com o AutoMode ligado o chat não mostra
  card de aprovação para pedidos auto-aprovados — só um badge passivo. Quando
  a aprovação automática falha (uma tentativa rápida a mais, depois falha
  final), o pedido não trava em silêncio: uma nota vermelha aparece acima do
  composer e o pedido vira um card acionável normal pra revisão manual.
  Pedidos já respondidos viram linha "resolvida", duplicatas do mesmo pedido
  aparecem uma vez só e tocar num card velho diz "Permissão já resolvida"
  em vez de um 404 cru
- **Preview de aprovação** — o card de permissão mostra as primeiras linhas
  do comando/patch pedido (direto do evento de permissão) antes de aprovar
  ou negar, pra você sempre saber o que está liberando
- **Perguntas interativas** — o modelo pergunta, você toca na opção
- **Rewind** — volte a conversa *e o código* pra qualquer ponto, num toque
- **Gauge de contexto** — quando a janela de contexto do modelo é conhecida, o
  cabeçalho do chat mostra o quanto dela está ocupada na sessão (soma de
  tokens do opencode, amarelo a partir de 70%, vermelho a partir de 85%),
  atualizado sempre que o agente fica ocioso
- **Recap fixado** — uma linha embaixo do composer mostra onde a conversa
  parou: a primeira sentença da última resposta do agente (ou o summary da
  sessão, quando existir)
- **Voz** — segure e fale, transcrição local com whisper, sem nuvem
- **Arquivos** — envie do celular, dê preview de tudo, exporte a conversa
  em markdown; todo card de arquivo tem um botão ⧉ que copia o caminho
  completo do arquivo (Clipboard API com fallback execCommand)
- **Handoff** — continue a sessão exata no Mac (botão 💻)
- **Painel ao vivo** — estado de cada sessão: trabalhando, esperando aprovação,
  fez pergunta, pronto, erro; cards mostram o tempo relativo da última
  atividade (`5m`, `2h`, `3d`); sessões ficam ordenadas da mais recente
  para a mais antiga
- **Filtro de sessões** — chips acima da busca (Todas / Com badge / Sem badge)
  filtram o painel pelas conversas com ou sem badge de não-lidas
- **Troca rápida de sessão (P1-064)** — abrir uma conversa busca só as últimas
  50 mensagens (paginação no daemon com `?limit&before`, medida em bytes
  exatos — outputs gigantes de tool são aparados — pra caber no limite de
  frame do relay); histórico mais antigo carrega sob demanda no botão
  "Carregar mensagens anteriores" ou rolando até o topo. As últimas 3 conversas
  visitadas ficam em cache na memória: voltar pra elas repinta na hora (um
  refetch em segundo atualiza a cauda), e fetch de histórico que estoura
  timeout mostra erro com botão "Tentar de novo" em vez de skeleton eterno.
  Sessões com título no padrão do pilot (`P3-123 …`) colapsam num grupo
  "Sessões do pilot" no fim do painel. A batida é pelo id de task em
  qualquer parte do título (a heurística não adivinha intenção), então uma
  conversa sua que menciona ex. `P2-049` no título também agrupa — renomeie
  pra tirar do grupo
- **Rascunho por conversa (P1-088)** — o campo de mensagem guarda um rascunho
  por conversa: alternar de sessão no meio da digitação não perde nem mistura
  texto; enviar limpa só o rascunho da conversa onde você enviou
- **Rotinas** — cron de verdade: diário, dias da semana ou loop por intervalo
- **Seguro por construção** — gate com passkey (WebAuthn), ECDH P-256 +
  AES-256-GCM, anti-replay, allowlist de dispositivos, audit log, biometria
- **BYOM** — opencode suporta qualquer provider; escolha o modelo por sessão
- **API + SDK** — dirija sessões por código (`packages/sdk`)
- **Artifacts** — o agente escreve documentos (html, md, csv, pdf) em
  `~/.opencode-remote/artifacts/<sessionId>/`; o app desktop ganha um **pane
  Artifacts** que lista e renderiza tudo dentro do app (html sandboxed,
  markdown/tabelas, PDF inline) e mensagens do chat que citam um artifact
  ganham um card anexado; em telas com ≥ 900 px de largura, clicar no card abre
  a prévia num **painel lateral** ao lado do chat (divisor arrastável, o chat
  continua visível e navegável — estilo Claude/Codex); em telas mais estreitas
  vale o overlay em tela cheia de antes; também listável via `GET /api/artifacts`.
  A lista global de Artifacts agrupa por **título da conversa** (o daemon resolve
  os ids de sessão contra a lista de sessões do opencode; ids desconhecidos caem
  de volta pro id cru) e, em telas largas, clicar num item da lista volta pra
  Conversas com a prévia no painel lateral — sem desvio em tela cheia.
  Toda sessão criada pelo daemon carrega o protocolo de artifacts — ele é
  injetado no system prompt do agente mesmo em workspaces sem `AGENTS.md`
  (um AGENTS.md do workspace que já documenta o protocolo suprime a injeção;
  sessões criadas direto no CLI/TUI do opencode não são tocadas). O registro
  de sessões injetadas vive em memória: sessões criadas antes de um restart
  do daemon não são re-injetadas depois — apenas as criadas pelo daemon novo
- **App desktop (inicial)** — shell Electron com a mesma UI, com tray e menu nativo;
  inclui um **pane Browser**: no shell desktop ele renderiza um `<webview>` Electron real e
  sandboxed (scroll, click e edit funcionam como num navegador; `contextIsolation`/`sandbox`
  ligados, `nodeIntegration` desligado, popups desligados), com barra de URL editável, reload
  e botão maximizar (~80% de largura). O modo screenshot via Playwright (`/api/browse`) segue
  como fallback no PWA e como superfície de browse dos reviewers (`tools/browse.mjs`)
- **Primeiro boot degradado (P2-112)** — com o daemon local inacessível no primeiro
  contato, o app não trava mais no pareamento: um cartão calmo ("Conectando pela
  primeira vez…" — nunca um alerta vermelho de "daemon caiu" pra um daemon nunca
  visto) explica que conversas, arquivos e artifacts sincronizam quando o daemon
  responder, mostra o retry automático visível, mantém os dados locais (idioma, tema)
  funcionando, dá feedback real no "Reconectar agora" (spinner + toast) e deixa o
  pareamento manual a um clique
- **Auto-preview** — quando o agent menciona uma URL `http(s)://localhost:<porta>` /
  `127.0.0.1:<porta>` na resposta, o daemon emite um evento sintético `ocr.preview`
  (parse determinístico de URL, dedupe por sessão por 10 minutos) e o app desktop abre o
  pane Browser lado a lado com o chat, apontando pra URL, com botão de voltar pro chat.
  No PWA o evento é ignorado (o localhost da máquina não é alcançável do celular)
- **Mission Control** — pós-mortem navegável das runs autônomas do pilot no app desktop:
  um card por tarefa de agente (objetivo, progresso, esforço, ETA) e uma timeline forense
  lida do `pilot.log`/`events.jsonl` real (decisões, vereditos de reviewers, falhas de gate
  com tail do output, deploys), shots pós-deploy, shot ao vivo do dashboard e **Assumir**
  em um clique (Terminal anexado à sessão opencode do agente); também servido via
  `GET /api/pilot-forensic`
- **Linguagem de ícones consistente** — todos os ícones de chrome (nav desktop, tab bar,
  header do chat, cards de artifact, dots de status) usam o mesmo conjunto inline-SVG sobre
  tokens CSS; zero emoji-como-ícone, e os tokens `--panel`/`--bg2`/`--fg` agora existem de
  verdade, consertando o light theme no shell desktop
- **UI bilíngue + teclado** — todas as telas (pareamento, composer do chat, diálogos de
  atividade e diff) saem de um dicionário único EN/pt-BR; diálogos fecham com Esc e prendem
  o focus, e o painel de sessões é totalmente navegável por teclado. As telas de conexão
  seguem um único idioma de ponta a ponta: banners de daemon caído/reconectando, o scanner
  de QR e o estado vazio do desktop resolvem o copy do mesmo dicionário das ações vizinhas —
  sem mistura pt-BR/inglês numa mesma tela

## Quick Start (Mac → iPhone, ~5 min)

```bash
git clone https://github.com/caiovicentino/opencode-remote.git
cd opencode-remote && npm ci
opencode serve --port 4096    # se ainda não estiver rodando
node cli.mjs setup --relay=wss://seu-host.ts.net:8788
```

O wizard confere node/opencode/whisper/ffmpeg, instala os serviços launchd
com KeepAlive e imprime o QR de pareamento. Aponte a câmera do PWA e pronto.

O origin do PWA no celular é servido pelo serviço launchd `com.ocr.pwa`
(`apps/web/dist` estático em `127.0.0.1:5173`, P2-075) — nunca um dev server.
O daemon vigia `/healthz` e sinaliza no dashboard se o origin cair.

## Instalar como terceiro (sem tailnet — modo LAN)

O `wss://…ts.net` do Quick Start é só um jeito de alcançar o relay. Qualquer
Mac no mesmo Wi-Fi hospeda tudo com certificado local (o gate de passkey
precisa de contexto seguro, por isso o TLS):

```bash
git clone https://github.com/caiovicentino/opencode-remote.git
cd opencode-remote && npm ci
npm run build --workspace @ocr/web
opencode serve --port 4096    # se ainda não estiver rodando

# uma vez: CA local + certificado pro IP da LAN (brew install mkcert)
mkcert -install
LAN_IP=$(ipconfig getifaddr en0)
mkdir -p .certs
mkcert -cert-file .certs/lan.pem -key-file .certs/lan.key "$LAN_IP" localhost 127.0.0.1

# relay + daemon + origin estático do PWA como serviços launchd (KeepAlive)
RELAY_URL="wss://$LAN_IP:8788" \
RELAY_TLS_CERT="$PWD/.certs/lan.pem" RELAY_TLS_KEY="$PWD/.certs/lan.key" \
PWA_HOST=0.0.0.0 PWA_TLS_CERT="$PWD/.certs/lan.pem" PWA_TLS_KEY="$PWD/.certs/lan.key" \
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" \
  ./deploy/install.sh

RELAY_URL="wss://$LAN_IP:8788" node cli.mjs qr   # QR de pareamento
```

No celular (mesmo Wi-Fi): mande o `$(mkcert -CAROOT)/rootCA.pem` por AirDrop →
instale o perfil → habilite em **Ajustes → Geral → Sobre → Confiança de
Certificado**; abra `https://<LAN_IP>:5173` no Safari → **Adicionar à Tela de
Início** → escaneie o QR. Sem os overrides `PWA_*`/`RELAY_TLS_*` vale o layout
tailscale padrão — **mas um clone novo não tem `.certs/`**: sem certificados
gerados o relay sobe em ws puro na 8788, então use `RELAY_URL="ws://$LAN_IP:8788"`
e deixe de fora `PWA_TLS_*`/`NODE_EXTRA_CA_CERTS` também. Portas e certificados
são variáveis de ambiente. O serviço do pilot segue a mesma regra:
`deploy/install-pilot.sh` não tem hostname fixo — defina `RELAY_URL` (e
`NODE_EXTRA_CA_CERTS` para wss com CA local; na reinstalação os dois são
recuperados do plist, nunca descartados sem querença).

### Instalador do app desktop (DMG)

Todo release do GitHub traz o instalador macOS de verdade,
`OpenCode Remote-<version>-arm64.dmg` (alvo `dmg` do electron-builder, janela
com a marca do projeto). Releases são **assinados e notarizados** somente
quando o runner tem um certificado Developer ID Application configurado (além
das credenciais Apple de notarização); sem identidade de assinatura o build é
ad-hoc e basta right-click → **Open** uma vez para passar pelo Gatekeeper.
Quem prefere Homebrew usa o `Formula/opencode-remote.rb` (AGPL-3.0-only,
checksum fixado automaticamente pelo pipeline de release a cada tag).

## CLI

```bash
node cli.mjs doctor    # diagnóstico completo
node cli.mjs qr        # reimprime o QR de pareamento
node cli.mjs status    # estado dos serviços + devices
node cli.mjs start     # restart dos serviços (relay + daemon + pwa)
node cli.mjs update    # puxa, reinstala deps e reinicia num comando
node cli.mjs token     # imprime o token da API HTTP local
```

## API HTTP & SDK

```js
import { createClient } from "@ocr/sdk";

const ocr = createClient({ token: process.env.OCR_TOKEN });
const { id } = await ocr.createSession();
const reply = await ocr.sendAndWait(id, "explique o módulo de autenticação");
```

Veja [docs/api.md](docs/api.md).

## Arquitetura & segurança

- [docs/architecture.md](docs/architecture.md)
- [docs/security.md](docs/security.md)
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [docs/capacitor.md](docs/capacitor.md) — shell nativo iOS

## App desktop (inicial)

O primeiro estágio da [visão desktop](docs/VISION.md): um shell Electron
([`apps/desktop`](apps/desktop)) que abre o cockpit numa janela nativa, com
ícone de tray, menus nativos e renderer sandboxed — sem terminal, sem
Tailscale. Ele carrega o mesmo build de `@ocr/web` usado no telefone.

O shell roda em **Electron 44** (Chromium 152, V8 15.2, Node 24.18.1), que
exige **macOS 13 (Ventura) ou mais recente**.

Desde o P1-046 a janela é um cockpit de duas colunas de verdade: a conversa
fica aberta na coluna da esquerda enquanto Artifacts, Browser, Arquivos ou
Configurações abrem num pane contextual à direita (trocar de pane nunca
destrói o chat), e toda a navegação vive numa única view stack. Atalhos de
teclado (também no menu **Go**): `Cmd+T` nova conversa, `Cmd+K` command
palette (busca conversas e ações), `Cmd+1..6` troca para chat / Artifacts /
Browser / Arquivos / Configurações / Mission Control.

**Auto-preview (P1-072)**: quando o agent sobe um site local (http.server,
vite, dev server…) e menciona `http://localhost:<porta>` na resposta, o pane
Browser abre sozinho ao lado do chat apontando pra URL, renderizado como um
webview real e sandboxed — scroll, click e edição de formulário funcionam de
verdade. A barra de URL é editável, `↻` recarrega, `⤢` alterna o pane para
~80% da largura e volta, e `←` retorna pro chat. Falha de carregamento mostra
o erro e o botão de reload, nunca um pane em branco.

O **Mission Control** (Cmd+6) é o pós-mortem navegável das runs autônomas do
pilot: um card por tarefa de agente (objetivo, progresso, esforço em minuto,
ETA enquanto roda) lido do `pilot.log`/`events.jsonl` real, mais a timeline
forense por tarefa — cada decisão do builder, veredito de reviewer, falha de
gate (com tail do output) e deploy navegáveis, os shots pós-deploy, um shot
ao vivo do dashboard via a superfície de browse e o botão **Assumir** que
abre o Terminal anexado à própria sessão opencode do agente (handoff humano).

```bash
npm run build --workspace @ocr/web       # gere a UI uma vez
npm run build --workspace @ocr/desktop   # compila o shell (main process em TypeScript)
npm start  --workspace @ocr/desktop      # abre a janela
```

Durante o desenvolvimento do web, aponte o shell pro dev server do Vite:
`OCR_WEB_URL=http://localhost:5173 npm start --workspace @ocr/desktop`.
`npm run dist` é auto-suficiente: ele gera a UI web e o shell (TypeScript +
bundle do daemon) antes de empacotar, então funciona também num checkout limpo.

**Empacotamento (P1-050)**: `npm run dist --workspace @ocr/desktop` agora
também produz um **`OpenCode Remote-<versão>.dmg`** distribuível (janela de
instalação com branding, versão semântica no About e no nome do arquivo).
Builds são assinados ad-hoc — no primeiro abre, clique direito → **Abrir**
para passar pelo Gatekeeper; depois o app se comporta como qualquer app
instalado.

**Auto-update com consentimento (P1-050)**: o shell empacotado checa a pasta
versionada de updates do daemon (`http://127.0.0.1:8792/__ocr/updates/`
— servida pelo próprio daemon local, sem nova superfície de rede) no boot e
sob demanda pelo tray (**Check for updates**). Achando um `feed.json` mais
novo, o release baixa em segundo plano e um diálogo de consentimento oferece
**Reiniciar agora / Depois** — nada instala sem clique explícito, versão
adiada não é re-oferecida na sessão, e checagens repetidas nunca empilham
ofertas velhas. Publicar um release é copiar arquivos: solte `<versão>/` com
o artefato em `~/.opencode-remote/updates/` e reescreva `feed.json` (ver
`docs/troubleshooting.md`). Em dev, o update segue opt-in via `OCR_UPDATE_FEED`.

**Relatórios de crash & diagnóstico (P1-050)**: erros fatais do main process e
crashes do renderer viram arquivos com timestamp em
`~/.opencode-remote/pilot/client-logs/` (20 mais recentes mantidos). O
Settings ganha o card **Diagnóstico → Copiar diagnóstico**, que põe no
clipboard um bundle de suporte — versões app/electron, plataforma, estado do
daemon, últimas linhas do desktop.log e nomes dos arquivos de crash. Sem
segredos: apiToken, allowlist e URI de pareamento nunca são incluídos.

O shell desktop sobe o daemon como **sidecar**: ao abrir, ele faz spawn do
daemon — em apps empacotados, um bundle CJS single-file embarcado em
`resources/daemon/index.js` (gerado com esbuild no `npm run build`; a rota
`/dashboard` é servida de um `dashboard.html` embarcado ao lado, já que o
bundle CJS não tem `import.meta`; em checkout de dev roda o código TypeScript
via o `tsx` do workspace, e `OCR_DAEMON_ENTRY` sobrepõe ambos) — espera
`GET 127.0.0.1:8792/api/health` responder **com um 200 autenticado** antes de
mostrar a UI e encerra o filho no quit. `npm run dist --workspace @ocr/desktop
-- --dir` empacota web UI + daemon juntos (o script `dist` faz o build da web e
do shell antes de empacotar). Se já existe um daemon saudável nessa porta (instalação launchd/CLI),
ele é reaproveitado — nunca duplicado. Para trocar a porta:
`OCR_DAEMON_METRICS_PORT` (com fallback pro `OCR_METRICS_PORT`); o filho faz
bind exatamente na porta que o shell verifica.

**Reconexão infinita do daemon adotado**: se o daemon **adotado** (reuso de um
launchd/CLI já rodando na porta de metrics) sumir no meio do run, o shell nunca
desiste — não há filho nenhum pra respawnar e nenhum orçamento pra esgotar. Ele
sonda a porta em backoff infinito (5s → 15s → cap 30s) e mostra um banner
amarelo "Reconectando ao daemon… (n)" com o contador de tentativas, sem overlay
de QR e sem spawnar filho brigando pela porta com o supervisor externo. Quando
o daemon volta, o banner some e a sessão anterior é retomada **sem re-pairing**
(o desktop nunca reescreve o state 0600 nem adiciona entradas de allowlist). O
banner vermelho de "daemon down" agora vale só para o sidecar próprio (modo
hosted) e ganhou um botão **Reconectar agora** que dispara o mesmo restart do
tray — um `kickstart` no daemon a cada deploy não deixa mais o app preso na
tela de pareamento.

**Zero pairing na máquina host**: o shell do desktop trata o daemon da mesma
máquina como um único domínio de confiança (loopback, mesmo usuário,
`daemon.json` 0600). Se esse daemon prova saúde no boot — desafio 401
anti-squatter seguido de 200 autenticado — o app abre direto no chat: sem tela
de pareamento, sem QR, nada para escanear (P1-070). A cerimônia de QR só
existe para clientes remotos: aparece quando nenhum daemon local é alcançável
ou sob demanda em **Config → Parear um celular (dispositivo remoto)** ou via
deep link `opencode-remote://`. Quando um celular ainda precisa parear na
primeira execução, o QR abre com um **splash de boas-vindas** (pt/en): o valor
do produto logo de cara e um onboarding de 3 passos prometendo o primeiro
valor real em menos de 1 minuto. A tela manual de QR/colar continua disponível
como fallback (troca de máquinas → add machine).

**Conexão local direta (P1-061)**: na máquina host, o app desktop dispensa o
relay — ele fala direto com o WebSocket local do daemon
(`ws://127.0.0.1:8792/ws`, autenticado com o token local do arquivo de estado
0600). Kickstarts de deploy no relay não interrompem mais a sessão aberta e,
após qualquer reconexão, a conversa aberta é recarregada sozinha — mensagens
produzidas na lacuna aparecem sem reenvio. Acesso remoto (celular, fora de
casa) continua via relay; o fio em uso aparece em Config → About ("Conexão:
direta (local) / via relay").

**QR de primeira execução pro celular**: o overlay com o QR de pareamento
(renderizado pelo processo main a partir do `GET /__ocr/pairing-uri` do daemon,
rota read-only em loopback com o mesmo bearer token) só existe para clientes
remotos — aparece quando nenhum daemon local é alcançável ou quando você pede
explicitamente em Config → "Parear um celular (dispositivo remoto)". O shell
checa a allowlist a cada 3s — quando o celular pareia, o overlay sai e o chat
aparece. "Pair later" dispensa o overlay pela sessão.

**A janela lembra tamanho e posição**: mexeu, fechou e reabriu — os bounds
voltam como estavam. Ficam em `userData/window-state.json`, gravados no close,
e são validados contra os displays conectados no boot: janela esquecida num
monitor desconectado (ou arquivo corrompido) cai no padrão 1280×820 em vez de
abrir off-screen ou travar.

**Log persistente do shell**: o app desktop grava tudo que o processo main
emite (linhas `[desktop] …`: ciclo de vida do daemon, polls de pareamento,
crashes do renderer, erros fatais) em `userData/logs/desktop.log` — assim o
app empacotado, usado por alguém sem terminal, continua diagnosticável. O
arquivo tem cap de ~1MB e rotaciona para `desktop.log.1` (só 2 arquivos); se o
disco encher, o app segue rodando e apenas para de gravar. No macOS:
`~/Library/Application Support/OpenCode Remote/logs/`.

**Log do sidecar de daemon**: o daemon que o app desktop spawna escreve sua
saída JSONL no mesmo `userData/logs/daemon-sidecar.log` (rotaciona para
`daemon-sidecar.log.1`, cap ~1MB, 2 arquivos — falha de escrita é ignorada em
silêncio). No app empacotado o stdout/stderr do daemon ia para um console que
não existe; o item **Open logs folder** do tray agora registra qual arquivo
guarda o quê.

**Notificação nativa quando o daemon para**: se o orçamento de respawn do
sidecar se esgota, o shell dispara uma notificação nativa única —
`daemon parou — use "Reconectar agora" no OpenCode Remote` — e `daemon de
volta` quando um
daemon saudável responde de novo. Cada transição notifica exatamente uma vez
(dedup pelo mesmo poll de 3s que alimenta o tooltip do tray) e a feature é
best-effort: em plataformas sem suporte a notificação o shell segue rodando
em silêncio — com a janela fechada no tray, é assim que o usuário leigo
descobre que perdeu o controle.

## Roadmap

Próximos: relay hospedado
opcional, wizard de onboarding, compartilhamento de skills, push nativo iOS.

## Licença

Open core, escolhido pra comunidade ficar com o cliente e o negócio com o
serviço:

| Parte | Licença | Por quê |
|---|---|---|
| `apps/relay` (o lado hospedado) | **AGPL-3.0-only** | quem hospedar pra terceiros precisa publicar o fonte — sem SaaS parasita |
| `apps/daemon`, `apps/web`, `cli.mjs`, `tools/` | **AGPL-3.0-only** | o produto segue aberto e self-hosted, para sempre |
| `packages/sdk`, `packages/protocol` | **MIT** | construa integrações em cima, sem amarras |

Deploy próprio, fork e uso interno seguem livres — a AGPL só mordem se você
oferecer o software como serviço pra terceiros e esconder o fonte.

---

🇬🇧 This project also speaks English: [README.md](README.md)
