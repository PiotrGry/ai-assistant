# Production error intake: Log Analytics to a triaged Pirx bug

Date: 2026-11-12
Status: approved design, not implemented
Scope: sub-project A of three. C (Pirx on the phone: chat and push
notifications) and B (testing the local model for triage and grouping)
follow with their own specs.

## Goal

When the zdrovena app raises an exception in production, Pirx notices it,
groups it with earlier occurrences of the same problem, and opens one GitHub
bug issue in triage. After the operator moves the issue to `Todo`, the normal
Pirx queue gives it to the Claude worker. The worker reads the original log
entries itself through a read-only tool, so it can confirm that the issue
describes them correctly.

No language model takes part in detection, grouping or issue creation. All of
it is deterministic daemon code.

## Non-goals

- `AppTraces` with `severityLevel >= 3` that have no exception (3 in the last
  30 days). Add when they matter.
- Staging telemetry. It shares the App Insights component and is filtered out.
- Azure alert rules, Logic Apps or any change to zdrovena infrastructure.
- Notifications (sub-project C) and model-based triage or grouping
  (sub-project B).
- Automatic start of the worker. A human approves every issue.

## Facts this design rests on

Observed on 2026-11-12 in Log Analytics workspace
`d1af17c0-c042-4cb1-870b-c94b6e950fff` (resource group `zdrovena-rg`):

- `AppExceptions` held 15 rows in 30 days, from `zdrovena-api-prod` and
  `zdrovena-allegro-poller`. Types: `ServiceResponseError`,
  `ServiceResponseTimeoutError`, `CourierServerError`,
  `CourierConnectionError`, `PermissionError`, `AllegroBusinessError`.
- The `AllegroBusinessError` of 2026-10-26 has `OperationId`
  `597656160853e0e03e4951ffebc4a4aa`, the locator issue #462 was written from.
- `ProblemId` is often the exception type alone, so it merges unrelated
  errors. `OperationId` is all zeros for background jobs.
- `Details` has no `parsedStack`. The stack is `rawStack`, a Python traceback.
  Our code appears as `/app/.venv/lib/python3.12/site-packages/zdrovena/...`.
- The deepest frame of our code is often a shared helper (for every Allegro
  error, `zdrovena/common/allegro.py:_request`).
- `zdrovena-reconciliation` is a public repository. Exception messages can
  contain customer or vendor data.
- Pirx treats Project #3 statuses `Todo`, `Open` and `In Progress` as
  runnable (`EXECUTABLE_STATUS` in `github-queue-sync.ts`).
- The advisor MCP server is created per worker run and bound to one Task and
  Attempt (`createAdvisorServer(store, taskId, attemptId)`).
- Merges and deploys are fully automatic: a feature PR merges to `develop`
  after Fast Gate, Pirx merges `develop` to `main` after Release Gate, and a
  push to `main` deploys production. Human triage is therefore the only
  approval in the chain.

## Architecture

```
Log Analytics (AppExceptions)
      │  every 15 min
      ▼
[1] ErrorSignalSource      az token + Log Analytics query API
      │  ItemId, TimeGenerated, ingestion time, AppRoleName,
      │  ExceptionType, OperationId, rawStack
      ▼
[2] fingerprint()          pure: role + type + 3 deepest frames of our code
      ▼
[3] SQLite                 signals, occurrences, cursor
      ▼
[4] ErrorIssuePublisher    issue in Triage, daily comment, regression issue
      ▼
GitHub issue (Triage) ──operator──▶ Todo ──▶ Pirx queue ──▶ Claude worker
                                                            │
[5] advisor tool read_error_occurrences ◀───────────────────┘
```

Steps 1 to 4 run as one new step of the daemon cycle with its own interval,
next to queue synchronization.

### [1] ErrorSignalSource

- Token: `az account get-access-token --resource https://api.loganalytics.io`
  run with `execFile`, cached until its `expiresOn`. The daemon already runs
  as the operator, so it uses the operator's `az` login.
