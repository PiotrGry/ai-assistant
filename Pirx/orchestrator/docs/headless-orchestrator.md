# Headless orchestrator service

Pirx runs in the foreground and lets the operating system supervise it. The
process opens the durable runtime SQLite database, recovers interrupted state,
and then executes one scheduler cycle at a time. It never daemonizes itself.

## Configuration

Set `PIRX_ORCHESTRATOR_CONFIG` to an absolute path to a mode `0600` JSON file.
Do not put tokens, passwords, authorization headers, or provider credentials in
this file. GitHub and Claude authentication remain in their respective local
CLI credential stores.

```json
{
  "schemaVersion": 1,
  "databasePath": "/var/lib/pirx/runtime.sqlite",
  "workerId": "pirx-worker",
  "provider": "claude-code",
  "workerCapabilities": [
    "repository.read",
    "repository.write",
    "tests.run",
    "git.commit",
    "git.push_assigned_branch"
  ],
  "repositories": [
    {
      "repository": "PiotrGry/ai-assistant",
      "repositoryRoot": "/srv/pirx/ai-assistant",
      "baseBranch": "develop",
      "baseRevision": "0123456789abcdef0123456789abcdef01234567",
      "remoteName": "origin",
      "testCommands": ["npm run check"],
      "delivery": {
        "releaseBranch": "main",
        "featureWorkflowName": "CI",
        "releaseRequiredChecks": ["CI"],
        "featureRequiredApprovals": 0,
        "releaseRequiredApprovals": 0,
        "featureMergeMethod": "merge",
        "releaseMergeMethod": "merge",
        "requireMergeable": true
      }
    }
  ],
  "worktreeParent": "/var/lib/pirx/worktrees",
  "leaseDurationMs": 3600000,
  "shutdownTimeoutMs": 30000,
  "workerTimeoutMs": 120000,
  "workerOutputBytes": 16384,
  "workerErrorBytes": 16384,
  "maximumConsecutiveResumeFailures": 3,
  "cycleIntervalMs": 30000,
  "errorIntervalMs": 60000,
  "githubProjectOwner": "PiotrGry",
  "githubProjectNumber": 3,
  "githubApiUrl": "https://api.github.com",
  "githubTimeoutMs": 10000,
  "hostPowerOff": {
    "enabled": true,
    "method": "linux-systemctl",
    "acceptanceTimeoutMs": 5000
  }
}
```

Every field except `hostPowerOff` is required. Repositories form an explicit allowlist; test commands
must match the bounded code-worker command policy. Update `baseRevision` to the
reviewed revision from which a new assigned worktree may be created.

`baseBranch` is the integration branch for feature PRs. `delivery.releaseBranch`
is the protected Release target and must be different. Feature merges are
intentionally restricted to the `merge` method because durable ReleaseTask
membership refers to the worker's exact pushed revision; squash or rebase would
replace that identity. Required checks and approvals are explicit repository
policy, never inferred by Pirx.

Run `gh auth login` for the service account before starting Pirx. The credential
stays in the GitHub CLI credential store and is never copied into this JSON.

## Queue contract

Before every scheduler cycle, Pirx reads one bounded snapshot of the configured
GitHub Project. It executes only open items with a positive unique `Queue Order`,
Worker `Pirx`, Work Type `Task`, `Bug`, or `Experiment`, and Status `Todo`, `Open`,
or `In Progress`. A new executable Issue must contain `## Goal`,
`## Implementation scope`, and checkbox items under `## Acceptance criteria`.

Order validity and uniqueness apply only to active executable Pirx items.
Closed Issues, Done items, other workers, non-executable Work Types and
non-executable statuses are filtered first. Their historical Queue Orders may
be duplicated or fractional without blocking the active Queue. Active items
with missing planning metadata, invalid orders or duplicate orders still stop
synchronization before any runtime Task is created.

Priority, Risk, repository allowlist, native `blockedBy` relationships, and the
Markdown contract are validated before SQLite is changed. Open blockers skip
only their dependent item. A failed or incomplete GitHub snapshot prevents a
scheduler cycle, so Pirx never falls back to a stale Queue. SQLite remains
authoritative after an Attempt starts; later Issue edits cannot rewrite that
execution contract.

## Run

Build once, then run the foreground process:

