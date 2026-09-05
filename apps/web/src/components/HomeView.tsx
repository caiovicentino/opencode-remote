import { useEffect, useRef, useState } from "react";
import type { OpResponse } from "@ocr/protocol";
import { useT, getLang } from "../lib/i18n";
import { greetingKey, homeIdeas, type HomeIdeaIcon } from "../lib/home";
import { composerSelectorLabel } from "../lib/composer";
import { useModelSelector } from "../lib/models";
import { transcribeBlob } from "../lib/transcribe";
import { WavRecorder } from "../lib/recorder";
import ModelMenuItems from "./ModelMenuItems";
import {
  IconArrowUp,
  IconBookOpen,
  IconChevronDown,
  IconFileText,
  IconMic,
  IconWrench,
  type IconProps,
} from "./icons";

const IDEA_ICONS: Record<HomeIdeaIcon, (p: IconProps) => React.JSX.Element> = {
  wrench: IconWrench,
  book: IconBookOpen,
  file: IconFileText,
};

type Props = {
  machineName: string;
  request: (method: string, path: string, body?: unknown) => Promise<OpResponse>;
  /** live transcribe capability (same source ChatView's mic uses) */
  voice: boolean;
  /** true while App.createSession is in flight — one session per click */
  creating: boolean;
  /** start a session with `prompt` pre-filled; resolves to an error message */
  onStart: (prompt: string) => Promise<string | null>;
};

type RecState = "idle" | "rec" | "busy";

/** P2-123: the living home (desktop empty state) — Claude-Desktop-style
 * serif greeting, a central composer with the model selector and three
 * clickable ideas. Every string comes from the dict. */
export default function HomeView({ machineName, request, voice, creating, onStart }: Props) {
  const t = useT();
  const [input, setInput] = useState("");
  const [error, setError] = useState(""); // dict copy only — never raw bodies
  const { models, model, pickModel } = useModelSelector(request);
  const [modelMenu, setModelMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // mic: real press-and-hold recording, same flow as the ChatView mic
  const [recState, setRecState] = useState<RecState>("idle");
  const recorder = useRef<WavRecorder | null>(null);

  // close the model menu on outside clicks, like the ChatView dropdown
  useEffect(() => {
    if (!modelMenu) return;
    function onDown(e: PointerEvent) {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenu(false);
      }
    }
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("pointerdown", onDown);
    };
  }, [modelMenu]);

  async function start(prompt: string) {
    const text = prompt.trim();
    if (!text || creating) return;
    setError("");
    const err = await onStart(text);
    if (err) setError(t("homeStartError")); // input stays — never lose the text
  }

  async function micDown() {
    if (!voice || recState !== "idle") return;
    setError("");
    try {
      recorder.current = new WavRecorder();
      await recorder.current.start();
      setRecState("rec");
    } catch (err) {
      setRecState("idle");
      const e = err as Error & { name?: string };
      if (e.name === "NotAllowedError" || e.name === "NotFoundError") {
        setError(t("micNeedsPermission"));
      }
    }
  }

  async function micUp() {
    if (recState !== "rec") return;
    setRecState("busy");
    try {
      const blob = await recorder.current!.stop();
      const text = await transcribeBlob(request, blob);
      if (text.trim()) setInput((prev) => (prev.trim() ? `${prev.trim()} ${text.trim()}` : text.trim()));
      taRef.current?.focus();
    } catch {
      // transcription is best effort — the draft text stays untouched
    }
    setRecState("idle");
  }

  const ideas = homeIdeas(getLang());

  return (
    <div className="home">
      <div className="home-col">
        <div className="home-head">
          <div className="desk-greet-mark" aria-hidden>
            ✻
          </div>
          <h2 className="home-greeting">
            {t(greetingKey(machineName), { name: machineName.toLowerCase() })}
          </h2>
        </div>

        <div className="home-composer">
          <div className="composer">
            <textarea
              ref={taRef}
              className="composer-text"
              rows={1}
              placeholder={recState === "rec" ? t("recording") : t("homePlaceholder")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void start(input);
                }
              }}
            />
            <div className="composer-bar">
              <div className="composer-spacer" />
              <div className="composer-model" ref={modelMenuRef}>
                <button
                  className="composer-model-btn"
                  onClick={() => setModelMenu((v) => !v)}
                  aria-expanded={modelMenu}
                  aria-haspopup="listbox"
                  title={t("modelSelector")}
                >
                  <span className="composer-model-label">
                    {composerSelectorLabel(
                      "",
                      model ? model.split("/")[1] ?? model : t("defaultModel"),
                    )}
                  </span>
                  <IconChevronDown size={13} />
                </button>
                {modelMenu && (
                  <div className="composer-menu" role="listbox" aria-label={t("modelSelector")}>
                    <ModelMenuItems
                      models={models}
                      model={model}
                      onPick={(v) => {
                        pickModel(v);
                        setModelMenu(false);
                      }}
                    />
                  </div>
                )}
              </div>
              <button
                className="composer-btn composer-mic"
                onPointerDown={(e) => {
                  e.preventDefault();
                  void micDown();
                }}
                onPointerUp={() => void micUp()}
                disabled={!voice || recState === "busy"}
                aria-label={recState === "rec" ? t("stopRecording") : t("recordVoice")}
                title={!voice ? t("micNeedsPermission") : recState === "rec" ? t("stopRecording") : t("recordVoice")}
              >
                {recState === "busy" ? (
                  "…"
                ) : recState === "rec" ? (
                  <span className="composer-mic-rec" aria-hidden />
                ) : (
                  <IconMic />
                )}
              </button>
              <button
                className="primary composer-send"
                onClick={() => void start(input)}
                disabled={creating || !input.trim()}
                aria-label={t("send")}
                title={t("send")}
              >
                <IconArrowUp size={16} />
              </button>
            </div>
          </div>
          {error && (
            <div className="home-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="home-ideas">
          <h3 className="home-ideas-title">{t("homeIdeasTitle")}</h3>
          {ideas.map((idea) => {
            const Icon = IDEA_ICONS[idea.icon];
            return (
              <button
                key={idea.id}
                className="home-idea"
                data-idea={idea.id}
                data-prompt={idea.prompt}
                disabled={creating}
                onClick={() => void start(idea.prompt)}
              >
                <span className="home-idea-icon" aria-hidden>
                  <Icon size={16} />
                </span>
                <span className="home-idea-label">{idea.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
