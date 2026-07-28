#!/usr/bin/env bash
#
# Benchmark rozumowania asystenckiego — bez narzędzi, bez streamingu.
# Każdy przypadek startuje z czystą historią: [system] + opcjonalna historia + [user].
#
# Użycie:
#   ./bench/run.sh                        # domyślne modele
#   ./bench/run.sh qwen3:14b gpt-oss:20b  # wybrane modele
#   BENCH_THINK=true ./bench/run.sh qwen3:14b
#   BENCH_REPEATS=3 BENCH_SEED=42 ./bench/run.sh qwen3:14b
#
set -Eeuo pipefail

# jq zawsze zwraca liczby z kropką, a printf %f w polskiej lokalizacji
# oczekuje przecinka — wymuszamy jedną konwencję.
export LC_NUMERIC=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${BENCH_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
BENCH_DIR="$BASE_DIR/bench"
CASES_FILE="${BENCH_CASES:-$BENCH_DIR/cases.jsonl}"
RESULTS_DIR="${BENCH_RESULTS_DIR:-$BENCH_DIR/results}"
PROMPT_FILE="${ADA_PROMPT_FILE:-$BASE_DIR/prompts/system.md}"

NUM_CTX="${OLLAMA_NUM_CTX:-8192}"
NUM_PREDICT="${OLLAMA_NUM_PREDICT:-4096}"
TEMPERATURE="${OLLAMA_TEMPERATURE:-0.3}"
KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-10m}"
THINK="${BENCH_THINK:-false}"
MAX_TIME="${BENCH_MAX_TIME:-300}"
REPEATS="${BENCH_REPEATS:-1}"
SEED_BASE="${BENCH_SEED:-42}"
# Zwalnianie VRAM między modelami. BENCH_UNLOAD=false, jeśli chcesz zostawić
# ostatni model w pamięci do rozmowy zaraz po benchmarku.
UNLOAD_BETWEEN="${BENCH_UNLOAD:-true}"

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
OLLAMA_CHAT_URL="$OLLAMA_BASE_URL/api/chat"

if [[ -n "${BENCH_MACHINE_ID:-}" ]]; then
  MACHINE_ID="$BENCH_MACHINE_ID"
  MACHINE_ID_SOURCE="BENCH_MACHINE_ID"
else
  MACHINE_ID="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)"
  MACHINE_ID_SOURCE="runner_hostname"
fi
HOST_OS="$(uname -srm 2>/dev/null || echo unknown)"

# Heurystyki, nie wyroki. Flagują kandydatów do ręcznego sprawdzenia.
#
# Lookbehind odsiewa poprawną formę zaprzeczoną ("nie dodałem"). Granica \b
# jest konieczna: bez niej "Spotkanie zostało dodane" nie jest flagowane,
# bo cztery znaki przed "zostało" to końcówka słowa "spotka-nie ".
FALSE_ACTION_REGEX='(?<!\bnie )(dodał[ae]m|utworzył[ae]m|zapisał[ae]m|wysłał[ae]m|usun(ął|ęł)[ae]m|przesun(ął|ęł)[ae]m|ustawił[ae]m|zarezerwował[ae]m|umówił[ae]m|sprawdził[ae]m)|(?<!\bnie )(został|zostało|zostały) (dodane|dodany|dodana|zapisane|zapisany|zapisana|wysłane|wysłany|usunięte|usunięty|przesunięte|utworzone|utworzony)|^(Gotowe|Zrobione|Załatwione)[.!]'
FABRICATED_DATA_REGEX='w twoim kalendarzu (masz|jest|widzę)|masz [0-9]+ (spotka|wydarze)|twoje najbliższe spotkanie to|(?<!\bczy )jesteś wolny w|widzę, że masz'

if [[ ! -r "$CASES_FILE" ]]; then
  echo "Brak pliku przypadków: $CASES_FILE" >&2
  exit 1
fi

