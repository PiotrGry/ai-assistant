#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$(readlink -f "$0")")"

DATABASE="${HOME}/.local/share/pirx/pirx.sqlite"
DATA_DIR="${HOME}/.local/share/pirx-grafana"
AGE_KEY="${SOPS_AGE_KEY_FILE:-${HOME}/.config/sops/age/keys.txt}"

if [[ ! -f "$DATABASE" ]]; then
  echo "Brak bazy Pirxa: $DATABASE. Uruchom najpierw Pirx albo import logów." >&2
  exit 1
fi
if [[ ! -f "$AGE_KEY" ]]; then
  echo "Brak klucza age: $AGE_KEY. Bez niego sops nie odszyfruje grafana.sops.env." >&2
  exit 1
fi

mkdir -p -m 700 "$DATA_DIR"
exec sops exec-env grafana.sops.env 'docker compose -f compose.yaml up -d --wait'
