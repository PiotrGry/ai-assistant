# Pirx configuration contract

Pirx has two configuration domains. They are intentionally separate:

1. The **chat profile** contains local chat, integration and observability
   settings. Its default path is `$XDG_CONFIG_HOME/pirx/chat.json`, or
   `~/.config/pirx/chat.json`. `PIRX_CHAT_CONFIG` selects a different absolute
   or relative file for that process.
2. The **orchestrator profile** contains the durable headless runtime policy.
   Its default path is `$XDG_CONFIG_HOME/pirx/orchestrator.json`, or
   `~/.config/pirx/orchestrator.json`. `PIRX_ORCHESTRATOR_CONFIG` selects a
   different absolute file.

The orchestrator profile is strict and versioned. Do not copy its fields into
`chat.json`. The chat profile accepts only names registered in
`@pirx/config`; unknown names, non-string values, empty strings and control
characters reject the whole profile before any value is applied.

## Precedence and failure rules

For chat-profile settings the precedence is deterministic:

1. an explicitly present process environment value,
2. the value from `chat.json`,
3. the setting's code default.

Only `undefined` means “not supplied”. An empty or invalid explicit value is an
error and never falls back to the profile or a default. A missing default
`chat.json` is allowed. A missing file selected with `PIRX_CHAT_CONFIG` is a
startup error. Profile resolution is atomic: an invalid profile applies no
partial values.

The orchestrator reads `orchestrator.json` as its runtime policy.
`PIRX_ORCHESTRATOR_DATABASE`, when present, must identify the same runtime
database as that profile. The chat database and runtime database must identify
different files, including hard links. Pirx checks this before opening the
runtime store.

## Process boundaries

```text
chat.json + chat environment
            |
            v
       CLI / TUI agent
            |
            | allowlisted, resolved integration/runtime settings
            v
       main MCP server

orchestrator.json + daemon environment
            |
            v
     headless orchestrator ---- assigned Task/Attempt ----> Claude Code
            |                                               |
            | exact resolved Ollama settings                | strict MCP config
            +-----------------------------------------------v
                                                    Pirx Advisor MCP
```

The agent never forwards its whole environment to MCP. Host identity plus
registered settings whose `forwardToMcp` metadata is true are copied into a new
environment. Chat model settings are not sent to the main MCP server.
`PIRX_TOOL_PROFILE` is resolved once by the CLI/TUI and forwarded explicitly;
the MCP child registers only that profile's tool groups. The safe default is
`personal`. `development` excludes private Calendar/Obsidian tools, while
`operations` adds daemon control and observability to the development set.
Unknown values fail startup and never fall back to a wider catalog.
`PIRX_STORAGE_FILE` is the deliberate exception among chat-owned paths: MCP
needs the resolved path only to prove that the runtime database is not the chat
database. The path is sensitive metadata and must not be logged.

Claude receives only the worker allowlist defined by its capability boundary.
The separate Advisor MCP receives the exact validated Ollama model settings in
its strict MCP configuration. It does not inherit arbitrary daemon or Claude
environment values.

## Chat-profile registry and configuration matrix

The source of truth for names, ownership, sensitivity and child forwarding is
`config/src/index.ts`. The owning loader remains the source of truth for type
validation and defaults. All chat-profile rows use the same precedence:
process environment, then `chat.json`, then the listed code default. “none”
means the integration is opt-in or the owning loader requires the value.

