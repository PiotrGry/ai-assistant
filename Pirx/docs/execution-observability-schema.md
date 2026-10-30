# Pirx execution observability schema v1

Pirx uses a small internal schema instead of binding runtime code directly to a telemetry vendor. An adapter may later project these signals to OpenTelemetry, Grafana, or another backend without changing their meaning.

## Signal families

Events describe individual Task, Attempt, CI, Worker cooldown, and delivery lifecycle observations. Every event carries a stable `correlationId` plus only the identifiers required to join it to durable Pirx state. Event attributes are flat, bounded scalars. Prompts, provider payloads, stdout/stderr, log bodies, authorization data, and secret-shaped values are forbidden.

Metrics are aggregate counters or duration histograms. Metric labels contain only low or configured-bounded dimensions such as state, outcome, provider, workflow name, recovery source, and environment. Task, Attempt, Release, deployment, run, correlation, and repository identifiers must never be metric labels.

The authoritative names, required fields, units, and allowed labels live in `orchestrator/src/runtime/execution-observability.ts`.

## Cardinality policy

- `low`: closed vocabularies controlled by Pirx, for example lifecycle state or risk.
- `bounded`: values must come from configured allowlists, for example provider, required workflow, recovery source, or deployment environment.
- unique identifiers are event-only correlation data and are never metric dimensions.
- new attributes require a schema version or a backwards-compatible catalog change with tests.

## Retention expectation

- execution events: 30 days in local durable storage;
- raw metric points: 30 days;
- aggregated metric rollups: 180 days;
- cleanup must be explicit and must not delete the Pirx Task, Attempt, Checkpoint, Lease, Release, or correlation records that remain the machine source of truth.

Retention values are schema expectations, not permission for an emitter to delete data. Storage/export implementation belongs to the subsequent observability slices.
