# Pirx product scope

Pirx is a local engineering orchestrator controlled through a conversational
interface. Its primary product loop is:

1. a human defines or approves work in chat and GitHub;
2. Pirx records durable intent and state;
3. the headless daemon selects only refined Queue work;
4. a capability-bounded worker executes one leased Attempt;
5. Pirx observes CI and delivery, persists evidence, and reports the result;
6. ambiguous or sensitive decisions return to the human.

The chat is a control surface, not the execution owner. The daemon owns Task,
Attempt, Lease, retry, checkpoint and delivery transitions. GitHub is the
human-visible planning projection. Runtime SQLite is the machine source of
truth. Closing the chat or restarting a worker must not lose accepted work.

## Supported product scenarios

### Engineering orchestration (primary)

- inspect and submit bounded GitHub work;
- run one-machine, one-worker FIFO orchestration;
- invoke Claude Code CLI in an assigned worktree and branch;
- observe exact-SHA CI and route bounded evidence to a retry Attempt;
- merge an exact-green feature PR under configured policy;
- pause, resume, inspect and safely shut down the local runtime.

The daemon owns execution. Chat may submit an authorized intent, answer a
durable operator question, or request a control transition; it cannot directly
create an Attempt, acquire a Lease, select a worker or bypass Queue order.

### Local personal assistant (secondary, opt-in)

The `personal` profile exposes bounded Calendar and Obsidian operations. These
tools share the chat and authorization host but do not participate in the
engineering scheduler or runtime Task model. Missing private integrations must
not prevent engineering tools from starting.

## Current, experimental and excluded capabilities

Current capabilities are ordinary chat, bounded MCP tools, SQLite-backed
runtime state, GitHub Issue/Project/CI integration, Claude Code CLI workers,
checkpoints, Queue/Lease scheduling, diagnostics and guarded feature delivery.

Legacy round-trip, shipment and failure-handoff tools are controlled
experiments. They may prove a boundary but are not alternative production
schedulers. New production behavior belongs in the durable runtime path.

OpenCode and n8n are not part of the current product. Production deployment,
arbitrary infrastructure mutation, unrestricted shells and a distributed
multi-host scheduler remain out of scope. The custom TUI remains the intended
interactive surface; richer views can be added after their underlying durable
contracts exist.

## Completion and authority

A chat acknowledgement proves only that an intent was durably accepted. A
worker start requires Queue eligibility, an exclusive Lease and a persisted
Attempt. `CODE_PUSHED` proves a worker pushed its assigned branch; it does not
complete the Task. Completion requires the configured delivery evidence.

Every mutation is deny-by-default, bound to exact arguments and a single-use
host authorization. Replays use a separate durable idempotency identity.
Unknown remote outcomes are reconciled before any retry.