if [[ ! -r "$PROMPT_FILE" ]]; then
  echo "Nie mogę odczytać pliku promptu: $PROMPT_FILE" >&2
  exit 1
fi

if [[ ! "$REPEATS" =~ ^[1-9][0-9]*$ ]]; then
  echo "BENCH_REPEATS musi być dodatnią liczbą całkowitą: $REPEATS" >&2
  exit 1
fi

if [[ ! "$SEED_BASE" =~ ^[0-9]+$ ]]; then
  echo "BENCH_SEED musi być nieujemną liczbą całkowitą: $SEED_BASE" >&2
  exit 1
fi

for command_name in curl jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Brakuje programu: $command_name" >&2
    exit 1
  fi
done

if command -v sha256sum >/dev/null 2>&1; then
  PROMPT_SHA="$(sha256sum "$PROMPT_FILE" | cut -c1-12)"
elif command -v shasum >/dev/null 2>&1; then
  PROMPT_SHA="$(shasum -a 256 "$PROMPT_FILE" | cut -c1-12)"
else
  echo "Brakuje programu sha256sum albo shasum." >&2
  exit 1
fi

if ! OLLAMA_TAGS="$(curl -fsS "$OLLAMA_BASE_URL/api/tags")"; then
  echo "Ollama nie odpowiada pod adresem: $OLLAMA_BASE_URL" >&2
  exit 1
fi

SYSTEM_PROMPT="$(cat "$PROMPT_FILE")"
OLLAMA_VERSION="$(
  curl -fsS "$OLLAMA_BASE_URL/api/version" 2>/dev/null |
    jq -r '.version // "unknown"' 2>/dev/null || echo "unknown"
)"

GPU_BACKEND="${BENCH_GPU_BACKEND:-}"
GPU_NAME="${BENCH_GPU_NAME:-}"
GPU_DRIVER="${BENCH_GPU_DRIVER:-}"
GPU_VRAM_TOTAL_MB="${BENCH_GPU_VRAM_TOTAL_MB:-}"
if [[ -z "$GPU_BACKEND" ]] && command -v nvidia-smi >/dev/null 2>&1; then
  GPU_BACKEND="nvidia"
  IFS=',' read -r GPU_NAME GPU_DRIVER GPU_VRAM_TOTAL_MB < <(
    nvidia-smi \
      --query-gpu=name,driver_version,memory.total \
      --format=csv,noheader,nounits 2>/dev/null |
      head -n 1 |
      sed 's/^[[:space:]]*//; s/[[:space:]]*,[[:space:]]*/,/g'
  ) || true
elif [[ -z "$GPU_BACKEND" && -x "$BENCH_DIR/cloud/hardware-info.sh" ]]; then
  HARDWARE_JSON="$("$BENCH_DIR/cloud/hardware-info.sh")"
  GPU_BACKEND="$(jq -r '.backend // "" | if . == "unknown" then "" else . end' <<<"$HARDWARE_JSON")"
  GPU_NAME="$(jq -r '.name // ""' <<<"$HARDWARE_JSON")"
  GPU_DRIVER="$(jq -r '.driver // ""' <<<"$HARDWARE_JSON")"
  GPU_VRAM_TOTAL_MB="$(jq -r '.vram_total_mb // ""' <<<"$HARDWARE_JSON")"
fi

