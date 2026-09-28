import { useCallback, useEffect, useMemo, useState } from "react";
import { humanizeError } from "../lib/errors";
import { useT } from "../lib/i18n";
import { IconArrowLeft, IconRadar } from "./icons";

/**
 * Mission Control (P2-048): navigable post-mortem for the pilot's autonomous
 * runs — one card per agent task (goal, progress, effort, ETA) and a forensic
 * timeline fed by the daemon's /api/pilot-forensic surface, which parses the
 * real pilot.log + events.jsonl. Shots are the post-deploy captures from
 * pilot/shots; the "live" button reuses the daemon's /api/browse surface
 * (tools/browse.mjs machinery) for a fresh screenshot of the dashboard.
 */

export type DaemonApiFn = (
  req: { path: string; method?: string; body?: unknown },
) => Promise<{ status: number; contentType: string; body: string } | null>;

export type BrowseFn = (
  req: { path: string; method?: string; body?: unknown },
) => Promise<{ status: number; contentType: string; body: string } | null>;

/** Sealed-tunnel request (App.request) — the phone's only path to the daemon. */
export type TunnelRequest = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * EVAL4-B (fable r4, product track): Mission Control on the phone. The pane
 * used to dead-end without the desktop bridge ("open the app on the host
 * machine"). This adapter maps the loopback /api paths the pane speaks onto
 * the daemon's sealed /__ocr/pilot-* routes so the SAME loaders work over
 * the E2E tunnel. Host-only actions (takeover, shots, live browse) stay
 * desktop-only and answer 501 here — the UI hides them on the phone.
 */
export function tunnelApi(request: TunnelRequest): DaemonApiFn {
  return async ({ path, method }) => {
    const url = new URL(path, "http://x");
    const seg = url.pathname.split("/").filter(Boolean); // ["api", "pilot-forensic", "timeline"?]
    let res: { status: number; body: unknown };
    if (seg[1] === "pilot-forensic" && (method ?? "GET") === "GET") {
      const task = seg[2] === "timeline" ? (url.searchParams.get("task") ?? "") : "";
      res = await request("GET", "/__ocr/pilot-forensic", undefined, task ? { task } : undefined);
    } else if (seg[1] === "pilot-mission" && (method ?? "GET") === "GET") {
      res = await request("GET", "/__ocr/pilot-mission");
    } else if (seg[1] === "pilot-status" && (method ?? "GET") === "GET") {
      res = await request("GET", "/__ocr/pilot-status");
    } else if (seg[1] === "mission" && method === "DELETE") {
      res = await request("DELETE", "/__ocr/mission");
    } else {
      res = { status: 501, body: { error: "host-only" } };
    }
    return { status: res.status, contentType: "application/json", body: utf8ToB64(JSON.stringify(res.body ?? {})) };
  };
}

interface SessionCard {
  id: string;
  title: string;
  status: "running" | "merged" | "failed";
  startedAt?: string;
  durationMs?: number;
  rounds?: number;
  gateFails: number;
  decisions: number;
  effortMin: number | null;
  etaMs: number | null;
  mergeSha?: string;
  progress?: number;
  shots: string[];
}

interface TimelineEntry {
  ts: string;
  kind: "phase" | "decision" | "gate" | "review" | "deploy" | "result" | "scribe";
  text: string;
  round?: number;
  ok?: boolean;
  step?: string;
  tail?: string;
}

/** Read-only view of ~/.opencode-remote/mission.json (set from the chat only). */
interface MissionSpecView {
  prompt?: string;
  repoUrl?: string;
  /** v2: per-role model pins (role -> provider/model). */
  models?: Record<string, string>;
  setAt?: string;
}

/** A pinned model the pilot could not dispatch (GET /api/pilot-mission `modelSubstitutions`). */
export interface ModelSubstitutionView {
  role: string;
  wanted: string;
  usedInstead: string;
}

/** One-line `role: wanted -> usedInstead` rendering of the substitutions ("" when none). */
export function formatModelSubstitutions(subs: ModelSubstitutionView[] | undefined | null): string {
  if (!Array.isArray(subs)) return "";
  return subs
    .filter((s) => s && typeof s.role === "string" && typeof s.wanted === "string" && typeof s.usedInstead === "string")
    .map((s) => `${s.role}: ${s.wanted} -> ${s.usedInstead}`)
    .join(", ");
}

/** One-line `role=model` rendering of the v2 model pins ("" when none). */
export function formatMissionModels(models: Record<string, string> | undefined | null): string {
  if (!models || typeof models !== "object") return "";
  return Object.entries(models)
    .filter(([, m]) => typeof m === "string" && m)
    .map(([r, m]) => `${r}=${m}`)
    .join(", ");
}

/**
 * eval-19: the daemon's fleet status digest (GET /api/pilot-status; the phone
 * reads the sealed /__ocr/pilot-status). Only the fields this pane renders.
 */
export interface FleetStatusView {
  /** digest contract version (isFleetStatusView accepts exactly v:1) */
  v?: number;
  installed: boolean;
  pilot: { state: "alive" | "stale" | "down" | "absent"; heartbeatAgeMs: number | null; since: string | null; silentForMs?: number | null };
  deploy: { behind: number | null; behindTotal?: number | null; pendingSince: string | null; hold: { reason: string; count: number } | null };
  disk: { freeBytes: number | null; minFreeBytes: number };
  queue: { ready: number; blocked: number };
  cost: { week: { merges: number; tokens: number; usd: number | null; unpricedTokens: number } };
  alerts: { undelivered: number };
  attention: { kind: string; level: "critical" | "warn" }[];
}

/**
 * eval-19 fix-round: only a digest with EVERY section this pane reads is
 * accepted — the same contract as the dashboard's acceptStatus. The old load
 * accepted any JSON carrying `installed` + `attention[]` and the render then
 * read pilot/deploy/disk/queue/cost.week/alerts unguarded, so a digest from an
 * older or newer daemon (say, one whose cost.week has no `usd`) crashed the
 * WHOLE pane (`Cannot read properties of undefined (reading 'toFixed')`) and
 * the 6s poll kept failing — a wrong digest must degrade to the previous view,
 * never take the pane down.
 */
export function isFleetStatusView(d: unknown): d is FleetStatusView {
  if (!d || typeof d !== "object") return false;
  const s = d as Record<string, unknown>;
  if (s.v !== 1) return false;
  if (typeof s.installed !== "boolean" || !Array.isArray(s.attention)) return false;
  const okState = (x: unknown) => x === "alive" || x === "stale" || x === "down" || x === "absent";
  const obj = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
  const p = s.pilot;
  if (!obj(p) || !okState((p as Record<string, unknown>).state)) return false;
  const dep = s.deploy;
  if (!obj(dep)) return false;
  const dd = dep as Record<string, unknown>;
  if (dd.behind !== null && dd.behind !== undefined && typeof dd.behind !== "number") return false;
  if (dd.pendingSince !== null && dd.pendingSince !== undefined && typeof dd.pendingSince !== "string") return false;
  if (dd.hold !== null && dd.hold !== undefined && (!obj(dd.hold) || typeof (dd.hold as Record<string, unknown>).reason !== "string")) return false;
  const disk = s.disk;
  if (!obj(disk) || typeof (disk as Record<string, unknown>).minFreeBytes !== "number") return false;
  const df = (disk as Record<string, unknown>).freeBytes;
  if (df !== null && df !== undefined && typeof df !== "number") return false;
  const q = s.queue;
  if (!obj(q) || typeof (q as Record<string, unknown>).ready !== "number" || typeof (q as Record<string, unknown>).blocked !== "number") return false;
  const cost = s.cost;
  const week = cost && obj(cost) ? (cost as Record<string, unknown>).week : undefined;
  if (!obj(week)) return false;
  const usd = (week as Record<string, unknown>).usd;
  if (usd !== null && usd !== undefined && typeof usd !== "number") return false;
  const alerts = s.alerts;
  if (!obj(alerts) || typeof (alerts as Record<string, unknown>).undelivered !== "number") return false;
  return true;
}

/** One line of the fleet strip: an attention item or the all-clear. */
export interface FleetLine {
  key: string;
  level: "critical" | "warn" | "ok";
  text: string;
}

/** Compact span: 40s · 12min · 5.0h · 3.2d. */
export function fmtSpan(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  if (ms < 48 * 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

/** Bytes as GB with one decimal (the deploy guard's own unit). */
export function fmtGB(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Token counts: 845k · 12.3M · 1.3B. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return `${Math.max(1, Math.round(n / 1e3))}k`;
}

/**
 * eval-19: a "running" card of a pilot that is down is not running — the
 * forensic cards of P2-356/P2-357 said "running · ETA 0s" for days after the
 * process died on 24/09. Only a verdict of "down" re-labels; unknown keeps
 * the forensic status as-is.
 */
export function cardDisplayStatus(
  status: SessionCard["status"],
  pilot: FleetStatusView["pilot"]["state"] | undefined,
): SessionCard["status"] | "stalled" {
  return status === "running" && pilot === "down" ? "stalled" : status;
}

/** The strip's lines: every attention flag in the digest's order, or the all-clear. */
export function fleetLines(s: FleetStatusView, t: TFn): FleetLine[] {
  if (!s.installed) return [];
  const out: FleetLine[] = [];
  for (const f of s.attention ?? []) {
    let text = "";
    // silence counts from the pilot's last sign of life (a pid-dead verdict
    // dates it from the last recorded activity, not a foreign heartbeat touch)
    const silent = s.pilot.silentForMs ?? s.pilot.heartbeatAgeMs;
    if (f.kind === "pilot-down") text = t("fleetPilotDown", { span: fmtSpan(silent), when: fmtDateTime(s.pilot.since ?? undefined) || "—" });
    else if (f.kind === "pilot-stale") text = t("fleetPilotStale", { span: fmtSpan(silent) });
    else if (f.kind === "deploy-lag") text = t("fleetProdBehind", { n: s.deploy.behind ?? 0, when: fmtDateTime(s.deploy.pendingSince ?? undefined) || "—" });
    else if (f.kind === "deploy-hold" && s.deploy.hold) {
      const back = s.deploy.hold.reason === "disk-guard" && s.disk.freeBytes !== null && s.disk.freeBytes >= s.disk.minFreeBytes;
      text = back
        ? t("fleetDeployHoldResolved", { reason: s.deploy.hold.reason, free: fmtGB(s.disk.freeBytes) })
        : t("fleetDeployHold", { reason: s.deploy.hold.reason });
    } else if (f.kind === "disk-low") text = t("fleetDiskLow", { free: fmtGB(s.disk.freeBytes), min: fmtGB(s.disk.minFreeBytes) });
    else if (f.kind === "alerts-undelivered") text = t("fleetAlerts", { n: s.alerts.undelivered });
    if (text) out.push({ key: f.kind, level: f.level, text });
  }
  if (out.length === 0 && s.pilot.state === "alive") {
    out.push({ key: "ok", level: "ok", text: s.deploy.behind === 0 ? `${t("fleetPilotAlive")} · ${t("fleetProdCurrent")}` : t("fleetPilotAlive") });
  }
  return out;
}

/** The strip's quiet facts line: queue, disk, week cost (never a fake $0).
 * `usd` is read only when it really is a number — an undefined one (a digest
 * shape drift) must degrade to the token count, not throw. */
export function fleetFacts(s: FleetStatusView, t: TFn): string {
  const w = s.cost.week;
  const cost = typeof w.usd === "number" ? `US$ ${w.usd.toFixed(2)}` : w.tokens > 0 ? t("fleetCostUnpriced", { tokens: fmtTokens(w.tokens) }) : "0";
  return t("fleetFacts", { ready: s.queue.ready, blocked: s.queue.blocked, free: fmtGB(s.disk.freeBytes), cost });
}

type KindFilter = "all" | "decision" | "gate" | "deploy" | "review";

const KIND_FILTERS: KindFilter[] = ["all", "decision", "gate", "review", "deploy"];

function fmtDur(ms: number | undefined | null, t: (k: string) => string): string {
  if (ms === undefined || ms === null) return "—";
  const min = Math.round(ms / 60_000);
  if (min >= 60) return `${(min / 60).toFixed(1)}h`;
  if (min >= 1) return `${min} ${t("unitMin")}`;
  return `${Math.round(ms / 1000)}s`;
}

function fmtClock(ts: string | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function fmtDateTime(ts: string | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

async function decode(
  r: { status: number; contentType: string; body: string } | null,
): Promise<{ json?: Record<string, unknown>; png?: string }> {
  if (!r) throw new Error("daemon unreachable");
  if (r.contentType.includes("image/png")) return { png: r.body };
  const buf = window.atob(r.body);
  const bytes = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) bytes[i] = buf.charCodeAt(i);
  const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (r.status >= 400 || json.error) throw new Error(String(json.error ?? `HTTP ${r.status}`));
  return { json };
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// P3-381: the paired desktop world used to paint the internal throws verbatim
// in red ("daemon unreachable", "HTTP 502") — only the phone got localized
// copy. The view's own known throw resolves to the calm load-failed key, a
// string the shared humanizer recognizes keeps its dedicated copy, and
// everything else degrades to that same localized sentence — never a bare
// English literal.
export function missionErrorText(raw: string, t: TFn): string {
  if (/daemon unreachable/i.test(raw)) return t("missionLoadFailed");
  const humanized = humanizeError(raw, t);
  return humanized === raw ? t("missionLoadFailed") : humanized;
}

export default function MissionControlView({
  daemonApi: bridgeApi,
  browse,
  onBack,
  request,
  prePairing,
}: {
  daemonApi: DaemonApiFn | null;
  browse: BrowseFn | null;
  onBack: () => void;
  /** EVAL4-B: sealed tunnel (phone). Used only when the bridge is absent. */
  request?: TunnelRequest;
  /** P3-327: mounted behind the unpaired first-boot gate — a dead daemon is
   * the expected state there, so a failed load answers with the calm empty
   * world (forensic view, empty list) instead of the paired-shell red error,
   * and the dashboard/live actions that need the daemon stay hidden. */
  prePairing?: boolean;
}) {
  const t = useT();
  // EVAL4-B: phone = no desktop bridge; the sealed tunnel takes its place for
  // the read-only loaders and the mission clear. Stable identity per request.
  const phone = !bridgeApi && !!request;
  const daemonApi = useMemo<DaemonApiFn | null>(
    () => bridgeApi ?? (request ? tunnelApi(request) : null),
    [bridgeApi, request],
  );
  const [cards, setCards] = useState<SessionCard[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [shots, setShots] = useState<string[]>([]);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [error, setError] = useState("");
  // P3-377: the cards load failing is the pane's guided dead-daemon state —
  // distinct from the generic error line (timeline/takeover/live failures).
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [taking, setTaking] = useState(false);
  const [taken, setTaken] = useState<string | null>(null);
  const [liveShot, setLiveShot] = useState<string | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  // P2-123 follow-up: the pane's main surface is the LIVE orbital dashboard
  // (the same /dashboard/v3 the browser shows), embedded with self-auth via
  // the desktop bridge's local link. The forensic timeline stays one toggle away.
  const [view, setView] = useState<"dash" | "forensic">(bridgeApi && !prePairing ? "dash" : "forensic");
  const [dashUrl, setDashUrl] = useState<string | null>(null);
  // Self-serve mission: undefined = not loaded yet, null = none set.
  const [mission, setMission] = useState<MissionSpecView | null | undefined>(undefined);
  const [modelSubs, setModelSubs] = useState<ModelSubstitutionView[]>([]);
  // eval-19: fleet status digest (liveness, deploy lag/hold, disk, cost, alerts)
  const [fleet, setFleet] = useState<FleetStatusView | null>(null);
  // eval-19: the pilot.json mission the fleet actually runs when mission.json
  // holds no valid spec — the card used to say "no mission" meanwhile
  const [legacyMission, setLegacyMission] = useState("");
  // Mission v2 clear path: two-click confirm ("End mission" → "Confirm") so a
  // stray click never deletes the mission; the status line reports the result.
  const [clearArmed, setClearArmed] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearStatus, setClearStatus] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const bridge = (window as unknown as { ocrDesktop?: { getLocalLink?: () => Promise<{ port: number; token: string } | null> } }).ocrDesktop;
    bridge?.getLocalLink?.().then((link) => {
      if (alive && link?.port && link?.token) {
        setDashUrl(`http://127.0.0.1:${link.port}/dashboard/v3?token=${encodeURIComponent(link.token)}`);
      }
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const loadCards = useCallback(async () => {
    if (!daemonApi) return;
    try {
      const { json } = await decode(await daemonApi({ path: "/api/pilot-forensic" }));
      const list = (json?.cards as SessionCard[]) ?? [];
      setCards(list);
      setError("");
      setLoadFailed(false);
      setSelected((cur) => (cur && list.some((c) => c.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch (err) {
      // P3-327: behind the gate a dead daemon is the expected state — render
      // the calm empty world instead of the paired-shell red error line.
      if (prePairing) {
        setCards([]);
        setError("");
        setLoadFailed(false);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setLoadFailed(true);
    }
  }, [daemonApi, prePairing]);

  const loadMission = useCallback(async () => {
    if (!daemonApi) return;
    try {
      const { json } = await decode(await daemonApi({ path: "/api/pilot-mission" }));
      const spec = json?.spec as MissionSpecView | null | undefined;
      setMission(spec && typeof spec === "object" ? spec : null);
      setLegacyMission(!(spec && typeof spec === "object") && typeof json?.mission === "string" ? json.mission.trim() : "");
      const subs = json?.modelSubstitutions;
      setModelSubs(Array.isArray(subs) ? (subs as ModelSubstitutionView[]) : []);
    } catch {
      // best-effort: the cards error surface already reports a dead daemon.
      // P3-327: behind the gate a failed probe IS the "no mission yet" state —
      // otherwise the placeholder ellipsis would spin forever.
      if (prePairing) setMission(null);
    }
  }, [daemonApi, prePairing]);

  const loadFleet = useCallback(async () => {
    if (!daemonApi) return;
    try {
      const { json } = await decode(await daemonApi({ path: "/api/pilot-status" }));
      // only a digest with every section the strip reads is accepted — an
      // older/newer daemon's other shape keeps the previous view instead of
      // crashing the whole pane (fleetFacts used to throw on cost.week.usd)
      if (isFleetStatusView(json)) setFleet(json);
    } catch {
      // best-effort: an older daemon has no digest route and a dead one is
      // already reported by the cards' guided down state — keep the last view
    }
  }, [daemonApi]);

  const loadTimeline = useCallback(async (task: string) => {
    if (!daemonApi) return;
    try {
      const { json } = await decode(
        await daemonApi({ path: `/api/pilot-forensic/timeline?task=${encodeURIComponent(task)}` }),
      );
      setEntries((json?.entries as TimelineEntry[]) ?? []);
      setShots((json?.shots as string[]) ?? []);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [daemonApi]);

  useEffect(() => {
    if (!daemonApi) return;
    void loadCards();
    void loadMission();
    void loadFleet();
    const iv = setInterval(() => {
      void loadCards();
      void loadMission();
      void loadFleet();
    }, 6_000);
    return () => clearInterval(iv);
  }, [daemonApi, loadCards, loadMission, loadFleet]);

  useEffect(() => {
    if (selected) void loadTimeline(selected);
  }, [selected, loadTimeline]);

  /** P3-377: the guided dead-daemon state's manual escape — one click reloads
   * everything the pane reads, instead of waiting for the next 6s poll. */
  const retryLoad = useCallback(async () => {
    setRetrying(true);
    try {
      await Promise.all([
        loadCards(),
        loadMission(),
        loadFleet(),
        selected ? loadTimeline(selected) : Promise.resolve(),
      ]);
    } finally {
      setRetrying(false);
    }
  }, [loadCards, loadMission, loadFleet, loadTimeline, selected]);

  async function takeover(task: string) {
    if (!daemonApi) return;
    setTaking(true);
    setTaken(null);
    try {
      const { json } = await decode(
        await daemonApi({ path: "/api/pilot-takeover", method: "POST", body: { task } }),
      );
      setTaken(json?.ok ? t("missionTakenOver") : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTaking(false);
    }
  }

  /** Mission v2: DELETE /api/mission (auth-gated like POST) removes mission.json;
   * the pilot's drift check then self-restarts back to self-improvement mode. */
  async function clearMission() {
    if (!daemonApi) return;
    if (!clearArmed) {
      setClearArmed(true);
      setClearStatus(null);
      return;
    }
    setClearBusy(true);
    try {
      await decode(await daemonApi({ path: "/api/mission", method: "DELETE" }));
      setMission(null);
      setClearStatus(t("missionCleared"));
    } catch {
      setClearStatus(t("missionClearFailed"));
    } finally {
      setClearBusy(false);
      setClearArmed(false);
    }
  }

  /** P2-048 spec: reuse the browse.mjs surface for a fresh live shot. */
  async function liveShotNow() {
    if (!browse) return;
    setLiveBusy(true);
    try {
      await browse({ path: "/api/browse/open", method: "POST", body: { url: "http://127.0.0.1:8792/dashboard" } });
      const shot = await decode(await browse({ path: "/api/browse/screenshot" }));
      if (shot.png) setLiveShot(`data:image/png;base64,${shot.png}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLiveBusy(false);
    }
  }

  const filtered = useMemo(
    () => (filter === "all" ? entries : entries.filter((e) => e.kind === filter)),
    [entries, filter],
  );

  if (!daemonApi) {
    return (
      <div className="screen">
        <header>
          {onBack && <button className="pane-back" onClick={onBack} aria-label={t("back")}><IconArrowLeft /></button>}
          <h1 className="pane-title">{t("navMission")}</h1>
        </header>
        <div className="list">
          <p className="muted" style={{ padding: 16 }}>
            {t("missionDesktopOnly")}
          </p>
        </div>
      </div>
    );
  }

  // P3-444: the mission card renders in two worlds — the cards column of the
  // forensic grid (once sessions exist) and the centered empty world (while
  // they don't) — so the mission state and its clear action stay reachable in
  // both instead of being orphaned by the collapse.
  const missionCard = (
    <div className="mission-active" data-mission={mission ? "set" : "none"}>
      <span className="mission-active-label">{mission ? t("missionActive") : t("missionLabel")}</span>
      {mission ? (
        <>
          {mission.prompt && <p className="mission-active-text">{mission.prompt}</p>}
          {mission.repoUrl && (
            <p className="mission-active-src">
              {t("missionSourceRepo")}: {mission.repoUrl}
            </p>
          )}
          {formatMissionModels(mission.models) && (
            <p className="mission-active-src" data-mission-models>
              {t("missionModels")}: {formatMissionModels(mission.models)}
            </p>
          )}
          {formatModelSubstitutions(modelSubs) && (
            <p className="mission-active-src mission-bad" data-mission-model-subst>
              {t("missionModelSubstituted")}: {formatModelSubstitutions(modelSubs)}
            </p>
          )}
          <p className="mission-active-src">
            {t("missionSource")}:{" "}
            {[mission.prompt ? t("missionSourcePrompt") : "", mission.repoUrl ? t("missionSourceRepo") : ""]
              .filter(Boolean)
              .join(" + ")}
            {fmtDateTime(mission.setAt) ? ` · ${t("missionSetAt")} ${fmtDateTime(mission.setAt)}` : ""}
          </p>
          <div className="mission-active-actions">
            <button
              type="button"
              onClick={() => void clearMission()}
              disabled={clearBusy}
              aria-label={clearArmed ? t("missionClearConfirm") : t("missionClear")}
            >
              {clearBusy ? "…" : clearArmed ? t("missionClearConfirm") : t("missionClear")}
            </button>
          </div>
        </>
      ) : (
        /* P3-446: behind the gate the chat is the pane that needs
            pairing — the empty card points at the after-pairing world
            instead of the unreachable "define it in the chat". */
        legacyMission ? (
          <>
            <p className="mission-active-text" data-mission-legacy>{legacyMission}</p>
            <p className="mission-active-src">{t("missionLegacySource")}</p>
          </>
        ) : (
          <p className="mission-active-note">
            {mission === null ? t(prePairing ? "missionActiveNonePrePairing" : "missionActiveNone") : "…"}
          </p>
        )
      )}
      {clearStatus && <p className="mission-active-status">{clearStatus}</p>}
    </div>
  );

  return (
    <div className="screen mission">
      <header>
        {onBack && <button className="pane-back" onClick={onBack} aria-label={t("back")}><IconArrowLeft /></button>}
        <h1 className="pane-title">{t("navMission")}</h1>
        {!phone && !prePairing && (
          <>
            <button className={view === "dash" ? "on" : ""} onClick={() => setView("dash")} aria-label={t("missionDash")}>
              {t("missionDash")}
            </button>
            <button
              className={view === "forensic" ? "on" : ""}
              onClick={() => setView("forensic")}
              aria-label={t("missionForensic")}
            >
              {t("missionForensic")}
            </button>
          </>
        )}
        {browse && !prePairing && (
          <button onClick={() => void liveShotNow()} disabled={liveBusy} aria-label="live dashboard shot">
            {liveBusy ? "…" : t("missionLive")}
          </button>
        )}
      </header>
      {fleet?.installed && !prePairing && (phone || view === "forensic") && (
        // eval-19: the pane used to list a dead pilot's cards as "running" with
        // no word about the pilot, the deploy lag, the disk hold or the alerts
        // nobody received — the digest's attention flags lead the pane now.
        <section className="fleet-strip" aria-label={t("fleetTitle")} data-fleet={fleet.attention[0]?.level ?? "ok"}>
          {fleetLines(fleet, t).map((l) => (
            <p key={l.key} className={`fleet-line fleet-${l.level}`} data-kind={l.key}>
              <span className="fleet-dot" aria-hidden="true" />
              {l.text}
            </p>
          ))}
          <p className="fleet-facts">{fleetFacts(fleet, t)}</p>
        </section>
      )}
      {phone && <p className="muted mission-phone-intro">{t("missionPhoneIntro")}</p>}
      {error && phone && <p className="mission-error">{t("missionLoadFailed")}</p>}
      {loadFailed && !phone && (
        // P3-377: the old lone red "daemon unreachable" line — English in a
        // pt-BR app, no way out — becomes a guided state: what broke, the
        // auto-reload promise, the reconnect card beside the pane, and a
        // manual retry that skips the wait for the next poll.
        <div className="mission-down" role="note">
          <p className="mission-down-title">{t("missionDownTitle")}</p>
          <p className="mission-down-detail">{t("missionDownDetail")}</p>
          <p className="mission-down-detail">{t("missionDownHint")}</p>
          <div className="mission-down-actions">
            <button type="button" onClick={() => void retryLoad()} disabled={retrying}>
              {retrying ? "…" : t("missionDownRetry")}
            </button>
          </div>
        </div>
      )}
      {error && !phone && !loadFailed && (
        // P3-381: remaining failures (timeline, takeover, live) keep the
        // humanized single line — sentinel throws resolve to dedicated keys.
        <p className="mission-error">{missionErrorText(error, t)}</p>
      )}
      {view === "dash" && dashUrl && (
        <iframe
          src={dashUrl}
          title={t("navMission")}
          style={{ flex: 1, width: "100%", border: "0", background: "var(--bg)" }}
        />
      )}
      {view === "forensic" && (cards !== null && cards.length === 0 ? (
        // P3-444: with zero sessions the forensic grid kept its two columns —
        // the cards' border-right painted a full-height divider beside a dead
        // half-pane (explorer journey shot). Until the first session card
        // exists the pane collapses to one centered empty world, the same
        // composed browser/artifacts pattern; the mission card rides below so
        // its state and clear action never orphan.
        <div className="mission-empty">
          <div className="mission-empty-stack">
            <span className="mission-empty-icon" aria-hidden="true">
              <IconRadar />
            </span>
            <p className="mission-empty-title">{t("missionEmpty")}</p>
            <p className="mission-empty-hint">{t("missionEmptyHint")}</p>
          </div>
          {missionCard}
        </div>
      ) : (
      <div className="mission-grid">
        <div className="mission-cards" role="list">
          {missionCard}
          {cards === null && <p className="muted" style={{ padding: 12 }}>{t("missionLoading")}</p>}
          {(cards ?? []).map((c) => (
            <button
              key={c.id}
              role="listitem"
              className={`mission-card${selected === c.id ? " sel" : ""}`}
              onClick={() => setSelected(c.id)}
            >
              <div className="mission-card-top">
                <span className="mission-id">{c.id}</span>
                <span className={`mission-st st-${cardDisplayStatus(c.status, fleet?.pilot.state)}`}>
                  {t(`missionSt_${cardDisplayStatus(c.status, fleet?.pilot.state)}`)}
                </span>
              </div>
              <div className="mission-title">{c.title}</div>
              <div className="mission-bar">
                <i style={{ width: `${Math.round((c.progress ?? 0) * 100)}%` }} />
              </div>
              <div className="mission-meta">
                <span>{t("missionEffort")} {fmtDur(c.effortMin !== null ? c.effortMin * 60_000 : null, t)}</span>
                <span>·</span>
                <span>{t("missionRounds", { n: c.rounds ?? 0 })}</span>
                {cardDisplayStatus(c.status, fleet?.pilot.state) === "running" && c.etaMs !== null && (
                  <>
                    <span>·</span>
                    <span>{t("missionEta")} {fmtDur(c.etaMs, t)}</span>
                  </>
                )}
                {c.gateFails > 0 && (
                  <>
                    <span>·</span>
                    <span className="mission-bad">{t("missionGateFails", { n: c.gateFails })}</span>
                  </>
                )}
              </div>
            </button>
          ))}
        </div>
        <div className="mission-detail">
          {!selected && (cards?.length ?? 0) > 0 && <p className="muted" style={{ padding: 12 }}>{t("missionSelect")}</p>}
          {selected && (
            <>
              <div className="mission-tbar">
                <strong>{selected}</strong>
                <div className="mission-filters">
                  {KIND_FILTERS.map((k) => (
                    <button
                      key={k}
                      className={filter === k ? "on" : ""}
                      onClick={() => setFilter(k)}
                    >
                      {t(`missionF_${k}`)}
                    </button>
                  ))}
                </div>
                {!phone && (
                  <button
                    className="mission-takeover"
                    onClick={() => void takeover(selected)}
                    disabled={taking}
                  >
                    {taking ? "…" : t("missionTakeover")}
                  </button>
                )}
              </div>
              {taken && <p className="mission-taken">{taken}</p>}
              <div className="mission-timeline">
                {filtered.length === 0 && <p className="muted" style={{ padding: 12 }}>{t("missionNoEntries")}</p>}
                {filtered.map((e, i) => (
                  <div key={`${e.ts}-${i}`} className={`mission-ev ev-${e.kind}`}>
                    <span className="mission-ev-ts">{fmtClock(e.ts)}</span>
                    <span className="mission-ev-dot" aria-hidden />
                    <div className="mission-ev-body">
                      <span className="mission-ev-text">{e.text}</span>
                      {e.tail && <pre className="mission-ev-tail">{e.tail}</pre>}
                    </div>
                  </div>
                ))}
              </div>
              {!phone && shots.length > 0 && (
                <div className="mission-shots">
                  <span className="mission-shots-label">{t("missionShots")}</span>
                  <div className="mission-shots-row">
                    {shots.slice(0, 6).map((s) => <MissionShot key={s} name={s} daemonApi={daemonApi} />)}
                  </div>
                </div>
              )}
              {liveShot && (
                <div className="mission-shots">
                  <span className="mission-shots-label">{t("missionLiveShot")}</span>
                  <img src={liveShot} alt="live dashboard" style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)" }} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
      ))}
    </div>
  );
}

function MissionShot({ name, daemonApi }: { name: string; daemonApi: DaemonApiFn }) {
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    void daemonApi({ path: `/api/pilot-shot?name=${encodeURIComponent(name)}` })
      .then((r) => decode(r))
      .then((r) => {
        if (alive && r.png) setSrc(`data:image/png;base64,${r.png}`);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [name, daemonApi]);
  if (!src) return null;
  return (
    <>
      <img className="mission-shot" src={src} alt={name} onClick={() => setOpen(true)} />
      {open && (
        <div className="mission-shot-open" onClick={() => setOpen(false)}>
          <img src={src} alt={name} />
        </div>
      )}
    </>
  );
}
