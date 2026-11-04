# Local runtime SQLite migration

Use the same Pirx build for the daemon and chat/MCP. Daemon and MCP share `$XDG_CONFIG_HOME/pirx/orchestrator.json`
(default `~/.config/pirx/orchestrator.json`). If the service uses a custom
`PIRX_ORCHESTRATOR_CONFIG`, set the same absolute filename in the chat
profile. Set `databasePath` in that shared JSON. Remove the legacy
`PIRX_ORCHESTRATOR_DATABASE` from chat.json once the shared profile is used.
If both are present, they must identify the same path. The runtime file
must be separate from `PIRX_STORAGE_FILE`. Standalone MCP clients can still
specify a runtime file directly when the orchestrator service is disabled
and the shared profile is absent.

1. Pause work and let the current Attempt finish or checkpoint. Stop
   `pirx-orchestrator.service` and close clients or other tools that can write
   to the runtime file.
2. Build the target revision. With the daemon configuration available through
   `PIRX_ORCHESTRATOR_CONFIG`, run `pnpm orchestrator:run --migrate` from the
   Pirx directory. The command initializes a new database or creates one
   verified SQLite Backup API snapshot before changing an existing schema.
   It reports the backup path and exits without starting the scheduler.
3. Confirm `runtime_migrated` succeeded. Start the matching daemon build and
   then open the matching chat. Verify status, outstanding checkpoints and
   ambiguous external operations before resuming work.

If migration fails, keep the writer stopped. Use the reported backup and
restore to a separate path via SQLite's backup/restore facilities. Check
`PRAGMA integrity_check`, `PRAGMA foreign_key_check` and the runtime migration
ledger before switching both configurations to the restored database and
starting the previous compatible build. Reconcile any remote effects before
retrying. Never copy the live database file by itself while WAL is active.
