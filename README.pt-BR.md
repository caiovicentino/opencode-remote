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
  a sessão ainda não tem título) e tem botões de ação ghost (handoff, exportar,
  atividade de tools) no mesmo chrome de ícones do composer; conversa nova
  mostra um empty state de
  boas-vindas com dicas rápidas (áudio, foto ou texto). A resposta do agente
  pinta direto no canvas — a bolha é reservada pra SUA mensagem. A conversa só
  acompanha
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
- **Voz** — segure e fale, transcrição local com whisper, sem nuvem. A
  transcrição é um recurso **opcional** do host: quando a máquina não tem o
  motor whisper (ou falta o arquivo de modelo), o botão de microfone nasce
  desabilitado com uma frase curta e acionável do daemon em vez de gravar para
  falhar depois — e o daemon expõe o mesmo veredito em
  `GET /__ocr/voice/stt-status` (`{ available, state, message }`, espelhando a
  rota de tts-status). Instale no host com `./scripts/setup-whisper.sh`.
  `OCR_STT_BLOCK=1` no daemon é um hatch de teste que força o veredito
  missing-binary para evidência visual determinística
- **Arquivos** — envie do celular, dê preview de tudo, exporte a conversa
  em markdown; todo card de arquivo tem um botão ⧉ que copia o caminho
  completo do arquivo (Clipboard API com fallback execCommand)
- **Handoff** — continue a sessão exata no Mac (ícone de laptop no header do chat)
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
- **Dispositivos distinguíveis** — cada pareamento ganha um rótulo estável e
  sem dado pessoal (`Telefone 1`, `Telefone 2`, …) no lugar do `first` fixo, e a
  lista de dispositivos em Settings mostra um carimbo aproximado de último
  acesso (`visto 5m`, ou `nunca visto` em entradas anteriores ao campo) junto do
  prefixo de chave — dá pra revogar um celular perdido sem adivinhar entre
  prefixos. O carimbo é gravado no máximo uma vez por dispositivo por hora
  (`DEVICE_TOUCH_INTERVAL_MS`): propositalmente aproximado, nunca a frame, e não
  muda nenhuma decisão de admissão
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
- **Retenção de artifacts** — a pasta de artifacts é limitada por um janitor
  para que uma instalação antiga nunca encha o disco em silêncio: uma varredura
  do daemon (uma vez no boot, depois a cada **6 h**) apaga diretórios de sessão
  inteiros sob `~/.opencode-remote/artifacts/` com mais de **30 dias**, do mais
  antigo pro mais novo, até a pasta caber em **1 GB** no total. O período de
  graça de **48 h** protege artifacts recém-escritos, e os **3 diretórios de
  sessão modificados mais recentemente** são sempre preservados, mesmo com
  qualquer teto estourado. Só a raiz de artifacts é tocada — `uploads/`
  (material que o próprio usuário pediu para baixar), `clips/` e qualquer
  outro diretório de estado nunca são varridos ou apagados. Para desligar o
  janitor por completo, use `OCR_ARTIFACT_RETENTION=off` no ambiente do daemon
  (padrão: ligado). Cada varredura registra uma linha de log com quantidade e
  bytes apagados e incrementa a métrica `ocr_artifact_retention_deleted_total`
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
- **Boas-vindas de primeira execução (P2-148)** — o primeiro boot do app desktop
  percorre três passos: o que o app é (uma frase), o estado do agente local (reusando
  a copy calma da jornada degradada e o aviso de upstream da P2-138) e o convite a
  parear um celular com a opção explícita de "fazer isso depois". Dá para pular a
  qualquer momento; concluir ou pular grava a flag no localStorage do renderer (sem
  IPC, sem tocar o processo main), então quem já usa o app — incluindo todo mundo que
  atualizar com pareamento salvo — nunca a vê. Superfície única em tela cheia: sem
  banners e sem overlay de pareamento (regra P2-108)
