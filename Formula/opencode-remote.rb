# frozen_string_literal: true

# Homebrew formula. On every v* tag, .github/workflows/release.yml rewrites
# the url/version/sha256 below from the published tarball and attaches the
# result to the release as `opencode-remote.rb` (eval-16: the pipeline never
# pushes main — land that file here through a PR after each release).
#
# Homebrew only installs formulae from a tap (installing from a file path is
# refused unless HOMEBREW_DEVELOPER is set), so users install with:
#   brew tap caiovicentino/opencode-remote https://github.com/caiovicentino/opencode-remote
#   brew install caiovicentino/opencode-remote/opencode-remote
#
# Until the FIRST release exists, the sha256 placeholder below is intentionally
# not installable — there is no published artifact to checksum yet.
class OpencodeRemote < Formula
  desc "Control opencode from your phone — E2E encrypted, blind relay"
  homepage "https://github.com/caiovicentino/opencode-remote"
  url "https://github.com/caiovicentino/opencode-remote/releases/download/v0.2.0/opencode-remote-v0.2.0.tar.gz"
  version "0.2.0"
  # P2-098 (round 3): placeholder until release.yml pins the real checksum of
  # the published asset at tag time — never checksum a tarball that does not
  # exist yet.
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  # matches the SPDX license in package.json (P2-098: was "MIT")
  license "AGPL-3.0-only"
  depends_on "node@22"

  def install
    # eval-16: the phone's web app (apps/web/dist, what the pwa service
    # serves) is built, not shipped in the source tarball — `npm ci
    # --omit=dev` alone left it missing and every phone request got a 404.
    # Build with the dev toolchain, then drop the dev dependencies. The
    # desktop workspace's Electron binary is not needed for this build.
    ENV.prepend_path "PATH", formula_opt_bin("node@22")
    ENV["ELECTRON_SKIP_BINARY_DOWNLOAD"] = "1"
    system "npm", "ci", "--no-audit", "--no-fund"
    system "npm", "run", "build", "--workspace", "@ocr/web"
    system "npm", "prune", "--omit=dev", "--no-audit", "--no-fund"
    (libexec/"app").install Dir["*"]
    node_bin = formula_opt_bin("node@22")
    (bin/"opencode-remote").write <<~EOS
      #!/bin/bash
      export PATH="#{node_bin}":$PATH
      exec #{node_bin} #{libexec}/app/cli.mjs "$@"
    EOS
  end

  def caveats
    <<~EOS
      Run the setup wizard (installs and keeps alive launchd services):
        opencode-remote setup --relay=wss://<lan-ip>:8788

      The daemon controls opencode on this machine — pair phones only
      via the QR code it prints. No tailnet needed: on the same Wi-Fi,
      point the relay at this machine's LAN IP (see README, "Install as
      a third party").

      The launchd services point at this versioned install: after
      `brew upgrade opencode-remote`, run the same setup command again.
    EOS
  end
end
