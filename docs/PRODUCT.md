# PRODUCT — North Star

Benchmark de UI/UX: **Claude Desktop** (set/2026). Todo PR de front-end deve se
perguntar: "o Claude faria assim?" Se a resposta é não, não mergea.

## Princípios
1. **Tipografia primeiro** — corpo de conversa 15-16px, line-height 1.6-1.7,
   coluna de leitura max ~46rem centrada. Sem parede de texto justificada.
2. **Calma** — permissões e erros nunca gritam; badges passivos, linhas
   colapsáveis. Animações 150-300ms, ease-out, respeitando prefers-reduced-motion.
3. **Artifact-first** — o conteúdo produzido (diff, html, pdf, csv) é cidadão de
   primeira classe: painel dedicado, header com ações (abrir, baixar, expandir),
   slide-in suave, esc fecha.
4. **Detalhe que denuncia cuidado** — hover states, focus rings, ellipsis em
   títulos truncados, skeleton de loading, scroll-to-bottom flutuante.
5. **Paralelismo visível** — múltiplas sessões/rotinas são cidadãos de primeira
   classe na UI (Mission Control, badges, próximas rotinas agendadas).
6. **Zero cara de AI-generated** — sem gradientes gratuitos, sem emojis em UI,
   sem blocos cinza genéricos; hierarchy real de conteúdo.

## Deltas concretos vs. nosso app (set/2026)
- Lista de conversas: agrupamento temporal (Hoje/Ontem/Anteriores), hover com
  ação, estados ativos nítidos
- Bloco "Pensou por Xs" colapsável (thinking) com transição suave
- Composer: attach (+), mic, seletor de modelo/esforço inline, textarea auto-grow
- Colar no composer anexa print/imagem/arquivo copiado (P2-277, até 4 itens por
  colagem de 25 MB cada); colar texto continua sendo texto
- Home viva no shell desktop (P2-123): greeting serifado com glifo, composer
  central (~640px) com toggle Chat/Cowork + seletor de modelo + mic, e 3 ideias
  clicáveis que pré-preenchem a primeira mensagem — o estado vazio deixa de ser
  um beco (P1-071: todo fluxo alcançável no primeiro boot)
- Painel de artifact com animação de entrada/saída e backdrop
- Gauge de contexto e recap (P1-079) no rodapé do chat, discretos
- Rotinas agendadas visíveis ("Programado"), histórico de execução por rotina
- Cmd+K: switcher de sessões com preview e teclas ←/→

## Regra de ouro
Cada task de UI fecha com screenshot desktop-flow provando o critério visual.
