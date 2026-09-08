// Window-bounds persistence (P3-008). The shell remembers where the user left
// the window: bounds are saved to userData/window-state.json on "close" and
// re-applied in createWindow(). Kept free of electron imports so
// scripts/unit.test.ts can exercise the decision logic (same pattern as
// tray.ts / pairing.ts) — main.ts injects screen.getAllDisplays() at runtime.
// P2-172: the maximized flag persists alongside the bounds (with the normal,
// un-maximized rect, so restore/maximize both survive a reboot). Fullscreen is
// explicitly out of scope: isFullScreen on macOS creates its own Space and
// restoring that standalone would be hostile — a fullscreen user still gets a
// correct window, just not an auto-fullscreened one.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeZoom } from "./zoomlevel";

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  /** True when the user quit with the window maximized (P2-172). */
  maximized?: boolean;
  /** The remembered View-menu zoom level (P2-238). Absent in files written
   * before P2-238 — that shape stays valid and means the default. */
  zoom?: number;
}

/** Matches Electron's Rectangle (only the fields we validate against). */
export interface DisplayArea {
  workArea: { x: number; y: number; width: number; height: number };
}

/** The pre-P3-008 fixed window size — the fallback for every invalid state. */
export const DEFAULT_WINDOW_BOUNDS: WindowBounds = { width: 1280, height: 820 };
/** Must stay in sync with the minWidth/minHeight passed to BrowserWindow. */
export const WINDOW_MIN = { width: 1024, height: 640 };

export function windowStateFile(userDataDir: string): string {
  return join(userDataDir, "window-state.json");
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Two rects share at least one visible pixel. */
function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/**
 * Validates raw (parsed or not) persisted state against the displays currently
 * attached. Returns the bounds to open the window with: a window parked on a
 * since-disconnected display (or an all-garbage file) falls back to the
 * default. Size-only state ({width, height}) is valid — Electron centers it.
 * The maximized flag survives every fallback: opening maximized on the primary
 * display is still the user's intent even when the old monitor is gone
 * (P2-172). Anything that is not a real boolean degrades to false.
 */
export function sanitizeWindowBounds(
  raw: unknown,
  displays: DisplayArea[],
  defaults: WindowBounds = DEFAULT_WINDOW_BOUNDS,
): WindowBounds {
  const b = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const maximized = b.maximized === true;
  // P2-238: zoom rides along additively — the field only appears when the file
  // carried a number (a legacy file keeps its exact old shape), and the value
  // is clamped by the pure zoom policy before it ever reaches the shell.
  const zoom = typeof b.zoom === "number" ? sanitizeZoom(b.zoom) : undefined;
  const withZoom = (bounds: WindowBounds): WindowBounds => (zoom === undefined ? bounds : { ...bounds, zoom });
  if (!finite(b.width) || !finite(b.height) || b.width <= 0 || b.height <= 0) {
    return withZoom({ ...defaults, maximized });
  }
  const bounds: WindowBounds = {
    width: Math.max(WINDOW_MIN.width, b.width),
    height: Math.max(WINDOW_MIN.height, b.height),
  };
  const x = b.x;
  const y = b.y;
  if (finite(x) && finite(y)) {
    // Validate against the attached displays before applying position: a
    // window parked on a since-disconnected display re-opens at the default.
    if (!displays.some((d) => intersects(d.workArea, { x, y, width: bounds.width, height: bounds.height }))) {
      return withZoom({ ...defaults, maximized });
    }
    bounds.x = x;
    bounds.y = y;
  }
  return withZoom({ ...bounds, maximized });
}

/**
 * Reads the persisted bounds; every failure (missing file, corrupted JSON,
 * wrong shape) degrades to the default instead of crashing the shell.
 */
export function loadWindowBounds(file: string, displays: DisplayArea[]): WindowBounds {
  try {
    return sanitizeWindowBounds(JSON.parse(readFileSync(file, "utf8")), displays);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[desktop] window-state unreadable (${file}), using defaults:`, err);
    }
    return { ...DEFAULT_WINDOW_BOUNDS };
  }
}

/** Persist bounds (plus the maximized flag and the remembered zoom level);
 * log-only on failure (a full disk must never block quit). A zoom of undefined
 * (test session, P2-238) is simply omitted from the file by JSON.stringify. */
export function saveWindowBounds(file: string, bounds: WindowBounds): boolean {
  try {
    writeFileSync(
      file,
      JSON.stringify({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: bounds.maximized === true,
        zoom: bounds.zoom,
      }),
    );
    return true;
  } catch (err) {
    console.error(`[desktop] window-state write failed (${file}):`, err);
    return false;
  }
}