- **Aviso do upstream (P2-138)** — o daemon pode estar saudável enquanto o servidor
  de agente que ele proxyfica não está (`opencode serve` não instalado, porta errada,
  senha mudada). O `/api/health` traz o veredito classificado (`opencode.state`:
  unauthorized / unreachable / timeout / unhealthy) e o shell desktop repassa ao
  renderer pelo mesmo canal dos campos de versão. O cartão calmo do primeiro boot e a
  nova seção **Ajuda do servidor de agente** (topo das Configurações) dizem então o
  que aconteceu e o que fazer — um bloco único dentro de uma superfície existente,
  nunca um segundo banner — com botão secundário que abre a seção de ajuda direto do
  cartão de primeiro boot. reason/hint do daemon entram só como detalhe secundário em
  texto; nenhum token ou segredo entra na copy exibida. Desde a P2-149 o objeto
  `opencode` também traz `binaryFound` e `binarySource` (`"path"`, `"known"` ou
  `null`): o daemon resolve o binário executável do opencode no boot (e no máximo
  uma vez por minuto com o upstream inalcançável) para separar "opencode parado"
  ("verifique se o opencode está rodando") de "opencode nunca instalado" ("instale
  o opencode primeiro"); nenhum caminho absoluto entra em `reason`, `hint` ou payload
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
  de QR e a home do desktop resolvem o copy do mesmo dicionário das ações vizinhas —
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
e deixe de fora `PWA_TLS_*`/`NODE_EXTRA_CA_CERTS` também. `RELAY_TLS_CERT`/`RELAY_TLS_KEY`
são um par obrigatório: defina os dois para terminação `wss://` direta ou nenhum —
definir só um, valor em branco ou arquivo ilegível faz o relay recusar o boot
(exit 1) em vez de servir `ws://` puro sem avisar. Portas e certificados
são variáveis de ambiente. O serviço do pilot segue a mesma regra:
`deploy/install-pilot.sh` não tem hostname fixo — defina `RELAY_URL` (e
`NODE_EXTRA_CA_CERTS` para wss com CA local; na reinstalação os dois são
recuperados do plist, nunca descartados sem querença).

### Instalador do app desktop (DMG)

Todo release do GitHub traz o instalador macOS de verdade em **duas**
arquiteturas (P2-191): `OpenCode-Remote-<version>-arm64.dmg` para Apple
Silicon e `OpenCode-Remote-<version>-x64.dmg` para Intel (alvo `dmg` do
electron-builder, janela com a marca do projeto). Baixe o arquivo certo pro
seu Mac: menu Apple → **Sobre este Mac** → **Chip** diz "Apple" → `-arm64`;
diz "Intel" → `-x64`. Um preflight de assinatura
(`apps/desktop/scripts/signing-profile.mjs`) roda antes do empacotamento e
escolhe um de dois modos:

- **Developer ID + notarizado** — quando o runner tem um certificado
  Developer ID Application (`CSC_LINK` ou `CSC_NAME`, com
  `CSC_IDENTITY_AUTO_DISCOVERY` ausente ou `true`) além das credenciais
  Apple de notarização (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`). O bundle é assinado com hardened runtime e as
  entitlements de `build/entitlements.mac.plist` e depois notarizado.
- **Ad-hoc (padrão)** — sem esses secrets o DMG sai ad-hoc e basta
  right-click → **Open** uma vez para passar pelo Gatekeeper. O preflight só
  liga a notarização quando o certificado é realmente utilizável: certificado
  configurado com `CSC_IDENTITY_AUTO_DISCOVERY=false` (que o electron-builder
  ignoraria em silêncio) ou credenciais de notarização sem certificado são
  reportados como problema e o build volta para ad-hoc em vez de falhar.

Os dois modos mudam o que acontece na primeira abertura, e o pipeline de
release cobra a régua certa de cada um (P2-170). Um release **notarizado** tem
que abrir sem atrito: o job desktop-dmg roda os três vereditos do Gatekeeper no
app empacotado (`codesign --verify`, avaliação do `spctl` e `stapler validate`
via `scripts/gatekeeper-verify.ts`) entre o smoke do bundle e o upload, então um
DMG cujo ticket de notarização não foi grampeado, cuja identidade expirou no
meio do release, ou cujo perfil caiu em ad-hoc sem ninguém notar, derruba o job
antes do `gh release upload` — e não vira surpresa publicada de "app is
damaged". Um release **ad-hoc** cobra a régua ad-hoc: a assinatura precisa
verificar e as ferramentas precisam produzir vereditos legíveis, mas o spctl
rejeitando o build e a ausência de ticket são exatamente o fluxo documentado de
right-click → **Open**, então o caminho de release sem secrets continua verde.

Quem prefere Homebrew usa o `Formula/opencode-remote.rb` (AGPL-3.0-only,
checksum fixado automaticamente pelo pipeline de release a cada tag).

### Instalador do app desktop (Windows)

Os releases também trazem o instalador Windows, `OpenCode-Remote-Setup-<versão>.exe`
(alvo `nsis` do electron-builder: setup assistido, instalação
por usuário, diretório escolhível), junto do `latest.yml` que o cheque de
update do app usa como fallback. A assinatura Windows tem perfil próprio,
resolvido por `apps/desktop/scripts/signing-profile-win.mjs` antes do
empacotamento a partir dos secrets `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`
(opcional `WIN_CSC_SUBJECT_NAME` para escolher o certificado pelo subject
name) — o par Apple `CSC_LINK`/`CSC_KEY_PASSWORD` que o job macOS consome
nunca é consultado no Windows. Com o par configurado, o instalador sai
assinado com Authenticode e o aviso desaparece. Sem nenhum secret
`WIN_CSC_*`, o instalador sai **sem assinatura** e o SmartScreen mostra
"Windows protected your PC" na primeira execução — clique em **More info →
Run anyway** uma vez; a mesma dança de confiança do fluxo Gatekeeper do
macOS acima. Perfil configurado pela metade (link sem senha, senha sem link
ou valor em branco) é fail-closed: o job de release aborta no preflight de
assinatura e lista todos os problemas em vez de publicar uma assinatura
quebrada.

Os dois caminhos de release continuam propositalmente distintos. Quando o
perfil decide mode=authenticode, o job `desktop-win` também verifica a
assinatura Authenticode do instalador empacotado (PowerShell
`Get-AuthenticodeSignature` → `scripts/authenticode-verify.ts`) entre o
smoke do bundle e o upload: qualquer status diferente de `Valid` (arquivo
não assinado, hash divergente, cadeia não confiável, certificado
expirado/revogado, erro desconhecido) ou assinatura cujo certificado não
tem subject aborta o job ANTES de anexar o setup exe ao release — o aviso
do SmartScreen deixa de ser o primeiro sinal. Com mode=unsigned a
verificação é pulada de propósito (o aviso único do SmartScreen é o fluxo
documentado), exatamente como o caminho ad-hoc no macOS. Quando o passo
falha, o log do job lista todos os problemas de uma vez em
`authenticode-verify:`; as linhas `Status:`/`StatusMessage:` da verificação
ficam em `authenticode.txt` (artefato do workspace do run).

**Release**: a tag `vX.Y.Z` precisa ter a mesma versão nos **dois**
`package.json` (raiz e `apps/desktop`). O workflow de release roda
`scripts/release-preflight.ts` como primeiro passo e bloqueia o release em
caso de divergência, além de rodar `npm run dist:smoke --workspace
@ocr/desktop` no bundle empacotado antes do upload do DMG — suba a versão dos
dois arquivos junto com a tag. Desde a P2-204 (DMG) e a P2-208 (Windows) os
**dois** jobs de empacotamento também **abrem** o app empacotado uma vez
(passo `Smoke-boot the packaged app`): launch hermético do bundle real
(userData temporário, nenhum sidecar do daemon, janela oculta) que espera a
interface montar, verifica a coleta de erros de console do renderer com um
canário injetado e falha fechado quando o Playwright não está disponível —
pacote que não abre aborta o release antes do upload. Dá para rodar o smoke
de boot localmente contra um pacote já construído (macOS ou Windows):

    node apps/desktop/scripts/packaged-boot.mjs "apps/desktop/dist/mac-arm64/OpenCode Remote.app"
    node apps/desktop/scripts/packaged-boot.mjs "apps/desktop/dist/win-unpacked"

PRs que tocam o shell desktop, a web UI ou `package-lock.json` rodam ainda um
job de empacotamento escopado
(`desktop-package`, alvo mac `dir` apenas, sem DMG/assinatura) validado com
`dist:smoke --no-installer`; os instaladores assinados completos seguem
saindo só na tag. Antes de empacotar, esse job também garante os orçamentos de
tamanho de `scripts/bundle-budget.ts` (P2-162): o payload somado de
`apps/web/dist` e o bundle sidecar `apps/desktop/dist-daemon/index.js` precisam
ficar sob os tetos, ou o job falha antes de empacotar qualquer coisa — uma
dependência gorda não vira mais um download lento em silêncio. Meça localmente
após o build com `npx tsx scripts/bundle-budget.ts`; suba um teto de propósito,
atualizando `BUNDLE_BUDGETS` com a justificativa na mensagem do
commit.

**O que cada release precisa ter** (P2-153): o tarball de fonte
(`opencode-remote-<tag>.tar.gz`) do job `release`; o lado macOS do
`desktop-dmg` — o DMG e o zip do Squirrel.Mac **de cada arquitetura** (arm64
e x64, P2-191), `latest-mac.yml` e os três arquivos de feed (`update-mac.json`
mais os por-arquitetura `update-mac-arm64.json`/`update-mac-x64.json`); e o
lado Windows do `desktop-win` — o
setup exe do NSIS e o `latest.yml` (a imagem do relay é publicada no GHCR e
não é asset de download). Um job final `release-verify` lista os assets
publicados com `gh release view --json assets` e roda
`scripts/release-assets.ts` sobre essa lista: o release só é considerado
completo quando esse job passa — instalador (inclusive o Intel, P2-191) ou
feed de update faltando derruba
o workflow (todos os faltantes listados de uma vez) em vez de virar um 404
silencioso no cheque de update do app. O release também só é considerado
completo quando os feeds apontam para artefatos da mesma tag (P2-157): um job
`release-feeds` baixa `update-mac.json` e `latest.yml`, confere via
`scripts/feed-consistency.ts` que o `name`/`url` do Squirrel e o
`version`/`path` do yml citam a versão da tag e arquivos realmente publicados,
e derruba o workflow — sem isso um feed defasado sai verde e cada app
instalado falha o auto-update em silêncio.

**Releases nascem como rascunho** (P2-179): o `gh release create` roda com
`--draft`, então nada fica visível para a base instalada enquanto os jobs de
empacotamento ainda rodam. Um job final `release-publish` — depois do
`release-verify` e do `release-feeds` passando — lê a flag de rascunho + a
lista de assets com `gh release view --json isDraft,tagName,assets`, roda
`scripts/release-publish.ts` (só publica um rascunho carregando todos os
assets obrigatórios; release já publicada é um no-op idempotente) e só então
torna o release público com `gh release edit --draft=false`. Release com
falha de assinatura, notarização ou empacotamento termina o run como
**rascunho**, nunca como página de download quebrada. O pin do Formula do
Homebrew também mudou para o `release-publish`, depois da publicação: o sha256
é calculado a partir do tarball baixado de volta do release, então a `main`
nunca aponta para um release que não é público ainda (o push do pin segue
fail-open — push recusado só avisa). Para inspecionar ou descartar o rascunho
de um run que falhou: abra o run no Actions para ver qual job falhou (o passo
que falhou lista todos os assets faltantes) e depois ou conserte a causa e
re rode o workflow — um re-run passa direto por release já publicada — ou
apague o rascunho com `gh release delete vX.Y.Z --yes` (a tag fica; apague
também com `--cleanup-tag` se quiser retaggear limpo).

**Confira o seu download** (P2-186): todo release também traz o
`checksums.txt`, um manifesto SHA-256 no formato padrão do coreutils (uma linha
`<hash>  <nome>` por asset de download, ordenada por nome, dois espaços entre
hash e nome). Ele é gerado pelo próprio pipeline: o job `release-publish`
baixa os assets prontos de volta do rascunho, calcula o hash de cada arquivo e
anexa o manifesto **antes** de o release ficar público — então os checksums só
podem descrever os bytes de fato publicados. Depois de baixar um instalador (e
o `checksums.txt` ao lado), confira com a ferramenta padrão do seu sistema:

    # macOS / Linux — dentro da pasta dos arquivos baixados:
    shasum -a 256 -c checksums.txt     # macOS
    sha256sum -c checksums.txt         # Linux

    # Windows (PowerShell) — compare com a linha no checksums.txt:
    Get-FileHash ".\OpenCode-Remote-Setup-0.3.0.exe" -Algorithm SHA256

A ferramenta imprime `OK` para cada arquivo cujo hash bate. Divergência
significa que o arquivo em disco não é o que o CI produziu: **não abra nem
execute**. A causa mais comum é download truncado ou passado por proxy —
baixe de novo e confira de novo; se o hash continuar divergente, não
distribua o arquivo e reporte na página de releases (a fórmula do Homebrew é
um caminho alternativo de instalação que fixa o próprio sha256 no momento da
tag).

## Relay hospedado (Docker)

Não quer hospedar o relay no seu Mac? `deploy/relay/Dockerfile` gera uma imagem
multi-stage enxuta (node 22 slim, compilada com tsc, usuário não-root,
`HEALTHCHECK` no `/healthz`) para qualquer plataforma de containers — aponte o
TLS do provedor pra ela, defina `RELAY_URL` no daemon e pareie o celular de
novo. O relay continua cego: nunca vê plaintext nem chaves. O daemon valida o
`RELAY_URL` no boot e falha fechado: só `ws://`/`wss://` conectam, `ws://` pra
host não-loopback é recusado — URL inválida desativa a conexão com o relay
(motivo logado uma vez no boot e exposto em `/api/health`, campo aditivo
`relay`) e esconde o QR de pareamento; o modo local do app desktop não depende
do relay e segue funcionando. Runbook:
[docs/RELAY-HOSTING.md](docs/RELAY-HOSTING.md).

A imagem também entrega a PWA do celular (P2-188): ela define
`RELAY_WEB_DIR=/app/apps/web/dist`, então a URL do relay no navegador do
telefone já abre o app — o primeiro passo da jornada não exige dev server,
TLS próprio nem tailscale. Só arquivos estáticos são servidos (allowlist de
extensão, sem traversal, sem dotfiles, contenção à prova de symlink, fallback
SPA pro `index.html`), o roteamento de WebSocket e o corpo do `/healthz`
ficam intocados, e a rota estática responde `503` durante o dreno. Um
`RELAY_WEB_DIR` apontando pra diretório inexistente, que não é diretório,
ilegível ou sem `index.html` legível recusa o boot — motivos logados uma vez,
exit 1, sem listener; sem a variável, o comportamento antigo (404 pra todo o
resto) é preservado. Todo documento 200 da rota estática chega travado
(P2-192): `Content-Security-Policy` só permitindo a própria origem (estilo
inline liberado — o bundle gerado injeta estilo — além de imagens
`data:`/`blob:` e conexões `wss:`/`https:` porque o app disca pro relay),
`Referrer-Policy: no-referrer` pra URL da sala nunca vazar como referrer,
`Permissions-Policy` negando geolocalização/pagamento/USB/serial/HID/MIDI,
`X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin` e
`Cross-Origin-Resource-Policy: same-origin` — e `Strict-Transport-Security`
só quando a requisição de fato chegou sob TLS, porque anunciar HSTS numa
origem `http://` trava o operador que ainda está subindo o serviço. A
variável `RELAY_WEB_CSP` sobrescreve a política (precisa declarar
`default-src`, sem bytes de controle, ≤1024 caracteres — qualquer coisa
diferente recusa o boot, fail-closed); 404/405 e os bytes do `/healthz` ficam
como estão. A rota estática também tem um orçamento de requisições por
identidade (P2-195): toda requisição que não é o probe gasta um token de um
balde (`RELAY_WEB_RATE_PER_MIN=120`, `RELAY_WEB_BURST=60`, ambos fail-closed
com teto `10000`), estouro de rajada responde `429` com `retry-after` e os
mesmos cabeçalhos de segurança dos documentos 200, a chave da identidade é o
`ipTag` do P2-174 sobre o mesmo endereço consciente de proxy-hops que o
caminho de upgrade já deriva (nunca um IP cru), baldes ociosos são podados
pelo sweep de liveness sob teto de 4096 entradas — e o `GET /healthz` nunca é
contado nem barrado, então um balanceador não pode ser expulso do próprio
probe. Assets de texto também são negociados com gzip (P2-198): html/js/css/
map/json/svg/txt/webmanifest entre 1024 bytes e 8 MiB são servidos com
`content-encoding: gzip` quando o `Accept-Encoding` do cliente permite
(qualidade zero e cabeçalho malformado significam identity, o coringa `*`
vale como gzip), as duas variantes carregam `Vary: Accept-Encoding`, os bytes
comprimidos ficam memoizados em memória com teto de 64 entradas / 32 MiB
(chave caminho + tamanho + mtime, descarte do mais antigo), e
`png`/`jpg`/`webp`/`ico`/`woff2` e todo corpo fora da faixa de tamanho seguem
sem compressão — enquanto 404/405 e o `/healthz` permanecem byte a byte como
sempre. Requisições condicionais fecham o ciclo (P2-200): todo 200 da rota
estática carrega um `ETag` forte derivado do mesmo stat da negociação mais a
codificação — então o validador gzip e o identity são sempre diferentes e um
cache compartilhado nunca serve bytes comprimidos a quem pediu identity — e
um `If-None-Match` que revalida (lista, coringa `*`, prefixo fraco `W/`
ignorado, cabeçalho malformado significa enviar) recebe `304` sem corpo e sem
leitura em disco, com o etag, `Cache-Control`, `Vary: Accept-Encoding` e os
cabeçalhos de segurança do P2-192, mas nunca
`Content-Encoding`/`Content-Length`/`Content-Type`; 404/405 e `/healthz`
seguem byte a byte, e o orçamento de requisições continua sendo cobrado antes
da decisão condicional. O relay continua cego: nada disso toca frames, chaves
ou plaintext — só asset estático público da raiz allowlisted é cacheado ou
revalidado.

No app desktop você não precisa exportar `RELAY_URL` no braço: os Ajustes
(Settings) têm o card **Relay do celular** (seção exclusiva do shell), onde
você cola o endereço hospedado — ex. `wss://relay.exemplo.com:8788` — e o app
reinicia o daemon com ele, então o QR de pareamento deixa de apontar pro
loopback da própria máquina. A precedência é: variável de ambiente primeiro
(`RELAY_URL`, para operadores que roteirizam o app), depois o valor salvo,
depois o padrão local `ws://127.0.0.1:8787` — que só funciona na máquina onde
o app roda. O endereço é validado pelo app antes de salvar (apenas ws/wss,
`ws://` restrito a hosts loopback, sem credenciais embutidas); valor salvo
inválido aparece como erro nos Ajustes, nunca é trocado em silêncio pelo
padrão.

**Pareamento em dois passos (P2-189)**: o celular precisa de um endereço antes
de existir QR de pareamento pra escanear, então a tela de pareamento do
desktop mostra dois passos rotulados. O passo 1 é o **endereço do app** —
`https://…` derivado do endereço do relay (`wss://` vira `https://` no mesmo
host e porta, caminho e query descartados) — mostrado como QR e texto
copiável. O passo 2 é o QR de pareamento de sempre. A convenção de deploy é
que o host que serve o relay também serve o app web na mesma origem; quando
não serve, salve um endereço explícito em Config → **Endereço do app
(celular)** — o valor salvo vence o derivado. Com o relay local loopback, o
shell mostra uma explicação calma no lugar de um endereço que o celular nunca
alcançaria.

**Pareamento com um QR só (P2-193)**: quando o endereço do app está utilizável,
o shell funde os dois passos num único QR — a credencial de pareamento viaja no
**fragmento** da URL do app (`…/#/pair?v=2&…`), e a câmera do celular sozinha
abre o app já pareado. Nenhum navegador envia fragmento a servidor, então o
relay hospedado continua cego; o app web apaga o fragmento da barra de endereço
e do histórico (`history.replaceState`) assim que consome o link; e link com
problema nunca vira QR — os dois QRs rotulados de cima seguem como fallback. A
janela limitada de pareamento (P2-190) continua sendo o que restringe a
validade da credencial.

**Sonda de alcance (P2-197)**: um endereço sintaticamente válido pode mesmo
assim não levar a lugar nenhum — relay fora do ar, nome de DNS que nunca
existiu, certificado vencido ou um servidor que não é o nosso. Enquanto a tela
de pareamento está aberta, o shell sonda o endereço do app uma vez por tick de
polling (teto de 2s) a partir da máquina que hospeda o daemon e mostra o
veredito numa linha calma abaixo do QR ("inacessível", "timeout",
"certificado", "DNS", "erro HTTP", "não é o nosso app"), com ação **Testar de
novo** quando falha. A sonda bate apenas na origem do endereço do app — nunca
no link de pareamento, que carrega a credencial — e não envia nenhum
cabeçalho de credencial. Um aviso nunca bloqueia o pareamento nem esconde o QR:
o Mac não alcançar o relay não prova que o celular também não alcança (outra
rede, outro DNS).

**Elo do relay (P2-199)**: a sonda de alcance diz se o endereço do app
responde, mas a conversa em si viaja por outro elo — o WebSocket entre o
daemon desta máquina e o relay escrito dentro do QR. Enquanto a tela de
pareamento está aberta, o shell lê o veredito desse elo na mesma resposta de
`/api/health` que já busca a cada tick e mostra uma linha calma logo abaixo da
linha de alcance: **conectado**, **modo local** (sem relay), **conectando /
reconectando** (discagem em curso ou backoff), **recusado** (relay lotado ou
limitando o ritmo) ou **mal configurado** (o endereço de relay do daemon foi
recusado na partida). A linha descreve a máquina que hospeda o daemon — não o
celular, não a câmera. Como todo aviso desta tela, ela nunca bloqueia o
pareamento nem esconde o QR: o elo pode voltar antes de o celular terminar de
escanear.

**Reconexão guiada pelo código de fechamento (P2-156)**: quando o socket do
relay fecha, o daemon classifica o código em vez de tratar qualquer queda como
problema de rede. `1013` (server busy / too many connections / room full) o
relay está lotado e o tempo de reconexão passa a valer no mínimo 30s; `4029`
(rate limited) no mínimo 60s; `1001` (desligamento) e `1000` reconectam pelo
cronograma normal; qualquer outro código (incluída a queda abrupta 1006)
mantém a curva com jitter da P2-129 intocada. O veredito aparece nos campos
aditivos `closeCode`/`closeKind` na linha de log `relay connection lost` e como
`lastClose: { code, kind }` dentro do objeto `relayRetry` do `/api/health` —
a reason bruta nunca é exposta.

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

O primeiro pareamento num daemon recém-instalado só é aceito enquanto a
**janela de pareamento do bootstrap** está aberta: 15 minutos por padrão
(`OCR_PAIR_WINDOW_MS`, milissegundos inteiros positivos, teto de 24 h; um valor
inválido faz o daemon se recusar a subir). A janela abre no boot e é rearmada
a cada leitura autenticada da tela de pareamento — o QR na tela mantém o
pareamento disponível. Depois que a janela fechou, clientes desconhecidos são
rejeitados (evento de auditoria `client.bootstrap-expired`) — reabra a tela de
pareamento no app desktop ou reinicie o daemon para parear um novo dispositivo —
veja [docs/security.md](docs/security.md).

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

Desde a P2-178 toda abertura externa passa por um único gate: apenas links
`http`, `https` e `mailto` são entregues ao handler do sistema.
`file`, `javascript`, `data`, `blob` e qualquer outro esquema são recusados
de propósito (a recusa é registrada no log como esquema + motivo, nunca a
URL).

Desde o P1-046 a janela é um cockpit de duas colunas de verdade: a conversa
fica aberta na coluna da esquerda enquanto Artifacts, Browser, Arquivos ou
Configurações abrem num pane contextual à direita (trocar de pane nunca
destrói o chat), e toda a navegação vive numa única view stack. Atalhos de
teclado (também no menu **Ir**): `Cmd+T` nova conversa, `Cmd+K` paleta de
comandos (busca conversas e ações), `Cmd+1..6` troca para chat / Artifacts /
Browser / Arquivos / Configurações / Mission Control. O menu nativo fala
português desde a P2-176 (mesmo idioma da UI) e ganhou o menu **Ajuda** com
**Verificar atualizações**, **Abrir pasta de logs** e **Copiar diagnóstico** —
as ações de suporte do tray, agora também na barra de menus (os itens de
update só aparecem quando há feed configurado).

**Home viva (P2-123)**: sem conversa selecionada, o cockpit mostra uma home de
verdade no lugar do beco antigo — greeting serifado ("De volta à ação, &lt;máquina&gt;",
do mesmo dicionário EN/pt-BR), composer central com placeholder, toggle de modo
Chat/Cowork (Cowork pré-seleciona o agent `build` para a próxima sessão), seletor
de modelo e mic funcional (segurar pra gravar — dita no composer pelo mesmo
fluxo de transcrição do mic do chat) na linha de baixo, e três "Ideias para você"
clicáveis que abrem uma sessão nova com o prompt pré-preenchido (falha vira erro
inline, nunca tela congelada).

**Sidebar nível Claude (P2-124)**: a sidebar desktop é um shell de navegação
de 280px — botão primário **"+ Novo"** e a nav de seções (Conversas,
Artifacts, Browser, Arquivos, Mission Control, Configurações — ícones SVG
consistentes, zero emoji) no topo, a lista de conversas agrupada (busca +
filtros de badge + Hoje/Ontem/Anteriores) no meio e um **footer de conta**
fixo embaixo com avatar/inicial da máquina, nome e modo de conexão ("Local ·
esta máquina" / "Remoto · pareado"). O footer abre o seletor de máquina, o
mesmo overlay do header mobile.

**Auto-preview (P1-072)**: quando o agent sobe um site local (http.server,
vite, dev server…) e menciona `http://localhost:<porta>` na resposta, o pane
Browser abre sozinho ao lado do chat apontando pra URL, renderizado como um
webview real e sandboxed — scroll, click e edição de formulário funcionam de
verdade. A barra de URL é editável, `↻` recarrega, `⤢` alterna o pane para
~80% da largura e volta, e `←` retorna pro chat. Falha de carregamento mostra
o erro e o botão de reload, nunca um pane em branco.

**Indicador de não lidas (P3-053/P2-150)**: quando chega mensagem na conversa
aberta com a janela em segundo plano, o ícone do app mostra o indicador —
contagem no dock do macOS/Linux e um disco verde sobreposto ao ícone na
barra de tarefas do Windows. Focar a janela limpa o indicador.

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
também produz DMGs distribuíveis nas **duas arquiteturas** (P2-191) —
**`OpenCode-Remote-<versão>-arm64.dmg`** (Apple Silicon) e
**`OpenCode-Remote-<versão>-x64.dmg`** (Intel) — (janela de
instalação com branding, versão semântica no About e no nome do arquivo).
Builds locais são assinados ad-hoc com hardened runtime e as entitlements
compartilhadas (`build/entitlements.mac.plist`) — no primeiro abre, clique
direito → **Abrir** para passar pelo Gatekeeper; depois o app se comporta
como qualquer app instalado. P2-169: na primeira vez que você gravar uma
mensagem de voz ou ler o QR de pareamento, o macOS pede permissão de
**microfone** e **câmera** — conceda as duas; se negar por engano, o caminho
é Ajustes do Sistema → Privacidade e Segurança → Microfone / Câmera → ligar
**OpenCode Remote** e reabrir o app). P2-182: o shell concede **câmera,
microfone e tela cheia apenas à própria interface** — qualquer página aberta
no pane Browser tem **todo pedido de permissão recusado de propósito**
(câmera, microfone, geolocalização, notificações, MIDI, HID, serial, USB…),
assim um site de terceiros nunca dispara um prompt de permissão do SO em nome
do app. No release, o preflight de assinatura só liga a
notarização quando há certificado Developer ID e credenciais Apple de fato
configurados (veja *Instalador do app desktop*).

P2-184: o pane Browser só fala **http** e **https**. Navegações que partem de
dentro do pane — redirects, meta refresh, links clicados — são recusadas de
propósito para qualquer outro esquema (`file`, `javascript`, `data`, `blob`,
esquemas customizados), e as preferências do convidado são forçadas no
processo principal (context isolation + sandbox ligados, integração com node
desligada, nenhum preload declarado pelo renderer), assim uma página aberta
ali nunca renderiza arquivos locais nem concede privilégios a si mesma. A
recusa é registrada como esquema + motivo, nunca a URL.

**Auto-update com consentimento (P1-050)**: o shell empacotado checa a pasta
versionada de updates do daemon (`http://127.0.0.1:8792/__ocr/updates/`
— servida pelo próprio daemon local, sem nova superfície de rede) no boot e
sob demanda pelo tray (**Check for updates**). P2-155: com o app aberto (mesmo
com a janela fechada no tray) ele também reconfere sozinho a cada ~6 h
(jitter de ±10%), recuando de 15 min até o teto de 6 h enquanto o feed estiver
inacessível. Achando um `feed.json` mais
novo, o release baixa em segundo plano e um diálogo de consentimento oferece
**Reiniciar agora / Depois** — nada instala sem clique explícito, versão
adiada não é re-oferecida na sessão, e checagens repetidas nunca empilham
ofertas velhas. Desde a P2-146, todo release do GitHub também publica os
feeds JSON do Squirrel.Mac, gerados por
`apps/desktop/scripts/update-feed.mjs` a partir do `latest-mac.yml` + dos
zips de macOS que o empacotamento agora produz — desde a P2-191, um por
arquitetura (`update-mac-arm64.json` e `update-mac-x64.json`, mais o
`update-mac.json` mantido como apelido byte a byte do feed arm64 para a base
já instalada) — e é neles que o fallback público
do macOS resolve: o app instalado por DMG passa a se atualizar sozinho,
sempre pelo feed da própria arquitetura (um Mac Intel nunca recebe o zip
arm64). O
download só completa em build **assinada com Developer ID** (P2-136): o
Squirrel.Mac recusa update cuja assinatura não confere com a do app
instalado, então build ad-hoc (padrão sem os segredos de assinatura) segue
manual, pela página de releases. Publicar um release é copiar arquivos:
solte `<versão>/` com
o artefato em `~/.opencode-remote/updates/` e reescreva `feed.json` (ver
`docs/troubleshooting.md`). P2-161: a porta gravada no campo `url` (absoluto,
loopback) do `feed.json` é resolvida na hora em que a rota serve o documento,
não quando o release é staged — após um boot em porta de fallback (8793–8796)
o daemon reaponta a url para a porta realmente bindada, então o feed é
encontrado e o download sai; artefatos (`zip`, `dmg`, `exe`, `yml`,
`blockmap`) seguem em stream verbatim e o `latest.yml` nunca é reescrito (o
campo `path` dele é relativo ao endereço do próprio feed). Em dev, o update
segue opt-in via `OCR_UPDATE_FEED`.

**Relatórios de crash & diagnóstico (P1-050)**: erros fatais do main process e
crashes do renderer viram arquivos com timestamp em
`~/.opencode-remote/pilot/client-logs/` (20 mais recentes mantidos). O
Settings ganha o card **Diagnóstico → Copiar diagnóstico**, que põe no
clipboard um bundle de suporte — versões app/electron, plataforma, estado do
daemon, últimas linhas do desktop.log e do daemon-sidecar.log (20, P2-163) e
nomes dos arquivos de crash. Sem segredos: apiToken, allowlist e URI de
pareamento nunca são incluídos (o log do sidecar já é redigido em disco).

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
guarda o quê. Antes de qualquer escrita, um redator de linhas troca cada URI
de pareamento por `[pairing-uri redacted]` e descarta o bloco do QR de boot —
o arquivo é seguro de anexar num relato de bug: ele nunca contém a credencial
que poderia parear um novo dispositivo com a sua máquina.

**Notificação nativa quando o daemon para**: se o orçamento de respawn do
sidecar se esgota, o shell dispara uma notificação nativa única —
`daemon parou — use "Reconectar agora" no OpenCode Remote` — e `daemon de
volta` quando um
daemon saudável responde de novo. Cada transição notifica exatamente uma vez
(dedup pelo mesmo poll de 3s que alimenta o tooltip do tray) e a feature é
best-effort: em plataformas sem suporte a notificação o shell segue rodando
em silêncio — com a janela fechada no tray, é assim que o usuário leigo
descobre que perdeu o controle.

**Fechar a janela mantém o app na bandeja**: na primeira vez que a janela é
fechada, uma notificação nativa única avisa que o OpenCode Remote continua
rodando — na barra de menus no macOS, na bandeja do sistema no Windows/Linux
— e como reabrir (clique no ícone da bandeja ou abra o app de novo). A dica
aparece uma única vez; fechar de novo, ou reabrir depois, não notifica.

## Roadmap

Próximos: wizard de onboarding, compartilhamento de skills, push nativo iOS.

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
