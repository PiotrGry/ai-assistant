#!/usr/bin/env bash
#
# End-to-end pipeline benchmarku na RunPod:
# deploy -> SSH -> synchronizacja -> Ollama -> tmux -> walidacja -> pobranie.
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
CONFIG_FILE="${RUNPOD_CONFIG_FILE:-$SCRIPT_DIR/runpod.env}"
STATE_FILE="${RUNPOD_STATE_FILE:-$SCRIPT_DIR/.runpod-state.json}"
KNOWN_HOSTS_FILE="${RUNPOD_KNOWN_HOSTS_FILE:-$SCRIPT_DIR/known_hosts}"
API_BASE_URL="${RUNPOD_API_BASE_URL:-https://rest.runpod.io/v1}"

if [[ -f "$CONFIG_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
fi

: "${RUNPOD_GPU_TYPE_ID:=NVIDIA RTX PRO 6000 Blackwell Server Edition}"
: "${RUNPOD_GPU_COUNT:=1}"
: "${RUNPOD_IMAGE:=runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04}"
: "${RUNPOD_CONTAINER_DISK_GB:=50}"
: "${RUNPOD_POD_NAME:=pirx-final-benchmark}"
: "${RUNPOD_REMOTE_ROOT:=/workspace/ai-assistant}"
: "${RUNPOD_MODELS_DIR:=/workspace/ollama/models}"
: "${RUNPOD_SSH_KEY:=$HOME/.ssh/id_ed25519}"
: "${RUNPOD_SSH_USER:=root}"
: "${RUNPOD_PULL_MISSING_MODELS:=false}"
: "${RUNPOD_READY_TIMEOUT_SECONDS:=1200}"
: "${RUNPOD_JOB_TIMEOUT_SECONDS:=14400}"
: "${RUNPOD_POLL_SECONDS:=20}"

: "${CLOUD_BENCH_MODELS:=gemma4:31b-it-q4_K_M qwen3.6:35b-a3b-q4_K_M qwen3.5:122b-a10b-q4_K_M qwen3:32b-q4_K_M qwen3:14b-q4_K_M}"
: "${CLOUD_BENCH_THINK:=true}"
: "${CLOUD_BENCH_REPEATS:=1}"
: "${CLOUD_BENCH_SEED:=42}"
: "${CLOUD_BENCH_MAX_TIME:=600}"
: "${CLOUD_OLLAMA_TEMPERATURE:=0}"
: "${CLOUD_OLLAMA_NUM_CTX:=8192}"
: "${CLOUD_OLLAMA_NUM_PREDICT:=4096}"

# Model tags nie zawierają spacji; konfiguracyjna lista jest celowo prosta.
# shellcheck disable=SC2206
MODELS=($CLOUD_BENCH_MODELS)

usage() {
  cat <<'EOF'
Użycie:
  ./bench/cloud/runpod-pipeline.sh plan
  ./bench/cloud/runpod-pipeline.sh doctor
  ./bench/cloud/runpod-pipeline.sh volumes
  ./bench/cloud/runpod-pipeline.sh deploy
  ./bench/cloud/runpod-pipeline.sh use-pod POD_ID
  ./bench/cloud/runpod-pipeline.sh prepare
  ./bench/cloud/runpod-pipeline.sh start
  ./bench/cloud/runpod-pipeline.sh status
  ./bench/cloud/runpod-pipeline.sh logs [LICZBA_LINII]
  ./bench/cloud/runpod-pipeline.sh wait
  ./bench/cloud/runpod-pipeline.sh collect
  ./bench/cloud/runpod-pipeline.sh all
  ./bench/cloud/runpod-pipeline.sh terminate [--yes] [--force]

Najprostszy przebieg:
  1. cp bench/cloud/runpod.env.example bench/cloud/runpod.env
  2. uzupełnij RUNPOD_API_KEY, RUNPOD_NETWORK_VOLUME_ID i RUNPOD_SSH_KEY
  3. ./bench/cloud/runpod-pipeline.sh doctor
  4. ./bench/cloud/runpod-pipeline.sh all
  5. ./bench/cloud/runpod-pipeline.sh terminate

Polecenie all zostawia Pod uruchomiony. Terminate jest zawsze osobną,
jawną operacją po zweryfikowanym pobraniu wyników.
EOF
}

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

require_local_tools() {
  local command_name
  for command_name in curl jq ssh scp tar; do
    require_command "$command_name"
  done
}

validate_config() {
  [[ "$RUNPOD_REMOTE_ROOT" == /* ]] ||
    die "RUNPOD_REMOTE_ROOT musi być ścieżką bezwzględną."
  [[ "$RUNPOD_MODELS_DIR" == /* ]] ||
    die "RUNPOD_MODELS_DIR musi być ścieżką bezwzględną."
  [[ "$RUNPOD_GPU_COUNT" =~ ^[1-9][0-9]*$ ]] ||
    die "RUNPOD_GPU_COUNT musi być dodatnią liczbą całkowitą."
  [[ "$RUNPOD_CONTAINER_DISK_GB" =~ ^[1-9][0-9]*$ ]] ||
    die "RUNPOD_CONTAINER_DISK_GB musi być dodatnią liczbą całkowitą."
  [[ "$CLOUD_BENCH_THINK" == "true" || "$CLOUD_BENCH_THINK" == "false" ]] ||
    die "CLOUD_BENCH_THINK musi mieć wartość true albo false."
  [[ "$RUNPOD_PULL_MISSING_MODELS" == "true" || "$RUNPOD_PULL_MISSING_MODELS" == "false" ]] ||
    die "RUNPOD_PULL_MISSING_MODELS musi mieć wartość true albo false."
  (( ${#MODELS[@]} > 0 )) || die "Lista CLOUD_BENCH_MODELS jest pusta."

  local model
  for model in "${MODELS[@]}"; do
    [[ "$model" =~ ^[A-Za-z0-9._:/-]+$ ]] ||
      die "Nieprawidłowy tag modelu: $model"
  done
}

require_api_key() {
  [[ -n "${RUNPOD_API_KEY:-}" ]] ||
    die "Brak RUNPOD_API_KEY. Uzupełnij $CONFIG_FILE."
}

require_volume_id() {
  [[ -n "${RUNPOD_NETWORK_VOLUME_ID:-}" ]] ||
    die "Brak RUNPOD_NETWORK_VOLUME_ID. Użyj polecenia volumes i uzupełnij $CONFIG_FILE."
}

api_request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local args=(
    --fail-with-body
    --silent
    --show-error
    --retry 3
    --connect-timeout 10
    --max-time 60
    --request "$method"
    --url "$API_BASE_URL$path"
    --header "Authorization: Bearer $RUNPOD_API_KEY"
  )

  if [[ -n "$body" ]]; then
    args+=(--header "Content-Type: application/json" --data "$body")
  fi
  curl "${args[@]}"
}

state_get() {
  local query="$1"
  [[ -s "$STATE_FILE" ]] || return 1
  jq -er "$query" "$STATE_FILE"
}

state_replace() {
  local json="$1"
  local tmp
  mkdir -p "$(dirname "$STATE_FILE")"
  tmp="$(mktemp "$STATE_FILE.tmp.XXXXXX")"
  printf '%s\n' "$json" | jq . >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

state_update() {
  local filter="$1"
  shift
  local tmp
  [[ -s "$STATE_FILE" ]] || die "Brak stanu pipeline: $STATE_FILE"
  tmp="$(mktemp "$STATE_FILE.tmp.XXXXXX")"
  jq "$@" "$filter" "$STATE_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

pod_id() {
  local id
  id="$(state_get '.pod_id' || true)"
  [[ -n "$id" ]] ||
    die "Brak aktywnego Poda w stanie pipeline. Użyj deploy albo use-pod."
  printf '%s\n' "$id"
}

get_pod() {
  api_request GET "/pods/$(pod_id)"
}

refresh_connection() {
  local pod_json ip port machine_id desired_status
  pod_json="$(get_pod)"
  ip="$(jq -r '.publicIp // empty' <<<"$pod_json")"
  port="$(jq -r '.portMappings["22"] // empty' <<<"$pod_json")"
  machine_id="$(jq -r '.machine.machineId // .machineId // empty' <<<"$pod_json")"
  desired_status="$(jq -r '.desiredStatus // "unknown"' <<<"$pod_json")"

  # W pojedynczym cudzysłowie są zmienne programu jq, nie zmienne powłoki.
  # shellcheck disable=SC2016
  state_update \
    '.public_ip = $ip
     | .ssh_port = $port
     | .machine_id = $machine_id
     | .pod_status = $status
     | .last_refresh_at = $now' \
    --arg ip "$ip" \
    --arg port "$port" \
    --arg machine_id "$machine_id" \
    --arg status "$desired_status" \
    --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  [[ -n "$ip" && -n "$port" ]]
}

connection_values() {
  POD_IP="$(state_get '.public_ip')"
  SSH_PORT="$(state_get '.ssh_port')"
  [[ -n "$POD_IP" && -n "$SSH_PORT" ]] ||
    die "Pod nie ma jeszcze publicznego IP lub mapowania portu 22."
}

ssh_args() {
  SSH_ARGS=(
    -i "$RUNPOD_SSH_KEY"
    -p "$SSH_PORT"
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
    -i "$RUNPOD_SSH_KEY"
    -P "$SSH_PORT"
    -o BatchMode=yes
    -o ConnectTimeout=10
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=4
    -o StrictHostKeyChecking=accept-new
    -o UserKnownHostsFile="$KNOWN_HOSTS_FILE"
  )
}

remote_exec() {
  connection_values
  ssh_args
  # Argument jest świadomie budowany lokalnie przez shell_quote/printf %q.
  # shellcheck disable=SC2029
  ssh "${SSH_ARGS[@]}" "$RUNPOD_SSH_USER@$POD_IP" "$@"
}

wait_for_ssh() {
  local started now
  started="$(date +%s)"
  mkdir -p "$(dirname "$KNOWN_HOSTS_FILE")"
  touch "$KNOWN_HOSTS_FILE"
  chmod 600 "$KNOWN_HOSTS_FILE"

  info "Czekam na gotowy SSH"
  while true; do
    if refresh_connection; then
      connection_values
      ssh_args
      if ssh "${SSH_ARGS[@]}" "$RUNPOD_SSH_USER@$POD_IP" true >/dev/null 2>&1; then
        echo "SSH gotowe: $POD_IP:$SSH_PORT"
        return 0
      fi
    fi

    now="$(date +%s)"
    if (( now - started >= RUNPOD_READY_TIMEOUT_SECONDS )); then
      die "Pod nie udostępnił SSH w ciągu $RUNPOD_READY_TIMEOUT_SECONDS sekund."
    fi
    printf '.'
    sleep 10
  done
}

shell_quote() {
  printf '%q' "$1"
}

cmd_plan() {
  validate_config
  cat <<EOF
Pipeline:       RunPod REST API + SSH + tmux
GPU:            $RUNPOD_GPU_COUNT × $RUNPOD_GPU_TYPE_ID
Obraz:          $RUNPOD_IMAGE
Network Volume: ${RUNPOD_NETWORK_VOLUME_ID:-NIE USTAWIONO}
Katalog zdalny: $RUNPOD_REMOTE_ROOT
Modele:
$(printf '  - %s\n' "${MODELS[@]}")
Konfiguracja:   think=$CLOUD_BENCH_THINK repeats=$CLOUD_BENCH_REPEATS seed=$CLOUD_BENCH_SEED
                temperature=$CLOUD_OLLAMA_TEMPERATURE ctx=$CLOUD_OLLAMA_NUM_CTX num_predict=$CLOUD_OLLAMA_NUM_PREDICT

Pipeline nie usuwa Poda automatycznie. Do tego służy osobne polecenie terminate.
EOF
}

cmd_volumes() {
  require_local_tools
  require_api_key
  api_request GET /networkvolumes |
    jq -r '
      ["ID", "DATACENTER", "GB", "NAZWA"],
      (.[] | [.id, .dataCenterId, (.size | tostring), .name])
      | @tsv
    '
}

cmd_doctor() {
  require_local_tools
  validate_config
  require_api_key
  require_volume_id

  [[ -r "$RUNPOD_SSH_KEY" ]] ||
    die "Nie mogę odczytać klucza SSH: $RUNPOD_SSH_KEY"

  local volume
  volume="$(
    api_request GET /networkvolumes |
      jq -c --arg id "$RUNPOD_NETWORK_VOLUME_ID" '
        [.[] | select(.id == $id)][0] // empty
      '
  )"
  [[ -n "$volume" ]] ||
    die "Nie znaleziono Network Volume: $RUNPOD_NETWORK_VOLUME_ID"

  cmd_plan
  echo
  echo "Network Volume zweryfikowany:"
  jq '{id, name, size, dataCenterId}' <<<"$volume"
  echo "Preflight zakończony poprawnie."
}

cmd_deploy() {
  require_local_tools
  validate_config
  require_api_key
  require_volume_id

  if [[ -s "$STATE_FILE" ]] && state_get '.pod_id' >/dev/null 2>&1; then
    if [[ "$(state_get '.pod_status // empty' || true)" != "TERMINATED" ]]; then
      die "Plik stanu zawiera już Pod. Użyj status/terminate zamiast tworzyć kolejny."
    fi
    echo "Poprzedni Pod jest oznaczony jako TERMINATED; rozpoczynam nowy przebieg."
  fi

  local body response id
  body="$(
    jq -n \
      --arg name "$RUNPOD_POD_NAME" \
      --arg image "$RUNPOD_IMAGE" \
      --arg gpu "$RUNPOD_GPU_TYPE_ID" \
      --arg volume "$RUNPOD_NETWORK_VOLUME_ID" \
      --arg models_dir "$RUNPOD_MODELS_DIR" \
      --argjson gpu_count "$RUNPOD_GPU_COUNT" \
      --argjson disk "$RUNPOD_CONTAINER_DISK_GB" '
        {
          name: $name,
          imageName: $image,
          cloudType: "SECURE",
          computeType: "GPU",
          gpuCount: $gpu_count,
          gpuTypeIds: [$gpu],
          gpuTypePriority: "custom",
          containerDiskInGb: $disk,
          networkVolumeId: $volume,
          volumeMountPath: "/workspace",
          ports: ["22/tcp"],
          env: {OLLAMA_MODELS: $models_dir},
          interruptible: false
        }
      '
  )"

  info "Tworzę Pod"
  response="$(api_request POST /pods "$body")"
  id="$(jq -r '.id // empty' <<<"$response")"
  [[ -n "$id" ]] || die "RunPod nie zwrócił identyfikatora Poda: $response"

  state_replace "$(
    jq -n \
      --arg pod_id "$id" \
      --arg pod_name "$RUNPOD_POD_NAME" \
      --arg gpu "$RUNPOD_GPU_TYPE_ID" \
      --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson create_response "$response" '
        {
          pod_id: $pod_id,
          pod_name: $pod_name,
          gpu_requested: $gpu,
          created_at: $created_at,
          create_response: $create_response
        }
      '
  )"

  echo "Pod utworzony: $id"
  jq '{id, desiredStatus, costPerHr, adjustedCostPerHr}' <<<"$response"
  wait_for_ssh
}

cmd_use_pod() {
  local id="${1:-}"
  [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || die "Podaj prawidłowy POD_ID."
  require_local_tools
  validate_config
  require_api_key

  local response
  response="$(api_request GET "/pods/$id")"
  [[ "$(jq -r '.id // empty' <<<"$response")" == "$id" ]] ||
    die "Nie znaleziono Poda: $id"

  state_replace "$(
    jq -n \
      --arg pod_id "$id" \
      --arg adopted_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson pod "$response" '
        {
          pod_id: $pod_id,
          pod_name: ($pod.name // null),
          adopted_at: $adopted_at,
          create_response: $pod
        }
      '
  )"
  echo "Pipeline przejął istniejący Pod: $id"
  wait_for_ssh
}

sync_files() {
  local paths=(
    bench/run.sh
    bench/report.sh
    bench/grade.sh
    bench/grades.jsonl
    bench/README.md
    bench/cases.jsonl
    bench/contested_cases.jsonl
    bench/cloud/remote-bootstrap.sh
    bench/cloud/remote-job.sh
    prompts/system.md
  )
  local path
  for path in "${paths[@]}"; do
    [[ -f "$BASE_DIR/$path" ]] || die "Brak pliku do synchronizacji: $path"
  done

  info "Synchronizuję wyłącznie pliki benchmarku"
  tar -C "$BASE_DIR" -czf - "${paths[@]}" |
    remote_exec \
      "mkdir -p $(shell_quote "$RUNPOD_REMOTE_ROOT") && tar -xzf - -C $(shell_quote "$RUNPOD_REMOTE_ROOT")"
}

cmd_prepare() {
  require_local_tools
  validate_config
  require_api_key
  [[ -r "$RUNPOD_SSH_KEY" ]] ||
    die "Nie mogę odczytać klucza SSH: $RUNPOD_SSH_KEY"
  pod_id >/dev/null

  wait_for_ssh
  sync_files

  info "Przygotowuję Ollamę i sprawdzam modele"
  local command
  printf -v command '%q ' \
    bash \
    "$RUNPOD_REMOTE_ROOT/bench/cloud/remote-bootstrap.sh" \
    "$RUNPOD_REMOTE_ROOT" \
    "$RUNPOD_MODELS_DIR" \
    "$RUNPOD_PULL_MISSING_MODELS" \
    "${MODELS[@]}"
  remote_exec "$command"

  # shellcheck disable=SC2016
  state_update \
    '.prepared_at = $now' \
    --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

cmd_start() {
  require_local_tools
  validate_config
  require_api_key
  pod_id >/dev/null
  state_get '.prepared_at' >/dev/null 2>&1 ||
    die "Pod nie jest przygotowany. Najpierw uruchom polecenie prepare."
  refresh_connection || wait_for_ssh

  if state_get '.job.run_id' >/dev/null 2>&1; then
    die "Stan zawiera już job. Użyj status/wait/collect."
  fi

  local run_id session machine_id remote_job_dir inner_command tmux_command
  run_id="$(date -u +%Y%m%dT%H%M%SZ)"
  session="pirx-${run_id}"
  machine_id="$(state_get '.machine_id // empty' || true)"
  [[ -n "$machine_id" ]] || machine_id="runpod-$(pod_id)"
  remote_job_dir="$RUNPOD_REMOTE_ROOT/bench/cloud-runs/$run_id"

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
    "$RUNPOD_REMOTE_ROOT/bench/cloud/remote-job.sh" \
    "$run_id" \
    "$machine_id" \
    "$RUNPOD_REMOTE_ROOT" \
    "$RUNPOD_MODELS_DIR" \
    "${MODELS[@]}"

  printf -v tmux_command 'tmux new-session -d -s %q %q' \
    "$session" \
    "$inner_command"

  info "Uruchamiam odłączony benchmark"
  remote_exec "mkdir -p $(shell_quote "$remote_job_dir") && $tmux_command"

  # shellcheck disable=SC2016
  state_update \
    '.job = {
       run_id: $run_id,
       session: $session,
       remote_dir: $remote_dir,
       started_at: $now
     }' \
    --arg run_id "$run_id" \
    --arg session "$session" \
    --arg remote_dir "$remote_job_dir" \
    --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  echo "Benchmark uruchomiony w tmux: $session"
  echo "Stan: ./bench/cloud/runpod-pipeline.sh status"
  echo "Logi: ./bench/cloud/runpod-pipeline.sh logs"
}

remote_status_json() {
  local remote_dir
  remote_dir="$(state_get '.job.remote_dir')"
  remote_exec \
    "if [[ -s $(shell_quote "$remote_dir/status.json") ]]; then cat $(shell_quote "$remote_dir/status.json"); else jq -n '{stage:\"starting\",message:\"Job jeszcze nie utworzył statusu.\"}'; fi"
}

cmd_status() {
  require_local_tools
  require_api_key
  local pod_json
  pod_json="$(get_pod)"
  echo "Pod:"
  jq '{
    id,
    name,
    desiredStatus,
    costPerHr,
    adjustedCostPerHr,
    publicIp,
    ssh_port: .portMappings["22"],
    gpu: .gpu.displayName
  }' <<<"$pod_json"

  if state_get '.job.run_id' >/dev/null 2>&1; then
    refresh_connection >/dev/null || true
    echo
    echo "Job:"
    remote_status_json | jq .
  else
    echo
    echo "Job nie został jeszcze uruchomiony."
  fi
}

cmd_logs() {
  local lines="${1:-80}"
  [[ "$lines" =~ ^[1-9][0-9]*$ ]] || die "Liczba linii musi być dodatnią liczbą całkowitą."
  require_local_tools
  require_api_key
  refresh_connection || wait_for_ssh
  local remote_dir
  remote_dir="$(state_get '.job.remote_dir')"
  remote_exec "tail -n $lines $(shell_quote "$remote_dir/pipeline.log")"
}

cmd_wait() {
  require_local_tools
  require_api_key
  local started now status stage message
  started="$(date +%s)"

  info "Czekam na zakończenie benchmarku"
  while true; do
    refresh_connection >/dev/null || wait_for_ssh
    status="$(remote_status_json)"
    stage="$(jq -r '.stage' <<<"$status")"
    message="$(jq -r '.message' <<<"$status")"
    printf '%s  %-10s %s\n' "$(date +%H:%M:%S)" "$stage" "$message"

    case "$stage" in
      complete)
        return 0
        ;;
      failed)
        cmd_logs 120 || true
        die "Zdalny benchmark zakończył się błędem."
        ;;
    esac

    now="$(date +%s)"
    if (( now - started >= RUNPOD_JOB_TIMEOUT_SECONDS )); then
      die "Przekroczono limit oczekiwania $RUNPOD_JOB_TIMEOUT_SECONDS sekund. Job nadal działa w tmux."
    fi
    sleep "$RUNPOD_POLL_SECONDS"
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
  require_local_tools
  require_api_key
  refresh_connection || wait_for_ssh

  local status stage archive expected_sha run_id destination actual_sha local_archive
  status="$(remote_status_json)"
  stage="$(jq -r '.stage' <<<"$status")"
  [[ "$stage" == "complete" ]] ||
    die "Archiwum nie jest jeszcze gotowe (stage=$stage). Użyj wait."

  archive="$(jq -r '.archive' <<<"$status")"
  expected_sha="$(jq -r '.sha256' <<<"$status")"
  run_id="$(jq -r '.run_id' <<<"$status")"
  destination="$BASE_DIR/bench/cloud-results/$run_id"
  mkdir -p "$destination"

  connection_values
  scp_args
  info "Pobieram wyniki"
  scp "${SCP_ARGS[@]}" \
    "$RUNPOD_SSH_USER@$POD_IP:$archive" \
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
  echo "SHA-256: $actual_sha"
}

cmd_all() {
  if ! state_get '.pod_id' >/dev/null 2>&1 ||
    [[ "$(state_get '.pod_status // empty' || true)" == "TERMINATED" ]]; then
    cmd_deploy
  else
    echo "Wznawiam istniejący Pod ze stanu: $(pod_id)"
  fi

  if ! state_get '.prepared_at' >/dev/null 2>&1; then
    cmd_prepare
  else
    echo "Etap prepare był już zakończony."
  fi

  if ! state_get '.job.run_id' >/dev/null 2>&1; then
    cmd_start
  else
    echo "Wznawiam job: $(state_get '.job.run_id')"
  fi

  if ! state_get '.job.local_archive' >/dev/null 2>&1; then
    cmd_wait
    cmd_collect
  else
    echo "Wyniki były już pobrane: $(state_get '.job.local_archive')"
  fi

  echo
  echo "Pod nadal działa. Po sprawdzeniu pliku zakończ go poleceniem:"
  echo "  ./bench/cloud/runpod-pipeline.sh terminate"
}

cmd_terminate() {
  require_local_tools
  require_api_key
  local assume_yes=false force=false arg id status
  for arg in "$@"; do
    case "$arg" in
      --yes) assume_yes=true ;;
      --force) force=true ;;
      *) die "Nieznana opcja terminate: $arg" ;;
    esac
  done

  id="$(pod_id)"
  if [[ "$force" != "true" ]]; then
    if state_get '.job.run_id' >/dev/null 2>&1 &&
      ! state_get '.job.local_archive' >/dev/null 2>&1; then
      die "Wyniki nie zostały oznaczone jako pobrane. Użyj collect albo terminate --force."
    fi
  fi

  if [[ "$assume_yes" != "true" ]]; then
    printf 'Usunąć Pod %s? Network Volume pozostanie zachowany. [y/N] ' "$id"
    read -r answer
    [[ "$answer" == "y" || "$answer" == "Y" ]] || {
      echo "Anulowano."
      return 0
    }
  fi

  info "Usuwam Pod"
  api_request DELETE "/pods/$id" >/dev/null
  # shellcheck disable=SC2016
  state_update \
    '.pod_status = "TERMINATED"
     | .terminated_at = $now' \
    --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Pod $id został usunięty. Network Volume nie został usunięty."
}

main() {
  local command="${1:-}"
  shift || true

  case "$command" in
    plan) cmd_plan "$@" ;;
    doctor) cmd_doctor "$@" ;;
    volumes) cmd_volumes "$@" ;;
    deploy) cmd_deploy "$@" ;;
    use-pod) cmd_use_pod "$@" ;;
    prepare) cmd_prepare "$@" ;;
    start) cmd_start "$@" ;;
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    wait) cmd_wait "$@" ;;
    collect) cmd_collect "$@" ;;
    all) cmd_all "$@" ;;
    terminate) cmd_terminate "$@" ;;
    help|-h|--help|"") usage ;;
    *) usage >&2; die "Nieznane polecenie: $command" ;;
  esac
}

main "$@"
