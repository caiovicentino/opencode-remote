# Torre de Controle — Mission Control do Major como teatro do trabalho

## Context

O dashboard atual (`apps/pilot/dashboard/index.html`, 870 linhas) é um painel de *relatório*: grafo de nós que acendem por fase, contadores do dia, ticker de 6 linhas e uma gaveta de log. Ele descreve o trabalho **depois** que ele acontece, com polling de 2 s sobre um tail de 200 eventos. O operador quer o oposto: ver o trabalho **enquanto** acontece, no detalhe: o builder pensando, os reviewers acusando, o gate julgando etapa por etapa, o deploy pousando batida a batida.

A investigação do código mostrou o fato que muda tudo: **o daemon já recebe, em tempo real, cada token e cada tool call de todos os agents do pilot**. `forwardEvents()` em `apps/daemon/src/index.ts:1410` consome o SSE `/event` do opencode, e os agents do pilot (`opencode run`, `apps/pilot/src/runner.ts:235`) rodam contra o mesmo servidor. Esses eventos hoje só saem selados E2E para devices pareados. O dashboard nunca os vê. O teatro já está sendo transmitido; falta abrir a cortina.

Restrições respeitadas: HTML self-contained sem build step, servido por `GET /dashboard`; dados via `/api/pilot-events` + `state.json`; streaming pelo servidor loopback 8792 que já existe; mobile/PWA; nada de backend novo. O `MissionControlView` da PWA (`apps/web/src/components/MissionControlView.tsx`) continua como post-mortem navegável e fica fora do escopo.

---

## 1. Conceito central

**A tela é uma torre de controle: cada task é um voo com a caixa-preta aberta ao vivo. Você vê o builder pensar em tokens, os reviewers acusarem com citações, o gate acender doze lâmpadas uma a uma e o deploy pousar com o eletrocardiograma do soak.**

Não é um painel *sobre* o trabalho. É o próprio trabalho, com legenda.

---

## 2. As seis visões (o que passa a ser visto)

### 2.1 Pista de voos: um strip por slot
Cada slot (`cfg.slots`, `apps/pilot/src/state.ts:10`) vira uma pista horizontal estilo Vercel deployments. A task percorre estações fixas: `planner → builder rN → reviewers rN → gate → merge → deploy`. Rounds aparecem como voltas na mesma estação, com o número da tentativa (`state.taskAttempts`) e o breaker P1-014 visível como "última chance".
- **Dado que já existe**: `events.jsonl` tipo `phase` (planner, builder "round N", context-checkpoint "NN%", reviewers, review-escalation, gatekeeper, merge, gate-fail, scribe); `loop.picked` com `slot`; `state.taskAttempts`; `progressOf()` e `etaMs` do forense (`apps/daemon/src/pilotforensic.ts:262`).
- **Falta**: `slot` só vem em `loop` e `result`. Precisa viajar em toda fase.

### 2.2 Caixa-preta ao vivo: o cockpit do agent
Clicar num voo abre a transcrição corrente do agent: texto chegando como typewriter real, cada tool call como um chip que pulsa enquanto `running` e assenta com duração quando `completed`. Sem throttle de 10 s (hoje `stream()` em `pipeline.ts:1330` deixa passar uma linha a cada 10 s).
- **Dado que já existe**: `message.part.updated` do opencode com `part.type` `text` | `tool`, `part.state.{status,title,output}`, `part.sessionID` (o mesmo shape que `ChatView.tsx:104` consome); `session.idle`, `session.error`; `state.taskCostSessions` liga task a sessões (pós-hoc).
- **Falta**: um evento `agent-session {task, role, round, sessionId, model}` no instante em que `idScanner()` (`runner.ts:78`) detecta o `ses_…`, para atribuir a sessão ao voo enquanto ela ainda está viva. Tier B (`claude -p`, `runTierB` em `runner.ts:395`) é não-streaming: o cockpit mostra "caixa-preta lacrada" com modelo, relógio e o output completo quando fecha. Honesto, não fake.

