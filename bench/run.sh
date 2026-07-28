#!/usr/bin/env bash
#
# Benchmark rozumowania asystenckiego — bez narzędzi, bez streamingu.
# Każdy przypadek startuje z czystą historią: [system] + opcjonalna historia + [user].
#
# Użycie:
#   ./bench/run.sh                        # domyślne modele
#   ./bench/run.sh qwen3:14b gpt-oss:20b  # wybrane modele
#   BENCH_THINK=true ./bench/run.sh qwen3:14b
#
set -Eeuo pipefail

# jq zawsze zwraca liczby z kropką, a printf %f w polskiej lokalizacji
# oczekuje przecinka — wymuszamy jedną konwencję.
export LC_NUMERIC=C

BASE_DIR="$HOME/ai-assistant"
BENCH_DIR="$BASE_DIR/bench"
CASES_FILE="${BENCH_CASES:-$BENCH_DIR/cases.jsonl}"
RESULTS_DIR="$BENCH_DIR/results"
PROMPT_FILE="${ADA_PROMPT_FILE:-$BASE_DIR/prompts/system.md}"

NUM_CTX="${OLLAMA_NUM_CTX:-8192}"
TEMPERATURE="${OLLAMA_TEMPERATURE:-0.3}"
KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-10m}"
THINK="${BENCH_THINK:-false}"
MAX_TIME="${BENCH_MAX_TIME:-300}"
# Zwalnianie VRAM między modelami. BENCH_UNLOAD=false, jeśli chcesz zostawić
# ostatni model w pamięci do rozmowy zaraz po benchmarku.
UNLOAD_BETWEEN="${BENCH_UNLOAD:-true}"

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
OLLAMA_CHAT_URL="$OLLAMA_BASE_URL/api/chat"

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

for command_name in curl jq sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Brakuje programu: $command_name" >&2
    exit 1
  fi
done

if ! curl -fsS "$OLLAMA_BASE_URL/api/tags" >/dev/null; then
  echo "Ollama nie odpowiada pod adresem: $OLLAMA_BASE_URL" >&2
  exit 1
fi

SYSTEM_PROMPT="$(cat "$PROMPT_FILE")"
PROMPT_SHA="$(sha256sum "$PROMPT_FILE" | cut -c1-12)"

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
          options: {num_ctx: $num_ctx, num_predict: 8}
        }
      '
    )" >/dev/null
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
      --argjson temperature "$TEMPERATURE" \
      --argjson think "$THINK" '
      {
        model: $model,
        messages: $messages,
        stream: false,
        think: $think,
        keep_alive: $keep_alive,
        options: {
          num_ctx: $num_ctx,
          temperature: $temperature
        }
      }
    '
  )"

  printf '  %-4s %-20s ' "$case_id" "$kategoria" >&2

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
      --argjson case "$case_json" \
      --arg error "blad_zapytania" '
      {run_id: $run_id, model: $model, id: $case.id, kategoria: $case.kategoria,
       prompt: $case.prompt, kryterium: $case.kryterium, error: $error}
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
      --argjson case "$case_json" \
      --arg error "$error_text" '
      {run_id: $run_id, model: $model, id: $case.id, kategoria: $case.kategoria,
       prompt: $case.prompt, kryterium: $case.kryterium, error: $error}
    ' >>"$results_file"
    return 0
  fi

  content="$(jq -r '.message.content // ""' <<<"$response")"
  thinking="$(jq -r '.message.thinking // ""' <<<"$response")"

  jq -c -n \
    --arg run_id "$RUN_ID" \
    --arg model "$model" \
    --arg prompt_file "$PROMPT_FILE" \
    --arg prompt_sha "$PROMPT_SHA" \
    --arg content "$content" \
    --arg thinking "$thinking" \
    --arg false_action "$FALSE_ACTION_REGEX" \
    --arg fabricated "$FABRICATED_DATA_REGEX" \
    --argjson case "$case_json" \
    --argjson raw "$response" \
    --argjson context "$NUM_CTX" \
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

    ($content | bez_think) as $response
    | ($content | test("<think>")) as $inline_think
    |
    {
      run_id: $run_id,
      model: $model,
      id: $case.id,
      kategoria: $case.kategoria,
      prompt: $case.prompt,
      kryterium: $case.kryterium,
      multiturn: (($case.historia // []) | length > 0),

      system_prompt_file: $prompt_file,
      system_prompt_sha256: $prompt_sha,
      context: $context,
      temperature: $temperature,
      think: $think,

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
    }
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
echo "Przypadków: $CASE_COUNT | kontekst: $NUM_CTX | temperatura: $TEMPERATURE | think: $THINK"
echo

for model in "${MODELS[@]}"; do
  safe_model="${model//[^a-zA-Z0-9._-]/_}"
  results_file="$RESULTS_DIR/${safe_model}_${RUN_ID}.jsonl"
  : >"$results_file"

  echo "== $model =="

  printf '  rozgrzewka (ładowanie do VRAM)... ' >&2
  if ! warmup_model "$model"; then
    printf 'NIE UDAŁO SIĘ — pomijam ten model\n' >&2
    echo
    continue
  fi
  printf 'gotowe\n' >&2

  while IFS= read -r case_json <&3; do
    if [[ -z "${case_json//[[:space:]]/}" ]]; then
      continue
    fi
    run_case "$model" "$case_json" "$results_file"
  done 3<"$CASES_FILE"

  if [[ "$UNLOAD_BETWEEN" == "true" ]]; then
    unload_model "$model"
  fi

  echo "   -> $results_file"
  echo
done

echo "Gotowe. Podsumowanie: ./bench/report.sh"
echo "Ocena ręczna:        ./bench/grade.sh <plik_wynikow>"
