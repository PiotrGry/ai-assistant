# `@pirx/orchestrator`

This package is the bounded GitHub API boundary for Pirx M1. It keeps
authentication at the transport boundary, returns sanitized typed outcomes,
and prevents business logic from using a raw HTTP or GraphQL client.

## Configuration

`loadGitHubConfig()` validates the repository settings before the first request
and obtains the credential with `gh auth token`:

- run `gh auth login` first; set `GH_CONFIG_DIR` only when using a non-default
  GitHub CLI profile,
- `PIRX_GITHUB_OWNER`
- `PIRX_GITHUB_REPOSITORY`
- optional `PIRX_GITHUB_API_URL` (defaults to `https://api.github.com`)
- optional `PIRX_GITHUB_TIMEOUT_MS` (defaults to `10000`)

Tokens and authorization headers are never copied into operation errors. The
transport makes one REST or GraphQL attempt and returns response status,
request ID, rate-limit counters, reset time, `Retry-After`, and parsing
warnings without exposing the raw response object.

## Outcomes and retries

Callers inspect `GitHubOperationResult<T>` rather than catching provider
objects. It distinguishes `success`, `rate_limited`, `retryable_error`,
`permanent_error`, and `unknown`. A mutation timeout, lost connection, or
queue execution exception is `unknown` because GitHub may have accepted it.

`executeWithGitHubRetry()` is the only retry policy. It uses bounded defaults
of three attempts, 30 seconds total delay, 500 ms exponential backoff capped
at 10 seconds, and 20% jitter. Inject `now`, `sleep`, and `random` in tests.
Reads may retry within those bounds. Writes require `idempotent: true` and a
result proving that the remote mutation was not accepted; `unknown` writes
are never retried.

## Mutation queue

`GitHubWriteQueue` is an in-process FIFO with one mutation in flight. Each
operation supplies an operation kind, stable idempotency key, target, timeout,
and execution closure. The queue rejects overflow and shutdown explicitly,
coalesces active/completed duplicate keys, and supports `drain()` and
`close({ drain: true })`. It is intentionally not durable; SQLite persistence
and operation-specific reconciliation belong to later work.

Later Issue and Project clients should expose focused domain methods and use
`GitHubTransport.restRead()` / `graphqlRead()` for reads and the queue plus a
write transport method for mutations. They must not expose an unrestricted
GitHub executor to workers.

## Issue mutations and lifecycle comments

`GitHubIssueMutator` is the focused write surface for Issues. It exposes
`createIssue`, `updateIssue`, `closeIssue`, `reopenIssue`, and
`publishLifecycleComment`. Every write contains a stable idempotency key,
correlation ID, target identity, bounded timeout, and an explicit patch. The
allowed update fields are `title`, `body`, `state`, `labels`, `assignees`,
and `milestone`; omitted fields remain unchanged, while an empty array, empty
body, `null` body, or `none` milestone is an explicit value/removal.

Updates read the canonical Issue before enqueueing a write. An `expected`
state/version mismatch returns `conflict`, and a patch that already matches
the remote Issue returns `success` with `noOp: true` without writing. Accepted
writes are read back by Issue number. An uncertain write is never retried
blindly; replaying the same logical command reconciles the target and returns
a no-op when the desired state is already present.

Lifecycle comments use this envelope: event ID/type, Task ID, optional Attempt
ID, ISO timestamp, sanitized summary, and optional branch/commit. A hidden
operation marker is stored in the comment and is used for deduplication; the
comment is presentation evidence only and is not runtime state.

## GitHub Issue lifecycle round-trip POC

The opt-in POC performs read → lifecycle comment mutation → read verification
and repeats the same logical comment operation. A successful result includes
the canonical Issue ID/number, comment ID, correlation ID, verification state,
and `replayNoOp: true`. It never prints tokens or raw worker output.

Run it only against a dedicated controlled Issue:

```sh
export PIRX_GITHUB_OWNER=PiotrGry
export PIRX_GITHUB_REPOSITORY=ai-assistant
export PIRX_GITHUB_PROJECT_OWNER=PiotrGry
export PIRX_GITHUB_PROJECT_NUMBER=3
export PIRX_GITHUB_ROUND_TRIP_ISSUE=123
export PIRX_GITHUB_ROUND_TRIP_EVENT_ID=manual-poc-2026-09-11
export PIRX_GITHUB_ROUND_TRIP_SUMMARY="Controlled Pirx round-trip marker."
pnpm github:round-trip
```

