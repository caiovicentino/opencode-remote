# Releasing — runbook do dono

O pipeline (`.github/workflows/release.yml`) roda a cada push de tag `v*` e
termina com um **release rascunho (draft) completo e verificado**. Nada fica
público sem um passo humano, a menos que a variável de repositório
`RELEASE_AUTO_PUBLISH` seja exatamente `true`. O runbook de suspender/avançar
a liberação gradual de um release já publicado continua em `docs/PILOT.md`
(seção "Runbook de release").

## O que um run de tag produz

1. `release` — preflight (tag = versão dos dois `package.json`), tarball do
   código-fonte, notas geradas pela API e **limitadas** abaixo do teto de
   125.000 caracteres do GitHub (`scripts/release-body.ts`; o primeiro release
   geraria ~204 mil), e o draft. Idempotente por tag: um draft existente é
   reaproveitado; um release já publicado é recusado.
2. `desktop-dmg` (macos-14) — DMG + zip para arm64 e x64, `latest-mac.yml`,
   feeds Squirrel por arquitetura, e os smokes: bundle, tamanho, Gatekeeper
   no app e em cada DMG, boot do app empacotado, sidecar do daemon e montagem
   do DMG.
3. `desktop-win` (windows-latest) — instalador NSIS + `latest.yml`, smokes de
   bundle, boot, sidecar e instalação silenciosa.
4. `release-verify` / `release-feeds` — conjunto completo de assets, feeds
   apontando para os arquivos certos, sha512 conferidos contra os bytes.
5. `release-publish` — `checksums.txt`, manifestos winget, cask e fórmula do
   Homebrew fixados, guia de download no corpo, veredito de completude. Sem
   `RELEASE_AUTO_PUBLISH=true` o draft **fica draft** e o resumo do job traz o
   comando de publicação.
6. `relay-image` — build + smoke da imagem do relay; push no GHCR só com a
   variável `PUBLISH_RELAY_IMAGE=true`.

## Antes do primeiro release: assinatura (recomendado)

Sem secrets o Mac sai **ad-hoc** (o usuário libera em Ajustes do Sistema →
Privacidade e Segurança → Abrir Mesmo Assim) e o **update automático do Mac
não funciona** — o Squirrel.Mac só aplica update assinado pela mesma
identidade, então o app ad-hoc cai no fluxo manual (página de releases).
Trocar de ad-hoc para Developer ID depois também quebra o update entre as
duas versões. Por isso: configure a assinatura **antes** de publicar o
primeiro release.

Com uma identidade "Developer ID Application" no keychain (quem faz build
local assinado já tem uma — `security find-identity -v -p codesigning`), o CI
precisa só dos secrets:

```bash
# 1. Keychain Access → Meus Certificados → "Developer ID Application: …" →
#    botão direito → Exportar → devid.p12 (com senha). Depois:
base64 -i devid.p12 | gh secret set CSC_LINK --repo caiovicentino/opencode-remote
gh secret set CSC_KEY_PASSWORD --repo caiovicentino/opencode-remote      # a senha do .p12
rm devid.p12

# 2. Notarização: senha de app em appleid.apple.com → Iniciar Sessão e
#    Segurança → Senhas de App. O Team ID aparece entre parênteses no nome
#    da identidade (security find-identity -v -p codesigning).
gh secret set APPLE_ID --repo caiovicentino/opencode-remote
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo caiovicentino/opencode-remote
gh secret set APPLE_TEAM_ID --repo caiovicentino/opencode-remote
```

O preflight (`apps/desktop/scripts/signing-profile.mjs`) passa a escolher
`mode=developer-id notarize=true` e o job de Gatekeeper exige o ticket
grampeado.

**Windows:** desde junho de 2023 certificados de assinatura de código novos
só são emitidos com a chave em hardware/HSM, então não existe mais um `.pfx`
exportável para `WIN_CSC_LINK`. O caminho atual é assinatura em nuvem (Azure
Artifact Signing / Trusted Signing, que o electron-builder 26 suporta via
`win.azureSignOptions`) — ainda não ligado no pipeline. Sem assinatura o
instalador sai sem assinatura e o SmartScreen pede "Mais informações →
Executar assim mesmo" uma vez.

## Cortar um release

```bash
git fetch origin
# versão da tag = package.json = apps/desktop/package.json (o preflight confere)
node -p "require('./package.json').version"
git tag -a v0.2.0 -m "v0.2.0" origin/main
git push origin v0.2.0

# acompanhar
gh run list --repo caiovicentino/opencode-remote --workflow release.yml --limit 1
gh run watch --repo caiovicentino/opencode-remote <run-id>
```

## Conferir e publicar o draft

```bash
gh release view v0.2.0 --repo caiovicentino/opencode-remote
gh release download v0.2.0 --repo caiovicentino/opencode-remote --pattern '*-arm64.dmg' --dir ~/Downloads
# instale, abra, pareie um celular

# opcional: começar com uma fração das máquinas (reescreve só os feeds)
node apps/desktop/scripts/rollout.mjs v0.2.0 20

gh release edit v0.2.0 --repo caiovicentino/opencode-remote --draft=false
```

Draft ruim: `gh release delete v0.2.0 --repo caiovicentino/opencode-remote
--yes --cleanup-tag`, corrija em `main` e corte a tag de novo.

## Depois de publicar

- **Homebrew:** o release traz `opencode-remote.rb` (fórmula já fixada no
  tarball publicado). Abra um PR substituindo `Formula/opencode-remote.rb` por
  ele — o pipeline nunca dá push na `main`. O mesmo vale para o
  `opencode-remote-cask.rb`, se quiser oferecer o cask (em `Casks/`).
- **Publicação automática:** depois de um release de ponta a ponta sem
  surpresas, `gh variable set RELEASE_AUTO_PUBLISH --body true --repo
  caiovicentino/opencode-remote` faz os próximos runs publicarem sozinhos.
