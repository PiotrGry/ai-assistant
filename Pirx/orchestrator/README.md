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