The command is deliberately not part of `pnpm check`; tests use fakes and do
not contact GitHub. The event ID should remain the same when manually
re-running the experiment to verify idempotency.

## Issue read client

`GitHubIssueReader` exposes only the Issue read surface needed by M1:

- `getIssue(number)` uses the REST Issue endpoint;
- `listIssues(filter, pageOptions)` uses bounded REST pagination and filters
  pull requests from the Issue collection;
- `searchIssues(filter, pageOptions)` uses a focused GraphQL `search` query
  requesting only Issue summary fields.

Results use `GitHubIssueSummary` and `GitHubIssuePage<T>`, never raw REST
payloads or GraphQL nodes. `pageSize` is limited to 100, `maxItems` defaults
to 100 and is capped at 1,000. Returned cursors are opaque and operation-
specific. A failed later page remains a normalized failure and includes the
failed cursor plus the number of items already read; it is never marked as a
complete page.

## GitHub Actions watch

`GitHubActionsGateway` is the read-only provider adapter for workflow runs and
jobs. `GitHubActionsWatcher` owns the bounded polling loop: the caller gives
either an exact workflow run ID or a pull request number plus its expected head
revision, and receives one normalized terminal result. A pull request head is
rejected when no run matches it or when more than one run matches it. The
watcher bounds timeout, polling, provider retries, and failed job/step evidence
and maps rate limits, missing data, ambiguity, provider errors, cancellation,
and timeout explicitly. The MCP surface is `github_actions_watch`; the model
does not issue one GitHub call per poll.

## Local Claude Code structured round-trip POC

`ClaudeCodeCliRunner` is a bounded, read-only local POC. It starts the
configured `claude` executable directly with `shell: false`, an empty temporary
working directory, an allowlisted environment, no tools, no MCP tools, one
turn, and JSON Schema output. The runner generates a UUID request ID, sends
the literal `hello world` payload, validates the complete structured envelope,
and returns one of the documented normalized outcomes without exposing raw
stdout, stderr, environment values, or credentials.

The CLI is an explicitly manual smoke entry point and is not part of
`pnpm check`:

```sh
PIRX_CLAUDE_EXECUTABLE=claude pnpm claude:round-trip
```

It does not create or modify repositories, pull requests, workflows, tools,
worktrees, commits, deployments, or MCP sessions. The temporary working
directory is removed after every attempt.

## Runtime Task and Attempt domain

`runtime/task-domain.ts` contains the framework-free M2 domain boundary. A
Task keeps one opaque ID across execution retries; each retry creates the next
positive contiguous Attempt ordinal and never creates a second Task. Snapshots
use serialization version `1`, canonical UTC timestamps, frozen arrays/objects,
and validated opaque IDs.

Task states and allowed transitions are:

```text
ready       -> in_progress | blocked | cancelled
in_progress -> blocked | failed | completed | cancelled
blocked     -> ready | in_progress | cancelled
failed      -> ready | in_progress | cancelled
completed   -> terminal
cancelled   -> terminal
```

Attempts are `running` or `terminal`. A Task can have at most one running
Attempt. Terminal results are `CODE_PUSHED`, `BLOCKED`, `FAILED`,
`QUOTA_EXHAUSTED`, `CANCELLED`, and `UNKNOWN`; non-code-pushed results require
a bounded blocking reason, while `CODE_PUSHED` requires a branch and final commit.
`blocked`, `failed`, and `cancelled` Tasks require a blocking reason; other
states reject one. Task completion is explicit: it takes the Attempt ID, final
commit, and an evidence reference, plus the Task's Attempts, and succeeds only
when the referenced Attempt belongs to the Task, is terminal `CODE_PUSHED` with
the same final commit, and no Attempt is still running. The SQLite
`TaskRepository` re-checks that against stored Attempts and returns `conflict`
otherwise. `transitionTask`, `transitionAttempt`, `startInitialAttempt`
and `retryTask` are pure functions: callers provide the expected current state
and evaluation timestamp; no clock, persistence, provider, or network is read.

