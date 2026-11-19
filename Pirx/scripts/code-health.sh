#!/usr/bin/env bash
# Code health snapshot for Pirx rounds (#338): coverage per file and TODO/FIXME markers on the
# current origin/develop, measured in Pirx's own detached worktree (never the operator's checkout).
# The MCP tool zdrovena_code_health only reads the JSON this writes.
set -euo pipefail
repo="${PIRX_HEALTH_REPOSITORY_ROOT:-$HOME/dev/zdrovena-reconciliation}"
dir="${XDG_DATA_HOME:-$HOME/.local/share}/pirx/health"
wt="$dir/zdrovena-worktree"
mkdir -p "$dir"
git -C "$repo" fetch -q origin develop
[ -d "$wt" ] || git -C "$repo" worktree add -q --detach "$wt" origin/develop
git -C "$wt" checkout -q --detach --force origin/develop
git -C "$wt" clean -q -fdx -e .venv
cd "$wt"
uv sync -q --locked --extra dev --extra api --extra cloud --extra report --extra ksef --extra pdf
status=0
uv run --no-sync python -m pytest tests/ -q -p no:cacheprovider --no-header --cov=zdrovena --cov-report="json:$dir/coverage.json" > "$dir/pytest.log" 2>&1 || status=$?
git grep -n -I -E '\b(TODO|FIXME)\b' -- zdrovena frontend/src scripts > "$dir/markers.txt" || true
uv run --no-sync python - "$dir" "$(git rev-parse HEAD)" "$status" <<'PY'
import json, sys, datetime, pathlib
out, commit, status = pathlib.Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
cov = json.loads((out / "coverage.json").read_text()) if (out / "coverage.json").exists() else {"files": {}, "totals": {}}
def ranges(lines):
    spans, start, prev = [], None, None
    for n in sorted(lines):
        if start is None: start = prev = n
        elif n == prev + 1: prev = n
        else: spans.append(f"{start}-{prev}" if start != prev else str(start)); start = prev = n
    if start is not None: spans.append(f"{start}-{prev}" if start != prev else str(start))
    return spans[:15]
files = [
    {"file": name, "percent": round(data["summary"]["percent_covered"], 1), "statements": data["summary"]["num_statements"],
     "missing": data["summary"]["missing_lines"], "missingRanges": ranges(data.get("missing_lines", []))}
    for name, data in cov["files"].items() if data["summary"]["num_statements"] >= 30
]
files.sort(key=lambda item: (item["percent"], -item["missing"]))
markers = []
for line in (out / "markers.txt").read_text().splitlines()[:60]:
    path, number, text = (line.split(":", 2) + ["", ""])[:3]
    markers.append({"file": path, "line": int(number) if number.isdigit() else 0, "text": text.strip()[:200]})
report = {"generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "repository": "PiotrGry/zdrovena-reconciliation",
          "commit": commit, "testsPassed": status == 0, "totalCoverage": round(cov.get("totals", {}).get("percent_covered", 0.0), 1),
          "weakestFiles": files[:20], "markers": markers}
(out / "zdrovena.json").write_text(json.dumps(report, indent=1))
print(f"{out / 'zdrovena.json'}: coverage {report['totalCoverage']}%, {len(files)} files, {len(markers)} markers, tests {'passed' if status == 0 else 'FAILED'}")
PY
