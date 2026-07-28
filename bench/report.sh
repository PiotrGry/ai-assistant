#!/usr/bin/env bash
#
# Podsumowanie benchmarku: flagi automatyczne, wydajność, oceny ręczne.
#
# Użycie:
#   ./bench/report.sh                    # wszystkie pliki wyników
#   ./bench/report.sh bench/results/*.jsonl
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${BENCH_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
BENCH_DIR="$BASE_DIR/bench"
RESULTS_DIR="$BENCH_DIR/results"
GRADES_FILE="${BENCH_GRADES:-$BENCH_DIR/grades.jsonl}"

if (( $# > 0 )); then
  FILES=("$@")
else
  shopt -s nullglob
  FILES=("$RESULTS_DIR"/*.jsonl)
  shopt -u nullglob
fi

if (( ${#FILES[@]} == 0 )); then
  echo "Brak plików wyników w $RESULTS_DIR — najpierw uruchom ./bench/run.sh" >&2
  exit 1
fi

RESULT_KEYS="$(
  jq -s -c '
    group_by([(.run_id // "legacy"), .model])
    | map({
        run_id: (.[0].run_id // "legacy"),
        model: .[0].model
      })
  ' "${FILES[@]}"
)"

echo "=== Flagi automatyczne i wydajność (per przebieg i konfiguracja) ==="
echo
jq -s -r '
  def mediana:
    if length == 0 then null else sort | .[length / 2 | floor] end;
  def p95:
    if length == 0 then null else sort | .[((length * 0.95 | ceil) - 1)] end;

  group_by([
    (.run_id // "legacy"),
    .model,
    (.model_digest // ""),
    (.system_prompt_sha256 // ""),
    (.context // 0),
    (.num_predict // -1),
    (.temperature // 0),
    (.think // false)
  ])[]
  | (.[0]) as $first
  | ($first.expected_cases // null) as $expected_cases
  | ($first.expected_repeats // 1) as $expected_repeats
  | (
      if $expected_cases == null then null
      else ($expected_cases * $expected_repeats)
      end
    ) as $expected_records
  | {
      run_id: ($first.run_id // "legacy"),
      model: $first.model,
      digest: (($first.model_digest // "")[0:12] | if length == 0 then null else . end),
      quant: ($first.model_quant // null),
      machine_id: ($first.machine_id // null),
      machine_id_source: ($first.machine_id_source // null),
      host_os: ($first.host_os // null),
      ollama_version: ($first.ollama_version // null),
      gpu: ($first.gpu_name // null),
      gpu_driver: ($first.gpu_driver // null),
      gpu_vram_total_mb: ($first.gpu_vram_total_mb // null),
      model_size_gb: (
        if ($first.model_size_bytes | type) == "number"
        then (($first.model_size_bytes / 1073741824 * 100) | round / 100)
        else null
        end
      ),
      model_size_vram_gb: (
        if ($first.model_size_vram_bytes | type) == "number"
        then (($first.model_size_vram_bytes / 1073741824 * 100) | round / 100)
        else null
        end
      ),
      cpu_offload_gb: (
        if ($first.cpu_offload_bytes | type) == "number"
        then (($first.cpu_offload_bytes / 1073741824 * 100) | round / 100)
        else null
        end
      ),
      cpu_offload_detected: ($first.cpu_offload_detected // null),
      gpu_residency_percent: ($first.gpu_residency_percent // null),
      loaded_context_length: ($first.loaded_context_length // null),
      context: ($first.context // null),
      num_predict: ($first.num_predict // null),
      temperature: ($first.temperature // null),
      think: ($first.think // false),
      rekordow: length,
      oczekiwano: $expected_records,
      kompletny: (
        if $expected_records == null then null
        else (length == $expected_records)
        end
      ),
      bledy: (map(select(.error != null)) | length),
      falszywa_akcja: (map(select(.flaga_falszywa_akcja == true)) | length),
      wymyslone_dane: (map(select(.flaga_wymyslone_dane == true)) | length),
      zadala_pytanie: (map(select(.zadala_pytanie == true)) | length),
      mediana_tok_s: (
        map(select(.error == null and .generation_tokens_per_second != null)
          | .generation_tokens_per_second)
        | mediana
        | if . == null then null else ((. * 10) | round / 10) end
      ),
      p50_pelnej_odpowiedzi_s: (
        map(select(.error == null and .wall_seconds != null) | .wall_seconds)
        | mediana
        | if . == null then null else ((. * 10) | round / 10) end
      ),
      p95_pelnej_odpowiedzi_s: (
        map(select(.error == null and .wall_seconds != null) | .wall_seconds)
        | p95
        | if . == null then null else ((. * 10) | round / 10) end
      ),
      mediana_czasu_do_generacji_s: (
        map(select(.error == null and .czas_do_odpowiedzi_seconds != null)
          | .czas_do_odpowiedzi_seconds)
        | mediana
        | if . == null then null else ((. * 10) | round / 10) end
      ),
      sredni_input_tokens: (
        (map(select(.error == null and .input_tokens != null) | .input_tokens)) as $i
        | if ($i | length) == 0 then null else (($i | add) / ($i | length) | round) end
      ),
      thinking_tokens_widoczne: (map(select((.thinking_chars // 0) > 0)) | length)
    }
' "${FILES[@]}"

echo
echo "=== Kontrola porównywalności środowiska ==="
echo
jq -s '
  def znane($field):
    [.[]
      | .[$field]
      | select(. != null and . != "")
    ] | unique;

  (znane("machine_id")) as $machines
  | (znane("ollama_version")) as $versions
  | (znane("gpu_name")) as $gpus
  | {
      maszyny: $machines,
      jedna_maszyna: (
        if ($machines | length) == 0 then null
        else ($machines | length) == 1
        end
      ),
      wersje_ollamy: $versions,
      jedna_wersja_ollamy: (
        if ($versions | length) == 0 then null
        else ($versions | length) == 1
        end
      ),
      gpu: $gpus,
      cpu_offload_wykryty: any(.[]; .cpu_offload_detected == true),
      konfiguracje_z_cpu_offloadem: (
        [
          .[]
          | select(.cpu_offload_detected == true)
          | "\(.run_id // "legacy"):\(.model)"
        ] | unique
      ),
      brak_danych_o_offloadzie: any(.[]; .cpu_offload_detected == null)
    }
' "${FILES[@]}"

echo
echo "=== Flagi per kategoria ==="
echo
jq -s -r '
  group_by([
    (.run_id // "legacy"),
    .model,
    (.model_digest // ""),
    (.system_prompt_sha256 // ""),
    (.context // 0),
    (.num_predict // -1),
    (.temperature // 0),
    (.think // false)
  ])[]
  | (.[0]) as $first
  | "-- run=\($first.run_id // "legacy")  model=\($first.model)  think=\($first.think // false)  num_predict=\($first.num_predict // "?")  temp=\($first.temperature // "?")",
    (
      group_by(.kategoria)[]
      | "   \(.[0].kategoria | . + (" " * ([1, 22 - length] | max)))  n=\(length)  bledy=\(map(select(.error != null)) | length)  falszywa_akcja=\(map(select(.flaga_falszywa_akcja == true)) | length)  wymyslone_dane=\(map(select(.flaga_wymyslone_dane == true)) | length)"
    )
' "${FILES[@]}"

echo
if [[ ! -s "$GRADES_FILE" ]] ||
  ! jq -e -s --argjson result_keys "$RESULT_KEYS" '
    any(.[];
      . as $grade
      | any($result_keys[];
          .run_id == ($grade.run_id // "legacy")
          and .model == $grade.model
        )
    )
  ' "$GRADES_FILE" >/dev/null; then
  echo "=== Oceny ręczne ==="
  echo "Brak ocen dla wybranych wyników. Uruchom: ./bench/grade.sh <plik_wynikow>"
  exit 0
fi

echo "=== Oceny ręczne (per przebieg i model) ==="
echo
jq -s -r --argjson result_keys "$RESULT_KEYS" '
  def punkty:
    .score //
      (if .verdict == "pass" then 2
       elif .verdict == "partial" then 1
       else 0
       end);

  map(select(
    . as $grade
    | any($result_keys[];
        .run_id == ($grade.run_id // "legacy")
        and .model == $grade.model
      )
  ))
  | group_by([(.run_id // "legacy"), .model])[]
  | (.[0]) as $first
  | (map(select(.verdict == "pass")) | length) as $pass
  | (map(select(.verdict == "partial")) | length) as $partial
  | (map(select(.verdict == "fail")) | length) as $fail
  | (map(punkty) | add) as $score
  | length as $total
  | {
      run_id: ($first.run_id // "legacy"),
      model: $first.model,
      ocenionych: $total,
      pass: $pass,
      partial: $partial,
      fail: $fail,
      krytyczne_bledy: (map(select(.critical_failure == true)) | length),
      procent_pass: (($pass / $total * 1000) | round / 10),
      wynik_procent: (($score / ($total * 2) * 1000) | round / 10)
    }
' "$GRADES_FILE"

echo
echo "=== Oceny ręczne per kategoria ==="
echo
jq -s -r --argjson result_keys "$RESULT_KEYS" '
  def punkty:
    .score //
      (if .verdict == "pass" then 2
       elif .verdict == "partial" then 1
       else 0
       end);

  map(select(
    . as $grade
    | any($result_keys[];
        .run_id == ($grade.run_id // "legacy")
        and .model == $grade.model
      )
  ))
  | group_by([(.run_id // "legacy"), .model])[]
  | (.[0]) as $first
  | "-- run=\($first.run_id // "legacy")  model=\($first.model)",
    (
      group_by(.kategoria)[]
      | (map(select(.verdict == "pass")) | length) as $pass
      | (map(punkty) | add) as $score
      | (map(select(.critical_failure == true)) | length) as $critical
      | "   \(.[0].kategoria | . + (" " * ([1, 22 - length] | max)))  pass=\($pass)/\(length)  wynik=\((($score / (length * 2) * 1000) | round / 10))%  krytyczne=\($critical)"
    )
' "$GRADES_FILE"

echo
echo "=== Stabilność ocen w powtórzeniach ==="
echo
jq -s -r --argjson result_keys "$RESULT_KEYS" '
  map(select(
    . as $grade
    | any($result_keys[];
        .run_id == ($grade.run_id // "legacy")
        and .model == $grade.model
      )
  ))
  | group_by([(.run_id // "legacy"), .model])[]
  | (.[0]) as $first
  | [
      group_by(.id)[]
      | select(length > 1)
      | {
          id: .[0].id,
          proby: length,
          pass: (map(select(.verdict == "pass")) | length),
          wszystkie_pass: all(.[]; .verdict == "pass")
        }
    ] as $cases
  | "-- run=\($first.run_id // "legacy")  model=\($first.model)",
    (
      if ($cases | length) == 0 then
        "   brak ocenionych powtórzeń"
      else
        "   przypadków z powtórzeniami=\($cases | length)  stabilne=\($cases | map(select(.wszystkie_pass)) | length)",
        (
          $cases[]
          | select(.wszystkie_pass | not)
          | "   niestabilny: [\(.id)] pass=\(.pass)/\(.proby)"
        )
      end
    )
' "$GRADES_FILE"

echo
echo "=== Oblane przypadki (do poprawy promptu) ==="
echo
jq -s -r --argjson result_keys "$RESULT_KEYS" '
  map(select(
    . as $grade
    | any($result_keys[];
        .run_id == ($grade.run_id // "legacy")
        and .model == $grade.model
      )
  ))
  | map(select(.verdict == "fail" or .verdict == "partial"))
  | if length == 0 then "   brak" else
      (.[] | "   [\(.id) r\(.repeat // 1)] run=\(.run_id // "legacy")  \(.model) \(.verdict)\(if .critical_failure == true then "  [KRYTYCZNY]" else "" end)\(if (.comment // "") == "" then "" else "  — \(.comment)" end)")
    end
' "$GRADES_FILE"
