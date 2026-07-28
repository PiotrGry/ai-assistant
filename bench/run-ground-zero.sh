#!/usr/bin/env bash
#
# Ground 0: porównanie dwóch realnych konfiguracji możliwych do użycia
# na obecnym sprzęcie. To nie jest test samego wpływu liczby parametrów:
# Qwen działa z thinkingiem, a Gemma bez thinkingu.
#
# Użycie:
#   ./bench/run-ground-zero.sh
#
# Opcjonalne nadpisanie nazw modeli:
#   GROUND_ZERO_QWEN_MODEL=qwen3:14b \
#   GROUND_ZERO_GEMMA_MODEL=hf.co/google/gemma-4-12B-it-qat-q4_0-gguf \
#   ./bench/run-ground-zero.sh
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${BENCH_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
RUNNER="$SCRIPT_DIR/run.sh"
FULL_CASES="$SCRIPT_DIR/cases.jsonl"
CONTESTED_CASES="$SCRIPT_DIR/contested_cases.jsonl"

QWEN_MODEL="${GROUND_ZERO_QWEN_MODEL:-qwen3:14b}"
GEMMA_MODEL="${GROUND_ZERO_GEMMA_MODEL:-hf.co/google/gemma-4-12B-it-qat-q4_0-gguf}"

echo "Ground 0 — pełny zestaw 64 przypadków"
echo

BENCH_ROOT="$BASE_DIR" \
BENCH_CASES="$FULL_CASES" \
BENCH_THINK=true \
BENCH_REPEATS=1 \
BENCH_SEED=42 \
OLLAMA_TEMPERATURE=0 \
"$RUNNER" "$QWEN_MODEL"

BENCH_ROOT="$BASE_DIR" \
BENCH_CASES="$FULL_CASES" \
BENCH_THINK=false \
BENCH_REPEATS=1 \
BENCH_SEED=42 \
OLLAMA_TEMPERATURE=0 \
"$RUNNER" "$GEMMA_MODEL"

echo
echo "Ground 0 — stabilność: 10 trudnych przypadków × 5 prób"
echo

BENCH_ROOT="$BASE_DIR" \
BENCH_CASES="$CONTESTED_CASES" \
BENCH_THINK=true \
BENCH_REPEATS=5 \
BENCH_SEED=100 \
OLLAMA_TEMPERATURE=0.3 \
"$RUNNER" "$QWEN_MODEL"

BENCH_ROOT="$BASE_DIR" \
BENCH_CASES="$CONTESTED_CASES" \
BENCH_THINK=false \
BENCH_REPEATS=5 \
BENCH_SEED=100 \
OLLAMA_TEMPERATURE=0.3 \
"$RUNNER" "$GEMMA_MODEL"

echo
echo "Ground 0 zakończony. Oceń cztery nowe pliki:"
echo "  ./bench/grade.sh bench/results/<plik>.jsonl"
echo "Następnie porównaj je:"
echo "  ./bench/report.sh bench/results/<qwen-full> bench/results/<gemma-full> bench/results/<qwen-stability> bench/results/<gemma-stability>"
