# Pirx control-center refactor: plan and tasks

Tracking epic: PiotrGry/ai-assistant#338. Written 2026-11-19. Each task below is sized for one Claude Code session.

## What Pirx is

Pirx is the operator's local assistant: a chat application backed by a local model (today Qwen 27B on Ollama; the model is swappable). It has three jobs:

1. Calendar.
2. Notes.
3. Coordinating the development of the operator's application (today zdrovena-reconciliation).

In the third job **the local model is the coordinator**. It decides what to work on, writes the task for the worker, reads the result, reacts to CI and delivery, and closes the task. It asks the operator only when it cannot decide. The worker (Claude Code, Opus) writes code and nothing else.

Everything that is not the model is a **tool the model calls**. Tools are thin: one job each, facts in, facts out. There is no daemon that owns decisions.

This is an experiment in how well a local model coordinates. Every decision must be recorded with the facts the model saw and the reason it gave.

## What went wrong

The original epics said "Pirx is the control plane" and "Pirx decides". Implementation read "Pirx" as the daemon code. `PRODUCT.md` (2026-11-06) then stated the opposite of the intent: "The chat is a control surface, not the execution owner. The daemon owns Task, Attempt, Lease, retry, checkpoint and delivery transitions."

The result, measured on 2026-11-19:

| Measure | Value |
|---|---|
| Orchestrator source | 21,269 lines, plus 14,127 lines of tests |
| SQLite tables | 38 (9 empty) |
| Places that return a failure or conflict | 656 |
| Distinct `outcome` values | 84, plus 31 worker failure codes |
| Manual interventions | about one per delivered Task |

The daemon keeps its own copy of facts that git and GitHub already hold. Each failure of that day was a copy that no longer matched reality (`commit_mismatch`, `binding_mismatch`, `base_behind`).

## Principles

1. **The model decides. Tools execute.** No "if X then Y" outside a tool's own safety limits.
2. **git and GitHub are the truth.** Read them live. Do not store copies of PR, CI, merge or queue state.
3. **Local state is only what exists nowhere else:** the Task's worktree and worker session id, a single-worker lock, and the journal.
4. **Safety lives in tools, not in the prompt.** The local model ignored prompt-only rules twice on 2026-11-19.
5. **Tool results say plainly what happened,** including "nothing found" and "already done". Errors carry the raw message and one hint. Nothing is truncated to a fixed length.
6. **Everything is journaled.**
7. **No size limits below GitHub's own.**

### Hard limits (inside tools; the model cannot change them)

- One worker at a time.
- Only allowlisted repositories.
- Only `pirx/*` branches; no force push.
- No merge on red checks.
- A cap on worker starts per Task per day, and on CI reruns per run.
- The worker runs in the existing sandbox (worktree only, no credentials).
- A stop switch: one command or file that makes every mutating tool refuse.

## Storage

One database, `~/.local/share/pirx/pirx.sqlite` (the chat database), with three new tables:

| Table | Holds |
|---|---|
| `tasks` | repository, Issue number, branch, worktree path, worker session id, created/updated |
| `journal` | sequence, time, Task (optional), trigger event, facts given to the model, decision, reason, tool calls with inputs and results, operator verdict (optional) |
| `lock` | the running worker: Task, pid, started |

The old `runtime.sqlite` is archived as a file. No data migration.

## Communication

| Path | Design |
|---|---|
| Operator ↔ Pirx | The chat (TUI). Chat and tick share the model, the tools and the journal. |
| Pirx → operator | `ask_operator`: the question goes to the journal and shows in the chat. There is no notification outside the chat for now. |
| Pirx → Opus | `ask_opus`: when the local model cannot resolve an anomaly, it asks Opus for a second opinion first. It asks the operator only if Opus cannot settle it either. |
| Pirx → worker | Pirx writes the worker's instruction itself (Issue plus its own notes). |
| Worker → Pirx | A short free-text report. Pirx verifies it against git, it does not trust a result code. `ask_pirx` stays. |
| World → Pirx | A small watcher wakes a tick on an event: worker exited, CI finished, new queued Issue, timer. It decides nothing. |

## Logs and diagnostics

