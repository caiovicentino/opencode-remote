/**
 * P2-252: tray status tests (apps/desktop/src/traystatus.ts) — the portable
 * twin of the unit.test.ts block. Pure node: no Electron, no sockets, no
 * chmod, no spawn; the only fs use is reading the real traystatus.ts and
 * main.ts sources for the purity/wiring assertions, via URLs relative to
 * this file (Windows-safe).
 * Run: npx tsx scripts/traystatus.test.ts
 */
import { readFileSync } from "node:fs";
import { TRAY_TIP_MAX_CHARS, trayStatus } from "../apps/desktop/src/traystatus";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const json = (v: unknown) => JSON.stringify(v);

// --- the full rule table ---------------------------------------------------------
{
  // Rule 1 first: sidecar down wins over everything — even with a connected
  // link and phones paired, without the local process nothing works.
  const down = trayStatus(false, "connected", 3);
  check(
    "P2-252: sidecar down with connected link and many phones → the sidecar-down phrase",
    down.tooltip.includes("processo local fora do ar") &&
      down.menuLine.includes("Processo local fora do ar") &&
      !down.tooltip.includes("tudo pronto") &&
      !down.menuLine.includes("Tudo pronto"),
  );
  // Rule order proven: sidecar down AND zero phones hold at the same time —
  // the result is still the sidecar-down phrase, never the invite.
  const downZero = trayStatus(false, "connected", 0);
  check(
    "P2-252: sidecar down and zero phones at once → sidecar-down wins (rule order)",
    downZero.tooltip === down.tooltip &&
      downZero.menuLine === down.menuLine &&
      !downZero.menuLine.includes("pareado"),
  );

  // Rule 2: refused, misconfigured, dialing and unknown each carry their OWN
  // phrase (sidecar up, phones irrelevant for these states).
  const refused = trayStatus(true, "refused", 2);
  const misconfigured = trayStatus(true, "misconfigured", 2);
  const dialing = trayStatus(true, "dialing", 2);
  const unknown = trayStatus(true, "unknown", 2);
  const localWithPhones = trayStatus(true, "local", 2);
  const ready = trayStatus(true, "connected", 1);
  const invite = trayStatus(true, "connected", 0);
  const inviteLocal = trayStatus(true, "local", 0);
  check(
    "P2-252: each link state carries its own distinct phrase",
    refused.tooltip.includes("relay recusou a conexão") &&
      misconfigured.tooltip.includes("recusado na partida") &&
      dialing.tooltip.includes("conectando ao relay") &&
      unknown.tooltip.includes("sem informação do relay") &&
      localWithPhones.tooltip.includes("rede local") &&
      ready.tooltip.includes("tudo pronto") &&
      new Set([refused.tooltip, misconfigured.tooltip, dialing.tooltip, unknown.tooltip, localWithPhones.tooltip, ready.tooltip]).size === 6,
  );
  // Rule 3: with the sidecar up and the link connected or local, zero phones
  // is the invite-to-pair phrase.
  check(
    "P2-252: connected link with zero phones → invite to pair",
    invite.menuLine.includes("Nenhum telefone pareado") && invite.menuLine.includes("escaneie o código"),
  );
  check(
    "P2-252: local link with zero phones → invite to pair too",
    inviteLocal.menuLine === invite.menuLine && inviteLocal.tooltip === invite.tooltip,
  );
  // Rule 4: the remaining case — connected with phones — is the all-ready phrase.
  check(
    "P2-252: connected link with one phone → all ready",
    ready.tooltip.includes("tudo pronto") && ready.menuLine.includes("Tudo pronto"),
  );

  // Fail-closed phone count: text, non-finite, fractional and negative are all
  // treated as zero — never guessed, so a nonsense count can never read "ready".
  check(
    "P2-252: a textual phone count is treated as zero (fail-closed)",
    trayStatus(true, "connected", "3").tooltip === invite.tooltip,
  );
  check(
    "P2-252: non-finite phone counts (NaN, Infinity) are treated as zero",
    trayStatus(true, "connected", Number.NaN).tooltip === invite.tooltip &&
      trayStatus(true, "connected", Number.POSITIVE_INFINITY).tooltip === invite.tooltip,
  );
  check(
    "P2-252: a negative phone count is treated as zero",
    trayStatus(true, "connected", -1).tooltip === invite.tooltip,
  );
  check(
    "P2-252: a fractional phone count is treated as zero",
    trayStatus(true, "connected", 1.5).tooltip === invite.tooltip,
  );

  // A link state the module does not know falls to the neutral phrase instead
  // of throwing — absence of information is never an accusation.
  check(
    "P2-252: an unrecognized link state falls to the neutral phrase (no throw)",
    trayStatus(true, "alguma-coisa-nova", 1).tooltip === unknown.tooltip &&
      trayStatus(true, null, 1).tooltip === unknown.tooltip &&
      trayStatus(true, undefined, 1).tooltip === unknown.tooltip,
  );

  // Determinism: the same input mints the same output on every call.
  const once = trayStatus(true, "connected", 1);
  const twice = trayStatus(true, "connected", 1);
  check(
    "P2-252: identical input → identical output across calls",
    once.tooltip === twice.tooltip && once.menuLine === twice.menuLine,
  );

  // Every phrase is static and secret-free: no path separator, no URL scheme,
  // no address/port (no digits at all) in anything the module can emit.
  const everyCase = [
    down, downZero, refused, misconfigured, dialing, unknown, localWithPhones, ready, invite, inviteLocal,
    trayStatus(true, "local", 5),
  ];
  check(
    "P2-252: every phrase is path-free, scheme-free and carries no address/port/secret",
    everyCase.every(
      (s) =>
        !s.tooltip.includes("/") &&
        !s.tooltip.includes("\\") &&
        !s.tooltip.includes("http") &&
        !/[0-9]/.test(s.tooltip) &&
        !s.menuLine.includes("/") &&
        !s.menuLine.includes("\\") &&
        !s.menuLine.includes("http") &&
        !/[0-9]/.test(s.menuLine),
    ),
  );
  // Windows truncates long tray tooltips — every tooltip must fit the budget
  // the module documents.
  check(
    "P2-252: every tooltip fits the documented maximum size",
    everyCase.every((s) => s.tooltip.length > 0 && s.tooltip.length <= TRAY_TIP_MAX_CHARS),
  );
}

