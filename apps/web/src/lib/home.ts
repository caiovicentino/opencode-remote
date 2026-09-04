// P2-123: pure helpers for the living home screen (desktop empty state).
// No DOM, no React — every piece of copy resolves through lib/i18n so tests
// and per-locale checks work outside the component tree (P2-118 lesson).

import { translate, type Lang } from "./i18n";

/** The composer modes the home offers. "cowork" maps to the existing
 * "build" agent — no new backend, same key ChatView's composer reads. */
export const HOME_MODES = ["chat", "cowork"] as const;
export type HomeMode = (typeof HOME_MODES)[number];

/** Agent written to localStorage.ocr_agent for a home mode — the exact key
 * ChatView's composer persists its agent selection under. */
export function agentForMode(mode: HomeMode): string {
  return mode === "cowork" ? "build" : "";
}

/** Greeting dict key: never render a dangling comma when the machine name
 * hasn't arrived yet (settings still loading). */
export function greetingKey(machineName: string): string {
  return machineName.trim() ? "homeGreeting" : "homeGreetingAnon";
}

export type HomeIdeaIcon = "wrench" | "book" | "file";

export interface HomeIdea {
  id: string;
  icon: HomeIdeaIcon;
  label: string;
  prompt: string;
}

/** Exactly three clickable suggestions for the home screen, resolved in the
 * requested locale. Each opens a new session with `prompt` pre-filled. */
export function homeIdeas(lang: Lang): HomeIdea[] {
  const idea = (id: string, icon: HomeIdeaIcon, labelKey: string, promptKey: string): HomeIdea => ({
    id,
    icon,
    label: translate(lang, labelKey),
    prompt: translate(lang, promptKey),
  });
  return [
    idea("1", "wrench", "homeIdea1Label", "homeIdea1Prompt"),
    idea("2", "book", "homeIdea2Label", "homeIdea2Prompt"),
    idea("3", "file", "homeIdea3Label", "homeIdea3Prompt"),
  ];
}
