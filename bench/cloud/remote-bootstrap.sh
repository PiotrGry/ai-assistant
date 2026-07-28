#!/usr/bin/env bash
#
# Uruchamiany przez runpod-pipeline.sh na Podzie. Przygotowuje narzędzia,
# Ollamę i sprawdza dostępność dokładnie tych modeli, które obejmie test.
#
set -Eeuo pipefail

if (( $# < 4 )); then
  echo "Użycie: remote-bootstrap.sh REMOTE_ROOT MODELS_DIR PULL_MISSING MODEL..." >&2
  exit 2
fi

REMOTE_ROOT="$1"
MODELS_DIR="$2"
PULL_MISSING="$3"
shift 3
MODELS=("$@")

if [[ "$REMOTE_ROOT" != /* || "$MODELS_DIR" != /* ]]; then
  echo "REMOTE_ROOT i MODELS_DIR muszą być ścieżkami bezwzględnymi." >&2
  exit 2
fi

if [[ "$PULL_MISSING" != "true" && "$PULL_MISSING" != "false" ]]; then
  echo "PULL_MISSING musi mieć wartość true albo false." >&2
  exit 2
fi

missing_packages=()
command -v curl >/dev/null 2>&1 || missing_packages+=(curl)
command -v jq >/dev/null 2>&1 || missing_packages+=(jq)
command -v tmux >/dev/null 2>&1 || missing_packages+=(tmux)
[[ -r /etc/ssl/certs/ca-certificates.crt ]] || missing_packages+=(ca-certificates)

if (( ${#missing_packages[@]} > 0 )); then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates "${missing_packages[@]}"
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "Instaluję Ollamę..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

mkdir -p "$MODELS_DIR" "$REMOTE_ROOT/bench/cloud-runs"
export OLLAMA_MODELS="$MODELS_DIR"
export OLLAMA_HOST="127.0.0.1:11434"

if ! curl -fsS "$OLLAMA_HOST/api/version" >/dev/null 2>&1; then
  echo "Uruchamiam serwer Ollamy..."
  nohup env \
    OLLAMA_MODELS="$OLLAMA_MODELS" \
    OLLAMA_HOST="$OLLAMA_HOST" \
    ollama serve \
    >"$REMOTE_ROOT/bench/cloud-runs/ollama.log" 2>&1 &
fi

for ((attempt = 1; attempt <= 60; attempt++)); do
  if curl -fsS "$OLLAMA_HOST/api/version" >/dev/null 2>&1; then
    break
  fi
  if (( attempt == 60 )); then
    echo "Ollama nie uruchomiła się w ciągu 120 sekund." >&2
    tail -n 100 "$REMOTE_ROOT/bench/cloud-runs/ollama.log" >&2 || true
    exit 1
  fi
  sleep 2
done

echo "Ollama: $(curl -fsS "$OLLAMA_HOST/api/version" | jq -r '.version')"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,driver_version,memory.total \
    --format=csv,noheader
else
  echo "Brak nvidia-smi." >&2
  exit 1
fi

missing_models=()
for model in "${MODELS[@]}"; do
  if ollama show "$model" >/dev/null 2>&1; then
    echo "Model dostępny: $model"
  elif [[ "$PULL_MISSING" == "true" ]]; then
    echo "Pobieram brakujący model: $model"
    ollama pull "$model"
  else
    missing_models+=("$model")
  fi
done

if (( ${#missing_models[@]} > 0 )); then
  echo "Brak wymaganych modeli na Network Volume:" >&2
  printf '  - %s\n' "${missing_models[@]}" >&2
  echo "Ustaw RUNPOD_PULL_MISSING_MODELS=true, jeśli pipeline ma je pobrać." >&2
  exit 1
fi

echo
echo "Modele gotowe:"
ollama list
