# VISION — North Star

## Missão final

**Um app desktop (Mac + Windows) como o Claude Desktop, com nosso harness dentro:**
qualquer pessoa leiga instala, escaneia o QR com o telefone e passa a controlar
o opencode do próprio Mac — chat E2E, voz, arquivos, approvals, rotinas — de qualquer
lugar, sem terminal, sem TLS, sem tailscale.

## Estágios

1. ✅ **Harness**: protocolo v2 E2E, relay cego, daemon, PWA mobile (feito, em produção)
2. 🔄 **Workflow autônomo**: Pilot 24/7 com review chain, deploy staged, red team (esta infra)
3. 🖥️ **Desktop app**: shell Electron/JS + daemon sidecar + pairing QR + tray + auto-update
4. **Relay hospedado**: relay opérico multi-tenant pra eliminar TLS próprio do usuário
5. **Distribuição**: DMG notarizado + installer Windows assinado

## Regras do Pilot alinhadas à missão

- Toda task do STRATEGIST deve, direta ou indiretamente, aproximar o produto dos estágios 3-5
- Tasks de manutenção/UX mobile são bem-vindas, mas no máximo 1 a cada 3 (prioridade pro desktop)
- Nada de dependências pesadas sem justificativa no commit (bundle size importa pra distribuição)


## Stage 3.1 — Local-first desktop mode (31/08)

The desktop app runs ON the machine that hosts the daemon. Pairing (QR, relay,
ECDH handshake) is phone-oriented friction — a desktop user is already home.

Design: the desktop is a first-class local client.
1. The daemon already prints its `opencode-remote://pair?v=2&...` URL at boot.
   The desktop sidecar captures that line from the child's stdout.
2. `main.ts` keeps it; `preload.ts` exposes it via contextBridge IPC.
3. `App.tsx`: when running inside the desktop shell (bridge present) and no
   stored pairing exists, auto-connect using the captured pair URL — the same
   code path as paste-pairing. No relay changes, no crypto changes.
4. The QR/paste screen is never shown on desktop (manual pair stays in
   Settings as a fallback). User-visible change: zero-friction first run.
