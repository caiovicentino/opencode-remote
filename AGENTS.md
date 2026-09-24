# opencode-remote

Remote control for this opencode instance: mobile PWA -> relay -> daemon -> local opencode.

## Pilot (autonomous development loop)

This repo evolves autonomously via the Pilot service (`apps/pilot`, docs in `docs/PILOT.md`):
agents implement tasks from `BACKLOG.md`, a deterministic gatekeeper runs the eval battery +
`scripts/invariants.ts` BEFORE the reviewers (P1-101: a red gate returns as a same-attempt
builder finding instead of killing the attempt, and flaky steps retry once — `gate-flaky`) —
see `docs/CONSTITUTION.md` —, adversarial reviewers then check the branch, and
deploys are staged with automatic rollback — production only ever runs gate-verified merge
SHAs (P2-058): direct pushes to main never deploy, and a failed deploy quarantines its SHA
so the redeploy loop cannot re-run a defective build. Meta-commits (scribe, refills,
mark-done, blocks, corpus) land via the long-lived `pilot/meta` branch + auto-merge PR —
no pilot site pushes `origin main` (P1-076; operator enables GitHub branch protection
post-merge, runbook in docs/PILOT.md). P0/P1 tasks first go through a PLANNER phase: a
read-only agent writes `specs/<ID>.md` on the task branch (problem, approach, touched files,
edge cases, acceptance criteria, out of scope) and the builder + quality reviewer are held to
it; P2+ tasks go straight to the builder (P2-008). Cognition is tiered (P1-059): pilot.json may set a
`models.tierB` block mapping the judgment roles (`strategist`, `planner`, `forensic`,
`reviewerEscalation`, `fable`) to a stronger model — those roles then dispatch through the claude CLI
(`claude -p --model <m> --add-dir <workspace>`, prompt via stdin) with automatic tier-A fallback
on spawn error/timeout/empty output/missing completion marker (`tierB-fallback` in the log),
while builder/reviewers/scribe stay tier A (flash via `opencode run`) and the deterministic
evidence gate is unchanged; the `fable` role (P2-105) is the nightly product review that
judges the explorer's six journey shots against docs/PRODUCT.md (its tier-B dispatch
additionally mounts the shots evidence dir via `--add-dir`); reviewers tag every finding bullet [BLOCKING]/[NIT]
(P1-103: only a verified BLOCKING finding rejects — a nit-only review approves,
untagged fails closed) and the tier-B arbiter fires when a verified concern
REPEATS between rounds — or all-unverifiable findings in ANY
round (P1-073: fail-closed, never an effective approve) — triggers at
most one tier-B escalation reviewer (`review-escalation` phase; without tier-B the
REQUEST_CHANGES stands and the builder is told to restate it with verifiable path:line
evidence); repeated fail-closed guard rejections (2× the same guard on one task)
raise an `alert` event + supervisor notify carrying the reason (P2-115), and a weekly forensic pass
distills the failure record into a taxonomy at `~/.opencode-remote/pilot/forensic-latest.md`.
Tasks that keep failing the pipeline are circuit-broken
after `maxAttemptsPerTask` (default 4; a `(size: L)` task has its own cap of 6) attempts: moved to `## Blocked` in BACKLOG.md with the last
findings and never re-scheduled until a human/red team moves them back (P1-014). A task line may also carry a
`(size: L)` tag (P1-060): long-horizon epics scale budgets to 6 rounds/90min/6 attempts, and from round 2 on are
reviewed on the incremental diff since the round checkpoint (`~/.opencode-remote/pilot/checkpoints/<ID>.json`)
instead of the truncated whole-branch diff. Before every builder round the
pipeline checks the session's context pressure (P1-079): past 85% of the model
window a scribe pass distills a state recap into `~/.opencode-remote/pilot/carryover/<ID>.json`
and the next round opens a FRESH session with the recap in the prompt — without
burning an attempt (overflowed context is infra). Branch preservation across attempts is all-task behavior
(P1-060/P1-036): after any failed attempt the retry keeps the existing `pilot/<ID>` branch (the builder continues
the preserved history); only the first attempt starts clean at origin/main. A global
"fever" breaker (P2-032) pauses the whole queue in audit mode when >=3 DISTINCT tasks
fail within the last 10 pipeline cycles (P2-063: failures are aggregated by task id, so
one stubborn task burning through its own maxAttemptsPerTask breaker never pauses the
queue) or 2 tasks get blocked within 30min — it posts a diagnostic summary to
the log and resumes after external intervention (`touch ~/.opencode-remote/pilot/audit-clear`)
or 2h without a new failure. Once per day, alongside the red-team pass, a non-blocking
nightly EXPLORER agent (P3-052) drives the real desktop app through the P1-051 harness
in a fresh-state first-boot pass (clean userData) like a first-time user and files
journey/UX/robustness findings (shot + severity) as backlog lines, on freshly
rebuilt workspace bundles (P3-052 hardening — the runner rebuilds before the journey, fail-closed
on a failed build, so the agent never reviews a dist outliving its checkout),
budget-capped per run. Builders must end
their output with a final EVIDENCE block (real typecheck/test:unit outputs, plus 1440x900 and
390px screenshot paths for UI tasks) — the gatekeeper re-executes the cited commands and rejects
missing or fabricated evidence (P2-009), BEFORE the reviewers since P1-101 (the re-run now
captures stderr too, so vite warnings no longer fake a divergence). With `slots` > 1
in pilot.json the scheduler runs up to N pipelines concurrently, one workspace clone per slot
(`~/.opencode-remote/pilot/repo-1`, `repo-2`…), always on tasks with distinct `area:` tags —
two tasks of the same area never run in parallel, and deploys stay serial (P1-006). Slots
carry cache affinity (P1-078): a task prefers the free slot that last ran the same area
within ~10min (provider prefix-cache inheritance) and simultaneous slot starts are staggered
20s so the first builder's cache-write completes first; per-slot cache hit ratios are logged
as `slot cache` and folded into `state.slotCache`. After every
successful merge a SCRIBE agent distills up to 3 engineering lessons into `docs/EXPERIENCE.md`
(P1-007) — the top-5 keyword-matched lessons are injected into the planner, builder and
strategist prompts (P2-042), and the nightly red-team pass dedupes/prunes the file above 60 lessons.
When the stop-loss moves a
task to `## Blocked`, a failure scribe records a structured `kind:"failure"` lesson (failing step,
findings, gate tail) in `~/.opencode-remote/pilot/lessons.jsonl` (P2-031) and the strategist and
planner prompts receive the 10 most recent failure lessons so new tasks avoid repeating blocked patterns.
If you are asked to change anything that
the constitution protects (crypto, allowlist, replay protection, deploy/), flag it explicitly in
the commit message. Never commit secrets. Always document user-visible changes.

