/**
 * P2-288: settings-mirror tests (apps/daemon/src/settingsmirror.ts) — the
 * portable twin of the unit.test.ts block. Pure node: no Electron, no
 * sockets, no chmod, no spawn, no network; the only fs use is reading the
 * real settingsmirror.ts and index.ts sources for the purity/wiring
 * assertions, via paths relative to this file (Windows-safe).
 * Run: npx tsx scripts/settingsmirror.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settingsMirror } from "../apps/daemon/src/settingsmirror";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const json = (v: unknown) => JSON.stringify(v);
const DOC = {
  complete: "Conversão de documentos em PDF pronta neste computador.",
  partial:
    "A conversão de documentos neste computador cobre apenas alguns formatos — instale o LibreOffice para converter qualquer documento em PDF.",
  unavailable:
    "Este computador ainda não converte documentos em PDF — peça a quem gerencia a máquina para instalar o LibreOffice.",
};
const BROWSE = {
  ready: "Navegação de sites pronta neste computador.",
  noBrowser:
    "Este computador ainda não tem navegador para abrir sites — instalar o navegador do Playwright é opcional e fica a cargo de quem gerencia a máquina.",
  disabled:
    "A navegação de sites está desligada neste computador — quem gerencia a máquina é quem decide quando ligá-la.",
  unknown:
    "Não deu para verificar a navegação de sites agora — o resto do app segue disponível do mesmo jeito.",
};

// --- rule 1: absent input, non-object input, non-textual fields ---------------------
{
  check("rule 1: missing input yields the empty set", json(settingsMirror()) === "{}" && json(settingsMirror(undefined)) === "{}" && json(settingsMirror(null)) === "{}");
  check("rule 1: non-object input yields the empty set", ["snapshot", 42, true, [], ["ready"]].every((v) => json(settingsMirror(v)) === "{}"));
  check(
    "rule 1: a present non-textual field never becomes a field — the set stays empty",
    json(settingsMirror({ docConvertState: 42, docConvertMessage: DOC.complete })) === "{}" &&
      json(settingsMirror({ browseState: true, browseMessage: BROWSE.ready })) === "{}" &&
      json(settingsMirror({ docConvertState: "complete", docConvertMessage: null })) === "{}" &&
      json(settingsMirror({ docConvertState: ["complete"], browseState: "ready", browseMessage: BROWSE.ready })) === "{}",
  );
}

// --- rule 2: out-of-table verdicts yield no field ------------------------------------
{
  const outOfTable = (state: unknown) =>
    json(settingsMirror({ docConvertState: state, docConvertMessage: DOC.complete })) === "{}" &&
    json(settingsMirror({ browseState: state, browseMessage: BROWSE.ready })) === "{}";
  check("rule 2: verdicts outside the documented table yield no field", ["warp-speed", "", "Ready", "no_browser", "complete "].every(outOfTable));
}

// --- rule 3: the never-measured capability stays silent (fail-closed) ----------------
{
  check(
    "rule 3: the never-measured verdict (browse unknown) yields no field instead of one announcing readiness",
    json(settingsMirror({ browseState: "unknown", browseMessage: BROWSE.unknown })) === "{}",
  );
  check(
    "rule 3: an absent capability yields no field while the measured one still rides",
    json(settingsMirror({ docConvertState: "partial", docConvertMessage: DOC.partial })) === json({ docConvertState: "partial", docConvertMessage: DOC.partial }) &&
      json(settingsMirror({ browseState: "disabled", browseMessage: BROWSE.disabled })) === json({ browseState: "disabled", browseMessage: BROWSE.disabled }),
  );
}

// --- rules 4+5: verbatim pair, four fields together, order proof, determinism --------
{
  check(
    "rule 4: a measured capability becomes exactly state + phrase, verbatim",
    json(settingsMirror({ docConvertState: "unavailable", docConvertMessage: DOC.unavailable })) === json({ docConvertState: "unavailable", docConvertMessage: DOC.unavailable }) &&
      json(settingsMirror({ browseState: "no-browser", browseMessage: BROWSE.noBrowser })) === json({ browseState: "no-browser", browseMessage: BROWSE.noBrowser }),
  );
  const both = settingsMirror({
    docConvertState: "complete",
    docConvertMessage: DOC.complete,
    browseState: "ready",
    browseMessage: BROWSE.ready,
  });
  check(
    "rules: both measured capabilities become exactly the four additive fields, fixed key order",
    json(both) ===
      json({ docConvertState: "complete", docConvertMessage: DOC.complete, browseState: "ready", browseMessage: BROWSE.ready }) &&
      Object.keys(both).join(",") === "docConvertState,docConvertMessage,browseState,browseMessage",
  );
  const orderA = settingsMirror({
    docConvertState: "complete",
    docConvertMessage: DOC.complete,
    browseState: "warp-speed",
    browseMessage: BROWSE.ready,
  });
  const orderB = settingsMirror({
    docConvertState: "warp-speed",
    docConvertMessage: DOC.complete,
    browseState: "disabled",
    browseMessage: BROWSE.disabled,
  });
  check(
    "rule order: one measured capability and one out-of-table verdict coexist",
    json(orderA) === json({ docConvertState: "complete", docConvertMessage: DOC.complete }) &&
      json(orderB) === json({ browseState: "disabled", browseMessage: BROWSE.disabled }),
  );
  const snap = {
    docConvertState: "partial",
    docConvertMessage: DOC.partial,
    browseState: "no-browser",
    browseMessage: BROWSE.noBrowser,
  };
  check("rule 5: the same input yields the identical result on two calls", json(settingsMirror(snap)) === json(settingsMirror(snap)));
}

// --- hygiene: no path, port, address, env variable or secret in any value ------------
{
  const vals = (m: ReturnType<typeof settingsMirror>): string[] => Object.values(m) as string[];
  const allValues: string[] = [
    ...vals(settingsMirror({ docConvertState: "complete", docConvertMessage: DOC.complete })),
    ...vals(settingsMirror({ docConvertState: "partial", docConvertMessage: DOC.partial })),
    ...vals(settingsMirror({ docConvertState: "unavailable", docConvertMessage: DOC.unavailable })),
    ...vals(settingsMirror({ browseState: "ready", browseMessage: BROWSE.ready })),
    ...vals(settingsMirror({ browseState: "no-browser", browseMessage: BROWSE.noBrowser })),
    ...vals(settingsMirror({ browseState: "disabled", browseMessage: BROWSE.disabled })),
    ...vals(settingsMirror({ browseState: "unknown", browseMessage: BROWSE.unknown })),
  ];
  check(
    "hygiene: no returned value contains a path, port, address, env variable or secret",
    allValues.every(
      (v) =>
        !v.includes("://") &&
        !v.includes("/") &&
        !v.includes("\\") &&
        !v.includes("127.0.0.1") &&
        !v.includes(":8792") &&
        !v.includes("localhost") &&
        !v.includes("$") &&
        !v.includes("Bearer") &&
        !v.includes("token"),
    ),
  );
  let threw = false;
  try {
    for (const input of [NaN, new Date(), () => 1, { docConvertState: {} }, { browseMessage: Symbol("x") }, { docConvertState: "complete" }]) {
      settingsMirror(input);
    }
  } catch {
    threw = true;
  }
  check("robustness: no input shape ever throws", !threw);
}

// --- the real sources: module purity and daemon wiring --------------------------------
{
  const mirrorSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "settingsmirror.ts"), "utf8");
  check(
    "purity: settingsmirror.ts imports no node:fs, node:http, node:child_process, fetch or anything else",
    !/^import\b/m.test(mirrorSrc) &&
      !/^import[^\n]*(node:fs|node:http|node:child_process|fetch)/m.test(mirrorSrc) &&
      !mirrorSrc.includes("require("),
  );
  check("purity: the header documents the rule order and the privacy boundary", mirrorSrc.includes("RULE ORDER CONTRACT") && mirrorSrc.includes("PRIVACY BOUNDARY"));
  check(
    "tables: exactly the measured /api/health verdicts",
    mirrorSrc.includes('const DOC_STATES: readonly string[] = ["complete", "partial", "unavailable"];') &&
      mirrorSrc.includes('const BROWSE_STATES: readonly string[] = ["ready", "no-browser", "disabled"];'),
  );

  const indexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const handlerAt = indexSrc.indexOf('req.path === "/__ocr/settings" && req.method === "GET"');
  const patchAt = indexSrc.indexOf('req.path === "/__ocr/settings" && req.method === "PATCH"');
  const handler = handlerAt >= 0 && patchAt > handlerAt ? indexSrc.slice(handlerAt, patchAt) : "";
  check(
    "wiring: the settings GET handler mirrors the four fields from settingsMirror",
    handler.includes("...settingsMirror({") &&
      handler.includes("docConvertState: docConvert.state") &&
      handler.includes("docConvertMessage: docConvert.message") &&
      handler.includes("browseState: browseCap.state") &&
      handler.includes("browseMessage: browseCap.message"),
  );
  check(
    "wiring: no existing settings field is renamed, removed or repositioned",
    handler.indexOf("...readSettings()") < handler.indexOf("version: VERSION") &&
      handler.indexOf("version: VERSION") < handler.indexOf("opencodeVersion: opencodeVersion") &&
      handler.indexOf("opencodeVersion: opencodeVersion") < handler.indexOf("disk: diskStatus()") &&
      handler.indexOf("disk: diskStatus()") < handler.indexOf("...settingsMirror({"),
  );
  check(
    "wiring: both capabilities are lazily revalidated at the same point, same readiness policy",
    handler.indexOf("maybeReprobeOpencodeVersion();") < handler.indexOf("maybeReprobeDocConvert();") &&
      handler.includes("await maybeReprobeBrowse();") &&
      handler.indexOf("await maybeReprobeBrowse();") < handler.indexOf("...settingsMirror({") &&
      indexSrc.includes("readinessRefreshPlan(") &&
      indexSrc.includes("parseReadinessKnobs(process.env)"),
  );
  check(
    "wiring: no new periodic timer — the handler has none and the module keeps exactly the five pre-existing ones",
    !/setInterval|setTimeout/.test(handler) && (indexSrc.match(/setInterval\(/g) || []).length === 5,
  );
}

// --- P2-292: the relay and agent mirrorings — complete table -----------------
{
  // Fixtures copied from the real authors, same discipline as DOC/BROWSE
  // above: the four relay phrases are the boot-validation problems
  // relayurl.ts authors verbatim (they embed the userinfo-redacted URL, the
  // host or a dotted address — redaction there is userinfo-only), and the
  // agent pair is the P2-149 binary verdict, booleans included.
  const RELAY_PROBLEM_URL =
    'RELAY_URL="wss://relay.example.com:8792/room" is not a valid URL: refusing to dial the relay (fail-closed)';
  const RELAY_PROBLEM_SCHEME =
    'RELAY_URL scheme "ws:" is not supported — only ws:// and wss:// are accepted: refusing to dial the relay (fail-closed)';
  const RELAY_PROBLEM_HOST =
    'RELAY_URL points at non-loopback host "relay.example.com:8792" over plain ws://: room metadata and pairing traffic would cross the network without TLS — refusing to dial the relay (fail-closed)';
  const RELAY_PROBLEM_DOTTED =
    'RELAY_URL="relay.example.com" is not a valid URL: refusing to dial the relay (fail-closed)';
  // The documented riding shape for a down relay: an address-free phrase —
  // what relayurl.ts would have to author for the verdict to ride.
  const RELAY_PHRASE = "Endereço do relay recusado na partida — recusando discar (fail-closed)";
  const RELAY_OK = { ok: true, reason: null };
  const RELAY_DOWN = { ok: false, reason: RELAY_PHRASE };
  const AGENT_PATH = { binaryFound: true, binarySource: "path" };
  const AGENT_KNOWN = { binaryFound: true, binarySource: "known" };
  const AGENT_MISSING = { binaryFound: false, binarySource: null };

  // rule 1 — an absent or non-object capability entry never becomes a field
  // (and never takes the other capabilities down with it).
  check(
    "P2-292 rule 1: a relay/opencode entry that is absent or not an object never becomes a field",
    json(settingsMirror({})) === "{}" &&
      json(settingsMirror({ relay: "wss://relay.example.com:8792/room" })) === "{}" &&
      json(settingsMirror({ relay: 42 })) === "{}" &&
      json(settingsMirror({ relay: [] })) === "{}" &&
      json(settingsMirror({ relay: null })) === "{}" &&
      json(settingsMirror({ opencode: "warp" })) === "{}" &&
      json(settingsMirror({ opencode: 42 })) === "{}" &&
      json(settingsMirror({ relay: 42, docConvertState: "complete", docConvertMessage: DOC.complete })) ===
        json({ docConvertState: "complete", docConvertMessage: DOC.complete }),
  );
  check(
    "P2-292 rule 1: a non-textual phrase member never becomes a field",
    json(settingsMirror({ relay: { ok: true, reason: 42 } })) === "{}" &&
      json(settingsMirror({ relay: { ok: false, reason: 42 } })) === "{}" &&
      json(settingsMirror({ relay: { ok: true } })) === "{}" &&
      json(settingsMirror({ opencode: { binaryFound: true, binarySource: 42 } })) === "{}" &&
      json(settingsMirror({ opencode: { binaryFound: true } })) === "{}",
  );

  // rule 2 — verdicts outside the documented tables yield no field.
  check(
    "P2-292 rule 2: a relay verdict outside the documented table yields no field",
    [ "true", 1, 0, null, { yes: true }, [] ].every(
      (v) => json(settingsMirror({ relay: { ok: v, reason: RELAY_PHRASE } })) === "{}",
    ),
  );
  check(
    "P2-292 rule 2: an agent verdict outside the documented table yields no field",
    [ "true", 1, 0, null, {} ].every(
      (v) => json(settingsMirror({ opencode: { binaryFound: v, binarySource: "path" } })) === "{}",
    ) &&
      json(settingsMirror({ opencode: { binaryFound: true, binarySource: "warp" } })) === "{}" &&
      json(settingsMirror({ opencode: { binaryFound: false, binarySource: "/usr/local/bin/opencode" } })) === "{}",
  );
  check(
    "P2-292 rule 2: every boot-validation phrase relayurl.ts authors carries address material — the relay field stays silent",
    [RELAY_PROBLEM_URL, RELAY_PROBLEM_SCHEME, RELAY_PROBLEM_HOST, RELAY_PROBLEM_DOTTED].every(
      (p) =>
        json(settingsMirror({ relay: { ok: false, reason: p } })) === "{}" &&
        json(settingsMirror({ relay: { ok: true, reason: p } })) === "{}",
    ),
  );

  // rule 3 — a never-measured capability stays silent instead of announcing
  // readiness (fail-closed): no state member, no field, ever.
  check(
    "P2-292 rule 3: a never-measured relay or agent yields no field instead of one announcing readiness",
    json(settingsMirror({ relay: { reason: null } })) === "{}" &&
      json(settingsMirror({ relay: { reason: RELAY_PHRASE } })) === "{}" &&
      json(settingsMirror({ opencode: { binarySource: "path" } })) === "{}" &&
      json(settingsMirror({ opencode: { binarySource: null } })) === "{}",
  );

  // rule 4 — every documented verdict becomes exactly state + phrase,
  // verbatim, with the same names and values /api/health publishes: the
  // connected verdict rides with its null phrase, an address-free down
  // phrase rides verbatim, and the entry's url never does.
  check(
    "P2-292 rule 4: each documented relay verdict becomes exactly state + phrase",
    json(settingsMirror({ relay: { url: "wss://relay.example.com:8792/room", ...RELAY_OK } })) === json({ relay: RELAY_OK }) &&
      json(settingsMirror({ relay: RELAY_DOWN })) === json({ relay: RELAY_DOWN }),
  );
  check(
    "P2-292 rule 4: each documented agent verdict becomes exactly state + phrase",
    json(settingsMirror({ opencode: AGENT_PATH })) === json({ opencode: AGENT_PATH }) &&
      json(settingsMirror({ opencode: AGENT_KNOWN })) === json({ opencode: AGENT_KNOWN }) &&
      json(settingsMirror({ opencode: AGENT_MISSING })) === json({ opencode: AGENT_MISSING }),
  );

  // The four capabilities together: the P2-288 fields keep their exact names,
  // values and order, and the two new pairs append after them.
  const four = settingsMirror({
    docConvertState: "complete",
    docConvertMessage: DOC.complete,
    browseState: "ready",
    browseMessage: BROWSE.ready,
    relay: RELAY_DOWN,
    opencode: AGENT_PATH,
  });
  check(
    "P2-292: the four capabilities coexist and the P2-288 mirroring loses no field",
    json(four) ===
      json({
        docConvertState: "complete",
        docConvertMessage: DOC.complete,
        browseState: "ready",
        browseMessage: BROWSE.ready,
        relay: RELAY_DOWN,
        opencode: AGENT_PATH,
      }) &&
      Object.keys(four).join(",") ===
        "docConvertState,docConvertMessage,browseState,browseMessage,relay,opencode",
  );

  // Rule order proven: a measured relay and an out-of-table agent (and the
  // mirror image of that case) coexist — one silent capability never takes
  // the other down.
  const orderRelay = settingsMirror({ relay: RELAY_OK, opencode: { binaryFound: "true", binarySource: "path" } });
  const orderAgent = settingsMirror({ relay: { ok: 1, reason: RELAY_PHRASE }, opencode: AGENT_KNOWN });
  check(
    "P2-292 rule order: a measured relay and an out-of-table agent coexist (and vice versa)",
    json(orderRelay) === json({ relay: RELAY_OK }) && json(orderAgent) === json({ opencode: AGENT_KNOWN }),
  );

  // Privacy boundary proven against the data the daemon really feeds the
  // mirror: a complete relay address in the url AND the production-authored
  // problem phrase (host and port embedded) in the reason — the relay field
  // stays silent and nothing of the address survives anywhere in the output.
  const withAddress = settingsMirror({
    relay: { url: "wss://user:token@relay.example.com:8792/room", ok: false, reason: RELAY_PROBLEM_HOST },
    opencode: AGENT_MISSING,
  });
  const flat: string[] = [];
  const collect = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) collect(x);
    else flat.push(String(v));
  };
  collect(withAddress);
  check(
    "P2-292 privacy: a production relay entry (address in the url and in the phrase) yields no relay field and no address, host, port, path or secret",
    json(withAddress) === json({ opencode: AGENT_MISSING }) &&
      flat.length > 0 &&
      flat.every(
        (v) =>
          !v.includes("://") &&
          !v.includes("/") &&
          !v.includes("relay.example.com") &&
          !v.includes("8792") &&
          !v.includes("room") &&
          !v.includes("user") &&
          !v.includes("token") &&
          !v.includes("\\") &&
          !v.includes("localhost") &&
          !v.includes("127.0.0.1") &&
          !v.includes("RELAY_URL"),
      ),
  );

  // rule 5 — the same input yields the identical result on two calls,
  // nested objects included.
  const fullSnap = {
    docConvertState: "partial",
    docConvertMessage: DOC.partial,
    browseState: "no-browser",
    browseMessage: BROWSE.noBrowser,
    relay: { url: "ws://127.0.0.1:8787", ...RELAY_DOWN },
    opencode: AGENT_PATH,
  };
  check("P2-292 rule 5: the same input yields the identical result on two calls", json(settingsMirror(fullSnap)) === json(settingsMirror(fullSnap)));
}

// --- P2-292: the real sources — wiring, purity and the untouched P2-288 ------
{
  const mirrorSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "settingsmirror.ts"), "utf8");
  const mirrorCode = mirrorSrc
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  check(
    "P2-292 purity: settingsmirror.ts still imports no node:fs, node:http, node:child_process or fetch",
    !/^import\b/m.test(mirrorCode) &&
      !mirrorCode.includes("node:fs") &&
      !mirrorCode.includes("node:http") &&
      !mirrorCode.includes("node:child_process") &&
      !mirrorCode.includes("fetch") &&
      !mirrorSrc.includes("require("),
  );
  check(
    "P2-292 fail-closed boundary: the module refuses phrases carrying address material instead of trusting them",
    mirrorSrc.includes("ADDRESS_MATERIAL") &&
      mirrorSrc.includes('no URL authority ("://")') &&
      mirrorSrc.includes("redaction there is userinfo-only"),
  );

  const indexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const handlerAt = indexSrc.indexOf('req.path === "/__ocr/settings" && req.method === "GET"');
  const patchAt = indexSrc.indexOf('req.path === "/__ocr/settings" && req.method === "PATCH"');
  const handler = handlerAt >= 0 && patchAt > handlerAt ? indexSrc.slice(handlerAt, patchAt) : "";
  check(
    "P2-292 wiring: the additive relay and agent fields leave the module in the settings GET handler",
    handler.includes("...settingsMirror({") &&
      handler.indexOf("docConvertState: docConvert.state") < handler.indexOf("relay: {") &&
      handler.indexOf("relay: {") < handler.indexOf("opencode: {") &&
      handler.includes("ok: !relayDisabled") &&
      handler.includes("reason: relayDisabled ? relayUrl.problems.join(\" \") : null") &&
      handler.includes("binaryFound: binaryPick.path !== null") &&
      handler.includes("binarySource: binaryPick.source"),
  );
  check(
    "P2-292 wiring: no existing settings field is renamed, removed or repositioned",
    handler.indexOf("...readSettings()") < handler.indexOf("version: VERSION") &&
      handler.indexOf("version: VERSION") < handler.indexOf("opencodeVersion: opencodeVersion") &&
      handler.indexOf("opencodeVersion: opencodeVersion") < handler.indexOf("disk: diskStatus()") &&
      handler.indexOf("disk: diskStatus()") < handler.indexOf("...settingsMirror({") &&
      handler.indexOf("...settingsMirror({") < handler.indexOf("relay: {") &&
      handler.indexOf("relay: {") < handler.indexOf("opencode: {"),
  );
  check(
    "P2-292 wiring: the lazy revalidation is still called at the same point, same readiness policy",
    handler.indexOf("maybeReprobeOpencodeVersion();") < handler.indexOf("maybeReprobeDocConvert();") &&
      handler.indexOf("maybeReprobeDocConvert();") < handler.indexOf("await maybeReprobeBrowse();") &&
      handler.indexOf("await maybeReprobeBrowse();") < handler.indexOf("...settingsMirror({") &&
      indexSrc.includes("readinessRefreshPlan(") &&
      indexSrc.includes("parseReadinessKnobs(process.env)"),
  );
  check(
    "P2-292 wiring: no new periodic timer — the handler has none and the module keeps exactly the five pre-existing ones",
    !/setInterval|setTimeout/.test(handler) && (indexSrc.match(/setInterval\(/g) || []).length === 5,
  );
}

// --- P2-296: the voice-transcription verdict rides the same pure module -----
// Portable twin of the unit.test.ts block (P2-237 sub-battery): the same
// cases, the same fixtures — the three phrases are the voicecap.ts constants
// verbatim, and the dirty phrase is what a leak would look like.
{
  const VOICE = {
    ready: "Transcrição de voz pronta neste computador.",
    missingBinary:
      "A transcrição de voz ainda não está instalada neste computador — peça a quem gerencia a máquina para instalar o recurso de voz.",
    missingModel:
      "O computador tem o motor de transcrição, mas falta o modelo de voz — quem gerencia a máquina precisa concluir a instalação.",
  };
  const DOC296 = {
    complete: "Conversão de documentos em PDF pronta neste computador.",
    partial:
      "A conversão de documentos neste computador cobre apenas alguns formatos — instale o LibreOffice para converter qualquer documento em PDF.",
  };
  const BROWSE296 = {
    ready: "Navegação de sites pronta neste computador.",
    noBrowser:
      "Este computador ainda não tem navegador para abrir sites — instalar o navegador do Playwright é opcional e fica a cargo de quem gerencia a máquina.",
  };
  const RELAY_DOWN_296 = { ok: false, reason: "Endereço do relay recusado na partida — recusando discar (fail-closed)" };
  const AGENT_PATH_296 = { binaryFound: true, binarySource: "path" };

  // rule 1 — absent input, non-object input, non-textual voice field
  check(
    "P2-296 rule 1: missing or non-object input yields the empty set",
    json(settingsMirror()) === "{}" &&
      json(settingsMirror(undefined)) === "{}" &&
      json(settingsMirror(null)) === "{}" &&
      ["voice snapshot", 42, true, [], ["ready"]].every((v) => json(settingsMirror(v)) === "{}"),
  );
  check(
    "P2-296 rule 1: a non-textual voice field never becomes a field",
    json(settingsMirror({ voiceState: 42, voiceMessage: VOICE.ready })) === "{}" &&
      json(settingsMirror({ voiceState: true, voiceMessage: VOICE.ready })) === "{}" &&
      json(settingsMirror({ voiceState: "ready", voiceMessage: null })) === "{}" &&
      json(settingsMirror({ voiceState: ["ready"], voiceMessage: VOICE.ready })) === "{}",
  );

  // rule 2 — voice verdicts outside the documented table yield no field
  check(
    "P2-296 rule 2: voice verdicts outside the documented table yield no field",
    ["warp-speed", "", "Ready", "missing_binary", "ready ", "unavailable"].every(
      (state) => json(settingsMirror({ voiceState: state, voiceMessage: VOICE.ready })) === "{}",
    ),
  );

  // rule 3 — a never-measured voice capability stays silent (fail-closed)
  check(
    "P2-296 rule 3: a never-measured voice capability yields no field instead of one announcing readiness",
    json(settingsMirror({ voiceState: "unknown", voiceMessage: VOICE.ready })) === "{}" &&
      json(settingsMirror({ voiceMessage: VOICE.ready })) === "{}",
  );

  // rule 4 — each of the three documented verdicts becomes exactly state +
  // phrase, verbatim, the same names and values /api/health publishes
  check(
    "P2-296 rule 4: each documented voice verdict becomes exactly state + phrase, verbatim",
    json(settingsMirror({ voiceState: "ready", voiceMessage: VOICE.ready })) ===
      json({ voiceState: "ready", voiceMessage: VOICE.ready }) &&
      json(settingsMirror({ voiceState: "missing-binary", voiceMessage: VOICE.missingBinary })) ===
        json({ voiceState: "missing-binary", voiceMessage: VOICE.missingBinary }) &&
      json(settingsMirror({ voiceState: "missing-model", voiceMessage: VOICE.missingModel })) ===
        json({ voiceState: "missing-model", voiceMessage: VOICE.missingModel }),
  );

  // the five capabilities together — the P2-288/P2-292 mirrorings keep their
  // exact names, values and order, and the voice pair appends last
  const five296 = settingsMirror({
    docConvertState: "complete",
    docConvertMessage: DOC296.complete,
    browseState: "ready",
    browseMessage: BROWSE296.ready,
    relay: RELAY_DOWN_296,
    opencode: AGENT_PATH_296,
    voiceState: "missing-model",
    voiceMessage: VOICE.missingModel,
  });
  check(
    "P2-296: the five capabilities coexist and the P2-288/P2-292 mirroring loses no field",
    json(five296) ===
      json({
        docConvertState: "complete",
        docConvertMessage: DOC296.complete,
        browseState: "ready",
        browseMessage: BROWSE296.ready,
        relay: RELAY_DOWN_296,
        opencode: AGENT_PATH_296,
        voiceState: "missing-model",
        voiceMessage: VOICE.missingModel,
      }) &&
      Object.keys(five296).join(",") ===
        "docConvertState,docConvertMessage,browseState,browseMessage,relay,opencode,voiceState,voiceMessage",
  );

  // rule order proven: a measured voice and an out-of-table capability
  // coexist (and the mirror image of that case)
  const orderVoice296 = settingsMirror({ voiceState: "ready", voiceMessage: VOICE.ready, relay: { ok: 1, reason: null } });
  const orderDoc296 = settingsMirror({
    voiceState: "warp-speed",
    voiceMessage: VOICE.ready,
    docConvertState: "partial",
    docConvertMessage: DOC296.partial,
  });
  check(
    "P2-296 rule order: a measured voice and an out-of-table capability coexist (and vice versa)",
    json(orderVoice296) === json({ voiceState: "ready", voiceMessage: VOICE.ready }) &&
      json(orderDoc296) === json({ docConvertState: "partial", docConvertMessage: DOC296.partial }),
  );

  // privacy boundary proven against a leak-shaped input: the phrase carries
  // an absolute model path, a model file name, an install script name and a
  // port — the whole voice verdict stays silent and nothing of it survives
  // anywhere in the output (the measured doc capability is unaffected)
  const dirty296 =
    "Modelo de voz em /Users/caio/.opencode-remote/models/ggml-base.bin — rode scripts/setup-whisper.sh no host e confira a porta 8792";
  const dirtyOut296 = settingsMirror({
    voiceState: "missing-model",
    voiceMessage: dirty296,
    docConvertState: "partial",
    docConvertMessage: DOC296.partial,
  });
  check(
    "P2-296 privacy: a voice phrase carrying an absolute model path, script name and port silences the verdict",
    json(dirtyOut296) === json({ docConvertState: "partial", docConvertMessage: DOC296.partial }),
  );

  // hygiene over every riding combination
  const flat296: string[] = [];
  const collect296 = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) collect296(x);
    else flat296.push(String(v));
  };
  const allVoiceValues: string[] = [];
  for (const m of [
    settingsMirror({ voiceState: "ready", voiceMessage: VOICE.ready }),
    settingsMirror({ voiceState: "missing-binary", voiceMessage: VOICE.missingBinary }),
    settingsMirror({ voiceState: "missing-model", voiceMessage: VOICE.missingModel }),
    five296,
    dirtyOut296,
  ]) {
    collect296(m);
  }
  allVoiceValues.push(...flat296);
  check(
    "P2-296 hygiene: no returned value contains a path, script name, port, address, env variable or secret",
    allVoiceValues.length > 0 &&
      allVoiceValues.every(
        (v) =>
          !v.includes("/") &&
          !v.includes("\\") &&
          !v.includes("://") &&
          !v.includes("127.0.0.1") &&
          !v.includes("8792") &&
          !v.includes("localhost") &&
          !v.includes(".sh") &&
          !v.includes(".bin") &&
          !v.includes("$") &&
          !v.includes("Bearer") &&
          !v.includes("token"),
      ),
  );

  // rule 5 — the same input yields the identical result on two calls
  const voiceSnap296 = {
    docConvertState: "partial",
    docConvertMessage: DOC296.partial,
    browseState: "no-browser",
    browseMessage: BROWSE296.noBrowser,
    relay: RELAY_DOWN_296,
    opencode: AGENT_PATH_296,
    voiceState: "missing-binary",
    voiceMessage: VOICE.missingBinary,
  };
  check(
    "P2-296 rule 5: the same input yields the identical result on two calls",
    json(settingsMirror(voiceSnap296)) === json(settingsMirror(voiceSnap296)),
  );

  // robustness — no input shape ever throws
  let threw296 = false;
  try {
    for (const input of [NaN, new Date(), () => 1, { voiceState: {} }, { voiceMessage: Symbol("x") }, { voiceState: "ready" }]) {
      settingsMirror(input);
    }
  } catch {
    threw296 = true;
  }
  check("P2-296 robustness: no input shape ever throws", !threw296);
}

// --- P2-296: the real sources — purity, wiring and the untouched mirrorings --
{
  const mirrorSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "settingsmirror.ts"), "utf8");
  const mirrorCode = mirrorSrc
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  check(
    "P2-296 purity: settingsmirror.ts still imports no node:fs, node:http, node:child_process or fetch",
    !/^import\b/m.test(mirrorCode) &&
      !mirrorCode.includes("node:fs") &&
      !mirrorCode.includes("node:http") &&
      !mirrorCode.includes("node:child_process") &&
      !mirrorCode.includes("fetch") &&
      !mirrorSrc.includes("require("),
  );
  check(
    "P2-296 boundary: the module documents the voice table and the path-material privacy boundary",
    mirrorSrc.includes('const VOICE_STATES: readonly string[] = ["ready", "missing-binary", "missing-model"];') &&
      mirrorSrc.includes("PATH_MATERIAL") &&
      mirrorSrc.includes('voice transcription: "ready" | "missing-binary" | "missing-model"'),
  );

  const indexSrc = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const healthAt = indexSrc.indexOf('seg[1] === "health"');
  const mcpAt = indexSrc.indexOf('seg[1] === "mcp"');
  const health = healthAt >= 0 && mcpAt > healthAt ? indexSrc.slice(healthAt, mcpAt) : "";
  check(
    "P2-296 wiring: /api/health publishes the three additive voice fields from the hatch-aware sttStatus()",
    health.includes("const stt = sttStatus();") &&
      health.includes("voiceState: stt.state") &&
      health.includes("voiceMessage: stt.message") &&
      health.includes("voiceCheckedAt: readinessCheckedAt(readinessState.transcription.probedAt)"),
  );
  check(
    "P2-296 wiring: the voice fields are appended after the existing health fields — none renamed, removed or repositioned",
    [
      "docConvertState: docConvert.state",
      "docConvertMessage: docConvert.message",
      "docConvertExts: docConvert.exts",
      'docConvertCheckedAt: readinessCheckedAt(readinessState["doc-convert"].probedAt)',
      "browseState: browseCap.state",
      "browseMessage: browseCap.message",
      "browseCheckedAt: readinessCheckedAt(readinessState.browse.probedAt)",
      "voiceState: stt.state",
    ].every((f, i, arr) => health.includes(f) && (i === 0 || health.indexOf(arr[i - 1]) < health.indexOf(f))),
  );
  check(
    "P2-296 wiring: the lazy transcription re-probe runs in the health block, under the shared readiness policy",
    health.includes("await maybeReprobeTranscription();") &&
      health.indexOf("await maybeReprobeBrowse();") < health.indexOf("await maybeReprobeTranscription();") &&
      health.indexOf("await maybeReprobeTranscription();") < health.indexOf("const stt = sttStatus();") &&
      indexSrc.includes("readinessRefreshPlan(") &&
      indexSrc.includes("parseReadinessKnobs(process.env)"),
  );
  check("P2-296 wiring: no periodic timer in the health block", !/setInterval|setTimeout/.test(health));

  const getAt = indexSrc.indexOf('req.path === "/__ocr/settings" && req.method === "GET"');
  const patchAt = indexSrc.indexOf('req.path === "/__ocr/settings" && req.method === "PATCH"');
  const handler = getAt >= 0 && patchAt > getAt ? indexSrc.slice(getAt, patchAt) : "";
  check(
    "P2-296 wiring: the settings GET handler sources the voice pair through settingsMirror",
    handler.includes("...settingsMirror({") &&
      handler.indexOf("opencode: {") < handler.indexOf("voiceState: stt.state") &&
      handler.indexOf("voiceState: stt.state") < handler.indexOf("voiceMessage: stt.message"),
  );
  check(
    "P2-296 wiring: no existing settings field is renamed, removed or repositioned",
    handler.indexOf("...readSettings()") < handler.indexOf("version: VERSION") &&
      handler.indexOf("version: VERSION") < handler.indexOf("opencodeVersion: opencodeVersion") &&
      handler.indexOf("opencodeVersion: opencodeVersion") < handler.indexOf("disk: diskStatus()") &&
      handler.indexOf("disk: diskStatus()") < handler.indexOf("...settingsMirror({") &&
      handler.indexOf("...settingsMirror({") < handler.indexOf("relay: {") &&
      handler.indexOf("relay: {") < handler.indexOf("opencode: {") &&
      handler.indexOf("opencode: {") < handler.indexOf("voiceState: stt.state"),
  );
  check(
    "P2-296 wiring: the lazy transcription re-probe runs in the settings handler before the mirror answers",
    handler.includes("await maybeReprobeTranscription();") &&
      handler.indexOf("await maybeReprobeBrowse();") < handler.indexOf("await maybeReprobeTranscription();") &&
      handler.indexOf("await maybeReprobeTranscription();") < handler.indexOf("...settingsMirror({"),
  );
  check(
    "P2-296 wiring: no new periodic timer — the handlers have none and the daemon keeps exactly the five pre-existing ones",
    !/setInterval|setTimeout/.test(handler) && (indexSrc.match(/setInterval\(/g) || []).length === 5,
  );
  check(
    "P2-296 wiring: no new re-probe log line — each re-probe keeps its one-line policy (four capabilities total, P2-298 added tts)",
    indexSrc.split("\n").filter((l) => l.includes("readiness re-probe")).length === 4,
  );
}

// --- P2-300: the spoken-reply (tts) verdict rides the same pure module -----
// Portable twin of the unit.test.ts block (P2-237 sub-battery): the same
// cases, the same fixtures — the two phrases are the ttscap.ts constants
// verbatim, and the dirty phrase is what a leak would look like.
{
  const TTS = {
    ready: "Respostas faladas prontas neste computador.",
    missingTool:
      "A fala deste computador ainda não está instalada — peça a quem gerencia a máquina para instalar o recurso de voz.",
  };
  const DOC300 = {
    complete: "Conversão de documentos em PDF pronta neste computador.",
    partial:
      "A conversão de documentos neste computador cobre apenas alguns formatos — instale o LibreOffice para converter qualquer documento em PDF.",
  };
  const BROWSE300 = {
    ready: "Navegação de sites pronta neste computador.",
    noBrowser:
      "Este computador ainda não tem navegador para abrir sites — instalar o navegador do Playwright é opcional e fica a cargo de quem gerencia a máquina.",
  };
  const VOICE300 = {
    ready: "Transcrição de voz pronta neste computador.",
    missingBinary:
      "A transcrição de voz ainda não está instalada neste computador — peça a quem gerencia a máquina para instalar o recurso de voz.",
  };
  const RELAY_DOWN_300 = { ok: false, reason: "Endereço do relay recusado na partida — recusando discar (fail-closed)" };
  const AGENT_PATH_300 = { binaryFound: true, binarySource: "path" };

  // rule 1 — absent input, non-object input, non-textual tts field
  check(
    "P2-300 rule 1: missing or non-object input yields no tts field",
    json(settingsMirror()) === "{}" &&
      json(settingsMirror(undefined)) === "{}" &&
      json(settingsMirror(null)) === "{}" &&
      ["tts snapshot", 42, true, [], ["ready"]].every((v) => json(settingsMirror(v)) === "{}"),
  );
  check(
    "P2-300 rule 1: a non-textual tts field never becomes a field",
    json(settingsMirror({ ttsState: 42, ttsMessage: TTS.ready })) === "{}" &&
      json(settingsMirror({ ttsState: true, ttsMessage: TTS.ready })) === "{}" &&
      json(settingsMirror({ ttsState: "ready", ttsMessage: null })) === "{}" &&
      json(settingsMirror({ ttsState: ["ready"], ttsMessage: TTS.ready })) === "{}",
  );

  // rule 2 — speech verdicts outside the documented table yield no field
  check(
    "P2-300 rule 2: speech verdicts outside the documented table yield no field",
    ["warp-speed", "", "Ready", "missing_tool", "ready ", "unavailable", "missing-binary"].every(
      (state) => json(settingsMirror({ ttsState: state, ttsMessage: TTS.ready })) === "{}",
    ),
  );

  // rule 3 — a never-measured speech capability stays silent (fail-closed)
  check(
    "P2-300 rule 3: a never-measured speech capability yields no field instead of one announcing readiness",
    json(settingsMirror({ ttsState: "unknown", ttsMessage: TTS.ready })) === "{}" &&
      json(settingsMirror({ ttsMessage: TTS.ready })) === "{}",
  );

  // rule 4 — each of the two documented verdicts becomes exactly state +
  // phrase, verbatim, the same names and values /api/health publishes
  check(
    "P2-300 rule 4: each documented speech verdict becomes exactly state + phrase, verbatim",
    json(settingsMirror({ ttsState: "ready", ttsMessage: TTS.ready })) ===
      json({ ttsState: "ready", ttsMessage: TTS.ready }) &&
      json(settingsMirror({ ttsState: "missing-tool", ttsMessage: TTS.missingTool })) ===
        json({ ttsState: "missing-tool", ttsMessage: TTS.missingTool }),
  );

  // privacy boundary proven against a leak-shaped input: the phrase carries
  // an absolute tool path, a script name and a port — the whole speech
  // verdict stays silent (the measured doc capability is unaffected)
  const dirty300 =
    "Fala instalada em /usr/local/bin/edge-tts — rode scripts/setup-tts.sh no host e confira a porta 8792";
  const dirtyOut300 = settingsMirror({
    ttsState: "ready",
    ttsMessage: dirty300,
    docConvertState: "partial",
    docConvertMessage: DOC300.partial,
  });
  check(
    "P2-300 privacy: a speech phrase carrying an absolute tool path, script name and port silences the verdict",
    json(dirtyOut300) === json({ docConvertState: "partial", docConvertMessage: DOC300.partial }),
  );

  // the six capabilities together — the P2-288/P2-292/P2-296 mirrorings keep
  // their exact names, values and order, and the speech pair appends last
  const six300 = settingsMirror({
    docConvertState: "complete",
    docConvertMessage: DOC300.complete,
    browseState: "ready",
    browseMessage: BROWSE300.ready,
    relay: RELAY_DOWN_300,
    opencode: AGENT_PATH_300,
    voiceState: "missing-binary",
    voiceMessage: VOICE300.missingBinary,
    ttsState: "missing-tool",
    ttsMessage: TTS.missingTool,
  });
  check(
    "P2-300: the six capabilities coexist and the P2-288/P2-292/P2-296 mirroring loses no field",
    json(six300) ===
      json({
        docConvertState: "complete",
        docConvertMessage: DOC300.complete,
        browseState: "ready",
        browseMessage: BROWSE300.ready,
        relay: RELAY_DOWN_300,
        opencode: AGENT_PATH_300,
        voiceState: "missing-binary",
        voiceMessage: VOICE300.missingBinary,
        ttsState: "missing-tool",
        ttsMessage: TTS.missingTool,
      }) &&
      Object.keys(six300).join(",") ===
        "docConvertState,docConvertMessage,browseState,browseMessage,relay,opencode,voiceState,voiceMessage,ttsState,ttsMessage",
  );

  // rule order proven: a measured speech capability and an out-of-table
  // capability coexist (and the mirror image of that case)
  const orderTts300 = settingsMirror({ ttsState: "ready", ttsMessage: TTS.ready, relay: { ok: 1, reason: null } });
  const orderDoc300 = settingsMirror({
    ttsState: "warp-speed",
    ttsMessage: TTS.ready,
    docConvertState: "partial",
    docConvertMessage: DOC300.partial,
  });
  check(
    "P2-300 rule order: a measured speech capability and an out-of-table capability coexist (and vice versa)",
    json(orderTts300) === json({ ttsState: "ready", ttsMessage: TTS.ready }) &&
      json(orderDoc300) === json({ docConvertState: "partial", docConvertMessage: DOC300.partial }),
  );

  // rule 5 — the same input yields the identical result on two calls
  const ttsSnap300 = {
    docConvertState: "partial",
    docConvertMessage: DOC300.partial,
    browseState: "no-browser",
    browseMessage: BROWSE300.noBrowser,
    relay: RELAY_DOWN_300,
    opencode: AGENT_PATH_300,
    voiceState: "missing-binary",
    voiceMessage: VOICE300.missingBinary,
    ttsState: "missing-tool",
    ttsMessage: TTS.missingTool,
  };
  check(
    "P2-300 rule 5: the same input yields the identical result on two calls",
    json(settingsMirror(ttsSnap300)) === json(settingsMirror(ttsSnap300)),
  );

  // robustness — no input shape ever throws
  let threw300 = false;
  try {
    for (const input of [NaN, new Date(), () => 1, { ttsState: {} }, { ttsMessage: Symbol("x") }, { ttsState: "ready" }]) {
      settingsMirror(input);
    }
  } catch {
    threw300 = true;
  }
  check("P2-300 robustness: no input shape ever throws", !threw300);

  // the real sources: module purity, the speech table and daemon wiring
  const mirrorSrc300 = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "settingsmirror.ts"), "utf8");
  const mirrorCode300 = mirrorSrc300
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  check(
    "P2-300 purity: settingsmirror.ts still imports no node:fs, node:http, node:child_process or fetch",
    !/^import\b/m.test(mirrorCode300) &&
      !mirrorCode300.includes("node:fs") &&
      !mirrorCode300.includes("node:http") &&
      !mirrorCode300.includes("node:child_process") &&
      !mirrorCode300.includes("fetch") &&
      !mirrorSrc300.includes("require("),
  );
  check(
    "P2-300 boundary: the module documents the speech table and the voiceState collision",
    mirrorSrc300.includes('const TTS_STATES: readonly string[] = ["ready", "missing-tool"];') &&
      mirrorSrc300.includes("speech (tts):") &&
      mirrorSrc300.includes("NOT voiceState") &&
      mirrorSrc300.includes("ttsState?: string") &&
      mirrorSrc300.includes("ttsMessage?: string"),
  );

  const indexSrc300 = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
  const healthAt = indexSrc300.indexOf('seg[1] === "health"');
  const mcpAt = indexSrc300.indexOf('seg[1] === "mcp"');
  const health = healthAt >= 0 && mcpAt > healthAt ? indexSrc300.slice(healthAt, mcpAt) : "";
  check(
    "P2-300 wiring: /api/health publishes the three additive speech fields from the hatch-aware ttsStatus()",
    health.includes("const tts = ttsStatus();") &&
      health.includes("ttsState: tts.state") &&
      health.includes("ttsMessage: tts.message") &&
      health.includes("ttsCheckedAt: readinessCheckedAt(readinessState.tts.probedAt)"),
  );
  check(
    "P2-300 wiring: the identifier does not collide — voiceState stays transcription, ttsState is speech",
    health.includes("voiceState: stt.state") &&
      health.includes("ttsState: tts.state") &&
      !health.includes("voiceState: tts.") &&
      !health.includes("ttsState: stt."),
  );
  check(
    "P2-300 wiring: the speech fields are appended after the existing health fields — none renamed, removed or repositioned",
    [
      "docConvertState: docConvert.state",
      "docConvertMessage: docConvert.message",
      "docConvertExts: docConvert.exts",
      'docConvertCheckedAt: readinessCheckedAt(readinessState["doc-convert"].probedAt)',
      "browseState: browseCap.state",
      "browseMessage: browseCap.message",
      "browseCheckedAt: readinessCheckedAt(readinessState.browse.probedAt)",
      "voiceState: stt.state",
      "voiceMessage: stt.message",
      "voiceCheckedAt: readinessCheckedAt(readinessState.transcription.probedAt)",
      "ttsState: tts.state",
      "ttsMessage: tts.message",
      "ttsCheckedAt: readinessCheckedAt(readinessState.tts.probedAt)",
    ].every((f, i, arr) => health.includes(f) && (i === 0 || health.indexOf(arr[i - 1]) < health.indexOf(f))),
  );
  check(
    "P2-300 wiring: the lazy tts re-probe runs in the health block, under the shared readiness policy",
    health.includes("maybeReprobeTts();") &&
      health.indexOf("await maybeReprobeTranscription();") < health.indexOf("maybeReprobeTts();") &&
      health.indexOf("maybeReprobeTts();") < health.indexOf("const tts = ttsStatus();") &&
      indexSrc300.includes("readinessRefreshPlan(") &&
      indexSrc300.includes("parseReadinessKnobs(process.env)"),
  );
  check("P2-300 wiring: no periodic timer in the health block", !/setInterval|setTimeout/.test(health));

  const getAt300 = indexSrc300.indexOf('req.path === "/__ocr/settings" && req.method === "GET"');
  const patchAt300 = indexSrc300.indexOf('req.path === "/__ocr/settings" && req.method === "PATCH"');
  const handler300 = getAt300 >= 0 && patchAt300 > getAt300 ? indexSrc300.slice(getAt300, patchAt300) : "";
  check(
    "P2-300 wiring: the settings GET handler sources the speech pair through settingsMirror",
    handler300.includes("...settingsMirror({") &&
      handler300.indexOf("voiceMessage: stt.message") < handler300.indexOf("ttsState: tts.state") &&
      handler300.indexOf("ttsState: tts.state") < handler300.indexOf("ttsMessage: tts.message") &&
      !handler300.includes("voiceState: tts."),
  );
  check(
    "P2-300 wiring: no existing settings field is renamed, removed or repositioned",
    handler300.indexOf("...readSettings()") < handler300.indexOf("version: VERSION") &&
      handler300.indexOf("version: VERSION") < handler300.indexOf("opencodeVersion: opencodeVersion") &&
      handler300.indexOf("opencodeVersion: opencodeVersion") < handler300.indexOf("disk: diskStatus()") &&
      handler300.indexOf("disk: diskStatus()") < handler300.indexOf("...settingsMirror({") &&
      handler300.indexOf("...settingsMirror({") < handler300.indexOf("relay: {") &&
      handler300.indexOf("relay: {") < handler300.indexOf("opencode: {") &&
      handler300.indexOf("opencode: {") < handler300.indexOf("voiceState: stt.state") &&
      handler300.indexOf("voiceState: stt.state") < handler300.indexOf("ttsState: tts.state"),
  );
  check(
    "P2-300 wiring: the lazy tts re-probe runs in the settings handler before the mirror answers",
    handler300.includes("maybeReprobeTts();") &&
      handler300.indexOf("await maybeReprobeTranscription();") < handler300.indexOf("maybeReprobeTts();") &&
      handler300.indexOf("maybeReprobeTts();") < handler300.indexOf("...settingsMirror({"),
  );
  check(
    "P2-300 wiring: no new periodic timer — the handlers have none and the daemon keeps exactly the five pre-existing ones",
    !/setInterval|setTimeout/.test(handler300) && (indexSrc300.match(/setInterval\(/g) || []).length === 5,
  );
  check(
    "P2-300 wiring: no new re-probe log line — each re-probe keeps its one-line policy (four capabilities total)",
    indexSrc300.split("\n").filter((l) => l.includes("readiness re-probe")).length === 4,
  );
}

if (failures > 0) {
  console.error(`SETTINGS MIRROR TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("SETTINGS MIRROR TESTS PASSED");
process.exit(0);
