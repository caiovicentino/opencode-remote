# Native shell (Capacitor) — working setup

The PWA is fully functional from the Home Screen, but iOS limits web push
and notification actions. A Capacitor wrapper unlocks native push SDKs,
widgets and Siri shortcuts without rewriting the app.

## Status: scaffolded (apps/web/ios)

The iOS project lives in `apps/web/ios` (SPM-based, no CocoaPods needed).
The native shell loads the bundled `dist/` and the app connects to the relay
exactly like the PWA — pairing, E2E keys (IndexedDB), biometric gate and
web-push code paths are untouched.

## Build & run on a device

```bash
# from apps/web
npm run ios:sync     # vite build + cap sync ios
npm run ios:open     # opens Xcode
```

In Xcode: select the `App` target → Signing & Capabilities → set your team,
then Run on a device. First run requires trusting the developer in
Settings → VPN & Device Management.

## Regenerate after web changes

```bash
npm run ios:sync     # inside apps/web
```

`cap sync` copies `dist/` into the native project — always run it after a
build, or the native shell ships stale assets.

## Native push (next step)

The web-push (VAPID) subscription still works for the PWA. For APNs:

1. Add a `platform: "apns" | "webpush"` field to the subscription record
   stored by the daemon (`subscriptions.json`).
2. In the app, subscribe via `@capacitor/push-notifications` (already
   installed) and register the token through the E2E tunnel.
3. Daemon sends via web-push for webpush subs; via APNs (token-based auth
   with a `.p8` key) for apns subs.

## Distribution notes

- Review requires a privacy policy + data-handling disclosure (all local —
  easy, but must be written).
- The daemon must be user-provided; make the pairing screen prominent since
  there is no hosted relay by design.
- TestFlight needs an Apple Developer account ($99/yr). Sideload via Xcode
  is free and enough for personal use (expires every 7 days without a paid
  account).

## Alternative: share extensions without an app

The iOS Shortcut recipe in Settings → "Share to agent" covers the
highest-value native integration (share sheet → agent) without an App Store
release.
