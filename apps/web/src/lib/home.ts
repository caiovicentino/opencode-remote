// P2-123: pure helpers for the living home screen (desktop empty state).
// No DOM, no React — every piece of copy resolves through lib/i18n so tests
// and per-locale checks work outside the component tree (P2-118 lesson).

import { translate, type Lang } from "./i18n";

/** Greeting dict key: never render a dangling comma when the machine name
 * hasn't arrived yet (settings still loading). */
export function greetingKey(machineName: string): string {
  return machineName.trim() ? "homeGreeting" : "homeGreetingAnon";
}

/**
 * PWA home (Bug 2): time-of-day greeting key ("Boa tarde, {name}"). Morning
 * 5–11, afternoon 12–17, evening otherwise; an hour outside 0–23 (or not an
 * integer) falls back to the timeless greeting so the copy is never wrong,
 * only less specific. `hasName` picks the "{name}" or the anonymous variant.
 */
export function timeGreetingKey(hour: number, hasName: boolean): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return hasName ? "homeGreeting" : "homeGreetingAnon";
  const part = hour >= 5 && hour <= 11 ? "Morning" : hour >= 12 && hour <= 17 ? "Afternoon" : "Evening";
  return `home${part}${hasName ? "" : "Anon"}`;
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
