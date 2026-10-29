import { createHash } from "node:crypto";

import { ReleaseCorrelationService } from "./release-correlation.js";
import { releaseId, releaseText, releaseTimestamp, type ReleaseId } from "./release.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";
import type { UtcTimestamp } from "./task-domain.js";

export const DEPLOYMENT_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const DEPLOYMENT_OBSERVATION_LIMITS = Object.freeze({ failures: 32, text: 512, url: 2_048, timeoutMs: 300_000 } as const);
export type DeploymentTerminalOutcome = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "superseded";
export type DeploymentResolutionOutcome = DeploymentTerminalOutcome | "not_found" | "ambiguous" | "rate_limited" | "provider_error" | "unknown";

export interface DeploymentFailureReference { readonly name: string; readonly providerJobId?: string; readonly url?: string; }
export interface DeploymentObservation {
  readonly schemaVersion: typeof DEPLOYMENT_OBSERVATION_SCHEMA_VERSION;
  readonly repository: string;
  readonly workflowName: string;
  readonly environment: string;
  readonly revision: string;
  readonly provider: string;
  readonly providerRunId: string;
  readonly runUrl: string;
  readonly providerDeploymentId: string;
  readonly deploymentUrl: string;
  readonly outcome: DeploymentTerminalOutcome;
  readonly status?: string;
  readonly conclusion?: string;
  readonly failureReferences: readonly DeploymentFailureReference[];
  readonly observedAt: UtcTimestamp;
}
export interface DeploymentObservationRecord extends DeploymentObservation { readonly releaseId: ReleaseId; readonly observationKey: string; readonly createdAt: UtcTimestamp; }
export interface DeploymentObservationQuery { readonly repository: string; readonly workflowName: string; readonly environment: string; readonly revision: string; }
export interface DeploymentObservationContext { readonly correlationId: string; readonly timeoutMs?: number; readonly signal?: AbortSignal; }
export type DeploymentGatewayResult = { readonly outcome: DeploymentResolutionOutcome; readonly observation?: DeploymentObservation; readonly message: string };
export interface ReleaseDeploymentGateway { observe(query: DeploymentObservationQuery, context: DeploymentObservationContext): Promise<DeploymentGatewayResult>; }
export interface ObserveReleaseDeploymentRequest extends DeploymentObservationQuery { readonly releaseId: ReleaseId; readonly correlationId: string; readonly now: UtcTimestamp; readonly timeoutMs?: number; readonly signal?: AbortSignal; }
export type ObserveReleaseDeploymentResult =
  | { readonly outcome: DeploymentResolutionOutcome | "replayed"; readonly releaseId: ReleaseId; readonly message: string; readonly observation?: DeploymentObservationRecord }
  | { readonly outcome: "stale" | "conflict" | "invalid_request" | "storage_error"; readonly releaseId: ReleaseId; readonly message: string };

