import { useEffect, useRef, useState } from "react";
import type { EventEnvelope } from "@ocr/protocol";
import { WavRecorder, encodeWav } from "../lib/recorder";
import { getVoiceSettings } from "./SettingsView";
import { renderBubbleText } from "./FileCard";

interface Props {
  sessionId: string;
  events: EventEnvelope[];
  voice?: boolean;
  request: (
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    timeoutMs?: number,
  ) => Promise<{ status: number; body: unknown }>;
  onBack: () => void;
}

interface Bubble {
  role: "user" | "assistant";
  text: string;
  images?: string[];
}

interface PermissionAsk {
  permissionID: string;
  label: string;
  messageID?: string;
}

interface DiffFile {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: string;
}

interface Skill {
  id: string;
  label: string;
  prompt: string;
}

function extractPermission(
  evt: EventEnvelope,
  sessionId: string,
): PermissionAsk | null {
  if (!evt.type.toLowerCase().includes("permission")) return null;
  const p = evt.properties as {
    sessionID?: string;
    id?: string;
    permissionID?: string;
    type?: string;
    messageID?: string;
  };
  const id = p?.permissionID ?? p?.id;
  if (p?.sessionID && id && p.sessionID === sessionId) {
    return { permissionID: id, label: p.type ?? "action", messageID: p.messageID };
  }
  return null;
}

interface PendingImage {
  id: string;
  mime: string;
  filename: string;
  thumb: string;
  raw?: Uint8Array;
}

