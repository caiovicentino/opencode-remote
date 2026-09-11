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
- Copiar mensagem direto da bolha (P2-282): alvo de 44px sempre visível no
  telefone, hover/foco no ponteiro, confirmação calma no próprio botão — o
  texto copiado é a resposta, sem rastro de raciocínio nem de tools
- Home viva no shell desktop (P2-123): greeting serifado com glifo, composer
  central (~640px) com toggle Chat/Cowork + seletor de modelo + mic, e 3 ideias
  clicáveis que pré-preenchem a primeira mensagem — o estado vazio deixa de ser
  um beco (P1-071: todo fluxo alcançável no primeiro boot)
- Primeiro boot com shell real (P3-365): a jornada degradada renderiza o
  esqueleto do shell desktop — sidebar com rail funcional e panes
  offline-capables (Mission Control, lista de artifacts, Ajustes) — em vez de
  uma tela cheia; o card calmo "Conectando pela primeira vez…" segue como herói
  da coluna principal, e o mapa de panes do herói troca pra variante "Antes de
   parear" (cadeado só em Conversas) pra não contradizer o rail ao lado
   (P1-071: todo fluxo alcançável no primeiro boot); P3-422: o mapa vira uma
   linha só ("Conversas pede pareamento; o resto já abre ao lado") — o rail
   ao lado já lista os mesmos itens, então repetir o card era navegação
   duplicada na mesma tela. O mapa lista também
   Ajustes, que o rail abre offline no primeiro boot (P3-389). Na tela clássica
   centrada e na cerimônia manual do shell desktop o mapa também não mente
   sobre capacidade offline (P3-413): vira "Antes de parear" com cadeado só em
   Conversas — o mesmo shot do explorer mostrou Mission Control aberto sem
   pareamento, então quatro cadeados subestimavam o que funciona offline e
   empurravam pro parear desnecessário; no telefone (sem shell) o mapa completo
   com "Depois de parear" segue como estava. O botão primário
   "+ Novo" fica visivelmente acinzentado e carrega o mesmo tooltip de dica do
   rail até o pareamento bem-sucedido (P3-380) — o clique mais natural do
   primeiro boot se explica em vez de morrer em silêncio. Janela
  estreita, cerimônia manual e erros de pareamento guardado continuam na tela
   clássica centrada. Os panes abertos no portão mostram mundos vazios
   esperados — nunca o erro vermelho de mundo pareado (P3-327: Mission Control
   abre na visão forense com a copy de vazio, dashboard/captura ao vivo
   escondidos; a lista de artifacts fica calma). P3-375: a calma da lista de
   artifacts virou comportamento do próprio pane — falha "not connected"
   (primeiro boot, troca de máquina) mostra a copy vazia + aviso discreto de
   sincronização, nunca o erro vermelho "sem pareamento"
- Fila offline da primeira mensagem (P3-360): o card calmo ganha um compositor
  de verdade — "Escreva sua primeira mensagem" — e o texto salvo fica na
  máquina (`ocr_gate_queue`) até o daemon responder, quando vira a primeira
  mensagem da primeira conversa; "nada se perde" deixa de ser promessa e
  vira fluxo exercitável no primeiro boot (Enter salva, confirmação calma no
  próprio painel, fila sobrevive a restart do app). P3-386: o compositor é
  pintado sobre o branco do card com borda de repouso mais firme — lê como
  campo ativo que convida a digitar, não como campo desabilitado. P3-420: o
  botão "Salvar mensagem" habilitado segue o mesmo tratamento de campo ativo
  (superfície pintada + borda firme, hover que acentua) — deixa de parecer um
  fantasma apagado ao lado do "Reconectar agora".
  próprio painel, fila sobrevive a restart do app)