## Memória do projeto (LER PRIMEIRO)

Histórico completo de trabalho, regras do usuário, avaliação de maturidade e backlog:
`~/.opencode-remote/memory.md` — leia antes de qualquer tarefa neste repo.
Regras rápidas: memórias (`~/.opencode-remote/memory.md`) NUNCA são comitadas;
fuso GMT-3; só reiniciar daemon/relay se o Caio pedir; checar `git log`
antes de assumir HEAD (um agente in-chat também commita neste repo).
This machine also runs a media pipeline for social clips. When the user sends a video and asks
to clip/edit it for social media, follow the pipeline below — everything runs locally.

## Video clipping skill (OpusClip-style, local)

Tools: `tools/clip.mjs` (needs whisper-cli + ffmpeg, already installed).

1. **Transcribe** (word-level timestamps):
   `node tools/clip.mjs transcribe <video>` — prints the path of a JSON with timed tokens.
2. **Select moments** — read that JSON yourself. Pick 1-6 segments of 15-60s that stand alone,
   have a hook in the first 3s and a clean ending (complete sentence). Write a `plan.json`:
   ```json
   { "transcriptJson": "/abs/path/transcript.wav.json",
     "clips": [
       { "start": 12.3, "end": 45.6, "title": "Short punchy title",
         "captions": true, "aspect": "9:16", "cropX": 0.5 }
     ] }
   ```
   `cropX`: 0 = left, 0.5 = center, 1 = right (who is talking in frame).
3. **Render**:
   `node tools/clip.mjs render <video> plan.json`
   — outputs 1080x1920 mp4s with burned karaoke captions to `~/.opencode-remote/clips/<video>/`.
