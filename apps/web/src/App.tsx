import { useEffect, useRef, useState } from "react";
import {
  OcrClient,
  loadState,
  saveState,
  clearState,
  parsePairingUri,
  type Pairing,
} from "./lib/client";
import type { OpResponse, EventEnvelope } from "@ocr/protocol";
import { gateVerify, gateEnroll } from "./lib/gate";
import PairingView from "./components/PairingView";
import SessionsView from "./components/SessionsView";
import ChatView from "./components/ChatView";
import SettingsView, { applyTheme } from "./components/SettingsView";
import FilesView from "./components/FilesView";
import SendToAgentView from "./components/SendToAgentView";

type Phase = "unpaired" | "connecting" | "paired" | "error";

export default function App() {
  const [phase, setPhase] = useState<Phase>("unpaired");
  const [error, setError] = useState("");
  const [machineName, setMachineName] = useState("");
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const clientRef = useRef<OcrClient | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [filesView, setFilesView] = useState(false);
  const [share, setShare] = useState<{ title?: string; text?: string; url?: string } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    applyTheme();
  }, []);

  async function connect(pairing: Pairing, persist: boolean) {
    setPhase("connecting");
    setError("");
    try {
      // biometric gate before the identity key may be used
      if (!(await gateVerify())) {
        throw new Error("Biometric unlock failed");
      }
      const client = await OcrClient.connect(pairing);
      if (persist) {
        saveState(pairing);
        void gateEnroll(); // best effort: offer Face ID lock on first pair
      }
      (window as unknown as { __ocrClient?: OcrClient }).__ocrClient = client;
      clientRef.current = client;
      setMachineName(pairing.name ?? "machine");
      setPhase("paired");
      client.onEvent((evt) => {
        setEvents((prev) => [...prev.slice(-500), evt]);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  // deep-link routing: notifications open #/session/<id> or #/files
  useEffect(() => {
    function applyHash() {
      const h = location.hash;
      // #/send?text=...&url=... — share ingestion via hash route
      if (h.startsWith("#/send")) {
        const qs = h.split("?")[1] ?? "";
        const sp = new URLSearchParams(qs);
        const payload = { title: sp.get("title") ?? "", text: sp.get("text") ?? "", url: sp.get("url") ?? "" };
        if (payload.title || payload.text || payload.url) {
          setShare(payload);
          setSession(null);
        }
        return;
      }
      const sid = /^#\/session\/([\w-]+)/.exec(h)?.[1];
      if (sid && clientRef.current) {
        setSession(sid);
        setFilesView(false);
        setSettings(false);
        return;
      }
      if (h === "#/files" && clientRef.current) setFilesView(true);
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [phase]);

  useEffect(() => {
    const stored = loadState();
    if (stored) void connect(stored.pairing, false);
  }, []);

  // Web Share Target (Android/desktop Chrome): shared content arrives as query params
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const payload = {
      title: sp.get("title") ?? "",
      text: sp.get("text") ?? "",
      url: sp.get("url") ?? "",
    };
    if (payload.title || payload.text || payload.url) {
      setShare(payload);
      history.replaceState(null, "", location.pathname);
    }
  }, []);

  // machine name is user-editable — refresh it from the daemon after connecting
  useEffect(() => {
    if (phase !== "paired") return;
    void (async () => {
      try {
        const res = await request("GET", "/__ocr/settings");
        const name = (res.body as { name?: string }).name;
        if (name) setMachineName(name);
      } catch {}
    })();
  }, [phase, tick]);

  function disconnect() {
    clientRef.current?.close();
    clientRef.current = null;
    clearState();
    setPhase("unpaired");
    setSession(null);
    setEvents([]);
    setTick((t) => t + 1);
  }

  async function request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<OpResponse> {
    const client = clientRef.current;
    if (!client) throw new Error("not connected");
    return client.request(method as "GET", path, body, query);
  }

  if (phase !== "paired") {
    return (
      <PairingView
        phase={phase}
        error={error}
        onPair={(uri) => {
          const pairing = parsePairingUri(uri);
          if (!pairing) {
            setError("Invalid pairing code");
            setPhase("error");
            return;
          }
          void connect(pairing, true);
        }}
        onRetry={() => {
          const stored = loadState();
          if (stored) void connect(stored.pairing, false);
          else setPhase("unpaired");
        }}
      />
    );
  }

  return session ? (
    <ChatView
      sessionId={session}
      request={request}
      events={events}
      voice={clientRef.current?.caps?.transcribe === true}
      onBack={() => {
        setSession(null);
        history.replaceState(null, "", "#/");
      }}
    />
  ) : settings ? (
    <SettingsView
      request={request}
      onBack={() => {
        setSettings(false);
        setTick((t) => t + 1); // re-fetch machine name after settings edits
      }}
    />
  ) : filesView ? (
    <FilesView request={request} onBack={() => setFilesView(false)} />
  ) : share ? (
    <SendToAgentView
      request={request}
      payload={share}
      onBack={() => setShare(null)}
      onOpenSession={(id) => {
        setShare(null);
        setSession(id);
      }}
    />
  ) : (
    <SessionsView
      request={request}
      machineName={machineName}
      events={events}
      onOpen={setSession}
      onDisconnect={disconnect}
      onEnablePush={async () => {
        const { enablePush } = await import("./lib/push");
        await enablePush(request);
      }}
      onOpenSettings={() => setSettings(true)}
      onOpenFiles={() => setFilesView(true)}
      tick={tick}
    />
  );
}