### 2.3 Arena de review: o duelo
SECURITY e QUALITY lado a lado, cada um com veredito, findings **mantidos** (verde, citação clicável) e findings **derrubados como alucinação** (riscados, com o motivo: arquivo inexistente ou snippet ausente do diff). Quando há divergência ou tudo é derrubado, o ESCALATION entra como terceiro juiz no centro. O builder responde no round seguinte e a arena mostra quais findings sumiram.
- **Dado que já existe**: `parseFindings`/`verifyFindings` (`pipeline.ts:1779, 1803`) produzem `kept[]` e `dropped[]` verbatim; `reviewerOk`, `needsEscalation`; `pilot.log` tem `reviewers done {secOk, qualOk}`, `finding hallucinated, dropped`, `review escalation done {approve, kept}`.
- **Falta**: um evento `review-verdict {task, round, reviewer, verdict, kept[], dropped[]}` por reviewer. Hoje `reviewers-done` só carrega um `ok` combinado e `detail` é cortado em 220 chars.

### 2.4 Tribunal do gate: doze lâmpadas
A bateria determinística (`gatekeeper()`, `pipeline.ts:1978`: evidence, typecheck, build, unit, lock-sync, reconnect, integration, desktop-sidecar, invariants, +desktop-render/desktop-flow condicionais, +corpus) vira uma coluna de lâmpadas que acendem em sequência com duração e marca de "cache" quando o resultado veio do preflight (P2-040). Falha acende vermelho, para tudo e abre o tail.
- **Dado que já existe**: `gate-fail` com `detail = step`; `gate-fail/<TASK>.json` com tail de 1200 chars; `countFailSteps()`.
- **Falta**: `gate-start {task, steps[]}` e `gate-step {task, step, ok, ms, cached}` por etapa. Hoje só a falha emite; o sucesso é silêncio.

### 2.5 Pouso do deploy: eletrocardiograma do soak
`sha-guard → install → build → health → soak i/N` desenhado como um traço de ECG: cada check de soak é uma batida verde ou vermelha, `live-invariants` são marcas maiores, `rollback` é arremetida e `rollback-health` é o veredito de segurança da pista. O SHA desliza para a pista PROD no `done`.
- **Dado que já existe**: tudo. `apps/pilot/src/deploy.ts` já emite `start`, `sha-guard`, `disk-guard`, `baseline`, `install`, `soak i/N`, `live-invariants i/N`, `rollback`, `rollback-health`, `done`, `pwa-kickstart`, `self-reload`, `ui-shot`.
- **Falta (opcional)**: `pollHealth()` (`deploy.ts:623`, 5 s por 90 s) não emite; um `health-probe` por tick daria os primeiros segundos do pouso.

### 2.6 Presença e pulso: quem está acordado e quanto custa
Trilho de presença tipo Figma: um avatar por role (builder por slot, security, quality, escalation, planner, strategist, researcher, explorer, forensic, scribe, red team), estado `idle | thinking | tool | done`, badge do modelo, relógio de fase vivo e "última fala" com fade. Abaixo, o pulso econômico: tokens da task subindo enquanto o agent pensa, taxa de cache hit, janela de febre (`cycles` ok/fail) e o alarme de audit mode com diagnóstico.
- **Dado que já existe**: `pilot.log` `agent-dispatch {role, tier, model, label}`; `msg:<role>` do `agentStream()` (`runner.ts:188`); `session.idle`; `state.taskCosts`, `taskCache {input, cacheRead, cacheWrite}`, `slotCache`, `cycles[]`, `blockEvents[]`, `auditMode`, `auditDiagnosis`, `lessonImpact`; `heartbeatMs`; `GET /api/session/:id` traz `tokens.*` da sessão viva.
- **Falta**: nada obrigatório. Tokens ao vivo vêm de um poll leve (5 s) só nas sessões ativas do voo.

---

## 3. Arquitetura de streaming

**Decisão: SSE nativo do daemon, poll mantido como hidratação e fallback.** Não WebSocket.

Por quê não o WS existente: `ws://127.0.0.1:8792/ws` (`attachLocalWs`, `index.ts:1787`) fala frames selados E2E do relay. Uma página HTML simples precisaria da criptografia de pareamento para ler. SSE é `EventSource` nativo, reconecta sozinho com `Last-Event-ID`, atravessa suspensão de PWA no iOS e não precisa de biblioteca.

### Endpoint novo: `GET /api/pilot-stream`
Servido em `handleApi()` (o handler recebe o `res` cru, `apps/daemon/src/metrics.ts:72`, então streaming é possível). Auth: `authorized()` com cookie `ocr_session`; o dashboard minta o cookie uma vez via `POST /api/session` com o Bearer, porque `EventSource` não manda headers. Token nunca vai em query string.