export default function ChatView({ sessionId, events, voice, request, onBack }: Props) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  // transient errors: red text should not stick around forever
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 10_000);
    return () => clearTimeout(t);
  }, [error]);
  const [recState, setRecState] = useState<"idle" | "rec" | "busy">("idle");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [models, setModels] = useState<{ providerID: string; modelID: string; name: string }[]>([]);
  const [model, setModel] = useState(localStorage.getItem("ocr_model") ?? "");
  const [agent, setAgent] = useState(localStorage.getItem("ocr_agent") ?? "");
  const [tapToggle, setTapToggle] = useState(false);
  const [responded, setResponded] = useState<Set<string>>(new Set());
  const [persistedAsks, setPersistedAsks] = useState<PermissionAsk[]>([]);
  const [diff, setDiff] = useState<{
    ask: PermissionAsk | null;
    loading: boolean;
    files: DiffFile[];
    err?: string;
  } | null>(null);
  const rolesRef = useRef<Record<string, string>>({});
  const lastEventId = useRef<string | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [pendingVideo, setPendingVideo] = useState<{ file: File; dur: number } | null>(null);
  const [trimStart, setTrimStart] = useState("");
  const [trimEnd, setTrimEnd] = useState("");
  const downAt = useRef(0);
  const recorder = useRef<WavRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await request("GET", "/provider");
        const all = (res.body as { all?: { id: string; models?: Record<string, { id: string; name?: string }> }[] })
          .all ?? [];
        const flat = all.flatMap((p) =>
          Object.values(p.models ?? {}).map((m) => ({
            providerID: p.id,
            modelID: m.id,
            name: `${p.id} · ${m.name ?? m.id}`,
          })),
        );
        setModels(flat);
      } catch {
        // model list is optional
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await request("GET", "/__ocr/skills");
        if (res.status === 200) setSkills((res.body as { skills?: Skill[] }).skills ?? []);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    rolesRef.current = {};
    setResponded(new Set());
    setPersistedAsks([]); // never leak another session's pending asks on switch
    // events that arrived before this view opened are covered by the message
    // fetch below — streaming starts from the next event
    lastEventId.current = events[events.length - 1]?.id ?? null;
    // ask the daemon for pending permissions on this session — covers asks that
    // happened before the app was open (otherwise the agent stays stuck invisibly)
    void (async () => {
      try {
        const res = await request("GET", "/permission");
        const list = (Array.isArray(res.body) ? res.body : []) as {
          id: string;
          sessionID?: string;
          permission?: string;
        }[];
        setPersistedAsks(
          list
            .filter((x) => x.sessionID === sessionId)
            .map((x) => ({ permissionID: x.id, label: x.permission ?? "action" })),
        );
      } catch {}
    })();
  }, [sessionId]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await request("GET", `/session/${sessionId}/message`);
        if (res.status !== 200) throw new Error(`GET messages -> ${res.status}`);
        const rows = (res.body as { info: { role?: string }; parts: { type: string; text?: string; url?: string }[] }[]) ?? [];
        const out: Bubble[] = [];
        for (const row of rows) {
          const text = row.parts
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");
          const images = row.parts
            .filter((p) => p.type === "file" && typeof p.url === "string" && p.url.startsWith("data:image/"))
            .map((p) => p.url as string);
          if (text || images.length) {
            out.push({ role: row.info.role === "user" ? "user" : "assistant", text, images });
          }
        }
        setBubbles(out);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [sessionId]);

  // stream: rebuild the tail of the conversation from live part events.
  // user messages echo as parts too — track message roles and only stream
  // assistant parts. `session.idle`/`session.status:idle` finalize the turn.
  const [liveText, setLiveText] = useState("");
  const liveRef = useRef("");
  useEffect(() => {
    let text = "";
    let idle = false;
    let errored = "";
    let start = 0;
    if (lastEventId.current) {
      const idx = events.findIndex((e) => e.id === lastEventId.current);
      if (idx >= 0) start = idx + 1;
    }
    lastEventId.current = events[events.length - 1]?.id ?? null;
    for (const evt of events.slice(start)) {
      const p = evt.properties as {
        sessionID?: string;
        status?: { type?: string };
        info?: { id?: string; role?: string };
        part?: { type?: string; text?: string; messageID?: string };
        error?: unknown;
      };
      if (p?.sessionID !== sessionId) continue;
      if (evt.type === "message.updated" && p.info?.id) {
        rolesRef.current[p.info.id] = p.info.role ?? "assistant";
        continue;
      }
      if (evt.type === "session.status") idle = p.status?.type === "idle" || idle;
      if (evt.type === "session.error") {
        const errObj = (p as { error?: { name?: string } }).error;
        if (errObj?.name === "MessageAbortedError") {
          idle = true; // user pressed Stop — expected, not a failure
        } else {
          errored = JSON.stringify(evt.properties).slice(0, 200);
        }
      }
      if (p.part?.type === "text" && p.part.text) {
        if (p.part.messageID && rolesRef.current[p.part.messageID] === "user") continue;
        text = p.part.text;
        idle = false;
      }
      if (evt.type === "session.idle") idle = true;
    }
    if (text) {
      liveRef.current = text;
      setLiveText(text);
    }
    if (idle) {
      if (liveRef.current) {
        const final = liveRef.current;
        setBubbles((b) =>
          b[b.length - 1]?.text === final ? b : [...b, { role: "assistant" as const, text: final }],
        );
        liveRef.current = "";
      }
      setLiveText("");
      setSending(false);
      if (errored) setError(`agent error: ${errored}`);
    }
  }, [events, sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles, sending, liveText]);

  const pending: PermissionAsk[] = [];
  for (const evt of events.slice(-50)) {
    const ask = extractPermission(evt, sessionId);
    if (ask && !responded.has(ask.permissionID)) pending.push(ask);
  }
  // persisted asks (server-side pending list) — covers events lost before mount
  for (const pa of persistedAsks) {
    if (!responded.has(pa.permissionID) && !pending.some((p) => p.permissionID === pa.permissionID))
      pending.push(pa);
  }

  async function showDiff(ask: PermissionAsk) {
    setDiff({ ask, loading: true, files: [] });
    try {
      const res = await request(
        "GET",
        `/session/${sessionId}/diff`,
        undefined,
        ask.messageID ? { messageID: ask.messageID } : undefined,
      );
      const files = res.body as DiffFile[];
      setDiff({
        ask,
        loading: false,
        files: Array.isArray(files) ? files : [],
        err: Array.isArray(files) ? undefined : "diff unavailable",
      });
    } catch (err) {
      setDiff({ ask, loading: false, files: [], err: err instanceof Error ? err.message : String(err) });
    }
  }

  async function respond(permissionID: string, response: "approve" | "reject") {
    setResponded((prev) => new Set(prev).add(permissionID));
    try {
      const res = await request("POST", `/session/${sessionId}/permissions/${permissionID}`, {
        response: response === "approve" ? "once" : "reject",
      });
      if (res.status !== 200) {
        setResponded((prev) => {
          const next = new Set(prev);
          next.delete(permissionID);
          return next;
        });
        setError(`approve failed (${res.status}): ${JSON.stringify(res.body).slice(0, 140)}`);
      } else {
        setPersistedAsks((prev) => prev.filter((p) => p.permissionID !== permissionID));
      }
    } catch (err) {
      setResponded((prev) => {
        const next = new Set(prev);
        next.delete(permissionID);
        return next;
      });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if ((!text && images.length === 0) || sending || liveText) return;
    setSending(true);
    setError("");
    setInput("");
    setBubbles((b) => [
      ...b,
      {
        role: "user",
        text:
          text ||
          (images.length ? `[image${images.length > 1 ? `s x${images.length}` : ""}]` : ""),
      },
    ]);
    try {
      const attached = [...images];
      const buildBody = (): Record<string, unknown> => {
        const fileParts = attached.map((img) => ({
          type: "file",
          mime: img.mime,
          filename: img.filename,
          url: `ocr-upload://${img.id}`,
        }));
        const parts: unknown[] = [...fileParts];
        if (text) parts.push({ type: "text", text });
        const sel = model ? models.find((m) => `${m.providerID}/${m.modelID}` === model) : null;
        const body: Record<string, unknown> = { parts };
        if (sel) body.model = { providerID: sel.providerID, modelID: sel.modelID };
        if (agent) body.agent = agent;
        return body;
      };
      setImages([]);
      let body = buildBody();
      let res = await request("POST", `/session/${sessionId}/message`, body);
      // attachments age out of the daemon (30min TTL, or a daemon restart):
      // re-upload whatever we still hold in memory and retry once
      if (res.status === 410 && attached.some((img) => img.raw)) {
        for (const img of attached) {
          if (!img.raw) continue;
          img.id = await uploadBytes(img.raw, img.mime, img.filename);
        }
        body = buildBody();
        res = await request("POST", `/session/${sessionId}/message`, body);
      }
      if (res.status !== 200) {
        setError(`opencode responded ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  const CHUNK = 500_000;

  async function downscaleImage(file: File): Promise<{ bytes: Uint8Array; mime: string }> {
    const img = await createImageBitmap(file);
    const max = 1568;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.75));
    if (!blob) throw new Error("image processing failed");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" };
  }

  async function attachFile(file: File) {
    if (file.type.startsWith("video/")) return void stageVideo(file);
    return void attachImage(file);
  }

  async function stageVideo(file: File) {
    const dur = await videoDuration(file);
    if (!dur) throw new Error("empty video");
    setTrimStart("0");
    setTrimEnd(String(Math.round(dur * 10) / 10));
    setPendingVideo({ file, dur });
  }

  async function videoDuration(file: File): Promise<number> {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.preload = "metadata";
    await new Promise<void>((res) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => res();
    });
    URL.revokeObjectURL(url);
    return v.duration || 0;
  }

  function confirmTrim(useTrim: boolean) {
    if (!pendingVideo) return;
    const { file, dur } = pendingVideo;
    setPendingVideo(null);
    const start = useTrim ? Math.max(0, Number(trimStart) || 0) : 0;
    const end = useTrim ? Math.min(dur, Number(trimEnd) || dur) : dur;
    void processVideo(file, start, end);
  }

  async function uploadBytes(
    bytes: Uint8Array,
    mime: string,
    filename: string,
    kind?: "inline" | "file",
  ): Promise<string> {
    const id = crypto.randomUUID();
    for (let i = 0; i * CHUNK < bytes.length || i === 0; i++) {
      const slice = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
      const res = await request("POST", "/__ocr/upload/chunk", { id, idx: i, data: b64Of(slice) });
      if (res.status !== 200) throw new Error("upload failed");
    }
    const res = await request("POST", "/__ocr/upload/complete", { id, mime, filename, kind });
    if (res.status !== 200) {
      throw new Error(String((res.body as { error?: string }).error ?? "upload failed"));
    }
    const body = res.body as { url?: string; path?: string };
    return kind === "file" ? body.path! : body.url!.replace(/^ocr-upload:\/\/+/, "");
  }

  async function extractFrames(file: File, start: number, end: number): Promise<PendingImage[]> {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error("cannot read video"));
    });
    const span = Math.min(end - start, 60);
    if (span <= 0) throw new Error("empty video");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d")!;
    await video.play().catch(() => {});
    const out: PendingImage[] = [];
    const stamp = Date.now();
    for (let i = 0; i < 4; i++) {
      video.currentTime = Math.min(end - 0.05, start + (span * i) / 4 + 0.1);
      await new Promise<void>((res) => {
        video.onseeked = () => res();
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.7));
      if (!blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.length) continue;
      out.push({
        id: "",
        mime: "image/jpeg",
        filename: `frame-${stamp}-${i + 1}.jpg`,
        thumb: canvas.toDataURL("image/jpeg", 0.4),
        raw: bytes,
      });
    }
    video.pause();
    URL.revokeObjectURL(url);
    return out;
  }

  async function extractAudio(file: File, start: number, end: number): Promise<Blob | null> {
    try {
      const ac = new AudioContext();
      const decoded = await ac.decodeAudioData(await file.arrayBuffer());
      await ac.close();
      const secs = Math.min(end - start, 120);
      if (secs < 0.1) return null;
      const off = new OfflineAudioContext(1, Math.ceil(secs * 16000), 16000);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start(0, start, secs);
      const rendered = await off.startRendering();
      return new Blob([encodeWav(rendered.getChannelData(0), 16000)], { type: "audio/wav" });
    } catch {
      return null;
    }
  }

  async function processVideo(file: File, start: number, end: number) {
    setUploading(true);
    setError("");
    try {
      const audio = await extractAudio(file, start, end);
      if (audio) {
        const text = await transcribe(audio);
        if (text) setInput((prev) => (prev ? `${prev} ${text}` : text));
      }
      const frames = await extractFrames(file, start, end);
      for (const f of frames) {
        const id = await uploadBytes(f.raw!, f.mime, f.filename);
        setImages((prev) => [...prev.slice(-3), { ...f, id }]);
      }
      const path = await uploadBytes(
        new Uint8Array(await file.arrayBuffer()),
        file.type || "video/mp4",
        file.name || "video.mp4",
        "file",
      );
      const trimmed = end - start < (await videoDuration(file)) - 0.5;
      const note = trimmed
        ? `[trim ${start.toFixed(1)}-${end.toFixed(1)}s — full video saved at ${path}; use ffmpeg to cut or inspect]`
        : `[full video saved at ${path} — use ffmpeg to inspect frame by frame]`;
      setInput((prev) => `${prev ? `${prev} ` : ""}${note}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function attachImage(file: File) {
    setUploading(true);
    setError("");
    try {
      const { bytes, mime } = await downscaleImage(file);
      const filename = `image-${Date.now()}.jpg`;
      const id = await uploadBytes(bytes, mime, filename);
      setImages((prev) => [
        ...prev.slice(-3),
        { id, mime, filename, thumb: URL.createObjectURL(file), raw: bytes },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function b64Of(bytes: Uint8Array): string {
    let s = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      s += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(s);
  }

  async function transcribe(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const id = crypto.randomUUID();
    for (let i = 0; i * CHUNK < bytes.length || i === 0; i++) {
      const slice = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
      const res = await request("POST", "/__ocr/transcribe/chunk", {
        id,
        idx: i,
        data: b64Of(slice),
      });
      if (res.status !== 200) throw new Error("audio upload failed");
    }
    const res = await request(
      "POST",
      "/__ocr/transcribe",
      { id, lang: getVoiceSettings().lang },
      undefined,
      180_000,
    );
    if (res.status !== 200) {
      throw new Error(String((res.body as { error?: string }).error ?? "transcription failed"));
    }
    return String((res.body as { text?: string }).text ?? "");
  }

  async function micDown() {
    setError("");
    try {
      recorder.current = new WavRecorder();
      await recorder.current.start();
      downAt.current = Date.now();
      setRecState("rec");
    } catch (err) {
      micError(err);
    }
  }

  async function micUp() {
    try {
      setRecState("busy");
      const blob = await recorder.current!.stop();
      const text = await transcribe(blob);
      if (getVoiceSettings().autoSend && text.trim()) {
        await send(text);
      } else if (text) {
        setInput((prev) => (prev ? `${prev} ${text}` : text));
      }
      setRecState("idle");
    } catch (err) {
      micError(err);
      setRecState("idle");
    }
  }

  function micError(err: unknown) {
    const e = err as Error & { name?: string };
    if (e.name === "NotAllowedError") {
      setError("microphone denied — allow it once in iOS Settings → Apps → Safari → Microphone, then reload");
    } else if (e.name === "NotFoundError") {
      setError("no microphone found on this device");
    } else {
      setError(e.message ?? String(e));
    }
    setRecState("idle");
  }

  return (
    <div className="screen">
      <header>
        <button onClick={onBack}>←</button>
        <h1 style={{ fontSize: "0.9rem", margin: 0, flex: 1 }}>session</h1>
        <select
          value={agent}
          onChange={(e) => {
            setAgent(e.target.value);
            localStorage.setItem("ocr_agent", e.target.value);
          }}
          aria-label="Agent mode"
          style={{ maxWidth: 90 }}
        >
          <option value="">agent</option>
          <option value="build">build</option>
          <option value="plan">plan</option>
        </select>
      </header>

      <div className="chat">
        <div className="messages">
          {bubbles.map((b, i) => (
            <div key={i} className={`msg ${b.role}`}>
              {b.images && b.images.length > 0 && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: b.text ? 4 : 0 }}>
                  {b.images.map((u, j) => (
                    <img
                      key={j}
                      src={u}
                      alt=""
                      loading="lazy"
                      style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6 }}
                    />
                  ))}
                </div>
              )}
              {renderBubbleText(b.text, request, setError)}
            </div>
          ))}
          {liveText && (
            <div className="msg assistant">
              {renderBubbleText(liveText, request, setError)}
              <span>▍</span>
            </div>
          )}
          {sending && <div className="muted">agent is working…</div>}
          {(sending || liveText) && (
            <button
              className="danger"
              style={{ margin: "4px auto", display: "block" }}
              onClick={() => void request("POST", `/session/${sessionId}/abort`)}
            >
              Stop
            </button>
          )}
          <div ref={bottomRef} />
        </div>

        {pending.length > 0 && (
          <div className="card">
        {pending.map((p) => (
          <div key={p.permissionID} className="approval" style={{ marginBottom: 8 }}>
            <span style={{ flex: 1 }}>
              Approve <b>{p.label}</b>?
            </span>
            <button onClick={() => void showDiff(p)}>diff</button>
            <button className="primary" onClick={() => void respond(p.permissionID, "approve")}>
              Approve
            </button>
            <button className="danger" onClick={() => void respond(p.permissionID, "reject")}>
              Deny
            </button>
          </div>
        ))}
          </div>
        )}

        {error && <p style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}

        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void (async () => {
              for (const f of files) {
                await attachFile(f).catch((err) =>
                  setError(err instanceof Error ? err.message : String(err)),
                );
              }
            })();
          }}
        />

        {pendingVideo && (
          <div
            className="card"
            style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: 8 }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 100,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "0.8rem",
              }}
            >
              {pendingVideo.file.name}
            </span>
            <input
              type="number"
              step="0.1"
              min={0}
              max={pendingVideo.dur}
              style={{ width: 64, padding: "6px 8px" }}
              value={trimStart}
              onChange={(e) => setTrimStart(e.target.value)}
              aria-label="Trim start (s)"
            />
            <span className="muted">→</span>
            <input
              type="number"
              step="0.1"
              min={0}
              max={pendingVideo.dur}
              style={{ width: 64, padding: "6px 8px" }}
              value={trimEnd}
              onChange={(e) => setTrimEnd(e.target.value)}
              aria-label="Trim end (s)"
            />
            <button className="primary" onClick={() => confirmTrim(true)}>
              Attach
            </button>
            <button onClick={() => confirmTrim(false)}>Full</button>
          </div>
        )}

        {images.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {images.map((img) => (
              <span key={img.id} style={{ position: "relative", display: "inline-block" }}>
                <img
                  src={img.thumb}
                  alt=""
                  style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 8 }}
                />
                <button
                  onClick={() => setImages((prev) => prev.filter((i) => i.id !== img.id))}
                  aria-label="Remove image"
                  style={{
                    position: "absolute",
                    top: -6,
                    right: -6,
                    width: 18,
                    height: 18,
                    borderRadius: 9,
                    border: "none",
                    background: "var(--danger, #c0392b)",
                    color: "#fff",
                    fontSize: 11,
                    lineHeight: 1,
                    cursor: "pointer",
                  }}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        )}

        {models.length > 0 && (
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              localStorage.setItem("ocr_model", e.target.value);
            }}
            aria-label="Model"
            style={{ width: "100%", marginBottom: 6 }}
          >
            <option value="">default model</option>
            {models.map((m) => (
              <option key={`${m.providerID}/${m.modelID}`} value={`${m.providerID}/${m.modelID}`}>
                {m.name}
              </option>
            ))}
          </select>
        )}

        {skills.length > 0 && (
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
            {skills.map((s) => (
              <button
                key={s.id}
                style={{
                  whiteSpace: "nowrap",
                  fontSize: "0.78rem",
                  padding: "6px 12px",
                  borderRadius: 16,
                  flexShrink: 0,
                }}
                disabled={sending || !!liveText}
                onClick={() => void send(s.prompt)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        <div className="composer">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading || recState === "busy"}
            aria-label="Attach image"
          >
            {uploading ? (
              "…"
            ) : (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            )}
          </button>
          {voice && (
            <button
              className={recState === "rec" ? "danger" : ""}
              onPointerDown={(e) => {
                e.preventDefault();
                if (recState === "idle") void micDown();
              }}
              onPointerUp={() => {
                if (recState !== "rec") return;
                if (tapToggle || Date.now() - downAt.current > 400) {
                  setTapToggle(false);
                  void micUp();
                } else {
                  setTapToggle(true);
                }
              }}
              disabled={recState === "busy"}
              aria-label={recState === "rec" ? "Stop recording" : "Record voice"}
            >
              {recState === "busy" ? (
                "…"
              ) : recState === "rec" ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                  <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.07A7 7 0 0 0 19 11Z" />
                </svg>
              )}
            </button>
          )}
          <textarea
            rows={1}
            placeholder={recState === "rec" ? "recording…" : "Message the agent…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            className="primary"
            onClick={() => void send()}
            disabled={sending || !!liveText}
            title={liveText ? "Agent is streaming — wait or Stop" : "Send"}
          >
            {liveText ? "…" : "Send"}
          </button>
        </div>
      </div>

      {diff && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.94)",
            zIndex: 60,
            display: "flex",
            flexDirection: "column",
            padding: 12,
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setDiff(null)} aria-label="Close diff">
              ✕
            </button>
            <div style={{ flex: 1, fontWeight: 600, fontSize: "0.9rem" }}>
              {diff.loading ? "loading diff…" : `changes for ${diff.ask?.label ?? "action"}`}
            </div>
            {diff.ask && !diff.loading && (
              <>
                <button
                  className="primary"
                  onClick={() => {
                    const id = diff.ask!.permissionID;
                    setDiff(null);
                    void respond(id, "approve");
                  }}
                >
                  Approve
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    const id = diff.ask!.permissionID;
                    setDiff(null);
                    void respond(id, "reject");
                  }}
                >
                  Deny
                </button>
              </>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {diff.err && <p style={{ color: "var(--danger)" }}>{diff.err}</p>}
            {!diff.loading && !diff.err && diff.files.length === 0 && (
              <p className="muted">no file changes yet for this request</p>
            )}
            {diff.files.map((f) => (
              <div key={f.file} style={{ marginBottom: 10 }}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    marginBottom: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <b>{f.status}</b> · {f.file}{" "}
                  <span className="muted">
                    (+{f.additions} −{f.deletions})
                  </span>
                </div>
                <pre
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border, rgba(255,255,255,0.1))",
                    borderRadius: 8,
                    padding: "8px 10px",
                    overflowX: "auto",
                    fontSize: "0.72rem",
                    lineHeight: 1.45,
                    margin: 0,
                  }}
                >
                  {f.patch.split("\n").map((l, i) => {
                    const bg = l.startsWith("+")
                      ? "rgba(46,160,67,0.18)"
                      : l.startsWith("-")
                        ? "rgba(248,81,73,0.18)"
                        : undefined;
                    return (
                      <div
                        key={i}
                        style={{
                          background: bg,
                          whiteSpace: "pre",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        }}
                      >
                        {l}
                      </div>
                    );
                  })}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
