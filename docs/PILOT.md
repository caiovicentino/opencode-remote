# Pilot — desenvolvimento autônomo 24/7

O **Pilot** é um serviço launchd (`com.ocr.pilot`) que evolui este repositório
sozinho: pega tarefas do `BACKLOG.md`, implementa com um agent (builder), passa
por **2 reviewers adversariais independentes**, um **gatekeeper determinístico**
(bateria de eval + invariants), mergea via PR do GitHub e faz **deploy staged com
rollback automático**. Nenhum humano no loop.

## Arquitetura

```
BACKLOG.md ──> BUILDER ────┬──> SECURITY REVIEWER ─┬──> GATEKEEPER (determinístico)
  (fila)                   │   (contexto isolado)   │    typecheck · build · unit ·
                           └──> QUALITY REVIEWER ───┘    reconnect · integration ·
                                (contexto isolado)       invariants · download
                                   │                     │
                                    └─ VERDICT: ... ───────┘
                                                             │
                                      merge (gh pr squash) <─┘
                                           │
                                      OPS: deploy staged
                                      reset SHA → install (fast/ci) → build → kickstart
                                      → health watch (90s) → soak (10min)
                                      → OK: digest push / FAIL: auto-rollback
```

### Meta-commits: a branch `pilot/meta` (P1-076)

Nenhum commit "meta" (mark-done, refill do strategist, lições do scribe, achados
do red team/explorer, bloqueios do circuit breaker, amostras do corpus) é
empurrado direto em `main`. Todos pousam pela branch permanente `pilot/meta`
(`landMetaCommit` em `apps/pilot/src/metapush.ts`): re-base em `origin/main` →
edição determinística → guard do diff (P1-057, relido a cada attempt) → push
com `--force-with-lease` em `pilot/meta` (um landing concorrente que empurrou
depois do nosso fetch falha o push em vez de ser sobrescrito) → PR com squash +
`--auto` (auto-merge quando a proteção de branch está ativa; sem proteção,
merge imediato). Antes do rewind, um PR meta ainda **aberto** (landing pendente
esperando checks) é **esperado até o merge** — rebobinar o head pendente
reiniciaria as checks a cada re-entrada (livelock do circuit breaker) e
descartaria landings do mesmo slot (mark-done → corpus → scribe). O sucesso só
é reportado com **verificação fail-closed no mesmo poll** (P1-076 R4/R6):
`gh pr view --json state,headRefOid` deve retornar `state === "MERGED"` **e**
`headRefOid ===` o nosso sha empurrado — armar o `--auto` não é sucesso, e um
`MERGED` com head substituído por landing concorrente é `failed` honesto (o
ancestral de `origin/pilot/meta` e o sha indeterminável continuam reprovando).
Orçamento de confirmação/espera: ~5 min por fase (60 polls × 5s), cobrindo um
run verde de checks sob proteção. O retry do ciclo seguinte **converge como
noop** quando o estado desejado já existe: o `apply` de refill/bloqueio detecta
linha duplicada / task já bloqueada (`"applied" | "noop" | "missing"`) e o
landing reporta sucesso sem novo commit — nunca um abort eterno. Um landing
descartado por landing concorrente é re-aplicado e, no pior caso, reportado
honestamente como `failed` (refill persiste no store P1-037, bloqueio
re-tenta no próximo ciclo ocioso). O PR é reutilizado entre
landings e a branch **nunca** é apagada. Falha do `gh` deixa o commit em
`origin/pilot/meta` e é retentada no próximo ciclo — **não existe fallback para
`git push origin main`** (a bateria de eval reprova qualquer `push -q origin main`
no código do pilot com um check grep-style).

**Runbook do operador (pós-merge)**: ativar a proteção de branch no GitHub para
`main` — "Require a pull request before merging" + squash merges + as checks
requeridas do CI existente. Nenhuma mudança de código é necessária: com a
proteção ativa, `gh pr merge --squash --auto` arma o auto-merge e o landing
confirma o squash via `gh pr view` (estado + headRefOid) dentro do orçamento de
~5 min, esperando as checks terminarem (o caminho sem proteção continua
funcionando como fallback de merge imediato; landings pendentes de outros
landings são esperados, nunca rebobinados).
**Janela conhecida**: enquanto a proteção não está ativa, o squash imediato do
PR meta entra em `main` **sem checks** — a propriedade "auto-mergia quando a
bateria leve passa" só vale pós-runbook; a segurança do deploy não muda,
porque o deploy só embarca SHA verificado pós-gate (P2-058). Critério
operacional: 24h de logs do pipeline sem nenhum push direto em `main`;
deploys continuam saindo de PRs mergeados (SHAs verificados, P2-058).

### Roles (todos `opencode run` headless)

| Role | O que faz | Timeout |
|---|---|---|
| `planner` | para tasks **P0/P1**: agent read-only lê o código e escreve `specs/<ID>.md` na branch antes do builder | 10 min |
| `builder` | implementa a task em branch `pilot/<id>`, commita | 45 min |
| `security reviewer` | foco: crypto, auth, injection, secrets | 20 min |
| `quality reviewer` | foco: regressão, UX, docs, testes | 20 min |
| `scribe` | após o merge: destila até 3 lições do diff (P1-075: só o diff — findings de review não entram no prompt) → `docs/EXPERIENCE.md` | 10 min |
| `strategist` | quando a fila tem <2 tasks: lê código/memória/métricas e propõe as próximas tasks (o runner valida e pousa via PR `pilot/meta` com guard) | 25 min |
| `red team` (1x/dia, janela >= 2h ocioso) | tenta quebrar segurança/robustez; achados viram task P0 | 30 min |
| gatekeeper | **não é LLM** — roda scripts, decide por exit codes | — |

Builders e reviewers rodam em **clone isolado** (`~/.opencode-remote/pilot/repo`);
o checkout de produção só é tocado no deploy.

O gatekeeper roda typecheck + build em **todos os workspaces**, incluindo o shell
desktop (`apps/desktop`), e `scripts/invariants.ts` verifica que o renderer Electron
nasce sandboxed (contextIsolation on, nodeIntegration off) e que o sidecar do daemon
está wired (spawn com `ELECTRON_RUN_AS_NODE`, espera `/api/health` com 200 autenticado,
cleanup no quit). O gate também roda `scripts/desktop-sidecar.test.ts` (spawn/reuse, SIGTERM→SIGKILL,
aborto quando o filho morre, e o caso "servidor 200-para-tudo na porta não é
saudável" — sem token e mesmo com token, o challenge do healthOnce reprova). Empacotamento (DMG/notarização,
`npm run dist`) fica fora do gate — é etapa de distribuição. O smoke determinístico
desse output (`npm run dist:smoke --workspace @ocr/desktop`, P3-010) valida sem
abrir o app que o bundle empacotado carrega `web-dist/index.html`, o sidecar
`daemon/index.js` e o binário (layouts mac/win/linux) — também fora do gate por
design; é o chão do estágio 5 (instaladores assinados).

O gate também roda a invariant **anti module-shadowing** (P2-014): o diff de
merge (`origin/main...HEAD`) não pode introduzir na **raiz do workspace**
arquivo com nome de módulo stdlib de runtime (`struct.py`, `os.py`, `base64.py`,
`json.py`, `types.py`, `random.py`) — cadeias de hijack de agente (RCE em Auto
Mode, 26/08/2026) extraem arquivos não-confiáveis e rodam código dentro deles,
sombreando o stdlib de qualquer Python executado depois. Se o diff não puder
ser computado, a invariant reprova (fail-closed). O parser do diff é puro
(`scripts/stdlib-shadow.ts`) e coberto em `scripts/unit.test.ts`.

Quando o diff da task toca `apps/desktop/` **ou `apps/web/`** (a UI que o smoke
valida), o gate também roda o **render smoke** (`npm run test:desktop-render`):
além do boot do processo, o driver (`scripts/desktop-render-driver.cjs`) sobe o
Electron de verdade com as mesmas `webPreferences` sandboxed, carrega o build da UI
(`apps/web/dist/index.html`) via `file://`, espera `did-finish-load`, captura erros
de console do renderer (`webContents.on("console-message")`) e confere que o `#root`
ganhou conteúdo — **janela branca reprova** (ex.: asset 404 em `file://`). A captura
de console é verificada com um **canário**: o driver injeta um `console.error`
conhecido logo após o load e exige que o listener o tenha visto — um bump do Electron
que mude a assinatura do evento reprova alto em vez de passar vazio. Desde a P3-005
a UI não registra ServiceWorker em `file://` (app desktop), então **qualquer** erro
de console do renderer reprova. O trigger é **fail-closed**: se `git diff`
falhar, o smoke roda de qualquer jeito. O teste roda sem tocar no daemon de
produção: `userData` do Electron é temporário e nenhum sidecar é spawnado.

### Harness de interação no app desktop (P1-051)

O render smoke valida boot + montagem; para **interagir** com o app real os
builders usam `tools/desktop.mjs` (mesma DX do `browse.mjs`): `open [shot [w h]]`,
`see <texto>`, `click <sel>`, `type <sel> <texto>`, `shot <out.png> [w h]`,
`ipc <expr>` (avalia contra `window.ocrDesktop` e imprime JSON) e `close`. O
launch é hermético via Playwright `_electron`: `userData` temporário
(`OCR_USER_DATA_DIR`), state file sem `apiToken` (`OCR_DAEMON_STATE_FILE`),
`OCR_DAEMON_ENTRY` inexistente (nenhum sidecar spawnado) e `OCR_DAEMON_FORCE_DOWN`
(state de pairing determinístico `daemonDown:true`). Um keeper destacado mantém o
app vivo entre os comandos CLI por até 5min de idle; `OCR_DESKTOP_SESSION`
isola a instância — **o gate usa sessão única por execução** para nunca colidir
com a sessão `main` de um builder. Toda sessão vive num **dir 0700** próprio
(socket `chmod 0600` pós-bind + **token random 0600** que cada request deve
apresentar e **provar** — o keeper responde `sha256(token:nonce)`; server
impostor no path responde, mas não prova — achado do review round 2). Quando
o diff toca `apps/desktop/` ou
`apps/web/`, o gatekeeper roda também o **desktop-flow** (`npm run
test:desktop-flow`): 1 fluxo real de interação (abrir app → digitar código de
pairing inválido → clicar Pair → assert do erro visível → shot → asserts de IPC
`app:version` e `app:pairingState`) com orçamento de **60s**. O rail desktop
(Conversas/Artifacts) só renderiza com o app pareado a um daemon vivo — fora do
escopo hermético por design (chaves E2E reais).