Canais multiplexados por `event:` do SSE:

| `event:` | Fonte | Frequência |
|---|---|---|
| `snapshot` | mesmo payload do `/api/pilot-events` (state, últimos eventos, cfg, alertas) | 1x na conexão e a cada reconexão |
| `pilot` | tail-follow de `~/.opencode-remote/pilot/events.jsonl` via `fs.watch` | por linha nova |
| `agent` | `message.part.updated`, `session.idle`, `session.error` do `forwardEvents()`, filtrados para sessões do pilot | deltas coalescidos a 100 ms |
| `hb` | `heartbeatMs` | 15 s |

Regras de fôlego: coalescer deltas de texto por sessão em janelas de 100 ms; tool `output` maior que 2 KB vira cabeça+cauda; máximo 20 mensagens/s por cliente; cliente que não drena em 5 s é fechado. Gauge `ocr_pilot_stream_clients` nas métricas.

Filtro "sessão do pilot": o conjunto é alimentado pelos eventos `agent-session` (item 2.2). Fallback sem o evento: `GET /session/:id` no opencode uma vez por sessão nova, cache por 1 h, admite quando `directory` começa com `~/.opencode-remote/pilot/repo-`.

Tail-follow precisa sobreviver ao `trim()` de `events.ts` (reescrita do arquivo em 400 linhas): ao detectar `size` menor que o offset, reabre do zero e retoma a partir do último `ts` visto.

`/api/pilot-events` ganha `?since=<ISO>&limit=<n>` para o poll de fallback ficar barato (hoje devolve 200 eventos fixos a cada 2 s).

### Eventos que o pilot precisa emitir (todos via `emit()` de `apps/pilot/src/events.ts`)

| Evento | Onde | Campos |
|---|---|---|
| `slot` em toda fase | `runPipeline()` recebe o slot e repassa nos `emit("phase", …)` | `slot` |
| `agent-session` | `runAgent()` quando `idScanner().scan()` devolve `sessionId` pela primeira vez; callback `onSession` novo | `task, role, round, sessionId, model, tier` |
| `review-verdict` | `pipeline.ts` após `verifyFindings` (linhas 1650-1651 e 1692) | `task, round, reviewer, verdict, data:{kept[], dropped[]}` |
| `gate-start` / `gate-step` | `gatekeeper()`, antes do `evidence` e dentro do loop `for (const [name, cmd] of steps)` (2028-2035), mais `corpus` | `task, step, ok, ms, cached` |
| `agent-start` / `agent-end` para tier B | `runAgentForRole()` (`runner.ts:453`) | `task, role, model, tier:"B"` |
| `health-probe` (opcional) | `pollHealth()` | `ok` |

`PilotEvent` ganha `data?: Record<string, unknown>` com cap de 4 KB serializado, porque `detail` (220 chars) não comporta findings verbatim. `MAX_LINES` sobe de 400 para 1500. Tokens e tool calls **nunca** entram no `events.jsonl`: o arquivo guarda fatos, o stream carrega o efêmero.

---

## 4. Três detalhes de craft

**Densidade calma, cor só em estado.** Tipografia em três tamanhos (11/12/13 px), `tabular-nums` em todo número, monospace só onde é dado bruto (transcrição, SHA, tail). Nenhum card cinza: linhas de 28 px separadas por hairline `1px rgba(255,255,255,.06)`. Cor aparece apenas para significar estado (ciano trabalhando, verde ok, vermelho falha, âmbar deploy, índigo reviewer). Preto `#04060a` e a paleta atual permanecem. Layout desktop em três colunas fixas (pistas | cockpit | arena/gate/deploy); mobile empilha e o cockpit vira bottom sheet.

**Microanimações com significado físico.** Typewriter real dirigido pelos deltas do stream, com caret piscando só enquanto a sessão está em `thinking`. Tool chip: borda pulsa em `running`, assenta com a duração em `completed`, avermelha em `error`. Lâmpadas do gate acendem com stagger de 120 ms na ordem real de execução. Soak como `<svg>` cujo traço se desenha com `stroke-dashoffset`; cada batida é um `<circle>` que nasce em escala 0 → 1. O `done` do deploy desliza o SHA para a pista PROD com `transform` em 600 ms. Tudo em CSS, tudo desligado sob `prefers-reduced-motion`. Canvas só para o fundo da pista; texto sempre em DOM.