## Runtime SQLite storage

`RuntimeSqliteStore` uses Node.js 22+ `node:sqlite`, which avoids an ORM and
native npm addon build while matching the workspace runtime. The trade-off is
that the POC requires the Node runtime's built-in SQLite API; a future support
matrix can replace this boundary with a maintained addon without changing the
repositories.

The store uses the configured `PIRX_STORAGE_FILE`, or
`$XDG_DATA_HOME/pirx/pirx.sqlite` (falling back to
`~/.local/share/pirx/pirx.sqlite`). It enables foreign keys, WAL,
`synchronous=FULL`, and a finite 5-second busy timeout by default. SQLite
files and WAL/journal sidecars are ignored by Git. Runtime tables use their
own `runtime_schema_migrations` table so the same local database can coexist
with the agent's existing storage tables.

Migration inventory:

1. `runtime_schema_migrations`, normalized `runtime_tasks` and
   `runtime_attempts` tables, JSON checks for only collection/evidence fields,
   foreign-key linkage, task/ordinal uniqueness, and state/result checks.
2. At-most-one-running-Attempt partial uniqueness plus task/state/ordinal
   indexes.
3. Canonical Task-to-Issue links and durable lifecycle projections.
4. Authenticated GitHub webhook deliveries and pending synchronization
   intents, keyed by delivery ID and retained without storing raw payloads.
5. Attempt progress and test-summary evidence columns, with immutable Attempt
   identity and compare-and-set updates for terminal transitions.
6. Immutable Checkpoint payloads with Task/previous-Attempt foreign keys,
   deterministic creation sequence, serialized content, and SHA-256 integrity.
7. Resume predecessor links on Attempts, added with a forward-compatible
   nullable migration.

`RuntimeSqliteStore.transaction()` is the reusable `BEGIN IMMEDIATE` boundary;
successful work commits and typed failures roll back. `TaskRepository` and
`AttemptRepository` expose create/get/list/update compare-and-set operations,
returning `success`, `not_found`, `conflict`, `invalid_record`, or
`storage_error` without leaking SQLite exceptions into orchestration code.

## Runtime Attempt lifecycle recording

`RuntimeSqliteStore.startAttempt()` atomically reads the Task and its Attempt
history, chooses the first or next ordinal through the domain transition, moves
the Task to `in_progress`, and inserts the Attempt in one SQLite transaction.
The transaction rolls back if either write fails, so a retry cannot create an
orphan Attempt or advance the Task without its evidence.

`AttemptRepository.recordProgress()` records bounded progress, checkpoint,
branch/worktree, current commit, and test-summary fields with the Attempt's
expected `running` state and start timestamp. `currentByTask()` returns the
single active Attempt, while `listByTask()` returns the complete ordered
history. Mutable fields use compare-and-set predicates; Attempt identity,
Task ID, ordinal, worker, provider, and start time are immutable.

Terminal updates are explicit for every result (`CODE_PUSHED`, `BLOCKED`,
`FAILED`, `QUOTA_EXHAUSTED`, `CANCELLED`, and `UNKNOWN`). Repeating the exact
same terminal update is idempotent; a conflicting replay returns `conflict`.
`CODE_PUSHED` requires branch and final commit, but does not complete the Task
or claim CI evidence by itself. The durable lifecycle remains independent of
workers, Git resources, providers, and network calls.

## Runtime Checkpoint contract

`runtime/checkpoint.ts` defines version `1` of the provider-independent
Checkpoint boundary. A Checkpoint carries Task/previous-Attempt provenance,
trigger, canonical UTC creation time, goal/state, remaining work, normalized
changed files, findings, hypotheses, test summaries, evidence, blockers, the
last action, and the next resume instruction. Repository, branch, worktree,
and current commit are an all-or-none workspace group, so a checkpoint without
an established workspace can omit all four fields.

`createCheckpoint()` and `validateCheckpoint()` return a canonical frozen
object or field-level typed violations. They reject unsupported versions,
provider-specific secret-shaped fields, unsafe absolute/traversal paths,
conflicting duplicate evidence, malformed timestamps/IDs, missing resume
context, and bounded-size/count violations. File paths and evidence are
deduplicated while preserving order; the full conversation transcript is not
part of the schema. Serialization is bounded to 50,000 bytes, and the
current implementation deliberately rejects forward versions until an
explicit migration is added.

