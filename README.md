# OpenCode Remote

Controle o [opencode](https://opencode.ai) da sua máquina pelo celular, de
qualquer lugar. **Sua máquina, seu código, suas chaves** — nada sai do seu
hardware; o relay é um tubo cego que não consegue ler o tráfego.

```
[PWA (celular)] ⇄ [Relay] ⇄ [Daemon] ⇄ [opencode serve]
   passkey+QR      cego       E2E          localhost
```

## O que você ganha

- **Chat completo** com streaming e aprovação de permissões por notificação push
- **Voz**: segure o botão de micro e fale — transcrição local (whisper), sem nuvem
- **Fotos e vídeos**: anexos são enviados E2E; vídeos viram keyframes + transcrição
  de áudio, e o arquivo completo fica salvo pro agent usar ffmpeg
- **Recorte de clips**: pipeline local estilo OpusClip (legendas karaoka queimadas)
- **Seguro**: biometria (Face ID), criptografia E2E, allowlist de dispositivos

## Quick Start (Mac → iPhone, 5 min)

```bash
git clone https://github.com/caiovicentino/opencode-remote.git
cd opencode-remote && npm ci
opencode serve --port 4096    # se ainda não estiver rodando
node cli.mjs setup --relay=wss://seu-host.ts.net:8788
```

O wizard confere node/opencode/whisper/ffmpeg, instala os serviços launchd
com KeepAlive e imprime o QR de pareamento.

## CLI

```bash
node cli.mjs doctor   # diagnóstico completo: binários, saúde, serviços, devices
node cli.mjs qr       # reimprime o QR de pareamento
node cli.mjs status   # estado dos serviços launchd + devices pareados
node cli.mjs start    # restart dos serviços (relay + daemon)
```

Com a tag `v0.2.0+` no GitHub, dá pra instalar via Homebrew:

```bash
brew install --build-from-source Formula/opencode-remote.rb
opencode-remote doctor
```

## Docs

[Arquitetura](docs/architecture.md) · [Modelo de segurança](docs/security.md) ·
[Troubleshooting](docs/troubleshooting.md) · [Shell nativo (Capacitor)](docs/capacitor.md)

No iPhone (o script imprime a URL e o QR):

1. Abra a URL no Safari (ex.: `https://seu-mac.tailXXXX.ts.net`)
2. **Share → Add to Home Screen** (obrigatório pra push no iOS 16.4+)
3. Abra pelo ícone → **Scan QR code** → aponte pro QR do terminal
4. Toque em **Enable push**

Pronto: sessões, chat, voz e fotos direto do bolso.

## Pré-requisitos

| Componente | Necessário? | Como instalar |
|---|---|---|
| Node 22+ | sim | `brew install node@22` |
| opencode CLI | sim | `curl -fsSL https://opencode.ai/install \| bash` |
| Tailscale | recomendado (acesso de fora de casa) | `brew install tailscale && tailscale login` |
| whisper-cli | opcional (voz) | `./scripts/setup-whisper.sh` |
| ffmpeg-full | opcional (clips) | `brew install ffmpeg-full` |

`./scripts/setup.sh` verifica tudo e diz o que falta.

## Modos de deploy

**Pessoal (recomendado)** — Mac 24/7 + Tailscale: TLS e DNS automáticos, zero
VPS. É o `./scripts/dev-iphone.sh` do Quick Start. Pra deixar permanente
(sobrevive a reboot/crash): `RELAY_URL=wss://seu-host.ts.net:8788 ./deploy/install.sh`

**Localhost (dev)** — 3 terminais: `npm run dev:relay`, `npm run dev:daemon`,
`npm run dev:web`. Só funciona no mesmo WiFi (o browser bloqueia `ws://`
inseguro de fora).

**VPS público (Docker)** — pra relay exposto à internet com TLS via Caddy:
`docker compose --profile tls up -d relay caddy`. O relay é cego por design —
hospedar em terceiros não quebra o E2E.

## Portas

| Porta | Serviço |
|---|---|
| 4096 | opencode serve (localhost) |
| 5173 | PWA em dev (vite) |
| 8787 | relay (ws) |
| 8788 | relay TLS (lan/mkcert ou wss direto) |
| 8790 / 8792 | métricas do relay / daemon (127.0.0.1, JSON ou `?format=prom`) |

## Problemas comuns

| Sintoma | Causa e fix |
|---|---|
| `client rejected: not in allowlist` | dispositivo não pareado. Escaneie o QR de novo, ou reset com `npm run manage --workspace apps/daemon -- revoke-all` |
| `relay connection lost; retrying` | relay fora do ar ou tailscale caiu — confira o terminal do relay |
| respostas `502` no chat | o `opencode serve` não está rodando na porta 4096 |
| `transcription unavailable` | instale whisper: `./scripts/setup-whisper.sh` |
| push não chega no iPhone | precisa estar instalado via Add to Home Screen (iOS 16.4+) e permissão concedida |
| PWA não abre de fora de casa | falta TLS — use o caminho tailscale do `dev-iphone.sh` |

## Segurança (protocolo v2)

- **Identidade não-extraível**: a chave privada do cliente é ECDH P-256
  WebCrypto `extractable: false` em IndexedDB. XSS consegue *usar* a chave
  enquanto a página vive, mas nunca *exfiltrar*.
- **Gate biométrico**: WebAuthn com `userVerification: required` (Face ID /
  Touch ID / PIN) antes de usar a chave.
- **Handshake mutuamente autenticado** + **AES-256-GCM com seq no AAD**: o
  relay não pode reordenar, replayar ou recombinar frames.
- **Allowlist de clientes**: o primeiro pareamento (QR na sua máquina) cria a
  allowlist em `daemon.json` (0600); multi-device suportado.
- **Relay cego e limitado**: ciphertext opaco por sala, teto de 1MB/frame e
  limite de conexões.

Trust anchor = QR code lido na sua máquina. Sem servidores de identidade.

### Gerenciando clientes pareados

```bash
npm run manage --workspace apps/daemon -- list            # lista pareados
npm run manage --workspace apps/daemon -- revoke <prefix> # revoga um
npm run manage --workspace apps/daemon -- revoke-all      # recomeça
```

Também dá pra revogar direto do celular: ⚙ Settings → Paired devices.

## Roadmap

- [x] Rotinas agendadas com retry, status de erro e push de falha
- [x] Skills 1-tap (prompts salvos, chips no composer, edição no Settings)
- [x] Multi-máquina no mesmo app (switcher no header, pairing por QR)
- [x] Diff preview nas aprovações de permissão
- [x] Preview de arquivos no app (imagem, vídeo, áudio, texto, HTML, PDF)
- [x] Heartbeat + auto-reconnect (socket zombie do iOS)
- [x] Respostas gigantes em chunks (túnel sem limite prático)
- [ ] Wake hints + bufferização de eventos quando a máquina dorme
- [ ] Terminal PTY real (hoje o feed de tools é read-only)
- [ ] Approve/Deny dentro da notificação (hoje a action abre a sessão)
