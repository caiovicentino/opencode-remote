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

if (failures > 0) {
  console.error(`SETTINGS MIRROR TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("SETTINGS MIRROR TESTS PASSED");
process.exit(0);