- Query: `POST https://api.loganalytics.io/v1/workspaces/{workspaceId}/query`
  with Node's `fetch`. No new npm dependency.
- KQL:

  ```kusto
  AppExceptions
  | where ingestion_time() > datetime(<cursor - 5m>)
  | where AppRoleName in (<roles>)
  | project ItemId = _ItemId, TimeGenerated, Ingested = ingestion_time(),
            AppRoleName, ExceptionType, OperationId, Details
  | order by Ingested asc
  | take 500
  ```

- The cursor is ingestion time, not `TimeGenerated`, because rows can arrive
  minutes late. The 5-minute overlap plus a unique `ItemId` makes re-reading
  safe.
- From `Details` only `rawStack` is kept for fingerprinting. Messages are not
  stored in SQLite.
- Timeout 30 seconds. A failure leaves the cursor unchanged.

### [2] fingerprint()

- Parse frames from `rawStack` lines matching
  `File "<path>", line <n>, in <name>`.
- Our frames are paths containing `/site-packages/zdrovena/` or a path that
  starts with `zdrovena/`. Normalize them to `zdrovena/<rest>`.
- Signature input: `AppRoleName`, `ExceptionType`, and the 3 deepest of our
  frames as `file:function`, without line numbers. A line number changes with
  any edit above it; the function does not.
- Without any frame of our code, use the 3 deepest frames overall. This is
  the typical shape of a network or SDK error and a hint for triage.
- Fingerprint: SHA-256 of that input, hex, first 16 characters in titles and
  markers, full value in SQLite.

### [3] Durable state

New tables in `runtime.sqlite`, with a schema migration:

- `runtime_error_signals`: `fingerprint` (primary key), `repository`, `role`,
  `exception_type`, `frames_json` (file, line, function for display),
  `first_seen`, `last_seen`, `occurrence_count`, `issue_number` (nullable),
  `publish_state` (`pending_issue`, `published`, `deferred`),
  `last_comment_at`, `comment_pending_count`, `created_at`, `updated_at`.
- `runtime_error_occurrences`: `item_id` (primary key), `fingerprint`,
  `time_generated`, `operation_id`, `role`. At most 200 rows per fingerprint;
  the oldest are pruned.
- `runtime_error_intake_cursor`: `source` (primary key), `ingested_through`,
  `updated_at`.

One transaction writes the occurrences, updates the signals and advances the
cursor. If it fails, nothing advances.

On the first run the cursor starts at `now - initialLookbackDays` (30), so
the 15 existing exceptions become the first issues.

### [4] ErrorIssuePublisher

For each signal after a successful intake transaction:

- No issue yet: mark `pending_issue`, then search GitHub for the marker
  `pirx-error-signal:<fingerprint16>`. If found, adopt that issue. If not,
  create it, add it to Project #3 and set the fields, then mark `published`.
  A crash between the two steps is repaired by the marker search.
- Open issue and new occurrences: at most one comment per day, for example
  "3 new occurrences since 2026-11-10; latest ItemId `<id>` at `<time>`".
- Closed issue and a new occurrence: create a new issue whose Context says
  "Regression of #N", and point the signal at the new issue.
- Limits: at most 5 new issues per cycle and `maxNewIssuesPerDay` (20) per
  day. Signals over the limit stay `deferred` and are reported in the daemon
  event.
- `mode: dry_run` performs the intake and logs the issues it would create or
  comment on, with no GitHub writes. `mode: off` skips the step.
- Writes use the existing clients: `issue-mutate.ts` for issues and comments,
  `project-sync.ts` for the Project #3 item and fields.

Project #3 changes:

- Add the `Triage` option to the `Status` field (one-time, through the GitHub
  API or UI).
- Add `"Triage"` to `Status` in `GITHUB_PROJECT_FIELD_OPTIONS`
  (`orchestrator/src/github/project-sync.ts`). It must stay out of
  `EXECUTABLE_STATUS`.

### Issue format

The repository is public. The issue contains locators and code locations
only, never exception messages or source lines. The body must parse through
`github-queue-sync.ts` into a Task: `## Goal`, `## Implementation scope`,
`## Acceptance criteria` with `- [ ]` items, plus Priority and Risk.

