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

type Phase = "unpaired" | "connecting" | "paired" | "error";

export default function App() {
  const [phase, setPhase] = useState<Phase>("unpaired");
  const [error, setError] = useState("");
  const [machineName, setMachineName] = useState("");
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const clientRef = useRef<OcrClient | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
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

  useEffect(() => {
    const stored = loadState();
    if (stored) void connect(stored.pairing, false);
  }, []);

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
      onBack={() => setSession(null)}
    />
  ) : settings ? (
    <SettingsView request={request} onBack={() => setSettings(false)} />
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
      tick={tick}
    />
  );
}
