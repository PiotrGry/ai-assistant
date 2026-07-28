#!/usr/bin/env bash
#
# Podsumowanie benchmarku: flagi automatyczne, wydajność, oceny ręczne.
#
# Użycie:
#   ./bench/report.sh                    # wszystkie pliki wyników
#   ./bench/report.sh bench/results/*.jsonl
#
set -Eeuo pipefail

BASE_DIR="$HOME/ai-assistant"
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

echo "=== Flagi automatyczne i wydajność (per model) ==="
echo
jq -s -r '
  group_by(.model)[]
  | (.[0].model) as $model
  | {
      model: $model,
      przypadkow: length,
      bledy: (map(select(.error != null)) | length),
      falszywa_akcja: (map(select(.flaga_falszywa_akcja == true)) | length),
      wymyslone_dane: (map(select(.flaga_wymyslone_dane == true)) | length),
      zadala_pytanie: (map(select(.zadala_pytanie == true)) | length),
      mediana_tok_s: (
        (map(select(.generation_tokens_per_second != null) | .generation_tokens_per_second) | sort) as $s
        | if ($s | length) == 0 then null
          else (($s[($s | length) / 2 | floor] * 10) | round / 10) end
      ),
      sredni_czas_do_odpowiedzi_s: (
        (map(select(.czas_do_odpowiedzi_seconds != null) | .czas_do_odpowiedzi_seconds)) as $t
        | if ($t | length) == 0 then null
          else ((($t | add) / ($t | length) * 10) | round / 10) end
      ),
      sredni_input_tokens: (
        (map(select(.input_tokens != null) | .input_tokens)) as $i
        | if ($i | length) == 0 then null else (($i | add) / ($i | length) | round) end
      ),
      thinking_tokens_widoczne: (map(select((.thinking_chars // 0) > 0)) | length)
    }
' "${FILES[@]}"

echo
echo "=== Flagi per kategoria ==="
echo
jq -s -r '
  group_by(.model)[]
  | (.[0].model) as $model
  | "-- \($model)",
    (
      group_by(.kategoria)[]
      | "   \(.[0].kategoria | . + (" " * (22 - length)))  n=\(length)  falszywa_akcja=\(map(select(.flaga_falszywa_akcja == true)) | length)  wymyslone_dane=\(map(select(.flaga_wymyslone_dane == true)) | length)"
    )
' "${FILES[@]}"

echo
if [[ ! -s "$GRADES_FILE" ]]; then
  echo "=== Oceny ręczne ==="
  echo "Brak ocen. Uruchom: ./bench/grade.sh <plik_wynikow>"
  exit 0
fi

echo "=== Oceny ręczne (per model) ==="
echo
jq -s -r '
  group_by(.model)[]
  | (.[0].model) as $model
  | (map(select(.verdict == "pass")) | length) as $pass
  | (map(select(.verdict == "partial")) | length) as $partial
  | (map(select(.verdict == "fail")) | length) as $fail
  | length as $total
  | {
      model: $model,
      ocenionych: $total,
      pass: $pass,
      partial: $partial,
      fail: $fail,
      procent_pass: (($pass / $total * 1000) | round / 10)
    }
' "$GRADES_FILE"

echo
echo "=== Oceny ręczne per kategoria ==="
echo
jq -s -r '
  group_by(.model)[]
  | (.[0].model) as $model
  | "-- \($model)",
    (
      group_by(.kategoria)[]
      | (map(select(.verdict == "pass")) | length) as $pass
      | "   \(.[0].kategoria | . + (" " * (22 - length)))  \($pass)/\(length) pass"
    )
' "$GRADES_FILE"

echo
echo "=== Oblane przypadki (do poprawy promptu) ==="
echo
jq -s -r '
  map(select(.verdict == "fail" or .verdict == "partial"))
  | if length == 0 then "   brak" else
      (.[] | "   [\(.id)] \(.model) \(.verdict)\(if (.comment // "") == "" then "" else "  — \(.comment)" end)")
    end
' "$GRADES_FILE"
