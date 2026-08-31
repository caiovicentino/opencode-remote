# BACKLOG — fila de trabalho do Pilot

Formato: `- [ ] (ID) [Pn] Título — spec: ...`
O Pilot consome a primeira task `## Ready` em ordem. P0 > P1 > P2 > P3.
Tasks feitas vão para `## Done` automaticamente.

## Ready

- [ ] (P3-001) [P3] Título da sessão no header do chat — spec: em ChatView.tsx o header deve mostrar o título da sessão atual (buscar via GET /session/:id no mount); critério: título visível, sem regressão de typecheck/build.

## Done
- [x] (P2-003) [P2] Ordenar sessões por atividade recente — spec: em SessionsView.tsx ordenar a lista por updatedAt desc (mais recente primeiro) usando o mesmo campo já exibido; critério: lista ordenada, typecheck e build verdes. — merged by pilot 2026-08-31

- [x] (P2-002) [P2] Tempo relativo nas sessões — merged by pilot 2026-08-31 (PR #2)
