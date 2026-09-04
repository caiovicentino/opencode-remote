import { useEffect, useRef, useState } from "react";
import type { OpResponse } from "@ocr/protocol";
import { useT, getLang } from "../lib/i18n";
import { agentForMode, greetingKey, homeIdeas, HOME_MODES, type HomeIdeaIcon, type HomeMode } from "../lib/home";
import { composerSelectorLabel } from "../lib/composer";
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
  onStart: (prompt: string, mode: HomeMode) => Promise<string | null>;
};

/** P2-123: the living home (desktop empty state) — Claude-Desktop-style
 * serif greeting, a central composer with the Chat/Cowork toggle + model
 * selector, and three clickable ideas. Every string comes from the dict. */
export default function HomeView({ machineName, request, voice, creating, onStart }: Props) {
  const t = useT();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<HomeMode>(() =>
    localStorage.getItem("ocr_agent") === "build" ? "cowork" : "chat",
  );
  const [startError, setStartError] = useState("");
  const [models, setModels] = useState<{ providerID: string; modelID: string; name: string }[]>([]);
  const [model, setModel] = useState(localStorage.getItem("ocr_model") ?? "");
  const [modelMenu, setModelMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // model list, same endpoint ChatView's selector uses (best effort)
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

  function pickMode(next: HomeMode) {
    setMode(next);
    // same key the session composer reads, so the choice carries into the
    // conversation that gets created
    localStorage.setItem("ocr_agent", agentForMode(next));
  }

  function pickModel(value: string) {
    setModel(value);
    localStorage.setItem("ocr_model", value);
    setModelMenu(false);
  }

  async function start(prompt: string) {
    const text = prompt.trim();
    if (!text || creating) return;
    setStartError("");
    const err = await onStart(text, mode);
    if (err) setStartError(err); // input stays — never lose the user's text
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
              placeholder={t("homePlaceholder")}
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
              <div className="home-mode" role="radiogroup" aria-label={t("homeModeChat") + " / " + t("homeModeCowork")}>
                {HOME_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    data-mode={m}
                    disabled={creating}
                    onClick={() => pickMode(m)}
                  >
                    {t(m === "chat" ? "homeModeChat" : "homeModeCowork")}
                  </button>
                ))}
              </div>
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
                    <button
                      role="option"
                      aria-selected={!model}
                      data-model=""
                      className={`composer-menu-item${!model ? " selected" : ""}`}
                      onClick={() => pickModel("")}
                    >
                      {t("defaultModel")}
                    </button>
                    {models.map((m) => (
                      <button
                        key={`${m.providerID}/${m.modelID}`}
                        role="option"
                        aria-selected={model === `${m.providerID}/${m.modelID}`}
                        data-model={`${m.providerID}/${m.modelID}`}
                        className={`composer-menu-item${model === `${m.providerID}/${m.modelID}` ? " selected" : ""}`}
                        onClick={() => pickModel(`${m.providerID}/${m.modelID}`)}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="composer-btn composer-mic"
                disabled={!voice}
                aria-label={t("recordVoice")}
                title={voice ? t("recordVoice") : t("micNeedsPermission")}
                onClick={() => taRef.current?.focus()}
              >
                <IconMic />
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
          {startError && (
            <div className="home-error" role="alert" title={startError}>
              {t("homeStartError")}
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