- **Journal:** one entry per tick. No entries for "nothing happened".
- **Model session logs:** kept; move to `~/.local/share/pirx/logs/` so they do not live inside a runtime version directory.
- **Worker logs:** unchanged (`worker-logs/<task>/`).
- **`pirx_explain`:** the timeline of one Task from the journal, for the operator and the chat.
- **Experiment metrics, computed from the journal:** decisions made alone, decisions made after `ask_opus`, questions to the operator, decisions the operator reversed, time and tokens per tick.
- **Bad-decision marking:** the operator marks a journal entry as wrong; it joins the eval set. A new model runs the same set.
- **GPU:** a tick unloads the model when it ends (`keep_alive: 0`).

## Tools

### Remove (with the daemon)

`pirx_orchestrator_*` (start, status, diagnostic, control, shutdown, logs), `pirx_work_submit`, `pirx_work_status`, `pirx_task_unblock`, `pirx_task_history`, `pirx_operator_questions`, `pirx_operator_decision`, `pirx_execution_report`, `github_issue_round_trip_poc`, `github_shipment_round_trip_poc`, `github_failed_ci_codex_handoff_poc`, `github_shipment_cycle`, `github_actions_watch`, `hello`.

### Keep and fix

- `github_issue_*` (get, list, search, create, update, comment, close, reopen): add a label filter and linked PRs to list results; an empty search says "no matching Issues"; errors explain the cause.
- `zdrovena_production_errors`, `zdrovena_code_health`: rename to `app_*`, configured per application.
- `ask_pirx`, `pirx_agent_conversation`, `system_info`, `pirx_resource_report`: unchanged.
- Calendar and Obsidian tools: unchanged, out of scope.

### Add

| Tool | Job | Limit inside the tool |
|---|---|---|
| `queue_list` | Project items with fields and order | read-only |
| `queue_set` | Set an item's Worker, Status, order | allowlisted repositories |
| `task_facts` | Issue, PR, checks, worktree `git log` and `git status`, last worker report | read-only |
| `worker_start` | Run the worker in a new worktree with Pirx's instruction | one worker; start cap |
| `worker_resume` | Resume the worker session with a new instruction | same |
| `worker_status` | Running or not, since when, log tail | read-only |
| `task_ship` | Push the branch and open the PR | `pirx/*` only; no force push |
| `pr_list` | Recent PRs and the Issues they close | read-only |
| `ci_status` | Checks and runs for a commit or PR, with the failing log tail | read-only |
| `ci_rerun` | Rerun failed jobs | rerun cap |
| `pr_update_branch` | Merge the base into a PR that is behind it (on GitHub; no rebase, no force) | `pirx/*` branches only |
| `issue_list`, `issue_create`, `issue_comment` | Thin Issue tools on `gh`, in place of the old `github_issue_*` (labels, closing PRs, explicit empty result) | allowlisted repositories |
| `journal_verdict` | Record the operator's verdict on a journal entry; `wrong` entries join the eval set | none |
| `task_adopt_commit` | Take the worker's commit as the Task's current state | commit must be on the Task branch |
| `task_restart_clean` | New worktree from the current base | the old one is archived, not deleted |
| `task_park` | Set a Task aside with a reason | none |
| `task_close` | Close the Issue with evidence; remove branch and worktree | change must be on the target branch |
| `ask_opus` | Second opinion from Opus on an anomaly: Pirx sends the facts and its own view, and gets advice back. Opus advises; Pirx still decides and acts. | read-only for Opus (no tools that change anything); a cap on calls per Task per day |
| `ask_operator` | Question for the operator, used after `ask_opus` did not settle it | none |
| `journal_read`, `journal_note` | Pirx's memory between ticks | none |
| `pirx_explain` | Timeline of one Task | read-only |

Not now: `pr_merge` (zdrovena merges by itself), `notify_operator` (the operator decided on 2026-11-19 to have no notifications outside the chat for now).

**Tool budget:** a coordination tick sees about 20 tools; the personal chat sees calendar and notes. Cut the existing profiles accordingly.

## Tasks

The old daemon keeps serving zdrovena until T9. Do not add decision logic to it. Fix it only if it loses data or does something unsafe.

