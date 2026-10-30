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
      "baseBranch": "main",
      "baseRevision": "0123456789abcdef0123456789abcdef01234567",
      "remoteName": "origin",
      "testCommands": ["npm run check"]
    }
  ],
  "worktreeParent": "/var/lib/pirx/worktrees",
  "leaseDurationMs": 3600000,
  "shutdownTimeoutMs": 30000,
  "workerTimeoutMs": 120000,
  "workerOutputBytes": 16384,
  "workerErrorBytes": 16384,
  "maximumConsecutiveResumeFailures": 3,
  "cycleIntervalMs": 5000,
  "errorIntervalMs": 15000
}
```

Every field is required. Repositories form an explicit allowlist; test commands
must match the bounded code-worker command policy. Update `baseRevision` to the
reviewed revision from which a new assigned worktree may be created.

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

GitHub Queue synchronization, CI/Release continuation, MCP chat control, host
power-off, and resource telemetry are deliberately separate follow-up Tasks.