- Soltura de arquivo nunca morre em silêncio (P3-398): arrastar um arquivo do
  Finder sobre o app pinta o realce de soltura em qualquer tela; no portão do
  primeiro boot o drop responde com o mesmo aviso calmo de parear-primeiro
  (copy própria da superfície, com o escape "Parear agora" quando existe), e
  na Home o drop cria a conversa já com o arquivo anexado — o gesto mais
  natural do desktop vira caminho de entrada em vez de nada. Teto de 4
  arquivos por soltura, com linha calma para soltura vazia, excedente ou
  ilegível (veredito puro em lib/dropgate, testado em tabela).
- Escalada com um caminho só de recuperação (P3-385): quando o card calmo
  escala ("Sem resposta do daemon local há 1 min" + "Abrir diagnósticos"), o
  botão laranja "Reconectar agora" para de aparecer empilhado logo abaixo —
  vira um link discreto dentro do bloco de escalada, ao lado do botão de
  diagnósticos (mesmo feedback: spinner, estado "tentando", toast de
  resultado) — para a coluna nunca mostrar dois CTAs da mesma peso
- Escalada que respeita a superfície (P3-394): o detalhe do bloco de escalada
  nunca mais manda ninguém pro terminal — no desktop ele aponta o próprio
  botão "Abrir diagnósticos" do lado (o relatório já é copiado dentro do app)
  e no celular fala em conferir o próprio computador ou parear outro
  dispositivo, escolhido pelo mesmo veredito de shell que o app já calcula
- Jornada de instalação quando falta o servidor do agente (P3-392): no desktop,
  o split "recusado E sem binário" do veredito de upstream resolve para um
  título próprio ("Falta instalar o servidor do agente nesta máquina") e o card
  calmo — e o passo do agente no wizard de boas-vindas — ganha três ações reais:
  copiar o comando oficial da plataforma pro clipboard, abrir as instruções
  oficiais pelo portão de links externos, e "Verificar de novo", que re-sonda e
  sempre termina em estado terminal (o aviso some sozinho quando a instalação
  termina). No celular a copy anterior segue intacta
- Painel Mission guiado com daemon caído (P3-377): no mundo pareado, a falha de
  carga do pane deixa de ser a linha vermelha solta em inglês ("daemon
  unreachable") e vira um card calmo — o que quebrou (o daemon local não
  respondeu), a promessa (os dados recarregam sozinhos quando ele voltar), o
  caminho de volta ("Reconectar agora" no card de status ao lado do painel) e o
  botão "Tentar novamente", que recarrega na hora sem esperar a enquete de 6s. No
  portão, o mundo vazio calmo do P3-327 segue intacto
- Menu Go no portão sem beco circular (P3-362): os itens de painel abrem os
  mesmos panes offline que o rail já abre (Mission Control, Artifacts, Browser,
  Ajustes) em vez de piscar um aviso de pareamento — que era circular no
  primeiro boot, pois o QR nasce do daemon que está caído; onde o painel ainda
  não tem alvo (Conversas, nova conversa, paleta, Arquivos), o toast passa a
  nomear o que foi pedido ("Pareie com sua máquina primeiro para abrir
  Artifacts.") em vez de uma frase genérica igual pra tudo
- Marca do produto com escala tipográfica própria (P3-336): o h1 "OpenCode
  Remote" das telas de primeiro contato (boas-vindas, pareamento, jornada
  degradada) usa a classe compartilhada `.brand-wordmark` — serifado no passo
  display da escala de tokens (`--font-size-xl`) — em vez de estilo inline a
  1rem (tamanho de corpo)
- Títulos de pane na escala tipográfica (P3-384): todo header de pane
  (Artifacts, Browser, Files, Mission Control, Ajustes, Send to agent,
  scanner de QR) usa a classe compartilhada `.pane-title` — passo md dos
  tokens, peso 600, ellipsis em título longo — sem override inline de
  `fontSize`, então os headers não driftam mais entre si
- Headers de pane sem seta na frente no desktop (P3-419): no shell de duas
  colunas o rail é o navegador, então em Artifacts, Browser e Mission
  Control o título passa a liderar o header — o "←" pinta depois do título
  (order no bloco desktop-only, ≥1024px), e continua clicável: no portão o
  slot Conversas do rail fica desabilitado e a seta do próprio pane é o
  caminho de volta pro hero. Em janelas estreitas (<1024px, sem rail) e no
  celular a seta volta a liderar, porque o pane é a tela inteira
