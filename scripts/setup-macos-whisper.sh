#!/bin/sh
set -eu

WHISPER_CPP_TAG="v1.9.5"
WHISPER_CPP_DIR="${WHISPER_CPP_DIR:-${HOME}/.local/share/whisper-hub/whisper.cpp}"
MODEL_NAME="large-v3"
MODEL_SHA256="64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This setup script is for macOS." >&2
  exit 1
fi
for tool in git cmake curl shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required command not found: $tool" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$WHISPER_CPP_DIR")"
if [ ! -d "$WHISPER_CPP_DIR/.git" ]; then
  git clone --depth 1 --branch "$WHISPER_CPP_TAG" https://github.com/ggml-org/whisper.cpp.git "$WHISPER_CPP_DIR"
else
  git -C "$WHISPER_CPP_DIR" fetch --depth 1 origin "refs/tags/$WHISPER_CPP_TAG:refs/tags/$WHISPER_CPP_TAG"
  git -C "$WHISPER_CPP_DIR" checkout --detach "$WHISPER_CPP_TAG"
fi

cmake -S "$WHISPER_CPP_DIR" -B "$WHISPER_CPP_DIR/build" -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build "$WHISPER_CPP_DIR/build" --config Release -j "$(sysctl -n hw.logicalcpu)"

mkdir -p "$WHISPER_CPP_DIR/models"
MODEL_PATH="$WHISPER_CPP_DIR/models/ggml-$MODEL_NAME.bin"
if [ ! -f "$MODEL_PATH" ]; then
  "$WHISPER_CPP_DIR/models/download-ggml-model.sh" "$MODEL_NAME" "$WHISPER_CPP_DIR/models"
fi
ACTUAL_SHA256="$(shasum -a 256 "$MODEL_PATH" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]; then
  echo "Model checksum mismatch. Expected $MODEL_SHA256, got $ACTUAL_SHA256" >&2
  exit 1
fi

echo "whisper.cpp $WHISPER_CPP_TAG built with Metal and multilingual $MODEL_NAME model verified."
echo "Start it with: WHISPER_CPP_DIR='$WHISPER_CPP_DIR' ./scripts/start-macos-whisper.sh"

