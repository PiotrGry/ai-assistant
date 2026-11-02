# Chat execution and context policy

The daemon owns scheduling and durable execution. Chat reads its state and issues
explicit supported commands. `running` is a daemon state, not evidence that a
blocked Task is executing. Orchestrator status includes `attentionRequired` with
the queued failed/blocked Task, last Attempt and sanitized blocking reason.

## Shared startup configuration

Both `pnpm tui` and `pnpm start` initialize defaults from
`$XDG_CONFIG_HOME/pirx/chat.json` (normally `~/.config/pirx/chat.json`) before
creating the agent or MCP child. `PIRX_CHAT_CONFIG` selects an explicit file.
The JSON is a flat map of supported environment names to string values, e.g.:

```json
{
  "OLLAMA_NUM_CTX": "32768",
  "PIRX_ORCHESTRATOR_DATABASE": "/home/operator/.local/share/pirx/runtime.sqlite",
  "PIRX_ORCHESTRATOR_SERVICE_ENABLED": "true",
  "PIRX_GITHUB_OWNER": "owner",
  "PIRX_GITHUB_REPOSITORY": "repository"
}
```

Explicit environment variables override file defaults. Invalid settings fail
startup before any defaults are applied. Missing optional configuration keeps
existing behavior; a missing explicitly selected file is an error. Shell scripts,
PATH and credentials are not loaded from this file. The MCP child receives only
its existing environment allowlist. Editing the file requires restarting chat.

## Context

`OLLAMA_NUM_CTX` defaults to 32768. The workstation profile also sets it explicitly
so the runtime does not depend on local source edits. A longer window requires
more memory: verify the actually loaded `context_length` via Ollama `/api/ps`,
memory use and an ordinary tool conversation before increasing it again.

All model requests, including continuation, JSON recovery and finalization, go
through one context builder. It reserves output tokens and a safety margin,
uses a conservative initial character/token factor and increases that factor
per model using backend token counts. This is a conservative estimate, not an
exact tokenizer guarantee. `PIRX_CONTEXT_SAFETY_MARGIN_TOKENS` remains configurable.
If the backend reports input beyond the reserved budget, generated tools are not
executed: one recalibrated generation is allowed, then the turn fails explicitly.
Recorded context builds describe the actual selected request for every attempt.

Short confirmations retain their preceding substantive user request and proposed
action. If those references cannot fit, chat fails explicitly instead of sending
an isolated approval to the model. Host continuation/recovery instructions use
system messages and never replace the user's request in context selection.
Optional continuation applies to pending-action announcements, not ordinary
completed answers. Its failure cannot erase the answer already generated.

## Execution budgets and failures

- `PIRX_MAX_TOOL_CALLS`: 8 requested operations per turn, including invalid inputs.
- `PIRX_MAX_TOOL_ITERATIONS`: 8 model/tool rounds, independent of the call budget.
- `PIRX_MAX_TURN_DURATION_MS`: 180000; no new operation starts after the deadline.
  Model calls use the remaining time. An already-started MCP operation is allowed
  to complete under its own timeout; a timeout is not a rollback of external work.
- `PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS`: 24000; individual results are bounded
  by both the remaining allowance and `PIRX_MAX_TOOL_RESULT_CHARACTERS`.

Malformed JSON, arrays and non-object arguments are rejected before MCP and the
mutation ledger. They are never replaced by `{}`. Schema validation remains
authoritative in MCP even where the Ollama-facing schema omits regex grammars.

A backend or recording failure after tool execution preserves results and marks
the turn `partial_turn_error`. Missing results for interrupted call batches are
explicitly unknown. Earlier mutations must be reconciled rather than blindly
repeated. A failure before any tool activity may roll back the unexecuted turn.

The backend's malformed-argument error permits one generation repair per turn.
It does not replay completed MCP operations. Text that imitates a tool call is
never executed as code.

## Retry contract

`buildResumeContext` prepares a successor before it exists.
`buildAssignedResumeContext` reads a context for an already-created, running
successor and verifies its predecessor, explicit checkpoint reference, latest
history and checkpoint workspace. They intentionally have different invariants.
Production Claude uses the assigned path; it never creates another Attempt.
When an early process failure produced a checkpoint without workspace evidence,
the assigned successor's current commit is read from matching durable workspace
ownership. It is never guessed or written back into the historical checkpoint.
Existing terminal blocked Attempts are not rewritten by deploying a fix.
