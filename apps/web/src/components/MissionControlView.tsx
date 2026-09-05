import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../lib/i18n";
import { IconRadar } from "./icons";

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
  setAt?: string;
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

export default function MissionControlView({
  daemonApi,
  browse,
  onBack,
}: {
  daemonApi: DaemonApiFn | null;
  browse: BrowseFn | null;
  onBack: () => void;
}) {
  const t = useT();
  const [cards, setCards] = useState<SessionCard[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [shots, setShots] = useState<string[]>([]);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [error, setError] = useState("");
  const [taking, setTaking] = useState(false);
  const [taken, setTaken] = useState<string | null>(null);
  const [liveShot, setLiveShot] = useState<string | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  // P2-123 follow-up: the pane's main surface is the LIVE orbital dashboard
  // (the same /dashboard/v3 the browser shows), embedded with self-auth via
  // the desktop bridge's local link. The forensic timeline stays one toggle away.
  const [view, setView] = useState<"dash" | "forensic">("dash");
  const [dashUrl, setDashUrl] = useState<string | null>(null);
  // Self-serve mission: undefined = not loaded yet, null = none set.
  const [mission, setMission] = useState<MissionSpecView | null | undefined>(undefined);
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
      setSelected((cur) => (cur && list.some((c) => c.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [daemonApi]);

  const loadMission = useCallback(async () => {
    if (!daemonApi) return;
    try {
      const { json } = await decode(await daemonApi({ path: "/api/pilot-mission" }));
      const spec = json?.spec as MissionSpecView | null | undefined;
      setMission(spec && typeof spec === "object" ? spec : null);
    } catch {
      // best-effort: the cards error surface already reports a dead daemon
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
    const iv = setInterval(() => {
      void loadCards();
      void loadMission();
    }, 6_000);
    return () => clearInterval(iv);
  }, [daemonApi, loadCards, loadMission]);

  useEffect(() => {
    if (selected) void loadTimeline(selected);
  }, [selected, loadTimeline]);

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
          {onBack && <button onClick={onBack}>←</button>}
          <h1 style={{ fontSize: "1rem", margin: 0, flex: 1 }}>Mission Control</h1>
        </header>
        <div className="list">
          <p className="muted" style={{ padding: 16 }}>
            {t("missionDesktopOnly")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen mission">
      <header>
        {onBack && <button onClick={onBack}>←</button>}
        <h1 style={{ fontSize: "1rem", margin: 0, flex: 1 }}>
          <IconRadar size={16} /> Mission Control
        </h1>
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
        {browse && (
          <button onClick={() => void liveShotNow()} disabled={liveBusy} aria-label="live dashboard shot">
            {liveBusy ? "…" : t("missionLive")}
          </button>
        )}
      </header>
      {error && <p className="mission-error">{error}</p>}
      {view === "dash" && dashUrl && (
        <iframe
          src={dashUrl}
          title="Mission Control"
          style={{ flex: 1, width: "100%", border: "0", background: "var(--bg)" }}
        />
      )}
      {view === "forensic" && (
      <div className="mission-grid">
        <div className="mission-cards" role="list">
          <div className="mission-active" data-mission={mission ? "set" : "none"}>
            <span className="mission-active-label">{t("missionActive")}</span>
            {mission ? (
              <>
                {mission.prompt && <p className="mission-active-text">{mission.prompt}</p>}
                {mission.repoUrl && (
                  <p className="mission-active-src">
                    {t("missionSourceRepo")}: {mission.repoUrl}
                  </p>
                )}
                <p className="mission-active-src">
                  {t("missionSource")}:{" "}
                  {[mission.prompt ? t("missionSourcePrompt") : "", mission.repoUrl ? t("missionSourceRepo") : ""]
                    .filter(Boolean)
                    .join(" + ")}
                  {fmtDateTime(mission.setAt) ? ` · ${t("missionSetAt")} ${fmtDateTime(mission.setAt)}` : ""}
                </p>
              </>
            ) : (
              <p className="mission-active-src">{mission === null ? t("missionActiveNone") : "…"}</p>
            )}
          </div>
          {cards === null && <p className="muted" style={{ padding: 12 }}>{t("missionLoading")}</p>}
          {cards !== null && cards.length === 0 && (
            <p className="muted" style={{ padding: 12 }}>{t("missionEmpty")}</p>
          )}
          {(cards ?? []).map((c) => (
            <button
              key={c.id}
              role="listitem"
              className={`mission-card${selected === c.id ? " sel" : ""}`}
              onClick={() => setSelected(c.id)}
            >
              <div className="mission-card-top">
                <span className="mission-id">{c.id}</span>
                <span className={`mission-st st-${c.status}`}>
                  {t(`missionSt_${c.status}`)}
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
                {c.status === "running" && c.etaMs !== null && (
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
          {!selected && <p className="muted" style={{ padding: 12 }}>{t("missionSelect")}</p>}
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
                <button
                  className="mission-takeover"
                  onClick={() => void takeover(selected)}
                  disabled={taking}
                >
                  {taking ? "…" : t("missionTakeover")}
                </button>
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
              {shots.length > 0 && (
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
      )}
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
