/**
 * P2-090: artifact auto-open — daemon watcher + client pairing logic.
 * Run: npx tsx scripts/artifact-auto.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactFromPath, ArtifactWatcher } from "../apps/daemon/src/artifactwatch";
import { artifactKindFor, consumeArtifactEvents } from "../apps/web/src/lib/artifactAuto";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// --- artifactFromPath (daemon side: path → event payload) ---------------------

const root = mkdtempSync(join(tmpdir(), "ocr-artifact-auto-"));
const sesDir = join(root, "ses_abc123");
mkdirSync(sesDir);
writeFileSync(join(sesDir, "index.html"), "<h1>oi</h1>");

{
  const parsed = artifactFromPath(root, join(sesDir, "index.html"));
  check(
    "valid path parses into sessionID/name/kind",
    !!parsed &&
      parsed.sessionID === "ses_abc123" &&
      parsed.name === "index.html" &&
      parsed.kind === "html" &&
      parsed.path === join(sesDir, "index.html"),
    JSON.stringify(parsed),
  );
  check(
    "relative path resolves against the root",
    artifactFromPath(root, "ses_abc123/index.html")?.name === "index.html",
  );
  writeFileSync(join(sesDir, "x.md"), "# md");
  check("md extension maps to kind md", artifactFromPath(root, "ses_abc123/x.md")?.kind === "md");
  check("file at the root (no session dir) is ignored", artifactFromPath(root, "loose.html") === null);
  check("deeper nesting is ignored", artifactFromPath(root, "ses_abc123/sub/x.html") === null);
  check(
    "invalid session segment is ignored",
    artifactFromPath(root, join(root, ".hidden/x.html")) === null,
  );
  const outside = mkdtempSync(join(tmpdir(), "ocr-artifact-out-"));
  writeFileSync(join(outside, "evil.html"), "x");
  check("path outside the root is ignored", artifactFromPath(root, join(outside, "evil.html")) === null);
  rmSync(outside, { recursive: true, force: true });
  try {
    symlinkSync(join(sesDir, "index.html"), join(sesDir, "link.html"));
    check("symlink is never announced as an artifact", artifactFromPath(root, join(sesDir, "link.html")) === null);
  } catch {}
  rmSync(join(sesDir, "index.html"));
  check("deleted file is ignored (stat race)", artifactFromPath(root, join(sesDir, "index.html")) === null);
}

// --- consumeArtifactEvents (web side: write + idle → open) --------------------

{
  const st = { pending: null as string | null };
  const r1 = consumeArtifactEvents(
    [
      { type: "session.artifact", properties: { sessionID: "s1", name: "index.html" } },
      { type: "session.idle", properties: { sessionID: "s1" } },
    ],
    "s1",
    st,
  );
  check("artifact followed by idle opens the pane", r1.open === "index.html" && st.pending === null);

  st.pending = null;
  const r2 = consumeArtifactEvents([{ type: "session.idle", properties: { sessionID: "s1" } }], "s1", st);
  check("idle without a write never opens", r2.open === null);

  st.pending = null;
  const r3 = consumeArtifactEvents(
    [
      { type: "session.artifact", properties: { sessionID: "s1", name: "a.html" } },
      { type: "session.artifact", properties: { sessionID: "s1", name: "b.csv" } },
      { type: "session.idle", properties: { sessionID: "s1" } },
    ],
    "s1",
    st,
  );
  check("several writes in one turn: the newest wins", r3.open === "b.csv");

  st.pending = null;
  const r4 = consumeArtifactEvents(
    [
      { type: "session.artifact", properties: { sessionID: "other", name: "x.html" } },
      { type: "session.idle", properties: { sessionID: "other" } },
    ],
    "s1",
    st,
  );
  check("other sessions' events never interfere", r4.open === null && st.pending === null);

  st.pending = null;
  const r5 = consumeArtifactEvents(
    [
      { type: "session.artifact", properties: { sessionID: "s1", name: "a.html" } },
      { type: "session.idle", properties: { sessionID: "s1" } },
      { type: "session.idle", properties: { sessionID: "s1" } },
    ],
    "s1",
    st,
  );
  check("two idles after one write consume the pending artifact once", r5.open === "a.html" && st.pending === null);

  st.pending = null;
  const r6 = consumeArtifactEvents(
    [
      { type: "session.artifact", properties: { sessionID: "s1", name: "new.md" } },
      { type: "session.idle", properties: { sessionID: "s1" } },
      { type: "session.artifact", properties: { sessionID: "s1", name: "later.md" } },
    ],
    "s1",
    st,
  );
  check("a write after the idle re-arms for the next idle", r6.open === "new.md" && st.pending === "later.md");

  check(
    "kind mirror: html/md/csv/pdf/image/text/binary",
    artifactKindFor("a.htm") === "html" &&
      artifactKindFor("b.markdown") === "md" &&
      artifactKindFor("c.csv") === "csv" &&
      artifactKindFor("d.pdf") === "pdf" &&
      artifactKindFor("e.png") === "image" &&
      artifactKindFor("f.json") === "text" &&
      artifactKindFor("g.exe") === "binary",
  );
}

// --- ArtifactWatcher (integration, tmp dir) -----------------------------------

async function waitEvent(events: string[], name: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (events.includes(name)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

{
  const wroot = join(root, "watch");
  mkdirSync(join(wroot, "ses_old"), { recursive: true });
  writeFileSync(join(wroot, "ses_old", "stale.html"), "pre-existing");
  const events: string[] = [];
  const watcher = new ArtifactWatcher(wroot, (a) => events.push(`${a.sessionID}/${a.name}`), 60);
  watcher.start();
  // let the boot scan settle
  await new Promise((r) => setTimeout(r, 150));
  check("pre-existing artifact is never announced at boot", events.length === 0, JSON.stringify(events));

  writeFileSync(join(wroot, "ses_old", "report.md"), "# v1");
  const gotFirst = await waitEvent(events, "ses_old/report.md", 2_000);
  check("new write is announced once", gotFirst && events.length === 1, JSON.stringify(events));

  // rapid double write coalesces into one event (debounce + fingerprint)
  writeFileSync(join(wroot, "ses_old", "report.md"), "# v2\nlonger");
  writeFileSync(join(wroot, "ses_old", "report.md"), "# v2\nlonger!");
  await waitEvent(events, "ses_old/report.md@v2", 2_000);
  const v2Count = events.filter((e) => e === "ses_old/report.md").length;
  check(
    "chunked rewrite settles into one announcement per change",
    v2Count === 2 && events.length === 2,
    JSON.stringify(events),
  );

  // a session dir created at runtime gets picked up by the root watcher
  mkdirSync(join(wroot, "ses_new"));
  writeFileSync(join(wroot, "ses_new", "index.html"), "<h1>fresh</h1>");
  const gotNew = await waitEvent(events, "ses_new/index.html", 3_000);
  check("session dir created after boot is watched (race-free)", gotNew, JSON.stringify(events));

  watcher.stop();
  writeFileSync(join(wroot, "ses_old", "after-stop.html"), "x");
  await new Promise((r) => setTimeout(r, 250));
  check("stop() silences the watcher", events.length === 3, JSON.stringify(events));
}

rmSync(root, { recursive: true, force: true });

console.log(failures === 0 ? "artifact auto: all green" : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
