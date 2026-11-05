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

## Chat-profile registry

The source of truth is `config/src/index.ts`. `owner` identifies the subsystem
that validates and consumes a setting. `sensitive` means diagnostics must not
print the value. `MCP` says whether the resolved value crosses from the chat
process into the main MCP child.

| Settings | Owner | Sensitive | MCP |
| --- | --- | --- | --- |
| `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`, `OLLAMA_BASE_URL`, `OLLAMA_MAX_OUTPUT_TOKENS`, `OLLAMA_TEMPERATURE`, `OLLAMA_KEEP_ALIVE` | chat | no | no |
| `ADA_PROMPT_FILE` | chat | yes | no |
| `PIRX_CONTEXT_SAFETY_MARGIN_TOKENS`, `PIRX_MAX_TOOL_CALLS`, `PIRX_MAX_TOOL_ITERATIONS`, `PIRX_MAX_REPEATED_TOOL_CALLS` | chat | no | no |
| `PIRX_MAX_TURN_DURATION_MS`, `PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS`, `PIRX_MAX_TOOL_RESULT_CHARACTERS` | chat | no | no |
| `PIRX_CONTINUATION_CHECK`, `PIRX_LLM_TIMEOUT_MS`, `PIRX_TOOL_TIMEOUT_MS` | chat | no | no |
| `PIRX_STORAGE_FILE` | chat | yes | yes, alias protection only |
| `PIRX_STORAGE_MODE`, `PIRX_RESOURCE_SAMPLE_INTERVAL_MS` | chat | no | no |
| `PIRX_TOOL_PROFILE` (`personal`, `development`, `operations`) | chat | no | yes |
| `PIRX_ORCHESTRATOR_CONFIG`, `PIRX_ORCHESTRATOR_DATABASE` | runtime | yes | yes |
| `PIRX_ORCHESTRATOR_SERVICE_ENABLED` | runtime | no | yes |
| `PIRX_GPU_DB` | observability | yes | yes |
| `PIRX_OBSIDIAN_VAULT` | integration | yes | yes |
| `PIRX_GOOGLE_CREDENTIALS_FILE`, `PIRX_GOOGLE_TOKEN_FILE`, `PIRX_GOOGLE_CALENDAR_ID` | integration | yes | yes |
| `PIRX_GOOGLE_CALENDAR_TIMEZONE`, `PIRX_GOOGLE_TIMEOUT_MS`, `PIRX_GOOGLE_AUTH_TIMEOUT_MS` | integration | no | yes |
| `PIRX_GITHUB_OWNER`, `PIRX_GITHUB_REPOSITORY`, `PIRX_GITHUB_PROJECT_OWNER`, `PIRX_GITHUB_PROJECT_NUMBER` | integration | no | yes |
| `PIRX_GITHUB_API_URL`, `PIRX_GITHUB_TIMEOUT_MS` | integration | no | yes |

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
