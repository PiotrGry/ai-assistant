#!/usr/bin/env bash
# Deploys a Pirx runtime to the coordination watcher (ai-assistant#370).
#
#   scripts/go-live.sh build  <commit>   build ~/.local/share/pirx/runtime-<sha>, run unit and integration tests
#   scripts/go-live.sh shadow <commit>   point the watcher at it in dry-run mode (journal: pirx-shadow.sqlite)
#   scripts/go-live.sh live   <commit>   switch to live, only when all three conditions hold for this commit:
#       1. an eval run of the full case set passed the gate (every case, every run)
#       2. the build step's tests passed
#       3. the last SHADOW_TICKS shadow ticks of this runtime all ended with a decision
#   scripts/go-live.sh status            what runs now and what is missing for live
#
# Stop everything at once: touch ~/.config/pirx/STOP   (every mutating tool refuses)
# Roll back: scripts/go-live.sh live <previous commit>  (its conditions were met before)
set -euo pipefail

repo="${PIRX_REPO:-$HOME/ai-assistant}"
data="${XDG_DATA_HOME:-$HOME/.local/share}/pirx"
unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/pirx-watch.service"
shadow_ticks="${SHADOW_TICKS:-5}"

runtime_of() { echo "$data/runtime-$1/Pirx"; }
short() { git -C "$repo" rev-parse --short=7 "$1"; }

tests_passed() { [ -f "$(runtime_of "$1")/.tests-passed" ]; }

eval_passed() {
  # The newest full eval run for this commit decides.
  local file
  file=$(ls -t "$data"/evals/*.json 2>/dev/null | while read -r f; do
    if jq -e --arg c "$1" '.commit == $c and .only == null' "$f" >/dev/null 2>&1; then echo "$f"; break; fi
  done)
  [ -n "$file" ] && jq -e '.gate == true' "$file" >/dev/null
}

shadow_passed() {
  local runtime ok total
  runtime=$(runtime_of "$1")
  read -r total ok < <(sqlite3 -separator ' ' "$data/pirx-shadow.sqlite" \
    "select count(*), coalesce(sum(ok),0) from (select ok from coord_journal where kind='tick' and json_extract(input,'\$.runtime')='$runtime' order by seq desc limit $shadow_ticks)" 2>/dev/null || echo "0 0")
  [ "$total" -ge "$shadow_ticks" ] && [ "$ok" -eq "$total" ]
}

report() {
  local sha=$1
  printf '%s\n' "Runtime $sha:"
  if tests_passed "$sha"; then echo "  tests:  passed"; else echo "  tests:  MISSING (scripts/go-live.sh build $sha)"; fi
  if eval_passed "$sha"; then echo "  evals:  passed"; else echo "  evals:  MISSING (cd $(runtime_of "$sha") && pnpm eval --runs 3)"; fi
  if shadow_passed "$sha"; then echo "  shadow: $shadow_ticks ticks with a decision"; else echo "  shadow: MISSING ($shadow_ticks successful shadow ticks of this runtime; scripts/go-live.sh shadow $sha)"; fi
}

point_unit() {
  local sha=$1 mode=$2 runtime
  runtime=$(runtime_of "$sha")
  cp "$unit" "$unit.before-$(date +%Y%m%d%H%M%S)"
  sed -i -E "s#$data/runtime-[0-9a-f]+/Pirx#$runtime#g" "$unit"
  sed -i '/PIRX_COORDINATION_DRY_RUN=/d; /PIRX_STORAGE_FILE=.*pirx-shadow.sqlite/d' "$unit"
  if [ "$mode" = shadow ]; then
    sed -i "/^ExecStart=/i Environment=PIRX_COORDINATION_DRY_RUN=1\nEnvironment=PIRX_STORAGE_FILE=$data/pirx-shadow.sqlite" "$unit"
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now pirx-watch.timer >/dev/null 2>&1
  echo "pirx-watch now runs $runtime ($mode)."
}

cmd=${1:-status}
case "$cmd" in
  build)
    sha=$(short "${2:?commit}"); runtime=$(runtime_of "$sha")
    mkdir -p "$data/runtime-$sha"
    [ -d "$runtime" ] || git -C "$repo" archive "$sha" | tar -x -C "$data/runtime-$sha"
    cd "$runtime"
    pnpm install --frozen-lockfile >/dev/null
    pnpm build >/dev/null
    npx tsc -p mcp-server/tsconfig.test.json >/dev/null
    npx tsc -p agent/tsconfig.test.json >/dev/null
    node --test mcp-server/dist-test/test/*.test.js >/dev/null
    node --test agent/dist-test/test/*.test.js >/dev/null
    touch "$runtime/.tests-passed"
    echo "Built and tested $runtime."
    ;;
  shadow)
    sha=$(short "${2:?commit}")
    tests_passed "$sha" || { echo "Run: scripts/go-live.sh build $sha"; exit 1; }
    point_unit "$sha" shadow
    ;;
  live)
    sha=$(short "${2:?commit}")
    if tests_passed "$sha" && eval_passed "$sha" && shadow_passed "$sha"; then point_unit "$sha" live
    else report "$sha"; echo "Not switching to live."; exit 1; fi
    ;;
  status)
    current=$(grep -oE 'runtime-[0-9a-f]+' "$unit" | head -1 | sed 's/runtime-//')
    if grep -q PIRX_COORDINATION_DRY_RUN=1 "$unit"; then mode=shadow; else mode=live; fi
    echo "pirx-watch: $(systemctl --user is-active pirx-watch.timer) timer, $mode, runtime $current"
    [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/pirx/STOP" ] && echo "STOP switch is ON"
    [ -n "$current" ] && report "$current"
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