## Lane de auto-modificação (autocatálise, P1-044)

Task cujo diff toca `apps/pilot/**` é o caso em que o sistema edita o próprio
cérebro — o merge recebe um caminho reforçado no gate e no deploy:

- **Gate exige golden corpus verde (P3-033)**: quando o diff toca `apps/pilot/`,
  o gatekeeper roda uma checagem determinística extra (`corpusGateDetail`) sobre
  `apps/pilot/src/__fixtures__/gate-corpus/`: ≥3 amostras reais por comando de
  evidência, cada amostra casa consigo mesma e com a forma truncada, e uma linha
  fabricada sobre a amostra continua sendo rejeitada. Se o diff não puder ser
  computado, a checagem roda de qualquer jeito (fail-closed). Motivo: a calibração
  do próprio gate (evidence matcher) não pode regredir através de um merge.
- **Soak dobrado com `invariants --live` extra (b)**: o deploy detecta a lane pela
  faixa de SHAs que está aplicando (`git diff --name-only prev..sha -- apps/pilot`,
  cobrindo também deploys empacotados e o self-heal de "pending deploy") — se toca
  `apps/pilot/**`, dobra a janela de soak (`soakMinutesFor` — mínimo 20min,
  `2×monitorMin` quando maior) e roda `scripts/invariants.ts --live` adicional a
  cada 5 checagens (~5min); falha em qualquer rodada extra quarentena o SHA e rola
  back imediatamente. O probe extra toca o heartbeat do watchdog **antes e depois**
  da execução (que bloqueia o event loop por até 5min) — sem isso o watchdog mataria
  o próprio processo no meio do soak, antes da quarentena, deixando o SHA sem soak
  rodando (achado do review round 2).
- **Rollback por taxa de falha (c)**: antes de qualquer mutação o deploy amostra a
  saúde do deploy antigo 3× (`BASELINE_SAMPLES`) e calcula a taxa de falha
  baseline. Durante o soak, uma janela deslizante de 5 checagens
  (`SOAK_WINDOW`) com taxa de falha acima do baseline em mais de 20%
  (`SOAK_RATE_TOLERANCE`) rola back — pegando degradação intermitente que a regra
  de "3 falhas seguidas" nunca vê.
- **Branch preservada entre attempts (d, pré-requisito P1-036)**: já garantida
  pelo `preserveBranch` (P1-060/P1-036) para **qualquer** task — attempt 1 começa limpo,
  attempts seguintes continuam a branch `pilot/<ID>` existente (o builder é
  instruído a continuar o trabalho commitado, não recomeçar do zero).

Critério de sucesso da lane: tasks de infra do próprio pilot (ex. P1-034, P1-035)
mergeadas pelo workflow sem intervenção humana.

## Deploy staged + rollback

