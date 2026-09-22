import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { log } from "./log";

export interface MetricDef {
  name: string;
  help: string;
  type: "counter" | "gauge";
  value?: number;
}

const defs = new Map<string, MetricDef>();

function def(name: string, help: string, type: MetricDef["type"]) {
  if (!defs.has(name)) defs.set(name, { name, help, type, value: 0 });
  return defs.get(name)!;
}

export const metrics = {
  inc(name: string, by = 1) {
    def(name, "", "counter").value = (defs.get(name)!.value ?? 0) + by;
  },
  gauge(name: string, value: number) {
    def(name, "", "gauge").value = value;
  },
  get(name: string): number {
    return defs.get(name)?.value ?? 0;
  },
  describe(name: string, help: string, type: MetricDef["type"]) {
    def(name, help, type);
  },
};

const startedAt = Date.now();
// Bundled builds (desktop sidecar, apps/desktop/scripts/bundle-daemon.mjs)
// bake the version in via esbuild --define: there is no package.json next to
// the single-file bundle. Source checkouts keep reading it from the monorepo.
declare const OCR_DAEMON_VERSION: string | undefined;

export const VERSION =
  typeof OCR_DAEMON_VERSION !== "undefined"
    ? OCR_DAEMON_VERSION
    : (
        JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
          version: string;
        }
      ).version;

/** text/plain exposition format (Prometheus-compatible) */
function promText(): string {
  let out = "";
  for (const d of defs.values()) {
    if (d.help) out += `# HELP ${d.name} ${d.help}\n`;
    out += `# TYPE ${d.name} ${d.type}\n`;
    out += `${d.name} ${d.value}\n`;
  }
  return out;
}

function snapshot() {
  const o: Record<string, number> = {};
  for (const d of defs.values()) o[d.name] = d.value ?? 0;
  return {
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    version: VERSION,
    ...o,
  };
}

/**
 * Exponential backoff (ms) for the bind retry: 2s, 4s, 8s, 16s, 32s, then a
 * flat 60s cap. Pure so the unit suite can pin the schedule without opening
 * sockets.
 */
export function bindBackoffMs(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
}

/**
 * Starts the loopback server; returns it so shutdown can close it (P2-020).
 *
 * The port can be busy at boot: the desktop shell may hold :8792 with its own
 * sidecar while the launchd daemon starts (the exact race that left a daemon
 * running WITHOUT its API forever — un-adoptable by the shell, invisible to
 * every local surface, and the reason a stale sidecar used to split the
 * machine into two daemons). The bind now retries with backoff until the
 * squatter exits, then takes the port and becomes adoptable. Only EADDRINUSE
 * retries; any other listen error keeps the old single log line.
 */
export function startMetricsServer(port: number, api?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>): Server {
  const server = createHttpServer(async (req, res) => {
    if (req.url?.startsWith("/metrics")) {
      const body = req.url.includes("format=prom") ? promText() : JSON.stringify(snapshot(), null, 2);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
      return;
    }
    if (api && req.url && (await api(req, res, new URL(req.url, "http://127.0.0.1")))) return;
    res.writeHead(404).end();
  });
  let bound = false;
  let attempt = 0;
  const listen = () => {
    server.listen(port, "127.0.0.1", () => {
      bound = true;
      log("info", "metrics server listening", { port, bind: "127.0.0.1", attempts: attempt });
    });
  };
  server.on("error", (err) => {
    // A runtime error after a successful bind is not a bind failure — never
    // re-listen a server that is already serving (double-listen would throw).
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && !bound) {
      attempt++;
      const delay = bindBackoffMs(attempt);
      log("warn", "metrics port busy — retrying bind", { port, attempt, retryInMs: delay });
      setTimeout(listen, delay);
      return;
    }
    log("info", "metrics server unavailable", { error: (err as Error).message });
  });
  listen();
  return server;
}