4. Reply with title + absolute path of each clip. Do not re-encode with different codecs
   unless asked; keep the defaults (h264/aac, faststart, crf 20).

Videos the user sends from the phone are saved under `~/.opencode-remote/uploads/`.

## Entregando arquivos pro usuário (PDF, planilhas, relatórios...)

Quando gerar um artefato para o usuário, salve-o em `~/.opencode-remote/uploads/`
e inclua na sua resposta uma linha no formato:

    [file: /Users/<user>/.opencode-remote/uploads/relatorio.pdf]

O app do celular mostra um card com botão "Save" — o usuário salva direto
no telefone. Diretórios acessíveis para download: `~/.opencode-remote/uploads`,
`~/Desktop`, `~/Downloads`, `~/Documents` e o diretório deste repo. (RT-466)
Links simbólicos para fora dessas pastas não são baixáveis — o caminho é
resolvido pelo sistema de arquivos (realpath) antes da admissão e a listagem
de `/__ocr/files` nunca anuncia uma entrada symlink.

Caption appearance can be customized: `~/.opencode-remote/clip-style.json` accepts
`font`, `fontSize`, `primary`, `secondary`, `outlineColor`, `outline` and `marginV`.
The phone app edits this file for you — if the user asks for a caption style change,
tell them to use Settings → Caption style.

## Conversão de documentos (doc → PDF)

Quando o usuário mandar um documento (`.docx .doc .rtf .html .csv .xlsx .pptx`) e quiser
um PDF de volta, rode `node tools/doc2pdf.mjs <arquivo>` (padrão: arquivos em
`~/.opencode-remote/uploads/`) — usa LibreOffice quando instalado, com fallback nativo
macOS (textutil+cupsfilter) p/ doc/docx/rtf/html/csv. A saída imprime `[file: <abs path>]`;
repita essa linha na resposta pro card de download aparecer no chat.

O que a máquina precisa (P2-231): com LibreOffice instalado a conversão é
completa (todos os formatos, fidelidade preservada) — o conversor é descoberto
pelo PATH e pelos caminhos padrão de instalação (app bundle no macOS;
`C:\Program Files\LibreOffice\program\soffice.exe` no Windows). Sem LibreOffice
no macOS resta o fallback nativo (textutil+cupsfilter), só p/ doc/docx/rtf/html/csv
e sem preservar formatação. Sem nenhum conversor, a ferramenta responde com
uma frase curta em português pedindo a instalação do LibreOffice — nunca um
erro cru em inglês — e o arquivo original continua intacto. A prontidão da
conversão também viaja em `/api/health` (`docConvertState` /
`docConvertMessage` / `docConvertExts`), sondada no boot e revalidada
preguiçosamente no ponto de uso (P2-250, no máximo uma vez por
`OCR_READINESS_MIN_MS` por capacidade; `OCR_READINESS_DISABLE=off` desliga).

## Artifacts (documentos renderizáveis)

Quando o resultado for um documento (html, md, csv, pdf…), escreva-o em
`~/.opencode-remote/artifacts/<sessionId>/` e **mencione o nome do arquivo na
sua resposta** — o app desktop lista esses arquivos no pane "Artifacts"
(html em iframe sandboxed, md/tabelas e csv renderizados, pdf inline) e mostra
um card anexado na mensagem que cita o artifact. Use `uploads/` (método acima)
quando o objetivo for o usuário baixar o arquivo no celular.

## Missão da frota (self-serve, só pelo chat)

O usuário define ou muda a missão da frota autônoma (Pilot) **do jeito que
quiser** — vago ("conserta o bug do meu app"), só um link, ou detalhado
(pedido + repo + preferências). Você compõe sozinho o
`~/.opencode-remote/mission.json` COMPLETO a partir do que ele disse:
`{"v":1,"prompt":"<intenção do usuário, fiel e autocontida>","repoUrl":"https://github.com/<org>/<repo>.git","models":{"<papel>":"<provider/modelo>"},"setAt":"<ISO 8601>"}`.
Campos ausentes são omitidos, nunca inventados.