`CheckpointRepository.save()` validates before opening the write transaction,
then verifies the Task and previous Attempt relationship before inserting an
immutable payload. It is idempotent for an identical checkpoint ID and returns
`conflict` for different content. `get()`, `latestByTask()`, and
`listByTask()` verify schema, relationships, canonical serialized JSON, and
the SHA-256 content hash on every read. The repository is part of
`RuntimeSqliteStore.transaction()`, so a checkpoint can commit or roll back
with an Attempt transition; it never schedules a new Attempt itself.

## Runtime resume context

`buildResumeContext()` consumes the Task, its latest integrity-checked
Checkpoint, and the ordered Attempt history. It returns a bounded,
provider-independent context or one of the explicit outcomes `blocked`,
`human_action_required`, and `invalid_checkpoint`. Required resume material
is retained first (goal, remaining work, last action, tests, and resume
instruction); optional collections are deterministically trimmed and listed
in `truncatedFields` when the 12,000-byte context limit is reached.

`WorkspaceReferencePort` is the side-effect-free checker boundary for
repository, worktree, branch, and commit presence/currentness. Missing or
stale references produce a precise human-action result and never create an
Attempt. `startResumedAttempt()` rechecks the context inside a
`BEGIN IMMEDIATE` transaction, allocates a new ordinal, stores its
`predecessorAttemptId` and checkpoint reference, and updates the Task and
Attempt together. It never reopens the predecessor; a concurrent successor is
reported explicitly.

## Runtime Task Leases

SQLite schema version 9 stores durable `LeaseRecord` rows. Partial unique
indexes allow at most one active Lease for a Task and one active execution
Lease globally for the MVP worker. `LeaseRepository` exposes atomic acquire,
Attempt attachment, renew, release, uncertainty marking, recovery, and
inspection operations. Every ownership mutation checks the lease ID,
ownership token, and expected version; valid ownership uses the exclusive
expiry rule `now < expiresAt`, so equality is already expired.

Expired or uncertain Leases remain recorded and recoverable. They are never
stolen automatically: an explicit recovery records `expired` or `uncertain`
as the prior outcome before another Lease can be acquired. The repository
uses the surrounding SQLite transaction boundary, so failed composite work
rolls back ownership changes together with related runtime records.

## Runtime capability policy

`runtime/capabilities.ts` is the closed, provider-independent capability
boundary. The initial vocabulary is `repository.read`, `repository.write`,
`tests.run`, `git.commit`, `git.push_assigned_branch`, `ci.read`,
`ci.logs.read`, `application_logs.read`, `metrics.read`, and
`production.read`. Capability sets are validated, deduplicated, and sorted;
unknown values, wildcards, and implicit inheritance are denied.

`evaluateCapabilities()` compares normalized Task requirements with normalized
worker grants and returns stable reason codes plus sorted missing and sensitive
requirements. Push permission requires an assigned branch and matching scope.
CI and operational reads are sensitive and require an active approval bound to
the Task, capability, resource scope, approver, issuance/expiry interval, and
one-use/revocation state. Expired, used, revoked, wrong-Task, future-issued,
or cross-repository approvals never fall back to permission. Production is
read-only in this vocabulary; no deployment or arbitrary production mutation
capability exists.

`CapabilityEnforcementGate` is the invocation boundary for workers and tools.
It binds the grant to the exact Task and worker, requires a canonical
repository, branch, and worktree scope, evaluates the closed capability set
before the downstream closure, and writes a bounded sanitized allow/deny audit
decision. Denied decisions, invalid input, cancellation, evaluator failures,
and audit failures never call the downstream operation. Composite requests
require every capability; the helpers expose explicit worker-start and
mutating-tool actions. The gate never upgrades authority based on a downstream
result and does not record prompts, commands, tokens, or provider payloads.

## Runtime sensitive-resource safety policy

