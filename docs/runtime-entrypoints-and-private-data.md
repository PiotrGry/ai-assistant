# Pirx runtime entrypoints and private data

This inventory separates current Pirx execution from retained migration aids.
It is intentionally descriptive: deleting tracked files or rewriting Git
history requires a separate owner decision.

## Current supported entrypoints

| Entrypoint | Status | Purpose |
|---|---|---|
| `task Pirx` / `task Pirx:operations` | Primary | Build and start the operations-scoped TypeScript TUI. |
| `task Pirx:personal` | Primary | Start the local personal profile (Obsidian and Calendar). |
| `task Pirx:development` | Primary | Start the bounded development profile. |
| `pnpm start` / `pnpm tui` inside `Pirx/` | Primary | Direct CLI/TUI entrypoints using the shared config resolver. |
| `pirx-orchestrator.service` | Primary headless runtime | Sole owner of scheduling, Leases and worker execution. |

## Retained legacy and reference paths

- Root `assistant.sh` and `start.sh` are a supported **fallback only**. They
  provide the old tool-free assistant and tmux layout; they are not the Pirx
  scheduler, do not expose MCP tools and must not be extended with a second
  configuration system. `start.sh` validates the context size and shell-quotes
  every value before sending one command to the tmux pane. A regression test
  executes the generated command with spaces and shell metacharacters.
- `Pirx/pirx-mcp/` is a read-only Python reference from the MCP migration. New
  behavior belongs in the TypeScript `agent` and `mcp-server` packages.
- `bootstrap_pirx_orchestrator_v3.py` is the historical backlog bootstrap, not
  a runtime entrypoint. It must not be used to reconstruct runtime state.
- `bench/cloud/remote-bootstrap.sh` is isolated benchmark provisioning. If it
  installs Ollama, it requires a staged release archive and explicit SHA-256,
  rejects unsafe archive paths and never pipes a downloaded script to a shell.

## Vault privacy boundary

`PIRX_OBSIDIAN_VAULT` is the only supported vault selection. There is no
repository fallback. The committed `Pirx/vault/` directory is a historical
snapshot that may contain user-authored material; runtime code, examples,
tests and packaging must not read it implicitly.

`.gitignore` prevents new local files under `Pirx/vault/` from being added by
ordinary workflows. Files already tracked by Git remain tracked: removing
them, replacing them with synthetic examples or rewriting their history is a
separate human-approved retention operation. A public example vault, if ever
needed, must use synthetic content in a separately named fixture directory.

## Migration rule

New code and documentation should point to the TypeScript entrypoints. Legacy
paths may only receive security and retirement fixes. Retirement is complete
only when callers and docs have moved, a replacement command is verified, and
the owner explicitly approves removal of retained files or data.
