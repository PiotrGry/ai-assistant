# Claude Code worker isolation

Pirx runs a code worker only inside the durable Attempt's assigned worktree and
branch. The boundary is enforced by the process adapter, not by prompt text.

## Required runtime

- Claude Code `2.1.314` or newer. Pirx probes `claude --version` once per
  runner and returns a bounded `permission_denied` diagnostic before invoking
  a worker when the version is missing, malformed, or too old.
- On Linux/WSL2, `bubblewrap` and `socat` must be available on the daemon's
  `PATH`. Pirx enables `sandbox.failIfUnavailable`, so a missing dependency
  blocks execution instead of silently running a command outside the sandbox.
- The service `PATH` must resolve the supported Claude Code installation. The
  supported Ubuntu service profile puts `$HOME/.local/bin` before `/usr/bin`.

## Enforced layers

Every production code-worker invocation uses:

1. `--restricted`, which ignores user and project customizations and confines
   built-in file tools to the working directories;
2. per-invocation settings that block file-tool reads and writes outside the
   assigned worktree;
3. a required OS sandbox for Bash and child processes, with unsandboxed retry
   disabled and only `github.com` available to the network proxy;
4. an explicit tool set and deny-by-default `dontAsk` permissions;
5. exact allow rules for configured tests, commits, and a push to the assigned
   branch only;
6. a process environment built from the shared allowlist rather than the
   daemon's full environment.

The worker profile and the canonical process working directory must match.
Pirx rejects a mismatched profile before the version probe or worker spawn.

## Repeatable live matrix

Run only on a controlled developer host with authenticated Claude Code:

```sh
PIRX_CLAUDE_ISOLATION_SMOKE=1 \
PIRX_CLAUDE_EXECUTABLE="$HOME/.local/bin/claude" \
pnpm --filter @pirx/orchestrator claude:isolation-smoke
```

The smoke test creates disposable local Git fixtures and controlled sentinel
values. It does not read production, use real secrets, or push to GitHub.

The 2026-11-08 acceptance run used Claude Code `2.1.319` on Ubuntu and produced
this matrix:

| Probe | Expected and observed result |
| --- | --- |
| Read inside assigned worktree | allowed |
| Write inside assigned worktree | allowed |
| Read outside assigned worktree | denied |
| Write outside via file tool | denied |
| Write outside via allowed subprocess | denied by OS sandbox |
| Read a non-allowlisted environment value | value absent |
| Push to an unrelated branch | denied |

Before the isolation fix, the same controlled fixture on Claude Code `2.1.59`
proved that generic `Read` and `Write` permissions could cross the worktree
boundary. This is why the minimum version and strict runtime settings are hard
requirements rather than documentation-only recommendations.
