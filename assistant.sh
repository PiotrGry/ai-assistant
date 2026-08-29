#!/usr/bin/env bash
set -Eeuo pipefail

MODEL="${OLLAMA_MODEL:-hf.co/google/gemma-4-12B-it-qat-q4_0-gguf}"
NUM_CTX="${OLLAMA_NUM_CTX:-8192}"
KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-10m}"
TEMPERATURE="${OLLAMA_TEMPERATURE:-0.3}"

BASE_DIR="$HOME/ai-assistant"
PROMPT_FILE="${ADA_PROMPT_FILE:-$BASE_DIR/prompts/system.md}"
LOG_DIR="$BASE_DIR/logs"

SESSION_ID="$(date +%Y%m%d_%H%M%S)"
METRICS_FILE="$LOG_DIR/session_${SESSION_ID}.jsonl"
TRANSCRIPT_FILE="$LOG_DIR/session_${SESSION_ID}.md"

HISTORY_FILE="$(mktemp)"
STREAM_FILE=""
CLEANED_UP=0
HAS_NVIDIA_SMI=0
PROMPT_BUFFER=""
SYSTEM_PROMPT=""
PROMPT_SHA=""

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
OLLAMA_CHAT_URL="$OLLAMA_BASE_URL/api/chat"

mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"

cleanup() {
  if (( CLEANED_UP )); then
    return 0
  fi
  CLEANED_UP=1

  rm -f "$HISTORY_FILE"
  if [[ -n "${STREAM_FILE:-}" ]]; then
    rm -f "$STREAM_FILE"
  fi

  printf '\nSesja zakończona.\n'
  printf 'Rozmowa: %s\n' "$TRANSCRIPT_FILE"
  printf 'Metryki: %s\n' "$METRICS_FILE"
}

on_signal() {
  local exit_code="$1"
  cleanup
  exit "$exit_code"
}

trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

check_dependencies() {
  local command_name
  for command_name in curl jq; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "Brakuje programu: $command_name" >&2
      exit 1
    fi
  done

  if command -v nvidia-smi >/dev/null 2>&1; then
    HAS_NVIDIA_SMI=1
  else
    echo "Uwaga: brak nvidia-smi, metryki GPU będą puste." >&2
  fi

  if ! curl -fsS "$OLLAMA_BASE_URL/api/tags" >/dev/null; then
    echo "Ollama nie odpowiada pod adresem: $OLLAMA_BASE_URL" >&2
    echo "Spróbuj uruchomić: ollama serve" >&2
    exit 1
  fi
}

load_system_prompt() {
  if [[ ! -r "$PROMPT_FILE" ]]; then
    echo "Nie mogę odczytać pliku promptu: $PROMPT_FILE" >&2
    exit 1
  fi

  SYSTEM_PROMPT="$(cat "$PROMPT_FILE")"

  if [[ -z "${SYSTEM_PROMPT//[[:space:]]/}" ]]; then
    echo "Plik promptu jest pusty: $PROMPT_FILE" >&2
    exit 1
  fi

  PROMPT_SHA="$(sha256sum "$PROMPT_FILE" | cut -c1-12)"
}

initialize_history() {
  jq -cn \
    --arg content "$SYSTEM_PROMPT" \
    '[{
      role: "system",
      content: $content
    }]' >"$HISTORY_FILE"
}

append_message() {
  local role="$1"
  local content="$2"
  local temporary_file
  temporary_file="$(mktemp)"

  if jq \
    --arg role "$role" \
    --arg content "$content" \
    '. + [{
      role: $role,
      content: $content
    }]' \
    "$HISTORY_FILE" >"$temporary_file"; then
    mv "$temporary_file" "$HISTORY_FILE"
  else
    rm -f "$temporary_file"
    return 1
  fi
}

drop_last_message() {
  local temporary_file
  temporary_file="$(mktemp)"

  if jq 'if length > 1 then .[0:-1] else . end' "$HISTORY_FILE" >"$temporary_file"; then
    mv "$temporary_file" "$HISTORY_FILE"
  else
    rm -f "$temporary_file"
    return 1
  fi
}

