# frozen_string_literal: true

# Homebrew formula — the release pipeline keeps it installable. Bumping tags
# is automatic: on every v* tag, .github/workflows/release.yml publishes the
# tarball asset and rewrites the url/version/sha256 below from the actual
# artifact (no manual shasum step).
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
