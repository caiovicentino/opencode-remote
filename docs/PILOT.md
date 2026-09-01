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
| `builder` | implementa a task em branch `pilot/<id>`, commita | 45 min |
| `security reviewer` | foco: crypto, auth, injection, secrets | 20 min |
| `quality reviewer` | foco: regressão, UX, docs, testes | 20 min |
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

Quando o diff da task toca `apps/desktop/` **ou `apps/web/`** (a UI que o smoke
valida), o gate também roda o **render smoke** (`npm run test:desktop-render`):
além do boot do processo, o driver (`scripts/desktop-render-driver.cjs`) sobe o
Electron de verdade com as mesmas `webPreferences` sandboxed, carrega o build da UI
(`apps/web/dist/index.html`) via `file://`, espera `did-finish-load`, captura erros
de console do renderer (`webContents.on("console-message")`) e confere que o `#root`
ganhou conteúdo — **janela branca reprova** (ex.: asset 404 em `file://`). A captura
de console é verificada com um **canário**: o driver injeta um `console.error`
conhecido logo após o load e exige que o listener o tenha visto — um bump do Electron
que mude a assinatura do evento reprova alto em vez de passar vazio. Falha de
ServiceWorker em `file://` é ruído conhecido (registrada por `apps/web/src/main.tsx`;
será removida em P3-005) e não reprova. O trigger é **fail-closed**: se `git diff`
falhar, o smoke roda de qualquer jeito. O teste roda sem tocar no daemon de
produção: `userData` do Electron é temporário e nenhum sidecar é spawnado.

## Deploy staged + rollback

1. `git reset --hard <sha>` no repo de produção + `npm ci` + `npm run build`
2. `launchctl kickstart -k` relay e daemon
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


## Round efficiency + async deploy (31/08, v1.1)

- **Preflight typecheck**: after each builder round, a fast `tsc --noEmit` runs
  before the reviewers — broken code bounces straight back to the builder with
  the error tail instead of burning reviewer tokens.
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