```sh
cd Pirx
pnpm build
PIRX_ORCHESTRATOR_CONFIG=/etc/pirx/orchestrator.json pnpm orchestrator:run
```

The process writes one bounded JSON event per line. Exit codes are:

- `0`: graceful stop;
- `1`: configuration or startup construction failure;
- `2`: durable startup recovery could not complete;
- `3`: bounded shutdown timed out.
- `4`: an armed host shutdown could not be safely completed or accepted.

`SIGTERM` and `SIGINT` both stop new cycles, interrupt/drain the active cycle
through `ProductionRuntime`, and close storage after a successful drain.

## External supervision

For systemd use `Type=simple`, an unprivileged user, `Restart=on-failure`, an
`Environment=PIRX_ORCHESTRATOR_CONFIG=...` entry, and `ExecStart` pointing to
`node --enable-source-maps orchestrator/dist/headless-cli.js`. Set
`TimeoutStopSec` slightly above `shutdownTimeoutMs`.

For launchd set `KeepAlive` and `ProgramArguments` to the same Node entrypoint,
and pass only the configuration path in `EnvironmentVariables`.

For a container use the Node process as `ENTRYPOINT`, mount the configuration,
SQLite directory, repositories, and worktree directory, and give the container
an init process that forwards `SIGTERM`. Do not store credentials in the image
or configuration JSON.

After a worker records `CODE_PUSHED`, the same loop creates or reuses its feature
PR, observes CI for the exact head, creates one bounded repair Attempt after a
correlated failure, and merges only after configured checks pass. It then
creates an immutable one-Task Release and advances its Release PR through the
same exact-head policy. Deployment and production-verification provider ports
remain explicit follow-up configuration; until available, the Release truthfully
remains in `deploying` and the runtime Task remains active.

Resource telemetry remains a separate follow-up Task.

## Durable execution observations

At startup and after Queue, delivery, and worker-cycle boundaries, the headless
service rebuilds an append-only observability projection from runtime SQLite.
It records bounded Task, Attempt, CI, cooldown, and shipment lifecycle events,
plus queue, execution, retry-wait, CI, cooldown, and delivery durations in
seconds. Deterministic signal IDs make replay and restart idempotent.

The projection reads durable timestamps only. It never parses logs, GitHub
comments, prompts, or model prose and is not an authority for scheduling,
retry, merge, Release, or shutdown. Missing endpoints produce no invented
duration. Projection conflict, truncation, malformed time, and storage errors
are emitted as bounded `observability` events while source runtime state remains
unchanged.

`pirx_execution_report` exposes this projection to normal Pirx chat as one
read-only bounded query. With no window it reports the preceding 24 hours; a
caller may instead supply canonical UTC `from` and `to` values for a window of
at most 180 days. The response contains recent normalized lifecycle events,
count/minimum/average/p50/p95/maximum duration summaries, repeated normalized
Attempt and CI failures, coverage counts, and explicit missing/truncated-data
notices. It does not read GitHub, start work, or return raw logs, prompts,
Checkpoints, provider payloads, credentials, or paths.

## Chat status and pause/resume

### Chat-driven startup on Linux

Install the user-service template from `orchestrator/systemd/pirx-orchestrator.service`
once. Adjust its WorkingDirectory for the local checkout, and ensure the user
service PATH resolves the supported Node.js and authenticated Claude/GitHub CLIs.
The service's `~/.config/pirx/orchestrator.env` must define
`PIRX_ORCHESTRATOR_CONFIG=/absolute/path/to/orchestrator.json`; this JSON contains
the repository allowlist, actual reviewed base revision and shared runtime database.
Do not use the example revisions or paths verbatim.

