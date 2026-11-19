#!/usr/bin/env bash
# One observe-only Pirx round (#338 phase 1): the local model reads production errors,
# the backlog and the daemon state, and writes what it would do. Nothing is changed:
# mutation tools need host approval, which a non-interactive run never gives.
# --once reads the whole prompt from stdin and answers it in one turn.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${PIRX_ROUNDS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/pirx/rounds}"
mkdir -p "$out_dir"
out="$out_dir/$(date -u +%Y-%m-%dT%H%MZ).md"
{
  echo "# Pirx round $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  PIRX_TOOL_PROFILE=operations node --enable-source-maps "$here/agent/dist/index.js" --once \
    < "$here/agent/prompts/round.md" 2>&1
} > "$out"
ln -sfn "$out" "$out_dir/latest.md"
echo "$out"