### T1. Rewrite the product contract

- **Goal:** `PRODUCT.md`, the root `README.md` and `Pirx/README.md` state the model-as-coordinator design above. The "daemon owns" statements are removed.
- **Scope:** documents only.
- **Done when:** no document says the daemon owns decisions; the operator approved the text.

### T2. Journal, tasks and lock tables

- **Goal:** the three tables in `pirx.sqlite` with a small typed API, and `journal_read`, `journal_note`, `pirx_explain`.
- **Scope:** `agent/src/storage`, a new `tools` module in `mcp-server`. Every MCP tool call is journaled through one wrapper.
- **Done when:** a chat session's tool calls appear in the journal and `pirx_explain` prints them; tests cover write, read and restart.

### T3. Read-only fact tools

- **Goal:** `queue_list`, `task_facts`, `pr_list`, `ci_status`, `worker_status`, built on `git` and `gh` subprocess calls.
- **Scope:** `mcp-server`. Do not import from `@pirx/orchestrator`.
- **Done when:** each tool returns correct facts for zdrovena#539 and zdrovena#543 as they stand; results are explicit for the empty cases.

### T4. Worker tools

- **Goal:** `worker_start`, `worker_resume`, with the single-worker lock, the start cap and the sandbox.
- **Scope:** move the sandboxed Claude Code runner out of `orchestrator/src/claude/` into the new module; keep its sandbox behaviour and its tests. Drop the structured result contract; the worker returns a text report.
- **Done when:** a worker started from the chat commits in its worktree, cannot push, and a second start is refused while it runs; quota exhaustion is reported with the reset time.

### T5. Action tools

- **Goal:** `task_ship`, `ci_rerun`, `task_adopt_commit`, `task_restart_clean`, `task_park`, `task_close`, `queue_set`, `ask_opus`, `ask_operator`, each with its hard limit and the stop switch.
- **Done when:** each limit has a test that proves the tool refuses; each tool works by hand from the chat on a scratch Issue.

### T6. The tick

- **Goal:** `pirx tick`: load the event and the facts, give the model the coordination toolset, journal the decision, unload the model. A watcher (systemd timer plus worker-exit and CI polling) triggers it.
- **Scope:** `agent`, reusing `--once`. Replaces `scripts/round.sh`.
- **Done when:** a tick on an idle system does nothing and says so in one journal entry; a tick after a worker exit reads the facts and acts.

### T7. Evals