`runtime/safety-policy.ts` publishes the reviewed `SAFETY_POLICY_MATRIX` for
CI/CD, workflow, infrastructure, cost, deployment, application-log, metrics,
and production actions. Only explicit read actions represented by the
capability vocabulary reach `SafetyEnforcementGate`; they still require the
Task/workspace binding and any sensitive approval enforced by the capability
gate. Infrastructure, cost, deployment, workflow, and production mutations
have no capability and return `human_action_required` without invoking an
external client. Unknown, ambiguous, malformed, or missing-scope actions fail
closed.

`HumanActionRecord` is bounded and allowlisted: it contains only the Task,
normalized action, repository/branch/worktree scope, stable reason,
required capability/approval marker, and a fixed next instruction. It never
echoes command, prompt, credential, token, or provider payload data.

## Runtime Task-to-GitHub Issue linkage and lifecycle projection

Tasks may carry one canonical GitHub Issue identity: owner, repository, Issue
number, GraphQL node ID, and canonical HTTPS URL. SQLite stores the identity in
`runtime_task_issue_links` with one-to-one uniqueness and exposes both Issue-to-
Task and Task-to-Issue lookups. Older Task records without the node ID and URL
remain readable, but lifecycle publication requires the complete canonical
identity.

`GitHubLifecycleProjectionPublisher` accepts only these durable event types:
`task_accepted`, `attempt_started`, `attempt_result`, `branch_prepared`,
`code_pushed`, `blocked_human_action_required`, `retry_cooldown`, and
`task_completed`. Each event is stored in
`runtime_github_projections` before the existing read-safe lifecycle comment
mutator is called. Event IDs and `(Task, sequence)` are unique; replays are
idempotent, older sequences are marked `ignored`, and pending provider or
missing-link failures can be replayed after restart. GitHub failures never
roll back the runtime Task or Attempt, and only bounded, sanitized summaries,
branch names, commits, and correlation IDs reach the Issue comment boundary.

## GitHub Project metadata synchronization

`GitHubProjectSchemaResolver` resolves the configured user or organization
Project by owner and number, then caches the IDs for the supported fields:
`Status`, `Priority`, `Worker`, `Area`, `Risk`, `Work Type`, and numeric
`Queue Order`. Single-select options are mapped by their exact names; missing,
duplicate, renamed, or incorrectly typed fields/options return `schema_drift`
and invalidate the cache. `refresh()` performs an explicit bounded reload.

`GitHubProjectSynchronizer` reads the Project item for an Issue, adds it when
necessary, computes a desired-versus-observed diff, and submits only changed
fields through the shared serial write queue. Stable idempotency keys make
replays safe; an identical projection is `no_op`. A failed multi-field update
is re-read and returned as `partial` with the fields already changed and still
pending. Rate limits, uncertain mutations, missing items, invalid mappings,
and provider failures remain explicit outcomes. The synchronizer does not
store runtime Attempts, leases, checkpoints, or execution history in Project
fields.

## GitHub webhook intake and reconciliation

`GitHubWebhookHandler` is a framework-neutral boundary for a raw request. It
checks the configured out-of-repository secret against the exact request bytes
with `x-hub-signature-256` before parsing JSON, enforces a byte limit, and
returns explicit missing-header, signature, size, JSON, payload, and storage
outcomes. Supported events are `issues`, `issue_dependencies`,
`projects_v2_item`, `projects_v2`, `projects_v2_field`, `repository`,
`installation`, and `installation_repositories`, each with a bounded action
matrix exported as `GITHUB_WEBHOOK_EVENT_ACTIONS`. Unsupported events are
acknowledged as durable `ignored` deliveries.

Accepted deliveries and normalized Issue, relationship, Project, or repository
intents are committed together in `runtime_webhook_deliveries` and
`runtime_sync_intents`. Delivery IDs are idempotent; reusing one with a
different digest is a conflict. The handler stores only bounded identity,
action, timestamp, and SHA-256 digest data, never the raw payload or secret.

`GitHubWebhookReconciliationService` exposes startup replay,
Issue/Project-targeted reconciliation, and an `afterUnknownWrite` entry point.
It asks an adapter to read current remote state and converge through the
existing idempotent clients; webhook payloads are hints, so out-of-order
events cannot regress state. Successful or no-op convergence marks an intent
reconciled, while provider, rate-limit, and unknown outcomes leave it pending.
