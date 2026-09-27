// P2-110 (eval-19): GET /api/pilot-stream — Server-Sent Events for the pilot
// dashboard. docs/torre-de-controle.md PR2, re-scoped by what is true today:
//
//   snapshot  once per connection: the last events + the status digest
//   pilot     one frame per new events.jsonl line (tail-follow, ~100 ms)
//   status    the /api/pilot-status digest every 15 s — liveness heartbeat
//
// The spec's `agent` channel (live tokens/tool calls of the pilot's agents
// relayed from forwardEvents) is NOT here: its premise is false. The pilot
// runs `opencode run` without --attach, so every agent lives on its own
// in-process server; the daemon's /event subscription to :4096 never sees
// them (measured 2026-09-27 on opencode 1.18.32: two servers sharing one data
// dir share sessions but not the bus). The narration the pilot already writes
// to events.jsonl (`agent` events) flows through the `pilot` channel.
//
// events.ts rewrites the file IN PLACE when it trims (same inode, the size
// does not necessarily shrink), so neither offsets nor inodes detect the
// rewrite: the follower re-reads the bounded file on change and resumes after
// the last delivered line, found by content (falling back to ts order when it
// was trimmed away). EventSource cannot send headers, so the route rides the
// ocr_session cookie (POST /api/session) — the token never goes in a URL.
import { readFileSync, watch, statSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/** One SSE frame. Multi-line data is split into `data:` lines per the spec. */
export function sseFrame(event: string, data: unknown, id?: string): string {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  let out = `event: ${event}\n`;
  if (id) out += `id: ${id.replace(/[\r\n]/g, "")}\n`;
  for (const line of body.split("\n")) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** Events the snapshot carries — the same tail /api/pilot-events serves. */
export const SNAPSHOT_EVENTS = 200;

function lineTs(line: string): string | null {
  try {
    const ts = (JSON.parse(line) as { ts?: unknown }).ts;
    return typeof ts === "string" ? ts : null;
  } catch {
    return null;
  }
}

/**
 * Follows a JSONL file that is appended to and occasionally rewritten in
 * place. `read` returns the whole current text (null = missing). `prime()`
 * marks what exists as seen; each `poll()` returns only the complete lines
 * written since the previous call — never a duplicate, never a torn line.
 */
export class EventsFollower {
  private last: string | null = null;
  private lastTs: string | null = null;
  constructor(private readonly read: () => string | null) {}

  private lines(): string[] {
    const text = this.read();
    if (!text) return [];
    const all = text.split("\n");
    // a line without its newline is still being written: hold it back
    if (!text.endsWith("\n")) all.pop();
    return all.filter(Boolean);
  }

  prime(): void {
    const lines = this.lines();
    this.last = lines[lines.length - 1] ?? "";
    this.lastTs = this.last ? lineTs(this.last) : null;
  }

  poll(): string[] {
    const lines = this.lines();
    if (this.last === null) {
      this.prime();
      return [];
    }
    let fresh: string[];
    const at = this.last ? lines.lastIndexOf(this.last) : -1;
    if (at >= 0) fresh = lines.slice(at + 1);
    else if (this.lastTs) {
      const since = this.lastTs;
      fresh = lines.filter((l) => {
        const ts = lineTs(l);
        return ts !== null && ts > since;
      });
    } else fresh = lines; // nothing delivered yet: everything is new
    if (lines.length) {
      this.last = lines[lines.length - 1]!;
      this.lastTs = lineTs(this.last) ?? this.lastTs;
    }
    return fresh;
  }
}

export interface PilotStreamDeps {
  /** events.jsonl path */
  eventsFile: string;
  readEvents: () => string | null;
  /** first frame of every connection */
  snapshot: () => Promise<unknown>;
  /** periodic `status` frame (the /api/pilot-status digest) */
  status: () => Promise<unknown>;
  statusEveryMs?: number;
  /** debounce between a file change and the read */
  coalesceMs?: number;
  /** a client that cannot drain for this long is dropped */
  stallMs?: number;
  maxClients?: number;
  /** fallback stat poll when fs.watch is unavailable or silent */
  pollMs?: number;
  onClients?: (n: number) => void;
  /** injectable for tests */
  watchFile?: (file: string, onChange: () => void) => () => void;
}

interface Client {
  res: ServerResponse;
  blockedSince: number | null;
}

/** fs.watch on the parent dir (survives rename/recreate) + a stat poll. */
function defaultWatch(file: string, onChange: () => void, pollMs: number): () => void {
  let watcher: FSWatcher | null = null;
  try {
    const name = basename(file);
    watcher = watch(dirname(file), (_kind, f) => {
      if (!f || String(f) === name) onChange();
    });
    watcher.on("error", () => {});
  } catch {
    watcher = null;
  }
  let sig = "";
  const timer = setInterval(() => {
    try {
      const st = statSync(file);
      const next = `${st.mtimeMs}:${st.size}`;
      if (next !== sig) {
        sig = next;
        onChange();
      }
    } catch {
      // file not there yet
    }
  }, pollMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    try {
      watcher?.close();
    } catch {
      // already closed
    }
  };
}

export function createPilotStream(deps: PilotStreamDeps) {
  const clients = new Set<Client>();
  const statusEveryMs = deps.statusEveryMs ?? 15_000;
  const coalesceMs = deps.coalesceMs ?? 100;
  const stallMs = deps.stallMs ?? 5_000;
  const maxClients = deps.maxClients ?? 8;
  const follower = new EventsFollower(deps.readEvents);
  let unwatch: (() => void) | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const report = () => deps.onClients?.(clients.size);

  function drop(c: Client) {
    if (!clients.delete(c)) return;
    try {
      c.res.end();
    } catch {
      // socket already gone
    }
    report();
    if (clients.size === 0) stop();
  }

  function write(c: Client, chunk: string) {
    if (c.res.writableEnded || c.res.destroyed) return drop(c);
    if (c.blockedSince !== null && Date.now() - c.blockedSince > stallMs) {
      c.res.destroy();
      return drop(c);
    }
    const ok = c.res.write(chunk);
    if (!ok && c.blockedSince === null) {
      c.blockedSince = Date.now();
      c.res.once("drain", () => {
        c.blockedSince = null;
      });
    }
  }

  function broadcast(chunk: string) {
    for (const c of [...clients]) write(c, chunk);
  }

  function flush() {
    pending = null;
    const lines = follower.poll();
    if (!lines.length || !clients.size) return;
    let chunk = "";
    for (const line of lines) chunk += sseFrame("pilot", line, lineTs(line) ?? undefined);
    broadcast(chunk);
  }

  function onChange() {
    if (pending === null) pending = setTimeout(flush, coalesceMs);
  }

  async function pushStatus() {
    if (!clients.size) return;
    try {
      broadcast(sseFrame("status", await deps.status()));
    } catch {
      // a failed digest skips one beat; the next one retries
    }
  }

  function start() {
    follower.prime();
    unwatch = (deps.watchFile ?? ((f, cb) => defaultWatch(f, cb, deps.pollMs ?? 1_000)))(deps.eventsFile, onChange);
    statusTimer = setInterval(() => void pushStatus(), statusEveryMs);
    statusTimer.unref?.();
  }

  function stop() {
    unwatch?.();
    unwatch = null;
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    if (pending) clearTimeout(pending);
    pending = null;
  }

  return {
    /** Serve one EventSource connection (auth is the caller's job). */
    async attach(_req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (clients.size >= maxClients) {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "10" });
        res.end(JSON.stringify({ error: "too many stream clients" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 3000\n\n");
      const client: Client = { res, blockedSince: null };
      // the follower is primed BEFORE the snapshot is read, so a line landing
      // in between is delivered twice at worst — never lost; the dashboard's
      // ingest() already dedupes an overlapping tail
      if (clients.size === 0) start();
      clients.add(client);
      report();
      // the RESPONSE closes with the connection — req "close" fires as soon
      // as a GET's (empty) body is consumed on modern Node
      res.on("close", () => drop(client));
      try {
        write(client, sseFrame("snapshot", await deps.snapshot()));
      } catch {
        write(client, sseFrame("snapshot", { events: [], status: null }));
      }
    },
    clients: () => clients.size,
    /** Forces a read now (tests; also usable after an external write). */
    flush,
    close() {
      for (const c of [...clients]) drop(c);
      stop();
    },
  };
}

export type PilotStream = ReturnType<typeof createPilotStream>;

/**
 * The daemon's stream over the real ~/.opencode-remote/pilot/events.jsonl:
 * snapshot = the last SNAPSHOT_EVENTS events + the status digest.
 */
export function createDefaultPilotStream(opts: {
  status: () => Promise<unknown>;
  onClients?: (n: number) => void;
  home?: string;
}): PilotStream {
  const eventsFile = join(opts.home ?? homedir(), ".opencode-remote", "pilot", "events.jsonl");
  const readEvents = () => {
    try {
      return readFileSync(eventsFile, "utf8");
    } catch {
      return null;
    }
  };
  return createPilotStream({
    eventsFile,
    readEvents,
    status: opts.status,
    onClients: opts.onClients,
    snapshot: async () => {
      const events: unknown[] = [];
      for (const line of (readEvents() ?? "").split("\n").filter(Boolean).slice(-SNAPSHOT_EVENTS)) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // torn line: skipped
        }
      }
      return { events, status: await opts.status() };
    },
  });
}
