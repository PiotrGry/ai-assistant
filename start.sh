#!/usr/bin/env bash

set -Eeuo pipefail

BASE_DIR="$HOME/ai-assistant"
ASSISTANT="$BASE_DIR/assistant.sh"

# Model można podać argumentem (./start.sh qwen3:14b) albo przez OLLAMA_MODEL.
MODEL="${1:-${OLLAMA_MODEL:-hf.co/google/gemma-4-12B-it-qat-q4_0-gguf}}"
NUM_CTX="${OLLAMA_NUM_CTX:-8192}"

if [[ -z "${TMUX:-}" ]]; then
  echo "start.sh trzeba uruchomić wewnątrz sesji tmux." >&2
  echo "Najpierw: tmux new -s ada" >&2
  exit 1
fi

if [[ ! -x "$ASSISTANT" ]]; then
  echo "Brak wykonywalnego skryptu: $ASSISTANT" >&2
  exit 1
fi

if ! command -v nvtop >/dev/null 2>&1; then
  echo "Uwaga: brak nvtop, dolny panel zostanie pusty." >&2
fi

# zapamiętaj obecny pane (ten będzie Adą)
ADA_PANE="$(tmux display-message -p '#{pane_id}')"

# uruchom Adę w aktualnym pane
tmux send-keys \
  -t "$ADA_PANE" \
  "OLLAMA_MODEL=$MODEL OLLAMA_NUM_CTX=$NUM_CTX $ASSISTANT" \
  Enter

sleep 1

# dodaj dolny panel i od razu zapamiętaj jego id
# (-P -F zwraca id nowego pane, nie polegamy na tym, który pane jest aktywny)
BOTTOM_LEFT_PANE="$(
  tmux split-window \
    -v \
    -t "$ADA_PANE" \
    -c "$BASE_DIR" \
    -P -F '#{pane_id}'
)"

# podziel dolny panel w poziomie, na dwie kolumny
BOTTOM_RIGHT_PANE="$(
  tmux split-window \
    -h \
    -t "$BOTTOM_LEFT_PANE" \
    -c "$BASE_DIR" \
    -P -F '#{pane_id}'
)"

# nvtop w lewym dolnym, prawy dolny zostaje wolny na benchmarki
if command -v nvtop >/dev/null 2>&1; then
  tmux send-keys \
    -t "$BOTTOM_LEFT_PANE" \
    "nvtop" \
    Enter
fi

tmux select-pane -t "$BOTTOM_RIGHT_PANE"

# wróć do Ady
tmux select-pane -t "$ADA_PANE"
