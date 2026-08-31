# opencode-remote

Remote control for this opencode instance: mobile PWA -> relay -> daemon -> local opencode.

## Pilot (autonomous development loop)

This repo evolves autonomously via the Pilot service (`apps/pilot`, docs in `docs/PILOT.md`):
agents implement tasks from `BACKLOG.md`, adversarial reviewers check them, a deterministic
gatekeeper runs the eval battery + `scripts/invariants.ts` (see `docs/CONSTITUTION.md`), and
deploys are staged with automatic rollback. If you are asked to change anything that the
constitution protects (crypto, allowlist, replay protection, deploy/), flag it explicitly in
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
