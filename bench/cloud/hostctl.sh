#!/usr/bin/env bash
#
# Provider-agnostic transport benchmarku przez SSH.
# Tworzenie i usuwanie maszyny pozostaje świadomą operacją w panelu dostawcy.
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
CONFIG_FILE="${BENCH_HOST_CONFIG:-$SCRIPT_DIR/host.env}"
STATE_FILE="${BENCH_HOST_STATE:-$SCRIPT_DIR/.host-state.json}"
KNOWN_HOSTS_FILE="${BENCH_KNOWN_HOSTS:-$SCRIPT_DIR/known_hosts}"

if [[ -f "$CONFIG_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
fi

: "${BENCH_SSH_PORT:=22}"
: "${BENCH_SSH_USER:=root}"
: "${BENCH_SSH_KEY:=$HOME/.ssh/id_ed25519}"
: "${BENCH_REMOTE_DIR:=/workspace/ai-assistant}"
: "${BENCH_MODELS_DIR:=/workspace/ollama/models}"
: "${BENCH_PULL_MISSING_MODELS:=false}"
: "${BENCH_SSH_TIMEOUT_SECONDS:=600}"
: "${BENCH_JOB_TIMEOUT_SECONDS:=14400}"
: "${BENCH_POLL_SECONDS:=20}"

: "${CLOUD_BENCH_MODELS:=gemma4:31b-it-q4_K_M qwen3.6:35b-a3b-q4_K_M qwen3:32b-q4_K_M qwen3:14b-q4_K_M}"
: "${CLOUD_BENCH_THINK:=true}"
: "${CLOUD_BENCH_REPEATS:=1}"
: "${CLOUD_BENCH_SEED:=42}"
: "${CLOUD_BENCH_MAX_TIME:=600}"
: "${CLOUD_OLLAMA_TEMPERATURE:=0}"
: "${CLOUD_OLLAMA_NUM_CTX:=8192}"
: "${CLOUD_OLLAMA_NUM_PREDICT:=4096}"

case "$BENCH_SSH_KEY" in
  \~/*) BENCH_SSH_KEY="$HOME/${BENCH_SSH_KEY#\~/}" ;;
esac

# Tagi modeli nie zawierają spacji.
# shellcheck disable=SC2206
MODELS=($CLOUD_BENCH_MODELS)

die() {
  echo "BŁĄD: $*" >&2
  exit 1
}

info() {
  printf '\n== %s ==\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Brakuje programu: $1"
}

require_tools() {
  local command_name
  for command_name in jq ssh scp tar; do
    require_command "$command_name"
  done
}

validate_config() {
  [[ -n "${BENCH_SSH_HOST:-}" ]] ||
    die "Brak BENCH_SSH_HOST. Skopiuj host.env.example do host.env."
  [[ "$BENCH_SSH_PORT" =~ ^[1-9][0-9]*$ ]] ||
    die "BENCH_SSH_PORT musi być dodatnią liczbą całkowitą."
  [[ "$BENCH_REMOTE_DIR" == /* && "$BENCH_MODELS_DIR" == /* ]] ||
    die "Zdalne katalogi muszą być ścieżkami bezwzględnymi."
  [[ -r "$BENCH_SSH_KEY" ]] ||
    die "Nie mogę odczytać klucza SSH: $BENCH_SSH_KEY"
  [[ "$BENCH_PULL_MISSING_MODELS" == "true" || "$BENCH_PULL_MISSING_MODELS" == "false" ]] ||
    die "BENCH_PULL_MISSING_MODELS musi mieć wartość true albo false."
  [[ "$CLOUD_BENCH_THINK" == "true" || "$CLOUD_BENCH_THINK" == "false" ]] ||
    die "CLOUD_BENCH_THINK musi mieć wartość true albo false."
  (( ${#MODELS[@]} > 0 )) || die "Lista modeli jest pusta."

  local model
  for model in "${MODELS[@]}"; do
    [[ "$model" =~ ^[A-Za-z0-9._:/-]+$ ]] ||
      die "Nieprawidłowy tag modelu: $model"
  done
}

ssh_args() {
  SSH_ARGS=(
    -i "$BENCH_SSH_KEY"
    -p "$BENCH_SSH_PORT"
    -o BatchMode=yes
    -o ConnectTimeout=10
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=4
    -o StrictHostKeyChecking=accept-new
    -o UserKnownHostsFile="$KNOWN_HOSTS_FILE"
  )
}

scp_args() {
  SCP_ARGS=(
    -i "$BENCH_SSH_KEY"
    -P "$BENCH_SSH_PORT"
    -o BatchMode=yes
    -o ConnectTimeout=10
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=4
    -o StrictHostKeyChecking=accept-new
    -o UserKnownHostsFile="$KNOWN_HOSTS_FILE"
  )
}

remote_exec() {
  ssh_args
  # Polecenia są budowane przez printf %q/shell_quote.
  # shellcheck disable=SC2029
  ssh "${SSH_ARGS[@]}" "$BENCH_SSH_USER@$BENCH_SSH_HOST" "$@"
}

shell_quote() {
  printf '%q' "$1"
}

wait_for_ssh() {
  local started now
  started="$(date +%s)"
  mkdir -p "$(dirname "$KNOWN_HOSTS_FILE")"
  touch "$KNOWN_HOSTS_FILE"
  chmod 600 "$KNOWN_HOSTS_FILE"

  while true; do
    ssh_args
    if ssh "${SSH_ARGS[@]}" "$BENCH_SSH_USER@$BENCH_SSH_HOST" true >/dev/null 2>&1; then
      return 0
    fi
    now="$(date +%s)"
    if (( now - started >= BENCH_SSH_TIMEOUT_SECONDS )); then
      die "SSH nie odpowiada od $BENCH_SSH_TIMEOUT_SECONDS sekund."
    fi
    printf '.'
    sleep 10
  done
}

state_get() {
  local query="$1"
  [[ -s "$STATE_FILE" ]] || return 1
  jq -er "$query" "$STATE_FILE"
}

state_replace() {
  local json="$1"
  local tmp
  tmp="$(mktemp "$STATE_FILE.tmp.XXXXXX")"
  printf '%s\n' "$json" | jq . >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

state_update() {
  local filter="$1"
  shift
  local tmp
  [[ -s "$STATE_FILE" ]] || die "Brak stanu: $STATE_FILE"
  tmp="$(mktemp "$STATE_FILE.tmp.XXXXXX")"
  jq "$@" "$filter" "$STATE_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

require_state() {
  state_get '.job.run_id' >/dev/null 2>&1 ||
    die "Brak uruchomionego jobu. Najpierw wykonaj task cloud:run."
  [[ "$(state_get '.host')" == "$BENCH_SSH_HOST" ]] ||
    die "Stan dotyczy innego hosta niż bieżący host.env."
}

cmd_plan() {
  cat <<EOF
Host:           ${BENCH_SSH_USER}@${BENCH_SSH_HOST:-NIE USTAWIONO}:$BENCH_SSH_PORT
Klucz SSH:      $BENCH_SSH_KEY
Katalog:        $BENCH_REMOTE_DIR
Modele:
$(printf '  - %s\n' "${MODELS[@]}")
Konfiguracja:   think=$CLOUD_BENCH_THINK repeats=$CLOUD_BENCH_REPEATS seed=$CLOUD_BENCH_SEED
                temperature=$CLOUD_OLLAMA_TEMPERATURE ctx=$CLOUD_OLLAMA_NUM_CTX num_predict=$CLOUD_OLLAMA_NUM_PREDICT

Maszynę tworzysz i usuwasz ręcznie w panelu dostawcy.
EOF
}

cmd_doctor() {
  require_tools
  validate_config

  info "Sprawdzam SSH i sprzęt"
  wait_for_ssh
  remote_exec "
    set -Eeuo pipefail
    echo \"host=\$(hostname)\"
    echo \"system=\$(uname -srm)\"
    echo
    if command -v nvidia-smi >/dev/null 2>&1; then
      nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
    elif command -v amd-smi >/dev/null 2>&1; then
      amd-smi static
    elif command -v rocm-smi >/dev/null 2>&1; then
      rocm-smi --showproductname --showmeminfo vram
    else
      lspci 2>/dev/null | grep -Ei 'VGA|Display' || true
    fi
    echo
    df -h $(shell_quote "$BENCH_REMOTE_DIR") 2>/dev/null || df -h /
  "
  echo "Host jest dostępny."
}

cmd_sync() {
  require_tools
  validate_config
  wait_for_ssh

  local paths=(
    bench/run.sh
    bench/report.sh
    bench/grade.sh
    bench/grades.jsonl
    bench/README.md
    bench/cases.jsonl
    bench/contested_cases.jsonl
    bench/cloud/hardware-info.sh
    bench/cloud/remote-bootstrap.sh
    bench/cloud/remote-job.sh
    prompts/system.md
  )
  local path
  for path in "${paths[@]}"; do
    [[ -f "$BASE_DIR/$path" ]] || die "Brak pliku: $path"
  done

  info "Synchronizuję kod benchmarku"
  tar -C "$BASE_DIR" -czf - "${paths[@]}" |
    remote_exec \
      "mkdir -p $(shell_quote "$BENCH_REMOTE_DIR") && tar -xzf - -C $(shell_quote "$BENCH_REMOTE_DIR")"
}

cmd_prepare() {
  require_tools
  validate_config
  wait_for_ssh

  local command
  printf -v command '%q ' \
    env \
    "OLLAMA_NUM_CTX=$CLOUD_OLLAMA_NUM_CTX" \
    bash \
    "$BENCH_REMOTE_DIR/bench/cloud/remote-bootstrap.sh" \
    "$BENCH_REMOTE_DIR" \
    "$BENCH_MODELS_DIR" \
    "$BENCH_PULL_MISSING_MODELS" \
    "${MODELS[@]}"

  info "Przygotowuję Ollamę i modele"
  remote_exec "$command"
}

cmd_start() {
  require_tools
  validate_config
  wait_for_ssh

  if state_get '.job.run_id' >/dev/null 2>&1 &&
    ! state_get '.job.local_archive' >/dev/null 2>&1; then
    die "Poprzedni job nie został jeszcze pobrany. Użyj status/wait/collect."
  fi

  local run_id session machine_id remote_dir inner_command tmux_command
  run_id="$(date -u +%Y%m%dT%H%M%SZ)"
  session="pirx-$run_id"
  machine_id="${BENCH_MACHINE_ID:-$(remote_exec 'hostname -s 2>/dev/null || hostname')}"
  remote_dir="$BENCH_REMOTE_DIR/bench/cloud-runs/$run_id"

  printf -v inner_command '%q ' \
    env \
    "BENCH_THINK=$CLOUD_BENCH_THINK" \
    "BENCH_REPEATS=$CLOUD_BENCH_REPEATS" \
    "BENCH_SEED=$CLOUD_BENCH_SEED" \
    "BENCH_MAX_TIME=$CLOUD_BENCH_MAX_TIME" \
    "OLLAMA_TEMPERATURE=$CLOUD_OLLAMA_TEMPERATURE" \
    "OLLAMA_NUM_CTX=$CLOUD_OLLAMA_NUM_CTX" \
    "OLLAMA_NUM_PREDICT=$CLOUD_OLLAMA_NUM_PREDICT" \
    bash \
    "$BENCH_REMOTE_DIR/bench/cloud/remote-job.sh" \
    "$run_id" \
    "$machine_id" \
    "$BENCH_REMOTE_DIR" \
    "$BENCH_MODELS_DIR" \
    "${MODELS[@]}"

  printf -v tmux_command 'tmux new-session -d -s %q %q' \
    "$session" \
    "$inner_command"

  remote_exec "mkdir -p $(shell_quote "$remote_dir") && $tmux_command"

  state_replace "$(
    jq -n \
      --arg host "$BENCH_SSH_HOST" \
      --arg port "$BENCH_SSH_PORT" \
      --arg user "$BENCH_SSH_USER" \
      --arg run_id "$run_id" \
      --arg session "$session" \
      --arg remote_dir "$remote_dir" \
      --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
        {
          host: $host,
          port: ($port | tonumber),
          user: $user,
          job: {
            run_id: $run_id,
            session: $session,
            remote_dir: $remote_dir,
            started_at: $started_at
          }
        }
      '
  )"

  echo "Benchmark uruchomiony: $run_id"
}

remote_status() {
  local remote_dir
  require_state
  remote_dir="$(state_get '.job.remote_dir')"
  remote_exec \
    "if [[ -s $(shell_quote "$remote_dir/status.json") ]]; then cat $(shell_quote "$remote_dir/status.json"); else jq -n '{stage:\"starting\",message:\"Job przygotowuje status.\"}'; fi"
}

cmd_status() {
  require_tools
  validate_config
  require_state
  remote_status | jq .
}

cmd_logs() {
  local lines="${1:-100}"
  [[ "$lines" =~ ^[1-9][0-9]*$ ]] || die "Podaj dodatnią liczbę linii."
  require_tools
  validate_config
  require_state
  local remote_dir
  remote_dir="$(state_get '.job.remote_dir')"
  remote_exec "tail -n $lines $(shell_quote "$remote_dir/pipeline.log")"
}

cmd_wait() {
  require_tools
  validate_config
  require_state

  local started now status stage message
  started="$(date +%s)"
  while true; do
    status="$(remote_status)"
    stage="$(jq -r '.stage' <<<"$status")"
    message="$(jq -r '.message' <<<"$status")"
    printf '%s  %-10s %s\n' "$(date +%H:%M:%S)" "$stage" "$message"

    case "$stage" in
      complete) return 0 ;;
      failed)
        cmd_logs 120 || true
        die "Benchmark zakończył się błędem."
        ;;
    esac

    now="$(date +%s)"
    if (( now - started >= BENCH_JOB_TIMEOUT_SECONDS )); then
      die "Przekroczono limit oczekiwania; job nadal działa na hoście."
    fi
    sleep "$BENCH_POLL_SECONDS"
  done
}

local_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

cmd_collect() {
  require_tools
  validate_config
  require_state

  local status stage archive expected_sha run_id destination local_archive actual_sha
  status="$(remote_status)"
  stage="$(jq -r '.stage' <<<"$status")"
  [[ "$stage" == "complete" ]] ||
    die "Archiwum nie jest gotowe (stage=$stage). Użyj task cloud:wait."

  archive="$(jq -r '.archive' <<<"$status")"
  expected_sha="$(jq -r '.sha256' <<<"$status")"
  run_id="$(jq -r '.run_id' <<<"$status")"
  destination="$BASE_DIR/bench/cloud-results/$run_id"
  mkdir -p "$destination"

  scp_args
  scp "${SCP_ARGS[@]}" \
    "$BENCH_SSH_USER@$BENCH_SSH_HOST:$archive" \
    "$destination/"

  local_archive="$destination/$(basename "$archive")"
  tar -tzf "$local_archive" >/dev/null
  actual_sha="$(local_sha256 "$local_archive")"
  [[ "$actual_sha" == "$expected_sha" ]] ||
    die "SHA-256 pobranego archiwum jest nieprawidłowe."

  # shellcheck disable=SC2016
  state_update \
    '.job.collected_at = $now
     | .job.local_archive = $archive
     | .job.sha256 = $sha256' \
    --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg archive "$local_archive" \
    --arg sha256 "$actual_sha"

  echo "Wyniki pobrane i zweryfikowane:"
  echo "$local_archive"
}

cmd_finish() {
  require_state
  local archive expected_sha actual_sha
  archive="$(state_get '.job.local_archive' || true)"
  [[ -n "$archive" && -f "$archive" ]] ||
    die "Brak lokalnego archiwum. Najpierw użyj task cloud:collect."
  expected_sha="$(state_get '.job.sha256')"
  actual_sha="$(local_sha256 "$archive")"
  [[ "$actual_sha" == "$expected_sha" ]] ||
    die "Lokalne archiwum nie przechodzi ponownej kontroli SHA-256."

  cat <<EOF

Wyniki są bezpiecznie zapisane:
$archive

Możesz teraz ręcznie usunąć lub zatrzymać maszynę $BENCH_SSH_HOST
w panelu dostawcy. Taskfile celowo nie wykonuje tej operacji.
EOF
}

usage() {
  cat <<'EOF'
Użycie: hostctl.sh plan|doctor|sync|prepare|start|status|logs|wait|collect|finish
Normalnie korzystaj z poleceń `task cloud:*` z katalogu projektu.
EOF
}

main() {
  local command="${1:-}"
  shift || true
  case "$command" in
    plan) cmd_plan "$@" ;;
    doctor) cmd_doctor "$@" ;;
    sync) cmd_sync "$@" ;;
    prepare) cmd_prepare "$@" ;;
    start) cmd_start "$@" ;;
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    wait) cmd_wait "$@" ;;
    collect) cmd_collect "$@" ;;
    finish) cmd_finish "$@" ;;
    help|-h|--help|"") usage ;;
    *) usage >&2; die "Nieznane polecenie: $command" ;;
  esac
}

main "$@"
