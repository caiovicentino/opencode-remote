# opencode-remote

Remote control for this opencode instance: mobile PWA -> relay -> daemon -> local opencode.

## Pilot (autonomous development loop)

This repo evolves autonomously via the Pilot service (`apps/pilot`, docs in `docs/PILOT.md`):
agents implement tasks from `BACKLOG.md`, adversarial reviewers check them, a deterministic
gatekeeper runs the eval battery + `scripts/invariants.ts` (see `docs/CONSTITUTION.md`), and
deploys are staged with automatic rollback — production only ever runs gate-verified merge
SHAs (P2-058): direct pushes to main never deploy, and a failed deploy quarantines its SHA
so the redeploy loop cannot re-run a defective build. P0/P1 tasks first go through a PLANNER phase: a
read-only agent writes `specs/<ID>.md` on the task branch (problem, approach, touched files,
edge cases, acceptance criteria, out of scope) and the builder + quality reviewer are held to
it; P2+ tasks go straight to the builder (P2-008). Cognition is tiered (P1-059): pilot.json may set a
`models.tierB` block mapping the judgment roles (`strategist`, `planner`, `forensic`,
`reviewerEscalation`) to a stronger model — those roles then dispatch through the claude CLI
(`claude -p --model <m> --add-dir <workspace>`, prompt via stdin) with automatic tier-A fallback
on spawn error/timeout/empty output/missing completion marker (`tierB-fallback` in the log),
while builder/reviewers/scribe stay tier A (flash via `opencode run`) and the deterministic
evidence gate is unchanged; round-1 review divergence or all-unverifiable findings trigger at
most one tier-B escalation reviewer (`review-escalation` phase), and a weekly forensic pass
distills the failure record into a taxonomy at `~/.opencode-remote/pilot/forensic-latest.md`.
Tasks that keep failing the pipeline are circuit-broken
after `maxAttemptsPerTask` (default 4; a `(size: L)` task has its own cap of 6) attempts: moved to `## Blocked` in BACKLOG.md with the last
findings and never re-scheduled until a human/red team moves them back (P1-014). A task line may also carry a
`(size: L)` tag (P1-060): long-horizon epics scale budgets to 6 rounds/90min/6 attempts, and from round 2 on are
reviewed on the incremental diff since the round checkpoint (`~/.opencode-remote/pilot/checkpoints/<ID>.json`)
instead of the truncated whole-branch diff. Branch preservation across attempts is all-task behavior
(P1-060/P1-036): after any failed attempt the retry keeps the existing `pilot/<ID>` branch (the builder continues
the preserved history); only the first attempt starts clean at origin/main. A global
"fever" breaker (P2-032) pauses the whole queue in audit mode when >=3 DISTINCT tasks
fail within the last 10 pipeline cycles (P2-063: failures are aggregated by task id, so
one stubborn task burning through its own maxAttemptsPerTask breaker never pauses the
queue) or 2 tasks get blocked within 30min — it posts a diagnostic summary to
the log and resumes after external intervention (`touch ~/.opencode-remote/pilot/audit-clear`)
or 2h without a new failure. Once per day, alongside the red-team pass, a non-blocking
nightly EXPLORER agent (P3-052) drives the real desktop app through the P1-051 harness
in a fresh-state first-boot pass (clean userData) like a first-time user and files
journey/UX/robustness findings (shot + severity) as backlog lines,
budget-capped per run. Builders must end
their output with a final EVIDENCE block (real typecheck/test:unit outputs, plus 1440x900 and
390px screenshot paths for UI tasks) — the gatekeeper re-executes the cited commands and rejects
missing or fabricated evidence (P2-009). With `slots` > 1
in pilot.json the scheduler runs up to N pipelines concurrently, one workspace clone per slot
(`~/.opencode-remote/pilot/repo-1`, `repo-2`…), always on tasks with distinct `area:` tags —
two tasks of the same area never run in parallel, and deploys stay serial (P1-006). After every
successful merge a SCRIBE agent distills up to 3 engineering lessons into `docs/EXPERIENCE.md`
(P1-007) — the top-5 keyword-matched lessons are injected into the planner, builder and
strategist prompts (P2-042), and the nightly red-team pass dedupes/prunes the file above 60 lessons.
When the stop-loss moves a
task to `## Blocked`, a failure scribe records a structured `kind:"failure"` lesson (failing step,
findings, gate tail) in `~/.opencode-remote/pilot/lessons.jsonl` (P2-031) and the strategist and
planner prompts receive the 10 most recent failure lessons so new tasks avoid repeating blocked patterns.
If you are asked to change anything that
the constitution protects (crypto, allowlist, replay protection, deploy/), flag it explicitly in
the commit message. Never commit secrets. Always document user-visible changes.

## Memória do projeto (LER PRIMEIRO)

Histórico completo de trabalho, regras do usuário, avaliação de maturidade e backlog:
`~/.opencode-remote/memory.md` — leia antes de qualquer tarefa neste repo.
Regras rápidas: memórias (`~/.opencode-remote/memory.md`) NUNCA são comitadas;
fuso GMT-3; só reiniciar daemon/relay se o Caio pedir; checar `git log`
antes de assumir HEAD (um agente in-chat também commita neste repo).
This machine also runs a media pipeline for social clips. When the user sends a video and asks
to clip/edit it for social media, follow the pipeline below — everything runs locally.

## Video clipping skill (OpusClip-style, local)

Tools: `tools/clip.mjs` (needs whisper-cli + ffmpeg, already installed).

1. **Transcribe** (word-level timestamps):
   `node tools/clip.mjs transcribe <video>` — prints the path of a JSON with timed tokens.
