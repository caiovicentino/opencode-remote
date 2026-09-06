// P2-229: pure global-hotkey planner for the desktop shell. Since P2-021 a
// plain close hides the window into the tray and the only way back was
// hunting the tray/menu-bar icon — a leigo user who closed the window by
// mistake had no obvious route back, while the stage-3 reference app in
// docs/VISION.md comes back with a key combination from anywhere. This module
// decides WHICH accelerator (if any) the shell registers system-wide and WHY,
// carrying a short static pt-BR phrase for the log and for the informational
// menu/tray item.
//
// Same module hygiene as quithint.ts / wakeplan.ts: NO electron, no node:fs,
// no fetch, no I/O of any kind — main.ts resolves the session flag, the
// environment and the owner's choice and applies the verdict, and
// scripts/unit.test.ts exercises every rule in plain Node. Phrases are short
// static pt-BR strings with no file paths, no URL schemes and no secrets (the
// P2-140 bar).
//
// RULE ORDER CONTRACT (the gate depends on it): the harness-session rule
// comes FIRST and must stay first — before any environment, packaged or
// accelerator-shape consideration — because tools/desktop.mjs and the
// npm run test:desktop-flow battery run on the operator's machine and a
// global shortcut registered by a test session would steal keys from the
// whole system. The second rule is the documented kill-switch environment
// variable.

/** Documented kill switch: setting this variable to "1" (the repo-wide OCR_*
 * convention) keeps the shell from registering any global shortcut. */
export const HOTKEY_DISABLE_ENV = "OCR_DESKTOP_DISABLE_HOTKEY";

/** Documented way for the owner to choose another accelerator (modifiers
 * required — validated fail-closed by acceleratorProblem). */
export const HOTKEY_USER_ENV = "OCR_DESKTOP_HOTKEY";

/** Documented ceiling for a custom accelerator string — generous for any
 * real combination, small enough to keep logs and menu labels honest. */
export const HOTKEY_MAX_LEN = 64;

/** Documented defaults. Deliberately distinct strings per platform so the
 * informational surfaces never show a token the OS would not render: macOS
 * spells Command, Windows/Linux spell Ctrl. "O" is for OpenCode Remote. */
export const DEFAULT_HOTKEY_MAC = "Command+Shift+O";
export const DEFAULT_HOTKEY_WINDOWS = "Ctrl+Shift+O";

/** The documented per-platform default (Windows/Linux share one shape). */
export function defaultHotkeyFor(platform: string): string {
  return platform === "darwin" ? DEFAULT_HOTKEY_MAC : DEFAULT_HOTKEY_WINDOWS;
}

/** Modifier tokens Electron accepts, compared case-insensitively. */
const MODIFIERS: ReadonlySet<string> = new Set([
  "commandorcontrol",
  "cmdorctrl",
  "command",
  "cmd",
  "control",
  "ctrl",
  "meta",
  "super",
  "alt",
  "option",
  "altgr",
  "shift",
]);

/** Key tokens the shell accepts — single letters, digits, function keys and a
 * conservative named-key set. Anything outside the allowlist is a problem. */
const KEYS: ReadonlySet<string> = new Set([
  ...("abcdefghijklmnopqrstuvwxyz".split("")),
  ...("0123456789".split("")),
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  "space",
  "tab",
  "enter",
  "return",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "escape",
  "plus",
  "minus",
]);

/**
 * Fail-closed validation of one accelerator string (any shape — the value may
 * come from the environment, so nothing is trusted). Returns null when the
 * combination is registerable, or one problem message in the daemon's plain
 * log-safe format — messages never echo the raw value. A bare key without a
 * modifier is always a problem: keyjacking a common key system-wide is
 * hostile to every other application.
 */
export function acceleratorProblem(raw: unknown): string | null {
  if (typeof raw !== "string") return "hotkey accelerator must be a string";
  if (raw.trim() === "") return "hotkey accelerator is empty";
  if (raw.length > HOTKEY_MAX_LEN) {
    return `hotkey accelerator is longer than the documented ceiling of ${HOTKEY_MAX_LEN} characters`;
  }
  const tokens = raw.split("+").map((t) => t.trim());
  if (tokens.some((t) => t === "")) return "hotkey accelerator has an empty token";
  const lower = tokens.map((t) => t.toLowerCase());
  const key = lower[lower.length - 1]!;
  const mods = lower.slice(0, -1);
  if (mods.length === 0) {
    return "hotkey accelerator needs at least one modifier — a bare key would be stolen from every application";
  }
  if (!mods.every((m) => MODIFIERS.has(m))) {
    return "hotkey accelerator has a modifier token that is not allowed";
  }
  if (!KEYS.has(key)) {
    return "hotkey accelerator has a key token that is not allowed";
  }
  return null;
}

export interface HotkeyPlan {
  /** true = register `accelerator` system-wide for this session. */
  register: boolean;
  /** The final accelerator to register (null when the plan refuses). */
  accelerator: string | null;
  /** Short static pt-BR phrase for the log and the informational item. */
  reason: string;
}

/** Everything the decision needs, resolved by the caller (main.ts) once after
 * the app is ready. No probe, no request and no timer is created for this. */
export interface HotkeyPlanInput {
  /** True when the hermetic test harness owns this session (the
   * OCR_DESKTOP_SESSION hatch) — it must never register anything. */
  harnessSession: boolean;
  /** The process environment (read for the documented kill switch). */
  env: Record<string, string | undefined>;
  /** The owner's accelerator choice (HOTKEY_USER_ENV), absent when unset. */
  userAccelerator: unknown;
  /** process.platform. */
  platform: string;
}

/**
 * Decide the shell's global-hotkey behavior. Rules apply in this exact order:
 *
 *  1. a test-harness session NEVER registers — the harness and the flow
 *     battery run on the operator's machine and a registered shortcut would
 *     steal system-wide keys (first rule by contract, see the header);
 *  2. the documented kill switch (HOTKEY_DISABLE_ENV=1) registers nothing;
 *  3. an owner accelerator that fails validation registers nothing — never a
 *     silent fallback to the default (fail-closed, the reason travels);
 *  4. a valid owner accelerator wins over the default;
 *  5. anything else registers the documented platform default.
 */
export function hotkeyPlan(input: HotkeyPlanInput): HotkeyPlan {
  if (input.harnessSession) {
    return {
      register: false,
      accelerator: null,
      reason: "sessão de teste do harness — nenhum atalho global é registrado",
    };
  }
  if (input.env[HOTKEY_DISABLE_ENV] === "1") {
    return {
      register: false,
      accelerator: null,
      reason: "atalho global desligado pela variável de ambiente",
    };
  }
  const chosen =
    typeof input.userAccelerator === "string" && input.userAccelerator.trim() !== ""
      ? input.userAccelerator.trim()
      : null;
  if (chosen !== null) {
    if (acceleratorProblem(chosen) !== null) {
      return {
        register: false,
        accelerator: null,
        reason: "atalho configurado pelo dono é inválido — nenhum atalho global entra no lugar",
      };
    }
    return {
      register: true,
      accelerator: chosen,
      reason: "atalho configurado pelo dono registrado",
    };
  }
  return {
    register: true,
    accelerator: defaultHotkeyFor(input.platform),
    reason: "atalho padrão da plataforma registrado",
  };
}
