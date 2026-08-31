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