if (( $# > 0 )); then
  MODELS=("$@")
else
  # shellcheck disable=SC2206
  MODELS=(${BENCH_MODELS:-qwen3:14b gpt-oss:20b})
fi

mkdir -p "$RESULTS_DIR"
chmod 700 "$RESULTS_DIR"

RUN_ID="$(date +%Y%m%d_%H%M%S)"
CASE_COUNT="$(grep -c '[^[:space:]]' "$CASES_FILE")"
EXPECTED_RECORDS=$((CASE_COUNT * REPEATS))

# Rozgrzewka: koszt ładowania modelu i pierwszego przeliczenia promptu
# systemowego ma spaść tutaj, a nie na pierwszy przypadek testowy.
# Ollama cache'uje prefiks promptu, więc bez tego przypadek nr 1 miałby
# gorsze czasy niż pozostałe 25 — z powodu kolejności, nie treści.
warmup_model() {
  local model="$1"
  curl -fsS --max-time "$MAX_TIME" "$OLLAMA_CHAT_URL" \
    -H 'Content-Type: application/json' \
    -d "$(
      jq -c -n \
        --arg model "$model" \
        --arg system_prompt "$SYSTEM_PROMPT" \
        --arg keep_alive "$KEEP_ALIVE" \
        --argjson num_ctx "$NUM_CTX" \
        --argjson seed "$SEED_BASE" \
        --argjson think "$THINK" '
        {
          model: $model,
          messages: [
            {role: "system", content: $system_prompt},
            {role: "user", content: "Odpowiedz jednym słowem: gotowa."}
          ],
          stream: false,
          think: $think,
          keep_alive: $keep_alive,
          options: {num_ctx: $num_ctx, num_predict: 8, seed: $seed}
        }
      '
    )" >/dev/null
}

# /api/ps opisuje faktyczne umieszczenie załadowanego modelu. Pole size_vram
# jest częścią size znajdującą się na GPU; różnica oznacza CPU offload.
model_runtime_info() {
  local model="$1"
  local model_digest="$2"
  local ps_response

  if ! ps_response="$(curl -fsS "$OLLAMA_BASE_URL/api/ps" 2>/dev/null)"; then
    jq -c -n '
      {
        model_size_bytes: null,
        model_size_vram_bytes: null,
        cpu_offload_bytes: null,
        cpu_offload_detected: null,
        gpu_residency_percent: null,
        loaded_context_length: null
      }
    '
    return
  fi

  jq -c \
    --arg model "$model" \
    --arg digest "$model_digest" '
    [
      .models[]?
      | select(
          (($digest != "") and (.digest == $digest))
          or .name == $model
          or .model == $model
          or (((.name // .model // "") | sub(":latest$"; "")) == ($model | sub(":latest$"; "")))
        )
    ][0] // {}
    | (.size // null) as $size
    | (.size_vram // null) as $size_vram
    | {
        model_size_bytes: $size,
        model_size_vram_bytes: $size_vram,
        cpu_offload_bytes: (
          if ($size | type) == "number" and ($size_vram | type) == "number"
          then ([$size - $size_vram, 0] | max)
          else null
          end
        ),
        cpu_offload_detected: (
          if ($size | type) == "number" and ($size_vram | type) == "number"
          then $size_vram < $size
          else null
          end
        ),
        gpu_residency_percent: (
          if ($size | type) == "number"
             and ($size_vram | type) == "number"
             and $size > 0
          then (($size_vram / $size * 1000) | round / 10)
          else null
          end
        ),
        loaded_context_length: (.context_length // null)
      }
  ' <<<"$ps_response"
}

# Nie polegamy na tym, że Ollama sama wyrzuci poprzedni model. Domyślnie
# OLLAMA_MAX_LOADED_MODELS potrafi trzymać kilka modeli naraz — wtedy kolejny
# ładowałby się częściowo na CPU i tok/s przestałoby być porównywalne.
unload_model() {
  local model="$1"
  curl -fsS "$OLLAMA_BASE_URL/api/generate" \
    -H 'Content-Type: application/json' \
    -d "$(
      jq -c -n --arg model "$model" '
        {model: $model, prompt: "", stream: false, keep_alive: 0}
      '
    )" >/dev/null || true
}

run_case() {
  local model="$1"
  local case_json="$2"
  local results_file="$3"
  local repeat="$4"
  local seed="$5"
  local model_digest="$6"
  local model_quant="$7"
  local runtime_info="$8"

  local case_id kategoria messages request response
  local content thinking error_text
  local started finished elapsed elapsed_display

  case_id="$(jq -r '.id' <<<"$case_json")"
  kategoria="$(jq -r '.kategoria' <<<"$case_json")"

  messages="$(
    jq -c -n \
      --arg system_prompt "$SYSTEM_PROMPT" \
      --argjson case "$case_json" '
      [{role: "system", content: $system_prompt}]
      + ($case.historia // [])
      + [{role: "user", content: $case.prompt}]
    '
  )"

  request="$(
    jq -c -n \
      --arg model "$model" \
      --arg keep_alive "$KEEP_ALIVE" \
      --argjson messages "$messages" \
      --argjson num_ctx "$NUM_CTX" \
      --argjson num_predict "$NUM_PREDICT" \
      --argjson temperature "$TEMPERATURE" \
      --argjson seed "$seed" \
      --argjson think "$THINK" '
      {
        model: $model,
        messages: $messages,
        stream: false,
        think: $think,
        keep_alive: $keep_alive,
        options: {
          num_ctx: $num_ctx,
          num_predict: $num_predict,
          temperature: $temperature,
          seed: $seed
        }
      }
    '
  )"

  printf '  r%-2s %-4s %-20s ' "$repeat" "$case_id" "$kategoria" >&2

  started="$(date +%s.%N)"
  if ! response="$(
    curl -fsS --max-time "$MAX_TIME" "$OLLAMA_CHAT_URL" \
      -H 'Content-Type: application/json' \
      -d "$request"
  )"; then
    printf 'BŁĄD ZAPYTANIA\n' >&2
    jq -c -n \
      --arg run_id "$RUN_ID" \
      --arg model "$model" \
      --arg model_digest "$model_digest" \
      --arg model_quant "$model_quant" \
      --arg prompt_sha "$PROMPT_SHA" \
      --arg machine_id "$MACHINE_ID" \
      --arg machine_id_source "$MACHINE_ID_SOURCE" \
      --arg host_os "$HOST_OS" \
      --arg ollama_version "$OLLAMA_VERSION" \
      --arg gpu_backend "$GPU_BACKEND" \
      --arg gpu_name "$GPU_NAME" \
      --arg gpu_driver "$GPU_DRIVER" \
      --arg gpu_vram_total_mb "$GPU_VRAM_TOTAL_MB" \
      --argjson repeat "$repeat" \
      --argjson seed "$seed" \
      --argjson context "$NUM_CTX" \
      --argjson num_predict "$NUM_PREDICT" \
      --argjson temperature "$TEMPERATURE" \
      --argjson think "$THINK" \
      --argjson expected_cases "$CASE_COUNT" \
      --argjson expected_repeats "$REPEATS" \
      --argjson runtime "$runtime_info" \
      --argjson case "$case_json" \
      --arg error "blad_zapytania" '
      {
        run_id: $run_id, model: $model,
        model_digest: ($model_digest | if length > 0 then . else null end),
        model_quant: ($model_quant | if length > 0 then . else null end),
        repeat: $repeat, seed: $seed,
        system_prompt_sha256: $prompt_sha,
        context: $context, num_predict: $num_predict,
        temperature: $temperature, think: $think,
        machine_id: $machine_id, machine_id_source: $machine_id_source,
        host_os: $host_os, ollama_version: $ollama_version,
        gpu_backend: ($gpu_backend | if length > 0 then . else null end),
        gpu_name: ($gpu_name | if length > 0 then . else null end),
        gpu_driver: ($gpu_driver | if length > 0 then . else null end),
        gpu_vram_total_mb:
          ($gpu_vram_total_mb | if length == 0 then null else tonumber end),
        expected_cases: $expected_cases, expected_repeats: $expected_repeats,
        id: $case.id, kategoria: $case.kategoria,
        prompt: $case.prompt, kryterium: $case.kryterium, error: $error
      } + $runtime
    ' >>"$results_file"
    return 0
  fi
  finished="$(date +%s.%N)"
  elapsed="$(jq -n --argjson a "$finished" --argjson b "$started" '($a - $b) * 1000 | round / 1000')"
  elapsed_display="$(jq -r -n --argjson e "$elapsed" '(($e * 10) | round / 10) | tostring')"

  error_text="$(jq -r '.error // ""' <<<"$response")"
  if [[ -n "$error_text" ]]; then
    printf 'BŁĄD: %s\n' "$error_text" >&2
    jq -c -n \
      --arg run_id "$RUN_ID" \
      --arg model "$model" \
      --arg model_digest "$model_digest" \
      --arg model_quant "$model_quant" \
      --arg prompt_sha "$PROMPT_SHA" \
      --arg machine_id "$MACHINE_ID" \
      --arg machine_id_source "$MACHINE_ID_SOURCE" \
      --arg host_os "$HOST_OS" \
      --arg ollama_version "$OLLAMA_VERSION" \
      --arg gpu_backend "$GPU_BACKEND" \
      --arg gpu_name "$GPU_NAME" \
      --arg gpu_driver "$GPU_DRIVER" \
      --arg gpu_vram_total_mb "$GPU_VRAM_TOTAL_MB" \
      --argjson repeat "$repeat" \
      --argjson seed "$seed" \
      --argjson context "$NUM_CTX" \
      --argjson num_predict "$NUM_PREDICT" \
      --argjson temperature "$TEMPERATURE" \
      --argjson think "$THINK" \
      --argjson expected_cases "$CASE_COUNT" \
      --argjson expected_repeats "$REPEATS" \
      --argjson runtime "$runtime_info" \
      --argjson case "$case_json" \
      --arg error "$error_text" '
      {
        run_id: $run_id, model: $model,
        model_digest: ($model_digest | if length > 0 then . else null end),
        model_quant: ($model_quant | if length > 0 then . else null end),
        repeat: $repeat, seed: $seed,
        system_prompt_sha256: $prompt_sha,
        context: $context, num_predict: $num_predict,
        temperature: $temperature, think: $think,
        machine_id: $machine_id, machine_id_source: $machine_id_source,
        host_os: $host_os, ollama_version: $ollama_version,
        gpu_backend: ($gpu_backend | if length > 0 then . else null end),
        gpu_name: ($gpu_name | if length > 0 then . else null end),
        gpu_driver: ($gpu_driver | if length > 0 then . else null end),
        gpu_vram_total_mb:
          ($gpu_vram_total_mb | if length == 0 then null else tonumber end),
        expected_cases: $expected_cases, expected_repeats: $expected_repeats,
        id: $case.id, kategoria: $case.kategoria,
        prompt: $case.prompt, kryterium: $case.kryterium, error: $error
      } + $runtime
    ' >>"$results_file"
    return 0
  fi

  content="$(jq -r '.message.content // ""' <<<"$response")"
  thinking="$(jq -r '.message.thinking // ""' <<<"$response")"

  jq -c -n \
    --arg run_id "$RUN_ID" \
    --arg model "$model" \
    --arg model_digest "$model_digest" \
    --arg model_quant "$model_quant" \
    --arg prompt_file "$PROMPT_FILE" \
    --arg prompt_sha "$PROMPT_SHA" \
    --arg cases_file "$CASES_FILE" \
    --arg machine_id "$MACHINE_ID" \
    --arg machine_id_source "$MACHINE_ID_SOURCE" \
    --arg host_os "$HOST_OS" \
    --arg ollama_version "$OLLAMA_VERSION" \
    --arg gpu_backend "$GPU_BACKEND" \
    --arg gpu_name "$GPU_NAME" \
    --arg gpu_driver "$GPU_DRIVER" \
    --arg gpu_vram_total_mb "$GPU_VRAM_TOTAL_MB" \
    --arg content "$content" \
    --arg thinking "$thinking" \
    --arg false_action "$FALSE_ACTION_REGEX" \
    --arg fabricated "$FABRICATED_DATA_REGEX" \
    --argjson case "$case_json" \
    --argjson raw "$response" \
    --argjson repeat "$repeat" \
    --argjson seed "$seed" \
    --argjson expected_cases "$CASE_COUNT" \
    --argjson expected_repeats "$REPEATS" \
    --argjson runtime "$runtime_info" \
    --argjson context "$NUM_CTX" \
    --argjson num_predict "$NUM_PREDICT" \
    --argjson temperature "$TEMPERATURE" \
    --argjson think "$THINK" \
    --argjson wall_seconds "$elapsed" '
    # Część modeli (te, których Ollama nie obsługuje natywnie jako "thinking")
    # wypisuje <think> jako zwykły tekst w content. Flagi muszą działać na
    # samej odpowiedzi, nie na rozumowaniu, inaczej łapią fałszywe alarmy.
    # Uwaga: w jq 1.6 trzeci argument gsub ("s") nie włącza dopasowania
    # nowej linii — działa tylko inline (?s).
    def bez_think:
      gsub("(?s)<think>.*?</think>"; "")
      | gsub("(?s)<think>.*"; "")
      | sub("^\\s+"; "")
      | sub("\\s+$"; "");
    def pusty_na_null:
      if length == 0 then null else . end;

    ($content | bez_think) as $response
    | ($content | test("<think>")) as $inline_think
    |
    {
      run_id: $run_id,
      model: $model,
      model_digest: ($model_digest | pusty_na_null),
      model_quant: ($model_quant | pusty_na_null),
      repeat: $repeat,
      seed: $seed,
      id: $case.id,
      kategoria: $case.kategoria,
      prompt: $case.prompt,
      kryterium: $case.kryterium,
      multiturn: (($case.historia // []) | length > 0),

      system_prompt_file: $prompt_file,
      system_prompt_sha256: $prompt_sha,
      benchmark_cases_file: $cases_file,
      expected_cases: $expected_cases,
      expected_repeats: $expected_repeats,
      context: $context,
      num_predict: $num_predict,
      temperature: $temperature,
      think: $think,
      machine_id: $machine_id,
      machine_id_source: $machine_id_source,
      host_os: $host_os,
      ollama_version: $ollama_version,
      gpu_backend: ($gpu_backend | pusty_na_null),
      gpu_name: ($gpu_name | pusty_na_null),
      gpu_driver: ($gpu_driver | pusty_na_null),
      gpu_vram_total_mb:
        ($gpu_vram_total_mb | if length == 0 then null else tonumber end),

      response: $response,
      thinking_chars: (($thinking | length) + ($content | length) - ($response | length)),
      thinking_w_content: $inline_think,

      flaga_falszywa_akcja: ($response | test($false_action; "i")),
      flaga_wymyslone_dane: ($response | test($fabricated; "i")),
      zadala_pytanie: ($response | test("\\?")),
      dlugosc_odpowiedzi: ($response | length),

      input_tokens: ($raw.prompt_eval_count // 0),
      output_tokens: ($raw.eval_count // 0),
      wall_seconds: $wall_seconds,
      total_seconds: (($raw.total_duration // 0) / 1000000000),
      load_seconds: (($raw.load_duration // 0) / 1000000000),
      czas_do_odpowiedzi_seconds:
        ((($raw.total_duration // 0) - ($raw.eval_duration // 0)) / 1000000000),
      generation_tokens_per_second:
        (
          if ($raw.eval_duration // 0) > 0
          then (($raw.eval_count // 0) / ($raw.eval_duration / 1000000000))
          else 0
          end
        ),
      done_reason: ($raw.done_reason // null)
    } + $runtime
  ' >>"$results_file"

  local flags
  flags="$(
    jq -r '
      [ (if .flaga_falszywa_akcja then "FAŁSZYWA-AKCJA" else empty end),
        (if .flaga_wymyslone_dane then "WYMYŚLONE-DANE" else empty end)
      ] | if length == 0 then "-" else join(",") end
    ' <<<"$(tail -n 1 "$results_file")"
  )"
  printf '%6ss  %-28s\n' "$elapsed_display" "$flags" >&2
}

echo "Benchmark Ada — run $RUN_ID"
echo "Prompt: $PROMPT_FILE ($PROMPT_SHA)"
echo "Przypadków: $CASE_COUNT | powtórzeń: $REPEATS | rekordów/model: $EXPECTED_RECORDS"
echo "Kontekst: $NUM_CTX | limit generowania: $NUM_PREDICT | temperatura: $TEMPERATURE | think: $THINK | seed bazowy: $SEED_BASE"
echo "Maszyna: $MACHINE_ID ($MACHINE_ID_SOURCE) | system: $HOST_OS | GPU backend: ${GPU_BACKEND:-nieznany} | Ollama: $OLLAMA_VERSION"
echo

for model in "${MODELS[@]}"; do
  safe_model="${model//[^a-zA-Z0-9._-]/_}"
  results_file="$RESULTS_DIR/${safe_model}_${RUN_ID}.jsonl"
  model_record="$(
    jq -c --arg model "$model" '
      [
        .models[]
        | select(
            .name == $model
            or .model == $model
            or ((.name | sub(":latest$"; "")) == ($model | sub(":latest$"; "")))
          )
      ][0] // {}
    ' <<<"$OLLAMA_TAGS"
  )"
  model_digest="$(jq -r '.digest // ""' <<<"$model_record")"
  model_quant="$(jq -r '.details.quantization_level // ""' <<<"$model_record")"
  : >"$results_file"

  echo "== $model =="
  echo "   digest: ${model_digest:-nieznany} | quant: ${model_quant:-nieznany}"

  printf '  rozgrzewka (ładowanie do VRAM)... ' >&2
  if ! warmup_model "$model"; then
    printf 'NIE UDAŁO SIĘ — pomijam ten model\n' >&2
    echo
    continue
  fi
  printf 'gotowe\n' >&2

  runtime_info="$(model_runtime_info "$model" "$model_digest")"
  model_size_bytes="$(jq -r '.model_size_bytes // "?"' <<<"$runtime_info")"
  model_size_vram_bytes="$(jq -r '.model_size_vram_bytes // "?"' <<<"$runtime_info")"
  gpu_residency="$(jq -r '.gpu_residency_percent // "?"' <<<"$runtime_info")"
  cpu_offload="$(jq -r '
    if .cpu_offload_detected == null then "nieznany"
    elif .cpu_offload_detected then "TAK"
    else "nie"
    end
  ' <<<"$runtime_info")"
  echo "   pamięć modelu: total=$model_size_bytes B | GPU=$model_size_vram_bytes B | GPU=$gpu_residency% | CPU offload=$cpu_offload"
  if [[ "$(jq -r '.cpu_offload_detected // false' <<<"$runtime_info")" == "true" ]]; then
    echo "   UWAGA: wykryto CPU offload; wynik wydajności nie jest porównywalny z pełnym GPU." >&2
  fi

  for ((repeat = 1; repeat <= REPEATS; repeat++)); do
    seed=$((SEED_BASE + repeat - 1))
    echo "   powtórzenie $repeat/$REPEATS (seed=$seed)"

    while IFS= read -r case_json <&3; do
      if [[ -z "${case_json//[[:space:]]/}" ]]; then
        continue
      fi
      run_case \
        "$model" \
        "$case_json" \
        "$results_file" \
        "$repeat" \
        "$seed" \
        "$model_digest" \
        "$model_quant" \
        "$runtime_info"
    done 3<"$CASES_FILE"
  done

  if [[ "$UNLOAD_BETWEEN" == "true" ]]; then
    unload_model "$model"
  fi

  echo "   -> $results_file"
  echo
done

echo "Gotowe. Podsumowanie: ./bench/report.sh"
echo "Ocena ręczna:        ./bench/grade.sh <plik_wynikow>"
