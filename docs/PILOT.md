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
                                     reset SHA → npm ci → build → kickstart
                                     → health watch (90s) → soak (10min)
                                     → OK: digest push / FAIL: auto-rollback
```

### Roles (todos `opencode run` headless)

| Role | O que faz | Timeout |
|---|---|---|
| `planner` | para tasks **P0/P1**: agent read-only lê o código e escreve `specs/<ID>.md` na branch antes do builder | 10 min |
| `builder` | implementa a task em branch `pilot/<id>`, commita | 45 min |
| `security reviewer` | foco: crypto, auth, injection, secrets | 20 min |
| `quality reviewer` | foco: regressão, UX, docs, testes | 20 min |
| `scribe` | após o merge: destila até 3 lições do diff + findings → `docs/EXPERIENCE.md` | 10 min |
| `strategist` | quando a fila tem <2 tasks: lê código/memória/métricas e redige as próximas tasks no BACKLOG.md | 25 min |
| `red team` (03:00/dia) | tenta quebrar segurança/robustez; achados viram task P0 | 30 min |
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
`npm run dist`) fica fora do gate — é etapa de distribuição.

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

## Deploy staged + rollback

0. **Guard de disco (P3-006)**: antes de qualquer mutação (git/npm), `statfs` no
   repo de produção — com menos de **5GB livres** o deploy aborta com detail
   claro (`disk low: Xgb free (need 5.0gb) — deploy aborted before npm ci/build`),
   evento `disk-guard` no feed e `notifySupervisor` em vez de falhar depois com
   um `git index.lock` críptico. Sonda indisponível = fail-open (não bloqueia).
1. `git reset --hard <sha>` no repo de produção + `npm ci` + `npm run build`
2. `launchctl kickstart -k` relay e daemon (o daemon derruba-se com shutdown
   graceful desde P2-020: drain ≤3s, ws close 1001, exit 0)
3. Health: `GET 127.0.0.1:8792/api/health` (Bearer apiToken) até 90s
4. Soak: checagens a cada 60s por `monitorMin`; 3 falhas seguidas = rollback
5. Rollback: reset para o SHA anterior + rebuild + kickstart (idempotente)

## Budgets e kill switch

- `~/.opencode-remote/pilot.json` (opcional): `maxTasksPerDay` (6), `maxDeploysPerDay` (6),
  `maxReviewRounds` (3), `maxAttemptsPerTask` (4), `slots` (1), `taskTimeoutMin` (45), `monitorMin` (10), `digest`.
- **Freeze**: `touch ~/.opencode-remote/pilot.lock` para o loop (checado a cada ciclo).
- Contadores diários em `~/.opencode-remote/pilot/state.json`.

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
- **Gate serializado entre slots**: a bateria de eval usa portas fixas
  (reconnect/integration) e o merge empurra pra main — o gatekeeper roda em
  exclusão mútua; builders/reviewers continuam paralelos.
- **Arquivos de diagnóstico por task**: `pilot/gate-fail/<ID>.json` (carryover
  de falha do gate) e `pilot/builder-<ID>.log` (output do builder) — sem
  last-writer-wins entre slots.
- **Deploys continuam seriais**: `deployBusy` garante um deploy por vez; merge
  concorrente fica na fila na main e o próximo deploy pega.

## Observabilidade

- **Dashboard 3D em tempo real**: `http://127.0.0.1:8792/dashboard?token=<apiToken>`
  (Canvas 2D sem dependências: nodes do pipeline, partículas de trabalho, bursts de merge, rollback vermelho)
- Logs JSONL: `~/.opencode-remote/logs/pilot.log`
- Feed bruto: `GET 127.0.0.1:8792/api/pilot-events` (Bearer apiToken) — eventos + contadores + heartbeat
- Digest a cada pipeline: push no seu telefone (via `POST /api/push` autenticado no daemon)
- Sucessos, falhas, rollbacks e achados do red team aparecem como notificação.

## Self-healing (3 níveis)

1. **Agent**: retry de npm ci, re-upload de attachments, rounds de review
2. **Pipeline**: rollback automático de deploy (health + soak + invariants live); diff vazio do builder + task já presente no histórico de merge de `origin/main` (grep ancorado no formato de sujeito `^pilot(<id>):`, com ID validado) → `markDone` no BACKLOG.md e ciclo encerrado com sucesso em vez de falhar para sempre na mesma task
3. **Serviço**: singleton via pidfile — ao iniciar, o pilot grava `~/.opencode-remote/pilot/pilot.pid`
   e, se a instância anterior ainda estiver viva, a derruba (SIGTERM → 2s → SIGKILL, log
   `stale pilot instance killed`); o self-reload pós-deploy sai com `process.exit(0)` imediato
   (log já flushado, sem órfão); heartbeat + watchdog — 30min sem sinal → exit → KeepAlive ressozinho

