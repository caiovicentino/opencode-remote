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

- **Chat completo** com streaming, markdown, imagens e histórico de ferramentas
- **AutoMode** — o agente roda solto; toda aprovação automática vira auditoria
  (e notificação, se você quiser)
- **Perguntas interativas** — o modelo pergunta, você toca na opção
- **Rewind** — volte a conversa *e o código* pra qualquer ponto, num toque
- **Voz** — segure e fale, transcrição local com whisper, sem nuvem
- **Arquivos** — envie do celular, dê preview de tudo, exporte a conversa
  em markdown
- **Handoff** — continue a sessão exata no Mac (botão 💻)
- **Painel ao vivo** — estado de cada sessão: trabalhando, esperando aprovação,
  fez pergunta, pronto, erro
- **Rotinas** — cron de verdade: diário, dias da semana ou loop por intervalo
- **Seguro por construção** — gate com passkey (WebAuthn), ECDH P-256 +
  AES-256-GCM, anti-replay, allowlist de dispositivos, audit log, biometria
- **BYOM** — opencode suporta qualquer provider; escolha o modelo por sessão
- **API + SDK** — dirija sessões por código (`packages/sdk`)

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
