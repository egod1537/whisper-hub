#!/bin/sh
set -eu

WHISPER_CPP_DIR="${WHISPER_CPP_DIR:-${HOME}/.local/share/whisper-hub/whisper.cpp}"
WHISPER_HOST="${WHISPER_HOST:-0.0.0.0}"
WHISPER_PORT="${WHISPER_PORT:-8080}"
SERVER="$WHISPER_CPP_DIR/build/bin/whisper-server"
MODEL_NAME="${WHISPER_MODEL:-large-v3}"
MODEL="$WHISPER_CPP_DIR/models/ggml-$MODEL_NAME.bin"

if [ ! -x "$SERVER" ] || [ ! -f "$MODEL" ]; then
  echo "whisper.cpp server or model not found; run scripts/setup-macos-whisper.sh first." >&2
  exit 1
fi

echo "Starting native macOS whisper-server with $MODEL_NAME on $WHISPER_HOST:$WHISPER_PORT."
echo "Keep port $WHISPER_PORT blocked from LAN/public access; Docker reaches it through host.docker.internal."
exec "$SERVER" --host "$WHISPER_HOST" --port "$WHISPER_PORT" -m "$MODEL" -l auto

