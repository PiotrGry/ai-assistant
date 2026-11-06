# Pirx continuous integration

Every pull request that changes `Pirx/` runs two public, deterministic jobs:

- `check` installs the pinned package manager and runs the repository's normal `pnpm check` entry point (build, typecheck and every isolated test suite).
- `secret-scan` examines tracked Pirx source files for high-confidence private-key and provider-credential formats. It reports only the file and rule name, never the matched value.

Both jobs have read-only repository permissions. They receive no production tokens, do not read the operator's runtime profile, do not contact Portal/Zdrovena, and do not run GitHub mutation, Ollama, Claude Code or deployment smoke tests. Third-party actions are pinned to full commit revisions.

Run the same gates locally from `Pirx/`:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:secrets
```

Tests create temporary SQLite databases and fake provider boundaries. Cross-process fixtures may start the local MCP child, close it, and reconnect to the same temporary database; they never use the daemon's configured database. Schema compatibility tests operate on disposable copies and verify that an incompatible build refuses writes.

Live integrations remain explicit operator actions. `pnpm --filter @pirx/orchestrator claude:smoke` additionally requires `PIRX_CLAUDE_LOCAL_SMOKE=1`; it is not a CI gate. GitHub, Calendar and shipment round trips likewise remain outside public CI because they require private credentials and controlled external fixtures.
