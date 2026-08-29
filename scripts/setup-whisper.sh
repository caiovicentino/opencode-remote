#!/usr/bin/env bash
# opencode-remote: install local whisper for voice dictation (optional).
# Idempotent: safe to run multiple times. No cloud involved.
set -euo pipefail

DIR="$HOME/.opencode-remote/whisper"
MODEL="$DIR/ggml-base.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"

mkdir -p "$DIR"

have() { command -v "$1" >/dev/null 2>&1; }

BIN=""
if have whisper-cli; then
  BIN="$(command -v whisper-cli)"
elif have whisper-cpp; then
  BIN="$(command -v whisper-cpp)"
elif [ "$(uname -s)" = "Darwin" ] && have brew; then
  echo "==> installing whisper-cpp via Homebrew"
  brew install whisper-cpp
  BIN="$(command -v whisper-cli || command -v whisper-cpp)"
else
  echo "==> building whisper.cpp from source"
  if ! have cmake; then
    echo "cmake is required: brew install cmake | apt install cmake" >&2
    exit 1
  fi
  if [ ! -d "$DIR/whisper.cpp" ]; then
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$DIR/whisper.cpp"
  fi
  cmake -S "$DIR/whisper.cpp" -B "$DIR/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$DIR/whisper.cpp/build" --config Release -j
  BIN="$DIR/whisper.cpp/build/bin/whisper-cli"
  export PATH="$DIR/whisper.cpp/build/bin:$PATH"
fi

if [ ! -f "$MODEL" ]; then
  echo "==> downloading ggml-base model (~148MB) to $MODEL"
  if have curl; then
    curl -L --progress-bar -o "$MODEL.part" "$MODEL_URL" && mv "$MODEL.part" "$MODEL"
  else
    wget -q --show-progress -O "$MODEL.part" "$MODEL_URL" && mv "$MODEL.part" "$MODEL"
  fi
else
  echo "==> model already present"
fi

echo
echo "voice transcription ready:"
echo "  binary : $BIN"
echo "  model  : $MODEL"
echo "  test   : $BIN -m '$MODEL' -nt -f /path/to/audio.wav"
echo "restart the daemon (it detects whisper at boot) and re-pair or reload the PWA."
