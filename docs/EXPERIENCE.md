# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When shipping an asset loaded at runtime by Electron (tray icon, dock icon), name the Retina variant `<base>@2x.png` beside the base file so `nativeImage.createFromPath` auto-pairs them, add BOTH to electron-builder's `files`, and unit-tes… (fonte: P3-015)
- When loading an image asset that may be missing or corrupt, gate the load on both `existsSync` and `!createFromPath(path).isEmpty()` (a zero-byte file yields an empty NativeImage, not a thrown error) and keep an embedded data-URL fallback… (fonte: P3-015)
- When generating macOS template images, write pure alpha (RGB=0 — the menu bar recolors the mask, color is ignored) and call `setTemplateImage(true)` only on darwin, while keeping the asset/platform policy in an electron-free pure function… (fonte: P3-015)
