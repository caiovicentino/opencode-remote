# Pilot — Constituição (invariants executáveis)

Este documento define as regras **não negociáveis** do opencode-remote.
Elas são verificadas por `scripts/invariants.ts` (suite `invariants`) e lidas por
todos os agents do Pilot (builder, reviewers, red team). Um PR que quebra a
constituição NÃO é mergeado — sem exceção, sem waiver.

## Invariants (verificadas a cada merge e a cada deploy)

1. **E2E permanece E2E** — o relay é um roteador cego: sem dependência de crypto,
   sem logs de payload, sem descriptografia. `packages/protocol/src/crypto.ts`
   deve manter `seqAad` (binding `from + seq` no AAD do AES-GCM).
2. **Proteção anti-replay** — frames repetidos NÃO produzem segunda resposta
   (verificado ao vivo contra o daemon em `invariants.ts --live`).
3. **Allowlist de clientes** — handshake só pareia clientes na allowlist
   (`daemon.json: clients[]`, fresh-read por handshake).
4. **Estado 0600** — `~/.opencode-remote/daemon.json` com permissões restritivas.
5. **Guards de payload** — `SAFE_PAYLOAD` (900KB) no daemon e `MAX_FRAME` (1MB)
   no relay presentes.
6. **Sem traversal** — downloads restritos a `uploads/Desktop/Downloads/Documents/repo`.
7. **Sem segredos commitados** — scan de padrões de chave/token no repositório.
8. **Sem HTML injection** — `dangerouslySetInnerHTML` proibido no apps/web.
9. **Portas documentadas** — nenhum listener novo sem documentação em README/docs.
10. **Sem shadowing de stdlib** — o diff de merge (`origin/main...HEAD`) não
    introduz na **raiz do workspace** arquivo com nome de módulo stdlib de
    runtime (`struct.py`, `os.py`, `base64.py`, `json.py`, `types.py`,
    `random.py`). Defesa em profundidade contra cadeias de hijack de agente
    (RCE em Auto Mode, 26/08/2026): arquivo extraído na raiz sombreia o stdlib
    de qualquer Python rodado depois. Se o diff não puder ser computado, o
    check reprova (fail-closed).

## Product invariants (judgment)

Invariantes de **produto** que os agents aplicam por julgamento (reviewers, red team,
explorer de first boot) — explicitamente **NÃO** verificadas por `scripts/invariants.ts`:

- **Local = sem cerimonia de auth** — o app roda na maquina do usuario; nenhum fluxo
  pode exigir login/pareamento como barreira se existe caminho mais direto, e todo
  fluxo deve ser alcancavel a partir do **first boot** (state limpo, primeira
  instalacao). O explorer noturno roda uma passada fresh-state por dia exatamente
  para auditar esta regra (P3-052/P1-071).

## Meta-commits e proteção de `main` (P1-076)

Nenhum commit de bookkeeping do pipeline (mark-done, refill do strategist,
lições do scribe, achados de red team/explorer, bloqueios do circuit breaker,
amostras do golden corpus) é empurrado direto em `main`. Todo meta-commit pousa
pela branch permanente `pilot/meta` + PR com squash auto-merge
(`landMetaCommit`, `apps/pilot/src/metapush.ts`), sempre com o guard de diff
P1-057 relido a cada tentativa — um diff recusado nunca é empurrado. Não
existe fallback para `git push origin main`: sem `gh` funcional, o commit fica
em `origin/pilot/meta` e o ciclo seguinte retenta. A bateria de eval reprova
qualquer reintrodução de `push -q origin main` ou merge local em `main` no
código do pilot (check grep-style em `scripts/unit.test.ts`). A configuração da
proteção de branch no GitHub é do operador — runbook em docs/PILOT.md.

## Mudanças na constituição

Alterar `scripts/invariants.ts` ou qualquer regra acima exige:
commit com prefixo `constitution-change:` no body descrevendo o porquê,
e aprovação unânime dos 2 reviewers (security + quality).

Adicionar (ou editar) uma regra de julgamento — inclusive as invariantes de
produto da seção acima e o prompt `CONSTITUTION` em `apps/pilot/src/pipeline.ts`
— segue a mesma exigência de flag, mesmo sem tocar `invariants.ts`/`deploy/`.
O commit do item 7 (P1-071) carrega a flag no body: verificado no review.

## Hierarquia de segurança

```
invariants.ts (máquina)  >  reviewers (LLM)  >  builder (LLM)
```

Se um reviewer aprova algo que a suíte reprova, a suíte vence. Sempre.
