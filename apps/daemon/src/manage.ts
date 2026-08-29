/**
 * Manage paired clients: list and revoke.
 *
 *   npx tsx apps/daemon/src/manage.ts list
 *   npx tsx apps/daemon/src/manage.ts revoke <pub-prefix>
 *   npx tsx apps/daemon/src/manage.ts revoke-all
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface PairedClient {
  pub: string;
  label?: string;
  addedAt: string;
}

interface IdentityFile {
  room?: string;
  ecdhPub?: string;
  clients?: PairedClient[];
}

const file = join(homedir(), ".opencode-remote", "daemon.json");
if (!existsSync(file)) {
  console.error("daemon.json not found — run the daemon once first");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, "utf8")) as IdentityFile;
const clients = raw.clients ?? [];
const [, , cmd, arg] = process.argv;

function save() {
  writeFileSync(file, JSON.stringify(raw, null, 2));
  chmodSync(file, 0o600);
}

switch (cmd) {
  case undefined:
  case "list": {
    if (clients.length === 0) {
      console.log("no clients paired yet");
      break;
    }
    for (const c of clients) {
      console.log(`${c.pub.slice(0, 20)}…  added=${c.addedAt}${c.label ? `  label=${c.label}` : ""}`);
    }
    break;
  }
  case "revoke": {
    if (!arg) {
      console.error("usage: manage.ts revoke <pub-prefix>");
      process.exit(1);
    }
    const before = clients.length;
    raw.clients = clients.filter((c) => !c.pub.startsWith(arg));
    save();
    console.log(`revoked ${before - raw.clients.length} client(s); ${raw.clients.length} remaining`);
    break;
  }
  case "revoke-all": {
    raw.clients = [];
    save();
    console.log("all clients revoked; next pairing (QR) bootstraps again");
    break;
  }
  default:
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
}
