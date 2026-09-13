#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$(readlink -f "$0")")"

SQL="${1:?użycie: ./query.sh \"SELECT ...\"}"
BODY="$(SQL="$SQL" python3 -c '
import json, os
sql = os.environ["SQL"]
print(json.dumps({
    "queries": [{
        "refId": "A",
        "datasource": {"uid": "pirx-sqlite"},
        "rawQueryText": sql,
        "queryText": sql,
        "queryType": "table",
        "timeColumns": [],
    }],
    "from": "now-365d",
    "to": "now",
}))')"
export BODY
exec sops exec-env grafana.sops.env 'curl -sS --fail-with-body -u "admin:${GF_SECURITY_ADMIN_PASSWORD}" -H "content-type: application/json" --data "$BODY" http://127.0.0.1:3000/api/ds/query'
