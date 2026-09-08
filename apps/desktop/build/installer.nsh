; P2-249 — custom uninstaller hook electron-builder already looks for at
; build/installer.nsh (NSIS target; included via the generated script and
; invoked through !ifmacrodef customUnInstall in the uninstaller template).
;
; This macro does exactly two things:
;   1. it deletes the "start at login" autostart entry that P2-218 created
;      in the per-user Run key, so the next Windows boot stops trying to
;      open an executable the uninstaller just removed;
;   2. nothing beyond that.
;
; This macro NEVER touches the Documents, Desktop or Downloads folders and
; never deletes any path outside the app's own data: its only disk-adjacent
; action is deleting registry values it owns. Wiping the app-data folder is
; electron-builder's own deleteAppDataOnUninstall option (see
; electron-builder.yml), not this macro's job.
!macro customUnInstall
  ; Electron's app.setLoginItemSettings({ openAtLogin: true }) writes one
  ; value under the CURRENT USER's Run key (HKCU — never HKLM; the install
  ; is per-user). Only the two candidate value names of this app are
  ; deleted — "OpenCode Remote" (productName) and "@ocr/desktop" (package
  ; name fallback) — so other applications' Run entries are untouched, and
  ; deleting a value that was never created is a safe no-op.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenCode Remote"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "@ocr/desktop"
!macroend
