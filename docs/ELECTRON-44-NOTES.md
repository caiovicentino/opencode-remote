# Electron 44 readiness — P2-066 spike notes

Task: [P2-066] — validate the desktop shell on the Electron 44 line and probe the
staged auto-update path that stage 5 (notarized DMG + Windows installer) will build on.

## Current state

- P2-015 already did the major jump 38.8.6 → 44.1.0 (d421bae) with no API breaks.
- This task pins the latest 44.x patch, **44.1.0 → 44.1.1** (the `latest` dist-tag at
  the time of writing), and re-validates the whole desktop battery on it.
- Packaged bundle verified as 44.1.1 (`Electron Framework.framework/Info.plist`
  → `CFBundleVersion = 44.1.1`).

Stack delivered by the 44 line: Chromium **152.0.7977.54**, V8 **15.2**, Node **24.18.1**.

## Validation battery (all green on 44.1.1)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | OK |
| `npm run build` (all workspaces) | OK |
| `npm run test:unit` | OK (all suites, incl. desktop-log) |
| `npm run test:desktop` (sidecar bundle smoke) | OK |
| `npm run test:desktop-render` (real shell render smoke) | OK — no console errors, `#root` mounted |
| `npm run test:desktop-update` (P2-012 feed, unit + e2e) | OK — 12/12 |
| `npm run test:desktop-flow` (P1-051 interaction gate) | OK — 4.0s (budget 60s) |
| `npm run test:desktop-crash` | OK |

`electron-builder --dir` completes with the usual dev-machine ad-hoc signing
(notarization still skipped — see stage-5 list below).

## Staged update feed probe (P2-012 non-regression)

The staged feed (`OCR_UPDATE_FEED`, `apps/desktop/src/update.ts`) was exercised on the
**packaged** 44.1.1 app (hermetic launch: `OCR_USER_DATA_DIR` + `OCR_DAEMON_FORCE_DOWN=1`):

- **Squirrel JSON feed** (`feed.json`, v0.2.1): decision line
  `[desktop] update-available: 0.2.1 — …` **and** the real `autoUpdater` event fired;
  Squirrel downloaded the staged release into its ShipIt cache. The follow-up
  `ditto: Couldn't read PKZip signature` error is the fake test artifact (the feed URL
  pointed at itself instead of a real .zip) and is log-only by design — the shell kept running.
- **latest-mac.yml feed**: parsed by our own `parseFeed` (the built-in autoUpdater rejects
  yml with "invalid response" — same behavior as measured on 44.1.0 in P2-012), decision
  line logged, no download attempted.

Conclusion: the P2-012 feed contract (opt-in, boot-only, log-only, never blocks/crashes)
did **not** regress on 44.

## Bundle size before/after (`dist --dir`, macOS arm64)

| Measurement | Electron 43.5.1 ("before") | Electron 44.1.1 ("after") | Δ |
| --- | --- | --- | --- |
| `OpenCode Remote.app` total | 286,948 KB (280.2 MB) | 295,876 KB (288.9 MB) | **+8.7 MB (+3.1%)** |
| `Electron Framework.framework` | 282,192 KB | 291,136 KB | +8.8 MB |
| `app.asar` (our code) | 1,716,482 B | 1,716,482 B | 0 |

The runtime growth is the price of two Chromium majors (150 → 152) plus the ANGLE
static-linking change below; app code footprint is untouched.

## Breaking changes in 44 vs our surface (audit)

| Breaking change (44 release notes) | Impact here |
| --- | --- |
| `clipboard` module rearchitected (async `ClipboardItem`); **no longer exposed to renderers** | None — renderer already uses `navigator.clipboard` (`apps/web/src/lib/clipboard.ts`); main/preload never import electron `clipboard` |
| macOS 12 dropped (macOS 13+ required) | Already documented in READMEs since P2-015 |
| ANGLE statically linked — `libEGL`/`libGLESv2` no longer shipped | None (we never swap these libs); contributes most of the +3.1% runtime size |
| `select-client-certificate`: `webContents` can be `null` | None — no client-cert handlers |
| `net.request` rejects frame destinations without navigate mode | None — no `net.request` usage |
| `app.isUnityRunning()` removed (Linux) | Not used |
| `openAsHidden` removed from `setLoginItemSettings` | We only pass `openAtLogin` (`apps/desktop/src/main.ts:684`) — clean |
| Windows x86 (ia32) / Linux armv7l prebuilds dropped | Only relevant to stage 5: Windows targets must be x64/arm64 |

## What's missing for signed MSIX auto-update on Windows (stage 5)

Electron's MSIX auto-updater (RFC 0021, landed in v39.5.0, completed) reroutes
`autoUpdater` to the WinRT `PackageManager` APIs when the app has **package identity**
(`windowsPackagedApp.getPackagedAppInfo()`), and its feed is the **Squirrel.Mac JSON
format** — exactly the shape `update.ts` already parses and hands to Squirrel, so the
staged-feed spike carries over to Windows unchanged.

Still needed before stage 5 can ship it:

1. **Packaging target**: `electron-builder.yml` only builds `target: dir` today. An MSIX
   target needs a build path (electron-builder still lacks a first-class `msix` target;
   options are the `electron-windows-msix` package used by Slack's implementation or a
   Forge maker), including AppxManifest with our `opencode-remote://` protocol registration.
2. **Code-signing identity**: MSIX requires a signed package to establish package
   identity — a Microsoft-trusted code-signing cert (organization-validated for
   `signatureKind: enterprise/store`; self-signed only works for sideloading tests).
3. **Update feed hosting**: the JSON feed must serve real `.msix` package URLs over
   HTTPS; `updatePackage(packageUri)`/`deployPackage()` do the rest through the OS.
4. **ASAR integrity**: the 41+ line added the Windows ASAR integrity digest; enable the
   fuse when we start shipping signed installers so the OS-verified package validates the
   asar at load.
5. **macOS counterpart** (same stage): notarization is still unconfigured
   (`skipped macOS notarization` in builder output) — needs an App Store Connect API key
   and a `notarize` config in `electron-builder.yml`.

## Rollback

The only functional diff is the devDependency pin `44.1.0 → 44.1.1`; a single
`git revert` restores the previous state. No crypto/allowlist/deploy files were touched.

Sources: [Electron 44 blog post](https://electronjs.org/blog/electron-44-0),
[electron/rfcs#21 — MSIX Auto Updater](https://github.com/electron/rfcs/blob/main/text/0021-msix-auto-updater.md).
