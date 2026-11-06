# Durable chat and runtime communication

This contract defines local communication for engineering intake, runtime
events and operator decisions. It reuses MCP and runtime SQLite. It does not add
HTTP/SSE, a message broker, a second scheduler or a second Task model.

## Shared invariants

- Every command has a caller-supplied operation ID and exact host
  authorization. Authorization is single-use; idempotency is durable and
  separate.
- Runtime records are written before their notification event in the same
  transaction. An event refers to a durable entity or explicitly says that its
  detail is unavailable.
- Events use an append-only integer sequence. Consumers request `afterSequence`
  and receive a bounded page plus `nextSequence` and `complete`.
- Replaying a page does not duplicate a UI item because event identity is the
  sequence. A missing/pruned cursor returns `cursor_expired` with the earliest
  available sequence; storage/schema failures are explicit.
- Task and Attempt correlation is data, not text parsing. Events may carry
  bounded IDs and Issue number but never prompts, raw logs, secrets or paths.
- No connected chat is required. Closing chat changes no runtime state.

## Runtime event types

The first implementation should project existing durable transitions rather
than create competing events:

- `task.state_changed`;
- `attempt.state_changed`;
- `checkpoint.created`;
- `worker.availability_changed`;
- `ci.observed` and `delivery.state_changed`;
- `operator_question.opened`, `operator_question.answered`,
  `operator_question.expired`;
- `work_intake.accepted`, `work_intake.linked`, `work_intake.rejected`,
  `work_intake.uncertain`;
- `diagnostic.recorded` with a durable diagnostic sequence.

Failure visibility is atomic with its durable diagnostic reference. If detail
cannot be persisted, the event uses `detailUnavailable: true`; it never points
to a record that might appear later.

## Operator question and decision

`ask_pirx` remains advice requested by a worker. It cannot pause a Task, grant
permission or accept a human answer. A real operator question is a separate
durable record:

```text
OperatorQuestion
  id, taskId, sourceAttemptId, checkpointId
  kind, promptSummary, allowedAnswers
  state: open | answered | expired | cancelled
  openedAt, expiresAt?, version

OperatorDecision
  questionId, operationId, answer
  decidedBy, decidedAt, questionVersion
```

The daemon persists the question and a resumable Checkpoint, finishes the
source Attempt with a typed blocking result, and releases its Lease. It does
not keep a worker or Lease alive while waiting for a person. Chat polls events
or queries the question by ID. A response is accepted only when authorization
matches the exact question/version/answer and the question is still open.

The same operation ID and answer replay the existing decision. Another answer,
an expired question, a stale version or missing authorization is rejected.
Only the daemon consumes an accepted decision. It creates at most one successor
Attempt under the normal Queue and Lease rules. A crash after worker dispatch
uses existing invocation reconciliation; it never blindly creates another
Attempt.

## Asynchronous work intake

The authorized intake point is a local MCP command that writes a durable
`WorkIntake` before returning:

```text
WorkIntake
  id, operationId, repository, requestedIssue?, goal, acceptanceCriteria
  state: accepted | linking | linked | rejected | uncertain
  issueNumber?, taskId?, acceptedAt, updatedAt, version
```

`accepted` means only that Pirx durably owns the request. It is returned while
the daemon may be offline. It does not mean the Issue is in Queue, a Task is
runnable, a Lease exists or a worker started. Chat can close after receiving
the intake ID and later query it.

The daemon is the single consumer. It either reuses the exact requested Issue
or creates one through the centralized GitHub write queue, applies the reviewed
Project metadata, and lets normal Queue reconciliation create/link the runtime
Task. A remote timeout becomes `uncertain`; the same intake reconciles by
operation marker before another write. Duplicate operation IDs never create a
second intake, Issue or logical Task. A conflicting payload is rejected.

Manual Issue creation is not intake acceptance. An Issue becomes executable
only after reviewed metadata and Queue order exist. Worker selection still
requires Queue eligibility, capabilities, cooldown, an exclusive Lease and a
persisted Attempt.

## Required acceptance fixtures

The cross-process suite should prove:

1. chat submits intake and receives its ID before any worker starts;
2. daemon is stopped, chat restarts, and the same intake is still queryable;
3. daemon links exactly one Issue and Task, then normal scheduling creates one
   leased Attempt;
4. a worker opens an operator question, exits, and both daemon and chat restart;
5. an exact authorized answer is accepted once and a conflicting replay fails;
6. daemon creates at most one successor Attempt and reconciles an uncertain
   invocation;
7. event polling resumes from a stable cursor without duplicate presentation;
8. no prompt, raw provider payload, secret or filesystem path crosses the
   communication boundary.