function bounded(value: string, field: string, maximum: number = DEPLOYMENT_OBSERVATION_LIMITS.text): string { const result = releaseText(value, field, maximum); if (/[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${field} is invalid.`); return result; }
function httpsUrl(value: string, field: string): string { const result = bounded(value, field, DEPLOYMENT_OBSERVATION_LIMITS.url); const parsed = new URL(result); if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") throw new Error(`${field} is invalid.`); return result; }
function validateFailure(value: DeploymentFailureReference): DeploymentFailureReference { return Object.freeze({ name: bounded(value.name, "failure name"), ...(value.providerJobId === undefined ? {} : { providerJobId: bounded(value.providerJobId, "failure job ID") }), ...(value.url === undefined ? {} : { url: httpsUrl(value.url, "failure URL") }) }); }
export function validateDeploymentObservation(value: DeploymentObservation): DeploymentObservation {
  if (value.schemaVersion !== 1 || !["pending", "running", "succeeded", "failed", "cancelled", "superseded"].includes(value.outcome)) throw new Error("Deployment outcome is invalid.");
  if (!Array.isArray(value.failureReferences) || value.failureReferences.length > DEPLOYMENT_OBSERVATION_LIMITS.failures) throw new Error("Deployment failure references are invalid.");
  const failures = Object.freeze(value.failureReferences.map(validateFailure));
  return Object.freeze({ schemaVersion: 1, repository: bounded(value.repository, "repository"), workflowName: bounded(value.workflowName, "workflow name"), environment: bounded(value.environment, "environment"), revision: bounded(value.revision, "revision", 256), provider: bounded(value.provider, "provider"), providerRunId: bounded(value.providerRunId, "provider run ID"), runUrl: httpsUrl(value.runUrl, "run URL"), providerDeploymentId: bounded(value.providerDeploymentId, "deployment provider ID"), deploymentUrl: httpsUrl(value.deploymentUrl, "deployment URL"), outcome: value.outcome, ...(value.status === undefined ? {} : { status: bounded(value.status, "deployment status") }), ...(value.conclusion === undefined ? {} : { conclusion: bounded(value.conclusion, "deployment conclusion") }), failureReferences: failures, observedAt: releaseTimestamp(value.observedAt) });
}
function observationKey(release: ReleaseId, value: DeploymentObservation): string { return createHash("sha256").update(JSON.stringify([release, value]), "utf8").digest("hex"); }
function providerMessage(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return (sanitized.length === 0 ? "Deployment provider returned no details." : sanitized).slice(0, DEPLOYMENT_OBSERVATION_LIMITS.text);
}
function parseRow(row: Record<string, unknown>): StorageResult<DeploymentObservationRecord> {
  try {
    if (row.schema_version !== DEPLOYMENT_OBSERVATION_SCHEMA_VERSION || typeof row.observation_key !== "string" || !/^[a-f0-9]{64}$/u.test(row.observation_key)) throw new Error("invalid identity");
    const failures = JSON.parse(String(row.failure_references_json)) as unknown;
    if (!Array.isArray(failures)) throw new Error("invalid failures");
    const observation = validateDeploymentObservation({ schemaVersion: 1, repository: String(row.repository), workflowName: String(row.workflow_name), environment: String(row.environment), revision: String(row.revision), provider: String(row.provider), providerRunId: String(row.provider_run_id), runUrl: String(row.run_url), providerDeploymentId: String(row.provider_deployment_id), deploymentUrl: String(row.deployment_url), outcome: row.outcome as DeploymentTerminalOutcome, ...(row.status === null ? {} : { status: String(row.status) }), ...(row.conclusion === null ? {} : { conclusion: String(row.conclusion) }), failureReferences: failures as DeploymentFailureReference[], observedAt: releaseTimestamp(String(row.observed_at)) });
    if (typeof row.release_id !== "string" || typeof row.created_at !== "string") throw new Error("invalid row");
    return { outcome: "success", value: Object.freeze({ ...observation, releaseId: releaseId(row.release_id), observationKey: row.observation_key, createdAt: releaseTimestamp(row.created_at) }) };
  } catch { return { outcome: "invalid_record", message: "Stored deployment observation is invalid." }; }
}

export class DeploymentObservationRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }
  public save(release: ReleaseId, input: DeploymentObservation): StorageResult<DeploymentObservationRecord> {
    let value: DeploymentObservation;
    try { releaseId(release); value = validateDeploymentObservation(input); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Deployment observation is invalid." }; }
    const key = observationKey(release, value);
    return this.#store.execute(() => {
      try {
        this.#store.database.prepare("INSERT OR IGNORE INTO runtime_release_deployment_observations (release_id, observation_key, schema_version, repository, workflow_name, environment, revision, provider, provider_run_id, run_url, provider_deployment_id, deployment_url, outcome, status, conclusion, failure_references_json, observed_at, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(release, key, value.repository, value.workflowName, value.environment, value.revision, value.provider, value.providerRunId, value.runUrl, value.providerDeploymentId, value.deploymentUrl, value.outcome, value.status ?? null, value.conclusion ?? null, JSON.stringify(value.failureReferences), value.observedAt, value.observedAt);
        const row = this.#store.database.prepare("SELECT * FROM runtime_release_deployment_observations WHERE observation_key = ?").get(key) as Record<string, unknown> | undefined;
        return row === undefined ? { outcome: "storage_error", message: "Deployment observation was not stored." } : parseRow(row);
      } catch { return { outcome: "storage_error", message: "Deployment observation could not be stored." }; }
    });
  }
  public latest(release: ReleaseId): StorageResult<DeploymentObservationRecord> {
    return this.#store.execute(() => {
      try { const row = this.#store.database.prepare("SELECT * FROM runtime_release_deployment_observations WHERE release_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1").get(release) as Record<string, unknown> | undefined; return row === undefined ? { outcome: "not_found", message: "Deployment observation was not found." } : parseRow(row); }
      catch { return { outcome: "storage_error", message: "Deployment observation could not be read." }; }
    });
  }
  public list(release: ReleaseId): StorageResult<readonly DeploymentObservationRecord[]> {
    return this.#store.execute(() => {
      try { const rows = this.#store.database.prepare("SELECT * FROM runtime_release_deployment_observations WHERE release_id = ? ORDER BY observed_at, id").all(release) as Record<string, unknown>[]; const values: DeploymentObservationRecord[] = []; for (const row of rows) { const parsed = parseRow(row); if (parsed.outcome !== "success") return parsed; values.push(parsed.value); } return { outcome: "success", value: Object.freeze(values) }; }
      catch { return { outcome: "storage_error", message: "Deployment observations could not be read." }; }
    });
  }
}

export class ReleaseDeploymentObserver {
  readonly #store: RuntimeSqliteStore;
  readonly #gateway: ReleaseDeploymentGateway;
  readonly #observations: DeploymentObservationRepository;
  readonly #correlations: ReleaseCorrelationService;
  public constructor(store: RuntimeSqliteStore, gateway: ReleaseDeploymentGateway) { this.#store = store; this.#gateway = gateway; this.#observations = new DeploymentObservationRepository(store); this.#correlations = new ReleaseCorrelationService(store); }
  public async observe(request: ObserveReleaseDeploymentRequest): Promise<ObserveReleaseDeploymentResult> {
    try { releaseId(request.releaseId); bounded(request.repository, "repository"); bounded(request.workflowName, "workflow name"); bounded(request.environment, "environment"); bounded(request.revision, "revision", 256); bounded(request.correlationId, "correlation ID"); releaseTimestamp(request.now); } catch (error: unknown) { return { outcome: "invalid_request", releaseId: request.releaseId, message: error instanceof Error ? error.message : "Deployment observation request is invalid." }; }
    if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > DEPLOYMENT_OBSERVATION_LIMITS.timeoutMs)) return { outcome: "invalid_request", releaseId: request.releaseId, message: "Deployment observation timeout is invalid." };
    const release = this.#store.releases.get(request.releaseId); const correlation = this.#correlations.getByRelease(request.releaseId);
    if (release.outcome !== "success" || correlation.outcome !== "success") return { outcome: "conflict", releaseId: request.releaseId, message: "Deployment observation requires a durably merged Release correlation." };
    if (release.value.repository !== request.repository || release.value.mergeRevision !== request.revision || correlation.value.mergeRevision !== request.revision) return { outcome: "stale", releaseId: request.releaseId, message: "Deployment query does not match the exact Release merge revision." };
    if (["production_verification", "deployed"].includes(release.value.state) && correlation.value.deployment !== undefined) { const latest = this.#observations.latest(request.releaseId); return { outcome: "replayed", releaseId: request.releaseId, message: "Replayed the exact durable deployment observation.", ...(latest.outcome === "success" ? { observation: latest.value } : {}) }; }
    if (release.value.state !== "deploying") return { outcome: "conflict", releaseId: request.releaseId, message: "Release is not awaiting deployment observation." };
    const previous = this.#observations.latest(request.releaseId);
    if (previous.outcome !== "success" && previous.outcome !== "not_found") return { outcome: previous.outcome === "storage_error" ? "storage_error" : "conflict", releaseId: request.releaseId, message: previous.message };
    if (previous.outcome === "success" && (previous.value.repository !== request.repository || previous.value.workflowName !== request.workflowName || previous.value.environment !== request.environment || previous.value.revision !== request.revision)) return { outcome: "conflict", releaseId: request.releaseId, message: "Deployment query conflicts with the durable Release observation policy." };
    let remote: DeploymentGatewayResult;
    try { remote = await this.#gateway.observe({ repository: request.repository, workflowName: request.workflowName, environment: request.environment, revision: request.revision }, { correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) }); }
    catch { return { outcome: "provider_error", releaseId: request.releaseId, message: "Deployment provider observation failed." }; }
    if (remote.observation === undefined) return { outcome: remote.outcome, releaseId: request.releaseId, message: providerMessage(remote.message) };
    let observation: DeploymentObservation;
    try { observation = validateDeploymentObservation(remote.observation); } catch { return { outcome: "provider_error", releaseId: request.releaseId, message: "Deployment provider returned invalid evidence." }; }
    if (observation.repository !== request.repository || observation.workflowName !== request.workflowName || observation.environment !== request.environment || observation.revision !== request.revision) return { outcome: "stale", releaseId: request.releaseId, message: "Deployment evidence does not match the exact Release query." };
    if (remote.outcome !== observation.outcome) return { outcome: "conflict", releaseId: request.releaseId, message: "Deployment provider outcome conflicts with its evidence." };
    const saved = this.#observations.save(request.releaseId, observation);
    if (saved.outcome !== "success") return { outcome: saved.outcome === "storage_error" ? "storage_error" : "conflict", releaseId: request.releaseId, message: saved.message };
    if (observation.outcome !== "succeeded") return { outcome: observation.outcome, releaseId: request.releaseId, message: providerMessage(remote.message), observation: saved.value };
    if (correlation.value.workflow === undefined) return { outcome: "conflict", releaseId: request.releaseId, message: "Exact Release workflow evidence is missing before deployment completion." };
    const updated = this.#correlations.correlate({ releaseId: request.releaseId, repository: correlation.value.repository, sourceBranch: correlation.value.sourceBranch, baseBranch: correlation.value.baseBranch, releasePullRequest: correlation.value.releasePullRequest, releaseHeadRevision: correlation.value.releaseHeadRevision, memberRevisions: correlation.value.memberRevisions, workflow: correlation.value.workflow, mergeRevision: request.revision, deployment: { provider: observation.provider, providerDeploymentId: observation.providerDeploymentId, environment: observation.environment, deployedRevision: observation.revision }, observedAt: observation.observedAt });
    if (updated.outcome !== "correlated" && updated.outcome !== "replayed") return { outcome: updated.outcome === "storage_error" ? "storage_error" : "conflict", releaseId: request.releaseId, message: updated.message };
    const transitioned = this.#store.releases.transition(request.releaseId, { to: "production_verification", expectedVersion: release.value.version, now: observation.observedAt, deploymentProviderId: observation.providerDeploymentId });
    if (transitioned.outcome !== "success") return { outcome: transitioned.outcome === "storage_error" ? "storage_error" : "conflict", releaseId: request.releaseId, message: transitioned.message };
    return { outcome: "succeeded", releaseId: request.releaseId, message: "Exact Release deployment succeeded and is ready for production verification.", observation: saved.value };
  }
}
