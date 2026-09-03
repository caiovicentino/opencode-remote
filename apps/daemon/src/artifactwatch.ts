// P2-090: artifact auto-open — the daemon watches the artifacts root and emits
// a synthetic `session.artifact` event (sessionID, name, kind, path) whenever
// the agent writes a file, so the desktop ChatView can raise the P2-062
// split-pane on the turn's session.idle without manual navigation.
// Pure helpers live in their own module (same pattern as preview.ts /
// localws.ts: index.ts runs main() on import, so testable logic goes here).

import { lstatSync, mkdirSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { kindFor, validSegment } from "./artifacts.js";

export interface ArtifactWrite {
  sessionID: string;
  name: string;
  kind: string;
  /** absolute path of the written file (inside the artifacts root) */
  path: string;
}

/**
 * Parse a changed path under `root` into an artifact write; null when the
 * path is not `<root>/<sessionID>/<name>` with safe segments, is not a
 * regular file (symlinks are never followed), or escapes the root. Mirrors
 * the read-side validation of artifacts.ts.
 */
export function artifactFromPath(root: string, changed: string): ArtifactWrite | null {
  const base = resolve(root);
  let abs: string;
  try {
    abs = resolve(base, changed);
  } catch {
    return null;
  }
  // defense in depth: the changed path must stay inside the root
  if (abs !== base && !abs.startsWith(base + "/")) return null;
  const rel = abs.slice(base.length + 1);
  const parts = rel.split(/[/\\]/);
  if (parts.length !== 2) return null; // exactly <sessionID>/<name>
  const sessionID = parts[0];
  const name = parts[1];
  if (!sessionID || !name) return null;
  if (!validSegment(sessionID) || !validSegment(name)) return null;
  try {
    // lstat: a symlink pointing anywhere must not be announced as an artifact
    if (!lstatSync(abs).isFile()) return null;
  } catch {
    return null; // deleted between the event and the stat
  }
  return { sessionID, name, kind: kindFor(name), path: abs };
}

/** size:mtime fingerprint; a file re-emitted with the same fingerprint is a
 * duplicate watch event, not a new write. */
function fingerprint(abs: string): string | null {
  try {
    const st = lstatSync(abs);
    return st.isFile() ? `${st.size}:${st.mtimeMs}` : null;
  } catch {
    return null;
  }
}

/**
 * Watches <root>/<sessionID>/ directories (flat: artifacts are single files)
 * plus the root itself so session dirs created at runtime get picked up.
 * Writes are debounced until they settle, then deduped by fingerprint, so
 * chunked/sidecar writes (edit-in-place, atomic rename) emit exactly one
 * event per real change. Files that already exist when a watcher attaches
 * are marked as seen silently — only writes that happen during this
 * daemon's lifetime are announced.
 */
export class ArtifactWatcher {
  private rootWatcher: FSWatcher | null = null;
  private readonly dirWatchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly seen = new Map<string, string>();
  private stopped = false;

  constructor(
    private readonly root: string,
    private readonly onArtifact: (a: ArtifactWrite) => void,
    private readonly settleMs = 400,
  ) {}

  start(): void {
    if (this.stopped) return;
    try {
      mkdirRecursive(this.root);
    } catch {
      return; // unwritable homedir — artifacts stay list-only
    }
    for (const ent of safeReaddir(this.root)) {
      // boot scan: pre-existing artifacts are marked seen, never announced
      if (ent.isDir) this.attach(ent.name, false);
    }
    try {
      this.rootWatcher = watch(this.root, { persistent: false }, (_event, file) => {
        // a child dir appearing under the root is a new session's artifacts dir
        const name = file ?? "";
        if (name && validSegment(name) && !this.dirWatchers.has(name)) {
          this.attach(name, true); // created after boot: announce what's inside
        }
      });
    } catch {
      // root vanished between mkdir and watch — list-only fallback
    }
  }

  stop(): void {
    this.stopped = true;
    this.rootWatcher?.close();
    this.rootWatcher = null;
    for (const w of this.dirWatchers.values()) {
      try {
        w.close();
      } catch {}
    }
    this.dirWatchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.seen.clear();
  }

  /** Watch one session dir; when `announce` is true, files already present
   * are emitted (the dir was created after boot, so any content is fresh). */
  private attach(sessionID: string, announce: boolean): void {
    if (this.stopped || this.dirWatchers.has(sessionID)) return;
    const dir = join(this.root, sessionID);
    if (!isDirectory(dir)) return;
    for (const ent of safeReaddir(dir)) {
      if (ent.isDir) continue; // artifacts are flat files
      const abs = join(dir, ent.name);
      const fp = fingerprint(abs);
      if (!fp) continue;
      const key = `${sessionID}\u0000${ent.name}`;
      if (announce && !this.seen.has(key)) {
        const write = artifactFromPath(this.root, abs);
        if (write) this.onArtifact(write);
      }
      this.seen.set(key, fp);
    }
    try {
      const w = watch(dir, { persistent: false }, (_event, file) => {
        if (file) this.schedule(sessionID, file);
      });
      w.on("error", () => this.detach(sessionID));
      this.dirWatchers.set(sessionID, w);
    } catch {
      // dir deleted under us or too many watchers — the root watcher retries
    }
  }

  private detach(sessionID: string): void {
    const w = this.dirWatchers.get(sessionID);
    this.dirWatchers.delete(sessionID);
    try {
      w?.close();
    } catch {}
  }

  /** Debounce one changed file: emit only after the write settles and only
   * when the fingerprint actually changed. */
  private schedule(sessionID: string, name: string): void {
    const key = `${sessionID}\u0000${name}`;
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (this.stopped) return;
        const abs = join(this.root, sessionID, name);
        const fp = fingerprint(abs);
        if (!fp || this.seen.get(key) === fp) return;
        this.seen.set(key, fp);
        const write = artifactFromPath(this.root, abs);
        if (write) this.onArtifact(write);
      }, this.settleMs),
    );
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(path: string): { name: string; isDir: boolean }[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return [];
  }
}

function mkdirRecursive(path: string): void {
  mkdirSync(path, { recursive: true });
}
