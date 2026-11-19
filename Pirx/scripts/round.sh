#!/usr/bin/env bash
# One Pirx round (#338): the local model reads production errors, the backlog, the daemon
# state and code health, writes what it would do, and may dispatch one tests-only task
# (agent/prompts/round.md). Every tool call is in the chat action ledger and session log.
# --once reads the whole prompt from stdin and answers it in one turn.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${PIRX_ROUNDS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/pirx/rounds}"
mkdir -p "$out_dir"
out="$out_dir/$(date -u +%Y-%m-%dT%H%MZ).md"
{
  echo "# Pirx round $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  # Nobody waits on a background round: give it the budget of a full check, not of a chat reply
  # (the interactive defaults, 8 tool calls and 180 s, cut the report off after step 4).
  PIRX_MAX_TOOL_CALLS="${PIRX_MAX_TOOL_CALLS:-20}" PIRX_MAX_TOOL_ITERATIONS="${PIRX_MAX_TOOL_ITERATIONS:-24}" \
  PIRX_MAX_TURN_DURATION_MS="${PIRX_MAX_TURN_DURATION_MS:-900000}" PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS="${PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS:-60000}" \
  PIRX_TOOL_PROFILE=operations node --enable-source-maps "$here/agent/dist/index.js" --once \
    < "$here/agent/prompts/round.md" 2>&1
} > "$out"
ln -sfn "$out" "$out_dir/latest.md"
echo "$out"