**Presença e relógio de missão.** Avatar de cada role com "cursor" à la Figma: a última linha falada, 60 chars, some em 3 s de silêncio. Badge do modelo (glm-5.2, opus, fable-5.1) vindo do `agent-dispatch`. Header com relógio T+ desde o `pipeline start` do voo e T- para o gate, estimado por `etaMs` do forense ou `phaseAvg` de `/api/pilot-history` quando existir. Heartbeat vira um pulso de 1 px na borda do header, não uma bolinha.

---

## 5. Plano de build: três PRs cirúrgicos

Cada PR vira uma task no `BACKLOG.md` com spec em `specs/<ID>.md`. PR1 e PR2 tocam infra do pilot/daemon e passam pelo step `corpus` do gate. PR3 é size L e usa review incremental (P1-060).

### PR1 (S): os eventos que faltam
Arquivos: `apps/pilot/src/events.ts`, `apps/pilot/src/runner.ts`, `apps/pilot/src/pipeline.ts`, `apps/pilot/src/index.ts`, `apps/daemon/src/index.ts` (só o `since/limit`), `scripts/unit.test.ts`, `docs/PILOT.md`.
- `PilotEvent` ganha `data?`, `role?`, `round?`; `emit()` corta `data` em 4 KB; `MAX_LINES = 1500`.
- `runAgent()` aceita `onSession(id)` e chama uma única vez.
- `runPipeline()` recebe `slot` e todos os `emit("phase")` do arquivo o carregam.
- Emissões novas: `agent-session`, `review-verdict`, `gate-start`, `gate-step`, `agent-start/end` (tier B).
- `/api/pilot-events?since=&limit=`.

Critérios verificáveis:
- Teste unitário (`scripts/unit.test.ts`, ao lado do teste de `parseFindings` na linha 1879): saída falsa de reviewer com dois findings (um real, um alucinado) produz um `review-verdict` com `kept.length === 1` e `dropped.length === 1`, verbatim.
- Teste unitário: `gatekeeper()` com `exec` injetado que falha no terceiro step emite exatamente `gate-start` + 3 `gate-step` + 1 `gate-fail`, com `cached: true` no step já presente em `rerunResults`.
- Teste unitário: `idScanner` + `onSession` dispara uma única vez mesmo com o ID repetido em chunks.
- `curl` em `/api/pilot-events?since=<ts>` devolve só eventos posteriores; sem `since` mantém o comportamento atual.
- `events.jsonl` nunca passa de 1500 linhas após 2000 `emit()`.
- Corpus gate verde.

### PR2 (M): `/api/pilot-stream` no daemon
Arquivos: `apps/daemon/src/pilotstream.ts` (novo, funções puras), `apps/daemon/src/index.ts` (rota + hook em `forwardEvents()`), `apps/daemon/src/metrics.ts` (gauge), `scripts/pilot-stream.test.ts` (novo, entra no `test:unit`), `docs/api.md`.
- `pilotstream.ts` exporta: `TailFollower` (offset + detecção de truncate + retomada por `ts`), `isPilotSession(evt, set)`, `coalesceDeltas(buffer, windowMs)`, `clipToolOutput(part, 2048)`, `sseFrame(event, id, data)`. Tudo sem I/O de rede, testável a seco.
- Rota em `handleApi()`: `authorized()`, headers `text/event-stream`, `snapshot` imediato, registro do cliente, limpeza em `close`.
- Hook: `forwardEvents()` passa cada `evt` a `pilotStream.offer(evt)` logo após o `broadcast()` existente.
- Membership por `agent-session` (PR1) com fallback por `directory` via `GET /session/:id` cacheado.

Critérios verificáveis:
- Teste: `TailFollower` sobrevive a uma reescrita do arquivo que encolhe (simula `trim()`) sem duplicar nem perder linhas.
- Teste: 50 deltas de texto em 100 ms viram 1 frame; tool output de 10 KB sai com cabeça+cauda e marcador de corte.
- Teste: `isPilotSession` rejeita sessão fora do conjunto e aceita após `agent-session`.
- `curl -N` com cookie mostra `event: snapshot` como primeira linha, e um `echo >> events.jsonl` aparece como `event: pilot` em menos de 500 ms.
- Sessão `opencode run` iniciada em `~/.opencode-remote/pilot/repo-1` aparece como `event: agent` no stream.
- `scripts/invariants.ts` ganha a checagem: nenhum `token=` em URL de `EventSource` no dashboard.
- Gauge `ocr_pilot_stream_clients` sobe e desce com conexões.