| Settings | Owner / type | Code default | Sensitive | Main MCP child |
| --- | --- | --- | --- | --- |
| `OLLAMA_MODEL` | chat / model name | validated local model | no | no |
| `OLLAMA_BASE_URL` | chat / HTTP(S) URL | `http://localhost:11434` | no | no |
| `OLLAMA_NUM_CTX`, `OLLAMA_MAX_OUTPUT_TOKENS` | chat / positive integer | `16384`, `1536` | no | no |
| `OLLAMA_TEMPERATURE` | chat / finite number | `0.3` | no | no |
| `OLLAMA_KEEP_ALIVE` | chat / duration text | agent loader default | no | no |
| `ADA_PROMPT_FILE` | chat / path | bundled prompt | yes | no |
| `PIRX_CONTEXT_SAFETY_MARGIN_TOKENS`, `PIRX_MAX_TOOL_CALLS`, `PIRX_MAX_TOOL_ITERATIONS`, `PIRX_MAX_REPEATED_TOOL_CALLS` | chat / positive integer | agent bounded defaults | no | no |
| `PIRX_MAX_TURN_DURATION_MS`, `PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS`, `PIRX_MAX_TOOL_RESULT_CHARACTERS` | chat / positive integer | agent bounded defaults | no | no |
| `PIRX_CONTINUATION_CHECK` | chat / boolean | `true` | no | no |
| `PIRX_LLM_TIMEOUT_MS`, `PIRX_TOOL_TIMEOUT_MS` | chat / positive integer | `120000`, `30000` | no | no |
| `PIRX_STORAGE_FILE` | chat / path | XDG data `pirx/pirx.sqlite` | yes | alias protection only |
| `PIRX_STORAGE_MODE` | chat / enum | `full_local` | no | no |
| `PIRX_RESOURCE_SAMPLE_INTERVAL_MS` | chat / positive integer | `1000` | no | no |
| `PIRX_TOOL_PROFILE` | chat / `personal`, `development`, `operations` | `personal` | no | yes |
| `PIRX_ORCHESTRATOR_CONFIG` | runtime / absolute path | XDG config `pirx/orchestrator.json` | yes | yes |
| `PIRX_ORCHESTRATOR_DATABASE` | runtime / path identity constraint | profile `databasePath`; direct override only in unmanaged chat-only mode | yes | yes |
| `PIRX_ORCHESTRATOR_SERVICE_ENABLED` | runtime / exact boolean text | disabled | no | yes |
| `PIRX_GPU_DB` | observability / path | XDG data `pirx/gpu.sqlite` | yes | yes |
| `PIRX_OBSIDIAN_VAULT` | integration / existing directory | none | yes | yes |
| `PIRX_GOOGLE_CREDENTIALS_FILE`, `PIRX_GOOGLE_TOKEN_FILE` | integration / path | XDG config paths | yes | yes |
| `PIRX_GOOGLE_CALENDAR_ID` | integration / identifier | `primary` | yes | yes |
| `PIRX_GOOGLE_CALENDAR_TIMEZONE` | integration / IANA timezone | host timezone, then `UTC` | no | yes |
| `PIRX_GOOGLE_TIMEOUT_MS`, `PIRX_GOOGLE_AUTH_TIMEOUT_MS` | integration / positive integer | `10000`, `300000` | no | yes |
| `PIRX_GITHUB_OWNER`, `PIRX_GITHUB_REPOSITORY` | integration / repository identity | read-only fallback; no write authority | no | yes |
| `PIRX_GITHUB_PROJECT_OWNER`, `PIRX_GITHUB_PROJECT_NUMBER` | integration / owner and positive integer | none | no | yes |
| `PIRX_GITHUB_API_URL`, `PIRX_GITHUB_TIMEOUT_MS` | integration / HTTPS URL and positive integer | `https://api.github.com`, `10000` | no | yes |

The orchestrator JSON is a separate strict, versioned contract. Its own fields
are not accepted in `chat.json`; their types and bounds are enforced by
`parseHeadlessOrchestratorConfig` before runtime storage opens.

## Runtime identity and safe diagnostics

MCP reports only the safe configuration source (`explicit_profile`,
`default_profile`, or unmanaged `database_override`) and whether systemd
management is enabled. It never reports a profile or database path. Invalid
configuration includes a stable bounded code such as `missing_configuration`,
`read_failure`, or `invalid_configuration` in addition to the actionable
message.

When systemd management is enabled, runtime access and service startup verify
the installed unit's single `EnvironmentFile` and its single
`PIRX_ORCHESTRATOR_CONFIG` against the profile resolved by chat/MCP. This check
also runs while the service is stopped. A running service must additionally
hold the configured SQLite file open. Mismatches fail closed with bounded
diagnostic identifiers such as `runtime_profile_mismatch` or
`runtime_service_identity_unverifiable`; Pirx does not start the unit or read a
possibly unrelated runtime.

`PIRX_CHAT_CONFIG` selects the profile and therefore cannot be set inside that
same profile. Authentication secrets are also not profile settings. GitHub
authentication comes from `gh auth token`/`GH_CONFIG_DIR`; Google OAuth data
lives in the configured credential and token files.

## Entrypoint-only settings

The following settings belong to a bounded command or compatibility path and
are not general chat-profile settings:

- `PIRX_GPU_INTERVAL_MS`, `PIRX_GPU_RETENTION_DAYS` — standalone GPU sampler;
- `PIRX_GITHUB_POC_ISSUE`, `PIRX_GITHUB_SHIPMENT_POC`,
  `PIRX_GITHUB_SHIPMENT_POC_STATE_FILE`, `PIRX_GITHUB_SHIPMENT_CYCLE`,
  `PIRX_GITHUB_FAILURE_HANDOFF_POC`,
  `PIRX_GITHUB_FAILURE_HANDOFF_POC_STATE_FILE`, `PIRX_CODEX_EXECUTABLE` —
  legacy/controlled MCP workflows;
- `PIRX_GITHUB_ROUND_TRIP_*` — explicit round-trip CLI;
- `PIRX_CLAUDE_EXECUTABLE`, `PIRX_CLAUDE_TIMEOUT_MS`,
  `PIRX_CLAUDE_STDOUT_BYTES`, `PIRX_CLAUDE_STDERR_BYTES` — explicit Claude
  smoke/round-trip CLI;
- `PIRX_MCP_AUTH_SECRET` — generated by the agent for its MCP child and never
  accepted from the chat profile.

Production code must not add another hand-maintained child-process allowlist.
Add shared settings to the registry with explicit ownership and forwarding
metadata, then add a regression covering the relevant process boundary.

The production Claude code-worker additionally requires Claude Code 2.1.314+
and, on Linux/WSL2, `bubblewrap` plus `socat` on the daemon's `PATH`. The worker
fails closed before execution when the version is unsupported or the required
sandbox cannot start. See [Claude Code worker isolation](claude-worker-isolation.md).
