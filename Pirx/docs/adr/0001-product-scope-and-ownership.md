# ADR 0001: Product scope and execution ownership

- Status: accepted
- Date: 2026-11-06

## Context

Pirx contains both a local assistant and an autonomous engineering runtime.
Treating them as equal execution owners would duplicate state, authorization
and retry logic. Replacing the TUI with a generic agent shell would also discard
the local operational surface the product is intended to grow.

## Decision

Engineering orchestration is the primary product scenario. The conversational
agent and TUI are control and presentation surfaces. The headless daemon is the
only owner of Task, Attempt, Lease, checkpoint, worker invocation, retry and
delivery transitions.

The personal assistant remains a secondary opt-in profile in the same product,
with separate Calendar/Obsidian tools and no scheduler authority. The custom
TUI remains active. OpenCode is out of scope. n8n may be evaluated only as an
optional external experiment and cannot become a second runtime source of
truth.

## State and authorization boundaries

| Concern | Owner | Boundary |
| --- | --- | --- |
| Conversation and confirmation | chat agent | may request exact authorized operations; does not execute Tasks |
| Planning projection | GitHub | human-visible Issue/Project metadata; not runtime truth |
| Execution state | daemon + runtime SQLite | sole writer of Task/Attempt/Lease/checkpoint/delivery transitions |
| Worker code change | Claude Code CLI | one assigned worktree/branch and explicit capabilities |
| Advice | `ask_pirx` Advisor | read-only guidance; no permission or lifecycle transition |
| Operator decision | durable question/response contract | exact question, answer operation and validity; daemon consumes once |
| Retry | daemon scheduler | new Attempt for the same Task, never a new logical Task |
| Completion | daemon delivery policy | exact persisted evidence, not a chat statement or `CODE_PUSHED` alone |

## Consequences

Chat can close immediately after a durable submission. Workers and daemon can
restart without reconstructing state from conversation history. New chat
features must use local MCP and runtime SQLite rather than calling worker
adapters directly. A future web/TUI control centre can consume the same bounded
read models without becoming another state owner.
