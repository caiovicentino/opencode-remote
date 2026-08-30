import { createServer as createHttpServer } from "node:http";
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
export const VERSION = (
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

export function startMetricsServer(port: number) {
  const server = createHttpServer((req, res) => {
    if (req.url?.startsWith("/metrics")) {
      const body = req.url.includes("format=prom") ? promText() : JSON.stringify(snapshot(), null, 2);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1", () => {
    log("info", "metrics server listening", { port, bind: "127.0.0.1" });
  });
  server.on("error", (err) => {
    log("info", "metrics server unavailable", { error: (err as Error).message });
  });
}
