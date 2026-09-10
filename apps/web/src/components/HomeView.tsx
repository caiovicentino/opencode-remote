import { useEffect, useRef, useState } from "react";
import type { OpResponse } from "@ocr/protocol";
import { useT, getLang } from "../lib/i18n";
import { markSendOnOpen } from "../lib/drafts";
import { greetingKey, homeIdeas, timeGreetingKey, type HomeIdeaIcon } from "../lib/home";
import { clampComposerHeight, composerSelectorLabel } from "../lib/composer";
import { useModelSelector } from "../lib/models";
import { transcribeBlob, useSttStatus } from "../lib/transcribe";
import { modelHintKey, useModelStatus } from "../lib/modelstatus";
import { WavRecorder } from "../lib/recorder";
import ModelMenuItems from "./ModelMenuItems";
import ModelMissingActions from "./ModelMissingActions";
import {
  IconArrowUp,
  IconBookOpen,
  IconChevronDown,
  IconFileText,
  IconMark,
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
  /** "desktop" (P2-123 living home with ideas) | "mobile" (Bug 2 PWA home:
   * time-of-day greeting + mark, bottom-anchored composer, nothing else) */
  variant?: "desktop" | "mobile";
  /** P3-396: the same shell verdict the App computes (desktopBridge() !==
   * null). On the desktop shell the model hint resolves to dedicated copy +
   * a real credential journey; the phone keeps the daemon sentence, no
   * actions (per-surface keys, lesson P3-394). */
  desktopShell?: boolean;
};

type RecState = "idle" | "rec" | "busy";

/** P2-123: the living home (desktop empty state) — Claude-Desktop-style
 * serif greeting, a central composer with the model selector and three
 * clickable ideas. Every string comes from the dict. Bug 2 adds the mobile
 * variant: the same composer, anchored to the bottom, under a centered
 * greeting — no ideas, no cards. */
export default function HomeView({ machineName, request, voice, creating, onStart, variant = "desktop", desktopShell }: Props) {
  const t = useT();
  const mobile = variant === "mobile";
  const [input, setInput] = useState("");

  // P3-086 auto-grow, home twin of the ChatView effect: the home composer
  // grows with its content up to ~6 lines, then scrolls internally. Without
  // it the box stays one line tall and the user cannot reread long dictation.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 20;
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    el.style.height = "auto";
    el.style.height = `${clampComposerHeight(el.scrollHeight, lh, padY)}px`;
  }, [input]);
  const [error, setError] = useState(""); // dict copy only — never raw bodies
  const { models, model, pickModel } = useModelSelector(request);
  const [modelMenu, setModelMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // mic: real press-and-hold recording, same flow as the ChatView mic
  const [recState, setRecState] = useState<RecState>("idle");
  const recorder = useRef<WavRecorder | null>(null);
  // P2-201: host speech-to-text verdict — fail open while unknown (null),
  // disable with the actionable phrase once the daemon reports a problem.
  const stt = useSttStatus(request);
  const sttBlocked = !!stt && stt.state !== "ready";
  // P2-210: host model-readiness verdict. DELIBERATELY fail-open: this hint
  // never disables the composer and never blocks sending — blocking the
  // conversation because a probe says the machine has no credentials would be
  // worse than the late raw upstream error this calm line replaces. The
  // reason it exists at all is to explain the failure BEFORE the first send.
  // P3-396: bumping modelProbe re-probes (the hint block's "check again");
  // on the desktop shell the hint resolves to dedicated copy + real actions.
  const [modelProbe, bumpModelProbe] = useState(0);
  const modelStatus = useModelStatus(request, modelProbe);
  const modelHint = modelStatus && modelStatus.state !== "ready" ? modelStatus : null;
  const modelHintText = modelHint ? modelHintKey(modelHint.state, !!desktopShell) : null;

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

  // EVAL4-B: `autoSend` is true only for the composer submit (arrow / Enter):
  // the new chat then sends the text on open (lib/drafts.ts takeSendOnOpen).
  // Ideas stay edit-first (P2-123).
  async function start(prompt: string, autoSend = false) {
    const text = prompt.trim();
    if (!text || creating) return;
    setError("");
    if (autoSend) markSendOnOpen(text);
    const err = await onStart(text);
    if (err) setError(t("homeStartError")); // input stays — never lose the text
  }

  async function micDown() {
    if (!voice || sttBlocked || recState !== "idle") return;
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

  const ideas = mobile ? [] : homeIdeas(getLang());
  const name = machineName.trim();
  const greeting = mobile
    ? t(timeGreetingKey(new Date().getHours(), name !== ""), { name: name.toLowerCase() })
    : t(greetingKey(machineName), { name: machineName.toLowerCase() });

  return (
    <div className={mobile ? "home home-mobile" : "home"}>
      <div className="home-col">
        <div className="home-head">
          <div className="desk-greet-mark" aria-hidden>
            <IconMark size={mobile ? 32 : 26} />
          </div>
          <h2 className="home-greeting">{greeting}</h2>
        </div>

        <div className="home-composer">
          {modelHint && (
            <>
              <p className="composer-hint" role="status">
                {/* P3-396: desktop shell resolves the verdict to its own copy
                    (unit battery pins both locales); the phone keeps the
                    daemon's sentence untouched. */}
                {modelHintText ? t(modelHintText) : modelHint.message}
              </p>
              {/* P3-396: the credential journey — only when the desktop key
                  resolved (never on the phone, never for unknown). */}
              {modelHintText && (
                <ModelMissingActions status={modelHint} onRecheck={() => bumpModelProbe((n) => n + 1)} />
              )}
            </>
          )}
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
                  void start(input, true);
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
                      mobile ? t("agentOption") : "",
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
                disabled={!voice || recState === "busy" || sttBlocked}
                aria-label={recState === "rec" ? t("stopRecording") : t("recordVoice")}
                title={
                  sttBlocked
                    ? stt.message
                    : !voice
                      ? t("micNeedsPermission")
                      : recState === "rec"
                        ? t("stopRecording")
                        : t("recordVoice")
                }
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
                onClick={() => void start(input, true)}
                disabled={creating || !input.trim()}
                aria-label={t("send")}
                title={t("send")}
              >
                <IconArrowUp size={16} />
              </button>
            </div>
          </div>
          {sttBlocked && (
            <p className="composer-hint" role="status">
              {stt.message}
            </p>
          )}
          {error && (
            <div className="home-error" role="alert">
              {error}
            </div>
          )}
        </div>

        {ideas.length > 0 && (
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
        )}
      </div>
    </div>
  );
}
