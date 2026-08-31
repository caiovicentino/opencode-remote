# BACKLOG — fila de trabalho do Pilot

Formato: `- [ ] (ID) [Pn] Título — spec: ...`
O Pilot consome a primeira task `## Ready` em ordem. P0 > P1 > P2 > P3.
Tasks feitas vão para `## Done` automaticamente.

## Ready

- [ ] (P2-005) [P2] Filtro de sessão ativa — spec: em SessionsView.tsx adicionar chips de filtro (Todas / Com badge / Sem badge) acima da busca; estado local, sem deps; critério: filtro funcional, typecheck/build verdes.
- [ ] (P3-002) [P3] Copiar path do arquivo — spec: no FileCard.tsx adicionar botão de copiar o path absoluto do arquivo (navigator.clipboard.writeText com fallback); critério: botão copia e mostra feedback visual, typecheck/build verdes.
- [ ] (P3-003) [P3] Empty state do chat — spec: em ChatView.tsx quando não há bubbles mostrar mensagem de boas-vindas com dicas (ex: "mande um áudio, foto ou texto"); critério: empty state renderiza, typecheck/build verdes.

## Done
- [x] (P2-004) [P2] Diff preview no approval — spec: no card de approval do ChatView.tsx, antes dos botões Approve/Reject mostrar as 3 primeiras linhas do comando/patch pedido (campo metadata.command ou patterns do evento de permissão, já disponível no payload); critério: card mostra contexto legível, typecheck/build verdes. — merged by pilot 2026-08-31

- [x] (P3-001) [P3] Título da sessão no header do chat — merged by pilot 2026-08-31
- [x] (P2-003) [P2] Ordenar sessões por atividade recente — merged by pilot 2026-08-31
- [x] (P2-002) [P2] Tempo relativo nas sessões — merged by pilot 2026-08-31 (PR #2)