- **Goal:** replayable cases with a pass rule each, run N times against a model:
  - worker committed, then the quota ran out (zdrovena#539): adopt the commit and resume;
  - transient CI failure (zdrovena#543, TLS timeout in `pip-audit`): rerun, do not start the worker;
  - PR behind its base: update the branch;
  - open `pirx-round` Issue exists: do not dispatch another;
  - an Issue that is already fixed by a merged PR: close or skip, do not dispatch.
- **Each case records** whether the model decided alone or used `ask_opus`. Both count as a pass; the split is reported.
- **Done when:** `pnpm eval` prints a pass rate per case for the configured model; results are stored with model name and date.
- **Gate for T8:** all five cases pass (5/5), in every one of the N runs.

### T8. Shadow run

- **Goal:** for several real Tasks the tick runs with mutating tools in dry-run mode while the old daemon does the work. Compare the journal with what the daemon did.
- **Done when:** a short report lists agreements, disagreements and which side was right.

### T9. Switch over

- **Goal:** stop the old daemon; the tick delivers three real zdrovena Tasks end to end.
- **Done when:** three Tasks are delivered with no manual repair. The old unit file is kept for rollback until then.

### T10. Delete the old orchestrator

- **Goal:** remove `Pirx/orchestrator`, its tests, the removed tools, `runtime-communication.md`, `headless-orchestrator.md` and the old systemd unit. Archive `runtime.sqlite`.
- **Done when:** the build and tests pass without the package; the line count is reported against 21,269.

### Order and dependencies

T1 first. T2 before every tool task. T3, T4, T5 can run in that order or T3 in parallel with T4. T6 needs T2 to T5. T7 needs T6. T8 needs T7 at 5/5. T9, then T10.

## Status (2026-11-20)

| Task | State |
|---|---|
| T1 contract | Done (#350) |
| T2–T6 tools, journal, tick, watcher | Done (#351, #352) |
| T7 evals | Done. Gate passed: Qwen3.8 27B, every case 3/3, with no `ask_opus`; the tools refused 3 attempts (see below). |
| T8 shadow run | Running since 2026-11-20 02:26 CET: `pirx-watch.timer` every 5 min, dry-run, journal in `pirx-shadow.sqlite`. The old `pirx-round.timer` is disabled. |
| T9 switch-over | Not started; needs the operator (see below) |
| T10 delete old orchestrator | After T9 |

### What the evals taught (each fix went into a tool, not the prompt)

1. PR events named only the PR, so the model looked a PR up as a Task. The watcher now names the Task and the branch.
2. `keep_alive 0` reloaded the model for every call, so ticks took 5–6 min and model calls timed out. The model now stays loaded during a tick and is unloaded at its end; ticks take about 1 min.
3. With an empty queue, the model started work the operator had set to `Worker=Human`. `worker_start` and `worker_resume` now accept only Issues queued for Pirx.
4. Refused, it set the item back to `Worker=Pirx` itself. `queue_set` cannot take back a `Worker=Human` item.
5. Refused again, it created a new `pirx-round` Issue. `issue_create` now labels every Issue `pirx-round` and allows only one open at a time.

The pattern matches the hourly rounds of 2026-11-19: this model follows facts well, but not "do not" rules in a prompt. Every such rule must be a tool limit.

### First shadow tick on the real queue

| Task | Old daemon | Pirx (dry-run) |
|---|---|---|
| zdrovena#543 (label e-mail) | `blocked`: a transient `pip-audit` TLS timeout went to the worker, which could not fix it | `task_close`: PR #559 merged and on `main`; the tool verified it |
| zdrovena#539 (tests for `allegro_auth_cmd`) | `blocked`: `binding_mismatch` after the worker's commit `f0f534b` | `task_ship`: push `f0f534b` and open the PR; all tool checks passed |

The old daemon has been idle (`no_runnable_task`) since then.

### Before T9 (operator)

- Read a few hours of the shadow journal: `sqlite3 ~/.local/share/pirx/pirx-shadow.sqlite "select at, name, substr(output,1,300) from coord_journal where kind='tick'"`, or ask the chat (`pirx_explain`).
- Switch over:
  1. Stop `pirx-orchestrator`.
  2. Remove `PIRX_COORDINATION_DRY_RUN` and `PIRX_STORAGE_FILE` from `pirx-watch.service`.
  3. Restart the timer.
- Roll back by doing the reverse. `~/.config/pirx/STOP` halts every mutating tool at once.

## Implementation notes

- The coordination tools live in `mcp-server/src/coordination/` and are visible in the `coordination` tool profile (`PIRX_TOOL_PROFILE=coordination`). They use `git` and `gh` subprocesses and do not import `@pirx/orchestrator`.
- The repository allowlist, base branch, target branch, test and setup commands are read from the existing `~/.config/pirx/orchestrator.json`, so nothing is configured twice.
- Stop switch: the file `~/.config/pirx/STOP` (`PIRX_STOP_FILE`). Dry-run: `PIRX_COORDINATION_DRY_RUN=1`. Eval mode: `PIRX_COORDINATION_EVAL=<case.json>` (facts from the case file, mutating calls only recorded).
- The worker runs detached (`coordination/worker-run.js`) with the old sandbox profile and a persistent Claude session (`--session-id`, then `--resume`). Logs and reports are under `~/.local/share/pirx/coordination/worker-logs/`.
- Caps (environment): `PIRX_CAP_WORKER_STARTS` (3 per Task per day), `PIRX_CAP_CI_RERUNS` (2 per run), `PIRX_CAP_ASK_OPUS` (3 per Task per day).

## Operator decisions (2026-11-19)

1. **Notifications outside the chat:** none for now.
2. **Gate from T7 to T8:** 5/5 cases pass.
3. **When the local model cannot resolve an anomaly:** it asks Opus first (`ask_opus`), then the operator.
