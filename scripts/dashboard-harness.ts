/**
 * eval-19 — headless harness for the orbital dashboard: runs the REAL page
 * script of apps/pilot/dashboard/mission-v3.html in real mode against a stub
 * DOM (class lists that behave), a stub canvas and injected fetch /
 * EventSource / setTimeout, so tests assert what the operator would see.
 * Used by scripts/dashboard-status.test.ts and scripts/pilot-stream.test.ts.
 */
import { readFileSync } from "node:fs";

export interface HarnessEl {
  id: string;
  textContent: string;
  innerHTML: string;
  title: string;
  className: string;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): boolean; contains(c: string): boolean };
  style: Record<string, string>;
  dataset: Record<string, string>;
  value: string;
  disabled: boolean;
  addEventListener(): void;
  querySelector(sel: string): HarnessEl;
  querySelectorAll(): HarnessEl[];
  focus(): void;
}

export interface FetchReply {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchStub = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchReply>;

export interface Dashboard {
  el(id: string): HarnessEl;
  /** the page's `world` object */
  world: Record<string, unknown>;
  /** the page's live heartbeat-pulse ring queue (fx.pulses) — the core's
   * visual heartbeat; empty means the pilot's verdict is suppressing it */
  pulses: { t: number }[];
  /** page functions exposed for the test */
  fn: Record<string, (...args: unknown[]) => unknown>;
  /** every setTimeout the page scheduled: [delayMs] (never run automatically) */
  timeouts: number[];
  /** runs queued animation frames */
  frames(n: number): void;
  flush(): Promise<void>;
  /** puts back the globals the page needed (timers, fetch, EventSource) */
  restore(): void;
}

const html = readFileSync(new URL("../apps/pilot/dashboard/mission-v3.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
/** the page's main script, exactly as served */
export const DASHBOARD_SCRIPT = scripts[scripts.length - 1]!;
/** the page source, for static assertions */
export const DASHBOARD_HTML = html;

export const json = (status: number, body: unknown): FetchReply => ({ ok: status < 400, status, json: async () => body });

export async function loadDashboard(opts: { fetch: FetchStub; EventSource?: unknown; token?: string | null }): Promise<Dashboard> {
  const authored = new Map<string, string>();
  for (const m of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) authored.set(m[2]!, /\bclass="([^"]*)"/.exec(m[0])?.[1] ?? "");
  const els = new Map<string, HarnessEl>();
  const el = (id: string): HarnessEl => {
    const hit = els.get(id);
    if (hit) return hit;
    const classes = new Set((authored.get(id) ?? "").split(/\s+/).filter(Boolean));
    const kids = new Map<string, HarnessEl>();
    const e: HarnessEl = {
      id,
      textContent: "",
      innerHTML: "",
      title: "",
      get className() {
        return [...classes].join(" ");
      },
      set className(v: string) {
        classes.clear();
        for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c);
      },
      classList: {
        add: (c) => void classes.add(c),
        remove: (c) => void classes.delete(c),
        toggle: (c, on) => {
          const want = on === undefined ? !classes.has(c) : on;
          if (want) classes.add(c);
          else classes.delete(c);
          return want;
        },
        contains: (c) => classes.has(c),
      },
      style: {},
      dataset: {},
      value: "",
      disabled: false,
      addEventListener() {},
      querySelector(sel: string) {
        let k = kids.get(sel);
        if (!k) {
          k = el(`${id}>${sel}`);
          kids.set(sel, k);
        }
        return k;
      },
      querySelectorAll: () => [],
      focus() {},
    };
    els.set(id, e);
    return e;
  };
  const noop = () => {};
  const ctx2d = () =>
    new Proxy({} as Record<string, unknown>, {
      get(t, k) {
        if (k === "measureText") return () => ({ width: 50 });
        if (k === "createRadialGradient" || k === "createLinearGradient") return () => ({ addColorStop: noop });
        if (k === "fillText")
          return (s: unknown) => {
            if (typeof s === "string" && /NaN|undefined/.test(s)) throw new Error("bad label: " + s);
          };
        if (k in t) return t[k as string];
        return noop;
      },
      set(t, k, v) {
        t[k as string] = v;
        return true;
      },
    });
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { setTimeout: g.setTimeout, clearTimeout: g.clearTimeout, fetch: g.fetch, EventSource: g.EventSource };
  g.window = g;
  g.self = g;
  g.location = { search: "", pathname: "/dashboard" };
  g.history = { replaceState: noop };
  const token = opts.token === undefined ? "test-token" : opts.token;
  g.localStorage = { getItem: (k: string) => (k === "ocr_dash_token" ? token : null), setItem: noop };
  g.matchMedia = () => ({ matches: true }); // reduced motion: deterministic painter
  g.innerWidth = 1440;
  g.innerHeight = 900;
  g.devicePixelRatio = 2;
  const canvas = { ...el("scene"), width: 0, height: 0, getContext: () => ctx2d() };
  g.document = {
    getElementById: (id: string) => (id === "scene" ? canvas : el(id)),
    createElement: () => ({ getContext: () => ctx2d(), width: 0, height: 0 }),
    body: el("body"),
    activeElement: el("x"),
  };
  g.addEventListener = noop;
  const rafs: ((t: number) => void)[] = [];
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    rafs.push(cb);
  };
  const timeouts: number[] = [];
  g.setTimeout = (_fn: unknown, ms?: number) => {
    timeouts.push(Number(ms ?? 0));
    return timeouts.length;
  };
  g.clearTimeout = noop;
  g.fetch = opts.fetch;
  g.EventSource = opts.EventSource;
  const expose = ["renderHud", "loadStatus", "openStatus", "startStream", "ingest", "poll", "corePilotDownFn", "coreHbLabel", "pulseWanted"];
  const src = `${DASHBOARD_SCRIPT}\n;globalThis.__dash = { world, pulses: (typeof fx !== "undefined" && fx.pulses) ? fx.pulses : [], fn: { ${expose.map((f) => `${f}: typeof ${f} === "function" ? ${f} : undefined`).join(", ")} } };`;
  new Function(src)();
  const dash = g.__dash as { world: Record<string, unknown>; pulses?: { t: number }[]; fn: Record<string, (...args: unknown[]) => unknown> };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  await flush();
  return {
    el,
    world: dash.world,
    pulses: dash.pulses ?? [],
    fn: dash.fn,
    timeouts,
    frames(n: number) {
      for (let i = 0; i < n && rafs.length; i++) rafs.shift()!(16 * (i + 1));
    },
    flush,
    restore() {
      Object.assign(g, saved);
    },
  };
}
