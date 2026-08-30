# Native shell (Capacitor) — recipe

The PWA is fully functional from the Home Screen, but iOS limits web push
and notification actions. A Capacitor wrapper unlocks native push SDKs,
widgets and Siri shortcuts without rewriting the app.

## Sketch

1. `npm create @capacitor/app@latest` inside `apps/native`, pointing
   `webDir` to a production build of `apps/web` (`vite build`).
2. Copy the pairing state: IndexedDB and localStorage survive inside the
   WebView — pairing, identity and biometric gate work unchanged
   (`apps/web/src/lib/client.ts` and `gate.ts` need no changes).
3. Replace the web-push subscription with native push:
   - iOS: APNs via `@capacitor-firebase/messaging` or OneSignal — the daemon
     would send through the platform instead of VAPID/web-push. Add a
     `platform: "apns" | "webpush"` field on the subscription endpoint
     stored in the daemon.
   - Android: keep web-push (works today) or move to FCM for actions.
4. Deep-links: `capacitor-plugin-app` handles `opencode-remote://pair` URIs —
   the QR flow already parses them (`parsePairingUri`).

## Why not the App Store yet

- Review requires a privacy policy + data-handling disclosure (all local —
  easy, but must be written).
- The daemon must be user-provided; make the pairing screen prominent since
  there is no hosted relay by design.

## Alternative: share extensions without an app

The iOS Shortcut recipe in Settings → "Share to agent" covers the
highest-value native integration (share sheet → agent) without an App Store
release.
