# Pirx product scope

Pirx is the operator's local assistant. It is a chat application backed by a
local model: today Qwen 27B on Ollama, and the model is swappable. It has three
jobs:

1. calendar;
2. notes;
3. coordinating the development of the operator's application (today
   zdrovena-reconciliation).

## Who decides

In the third job **the local model is the coordinator**. It:

- decides what to work on, from production errors, bug reports, the backlog and
  code health;
- writes the instruction for the worker;
- reads the result and checks it against git;
- reacts to CI and delivery;
- closes the Task.

It asks Opus for a second opinion when it cannot resolve an anomaly, and the
operator only when that does not settle it.

The **worker** (Claude Code, Opus) writes code and nothing else.

Everything else is a **tool the model calls**. Tools are thin: one job each,
facts in, facts out. No daemon owns decisions. A small watcher wakes the model
when something happens (a worker exited, CI finished, new work was queued, or a
timer fired). The watcher decides nothing.

This is an experiment in how well a local model coordinates. Every decision is
journaled with the facts the model saw, the decision and the reason it gave.

## Sources of truth

- **git and GitHub are the truth** for Issues, Project fields, branches, PRs,
  checks and merges. Tools read them live and do not keep copies.
- **Local state** is only what exists nowhere else:
  - the Task's worktree and worker session id;
  - the single-worker lock;
  - the journal.

  It lives in `~/.local/share/pirx/pirx.sqlite`.

## Safety

Safety lives in the tools, not in the prompt. The model cannot change these
limits:

- one worker at a time;
- only allowlisted repositories;
- only `pirx/*` branches, and no force push;
- no merge on red checks;
- a cap on worker starts per Task per day, on CI reruns per run, and on
  `ask_opus` calls;
- the worker runs in a sandbox: its worktree only, no credentials, no push;
- a stop switch that makes every mutating tool refuse.

## Personal assistant

The `personal` profile exposes Calendar and Obsidian tools. It shares the chat
but not the coordination toolset.

## Out of scope

- Production deployment by Pirx: the application's own CD deploys.
- Arbitrary infrastructure changes, unrestricted shells, and more than one
  machine.

## Status

The old headless daemon (`Pirx/orchestrator`) still delivers Tasks until the
new coordination loop passes its evals and a supervised switch-over. The plan,
the tool list and the tasks are in
[`docs/control-center-refactor.md`](docs/control-center-refactor.md). Do not
add decision logic to the old daemon.