```sh
mkdir -p ~/.config/systemd/user
cp orchestrator/systemd/pirx-orchestrator.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

Give the chat `PIRX_ORCHESTRATOR_SERVICE_ENABLED=true` and
`PIRX_ORCHESTRATOR_DATABASE` pointing to the same runtime SQLite database as
the daemon. These values are forwarded to the MCP child, including with custom
system prompts. Ordinary orchestration instructions are added by the agent host.

The host-authorized `pirx_orchestrator_start` tool issues only
`/usr/bin/systemctl --user start --no-block pirx-orchestrator.service`.
Repeated starts reuse the same systemd unit. It does not launch an unsupervised
child, install software, accept arbitrary unit names, reorder Queue or select an
Issue. Missing enablement, unsupported platforms and service-manager errors are
explicit outcomes. `start_requested` confirms only that systemd accepted the
request: the chat must then read status to check heartbeat/Task/Attempt evidence.
Pause/resume continues to use the existing durable control channel.

After installation, say in chat: “Rozwiąż Issue #462 z kolejki”. Pirx should
read the Issue and daemon status, request service startup or resume when needed,
and report the actual runtime state. If another item precedes #462, normal Queue
ordering wins. Chat must not claim Claude started from startup acknowledgement alone.

Give the local MCP server the same runtime database path and the existing host
authorization secret:

```sh
PIRX_ORCHESTRATOR_DATABASE=/var/lib/pirx/runtime.sqlite
PIRX_MCP_AUTH_SECRET=use-the-existing-local-host-secret
```

`pirx_orchestrator_status` is read-only and returns only a bounded summary of
service heartbeat, active Task/Attempt/Lease, next queued Task, and active
Release. It never returns goals, prompts, Checkpoints, logs, filesystem paths,
or provider payloads.

Status also contains the latest durable diagnostic for each service event type:
sequence, recording time, source event, outcome, full sanitized reason and
structured result details. Queue, delivery, worker cycle and observability
results are recorded before the next heartbeat can replace their status.
The most recent non-idle worker cycle is also included, so subsequent idle
ticks do not hide the last execution failure or its Task/Attempt identifiers.
Diagnostics survive restart in `runtime_orchestrator_diagnostics` (schema 31).
Known diagnostic reasons are not cut to 256 characters. For long records use
`pirx_orchestrator_diagnostic` with the sequence and follow every `nextOffset`;
`totalCharacters` makes partial retrieval explicit. The record is retained in
full after secret masking. Raw prompt/body/checkpoint/credential fields are
redacted. Unclassified exceptions are explicitly marked instead of exporting
arbitrary provider payloads as diagnostic text.

The daemon also emits JSON events to systemd journal. Read them with
`journalctl --user -u pirx-orchestrator.service -n 100 --no-pager`, or follow
with `journalctl --user -u pirx-orchestrator.service -f`.
Chat can read the same service journal through `pirx_orchestrator_logs`.
It returns complete sanitized messages, timestamps, priorities and opaque cursors,
newest first. Follow `nextBeforeCursor` to retrieve older entries.
The returned cursors are short MCP-session handles; the full journal cursor stays
on the host. Unknown or expired handles fail explicitly; restart reading without
`beforeCursor` after an MCP restart. Each call defaults to ten entries.
The executable,
unit and arguments are fixed; no arbitrary command or system-unit input is
accepted. Unsupported platform, malformed entries, access failure and oversized
command output produce explicit errors. Journal retention is managed by systemd;
the tool cannot recover entries already removed by host retention.

`pirx_orchestrator_control` accepts an exactly host-authorized `pause` or
`resume` request with a stable `operationId`. Pause lets the current bounded
operation finish and prevents the next Queue/delivery/worker cycle. Resume only
changes the durable requested mode; the normal daemon loop observes it and
continues. Neither command selects a Task, creates an Attempt, bypasses safety
policy, stops the host, or powers it off.

## Safe host power-off

`pirx_orchestrator_shutdown` is a separate exactly host-authorized tool. `arm`
accepts `queue_drained` or `next_checkpoint`; `cancel` works only while the
request is still armed. MCP persists the command but never executes an OS
process. The daemon snapshots the Checkpoint sequence, evaluates fresh durable
state, drains the runtime, records `poweroff_requested`, and closes its primary
SQLite connection before invoking the adapter. Replay cannot invoke the
adapter twice.

Power-off is disabled when `hostPowerOff` is absent. The initial enabled method
is an exact shell-free `/usr/bin/systemctl poweroff --no-wall` invocation. The
service user must be granted only the host PolicyKit/systemd permission needed
for that command; do not run Pirx as root and do not add arbitrary commands to
the configuration. A missing permission or rejected command is a controlled
failure and never falls back to `sudo`, a shell, force-kill, reboot, suspend, or
another mutation.
