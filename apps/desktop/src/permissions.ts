// Permission policy for the desktop shell (P2-182). The Electron default is
// to grant several permissions silently, and the app ships signed/notarized
// with camera+microphone usage descriptions — so a permission request made by
// a third-party page loaded in the Browser pane would surface to the OS as
// our product asking. This module is the single gate in front of both
// permission handlers: only media, clipboard-sanitized-write and fullscreen
// are ever allowed, and only for the shell's own origin (the packaged
// bundle's file: scheme or exactly the dev URL when one is configured).
// Everything else — including every permission listed below that we never
// need and any name a future Chromium adds — is denied with a stable reason.
// Pure on purpose — no electron, no node builtins — so scripts/unit.test.ts
// exercises the real code (same pattern as extlink.ts); main.ts injects the
// raw strings at runtime.

/** Permissions the shell UI itself needs, nothing more. */
export const SHELL_PERMISSIONS = ["media", "clipboard-sanitized-write", "fullscreen"] as const;

const SHELL_PERMISSION_SET = new Set<string>(SHELL_PERMISSIONS);

/** Permissions with their own refusal reason, so the log reads clearly. */
const DENIED_PERMISSION_REASONS: Record<string, string> = {
  geolocation: "geolocation-denied",
  notifications: "notifications-denied",
  midi: "midi-denied",
  midiSysex: "midiSysex-denied",
  hid: "hid-denied",
  serial: "serial-denied",
  usb: "usb-denied",
  openExternal: "openExternal-denied",
  pointerLock: "pointerLock-denied",
  "idle-detection": "idle-detection-denied",
  "window-management": "window-management-denied",
};

export interface PermissionContext {
  /** Dev server origin (OCR_WEB_URL) that counts as the shell's own origin. */
  devUrl?: string;
  /** P2-117 test hatch (OCR_DESKTOP_CAMERA_BLOCK=1): deny media even for the shell. */
  cameraBlocked: boolean;
}

export interface PermissionDecision {
  allow: boolean;
  /** Stable, log-safe reason; always non-empty, also on the allow path. */
  reason: string;
}

function deny(reason: string): PermissionDecision {
  return { allow: false, reason };
}

/**
 * Lowercased scheme of a raw URL string, or "unknown" when it cannot be
 * parsed. Safe for logs — only the scheme, never the URL itself.
 */
export function requestingScheme(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  try {
    return new URL(raw).protocol.replace(/:$/, "").toLowerCase() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Decides a permission request for the desktop shell. Only names in
 * SHELL_PERMISSIONS pass, and only when the requester is the shell's own
 * origin: the file: scheme of the packaged bundle, or exactly the configured
 * dev URL's origin. The scheme comparison is case-insensitive, so uppercase
 * variants ("FILE://…") cannot slip past the check. Non-strings, empty
 * input, unparseable URLs and opaque origins are denied. Never throws.
 */
export function permissionDecision(
  name: unknown,
  requestingUrl: unknown,
  ctx: PermissionContext,
): PermissionDecision {
  if (typeof name !== "string") return deny("permission-not-a-string");
  if (!name) return deny("empty-permission");
  if (typeof requestingUrl !== "string") return deny("not-a-string");
  const candidate = requestingUrl.trim();
  if (!candidate) return deny("empty");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return deny("unparseable-url");
  }
  // WHATWG lowercases the protocol, but keep the explicit toLowerCase so the
  // intent survives even if the parser ever stops normalizing.
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();

  // file: URLs have an opaque origin ("null") by design — the scheme alone
  // identifies the packaged bundle, so it is checked directly.
  let shellOrigin = scheme === "file";
  if (!shellOrigin) {
    const origin = url.origin;
    if (!origin || origin === "null") return deny("missing-origin");
    if (ctx.devUrl) {
      try {
        shellOrigin = new URL(ctx.devUrl).origin === origin;
      } catch {
        // Unparseable dev URL counts as "no dev URL" — file: still passes.
      }
    }
  }
  if (!shellOrigin) return deny(`origin-not-shell:${scheme}`);

  if (!SHELL_PERMISSION_SET.has(name)) {
    return deny(DENIED_PERMISSION_REASONS[name] ?? `permission-not-allowed:${name}`);
  }
  if (name === "media" && ctx.cameraBlocked) return deny("camera-blocked");
  return { allow: true, reason: "shell-permission-allowed" };
}
