# OpenCode Remote

[🇧🇷 Português](README.pt-BR.md) | 🇬🇧 [English](README.md)

Controle o agente [opencode](https://opencode.ai) da sua máquina pelo celular,
de qualquer lugar. **Sua máquina, seu código, suas chaves** — nada sai do seu
hardware; o relay é um tubo cego que não consegue ler o tráfego.

```
[PWA (celular)] ⇄ [Relay] ⇄ [Daemon] ⇄ [opencode serve]
   passkey+QR      cego       E2E          localhost
```

<p align="center">
  <a href="assets/demo.mp4"><img src="assets/demo-poster.jpg" width="300" alt="Demo do OpenCode Remote — clique pra assistir"></a>
</p>

## Por que existe

Claude Code, Codex e companhia rodam o agente no cloud *deles*. O OpenCode
Remote roda na **sua** máquina — filesystem completo, terminal de verdade,
suas chaves, qualquer modelo — e entrega um cockpit no celular com
criptografia ponta a ponta. O relay nunca vê plaintext: mesmo um relay
hospedado continua privado. Esse é o produto: **poder local, controle
remoto, zero confiança**.

## O que você ganha

- **Chat completo** com streaming, markdown, imagens e histórico de ferramentas;
  o header do chat mostra o título da conversa (o genérico "session" enquanto
  a sessão ainda não tem título)
- **AutoMode** — o agente roda solto; toda aprovação automática vira auditoria
  (e notificação, se você quiser)
- **Preview de aprovação** — o card de permissão mostra as primeiras linhas
  do comando/patch pedido (direto do evento de permissão) antes de aprovar
  ou negar, pra você sempre saber o que está liberando
- **Perguntas interativas** — o modelo pergunta, você toca na opção
- **Rewind** — volte a conversa *e o código* pra qualquer ponto, num toque
- **Voz** — segure e fale, transcrição local com whisper, sem nuvem
- **Arquivos** — envie do celular, dê preview de tudo, exporte a conversa
  em markdown; todo card de arquivo tem um botão ⧉ que copia o caminho
  completo do arquivo (Clipboard API com fallback execCommand)
- **Handoff** — continue a sessão exata no Mac (botão 💻)
- **Painel ao vivo** — estado de cada sessão: trabalhando, esperando aprovação,
  fez pergunta, pronto, erro; cards mostram o tempo relativo da última
  atividade (`5m`, `2h`, `3d`); sessões ficam ordenadas da mais recente
  para a mais antiga
- **Filtro de sessões** — chips acima da busca (Todas / Com badge / Sem badge)
  filtram o painel pelas conversas com ou sem badge de não-lidas
- **Rotinas** — cron de verdade: diário, dias da semana ou loop por intervalo
- **Seguro por construção** — gate com passkey (WebAuthn), ECDH P-256 +
  AES-256-GCM, anti-replay, allowlist de dispositivos, audit log, biometria
- **BYOM** — opencode suporta qualquer provider; escolha o modelo por sessão
- **API + SDK** — dirija sessões por código (`packages/sdk`)
- **App desktop (inicial)** — shell Electron com a mesma UI, com tray e menu nativo

## Quick Start (Mac → iPhone, ~5 min)

```bash
git clone https://github.com/caiovicentino/opencode-remote.git
cd opencode-remote && npm ci
opencode serve --port 4096    # se ainda não estiver rodando
node cli.mjs setup --relay=wss://seu-host.ts.net:8788
```

O wizard confere node/opencode/whisper/ffmpeg, instala os serviços launchd
com KeepAlive e imprime o QR de pareamento. Aponte a câmera do PWA e pronto.

## CLI

```bash
node cli.mjs doctor    # diagnóstico completo
node cli.mjs qr        # reimprime o QR de pareamento
node cli.mjs status    # estado dos serviços + devices
node cli.mjs start     # restart dos serviços (relay + daemon)
node cli.mjs update    # puxa, reinstala deps e reinicia num comando
node cli.mjs token     # imprime o token da API HTTP local
```

## API HTTP & SDK

```js
import { createClient } from "@ocr/sdk";

const ocr = createClient({ token: process.env.OCR_TOKEN });
const { id } = await ocr.createSession();
const reply = await ocr.sendAndWait(id, "explique o módulo de autenticação");
```

Veja [docs/api.md](docs/api.md).

## Arquitetura & segurança

- [docs/architecture.md](docs/architecture.md)
- [docs/security.md](docs/security.md)
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [docs/capacitor.md](docs/capacitor.md) — shell nativo iOS

## App desktop (inicial)

O primeiro estágio da [visão desktop](docs/VISION.md): um shell Electron
([`apps/desktop`](apps/desktop)) que abre o cockpit numa janela nativa, com
ícone de tray, menus nativos e renderer sandboxed — sem terminal, sem
Tailscale. Ele carrega o mesmo build de `@ocr/web` usado no telefone.

```bash
npm run build --workspace @ocr/web       # gere a UI uma vez
npm run build --workspace @ocr/desktop   # compila o shell (main process em TypeScript)
npm start  --workspace @ocr/desktop      # abre a janela
```

Durante o desenvolvimento do web, aponte o shell pro dev server do Vite:
`OCR_WEB_URL=http://localhost:5173 npm start --workspace @ocr/desktop`.
Empacotamento (DMG, notarização) vem com a etapa de distribuição.

O shell desktop sobe o daemon como **sidecar**: ao abrir, ele faz spawn do
daemon (via o `tsx` do workspace; `OCR_DAEMON_ENTRY` aponta pra entrada
compilada nos builds empacotados), espera `GET 127.0.0.1:8792/api/health`
responder **com um 200 autenticado** antes de mostrar a UI e encerra o filho no
quit. Se já existe um daemon saudável nessa porta (instalação launchd/CLI), ele
é reaproveitado — nunca duplicado. Para trocar a porta: `OCR_DAEMON_METRICS_PORT`
(com fallback pro `OCR_METRICS_PORT`); o filho faz bind exatamente na porta que
o shell verifica.

## Roadmap

Próximos: relay hospedado
opcional, wizard de onboarding, compartilhamento de skills, push nativo iOS.

## Licença

Open core, escolhido pra comunidade ficar com o cliente e o negócio com o
serviço:

| Parte | Licença | Por quê |
|---|---|---|
| `apps/relay` (o lado hospedado) | **AGPL-3.0-only** | quem hospedar pra terceiros precisa publicar o fonte — sem SaaS parasita |
| `apps/daemon`, `apps/web`, `cli.mjs`, `tools/` | **AGPL-3.0-only** | o produto segue aberto e self-hosted, para sempre |
| `packages/sdk`, `packages/protocol` | **MIT** | construa integrações em cima, sem amarras |

Deploy próprio, fork e uso interno seguem livres — a AGPL só mordem se você
oferecer o software como serviço pra terceiros e esconder o fonte.

---

🇬🇧 This project also speaks English: [README.md](README.md)
