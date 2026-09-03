# frozen_string_literal: true

# Homebrew formula template — bump the tag on each release.
# Local test: brew install --build-from-source Formula/opencode-remote.rb
# P2-098: url points at the release asset produced by .github/workflows/
# release.yml (git archive with the opencode-remote-<tag>/ prefix). Regenerate
# the checksum on each release:
#   git archive --format=tar.gz --prefix="opencode-remote-<tag>/" -o \
#     opencode-remote-<tag>.tar.gz <tag>
#   shasum -a 256 opencode-remote-<tag>.tar.gz
class OpencodeRemote < Formula
  desc "Control opencode from your phone — E2E encrypted, blind relay"
  homepage "https://github.com/caiovicentino/opencode-remote"
  url "https://github.com/caiovicentino/opencode-remote/releases/download/v0.2.0/opencode-remote-v0.2.0.tar.gz"
  version "0.2.0"
  sha256 "1b21b1e92bfbe98461a4c99f0dffa2f8feaa703813370f9de322fda6fb5cb37d"
  # matches the SPDX license in package.json (P2-098: was "MIT")
  license "AGPL-3.0-only"
  depends_on "node@22"

  def install
    (libexec/"app").install Dir["*"]
    chdir(libexec/"app") { system "npm", "ci", "--omit=dev" }
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
    EOS
  end
end