## Stop-loss por task (circuit breaker, P1-014)

Toda falha de pipeline de uma task (builder não terminou, diff vazio, reviewers
reprovando até `maxReviewRounds`, gatekeeper vermelho, crash) incrementa
`taskAttempts[id]` em `state.json`. Ao atingir `maxAttemptsPerTask` (pilot.json,
default 4) o breaker dispara:

1. a linha da task sai de `## Ready` e vai para a seção `## Blocked` do
   BACKLOG.md (commit + push, com resumo do último findings) — o painel FILA do
   dashboard já mostra as duas filas;
2. um **único** `notifySupervisor` "task blocked after N attempts" é enviado;
3. a task não é re-agendada: cooldown infinito até um humano (ou o red team)
   mover de volta para `## Ready` — o contador é zerado quando a task passa no
   gate e também no momento do bloqueio, então a re-entrada começa limpa.

O contador **não** é zerado pelo reset diário de `state.json` (virar a noite não
reabre o breaker) e, se o push do bloqueio falhar, o guard do loop re-bloqueia a
task no ciclo seguinte em vez de executá-la de novo.

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
  segurando o lock de exclusão mútua entre slots (P1-006).
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

## Round efficiency + async deploy (31/08, v1.1)

- **Preflight typecheck**: after each builder round, a fast `tsc --noEmit` runs
  before the reviewers — broken code bounces straight back to the builder with
  the error tail instead of burning reviewer tokens.
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

## Verifiable findings (P2-015)

Reviewers are LLMs and hallucinate. When the pipeline parses `VERDICT:
REQUEST_CHANGES`, every finding bullet must carry verifiable evidence:

- a repo-relative `path/file.ext:LINE` citation — the file must exist in the
  workspace clone and, when a line is cited, that line must be non-empty; or
- a quoted literal snippet (≥6 chars) that appears verbatim in the reviewed diff.

A cheap mechanical verifier (`verifyFindings` in `apps/pilot/src/pipeline.ts`)
drops findings whose citations don't resolve and logs each one as
`finding hallucinated, dropped` (level `warn`). If **all** findings of a
`REQUEST_CHANGES` verdict are dropped, the review degenerates to an effective
APPROVE — a reviewer that provides no real evidence cannot block a merge.
Only verified findings reach the builder prompt in the next round; the
reviewer prompt documents the citation contract. Pinned by unit tests in
`scripts/unit.test.ts` (one valid citation with a real path, one hallucinated
path — only the invalid one is dropped).

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
   deduplica contra o que já existe, appenda (máx. 3 por merge) e comita/pusha em
   `main` (`pilot(scribe): N lesson(s) from <ID>`), com retry de push para lidar com
   scribes concorrentes de slots paralelos. Falha do scribe nunca falha o pipeline
   (o merge já aconteceu); é log + evento `scribe-done`.
2. **Injeção nos prompts**: `builderPrompt` e o prompt do strategist recebem o
   **top-5 de lições relevantes** — keyword-match (tokenizado, stopword-filtered)
   do título (peso 2) + spec (peso 1) da task contra o texto da lição, empate
   resolvido pela mais recente primeiro. Task sem overlap de keywords não recebe
   lição nenhuma (nada é injetado à força).
3. **Manutenção noturna (red team)**: no pass noturno das 03:00, além da caça a
   buracos de segurança, o pilot **deduplica e poda** `docs/EXPERIENCE.md`
   quando ele passa de **60 lições** — dedupe por chave normalizada (case/
   pontuação/provenance-insensitive, vence a ocorrência mais recente) e poda
   para as 60 mais recentes, com commit+push `pilot(redteam): experience maintenance`.

A memória cresce a cada merge (critério de aceite) e os prompts provam a injeção
nos testes de `scripts/unit.test.ts` (parse, match, append-dedupe, cap e block do
builder).

## RESEARCHER role (daily frontier scan)

Once per day, before picking tasks, the pilot wakes a RESEARCHER agent with webfetch.
It scans Electron releases, opencode releases, competing desktop-agent product pages
and HN front page, compares against docs/VISION.md, and appends 1-2 `[spike]` tasks to
BACKLOG.md ## Ready (citing the source URL in the spec). The scan commit stays on main;
the summary is pushed to the supervisor session for review. Spike budget rule: at least
1 in 4 tasks may be an experiment — cheap failures are signal.

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