2. **Select moments** — read that JSON yourself. Pick 1-6 segments of 15-60s that stand alone,
   have a hook in the first 3s and a clean ending (complete sentence). Write a `plan.json`:
   ```json
   { "transcriptJson": "/abs/path/transcript.wav.json",
     "clips": [
       { "start": 12.3, "end": 45.6, "title": "Short punchy title",
         "captions": true, "aspect": "9:16", "cropX": 0.5 }
     ] }
   ```
   `cropX`: 0 = left, 0.5 = center, 1 = right (who is talking in frame).
3. **Render**:
   `node tools/clip.mjs render <video> plan.json`
   — outputs 1080x1920 mp4s with burned karaoke captions to `~/.opencode-remote/clips/<video>/`.
4. Reply with title + absolute path of each clip. Do not re-encode with different codecs
   unless asked; keep the defaults (h264/aac, faststart, crf 20).

Videos the user sends from the phone are saved under `~/.opencode-remote/uploads/`.

## Entregando arquivos pro usuário (PDF, planilhas, relatórios...)

Quando gerar um artefato para o usuário, salve-o em `~/.opencode-remote/uploads/`
e inclua na sua resposta uma linha no formato:

    [file: /Users/<user>/.opencode-remote/uploads/relatorio.pdf]

O app do celular mostra um card com botão "Save" — o usuário salva direto
no telefone. Diretórios acessíveis para download: `~/.opencode-remote/uploads`,
`~/Desktop`, `~/Downloads`, `~/Documents` e o diretório deste repo.

Caption appearance can be customized: `~/.opencode-remote/clip-style.json` accepts
`font`, `fontSize`, `primary`, `secondary`, `outlineColor`, `outline` and `marginV`.
The phone app edits this file for you — if the user asks for a caption style change,
tell them to use Settings → Caption style.

## Conversão de documentos (doc → PDF)

Quando o usuário mandar um documento (`.docx .doc .rtf .html .csv .xlsx .pptx`) e quiser
um PDF de volta, rode `node tools/doc2pdf.mjs <arquivo>` (padrão: arquivos em
`~/.opencode-remote/uploads/`) — usa LibreOffice quando instalado, com fallback nativo
macOS (textutil+cupsfilter) p/ doc/docx/rtf/html/csv. A saída imprime `[file: <abs path>]`;
repita essa linha na resposta pro card de download aparecer no chat.

## Artifacts (documentos renderizáveis)

Quando o resultado for um documento (html, md, csv, pdf…), escreva-o em
`~/.opencode-remote/artifacts/<sessionId>/` e **mencione o nome do arquivo na
sua resposta** — o app desktop lista esses arquivos no pane "Artifacts"
(html em iframe sandboxed, md/tabelas e csv renderizados, pdf inline) e mostra
um card anexado na mensagem que cita o artifact. Use `uploads/` (método acima)
quando o objetivo for o usuário baixar o arquivo no celular.

## Auto-preview (site local abre sozinho no app)

Quando você subir um servidor/site local (http.server, vite, dev server…),
**mencione a URL `http://localhost:<porta>` na sua resposta** — o app desktop
abre o pane Browser sozinho (webview interativo, lado a lado com o chat).
A detecção é um parse determinístico de URLs loopback com porta explícita
(1..65535, exceto a própria porta do daemon 8792), dedupado por 10 minutos;
URLs não-loopback não disparam preview.

## Browser self-driving (validação visual de UI)

O daemon controla um Chromium headless no host via `/api/browse` (Playwright).
Para validar visualmente mudanças de UI, use o CLI:

    node tools/browse.mjs open <url> [shot.png]   # navegar (+ screenshot)
    node tools/browse.mjs shot <out.png>          # screenshot da página atual
    node tools/browse.mjs click "text=Settings"   # ou click <x> <y>
    node tools/browse.mjs text                    # extrair texto visível

O token vem de `~/.opencode-remote/daemon.json` (loopback apenas). Screenshots
pós-deploy ficam em `~/.opencode-remote/pilot/shots/` (evidência por task,
com retenção dos 20 mais recentes) e reviewers os citam no veredito
(docs/PILOT.md). Seus próprios checks pré-merge vão em
`~/.opencode-remote/pilot/shots/builder/` — o subdir builder não é usado como
evidência de review.

Desktop app: para interagir com o app Electron real use o harness
`tools/desktop.mjs` (`open/see/click/type/shot/ipc/close`, mesma DX do
browse.mjs) — launch hermético, sem daemon de produção. Quando o diff toca
`apps/desktop/` ou `apps/web/`, o gate roda `npm run test:desktop-flow` (fluxo
de interação real, <90s — P1-070 adicionou o bloco "local boot" com daemon
hermético real; P1-080 adicionou o repro de overflow do chat: bolha com diff
longo em janela estreita, nada pode sair do viewport; P1-089 adicionou o beat
queue→flush→reentrada com segundo boot hermético contra um fake de opencode:
fila offline drena no reboot, o burst de >500 eventos re-dispara idle antigo e
o count de bolhas fica estável em 3 re-entradas; ids de sessão do gate são
curtos de propósito — path de unix socket no macOS trunca em 104 chars); use `OCR_DESKTOP_SESSION` próprio para não colidir
com a sessão de outro processo. P1-081: com `OCR_DESKTOP_SESSION` setado o app
NÃO mostra janela (`showMainWindow` no-op + `paintWhenInitiallyHidden`, interação
100% via webContents) — a tela do operador nunca vê janela de teste; e
`test:e2e`/`test:desktop-flow` rodam `scripts/e2e-orphans.ts` antes (mata
órfãos electron/daemon/relay de runs anteriores — só processos com marker
argv E env `ocr-*`/`OCR_*` de teste; argv sozinho nunca mata) e todos os
servers e2e sobem em portas efêmeras com diagnóstico `lsof` no timeout.
