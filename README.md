# OpenCode Remote

Controle remoto seguro do [opencode](https://opencode.ai) a partir de qualquer
lugar, via PWA. **Sua máquina, seu código, suas chaves** — nada sai do seu
hardware; o relay é um tubo cego que não consegue ler o tráfego.

```
[PWA (celular)] ⇄ [Relay] ⇄ [Daemon] ⇄ [opencode serve]
   passkey+QR      cego       E2E          localhost
```

## Arquitetura

- **`packages/protocol`** — tipos do wire protocol + criptografia E2E v2
  (ECDH P-256 + HKDF-SHA256 + AES-256-GCM via WebCrypto, replay protection no
  AAD). O pairing é a âncora de confiança: a chave pública do daemon vem no QR
  code.
- **`apps/relay`** — roteador WebSocket *burro*: encaminha frames cifrados por
  sala. Não lê, não autentica, não armazena. Self-hostable em um VPS de $5 ou
  dentro da rede da empresa.
- **`apps/daemon`** — roda ao lado do `opencode serve`. Gera identidade
  persistente (`~/.opencode-remote/daemon.json`), mostra QR de pairing, faz o
  handshake E2E e tunela HTTP/SSE do opencode.
- **`apps/web`** — PWA (React + Vite): pairing, lista de sessões, chat com
  streaming e botões de aprovação de permissões.

## Rodando (dev)

```bash
npm install

# terminal 1 — relay
npm run dev:relay            # ws://127.0.0.1:8787

# terminal 2 — daemon (com opencode rodando em 127.0.0.1:4096)
npm run dev:daemon           # imprime o QR/código de pairing

# terminal 3 — PWA
npm run dev:web              # http://localhost:5173
```

Abra a PWA, cole o código `opencode-remote://pair?...` impresso pelo daemon e
pronto: sessões, chat e aprovações do seu opencode no celular.

### Variáveis de ambiente (daemon)

| Variável | Default | Descrição |
|---|---|---|
| `RELAY_URL` | `ws://127.0.0.1:8787` | relay a conectar |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | server local do opencode |
| `OPENCODE_SERVER_PASSWORD` | — | basic auth do opencode, se configurado |
| `OCR_MACHINE_NAME` | `my-machine` | nome exibido no pairing |
| `OCR_VAPID_SUBJECT` | `mailto:…` | contato enviado ao push service |
| `OCR_METRICS_PORT` | — | se setado, expõe métricas em 127.0.0.1 |
| `OCR_UPLOAD_MAX_MB` | `20` | limite por arquivo persistido (kind=file) |

### Web Push (aprovações como notificação)

Depois de parear, toque em **Enable push** na PWA. As chaves de assinatura
(VAPID) ficam em `~/.opencode-remote/daemon.json` e a URI de pairing já carrega
a chave pública. O daemon envia push quando detecta:

- eventos de **permissão** → "Approve needed: opencode wants to …"
- `session.idle` → agente terminou

iOS/iPadOS: push em PWA exige app instalado na home screen (iOS 16.4+).

### Deploy com Docker (recomendado pro relay)

```bash
# relay público com TLS automático (Caddy + Let's Encrypt):
#   1. edite docker/Caddyfile com seu domínio
#   2. dns do domínio apontando pro servidor
docker compose --profile tls up -d relay caddy

# homelab: relay + daemon na mesma máquina, opencode no host
RELAY_URL=ws://relay:8787 docker compose --profile daemon up -d relay daemon

# só o relay, rede confiável:
docker compose up -d relay
```

Imagens: `Dockerfile.relay` e `Dockerfile.daemon` (multi-stage, node:22-alpine).
O daemon em container monta `~/.opencode-remote` como volume — a identidade
(pairing) sobrevive a recriações — e fala com o opencode do host via
`host.docker.internal`. TLS em `wss://` é obrigatório antes de expor o relay
publicamente; o Caddy cuida do certificado sozinho.

### Rodando como serviço (macOS, launchd)

Instala relay + daemon + timer de rotação de log como serviços nativos com
**KeepAlive** (auto-start no boot, restart em crash, sobrevive a logout):

```bash
./deploy/install.sh
# ou com relay remoto:
RELAY_URL=wss://seu-relay:8788 ./deploy/install.sh
```

O que o installer faz (idempotente):

- gera `~/Library/LaunchAgents/com.ocr.{relay,daemon,logrotate}.plist` com os
  paths reais da máquina (node, tsx, certs) e `KeepAlive` + `RunAtLoad`
- derruba execuções ad-hoc (`pkill tsx`) e re-bootstrapa via `launchctl`
- logs em `~/.opencode-remote/logs/{relay,daemon}.log`

**Rotação de log:** `com.ocr.logrotate` roda todo dia 03:07
(`deploy/rotate-logs.sh`) — archive+truncate acima de 10MB, mantém os 5
arquivamentos mais recentes. Rode manualmente com `./deploy/rotate-logs.sh`.

**Métricas** (bind 127.0.0.1, JSON ou `?format=prom`):

```bash
curl 127.0.0.1:8790/metrics   # relay: conexões, frames/bytes roteados, rejects
curl 127.0.0.1:8791/metrics   # daemon: handshakes, ops, erros, uploads, whisper
```

Contadores úteis no daemon: `ocr_ops_total`, `ocr_ops_errors_total`,
`ocr_handshakes_total`, `ocr_reconnects_asked_total`, `ocr_relay_connected`,
`ocr_sessions_active`, `ocr_transcriptions_total`, `ocr_uploads_completed_total`,
`ocr_sealed_bytes_total`. Portas configuráveis via `RELAY_METRICS_PORT` /
`OCR_METRICS_PORT`.

**Verificação de sanidade pós-install:**

```bash
launchctl print gui/$(id -u)/com.ocr.daemon | grep state   # state = running
launchctl kickstart -k gui/$(id -u)/com.ocr.daemon         # mata → ressoa
```

Para Linux (systemd), use `apps/daemon/systemd/opencode-remote.service` como
referência.

## Roadmap

**MVP (este scaffold)**
- [x] Pairing via código + handshake E2E mutuamente autenticado
- [x] Túnel HTTP de toda a API do opencode (sessões, mensagens, diffs)
- [x] Streaming de eventos (SSE → frames cifrados)
- [x] Aprovação de permissões pelo celular
- [x] Web Push de aprovações/conclusões (VAPID, RFC 8291 via `web-push`)
- [x] Modo serviço launchd/systemd para máquinas 24/7
- [x] Deploy Docker (relay + daemon + Caddy TLS) — testado E2E em containers
- [x] Pairing por QR em qualquer plataforma — scanner in-app com
      getUserMedia + jsQR (BarcodeDetector não existe no iPhone)

**v1**
- [x] Identidade não-extraível (WebCrypto ECDH P-256 + IndexedDB) + gate
      biométrico WebAuthn + replay protection no AAD (protocolo v2)
- [x] Allowlist/revogação de clientes + multi-device no daemon
- [x] CI (GitHub Actions): typecheck + build + smoke E2E + integração real
- [ ] Rotinas e triggers no daemon (cron + webhooks)
- [ ] Skills/commands do opencode como botões de 1-tap
- [ ] Multi-máquina no mesmo app
- [ ] Wake hints + bufferização de eventos quando a máquina dorme

**Enterprise**
- [ ] Relay self-hosted (Docker) + audit log imutável
- [ ] RBAC por máquina/projeto (viewer / approver / operator / admin)
- [ ] SSO + SCIM (Okta, Entra) e offboarding instantâneo
- [ ] Policy enforcement (ex.: produção sempre exige aprovação humana)

## Modelo de segurança (protocolo v2)

- **Identidade não-extraível**: a chave privada do cliente é ECDH P-256
  WebCrypto gerada com `extractable: false` e vivendo só em IndexedDB. XSS
  consegue *usar* a chave enquanto a página vive, mas nunca *exfiltrar*.
- **Gate biométrico**: credencial WebAuthn com `userVerification: required`
  (Face ID / Touch ID / PIN) é exigida antes de usar a chave. Opcional em
  browsers sem platform authenticator; automática em iPhones.
- **Handshake mutuamente autenticado**: o hello do cliente é selado com a
  própria chave de sessão derivada (ECDH estático + HKDF-SHA256, salt do
  handshake). Só quem tem a chave privada do daemon (âncora: o QR code) abre.
- **AES-256-GCM em tudo** que passa no relay, com **seq no AAD**: o relay não
  pode reordenar, replayar ou recombinar frames — o receptor rejeita
  `seq <= último visto`.
- **Allowlist de clientes**: o primeiro pareamento (via QR na sua máquina) é
  persistido em `daemon.json`; a partir daí só clientes na allowlist conectam.
  Multi-device suportado — todos os clientes pareados recebem eventos.
- **Estado com permissão 0600**: `daemon.json` (chaves + allowlist) é
  restringido no boot e a cada escrita.
- **Relay cego e com limites**: reencaminha ciphertext opaco por sala, com
  teto de frame (1 MB), sockets por sala e conexões totais.

Trust anchor = QR code lido na máquina do usuário. Sem servidores de
identidade no caminho.

### Gerenciando clientes pareados

```bash
npm run manage --workspace apps/daemon -- list          # lista pubkeys pareadas
npm run manage --workspace apps/daemon -- revoke <prefix>  # revoga um cliente
npm run manage --workspace apps/daemon -- revoke-all    # recomeça (QR pareia de novo)
```
