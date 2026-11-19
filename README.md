# Pirx

Pirx is a local assistant: a chat backed by a local model (today Qwen 27B on Ollama). It keeps your calendar and notes, and it coordinates the development of your application. In that work **the local model is the coordinator**: it picks the work, writes the instruction for the worker, checks the result against git, reacts to CI and delivery, and closes the task. Claude Code (Opus) is the worker and only writes code. Everything else is a thin tool the model calls.

The product contract is [`Pirx/PRODUCT.md`](Pirx/PRODUCT.md). The move from the old daemon to this design is planned in [`Pirx/docs/control-center-refactor.md`](Pirx/docs/control-center-refactor.md).

The code lives in [`Pirx/`](Pirx).

## What works today (old daemon, until the switch-over)

- **Headless daemon** (`Pirx/orchestrator`). It runs one Task at a time, from a GitHub Project queue. Its state lives in SQLite, so a restart or a reboot loses no accepted work.
- **Claude Code worker.** It runs in a sandboxed worktree on an assigned branch, with bounded capabilities: read, write, tests, commit, and push of that branch only.
- **Usage limit.** On a real Claude limit, the Attempt ends as `QUOTA_EXHAUSTED`. The worker cools down until the reset time from Claude's message, then the Task resumes with a new Attempt.
- **Delivery.** Pirx opens or reuses the feature PR and waits for exact-SHA CI. When CI fails, it hands the failure evidence to a retry Attempt. It merges `develop` into a branch that has fallen behind.
- **Repositories that release on their own** (`delivery.postMerge`). Pirx ends the Task once the merged change passed the repository's own pipeline, then deletes the branch and worktree and closes the Issue. If that pipeline fails, the failure goes back to the worker on the same branch, at most twice.
- **Chat** (`Pirx/tui`, `Pirx/agent`). A local LLM via Ollama with MCP tools. It can submit work, show status, and pause or resume the daemon.

Experimental and out of scope: see [`Pirx/PRODUCT.md`](Pirx/PRODUCT.md). Codex workers and autonomous task discovery are planned, not built (milestones M3 and M5 to M7).

## Run one Task end to end

### 1. Prerequisites

- Node.js 22+, pnpm 11, git.
- [Claude Code](https://claude.com/claude-code), logged in: `claude` on `PATH`. On Linux, `bwrap` and `socat` are also needed for the worker sandbox.
- GitHub CLI, logged in with access to the target repository and the Project: `gh auth login`.
- A local clone of the target repository.

### 2. Build

```sh
cd Pirx
pnpm install --frozen-lockfile
pnpm build
```

### 3. Configure the daemon

Create `~/.config/pirx/orchestrator.json` with mode `0600`. The full schema and an example are in [`Pirx/orchestrator/docs/headless-orchestrator.md`](Pirx/orchestrator/docs/headless-orchestrator.md#configuration). The fields that matter most:

- `repositories[]`: the allowlist. Pirx never works anywhere else. Each entry has `repository` (`owner/name`), `repositoryRoot` (the local clone), `baseBranch` (for example `develop`), `remoteName` and `testCommands`.
- `baseRevision`: leave it out. New Task branches then start from the current `<remoteName>/<baseBranch>`.
- `delivery.postMerge`: set it when the repository merges and releases by itself. Pirx then watches that pipeline instead of opening its own Release.
- `githubProjectOwner` / `githubProjectNumber`: the Project that holds the queue.

No secrets go into this file. GitHub and Claude credentials stay in their CLIs.

Check the setup. This changes nothing and starts no worker:

```sh
PIRX_ORCHESTRATOR_CONFIG=~/.config/pirx/orchestrator.json pnpm orchestrator:run --check
```

### 4. Start the daemon

To try it, run in the foreground:

```sh
PIRX_ORCHESTRATOR_CONFIG=~/.config/pirx/orchestrator.json pnpm orchestrator:run
```

As a service, use the user unit [`Pirx/orchestrator/systemd/pirx-orchestrator.service`](Pirx/orchestrator/systemd/pirx-orchestrator.service). It expects this repository at `~/ai-assistant` and reads `~/.config/pirx/orchestrator.env`, which must set `PIRX_ORCHESTRATOR_CONFIG` and a `PATH` that contains `node`, `git`, `gh` and `claude`:

```sh
cp Pirx/orchestrator/systemd/pirx-orchestrator.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pirx-orchestrator
loginctl enable-linger "$USER"   # keep it running after logout
```

### 5. Submit a Task

Pirx executes only Issues that a human prepared for it.

1. Write the Issue in the target repository with these three sections. [zdrovena-reconciliation#515](https://github.com/PiotrGry/zdrovena-reconciliation/issues/515) is an example.
   ```markdown
   ## Goal
   ## Implementation scope
   ## Acceptance criteria
   - [ ] ...
   ```
2. Add it to the Project and set:
   - **Status** `Todo`
   - **Worker** `Pirx`
   - **Work Type** `Task`, `Bug` or `Experiment`
   - **Queue Order**: a positive number no other open Pirx item uses
   - **Priority** and **Risk**

   An item without Worker, Work Type or Queue Order is skipped silently. Active Pirx items with an invalid or duplicate Queue Order stop the whole queue.

On the next cycle (`cycleIntervalMs`, at least 30 s) the `queue` event reports `"created":1` and a worker Attempt starts.

### 6. Watch it

```sh
journalctl --user -u pirx-orchestrator -o cat -f
```

Each line is one JSON event: `queue`, `cycle` (worker Attempt), `delivery` (PR, CI, merge, pipeline). A finished Task ends with a `delivery` event whose outcome is `completed`. It says what passed, which branch was deleted, and which Issue was closed. How to read the journal: [headless-orchestrator.md](Pirx/orchestrator/docs/headless-orchestrator.md#reading-the-journal).

From the chat (`cd Pirx && PIRX_TOOL_PROFILE=operations pnpm tui`) you can ask for status, pause and resume.

## Where logs and state live

| What | Where |
| --- | --- |
| Daemon events | `journalctl --user -u pirx-orchestrator` |
| Runtime state (Tasks, Attempts, Leases, CI, delivery) | `databasePath` from `orchestrator.json`, e.g. `~/.local/share/pirx/runtime.sqlite` |
| Claude worker streams, per Attempt | `worker-logs/` next to the runtime database |
| Task worktrees | `worktreeParent` from `orchestrator.json` |
| Chat history and metrics | `~/.local/share/pirx/pirx.sqlite`, session logs in `logs/` |
| Configuration contract (chat vs daemon) | [`Pirx/docs/configuration.md`](Pirx/docs/configuration.md) |

## Legacy

`start.sh` and `assistant.sh` in this directory start the old bash assistant. Pirx does not use them; they are kept only until they are removed.
