#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$(readlink -f "$0")")"
exec sops exec-env grafana.sops.env 'docker compose -f compose.yaml down'