// --- the real sources: module purity + main.ts wiring -----------------------------
{
  const trayStatusSrc = readFileSync(new URL("../apps/desktop/src/traystatus.ts", import.meta.url), "utf8");
  check(
    "P2-252: the real traystatus.ts imports no electron, no node:fs and no fetch",
    trayStatusSrc
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import "))
      .every((line) => !line.includes("electron") && !line.includes("node:fs") && !line.includes("fetch")),
  );

  const mainSrc = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  check(
    "P2-252: the tray tooltip is written by a single call site in main.ts",
    (mainSrc.match(/setToolTip\(/g) ?? []).length === 1 && mainSrc.includes("if (trayStatusKey === key) return;"),
  );
  check(
    "P2-252: no new periodic timer — the pairing watcher remains the only 3s driver",
    (mainSrc.match(/setInterval\(/g) ?? []).length === 2,
  );
  check(
    "P2-252: the tray rides the pairing tick's already-computed link verdict and device count",
    mainSrc.includes('updateTrayStatus(true, quietLocal ? "local" : relayLink?.state ?? null, devices.length)'),
  );
  const trayAt = mainSrc.indexOf("function trayMenuItems");
  const trayBlock = trayAt >= 0 ? mainSrc.slice(trayAt, mainSrc.indexOf("return items;", trayAt)) : "";
  check(
    "P2-252: the status line is the first, disabled tray item and the existing items keep their order",
    trayBlock.includes("{ label: trayMenuLine, enabled: false }") &&
      trayBlock.indexOf("trayMenuLine") < trayBlock.indexOf('"Open OpenCode Remote"') &&
      trayBlock.indexOf('"Open OpenCode Remote"') < trayBlock.indexOf('"Restart daemon"') &&
      trayBlock.indexOf('"Restart daemon"') < trayBlock.indexOf('"Open logs folder"') &&
      trayBlock.indexOf('"Open logs folder"') < trayBlock.indexOf('"Quit"'),
  );
}

console.log(failures === 0 ? "\ntraystatus tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
