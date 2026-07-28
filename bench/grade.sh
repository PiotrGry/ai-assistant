#!/usr/bin/env bash
#
# Ręczna ocena wyników benchmarku. Flagi z run.sh to tylko podpowiedzi —
# o zaliczeniu decyduje kryterium przy przypadku.
#
# Użycie: ./bench/grade.sh bench/results/qwen3_14b_20260726_150000.jsonl
#
set -Eeuo pipefail

BASE_DIR="$HOME/ai-assistant"
BENCH_DIR="$BASE_DIR/bench"
GRADES_FILE="${BENCH_GRADES:-$BENCH_DIR/grades.jsonl}"

if (( $# != 1 )); then
  echo "Użycie: $0 <plik_wynikow.jsonl>" >&2
  exit 1
fi

RESULTS_FILE="$1"

if [[ ! -r "$RESULTS_FILE" ]]; then
  echo "Nie mogę odczytać: $RESULTS_FILE" >&2
  exit 1
fi

touch "$GRADES_FILE"
chmod 600 "$GRADES_FILE"

already_graded() {
  local model="$1"
  local case_id="$2"
  jq -e -s \
    --arg model "$model" \
    --arg case_id "$case_id" \
    'any(.[]; .model == $model and .id == $case_id)' \
    "$GRADES_FILE" >/dev/null 2>&1
}

total=0
graded=0

while IFS= read -r record <&3; do
  if [[ -z "${record//[[:space:]]/}" ]]; then
    continue
  fi

  total=$((total + 1))

  model="$(jq -r '.model' <<<"$record")"
  case_id="$(jq -r '.id' <<<"$record")"

  if already_graded "$model" "$case_id"; then
    echo "[$case_id] już ocenione, pomijam."
    continue
  fi

  printf '\n%s\n' "----------------------------------------------------------------"
  jq -r '
    "[\(.id)] \(.kategoria)\(if .multiturn then "  (wieloturowy)" else "" end)",
    "",
    "PYTANIE:   \(.prompt)",
    "",
    "KRYTERIUM: \(.kryterium)",
    "",
    "ODPOWIEDŹ:",
    (.response // "(brak — \(.error // "nieznany błąd"))"),
    "",
    "flagi automatyczne: \(
      [ (if .flaga_falszywa_akcja then "FAŁSZYWA-AKCJA" else empty end),
        (if .flaga_wymyslone_dane then "WYMYŚLONE-DANE" else empty end),
        (if .zadala_pytanie then "zadała-pytanie" else empty end)
      ] | if length == 0 then "brak" else join(", ") end
    )   |   \(.output_tokens // 0) tok, \(((.wall_seconds // 0) * 10 | round) / 10)s"
  ' <<<"$record"

  verdict=""
  while [[ -z "$verdict" ]]; do
    printf '\nZaliczone? [t]ak / [n]ie / [c]zęściowo / [p]omiń / [k]oniec: ' >&2
    if ! IFS= read -r answer </dev/tty; then
      echo
      echo "Przerwane."
      exit 0
    fi
    case "$answer" in
    t | T) verdict="pass" ;;
    n | N) verdict="fail" ;;
    c | C) verdict="partial" ;;
    p | P) verdict="skip" ;;
    k | K)
      echo "Koniec. Ocenione w tej sesji: $graded"
      exit 0
      ;;
    *) echo "Nie rozumiem: $answer" >&2 ;;
    esac
  done

  if [[ "$verdict" == "skip" ]]; then
    continue
  fi

  printf 'Komentarz (Enter = pomiń): ' >&2
  IFS= read -r comment </dev/tty || comment=""

  jq -c -n \
    --arg results_file "$RESULTS_FILE" \
    --arg model "$model" \
    --arg case_id "$case_id" \
    --arg kategoria "$(jq -r '.kategoria' <<<"$record")" \
    --arg run_id "$(jq -r '.run_id // ""' <<<"$record")" \
    --arg verdict "$verdict" \
    --arg comment "$comment" \
    --arg graded_at "$(date --iso-8601=seconds)" '
    {
      results_file: $results_file,
      run_id: $run_id,
      model: $model,
      id: $case_id,
      kategoria: $kategoria,
      verdict: $verdict,
      comment: $comment,
      graded_at: $graded_at
    }
  ' >>"$GRADES_FILE"

  graded=$((graded + 1))
done 3<"$RESULTS_FILE"

echo
echo "Przypadków w pliku: $total, ocenionych w tej sesji: $graded"
echo "Oceny: $GRADES_FILE"
echo "Podsumowanie: ./bench/report.sh"
