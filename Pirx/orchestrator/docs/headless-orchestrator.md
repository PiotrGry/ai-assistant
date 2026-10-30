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
  "githubTimeoutMs": 10000
}
```

Every field is required. Repositories form an explicit allowlist; test commands
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

MCP chat control, host power-off, and resource telemetry are deliberately
separate follow-up Tasks.
