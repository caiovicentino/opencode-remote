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

## Deploy staged + rollback

1. `git reset --hard <sha>` no repo de produção + `npm ci` + `npm run build`
2. `launchctl kickstart -k` relay e daemon
3. Health: `GET 127.0.0.1:8792/api/health` (Bearer apiToken) até 90s
4. Soak: checagens a cada 60s por `monitorMin`; 3 falhas seguidas = rollback
5. Rollback: reset para o SHA anterior + rebuild + kickstart (idempotente)

## Budgets e kill switch

- `~/.opencode-remote/pilot.json` (opcional): `maxTasksPerDay` (6), `maxDeploysPerDay` (6),
  `maxReviewRounds` (3), `taskTimeoutMin` (45), `monitorMin` (10), `digest`.
- **Freeze**: `touch ~/.opencode-remote/pilot.lock` para o loop (checado a cada ciclo).
- Contadores diários em `~/.opencode-remote/pilot/state.json`.

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
3. **Serviço**: heartbeat + watchdog — 30min sem sinal → exit → KeepAlive ressozinho

## Rodar manualmente

```sh
npm run once --workspace @ocr/pilot        # um ciclo (eval)
npm run start --workspace @ocr/pilot       # loop contínuo em foreground
./deploy/install-pilot.sh                  # instalar como serviço launchd
```

## Regras do BACKLOG.md

Formato das tasks (seção `## Ready`):

```md
- [ ] (P2-001) Título curto — spec: o que fazer, onde, e critério de aceite
```

O pilot pega a primeira task `Ready`, em ordem. Red team insere `(RT-###)` P0 no topo.
