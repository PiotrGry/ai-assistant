#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$(readlink -f "$0")")"

DATABASE="${PIRX_STORAGE_FILE:-${HOME}/.local/share/pirx/pirx.sqlite}"
GPU_DATABASE="${PIRX_GPU_DB:-${HOME}/.local/share/pirx/gpu.sqlite}"
DATA_DIR="${PIRX_GRAFANA_DATA_DIR:-${HOME}/.local/share/pirx-grafana}"
EXPORT_DIR="${PIRX_DASHBOARD_EXPORT_DIR:-${HOME}/.local/share/pirx-dashboard-export}"
AGE_KEY="${SOPS_AGE_KEY_FILE:-${HOME}/.config/sops/age/keys.txt}"

canonical_path() {
  python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

DATABASE="$(canonical_path "$DATABASE")"
GPU_DATABASE="$(canonical_path "$GPU_DATABASE")"
DATA_DIR="$(canonical_path "$DATA_DIR")"
EXPORT_DIR="$(canonical_path "$EXPORT_DIR")"

if [[ ! -f "$DATABASE" ]]; then
  echo "Brak bazy Pirxa: $DATABASE. Uruchom najpierw Pirx albo import logów." >&2
  exit 1
fi
if [[ ! -f "$AGE_KEY" ]]; then
  echo "Brak klucza age: $AGE_KEY. Bez niego sops nie odszyfruje grafana.sops.env." >&2
  exit 1
fi

mkdir -p -m 700 "$DATA_DIR" "$EXPORT_DIR"
export PIRX_DASHBOARD_CHAT_DIR="$(dirname "$DATABASE")"
export PIRX_DASHBOARD_CHAT_NAME="$(basename "$DATABASE")"
export PIRX_DASHBOARD_GPU_DIR="$(dirname "$GPU_DATABASE")"
export PIRX_DASHBOARD_GPU_NAME="$(basename "$GPU_DATABASE")"
export PIRX_DASHBOARD_EXPORT_DIR="$EXPORT_DIR"
export PIRX_GRAFANA_DATA_DIR="$DATA_DIR"
export PIRX_DASHBOARD_UID="${PIRX_DASHBOARD_UID:-$(id -u)}"
export PIRX_DASHBOARD_GID="${PIRX_DASHBOARD_GID:-$(id -g)}"
exec sops exec-env grafana.sops.env 'docker compose -f compose.yaml up -d --wait'