### PR3 (L): a Torre de Controle
Arquivos: `apps/pilot/dashboard/index.html` (reescrito), `apps/pilot/dashboard/tower.css`, `apps/pilot/dashboard/tower.js`, `apps/pilot/dashboard/reducer.mjs` (puro), `apps/daemon/src/index.ts` (rota `GET /dashboard/<arquivo>` com allowlist fixa desses três nomes, mesmo padrão de `resolveUpdatePath`), `scripts/dashboard-reducer.test.ts` (novo), `docs/PILOT.md`.
- Sem build step: quatro arquivos estáticos, servidos pelo daemon; `index.html` mantém o contrato `__APITOKEN__ → ""` (P1-057).
- `reducer.mjs`: `reduce(state, event) → state` puro. Modelo: `flights[slot]`, `sessions[sessionId] → {task, role, round, parts[]}`, `arena[task][round]`, `gate[task] → steps[]`, `landing → beats[]`, `presence[role]`, `economy`. É o único lugar que interpreta eventos; a UI só renderiza o estado.
- `tower.js`: conexão `EventSource` com hidratação por `snapshot`, reconexão em `visibilitychange`, fallback para `/api/pilot-events?since=` a cada 10 s quando o SSE cai duas vezes. Render por diff de DOM manual (sem framework), linhas com altura fixa para zero layout shift.
- Layout: header com missão editável e relógio T+; pistas por slot; cockpit; arena; gate; pouso; trilho de presença; pulso econômico. Mobile 390 px empilha com o cockpit em bottom sheet. `manifest` mínimo inline para "adicionar à tela inicial".
- Mantém o que hoje funciona: budget editável (`POST /api/pilot-budget`), missão (`/api/pilot-mission`), filas (`/api/pilot-ready`, `/api/pilot-done`), chips de `rollbackUnhealthy`, `pwaDown`, `auditMode`, breakdown de `failSteps`.

Critérios verificáveis:
- Teste golden: reproduzir um `events.jsonl` real gravado como fixture (`scripts/fixtures/tower-events.jsonl`) através de `reduce()` e comparar o estado final com um JSON esperado; inclui um round com escalação, um `gate-fail` em `unit` e um deploy com rollback.
- Teste: `reduce()` com `agent-session` seguido de 3 `message.part.updated` da mesma sessão produz um cockpit com o texto concatenado e um tool chip `completed` com duração.
- Teste: `reduce()` ignora `message.part.updated` de sessão não atribuída (nenhum estado novo).
- Evidência visual (P2-009): screenshots via `node tools/browse.mjs shot` em 1440 px e 390 px com o pilot rodando um voo real, mostrando cockpit com texto vivo e arena com pelo menos um finding derrubado.
- Reconexão: derrubar o daemon e subir de novo; o dashboard reidrata sozinho em menos de 5 s sem recarregar a página.
- `prefers-reduced-motion: reduce` desliga typewriter, pulso e ECG; verificável por screenshot com a media query forçada no `browse.mjs`.
- `desktop-sidecar.test.ts` continua verde (o `/dashboard` é embutido no sidecar; ver `scripts/invariants.ts:89-100`).

---

## Verificação ponta a ponta (após os três PRs)
1. `npm run typecheck && npm run test:unit && npx tsx scripts/invariants.ts` verdes.
2. Com o pilot em execução, abrir `http://127.0.0.1:8792/dashboard?token=<apiToken>`: o token é trocado por cookie e some da URL; `event: snapshot` chega; a pista do slot 1 mostra o voo atual.
3. Durante o round do builder: o cockpit escreve em tempo real; um tool call `bash` aparece como chip pulsando e assenta.
4. Durante os reviewers: a arena mostra dois vereditos, findings mantidos e derrubados, com citações que abrem o arquivo no tail.
5. Durante o gate: lâmpadas acendem na ordem `evidence → typecheck → … → invariants`, com marca de cache no `typecheck`.
6. Durante o deploy: ECG do soak com batidas verdes; `done` desliza o SHA para PROD.
7. No iPhone (PWA): mesma sequência empilhada, cockpit como bottom sheet, reconexão após voltar do background.
