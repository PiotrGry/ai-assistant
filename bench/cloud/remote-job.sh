#!/usr/bin/env bash
#
# Odłączony job benchmarku uruchamiany na Podzie w tmux.
#
set -Eeuo pipefail

if (( $# < 5 )); then
  echo "Użycie: remote-job.sh RUN_ID MACHINE_ID REMOTE_ROOT MODELS_DIR MODEL..." >&2
  exit 2
fi

CLOUD_RUN_ID="$1"
MACHINE_ID="$2"
REMOTE_ROOT="$3"
MODELS_DIR="$4"
shift 4
MODELS=("$@")

JOB_DIR="$REMOTE_ROOT/bench/cloud-runs/$CLOUD_RUN_ID"
RESULTS_DIR="$JOB_DIR/results"
STATUS_FILE="$JOB_DIR/status.json"
LOG_FILE="$JOB_DIR/pipeline.log"

mkdir -p "$RESULTS_DIR"
chmod 700 "$JOB_DIR" "$RESULTS_DIR"

status_write() {
  local stage="$1"
  local message="$2"
  local exit_code="${3:-null}"
  local archive="${4:-}"
  local sha256="${5:-}"
  local tmp

  tmp="$(mktemp "$JOB_DIR/.status.XXXXXX")"
  jq -n \
    --arg run_id "$CLOUD_RUN_ID" \
    --arg stage "$stage" \
    --arg message "$message" \
    --arg updated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg archive "$archive" \
    --arg sha256 "$sha256" \
    --argjson exit_code "$exit_code" '
      {
        run_id: $run_id,
        stage: $stage,
        message: $message,
        updated_at: $updated_at,
        exit_code: $exit_code,
        archive: (if $archive == "" then null else $archive end),
        sha256: (if $sha256 == "" then null else $sha256 end)
      }
    ' >"$tmp"
  mv "$tmp" "$STATUS_FILE"
}

job_finished=false
on_exit() {
  local code=$?
  if [[ "$job_finished" != "true" ]]; then
    status_write "failed" "Pipeline zakończył się błędem." "$code"
  fi
}
trap on_exit EXIT

exec > >(tee -a "$LOG_FILE") 2>&1

export OLLAMA_MODELS="$MODELS_DIR"
export OLLAMA_HOST="127.0.0.1:11434"

status_write "running" "Benchmark jest uruchomiony."
echo "Run: $CLOUD_RUN_ID"
echo "Maszyna: $MACHINE_ID"
printf 'Modele: %s\n' "${MODELS[*]}"
echo

models_json="$(
  printf '%s\n' "${MODELS[@]}" |
    jq -R . |
    jq -s .
)"

nvidia_smi="$(
  nvidia-smi \
    --query-gpu=name,driver_version,memory.total \
    --format=csv,noheader,nounits 2>/dev/null || true
)"
ollama_version="$(
  curl -fsS "$OLLAMA_HOST/api/version" |
    jq -r '.version // "unknown"'
)"

jq -n \
  --arg run_id "$CLOUD_RUN_ID" \
  --arg machine_id "$MACHINE_ID" \
  --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg nvidia_smi "$nvidia_smi" \
  --arg ollama_version "$ollama_version" \
  --argjson models "$models_json" \
  --argjson think "${BENCH_THINK:-true}" \
  --argjson repeats "${BENCH_REPEATS:-1}" \
  --argjson seed "${BENCH_SEED:-42}" \
  --argjson temperature "${OLLAMA_TEMPERATURE:-0}" \
  --argjson num_ctx "${OLLAMA_NUM_CTX:-8192}" \
  --argjson num_predict "${OLLAMA_NUM_PREDICT:-4096}" '
    {
      cloud_run_id: $run_id,
      machine_id: $machine_id,
      started_at: $started_at,
      nvidia_smi: $nvidia_smi,
      ollama_version: $ollama_version,
      models: $models,
      config: {
        think: $think,
        repeats: $repeats,
        seed: $seed,
        temperature: $temperature,
        num_ctx: $num_ctx,
        num_predict: $num_predict
      }
    }
  ' >"$JOB_DIR/environment.json"

ollama list >"$JOB_DIR/ollama-list.txt"

BENCH_MACHINE_ID="$MACHINE_ID" \
BENCH_CASES="$REMOTE_ROOT/bench/cases.jsonl" \
BENCH_RESULTS_DIR="$RESULTS_DIR" \
BENCH_THINK="${BENCH_THINK:-true}" \
BENCH_REPEATS="${BENCH_REPEATS:-1}" \
BENCH_SEED="${BENCH_SEED:-42}" \
BENCH_MAX_TIME="${BENCH_MAX_TIME:-600}" \
OLLAMA_TEMPERATURE="${OLLAMA_TEMPERATURE:-0}" \
OLLAMA_NUM_CTX="${OLLAMA_NUM_CTX:-8192}" \
OLLAMA_NUM_PREDICT="${OLLAMA_NUM_PREDICT:-4096}" \
"$REMOTE_ROOT/bench/run.sh" "${MODELS[@]}"

mapfile -t result_files < <(
  find "$RESULTS_DIR" -maxdepth 1 -type f -name '*.jsonl' -print | sort
)
if (( ${#result_files[@]} != ${#MODELS[@]} )); then
  echo "Oczekiwano ${#MODELS[@]} plików wynikowych, znaleziono ${#result_files[@]}." >&2
  exit 1
fi

for result_file in "${result_files[@]}"; do
  expected_records="$(
    jq -s '.[0].expected_cases * .[0].expected_repeats' "$result_file"
  )"
  actual_records="$(jq -s 'length' "$result_file")"
  errors="$(jq -s 'map(select(.error != null)) | length' "$result_file")"
  incomplete="$(jq -s 'map(select(.done_reason != "stop")) | length' "$result_file")"

  if [[ "$actual_records" != "$expected_records" || "$errors" != "0" || "$incomplete" != "0" ]]; then
    echo "Niekompletny wynik: $result_file" >&2
    echo "rekordy=$actual_records/$expected_records błędy=$errors done_reason!=stop=$incomplete" >&2
    exit 1
  fi
done

BENCH_ROOT="$REMOTE_ROOT" \
  "$REMOTE_ROOT/bench/report.sh" "${result_files[@]}" \
  >"$JOB_DIR/final-cloud-report.txt"

cp "$LOG_FILE" "$JOB_DIR/pipeline.snapshot.log"

archive="$JOB_DIR/pirx-final-64-results-$CLOUD_RUN_ID.tar.gz"
archive_tmp="$archive.tmp"
tar -czf "$archive_tmp" \
  -C "$JOB_DIR" \
    results \
    environment.json \
    ollama-list.txt \
    final-cloud-report.txt \
    pipeline.snapshot.log \
  -C "$REMOTE_ROOT" \
    bench/cases.jsonl \
    bench/contested_cases.jsonl \
    bench/grades.jsonl \
    prompts/system.md
mv "$archive_tmp" "$archive"

if command -v sha256sum >/dev/null 2>&1; then
  archive_sha="$(sha256sum "$archive" | awk '{print $1}')"
else
  archive_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
fi

status_write "complete" "Benchmark i archiwum są gotowe." 0 "$archive" "$archive_sha"
job_finished=true

echo
echo "Benchmark zakończony."
echo "Archiwum: $archive"
echo "SHA-256:  $archive_sha"