gpu_stats() {
  if (( ! HAS_NVIDIA_SMI )); then
    echo 'null'
    return 0
  fi

  local stats
  if ! stats="$(
    nvidia-smi \
      --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw \
      --format=csv,noheader,nounits 2>/dev/null
  )"; then
    echo 'null'
    return 0
  fi

  stats="${stats%%$'\n'*}"

  jq -cn \
    --arg stats "$stats" '
    def to_number: try tonumber catch null;
    ($stats | split(",") | map(gsub("^\\s+|\\s+$"; ""))) as $values
    | {
        utilization_percent: (($values[0] // "") | to_number),
        vram_used_mb: (($values[1] // "") | to_number),
        vram_total_mb: (($values[2] // "") | to_number),
        temperature_c: (($values[3] // "") | to_number),
        power_w: (($values[4] // "") | to_number)
      }
' || echo 'null'
}

show_help() {
  cat <<'EOF'
Dostępne komendy:
  /help       pokaż pomoc
  /clear      wyczyść pamięć bieżącej rozmowy
  /reload     wczytaj ponownie system prompt z pliku
  /stats      pokaż metryki ostatniej odpowiedzi
  /model      pokaż model, kontekst i stan Ollamy
  /unload     usuń model z pamięci GPU
  /exit       zakończ rozmowę

Wiadomość wieloliniową zakończ osobną linią /send.
Komendy zaczynające się od / działają od razu, bez /send.
EOF
}

show_last_stats() {
  if [[ ! -s "$METRICS_FILE" ]]; then
    echo "Nie ma jeszcze żadnych metryk."
    return
  fi

  tail -n 1 "$METRICS_FILE" |
    jq '{
      model,
      context,
      input_tokens,
      output_tokens,
      generation_tokens_per_second,
      total_seconds,
      load_seconds,
      gpu_before,
      gpu_after
    }'
}

unload_model() {
  if curl -fsS "$OLLAMA_BASE_URL/api/generate" \
    -H 'Content-Type: application/json' \
    -d "$(
      jq -cn \
        --arg model "$MODEL" '
      {
        model: $model,
        prompt: "",
        stream: false,
        keep_alive: 0
      }
'
    )" >/dev/null; then
    echo "Model został usunięty z pamięci."
  else
    echo "Nie udało się usunąć modelu z pamięci." >&2
  fi
}

save_transcript_entry() {
  local prompt="$1"
  local response="$2"
  {
    printf '## Ty\n\n%s\n\n' "$prompt"
    printf '## Pirx\n\n%s\n\n' "$response"
  } >>"$TRANSCRIPT_FILE"
}

save_metrics() {
  local timestamp="$1"
  local prompt="$2"
  local response="$3"
  local gpu_before="$4"
  local gpu_after="$5"
  local final_record="$6"

  jq -cn \
    --arg timestamp "$timestamp" \
    --arg model "$MODEL" \
    --arg prompt "$prompt" \
    --arg response "$response" \
    --arg prompt_file "$PROMPT_FILE" \
    --arg prompt_sha "$PROMPT_SHA" \
    --argjson context "$NUM_CTX" \
    --argjson temperature "$TEMPERATURE" \
    --argjson gpu_before "$gpu_before" \
    --argjson gpu_after "$gpu_after" \
    --argjson final "$final_record" '
  {
    timestamp: $timestamp,
    model: $model,
    context: $context,
    temperature: $temperature,
    system_prompt_file: $prompt_file,
    system_prompt_sha256: $prompt_sha,
    prompt: $prompt,
    response: $response,

    input_tokens: ($final.prompt_eval_count // 0),
    output_tokens: ($final.eval_count // 0),

    total_seconds:
      (($final.total_duration // 0) / 1000000000),

    load_seconds:
      (($final.load_duration // 0) / 1000000000),

    prompt_tokens_per_second:
      (
        if ($final.prompt_eval_duration // 0) > 0
        then
          (($final.prompt_eval_count // 0) /
          ($final.prompt_eval_duration / 1000000000))
        else 0
        end
      ),

    generation_tokens_per_second:
      (
        if ($final.eval_duration // 0) > 0
        then
          (($final.eval_count // 0) /
          ($final.eval_duration / 1000000000))
        else 0
        end
      ),

    done_reason: ($final.done_reason // null),

    gpu_before: $gpu_before,
    gpu_after: $gpu_after
  }
' >>"$METRICS_FILE"
}

chat_once() {
  local prompt="$1"
  local timestamp
  local request
  local assistant_response
  local final_record
  local gpu_before
  local gpu_after

  timestamp="$(date --iso-8601=seconds)"
  gpu_before="$(gpu_stats)"

  append_message "user" "$prompt"

  request="$(
    jq -cn \
      --arg model "$MODEL" \
      --arg keep_alive "$KEEP_ALIVE" \
      --argjson num_ctx "$NUM_CTX" \
      --argjson temperature "$TEMPERATURE" \
      --slurpfile messages "$HISTORY_FILE" '
    {
      model: $model,
      messages: $messages[0],
      stream: true,
      keep_alive: $keep_alive,
      options: {
        num_ctx: $num_ctx,
        temperature: $temperature
      }
    }
'
  )"

  STREAM_FILE="$(mktemp)"

  printf '\nPirx: '
  if ! curl -fsS "$OLLAMA_CHAT_URL" \
    -H 'Content-Type: application/json' \
    -d "$request" |
    tee "$STREAM_FILE" |
    jq --unbuffered -rj '
select(.message.content != null)
| .message.content
'; then
    printf '\n\nWystąpił błąd podczas komunikacji z Ollamą.\n'
    drop_last_message
    rm -f "$STREAM_FILE"
    STREAM_FILE=""
    return 1
  fi
  printf '\n\n'

  assistant_response="$(
    jq -rs '
  map(.message.content // "")
  | join("")
  ' "$STREAM_FILE"
  )"

  final_record="$(
    jq -s '
    map(select(.done == true))
    | if length > 0 then last else {} end
    ' "$STREAM_FILE"
  )"

  append_message "assistant" "$assistant_response"
  gpu_after="$(gpu_stats)"

  save_transcript_entry "$prompt" "$assistant_response"
  save_metrics \
    "$timestamp" \
    "$prompt" \
    "$assistant_response" \
    "$gpu_before" \
    "$gpu_after" \
    "$final_record"

  rm -f "$STREAM_FILE"
  STREAM_FILE=""

  show_last_stats
}

read_prompt() {
  local line
  PROMPT_BUFFER=""

  while true; do
    if ! IFS= read -r line; then
      return 1
    fi

    if [[ "$line" == "/send" ]]; then
      return 0
    fi

    if [[ -z "$PROMPT_BUFFER" ]]; then
      PROMPT_BUFFER="$line"
      if [[ "$line" == /* ]]; then
        return 0
      fi
    else
      PROMPT_BUFFER+=$'\n'"$line"
    fi
  done
}

main() {
  load_system_prompt
  check_dependencies
  initialize_history

  cat >"$TRANSCRIPT_FILE" <<EOF
# Rozmowa z Adą

- Model: \`$MODEL\`
- Kontekst: \`$NUM_CTX\`
- System prompt: \`$PROMPT_FILE\` (sha256: \`$PROMPT_SHA\`)
- Start: \`$(date --iso-8601=seconds)\`

EOF

  echo
  echo "Pirx — lokalna asystentka"
  echo "Model: $MODEL"
  echo "Kontekst: $NUM_CTX"
  echo "Prompt: $PROMPT_FILE ($PROMPT_SHA)"
  echo "Wpisz /help, aby zobaczyć komendy."

  while true; do
    echo
    echo "Ty: wpisz wiadomość. Zakończ osobną linią /send"

    if ! read_prompt; then
      break
    fi

    case "$PROMPT_BUFFER" in
    "")
      continue
      ;;

    /help)
      show_help
      ;;

    /clear)
      initialize_history
      echo "Pamięć bieżącej rozmowy została wyczyszczona."
      ;;

    /reload)
      load_system_prompt
      initialize_history
      echo "System prompt wczytany ponownie: $PROMPT_FILE ($PROMPT_SHA)"
      echo "Pamięć bieżącej rozmowy została wyczyszczona."
      ;;

    /stats)
      show_last_stats
      ;;

    /model)
      echo "Model: $MODEL"
      echo "Kontekst: $NUM_CTX"
      echo "Keep alive: $KEEP_ALIVE"
      echo "Temperatura: $TEMPERATURE"
      echo
      if command -v ollama >/dev/null 2>&1; then
        ollama ps
      else
        echo "Brak polecenia ollama w PATH."
      fi
      ;;

    /unload)
      unload_model
      ;;

    /exit | /quit)
      break
      ;;

    *)
      if [[ -z "${PROMPT_BUFFER//[[:space:]]/}" ]]; then
        continue
      fi
      chat_once "$PROMPT_BUFFER" || true
      ;;
    esac
  done
}

main "$@"
