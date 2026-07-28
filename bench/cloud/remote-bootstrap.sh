#!/usr/bin/env bash
#
# Uruchamiany przez Taskfile na dowolnym hoście SSH. Przygotowuje narzędzia,
# Ollamę i sprawdza GPU oraz dokładnie te modele, które obejmie test.
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
command -v lspci >/dev/null 2>&1 || missing_packages+=(pciutils)
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

hardware_json="$("$REMOTE_ROOT/bench/cloud/hardware-info.sh")"
hardware_backend="$(jq -r '.backend' <<<"$hardware_json")"
if [[ "$hardware_backend" == "unknown" ]]; then
  echo "Nie wykryto obsługiwanego GPU NVIDIA ani AMD." >&2
  exit 1
fi
echo "Sprzęt:"
jq . <<<"$hardware_json"

if [[ "$hardware_backend" == "amd" && ! -e /dev/kfd ]]; then
  echo "Wykryto AMD, ale brakuje /dev/kfd wymaganego przez ROCm." >&2
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
  echo "Brak wymaganych modeli w $MODELS_DIR:" >&2
  printf '  - %s\n' "${missing_models[@]}" >&2
  echo "Ustaw BENCH_PULL_MISSING_MODELS=true, jeśli Taskfile ma je pobrać." >&2
  exit 1
fi

echo
echo "Modele gotowe:"
ollama list

echo
echo "Kontrola uruchomienia i rozmieszczenia modeli:"
num_ctx="${OLLAMA_NUM_CTX:-8192}"
for model in "${MODELS[@]}"; do
  printf '  %s ... ' "$model"
  curl -fsS --max-time 600 "$OLLAMA_HOST/api/chat" \
    -H 'Content-Type: application/json' \
    -d "$(
      jq -n \
        --arg model "$model" \
        --argjson num_ctx "$num_ctx" '
          {
            model: $model,
            messages: [{role: "user", content: "Odpowiedz: OK"}],
            stream: false,
            think: false,
            keep_alive: "5m",
            options: {
              num_ctx: $num_ctx,
              num_predict: 1,
              temperature: 0,
              seed: 42
            }
          }
        '
    )" >/dev/null

  placement="$(
    curl -fsS "$OLLAMA_HOST/api/ps" |
      jq -c --arg model "$model" '
        [
          .models[]?
          | select(
              .name == $model
              or .model == $model
              or (((.name // .model // "") | sub(":latest$"; "")) == ($model | sub(":latest$"; "")))
            )
        ][0] // {}
        | {
            size: (.size // null),
            size_vram: (.size_vram // null),
            context_length: (.context_length // null)
          }
      '
  )"
  size="$(jq -r '.size // empty' <<<"$placement")"
  size_vram="$(jq -r '.size_vram // empty' <<<"$placement")"

  if [[ -z "$size" || -z "$size_vram" ]]; then
    echo "brak danych /api/ps" >&2
    exit 1
  fi
  if (( size_vram < size )); then
    echo "CPU offload: $((size - size_vram)) B" >&2
    exit 1
  fi
  echo "100% GPU, context=$(jq -r '.context_length' <<<"$placement")"

  curl -fsS "$OLLAMA_HOST/api/generate" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg model "$model" '{model: $model, prompt: "", stream: false, keep_alive: 0}')" \
    >/dev/null || true
done
