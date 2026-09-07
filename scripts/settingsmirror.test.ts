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

if (failures > 0) {
  console.error(`SETTINGS MIRROR TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("SETTINGS MIRROR TESTS PASSED");
process.exit(0);