```markdown
Title: [prod-error] AllegroBusinessError in common/allegro.py:create_ship_with_allegro_shipment

<!-- pirx-error-signal:e3b0c44298fc1c14 -->

## Goal
Find and fix the cause of `AllegroBusinessError` raised in production by
`zdrovena-api-prod`, or show that it is not a code defect.

## Context
Signature: `e3b0c44298fc1c14` (role + type + frames below)
Occurrences: 2 · first 2026-09-15 08:27 UTC · last 2026-10-26 08:48 UTC

Code location (deepest 3 frames of our code):
- zdrovena/common/allegro.py:359 `_request`
- zdrovena/common/allegro.py:377 `_post`
- zdrovena/common/allegro.py:640 `create_ship_with_allegro_shipment`

Locators (Log Analytics workspace `d1af17c0-c042-4cb1-870b-c94b6e950fff`,
table `AppExceptions`):
| TimeGenerated (UTC) | ItemId | OperationId |
|---|---|---|
| 2026-10-26T08:48:39.962Z | 0a06dcd5-d11a-11f1-a04b-7c1e526c4930 | 597656160853e0e03e4951ffebc4a4aa |

The exception message and stack text are not copied here (public
repository). The worker reads them with
`mcp__pirx_advisor__read_error_occurrences`.

## Implementation scope
- Read the occurrences with read_error_occurrences and confirm they match this issue.
- Reproduce with a test using fake providers and synthetic data, then fix the cause.
- If the cause is external (provider outage, credentials, network), make no code change; return BLOCKED with the evidence.

## Acceptance criteria
- [ ] The log entries were read and match the signature above.
- [ ] A regression test fails before the fix and passes after it.
- [ ] Required checks pass.
```

Rules:

- The title names the outermost of the 3 fingerprint frames (the
  third-deepest of our code), because the deepest is often a shared helper.
- Frames show `file:line function` only, parsed from the `File` lines.
- The locator table lists at most the 10 latest occurrences.
- Label `prod-error`. Project fields: `Status=Triage`, `Work Type=Bug`,
  `Worker=Pirx`, `Priority=P2`, `Risk=Prod-sensitive`.
- The operator may edit Goal and Scope before moving the issue to `Todo`.

### [5] Worker access: read_error_occurrences

A new tool on the existing `pirx_advisor` MCP server, added to the worker's
allowed tools next to `mcp__pirx_advisor__ask_pirx`.

- Input: none. The server is already bound to the Task and Attempt.
- Lookup: Task → `githubReference` → `runtime_error_signals.issue_number` →
  the latest 20 `ItemId`s from `runtime_error_occurrences`. The `ItemId`s come
  from Pirx's own records, never from the editable issue text. A Task without
  a linked signal gets `not_found`.
- Query, live from Log Analytics, with the same token mechanism as [1]:
  - `AppExceptions | where _ItemId in (...)` limited to first seen − 1 hour
    through last seen + 1 hour.
  - For each non-zero `OperationId`: `AppTraces` and `AppDependencies` of that
    operation, at most 50 rows each.
- Returns per occurrence: `TimeGenerated`, `ItemId`, `OperationId`, role,
  type, `OuterMessage`, `InnermostMessage`, full `rawStack`, related traces
  and dependencies, and the fingerprint recomputed from this row. A mismatch
  with the issue's signature shows the worker that Pirx grouped it wrongly.
- Redaction before returning: emails → `[email]`, phone numbers → `[phone]`,
  IBAN and bank account numbers → `[iban]`, Polish postal codes
  (`\b\d{2}-\d{3}\b`) → `[postcode]`. Mark it in code with
  `ponytail: regex redaction covers common formats only`.
- Limits: response at most 64 KB (truncate traces first, then occurrences
  beyond the latest 5), at most 10 calls per Attempt.
- The advisor process runs on the host and must inherit `PATH` and `HOME` so
  `az` works. The worker never receives a token.