0. **Guard de SHA verificado (P2-058)**: o `deploy()` só aceita SHA que o
   gatekeeper gravou em `~/.opencode-remote/pilot/verified-merges.jsonl` no
   momento do merge (squash de PR pós-gate verde, gravado por código
   determinístico — nunca por um agente). Commit direto em
   main — bookkeeping (mark-done, scribe, refill do strategist) ou hostil — é
   pulado pela caminhada first-parent em `origin/main` e **nunca dispara
   deploy** (caminho da fábula de segurança #2/#3). Sem nenhum SHA verificado
   alcançável, não há deploy (fail-closed).
0b. **Quarentena (P2-058)**: deploy que falha (steps, health, invariants live,
   soak) quarentena o SHA em `~/.opencode-remote/pilot/quarantine.jsonl` antes
   do rollback — o self-heal de "pending deploy" pula o SHA ruim e production
   fica no último SHA verificado bom, em vez de re-deployar em loop o mesmo
   cérebro defeituoso. Um merge posterior (com a correção) volta a destravar.
0c. **Guard de disco (P3-006)**: antes de qualquer mutação (git/npm), `statfs` no
   repo de produção — com menos de **5GB livres** o deploy aborta com detail
   claro (`disk low: Xgb free (need 5.0gb) — deploy aborted before npm ci/build`),
   evento `disk-guard` no feed e `notifySupervisor` em vez de falhar depois com
   um `git index.lock` críptico. Sonda indisponível = fail-open (não bloqueia).
1. `git reset --hard <sha>` no repo de produção + install + `npm run build`.
   **P1-021**: o install é decidido pelo hash do `package-lock.json` persistido
   em `~/.opencode-remote/pilot/last-install.json` — lock inalterado roda o fast
   path `npm install --prefer-offline --no-audit --no-fund --ignore-scripts`
   (sem wipe de node_modules, ~segundos); lock alterado, estado ausente/corrupto
   ou hash indisponível roda `npm ci` completo (fail-closed). Fast install que
   falha cai para o ci completo antes de declarar erro (escada de reparo).
   Binários electron/ffmpeg saem de cache local (`ELECTRON_CACHE=~/.cache/electron`)
   em ambos os caminhos. O hash só é (re)gravado após um ci bem-sucedido
   (deploy novo ou rollback), mantendo o invariante "hash persistido == lock
   instalado em disco".
2. `launchctl kickstart -k` relay, daemon e `com.ocr.pwa` (relay/daemon derrubam-se
   com shutdown graceful: drain ≤3s, ws close 1001, exit 0 — daemon P2-020,
   relay P2-023; o kickstart do PWA é best-effort — serviço existe após rodar
   `deploy/install.sh` uma vez, P2-075)
3. Health: `GET 127.0.0.1:8792/api/health` (Bearer apiToken) até 90s
4. Soak: checagens a cada 60s por `monitorMin`; 3 falhas seguidas = rollback
   (deploy que toca `apps/pilot/**` dobra a janela, roda `invariants --live`
   extra e ganha rollback por taxa de falha — ver Lane de auto-modificação)
5. Rollback: reset para o SHA anterior + rebuild + kickstart (idempotente).
   **P2-041**: em vez de um `sleep` às cegas, o rollback fecha com a verificação
   `verifyRollbackHealth` — sondas a cada 5s por até 30s no `/api/health`, estado
   logado no pilot.log (`rollback-health`) e evento `rollback-health` no feed.
   Prod ainda unhealthy após o rollback acende o chip vermelho "PROD UNHEALTHY"
   no dashboard (o veredito mais recente vence; um deploy limpo posterior apaga)
   e notifica o supervisor — nunca mais silêncio pós-rollback.

## Budgets e kill switch

- `~/.opencode-remote/pilot.json` (opcional): `maxTasksPerDay` (6), `maxDeploysPerDay` (6),
  `maxReviewRounds` (3), `maxAttemptsPerTask` (4), `slots` (1), `taskTimeoutMin` (45), `monitorMin` (10), `digest`.
- Tasks com a tag `(size: L)` escalam os próprios budgets — ver a seção abaixo.
- **Freeze**: `touch ~/.opencode-remote/pilot.lock` para o loop (checado a cada ciclo).
- Contadores diários em `~/.opencode-remote/pilot/state.json`.
- **Escrita atômica (P2-024)**: `state.json` é gravado via tmp+rename
  (`writeJsonAtomic`) — um crash/OOM/disco cheio no meio da escrita não deixa
  mais arquivo truncado (que zeraria o circuit breaker `taskAttempts`).

## Cognição em tiers (P1-059)

Papéis de **julgamento** merecem modelo mais forte; papéis de **execução**
seguem no flash (tier A, `opencode run` com o modelo configurado do
opencode.json — os nomes em `tierA` são documentação, não mudam o dispatch).
Sem o bloco `models` no pilot.json, **tudo é tier A** (comportamento anterior
intacto). Bloco opcional:

```json
"models": {
  "tierA": { "builder": "glm-5.3-flash", "reviewer": "glm-5.3-flash", "scribe": "glm-5.3-flash" },
  "tierB": { "strategist": "fable-5.1", "planner": "opus", "forensic": "fable-5.1", "reviewerEscalation": "opus" }
}
```

- **Dispatch tier B** (`runAgentForRole` em `apps/pilot/src/runner.ts`): se o
  papel tem modelo em `tierB`, roda via **CLI claude** — `claude -p --model <m>
  --add-dir <workspace> --permission-mode acceptEdits`, prompt via **stdin**
  (fechado após EOF), timeout com a mesma escada SIGTERM→SIGKILL do `runAgent`.
  `--add-dir` fica restrito ao clone do slot: nada de `~/.opencode-remote` no
  tier B (a regra anti-exfiltração do strategist se mantém).
- **Fallback**: spawn error, timeout, output vazio ou marker de conclusão do
  papel ausente (`PLANNER:DONE`, `STRATEGIST:DONE`, `VERDICT:`,
  `FORENSIC:DONE`) ⇒ o mesmo prompt re-executa pelo tier A e o pilot.log recebe
  `tierB-fallback` — o pipeline nunca trava nem queima attempt por indisponibilidade
  do tier B. Sem tier B configurado, `runAgentForRole` === `runAgent`. Cada
  dispatch loga `agent-dispatch` com role/tier/model.
- **Runs tier B são non-streaming e context-less**: `claude -p` imprime a
  resposta final uma única vez — `onStdout` não é ligado ao output tier B e
  não há session id para resume; `sessionId`/`onStdout` só valem quando o
  papel roda (ou cai) no tier A. O watchdog é alimentado por timers internos
  de heartbeat — `runTierB` (non-streaming) e `runAgent` (P1-035: timer de
  60s armado no spawn, parado em exit/error; um agent silencioso não derruba
  mais o pilot com slots em voo).
- **Papéis tier B**: planner de P0/P1 (o spec commitado passa pelo mesmo
  `validateSpec`/gate determinístico), strategist (refill de qualidade),
  **reviewer de escalada** e **forensic semanal** (abaixo). O gatekeeper e a
  bateria de evidência não mudam: modelo forte planeja/julga, mas o merge passa
  pela mesma evidência.
- **Escalada de review**: vereditos divergentes (1× APPROVE vs
  1× REQUEST_CHANGES) no round 1, ou findings **todos** unverificados **em
  qualquer round** (P1-073), disparam **1** reviewer
  extra com o modelo `reviewerEscalation` (fase `review-escalation` no feed);
  o veredito dele decide e, quando rejeita, os findings verificados dele se
  **somam** (união, dedup) aos findings verificados do round 1 que seguem para
  o builder. Máx. 1 escalada por round. Sem `reviewerEscalation` configurado —
  ou quando um REQUEST_CHANGES tem **todos** os findings unverificados — vale
  fail-closed (P1-073): o veredito de rejeição permanece e o builder recebe a
  instrução de reformular a concern citando evidência verificável
  `path:line` do diff; findings unverificados nunca mais aprovam por padrão.
- **Forensic semanal**: na passada noturna (primeira janela >= 2h ocioso do
  dia — P1-095), um agente analisa as últimas
  100 failure lessons (`lessons.jsonl`), os carryovers de gate-fail e o
  `git log -50` e escreve a taxonomia de falhas (padrões, causas raiz,
  recomendações) em `~/.opencode-remote/pilot/forensic-latest.md` + digest no
  telefone. Guard próprio de 7 dias (`state.forensicLast`, persistido **antes**
  do run); falha é best-effort e nunca bloqueia o loop. O relatório chega ao
  disco pelo runner (stdout), nunca por write direto do agente fora do workspace.

## Tarefas long-horizon — campo size (P1-060)

A linha da task no BACKLOG.md pode carregar a tag opcional `(size: S|M|L)` (default
`S` quando ausente ou desconhecida), no fim da linha junto da tag de área:
`- [ ] (P1-060) [P1] Título — spec: ... (size: L) (area: desktop)`.

- **Budgets por size**: S/M mantêm os budgets clássicos (3 rounds de review, 45min
  por round de builder, 4 attempts); **L** escala para **6 rounds, 90min por round,
  6 attempts** antes do circuit breaker (`budgetsFor` em `apps/pilot/src/pipeline.ts`).
- **Checkpoint review**: em tasks L, o início de cada round de builder grava o SHA
  corrente da branch em `~/.opencode-remote/pilot/checkpoints/<ID>.json`; os
  reviewers dos rounds > 1 recebem o diff **incremental** desde esse SHA
  (`git diff <sha> pilot/<ID>`, com nota explícita de que rounds anteriores já
  foram revisados) em vez do diff total truncado a 60.000 chars. Diff incremental
  vazio ou falho cai no fallback do diff total da branch; round 1 e tasks S/M
  sempre recebem o diff total.
- **Branch preservada entre attempts** (pré-requisito P1-036): só o primeiro
  attempt recomeça limpo (`checkout -B` a partir de origin/main); attempts
  seguintes fazem `git checkout pilot/<ID>` sem reset, preservando o histórico —
  o prompt do builder recebe o bloco "attempt N: a branch já existe, continue do
  histórico". A branch preservada já contém o spec commitado, então o planner não
  é re-executado (o `commitSpec` dele resetaria a branch e destruiria o trabalho):
  se a cópia em disco estiver ausente/adulterada, o spec é recuperado do histórico
  da branch; irrecuperável com commits preservados → fail fast sem destruir nada
  (o planner só re-roda quando a branch não tem nenhum commit além de origin/main).
- **Planner com marcos**: para tasks L, o planner precisa estruturar a seção
  `## Approach` em marcos numerados M1..Mn com critério de aceite por marco; o
  builder executa os marcos em ordem, 1+ por round.
- **Strategist**: no máximo 1 épico `(size: L)` por batch, apenas para trabalho
  genuinamente indivisível, com os marcos listados na própria linha do BACKLOG.

## Paralelismo com slots (P1-006)

`slots` (pilot.json, default 1) controla quantos pipelines rodam **concorrentes**:

- Cada slot tem um **workspace clone próprio**: `~/.opencode-remote/pilot/repo-1`,
  `repo-2`… criado na primeira vez via `git clone --shared` do checkout de produção
  (objetos compartilhados, clone barato) com o remote `origin` apontando pro GitHub
  e **deps bootstrapadas com npm ci** antes do slot ficar utilizável. A chave
  `workspace` do pilot.json virou legada e é ignorada — os paths dos slots são
  derivados do número do slot.
- O scheduler (`apps/pilot/src/index.ts`) lê a fila direto de `origin/main`
  (`git show origin/main:BACKLOG.md`) — worktrees de slots ocupados nunca são
  fontes de verdade. Tasks de **áreas diferentes** rodam em paralelo; **duas
  tasks da mesma área nunca rodam juntas**. Task sem tag de área roda serial
  (uma por vez). Os budgets diários (`maxTasksPerDay`, `maxDeploysPerDay`)
  são **globais** a todos os slots.
- **Área da task**: o strategist/researcher taggeia o **fim da linha** com
  `(area: ui|daemon|desktop|infra|relay)`. A ui = apps/web, daemon = apps/daemon,
  desktop = apps/desktop, infra = build/scripts/deploy/pilot, relay = apps/relay.
  Tag fora desse vocabulário vira serial (sem área).
- **Eager-fill dos slots (P1-099)**: o fim de cada pipeline (hook `finally` do
  slot) preenche **imediatamente todos** os slots livres — o recém-liberado
  **e** qualquer outro ocioso — lendo a fila fresca de `origin/main`; o loop
  principal segue agendando no ciclo de 5s. O log diferencia a origem:
  `pipeline start` com `reason:"loop"` (ciclo do dispatcher) ou
  `reason:"eager-fill"` (fim de pipeline). Assim, com Ready ≥ 2 tasks de áreas
  distintas, os dois slots ficam quentes em vez de alternar no slot 1.
- **Gate paralelo entre slots (P1-099)**: desde a P1-081 a bateria de eval é
  hermética — portas efêmeras pedidas ao kernel, `OCR_DESKTOP_SESSION` único
  por run — então o gatekeeper roda **concorrente** nos slots (sem lock
  global). Merge concorrente em main é seguro: o caminho de PR é serializado
  pelo servidor GitHub e o fallback local refaz `fetch` + retry em
  non-fast-forward. `recordVerifiedMerge` é síncrono, portanto atômico no
  event loop.
- **Cache affinity entre slots (P1-078)**: o cache de prefixo do provider é
  por conta/organização — os slots batem no mesmo provider e podem herdar
  cache um do outro. O scheduler registra em memória qual area key cada slot
  rodou por último e, ao preencher slots livres, uma task **prefere o slot
  que acabou de rodar shape similar** (mesma `area`) dentro de um TTL de
  10min (`AFFINITY_TTL_MS`; mais recente vence; sem affinity → slot de menor
  número; key `solo` nunca ganha affinity). A regra P1-006 (duas tasks da
  mesma área nunca em paralelo) continua valendo — affinity só escolhe entre
  slots livres. **Starts escalonados**: quando 2 slots iniciam no mesmo ciclo,
  o segundo espera ~20s (`SLOT_START_STAGGER_MS`) para o primeiro completar o
  cache-write do prefixo. O pick escalonado é anunciado como `pipeline staged`
  (evento `phase:"staged"`) e só loga `pipeline start`/`picked` quando spawn de
  fato; o timer re-checa `frozen`/audit antes de spawnar — **sem** re-checar
  orçamento: o pick já foi commitado dentro do cap pelo `pickBatch` no momento
  da reserva (a reserva conta em `running.size`), e re-contá-la descartaria
  picks válidos quando o lote preenche exatamente o budget restante. A affinity
  é in-memory (perde-se no restart, aceitável para um TTL
  de minutos). **Métrica por slot**: a reconciliação de custos emite
  `msg:"slot cache"` com `{slot, task, input, cacheRead, cacheWrite, ratio}` e
  dobra em `state.slotCache` (janela viva, substituída a cada task) — o
  critério de efeito é `cache.read > 0` no segundo builder do par de affinity
  no `opencode.db`. **Limitação conhecida**: cada spawn headless roda em cwd
  distinto e o próprio opencode injeta `Working directory: ${cwd}` + header
  absoluto do AGENTS.md no bloco `<env>` do system prompt — bytes fora do
  controle do pilot, então a herança cross-slot **simultânea** de prefixo é
  parcial (garantida dentro do mesmo slot; entre slots, depende do provider
  tolerar o `<env>` divergente no meio do prefixo).
- **Arquivos de diagnóstico por task**: `pilot/gate-fail/<ID>.json` (carryover
  de falha do gate) e `pilot/builder-<ID>.log` (output do builder) — sem
  last-writer-wins entre slots.
- **Deploys continuam seriais**: `deployBusy` garante um deploy por vez; merge
  concorrente fica na fila na main e o próximo deploy pega.

## Observabilidade

- **Dashboard 3D em tempo real**: `http://127.0.0.1:8792/dashboard?token=<apiToken>`
  (Canvas 2D sem dependências: nodes do pipeline, partículas de trabalho, bursts de merge, rollback vermelho)
- **Métricas honestas (P2-045)**: o contador **MERGES** vem do `state.json`
  (`merges` diário, zerado à meia-noite junto com os outros orçamentos) — bate
  com `git log --oneline --since=00:00 --grep='pilot.*(#'`, nunca com a janela
  de eventos. **FALHAS** ganhou breakdown por step do gate
  (evidence/typecheck/build/…/invariants/review) calculado sobre os eventos
  `gate-fail` que o `recordGateFail` emite; o botão **FILA** mostra na face
  `n prontos ⛔m bloqueadas` (seções `## Ready`/`## Blocked` do BACKLOG.md).
- **Chip AUDIT MODE**: quando o circuit breaker de febre (P2-032) pausa a fila,
  um chip vermelho no topo do painel mostra o motivo e, no tooltip, o resumo
  do `buildDiagnosis` (api + top steps + top tasks) persistido em
  `state.json` (`auditDiagnosis`) pelo doctor pass.
- **Histórico (condicional ao P2-043)**: existindo
  `~/.opencode-remote/pilot/history.jsonl`, o painel exibe burn-down de 7 dias
  (verde ok / vermelho falha por dia local) e duração média por fase
  (planner/builder/reviewers/gatekeeper, rounds incluídos) via
  `GET /api/pilot-history`; sem o arquivo, o widget fica oculto em vez de
  inventar série.
- **Custo por task (P2-028)**: o runner já captura o `ses_…` de cada spawn —
  o pilot reconcilia esses ids contra o `opencode.db` local
  (`~/.local/share/opencode/opencode.db`, tabela `session`: `tokens_input`,
  `tokens_output`, `tokens_cache_read`, `tokens_cache_write`; os totais batem
  com o JSON `data` da tabela `message`) e acumula em `state.json` como
  `taskCosts: {id: tokens}` + `taskCostSessions: {id: [ses…]}`. O total é
  **recomputado** (não somado) a cada ciclo a partir da lista deduplicada de
  sessões — sessão retomada cresce sem virar dupla contagem; task bloqueada
  preserva o custo das tentativas. Os views **FILA** e **CONCLUÍDAS** mostram
  o chip `x.xM tok` em cada linha (formato k/M/B). Janela rolante de 200 tasks
  em `state.json`; sem DB/`sqlite3`, o total anterior é preservado e o ciclo
  segue. Objetivo: identificar tasks caras e priorizar otimização por dado.
  Sinal **best-effort** (round 3): os ids vêm do stdout dos agentes — um eco
  estranho de `ses_…` pode inflar a linha da própria task (nada de gate
  consome `taskCosts`); a reconciliação abre o DB com `sqlite3 -readonly`,
  sem possibilidade de escrever no WAL/journal do opencode em produção.
- **Cache-aware prompt assembly (P1-077)**: medido no `opencode.db` (janela de
  51h), o pipeline consumiu 1.87B tokens de input com apenas 954k de
  `cache.read` — hit rate de 0.05%. Causa raiz: os templates de prompt abriam
  com conteúdo **variável** (task, round, findings, lessons) antes dos blocos
  estáveis; provider prefix caching (GLM/CulturaBuilder faz context caching
  server-side) só engata com prefixo byte-idêntico. Os quatro templates
  (`builderPrompt`, `plannerPrompt`, `reviewerPrompt`, `scribePrompt`) agora
  montam **primeiro** o prefixo estável — linha de role (sem `round`), regras
  de role, `CONSTITUTION` e contrato de saída (bloco EVIDENCE do builder,
  veredito do reviewer, contrato LESSONS do scribe, seções+marcador do
  planner; placeholders genéricos `<TASK-ID>` no lugar do id interpolado) — e
  a cauda **variável** por último (task id/título/spec, round, specBlock/
  longBlock/attempt/resume, findings, lições IER e failure lessons, bullet de
  screenshots, diff por último para reviewer/scribe). O bloco EVIDENCE tem
  uma variante inevitável (`uiTask` on/off); o prefixo é idêntico dentro de
  cada variante. **Métrica**: `state.json` ganhou `taskCache: {id: {input,
  cacheRead, cacheWrite}}` (dobra na mesma reconciliação REPLACE-by-recompute
  e janela rolante de 200 do `taskCosts`; normalizado pelo doctor) e cada
  task loga `msg:"task cache"` com `{task, input, cacheRead, cacheWrite,
  ratio}` onde `ratio = cacheRead/(cacheRead+input)` (0 quando o denominador
  é 0). Critério pós-merge (janela de 10 ciclos): razão agregada
  `sum(cacheRead)/sum(cacheRead+input) >= 30%` nas tasks novas.
  **Investigação do provider**: no mesmo opencode.db, sessões interativas com
  outros modelos reportam `cache.read > 0` (kimi-k3: 746k, laguna: 208k
  tokens) — ou seja, o opencode repassa a contabilidade de cache do provider;
  já as ~30k mensagens do `glm-5.2` (CulturaBuilder, `@ai-sdk/openai-compatible`)
  têm `cache.read`/`cache.write` = 0 em todas — o gateway só "acerta" o cache
  quando o prefixo de fato coincide, e os prompts antigos tornavam isso
  praticamente impossível. Conclusão: nenhum option extra de modelo é
  necessário no `opencode.jsonc` (arquivo do host, nunca commitado — contém a
  API key); o lever é a ordem de montagem do prompt, implementada nesta task.
- Logs JSONL: `~/.opencode-remote/logs/pilot.log`
- Feed bruto: `GET 127.0.0.1:8792/api/pilot-events` (Bearer apiToken) — eventos + contadores + heartbeat
- Digest a cada pipeline: push no seu telefone (via `POST /api/push` autenticado no daemon)
- Sucessos, falhas, rollbacks e achados do red team aparecem como notificação.
- **Pós-mortem navegável (P2-048)**: o pane Mission Control no app desktop
  (⌘6) renderiza um card por tarefa (objetivo, progresso, esforço, ETA) e a
  timeline forense por tarefa — decisões do builder, vereditos de reviewer,
  falhas de gate com tail, deploys e shots pós-deploy — lido do
  `pilot.log`/`events.jsonl` real via `GET /api/pilot-forensic[(/timeline)?]`;
  `POST /api/pilot-takeover` abre o Terminal anexado à sessão opencode do
  builder para handoff humano.

## Self-healing (3 níveis)

1. **Agent**: retry de npm ci, re-upload de attachments, rounds de review
2. **Pipeline**: rollback automático de deploy (health + soak + invariants live); diff vazio do builder + task já presente no histórico de merge de `origin/main` (grep ancorado no formato de sujeito `^pilot(<id>):`, com ID validado) → `markDone` no BACKLOG.md e ciclo encerrado com sucesso em vez de falhar para sempre na mesma task
3. **Serviço**: singleton via pidfile — ao iniciar, o pilot grava `~/.opencode-remote/pilot/pilot.pid`
   e, se a instância anterior ainda estiver viva, a derruba (SIGTERM → 2s → SIGKILL, log
   `stale pilot instance killed`); o self-reload pós-deploy (P1-034) dispara sempre que o
   HEAD mudou no deploy (`prev !== HEAD` pós-reset, em vez do diff `apps/pilot` contra ele
   mesmo, sempre vazio) — sai com `process.exit(0)` imediato (log já flushado, sem órfão) e
   o KeepAlive reassume no código novo; heartbeat + watchdog — 30min sem sinal → exit → KeepAlive ressozinho
4. **Processo stale (P3-101)**: o loop guarda o HEAD do repo de produção capturado no boot
   (`bootHead`) e, num momento 100% ocioso (nenhum slot rodando, nenhum deploy em voo),
   reexecuta `git rev-parse HEAD`; se driftou (`headDrifted`), sai com `exit(0)` e o
   KeepAlive reassume no código novo — cobrindo o caso que o self-reload pós-deploy não
   alcança: um processo **anterior** ao conserto do reload (o incidente do P1-095 — o
   trigger novo mergeou e deployou, mas o processo de 01/09, com o reload morto em
   memória, nunca reiniciou e a janela ociosa nunca ficou viva). Sem isso, o explorer /
   red team de P3-052 só rodariam "de fato" após restart manual.

## Stop-loss por task (circuit breaker, P1-014)

Toda falha de pipeline de uma task (builder não terminou, diff vazio, reviewers
reprovando até `maxReviewRounds`, gatekeeper vermelho, crash) incrementa
`taskAttempts[id]` em `state.json`. Ao atingir `maxAttemptsPerTask` (pilot.json,
default 4; task size L tem cap próprio de 6, P1-060) o breaker dispara:

1. a linha da task sai de `## Ready` e vai para a seção `## Blocked` do
   BACKLOG.md (landing via PR `pilot/meta`, com resumo do último findings) — o painel FILA do
   dashboard já mostra as duas filas;
2. um **único** `notifySupervisor` "task blocked after N attempts" é enviado;
3. a task não é re-agendada: cooldown infinito até um humano (ou o red team)
   mover de volta para `## Ready` — o contador é zerado quando a task passa no
   gate e também no momento do bloqueio, então a re-entrada começa limpa;
4. **scribe de falha (P2-031)**: quando o bloqueio pousa (landing do
   PR `pilot/meta` armado com sucesso),
   uma lição estruturada `kind:"failure"` é gravada em
   `~/.opencode-remote/pilot/lessons.jsonl` com o step da falha, os findings e
   o tail do gatekeeper/review — ver "Lições de falha" na seção do IER.

O contador **não** é zerado pelo reset diário de `state.json` (virar a noite não
reabre o breaker) e, se o push do bloqueio falhar, o guard do loop re-bloqueia a
task no ciclo seguinte em vez de executá-la de novo.

**Falhas de infraestrutura não queimam attempt (P1-074)**: falhas de infra — API
do opencode fora (preflight), `spawn error:` e timeout do builder sem output
(`[infra] builder timed out without output`) — são classificadas (P1-094) apenas
pelo campo estruturado `infra` que o produtor da falha preenche
(`resultInfraKind`; o texto do `detail` nunca é escaneado, pois findings de
review podem citar palavras de infra sem ser infra) e seguem por outro caminho:
incrementam apenas o contador
diagnóstico `infraFails` em `state.json` (reset diário), **sem** incrementar
`taskAttempts` e **sem** alimentar a janela de febre. A cada 3 ocorrências o
doctor roda um pass de diagnóstico no log (`audit diagnosis`, com `api=…`), sem
entrar em modo auditoria — a fila continua rodando e a task é re-agendada pelo
scheduler no ciclo seguinte.

**Checkpoint de pressão de contexto (P1-079)**: o builder resume a MESMA sessão
opencode entre rounds (cache de contexto), então o total de tokens só cresce. Antes
de cada round o pipeline mede a pressão — tokens da sessão (API do opencode, os
mesmos números de `opencode.db`) contra a janela do modelo (`GET /provider`) — e
registra a amostra em `state.json` (`contextPressure`, últimas 8 por task). Acima
de **85%** o pipeline roda um pass de scribe curto que destila o estado do trabalho
(task id, pendências, próximo passo), grava o recap em
`~/.opencode-remote/pilot/carryover/<ID>.json`, mata a sessão LIMPO e abre sessão
fresca na próxima round com o recap no prompt (`CONTEXT RECAP` block). Pressão de
contexto estourada é infra, não mérito: **nenhum attempt é queimado**. Se o pass
de recap falha, a sessão segue como antes (fail-open); o carryover é consumido na
primeira round que o usar e removido no merge. O mesmo cálculo alimenta o gauge de
contexto do chat (apps/web via `GET /__ocr/context` do daemon, amarelo ~70%,
vermelho ~85%) e o recap fixado sob o composer — ver README.

## Circuit breaker de febre — modo auditoria (P2-032)

O stop-loss acima é **por task**; o breaker de febre é **global**: pausa o
scheduler inteiro quando o pipeline em si está doente. Dois gatilhos
independentes, alimentados por estado em `state.json` (`cycles`,
`blockEvents`, `auditMode` — sobrevivem ao rollover de meia-noite):

1. **Taxa de febre**: janela deslizante dos últimos **10 ciclos** de pipeline;
   **>= 3 tasks DISTINTAS** falhando dispara (P2-063: as falhas são agregadas por
   `task.id` — uma task teimosa sozinha, esgotando o próprio
   `maxAttemptsPerTask`, nunca pausa a fila global; ela segue o circuito
   normal por task). Falhas sem task atribuída (crashes de pipeline, amostras
   legacy) contam cada uma como distinta — sinal sistêmico conservador.
2. **Rajada de bloqueios**: **2 tasks** indo para `## Blocked` em **30min**
   (contagem nos landings reais do bloqueio via PR `pilot/meta`).

Ao disparar, o pilot entra em **modo auditoria**:

- **não pega tasks novas** do `## Ready` (slots em execução terminam; suas
  falhas contam para o relógio de retomada);
- roda o **pass de doctor**: sonda de saúde da API do opencode (mesmo check do
  `cli.mjs doctor`) + agregação determinística de **top steps de falha**
  (lições de falha P2-031 + arquivos `gate-fail/<ID>.json`, sem dupla contagem)
  e **top tasks rejeitadas** (lições + `taskAttempts` vivos), postada no log
  JSONL (`audit mode entered` / `audit diagnosis`) e no feed de eventos
  (tipo `audit`), com `notifySupervisor`;
- **retomar** por intervenção externa (`touch
  ~/.opencode-remote/pilot/audit-clear` — a flag é consumida no ciclo seguinte,
  no espírito do `pilot.lock`) ou automaticamente após **2h sem falha nova**
  (qualquer falha enquanto pausado empurra o prazo). Nas duas retomadas as
  janelas são zeradas — febre nova precisa re-acumular.

Cobertura: `scripts/unit.test.ts` injeta falhas nos dois gatilhos (janela
deslizante, rajada com pruning, fronteira de 2h, agregação do diagnóstico e
persistência no `state.json`).

## Doctor de reparo determinístico (P1-030)

Reparos que antes eram feitos à mão (refs stale no clone, `state.json` corrompido,
BACKLOG.md malformado, branches órfãs `pilot/*`) viraram subcomandos idempotentes
e logados em `apps/pilot/src/doctor.ts`:

- **`refs`** — fetch + `reset --hard origin/main` + clean do clone de trabalho
  (mesma sequência do `syncWorkspace` do scheduler); loga `changed` só quando o
  HEAD realmente se moveu;
- **`attempts`** — contador do circuit breaker (P1-014): sem flag apenas
  **reporta** (nunca altera nada); `--clear <id>` zera o contador de um id;
  `--clear` sem id é **erro** (exit 1) — o modo report nunca limpa contadores,
  muito menos todos de uma vez;
- **`backlog`** — valida seções (`## Ready`/`## Done` obrigatórias, `## Blocked`
  opcional) + ids de task únicos em todas as seções, via `loadBacklog`; somente
  leitura — backlog inválido é reportado (log warn + exit 1), nunca auto-editado;
- **`branches`** — deleta branches locais `pilot/*` **sem PR aberto**; fail-safe:
  só deleta com `gh` respondendo (PR aberto, gh indisponível, branch checked-out
  ou de task com tentativa viva no breaker — preservada para retry, P1-060 —
  são pulados);
- **`state`** — normaliza `state.json` pro schema atual + defaults (campos
  legados, tipos lixo e arquivo corrompido viram defaults; writeJsonAtomic);
  segunda passada seguida loga `changed: false`.

O boot do pilot roda o pass completo (refs/state/backlog/branches em cada slot,
log `doctor: <cmd>` no JSONL) — falha do doctor nunca impede o pipeline de subir.
Uso manual:

```sh
npx tsx apps/pilot/src/doctor.ts all                # pass completo
npx tsx apps/pilot/src/doctor.ts refs               # só refs
npx tsx apps/pilot/src/doctor.ts attempts --clear P1-030
npx tsx apps/pilot/src/doctor.ts backlog            # exit 1 se inválido
npx tsx apps/pilot/src/doctor.ts branches
npx tsx apps/pilot/src/doctor.ts state
```

Cobertura: um bloco por subcomando em `scripts/unit.test.ts` (sequência exata de
comandos do refs, idempotência, fail-safe do branches, refnames fora do padrão
`pilot/<ID>` pulados antes de tocar shell, deleção que falha → `ok: false`,
reparo de state corrompido e tabela de dispatch do CLI `attempts` contra
state.json descartável).

## Rodar manualmente

```sh
npm run once --workspace @ocr/pilot        # um ciclo (eval)
npm run start --workspace @ocr/pilot       # loop contínuo em foreground
./deploy/install-pilot.sh                  # instalar como serviço launchd
```

Atenção: vale o singleton do pidfile — subir uma segunda instância (foreground,
`once` ou serviço) mata a instância anterior viva.

## Regras do BACKLOG.md

Formato das tasks (seção `## Ready`):

```md
- [ ] (P2-001) Título curto — spec: o que fazer, onde, e critério de aceite (area: daemon)
```

O tag `(area: ui|daemon|desktop|infra|relay)` no fim da linha (P1-006) define em
qual área a task roda no scheduler paralelo; task sem tag roda serial.

O pilot pega a primeira task `Ready`, em ordem. Red team insere `(RT-###)` P0 no topo.


## Spec-before-build (P2-008)

Tasks de prioridade **P0/P1** ganham uma fase **PLANNER** antes do builder: um
agent **read-only** lê o código no clone e escreve `specs/<ID>.md` na branch da
task, com seções obrigatórias `## Problem`, `## Approach`, `## Touched files`,
`## Edge cases`, `## Acceptance criteria` e `## Out of scope`. O runner valida
deterministicamente as seções e commita o arquivo na branch (o agent nunca
commita); se o spec válido não existir após 2 tentativas, o pipeline falha — o
circuit breaker (P1-014) cuida do retry. Tasks **P2+ seguem direto pro builder**,
sem spec.

- O `builderPrompt` referência o spec: "read it FIRST ... do not delete or
  rewrite the spec" — desvios precisam ser justificados no commit.
- **Planner enxerga as lições (P2-042)**: o `plannerPrompt` injeta o mesmo
  contexto de experiência do builder/strategist — top-5 lições do IER
  (`pickRelevantLessons`, keyword-match contra título+spec da task) e as 10
  failure lessons mais recentes (`~/.opencode-remote/pilot/lessons.jsonl`).
  Assim o spec de P0/P1 já nasce ciente dos padrões que bloquearam tasks
  anteriores; sem nenhum match, o prompt fica limpo (blocos vazios).
- O reviewer de **quality** ganha o critério explícito "does the diff fulfill
  `specs/<ID>.md`?" — desvio de abordagem/arquivos/critérios de aceite é finding.
- **Exclusividade determinística**: "commita ONLY o spec" é enforced pelo runner,
  não pelo prompt — `commitSpec` rebobina a branch para `origin/main` e replaya
  exatamente 1 commit tocando `specs/<ID>.md`; qualquer outro arquivo que o
  planner (read-only) tenha criado ou modificado é eliminado antes do builder
  rodar, e o diff da branch é verificado contra `specs/<ID>.md` no final.
  Cobertura real: `scripts/unit.test.ts` roda `commitSpec` contra um repo git
  temporário com um planner que commita lixo.
- **Diff vazio ignora o spec**: o check de empty-diff/self-heal usa
  `codeChanges` — o diff name-only da branch menos `specs/<ID>.md` — então um
  diff só-de-spec ainda dispara o self-heal de task já mergeada em P0/P1.
- **Spec é dado, não instrução**: `validateSpec` rejeita spec > 400 linhas /
  40k chars e qualquer corpo contendo markers de controle do pipeline
  (`VERDICT:`, `PILOT:TASK-DONE`, `PLANNER:DONE`, `SCRIBE:DONE`).
- O dashboard (`apps/pilot/dashboard`) conhece as fases `planner`/`planner-done`:
  só o node backlog acende e o builder aparece como "working" durante o spec.
- Se a task já está mergeada em `origin/main`, o planner é pulado (senão o
  commit do spec sozinho mascararia o self-heal de diff vazio).

## Evidência obrigatória no builder (P2-009)

Builder de mentira é o pior modo de falha do pipeline: reviewers gastariam tokens
confiando em "typecheck verde" que nunca rodou. Agora o builder **tem que provar**
o que fez e o gate **re-executa** a prova:

- **Prompt**: o `builderPrompt` exige um bloco final `EVIDENCE:` com os outputs
  reais colados de `npm run typecheck --silent` e `npm run test:unit --silent`
  (`$ <comando>` + output colado), e — para tasks de UI — os paths de dois
  screenshots reais: `shot-1440x900:` (desktop) e `shot-390:` (phone), produzidos
  com o browse CLI em sintaxe posicional `tools/browse.mjs shot <path>.png 1440 900`
  e `tools/browse.mjs shot <path>.png 390 844` (as dimensões são verificadas no
  header do PNG: 1440x900 exato — 2x Retina aceito — e largura 390/780; capture
  de janela inteira via `screencapture` não tem dimensão garantida e normalmente
  reprova). As linhas `shot-*:` aparecem no template de todo builder — para task
  sem tag de UI, como bloco condicional ("if this round's diff touches
  apps/web/ or apps/desktop/, also cite").
  Um único predicado (`needsUiEvidence`) comanda **prompt e gate**: task taggada
  `ui`/`desktop` recebe o bloco de shots explicitamente, e todo builder é avisado
  de que diff que toque `apps/web/`/`apps/desktop/` exige os dois shots mesmo
  sem tag de UI — impossível cair num round perdido por desalinhamento
  prompt/gate.
- **Gatekeeper determinístico**: novo primeiro step do gate (`evidence`) que
  parseia o bloco do output do builder e (1) reprova bloco ausente, (2) reprova
  comando fora da allowlist — só `npm run {typecheck,test:unit,build} --silent`
  podem ser citados, o que também fecha injeção de shell via output de LLM —
  (3) reprova comando obrigatório faltando, (4) reprova screenshot inexistente,
  com dimensões erradas (aceita 1x e 2x Retina: 1440x900/2880x1800 e largura
  390/780 — o tamanho é lido direto do header PNG) ou **velho** (mtime anterior
  ao início do pipeline — PNG de task/round anterior não serve de evidência) e
  (5) **re-executa** cada comando citado no workspace: toda linha colada tem que
  existir no output real (semântica de contenção, normalizada contra
  ANSI/whitespace) — output fabricado diverge e reprova. Linhas de output real
  que começam com `$ ` sem ser comandos allowlisted são descartadas no parse
  (nunca executadas, nunca poluem a contenção) — transcript colado com `$
  npm run ...` a mais não rejeita bloco honesto.
- **Sem execução dupla**: os resultados das re-execuções da evidência são
  reusados como os steps `typecheck`/`build`/`unit` do próprio gate (os comandos
  canônicos são idênticos), então o gate não roda os mesmos comandos duas vezes
  segurando o lock de exclusão mútua entre slots (P1-006). P2-040: o mapa de
  re-runs é **por round e compartilhado com o preflight** — o `cachedExec`
  (key `comando+workspace`) faz o preflight pós-builder executar o typecheck
  uma única vez e o gate (evidence + steps) ler o mesmo resultado; o typecheck
  roda 1x por round no código da pipeline, não 3x. Round novo = mapa novo (o
  builder pode ter mudado o código).
- **Self-heal**: falha de evidência escreve o carryover padrão
  `pilot/gate-fail/<ID>.json` (step `evidence`), então a próxima rodada do
  builder recebe o detalhe exato (ex.: "stale screenshot (predates this round)")
  e corrige sem redescobrir o problema.
- **Barato por design**: os checks estáticos rodam antes de qualquer re-execução;
  blocos patológicos (>600 linhas) são rejeitados no parse — folga calculada
  contra a bateria de unit (~300 linhas hoje). Colar vazio só é honesto quando o
  re-run não imprime nada (ex.: tsc silencioso no sucesso); citar comando
  verboso sem colar output reprova com "no output pasted". Cobertura:
  `scripts/unit.test.ts` testa parse, contenção, allowlist, dimensões PNG,
  freshness por mtime, o predicado compartilhado prompt/gate e o caminho
  fim-a-fim com re-execução real (scripts `echo` num workspace temp).

## Corpus dourado para os gates (P3-033)

Gates determinísticos têm falso-positivo que só aparece contra variação real de
output — o P1-030 foi rejeitado porque duas rodadas verdes do mesmo comando
imprimem timestamps/pids/tempdirs diferentes. Para não depender de strings
sintéticas, a bateria de eval testa o evidence matcher contra um **corpus de
outputs reais** dos três comandos de evidência:

- **Fixtures**: `apps/pilot/src/__fixtures__/gate-corpus/<slug>/<seq>-<sha>.txt`
  (slug = comando com não-alfanuméricos virando `-`; sha = commit-ish da
  captura). Cada amostra é output real de uma rodada verde, sanitizado por
  `sanitizeForCorpus` (usernames de paths, hex longo). Hoje: 3 amostras de
  typecheck (vazio no sucesso — também é variação real), 5 de unit, 3 de build.
- **Bateria**: `scripts/unit.test.ts` carrega o corpus (`loadGateCorpus`) e
  exige, para cada amostra: `evidenceMatches(s, s)` verdadeiro (e idempotência
  de `normalizeEvidenceLine`), paste truncado continua passando, ruído
  ANSI/espaço/linha-em-branco continua passando, linha fabricada continua
  reprovando, e **cross-pairs** — paste da amostra A contra re-run da amostra B
  — passam nas duas direções quando A e B são do mesmo commit (commits
  diferentes divergem legitimamente, ex. contagem de testes). Cobertura mínima:
  >= 3 amostras por comando. Regressão de falso-positivo (ex. tirar o mask de
  timestamps ISO-8601, que o P1-030 sofreu) quebra a bateria antes de quebrar
  merges honestos.
- **Crescimento automático**: a cada `corpusEveryNMerges` merges bem-sucedidos
  (config pilot.json, default 5; contador `mergesSinceCorpus` em state.json), o
  gatekeeper grava as próprias saídas re-executadas (sem rodar
  npm de novo) via `captureGateCorpus` e pousa `pilot(corpus): N gate
  sample(s) from <ID>` via **PR `pilot/meta`** (P1-076) — mesmo fluxo de retry
  do scribe, com guard por prefixo do diretório do corpus, teto de 3 arquivos
  por capture e formato exato de filename de amostra (`<seq>-<label>.txt`;
  qualquer coisa fora desse formato recusa o push). Amostra
  idêntica à última é descartada (typecheck vazio não acumula arquivo).
- **Correção que o corpus exigiu**: `normalizeEvidenceLine` agora mascara
  timestamps ISO-8601 (com data/milis/offset), contadores de processo
  (`"pid"`, `"uptimeS"`, `"activeConnections"`) e sufixos aleatórios de
  `mkdtemp` (`-HASH/`) — tokens que variam entre duas rodadas verdes, sem
  enfraquecer a detecção de fabricação (a linha fabricada continua sem fonte no
  re-run).

## Round efficiency + async deploy (31/08, v1.1)

- **Preflight typecheck**: after each builder round, a fast `tsc --noEmit` runs
  before the reviewers — broken code bounces straight back to the builder with
  the error tail instead of burning reviewer tokens. P2-040: the preflight
  populates the round's shared re-run cache (`cachedExec`, key =
  command+workspace), so the gatekeeper's evidence re-run and step battery
  reuse that result — one typecheck execution per round across the whole
  pipeline.
- **API preflight (P2-016)**: before every agent spawn (`runAgent`), the runner
  probes the opencode server (`GET $OPENCODE_URL/global/health`, 5s timeout —
  same endpoint/contract as the CLI doctor). If the API is down — typically
  during deploy churn, when `opencode serve` restarts — it waits 15s and
  retries up to 3× (~45s) BEFORE the run counts as an attempt or failure; the
  wait is logged as a warning and the circuit breaker is untouched. Only an
  outage that outlasts the whole window fails the run (through the normal
  failure path). Pinned by unit tests in `scripts/unit.test.ts`.
- **Gate-fail carryover**: the gatekeeper writes `pilot/gate-fail/<ID>.json`
  (per-task since P1-006); the
  retry pipeline seeds the builder prompt with the exact failing step + output.
- **Incremental rounds**: builder prompt for round ≥ 2 instructs inspecting the
  existing branch diff and fixing findings incrementally.
- **Async deploy**: deploys run fire-and-forget (prod repo vs workspace clone
  are independent); the next task starts immediately. `deployBusy` prevents
  concurrent deploys; pending-deploy self-heal covers a crashed deploy.

## Deterministic gate before reviewers + retry-once (P1-101)

The gate order changed: **the deterministic gate runs BEFORE the LLM
reviewers**, right after the preflight typecheck (which shares the same re-run
cache). Consequences:

- **Gate-fail as a finding, not an attempt killer**: a red gate (evidence,
  build, unit, invariants, corpus…) no longer burns reviewer tokens and kills
  the attempt (the P2-099 failure mode). Instead the failing step + output tail
  come back as a `[deterministic gate failed at step …]` block in the builder's
  findings for the SAME attempt; the pipeline only turns terminal on the last
  review round. The `pilot/gate-fail/<ID>.json` carryover is still written (so
  the next attempt seeds it), and `state.failures` only grows on the terminal
  path.
- **Retry-once per step (`gate-flaky`)**: every battery step gets exactly one
  automatic re-run when it fails. A fail→pass pair is classified deterministically
  (no LLM) as flaky and reported as a `gate-flaky` phase event + JSON log line
  with the step name; two reds still reject. The evidence re-run retries once
  ONLY when a cited command itself failed — a pasted-output divergence never
  retries (the P2-009 anti-fabrication gate stays intact).
- **stderr captured**: `exec()` now runs via `spawnSync` and concatenates
  stdout + stderr on success and failure. Vite/tsc warnings used to vanish
  into the pilot terminal, making honest evidence pastes of `npm run build
  --silent` diverge from the re-run.
- **Tamper check**: reviewers approve the exact HEAD the gate certified —
  between the green gate and the merge, HEAD must be unchanged and the tracked
  worktree clean (`git status --porcelain --untracked-files=no`; the pipeline's
  own untracked sandbox config doesn't count). Any drift fails closed.
- **Metrics pairing**: `gatekeeper-done` (not `merge`) closes the gatekeeper
  phase in `avgPhaseDurations`; `gate-flaky`/`gate-fail` events never open a
  phase.

## Verifiable findings (P2-015)

Reviewers are LLMs and hallucinate. Finding bullets are parsed ONLY from a
`VERDICT: REQUEST_CHANGES` tail (P1-102: bullets after a `VERDICT: APPROVE`
are rationale, not findings — 830 of the 1189 findings dropped in the audit
came from APPROVE outputs), and every finding bullet must carry verifiable
evidence:

- a quoted literal snippet (≥6 chars) that appears verbatim in the reviewed
  diff — checked FIRST (P1-102), so a real finding is never dropped because its
  path:line resolution failed (audit fixtures: shell injection via `t.id`, the
  unused `qrcode` devDep). Quoted paths don't count as snippets: every
  unified-diff header repeats the touched file's path, so path-shaped spans are
  excluded from the verbatim check and stay the business of `FILE_CITE_RE`; or
- a repo-relative `path/file.ext:LINE` citation — the file must exist in the
  workspace clone and, when a line is cited, that line must be non-empty.

A cheap mechanical verifier (`verifyFindings` in `apps/pilot/src/pipeline.ts`)
drops findings whose citations don't resolve and logs each one as
`finding hallucinated, dropped` (level `warn`) **with the mechanical reason**
(file not found, line empty/beyond EOF, no quoted span resolves — P1-102).
If **all** findings of a `REQUEST_CHANGES` verdict are dropped the verdict
still rejects fail-closed (P1-073: escalate or reject — never an effective
approve). Dropped findings are not erased either: a rejecting reviewer's
(or tier-B arbiter's) dropped list is repassed to the builder tagged
`[unverified]` (P1-102); the reviewer prompt documents the citation contract.
Pinned by unit tests in `scripts/unit.test.ts` (one valid citation with a real
path, one hallucinated path — only the invalid one is dropped).

Since P2-038 the verifier treats code observations as first-class evidence:

- **Last marker wins**: the verdict is the LAST `VERDICT:` marker in the
  reviewer output (`parseVerdict`), not a substring test — a
  `VERDICT: REQUEST_CHANGES` written after an APPROVE in prose rejects the
  build. P1-102: finding bullets are parsed only under a REQUEST_CHANGES
  verdict — an APPROVE's rationale bullets are never treated as findings
  (`reviewerOk` still rejects an APPROVE when findings are passed to it
  explicitly).
- **Bare-name citations resolve**: a citation like `CommandPalette.tsx:63`
  without a directory is resolved by suffix match against the workspace
  listing instead of being dropped. (The same audit fixed a regex truncation
  that read `.tsx` as `.ts` — the cause of 7 valid P1-046 findings being
  dropped as hallucinated.)
- **Symbol check (code-observation findings)**: a finding that cites
  `file:line` and quotes a symbol (`[request]`, `verifyToken`, …) is verified
  deterministically — the cited file:line must exist and the quoted symbols
  must appear in the **union** of all cited files' contents plus the reviewed
  diff (P1-065: no longer per-citation, so a cross-file finding whose symbols
  are spread across its own citations is valid). Two tiers: when the full
  symbol set does not resolve, the finding is still kept if at least one
  quoted span of ≥6 chars matches the union. A finding is marked hallucinated
  only when a cited file or line does not exist, or when no quoted span of
  ≥6 chars matches the union.

## Cheap resumption (P2-013)

Since opencode ≥1.18.20, failed subagent tool calls surface a **resumable
`task_id`** instead of vanishing. The pipeline exploits that for cheap
resumption of a failed builder round:

- **Capture** (`apps/pilot/src/runner.ts`): `runAgent` scans stdout for both
  `ses_[A-Za-z0-9]+` (session) and `task_` ids (resumable subagent tasks) and
  returns them in `RunResult` (`sessionId`, `taskIds[]`). Task capture requires
  a non-word left boundary and a ≥8-char id suffix (`MIN_TASK_ID_SUFFIX`), so
  prose echoing through stdout — "the task_id is resumable", "mytask_abc" — is
  never mistaken for resumable work. stdout and
  stderr each get their own streaming scanner (`idScanner` — dedupe in arrival
  order, 128-char tail buffer so an id split across two chunks is captured
  whole, edge matches committed by `flush()` at exit) merged by
  `mergeAgentIds`, so arbitrarily interleaved streams can never fabricate an
  id that never appeared contiguously.
- **Feed-back** (`apps/pilot/src/pipeline.ts`): only a round that actually
  failed (no `PILOT:TASK-DONE`) leaves resumable state
  (`updateResumeState` — a successful round RESETS it, so review-fix rounds
  never see a false crash claim). While the state is live, the next builder
  prompt carries a `RESUME PARTIAL WORK (P2-013)` block — previous builder
  session id + resumable task ids (capped at `RESUME_MAX_TASK_IDS`) — with the
  instruction to inspect and CONTINUE the partial work instead of restarting
  from scratch.
- **Failed rounds now retry**: a builder round that dies without
  `PILOT:TASK-DONE` (crash/timeout) continues to the next round within the
  existing `maxReviewRounds` budget instead of aborting the pipeline, so the
  resume ids actually reach a round N+1 (pure `crashRoundDecision`; the
  failure notice rides in the resume block, keeping the findings section
  reviewer-only). The final round still fails as before and counts through
  the normal circuit-breaker path (P1-014). **Cost bound**: worst case for a
  task whose builder hangs every round is now `maxReviewRounds ×
  taskTimeoutMin` of builder time per pipeline run (default 3 × 45 min) —
  bounded by the loop and by the breaker counting the run as one failure.
- **Prompt-only**: ids flow exclusively into the builder prompt text — never
  into a shell command — so captured output cannot become injection. A
  round with no captured ids renders no block (round 1 unchanged).

Pinned by unit tests in `scripts/unit.test.ts`: canned output extracts `ses_`
and `task_` correctly, prose tokens (`task_id`, `task_ids`, glued words) are
rejected, split-across-chunks ids are recovered, duplicates
collapse, the round N+1 prompt contains the captured ids with the evidence
block intact, `updateResumeState` resets on success (and only then keeps
state, first-N capped), and `crashRoundDecision` retries on non-final rounds /
aborts on the last one.

## Experience memory (IER, P1-007)

O pipeline mantém uma **memória de experiência** versionada em `docs/EXPERIENCE.md`:
lições de engenharia de uma linha, no formato `- When <situação>, do <ação> (fonte: <ID>)`,
seção `## Lessons`. Três peças:

1. **SCRIBE (pós-merge)**: logo depois que o gatekeeper mergea, um agent lê o diff
   da task + os findings de review (já endereçados) e **saída** de 1-3 lições no
   formato acima — o agent nunca edita o arquivo direto: o runner valida o formato,
   deduplica contra o que já existe, appenda (máx. 3 por merge) e pousa o commit
   `pilot(scribe): N lesson(s) from <ID>` via **PR `pilot/meta`** (P1-076), com
   retry do landing inteiro para lidar com scribes concorrentes de slots paralelos.
   Falha do scribe nunca falha o pipeline
   (o merge já aconteceu); é log + evento `scribe-done`.
2. **Injeção nos prompts**: `builderPrompt` e o prompt do strategist recebem o
   **top-5 de lições relevantes** — keyword-match (tokenizado, stopword-filtered)
   do título (peso 2) + spec (peso 1) da task contra o texto da lição, empate
   resolvido pela mais recente primeiro. Task sem overlap de keywords não recebe
   lição nenhuma (nada é injetado à força).
3. **Manutenção noturna (red team)**: no pass noturno (primeira janela >= 2h
   ocioso do dia), além da caça a
   buracos de segurança, o pilot **deduplica e poda** `docs/EXPERIENCE.md`
   quando ele passa de **60 lições** — dedupe por chave normalizada (case/
   pontuação/provenance-insensitive, vence a ocorrência mais recente) **e, desde
   P1-075, dedupe semântico** (Jaccard >= 0.6 sobre os tokens da lição, só para
   pares com >= 5 tokens) — e poda para as 60 mais recentes, com commit+push
   `pilot(redteam): experience maintenance`. A manutenção roda **antes** do
   agent de redteam, sob guard própria (`expMaintLast`): falha/crash do agent
   não perde mais o dia. Na poda, lições de **harness** (vocabulário do
   pipeline: pilot/pipeline/builder/reviewer/scribe/gate/backlog/planner/slot…)
   cujo `(fonte: ID)` já está em `## Done` são **arquivadas** — viram uma linha
   `step:"archived"` em `~/.opencode-remote/pilot/lessons.jsonl` (fora de todo
   worktree) em vez de serem apagadas; lições de código de produto têm
   prioridade e nunca são arquivadas (acima do cap, cai primeiro a harness, e
   dentro da classe a mais antiga).

A memória cresce a cada merge (critério de aceite) e os prompts provam a injeção
nos testes de `scripts/unit.test.ts` (parse, match, append-dedupe, cap e block do
builder).

### Lições de falha (P2-031)

O IER acima só cobre merges bem-sucedidos; o caminho oposto — task **bloqueada**
pelo stop-loss — também gera memória. Quando o bloqueio pousa (landing via
PR `pilot/meta` armado com sucesso), o pilot grava uma linha JSONL em
`~/.opencode-remote/pilot/lessons.jsonl` com `kind:"failure"` e os campos
`task`, `attempts`, `step` (o step real da última falha: um step do gatekeeper,
`review` quando a task queima as rodadas de review — caminho que também grava o
arquivo de falha, com os findings verificados dos reviewers — ou `pipeline`),
`findings` (último motivo da falha, cap 500 chars) e `tail` (tail do output do
gatekeeper/review, cap 1200 chars, vazio quando indisponível). A gravação só
acontece quando o landing do bloqueio via `pilot/meta` arma o PR com sucesso,
então ciclos de retry não
duplicam entradas, e `findings` nunca repete o conteúdo de `tail` no caminho de
re-bloqueio (que resume pelo step). O prompt do **strategist** recebe as **10
lições de falha mais recentes** num bloco `FAILURE LESSONS` na hora de
criar/refinar tasks, para não re-propor padrões que já queimaram o orçamento de
tentativas. P1-075: lições de experiência **arquivadas** pela manutenção
noturna (`step: "archived"`) também pousam nesse jsonl, mas prefill no máximo
**3 dos 10 slots** do bloco — falhas reais de task bloqueada mantêm o resto.
O pipeline também instrumenta o efeito da injeção de lições: cada resultado de
pipeline é dobrado em `state.lessonImpact` (coortes *with/without lessons*:
merges, rounds totais e tokens totais) e logado como `lesson impact`.

## RESEARCHER role (daily frontier scan)

Once per day, before picking tasks, the pilot wakes a RESEARCHER agent with webfetch.
It scans Electron releases, opencode releases, competing desktop-agent product pages
and HN front page, compares against docs/VISION.md, and proposes 1-2 `[spike]` tasks
(citing the source URL in the spec). P1-057: the researcher has **no shell and no write
access** — it prints the proposed BACKLOG.md lines between `AUX-TASKS:` / `AUX-TASKS-EOF`
markers; the runner validates each line (`parseAuxTaskLines`: backlog format, id, known
area, no shell metacharacters), appends the valid ones to `## Ready`, commits and pushes
only when the branch diff is exactly `BACKLOG.md` (push guard). The summary is pushed to
the supervisor session for review. Spike budget rule: at least 1 in 4 tasks may be an
experiment — cheap failures are signal.

## Aux agents sem shell (P1-057)

researcher, strategist, redteam e scribe ingerem conteúdo não confiável (webfetch,
diffs) e por isso rodam com sandbox restrito (`writeAuxSandboxConfig`):
`bash: deny`, `edit: deny`, `external_directory: deny` — apenas `webfetch: allow`.
Uma página injetando `curl exfil` no conteúdo pesquisado vira, no pior caso, texto
rejeitado pelo parser — nunca um comando no host. Toda escrita em repo é feita pelo
**runner** (código determinístico): `appendReadyLines` + commit + guard de push
(`mayPush`) que só aceita diff cujo `git diff --name-only origin/main...HEAD` seja
exatamente `BACKLOG.md` (tarefas) ou `docs/EXPERIENCE.md` (lições); qualquer outro
conteúdo loga `aux push refused` e não empurra. Retry de push (3x com fetch/reset)
reavalia o guard a cada tentativa; desde P1-076 o landing inteiro vai pela branch
`pilot/meta` + PR (nunca direto em `main`). O `npm ci` do deploy roda com `--ignore-scripts`
(lifecycle scripts de dependências são vetor de supply chain; o deploy só precisa de
tsc/esbuild — rollback existente cobre falha de build num lock novo).

**Refill durável (P1-037)**: se o push do refill do strategist falha nas 3 tentativas,
as linhas draftadas são gravadas atomicamente em
`~/.opencode-remote/pilot/pending-refill.json` — fora de qualquer worktree, imune ao
`reset --hard` + `clean` do `syncWorkspace`. No próximo ciclo ocioso o dispatcher relê o
arquivo, descarta ids já presentes em `origin/main:BACKLOG.md` (nunca empurra
duplicado) e tenta relanding com o mesmo `appendCommitAndPush` (mesmo guard `mayPush`):
`pushed`/`empty`/`refused` limpam o arquivo; `failed` o mantém e re-tenta no ciclo
seguinte — a fila nunca mais seca porque um push lento comeu o refill.

## Dashboard sem token no HTML (P1-057)

`GET /dashboard` nunca mais embute o apiToken no HTML (`__APITOKEN__` vira `""`). O
browser prova quem é pelo token box / `?token=` (salvos em localStorage) ou trocando
o Bearer por um cookie de sessão: `POST /api/session` (Bearer obrigatório) devolve
`ocr_session` HttpOnly/SameSite=Strict com TTL de 12h, válido em todos os gates
`/api/*`, `/api/browse` e `/__ocr/*` via helper `authorized()`. Sessões vivem só em
memória: reiniciar o daemon pede novo login (o cliente refaz o Bearer). A rota de
criação de sessão opencode (`POST /api/session` com proxy) foi substituída por este
endpoint de autenticação.

## Explorer noturno: computer-use agentic async (P3-052)

Junto do pass noturno do red team (primeira janela >= 2h ocioso do dia —
P1-095), o pilot acorda um agente
com **visão** para explorar o app desktop **de verdade** — via harness hermético
do P1-051 (`tools/desktop.mjs`, sem daemon de produção). É a camada exploratória
que complementa os reviewers adversariais: em vez de olhar diffs, olha o
**produto**. Desde o P1-071 a pass é **fresh-state**: cada run usa a sessão
única `explorer-fresh-<AAAAMMDD>` (`explorerSessionName`), que nunca foi usada
antes — o keeper do harness nasce novo e o `hermeticEnv()` cria um userData
virgem, simulando uma primeira instalação real. O prompt manda abrir o app já
tirando o shot `first-boot-<data>.png` 1440x900 (tela intacta, pré-interação) e
responder as **perguntas de premissa** do produto: por que um app local mostraria
cerimonia de auth/pareamento? Todo fluxo é alcançável a partir do first boot?
Como ficam os empty states? Um segundo boot (best-effort, mesma sessão) com
`OCR_DAEMON_FORCE_RECONNECTING=1` (knob P1-053, sem mudança no harness) cobre o
estado "daemon detectado, primeiro contato".

- **O que explora**: a jornada de first boot com state limpo — premissa do produto
  (cerimonia de auth num app local, alcançabilidade de fluxos, empty states),
  onboarding/pairing (incl. código inválido e campos vazios), segundo boot com
  daemon "detectado", fluxos completos entre panes, states de erro deliberados,
  dead ends de navegação. Achados de jornada exigem o shot do first boot citado.
- **Budget de custo previsível**: no máx. **24 comandos de harness** por run
  (enforced no prompt), timeout de agente de **25min** e cap de **5 findings**
  inseridos por run (`EXPLORER_MAX_*` em `apps/pilot/src/explorer.ts`).
- **Findings viram backlog**: o parser determinístico (`parseExplorerFindings`)
  só aceita achados com `title`, `severity` (high|medium|low) e **shot que
  existe em disco**; unknown area degrada para fila serial; títulos duplicados
  são dedupados. Cada achado vira linha `- [ ] (P3-0XX) [P3] [explorer][sev]
  Título — spec: ... (severity: ..., evidence: /abs/shot.png) (area: ...)` no
  `## Ready`, commitada com `pilot(explorer): N finding(s) from nightly run`
  e push com retry.
- **Nunca bloqueia**: qualquer falha (sync, agente, push) é log-only — o
  explorer não participa do circuit breaker nem reprova merge. Guard diário
  próprio em `state.json` (`explorerLast`), independente do `redteamLast`
  (`claimExplorerRun` persiste o claim ANTES do spawn — crash no meio da run
  não re-executa no mesmo dia).
- **Driver de prova (`scripts/explorer-proof.ts`)**: roda o fluxo REAL do
  explorer em sandbox hermético (bare origin + clone scratch jogáveis, save
  injetado como spy) e imprime uma linha `PROOF` por assertion — eventos
  `task:explorer` no events.jsonl, shots do dia em `shots/explorer/` e o
  commit `pilot(explorer):` resolvido por SHA no origin jogável. Prova o
  mecanismo de ponta a ponta sem tocar `state.json` de produção nem GitHub.
- **Watchdog**: a pass bloqueia o loop por ~25min; desde o P1-035 o `runAgent`
  alimenta o self-watchdog num timer interno (60s) durante qualquer await de
  aux agent — o toque extra no callback de stdout do explorer é redundante,
  mantido por defesa em profundidade.

Barra de aceitação: a primeira run noturna deve gerar >=3 findings reais no
backlog, cada um com shot anexado.

## Browser self-driving + review screenshots (P2-011)

The daemon exposes `/api/browse` (Playwright chromium on the host) and the desktop
app has a **Browser pane** that shows live screenshots of the host browser. The
pipeline uses both to close the loop on UI changes:

- **Builder** (tasks tagged `area: ui` or `area: desktop`): instructed to validate
  its own output visually — `node tools/browse.mjs open <url> shot.png` — saving
  under `pilot/shots/builder/` and referencing the PNG in the final output.
  Builder shots are pre-merge self-checks and are structurally excluded from
  review evidence (separate subdir + deploy-shot shape filter).
- **Post-deploy**: when a merged task touched `apps/web/` or `apps/desktop/`
  (detected from `git diff --name-only` — unit-tested), the deploy captures a
  screenshot of the production dashboard into
  `~/.opencode-remote/pilot/shots/<task>-<sha7>-<ts>.png` and emits a `ui-shot`
  event (visible on the dashboard feed). It uses a dedicated `pilot-shot`
  browse session so it never clobbers a session in use. Retention: the 20
  newest shots are kept.
- **Reviewer**: the evidence function serves only the newest deploy-shaped shot
  **of that same task** (by mtime). The prompt states honestly that the shot
  may predate the diff (regression baseline, not proof), asks the reviewer to
  describe what it shows and check the diff against it, and offers the CLI for
  fresh screenshots.

So a cycle that changes the UI always leaves visual evidence in the review log,
and the verdict references it. Browse sessions are capped (3, 5-min idle) and the
whole surface can be disabled with `OCR_BROWSE_DISABLED=1`.

## Disk guard no deploy (P3-006, 01/09)

Um disco cheio derrubou o pilot com um `git index.lock` críptico. Agora o
`deploy()` roda um **guard de disco** como primeiro passo (antes de qualquer
git/npm): `statfs` no repo de produção (`apps/pilot/src/disk.ts`) e, com menos
de **5GB livres**, o deploy aborta com `{ ok: false, rolledBack: false }`,
detail `disk low: Xgb free (need 5.0gb) — deploy aborted before npm ci/build`,
evento `deploy/disk-guard` no feed e `notifySupervisor` avisando o supervisor.
Sonda indisponível = fail-open (nunca bloqueia deploy saudável). Sondas,
threshold, notify e emit são injetáveis (`DeployOpts`) — a bateria de eval
(`scripts/unit.test.ts`) testa o abort com threshold mockado provando que ele
acontece antes do `npm ci`.

## Deploy só de SHA verificado + quarentena (P2-058, 02/09)

Antes o `deploy()` aceitava qualquer HEAD de `origin/main`: um push direto em
main (bookkeeping do pipeline ou, pior, um commit hostil) virava deploy. Agora:

- **Merge verificado**: o gatekeeper grava o SHA do merge (squash de PR,
  sempre pós-gate verde; o fallback de merge local `--no-ff` foi removido pelo
  P1-076) em
  `~/.opencode-remote/pilot/verified-merges.jsonl` — código determinístico
  (nunca um agente). Round 2: a gravação só acontece quando o HEAD
  de main **andou** desde a ponta pré-merge **e** carrega a identidade de
  merge da task (subject `pilot(<id>): ...` no squash, ou o commit de merge
  `--no-ff` do branch no fallback) — merge enfileirado pelo `--auto` não
  grava nada (fail-closed; o código embarca no próximo merge verificado).
  As duas call sites de deploy resolvem o alvo com `latestDeployableSha()`:
  caminhada first-parent em `origin/main` que retorna o SHA verificado
  **mais recente não-quarentenado** e ignora commits de bookkeeping
  (mark-done, scribe, refill). Critério do backlog: **push direto em main não
  dispara deploy**.
- **Quarentena**: deploy que falha (steps/health/invariants/soak) grava o SHA
  ruim em `~/.opencode-remote/pilot/quarantine.jsonl` **antes** do rollback —
  o loop de redeploy do mesmo SHA quebrado acabou; produção fica no último
  SHA verificado bom até um merge posterior destravar. Round 2: falha de
  escrita da quarentena (anti-loop degradado) notifica o supervisor
  best-effort em vez de ficar só no log.
- `deploy()` re-checa o SHA recebido contra as duas listas (`shaGuardDetail`)
  como segunda camada — recusa com `{ ok: false, rolledBack: false }` e evento
  `deploy/sha-guard`, sem `notifySupervisor` (recusa esperada ≠ falha).
- Escolha de design: lista em state (determinística, offline, testável na
  bateria de eval) em vez de `gh api` no caminho crítico do deploy.
- Perda do arquivo (ex.: máquina nova) = fail-closed: nada deploya até o
  próximo merge do pilot regravar a lista.

## Watcher de releases do opencode (P2-100, 03/09)

O runtime do pipeline (CLI opencode) solta release quase diária, e mudança de
comportamento de provider (timeout default, regra de binding do Anthropic)
queima attempt do builder de um jeito que parece falha de task. O script
`scripts/opencode-release-watch.ts` dá o sinal de frescor do runtime:

- **Read-only por definição**: consulta
  `GET https://api.github.com/repos/anomalyco/opencode/releases/latest`
  (sem auth, User-Agent próprio, timeout de 10s), compara a tag com
  `opencode --version` local e **nunca atualiza nada** — só observa e reporta.
- **Divergiu** → grava `lastOpencodeRelease: {tag, publishedAt}` no
  `state.json` (escrita atômica, P2-024, preservando os demais campos) e
  emite evento `audit` no `events.jsonl` com o texto
  `runtime desatualizado: local X, latest Y` — o feed do Mission Control
  já o exibe; um chip dedicado pode casar nesse texto.
- **Idempotente**: mesma tag já gravada no state ⇒ no-op (sem evento
  duplicado); runtime em-par-com-a-latest ⇒ no-op (e registro velho de
  divergência é removido pra o chip não mentir).
- **Nunca quebra**: API fora / payload malformado / `opencode` ausente /
  `state.json` corrompido são warn no log e exit 0 — corrompido nunca é
  sobrescrito (reparo é do doctor, P1-030).

Run manual: `npx tsx scripts/opencode-release-watch.ts` (cobre via
`scripts/release-watch.test.ts` na bateria `test:unit`, com fetch mockado).
Wiring no loop do pipeline é follow-up — o spike valida o sinal primeiro.
