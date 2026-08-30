# Homebrew formula template — bump the tag on each release.
# Local test: brew install --build-from-source Formula/opencode-remote.rb
class OpencodeRemote < Formula
  desc "Control opencode from your phone — E2E encrypted, blind relay"
  homepage "https://github.com/caiovicentino/opencode-remote"
  url "https://github.com/caiovicentino/opencode-remote/archive/refs/tags/v0.2.0.tar.gz"
  version "0.2.0"
  license "MIT"
  depends_on "node@22"

  def install
    (libexec/"app").install Dir["*"]
    chdir(libexec/"app") { system "npm", "ci", "--omit=dev" }
    node_bin = Formula["node@22"].opt_bin/"node"
    (bin/"opencode-remote").write <<~EOS
      #!/bin/bash
      export PATH="#{node_bin}":$PATH
      exec #{node_bin} #{libexec}/app/cli.mjs "$@"
    EOS
  end

  def caveats
    <<~EOS
      Run the setup wizard (installs and keeps alive launchd services):
        opencode-remote setup --relay=wss://your-host.ts.net:8788

      The daemon controls opencode on this machine — pair phones only
      via the QR code it prints.
    EOS
  end
end