- Glifo da marca em todas as telas de primeiro contato (P3-373): o glifo de
  destaque (`.welcome-mark`) abre o header de marca centrado do wizard de
  boas-vindas, do pareamento e da jornada degradada — as três primeiras telas
  da jornada compartilham a mesma linguagem de marca, em vez de o glifo
  aparecer só no wizard. Desde o P3-383 ele é um marco display de verdade:
  ~2rem com line-height travado e respiro na escala de espaçamento abaixo,
  em vez de texto do tamanho do corpo frouxo sobre o wordmark serifado
- Progresso do wizard em três pontos silenciosos (P3-421): a legenda caps
  "PASSO 1 DE 3" deu lugar a três pontos sob o wordmark serifado — o passo
  ativo é uma pílula accent, passos feitos ficam na linha forte e futuros na
  linha de repouso, tudo da escada de tokens com assentamento de 150ms que
  morre em `prefers-reduced-motion`; a copy "Passo {n} de 3" segue viva como
  rótulo acessível do grupo, então o bloco de marca continua
  tipografia-primeiro sem captions cinzas
- Pane do navegador no dicionário (P3-382): o header reusa o rótulo do rail
  verbatim ("Navegador" em pt-BR, via `navBrowser`), e todo o chrome — botão
  Ir, estados carregando/vazio, labels de acessibilidade e copy de erro —
  sai do dicionário EN/pt-BR, inclusive no fallback de screenshot; o pane é
  visto no portão do primeiro boot, então um usuário pt-BR nunca mais lê
  "Browser / Go / Loading…" em cima de um rail que diz "Navegador"
- Mission Control sem erro cru (P3-381): no mundo pareado a linha de erro
  pintava o throw interno verbatim ("daemon unreachable", "HTTP 502") em
  vermelho — só o celular tinha copy traduzida; agora o erro passa pelo
  humanizador compartilhado e degrada para a mesma frase calma de falha de
  carregamento ("Não deu pra ler os registros da frota — a máquina não
  respondeu"), nunca um literal em inglês
- Painel de artifact com animação de entrada/saída e backdrop
- Gauge de contexto e recap (P1-079) no rodapé do chat, discretos
- Rotinas agendadas visíveis ("Programado"), com histórico de execução por
  rotina já renderizado na tela de ajustes (P2-318: linha colapsável calma por
  rotina, mais recente primeiro, com estado vazio falado)
- Cmd+K: switcher de sessões com preview e teclas ←/→
- Câmera-pergunta "Olho" (P3-402): botão de câmera no composer abre um
  viewfinder ao vivo em sheet — o shutter prepara o frame localmente (canvas →
  JPEG em memória, sem upload), o usuário digita a pergunta e envia; só no
  envio cada foto preparada é reduzida (≤1568px) e sobe pelo mesmo pipeline
  de anexo das imagens de arquivo, com foto e texto numa mensagem só, e o
  sheet permanece aberto pra pergunta de follow-up sem reabrir a câmera.
  Nada de streaming: o frame só sai do dispositivo quando o botão de envio é
  pressionado ("a foto só sai quando você envia", na própria UI) — abandonar
  o sheet não transmite nada. A
  máquina de estados da câmera reusa os padrões provados do scanner de QR
  (facingMode environment, retry de abort do iOS, watchdog de feed morto) e,
  no shell desktop, a mesma ponte de veredito de permissão com atalho pro
  painel do sistema; modelo sem visão degrada em card de aviso sugerindo
  troca de modelo. O rascunho do composer coexiste com o sheet: pergunta
  digitada nunca o apaga; enviar sem digitar faz dele a própria mensagem,
  com aviso visível no sheet

## Regra de ouro
Cada task de UI fecha com screenshot desktop-flow provando o critério visual.