- If the log cannot be read, the tool returns
  `{ outcome: "unavailable", reason }`.

Worker prompt additions in `production-worker.ts`, for every Task:

- Never copy log messages, trace text or customer data into commits, pull
  request text, comments or code. Refer to an `ItemId` instead.
- Regression tests use synthetic data, never values from a log entry.
- If `read_error_occurrences` reports `unavailable`, return `FAILED` with its
  reason. The normal resume path retries it.

## Configuration

New optional block in `~/.config/pirx/orchestrator.json`, validated in
`headless-config.ts`. The repository must already be in `repositories`.

```json
"errorIntake": {
  "mode": "dry_run",
  "repository": "PiotrGry/zdrovena-reconciliation",
  "workspaceId": "d1af17c0-c042-4cb1-870b-c94b6e950fff",
  "roles": ["zdrovena-api-prod", "zdrovena-allegro-poller"],
  "intervalMs": 900000,
  "initialLookbackDays": 30,
  "maxNewIssuesPerDay": 20
}
```

## Failure handling

| Situation | Behavior |
|---|---|
| `az` login missing or expired | Event `error_intake` with outcome `credentials_unavailable`, shown in `pirx_orchestrator_status`. The cursor does not move, so nothing is lost after `az login`. |
| Query timeout or HTTP error | Retry on the next interval. The cursor does not move. |
| Same window read twice | Unique `ItemId`; no duplicates. |
| GitHub fails during creation | `pending_issue` plus marker search on retry; no duplicate issues. |
| Burst of errors | 5 new issues per cycle, 20 per day, 1 comment per issue per day. The rest is `deferred` and reported. |
| SQLite lost | Signals are rebuilt from GitHub issues with the `prod-error` label and the marker. |
| Worker cannot read the log | Worker returns `FAILED`; normal resume, then escalation. |

## Rollout

1. Implement with `mode: dry_run`, deploy, and run against the real
   workspace. The operator reviews the would-be issues for the 15 existing
   exceptions, especially signatures and grouping.
2. Add the `Triage` status to Project #3.
3. Switch to `mode: publish`.

## Testing

- `fingerprint()`: synthetic `rawStack`s with `site-packages/zdrovena/` paths,
  stacks without frames of our code, and the same stack with shifted line
  numbers. Same call site gives the same fingerprint; a different call site
  gives a different one.
- Redaction: one case per pattern, and a stack without data that stays
  unchanged.
- Intake cycle with a fake source and a fake GitHub:
  - a new signature creates an issue in `Triage`;
  - repeats produce at most one comment per day;
  - a closed issue plus a new occurrence creates a regression issue;
  - re-reading the same window changes nothing;
  - the burst limits hold and the excess is `deferred`;
  - `credentials_unavailable` leaves the cursor unchanged;
  - `dry_run` makes no GitHub writes;
  - a crash after creation and before `published` adopts the issue by marker.
- Round trip: a generated issue body parses through `github-queue-sync.ts`
  into a valid Task plan.
- Advisor tool:
  - a Task without a signal gets `not_found`;
  - only `ItemId`s linked to the Task's issue are queried;
  - redaction is applied;
  - the 64 KB and 10-call limits hold;
  - the recomputed fingerprint is returned.
- Live: one manual `dry_run` cycle against the real workspace before
  `publish`.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Who starts the worker | The operator, by moving the issue to `Todo` | Merges and deploys have no other human gate. |
| Detection | The Pirx daemon pulls from Log Analytics | No Azure infra change and no GitHub token in Azure; dedup lives with the rest of Pirx's state. |
| Credentials | The operator's `az` login | Already present. An expired login stops intake visibly and loses nothing. Switch to a service principal if the 90-day inactivity expiry becomes a problem. |
| Grouping key | Role + type + 3 deepest frames of our code | `ProblemId` merges unrelated errors; one frame is often a shared helper. |
| Initial lookback | 30 days | Gives the first issues and the first data for sub-project B. |
| Log data sent to Claude | Redacted messages, stacks and traces | Enough to diagnose code defects; common personal data formats removed. |