- `repoUrl`: se aparecer QUALQUER link do GitHub nas palavras do usuário (no
  meio da frase, com `/tree/...`, sem https, com `.git` ou barra final),
  deduza org/repo e normalize para `https://github.com/<org>/<repo>(.git)?` —
  só esse formato vale. Sem link, omita: a frota trabalha neste repo mesmo.
- `prompt`: afirmação fiel e autocontida do que o usuário quer (quem lê só o
  arquivo, sem o chat, entende) — pode ser uma frase só. Nunca invente
  requisitos, critérios ou escopo que ele não disse; só link → sem prompt.
  Pelo menos um de `prompt`/`repoUrl` é obrigatório.
- `models` (opcional): papel → id de modelo; papéis válidos:
  `strategist|researcher|builder|reviewer|scribe` (subconjunto permitido;
  qualquer outro papel invalida o arquivo inteiro). Só grave um id que você
  verificou na saída de `opencode models` (formato `provider/modelo`); quando
  o usuário perguntar quais modelos existem, rode `opencode models` e liste.
  Sem pedido de modelo, omita o campo.
- Nunca grave tokens, chaves ou segredos. Escrita atômica e privada: grave em
  `mission.json.tmp`, `chmod 600`, depois `mv` por cima de `mission.json`.
- Encerrar a missão ("missão limpa", "encerrar missão", "voltar pro repo de
  vocês"): apague o arquivo com `rm -f ~/.opencode-remote/mission.json` — a
  frota volta ao modo de auto-evolução deste repo no próximo boot.
- Confirme em uma frase curta que a frota pega a missão (ou o encerramento)
  no próximo boot (o pilot detecta a mudança de hash e se reinicia sozinho —
  idle primeiro, forçado após 15 min). Não existe formulário: o chat é o único
  caminho.

## Auto-preview (site local abre sozinho no app)

Quando você subir um servidor/site local (http.server, vite, dev server…),
**mencione a URL `http://localhost:<porta>` na sua resposta** — o app desktop
abre o pane Browser sozinho (webview interativo, lado a lado com o chat).
A detecção é um parse determinístico de URLs loopback com porta explícita
(1..65535, exceto a própria porta do daemon 8792), dedupado por 10 minutos;
URLs não-loopback não disparam preview.

## Browser self-driving (validação visual de UI)

O daemon controla um Chromium headless no host via `/api/browse` (Playwright).
Para validar visualmente mudanças de UI, use o CLI:

    node tools/browse.mjs open <url> [shot.png]   # navegar (+ screenshot)
    node tools/browse.mjs shot <out.png>          # screenshot da página atual
    node tools/browse.mjs click "text=Settings"   # ou click <x> <y>
    node tools/browse.mjs text                    # extrair texto visível

O token vem de `~/.opencode-remote/daemon.json` (loopback apenas). Screenshots
pós-deploy ficam em `~/.opencode-remote/pilot/shots/` (evidência por task,
com retenção dos 20 mais recentes) e reviewers os citam no veredito
(docs/PILOT.md). Seus próprios checks pré-merge vão em
`~/.opencode-remote/pilot/shots/builder/` — o subdir builder não é usado como
evidência de review.

Desktop app: para interagir com o app Electron real use o harness
`tools/desktop.mjs` (`open/see/click/type/shot/ipc/close`, mesma DX do
browse.mjs) — launch hermético, sem daemon de produção. Quando o diff toca
`apps/desktop/` ou `apps/web/`, o gate roda `npm run test:desktop-flow` (fluxo
de interação real, <420s — P1-070 adicionou o bloco "local boot" com daemon
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
use
`OCR_DESKTOP_SESSION` próprio para não colidir
com a sessão de outro processo. P1-081: com `OCR_DESKTOP_SESSION` setado o app
NÃO mostra janela (`showMainWindow` no-op + `paintWhenInitiallyHidden`, interação
100% via webContents) — a tela do operador nunca vê janela de teste; e
`test:e2e`/`test:desktop-flow` rodam `scripts/e2e-orphans.ts` antes (mata
órfãos electron/daemon/relay de runs anteriores — só processos com marker
argv E env `ocr-*`/`OCR_*` de teste; argv sozinho nunca mata) e todos os
servers e2e sobem em portas efêmeras com diagnóstico `lsof` no timeout.
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
