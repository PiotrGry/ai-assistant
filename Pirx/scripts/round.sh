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
# Dispatch gate, enforced here rather than in the prompt: the local model saw an open
# `pirx-round` Issue and dispatched again anyway, once an hour. While any such Issue is
# open, or the check itself fails, the round may change nothing.
open_rounds="$(gh issue list -R "${PIRX_ROUND_REPOSITORY:-PiotrGry/zdrovena-reconciliation}" --label pirx-round --state open --json number --jq 'map("#\(.number)") | join(" ")' 2>/dev/null)" || open_rounds="(check failed)"
if [ -n "$open_rounds" ]; then
  mutations=0
  note="Zlecanie jest w tym obchodzie zablokowane: otwarte zadania pirx-round: $open_rounds. Nie wywołuj github_issue_create ani pirx_work_submit; opisz propozycje w części B."
else
  mutations="${PIRX_MAX_MUTATIONS_PER_TOOL:-1}"
  note=""
fi
{
  echo "# Pirx round $(date -u +%Y-%m-%dT%H:%MZ)"
  echo "Dispatch: ${note:-allowed}"
  echo
  # Nobody waits on a background round: give it the budget of a full check, not of a chat reply
  # (the interactive defaults, 8 tool calls, 180 s and 1536 output tokens, cut the report off).
  PIRX_MAX_TOOL_CALLS="${PIRX_MAX_TOOL_CALLS:-20}" PIRX_MAX_TOOL_ITERATIONS="${PIRX_MAX_TOOL_ITERATIONS:-24}" \
  PIRX_MAX_TURN_DURATION_MS="${PIRX_MAX_TURN_DURATION_MS:-900000}" PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS="${PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS:-60000}" \
  PIRX_MAX_OUTPUT_TOKENS="${PIRX_MAX_OUTPUT_TOKENS:-4096}" \
  PIRX_MAX_MUTATIONS_PER_TOOL="$mutations" \
  PIRX_TOOL_PROFILE=operations node --enable-source-maps "$here/agent/dist/index.js" --once \
    < <(cat "$here/agent/prompts/round.md"; [ -z "$note" ] || printf '\n%s\n' "$note") 2>&1
} > "$out"
ln -sfn "$out" "$out_dir/latest.md"
echo "$out"
