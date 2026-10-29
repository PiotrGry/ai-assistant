import { releaseId, releaseText, releaseTimestamp, validatePullRequest, type ReleaseId, type ReleasePullRequestIdentity, type ReleaseTaskRecord } from "./release.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";
import type { UtcTimestamp } from "./task-domain.js";

export const RELEASE_CORRELATION_SCHEMA_VERSION = 1 as const;
export const RELEASE_CORRELATION_LIMITS = Object.freeze({ memberRevisions: 100, text: 512, url: 2_048 } as const);

export type ReleaseCorrelationState = "release_pr_correlated" | "workflow_correlated" | "merged" | "deployed" | "production_observed";

export interface ReleaseWorkflowIdentity {
  readonly provider: string;
  readonly providerRunId: string;
  readonly url: string;
  readonly name: string;
  readonly testedRevision: string;
}

export interface ReleaseDeploymentIdentity {
  readonly provider: string;
  readonly providerDeploymentId: string;
  readonly environment: string;
  readonly deployedRevision: string;
}

export interface ReleaseCorrelationInput {
  readonly releaseId: ReleaseId;
  readonly repository: string;
  readonly sourceBranch: string;
  readonly baseBranch: string;
  readonly releasePullRequest: ReleasePullRequestIdentity;
  readonly releaseHeadRevision: string;
  readonly memberRevisions: readonly string[];
  readonly workflow?: ReleaseWorkflowIdentity;
  readonly mergeRevision?: string;
  readonly deployment?: ReleaseDeploymentIdentity;
  readonly productionVersion?: string;
  readonly observedAt: UtcTimestamp;
}

export interface ReleaseCorrelationRecord extends ReleaseCorrelationInput {
  readonly schemaVersion: typeof RELEASE_CORRELATION_SCHEMA_VERSION;
  readonly state: ReleaseCorrelationState;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly version: number;
}

export interface ReleaseCorrelationRequest extends ReleaseCorrelationInput {}

export type ReleaseCorrelationResult =
  | { readonly outcome: "correlated" | "replayed"; readonly record: ReleaseCorrelationRecord; readonly message: string }
  | { readonly outcome: "missing_evidence" | "stale" | "superseded" | "unrelated" | "ambiguous" | "conflict" | "storage_error"; readonly message: string };

function bounded(value: string, field: string, maximum: number = RELEASE_CORRELATION_LIMITS.text): string {
  const result = releaseText(value, field, maximum);
  if (/[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${field} is invalid.`);
  return result;
}

function httpsUrl(value: string, field: string): string {
  const result = bounded(value, field, RELEASE_CORRELATION_LIMITS.url);
  const parsed = new URL(result);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") throw new Error(`${field} is invalid.`);
  return result;
}

export function normalizeReleaseMemberRevisions(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > RELEASE_CORRELATION_LIMITS.memberRevisions) throw new Error("Release member revisions are invalid.");
  const revisions = values.map((value) => bounded(value, "member revision", 256)).sort((left, right) => left.localeCompare(right));
  if (new Set(revisions).size !== revisions.length) throw new Error("Release member revisions must be unique.");
  return Object.freeze(revisions);
}

function validateWorkflow(value: ReleaseWorkflowIdentity, releaseHeadRevision: string): ReleaseWorkflowIdentity {
  const workflow = Object.freeze({ provider: bounded(value.provider, "workflow provider"), providerRunId: bounded(value.providerRunId, "workflow run ID"), url: httpsUrl(value.url, "workflow URL"), name: bounded(value.name, "workflow name"), testedRevision: bounded(value.testedRevision, "workflow tested revision", 256) });
  if (workflow.testedRevision !== releaseHeadRevision) throw new Error("Release workflow does not test the exact release head revision.");
  return workflow;
}

function validateDeployment(value: ReleaseDeploymentIdentity, mergeRevision: string | undefined): ReleaseDeploymentIdentity {
  const deployment = Object.freeze({ provider: bounded(value.provider, "deployment provider"), providerDeploymentId: bounded(value.providerDeploymentId, "deployment provider ID"), environment: bounded(value.environment, "deployment environment"), deployedRevision: bounded(value.deployedRevision, "deployed revision", 256) });
  if (mergeRevision === undefined || deployment.deployedRevision !== mergeRevision) throw new Error("Deployment does not reference the exact Release merge revision.");
  return deployment;
}

export function releaseCorrelationState(input: Pick<ReleaseCorrelationInput, "workflow" | "mergeRevision" | "deployment" | "productionVersion">): ReleaseCorrelationState {
  if (input.productionVersion !== undefined) return "production_observed";
  if (input.deployment !== undefined) return "deployed";
  if (input.mergeRevision !== undefined) return "merged";
  if (input.workflow !== undefined) return "workflow_correlated";
  return "release_pr_correlated";
}

export function validateReleaseCorrelationInput(input: ReleaseCorrelationInput): ReleaseCorrelationInput {
  releaseId(input.releaseId);
  const repository = bounded(input.repository, "repository");
  const sourceBranch = bounded(input.sourceBranch, "source branch");
  const baseBranch = bounded(input.baseBranch, "base branch");
  if (sourceBranch === baseBranch) throw new Error("Release source and base branches must differ.");
  const releasePullRequest = validatePullRequest(input.releasePullRequest);
  const releaseHeadRevision = bounded(input.releaseHeadRevision, "release head revision", 256);
  const memberRevisions = normalizeReleaseMemberRevisions(input.memberRevisions);
  const workflow = input.workflow === undefined ? undefined : validateWorkflow(input.workflow, releaseHeadRevision);
  const mergeRevision = input.mergeRevision === undefined ? undefined : bounded(input.mergeRevision, "merge revision", 256);
  if (mergeRevision !== undefined && workflow === undefined) throw new Error("Release merge evidence requires exact workflow evidence.");
  const deployment = input.deployment === undefined ? undefined : validateDeployment(input.deployment, mergeRevision);
  const productionVersion = input.productionVersion === undefined ? undefined : bounded(input.productionVersion, "production version", 256);
  if (productionVersion !== undefined && deployment === undefined) throw new Error("Production version evidence requires exact deployment evidence.");
  const observedAt = releaseTimestamp(input.observedAt);
  return Object.freeze({ releaseId: input.releaseId, repository, sourceBranch, baseBranch, releasePullRequest, releaseHeadRevision, memberRevisions, ...(workflow === undefined ? {} : { workflow }), ...(mergeRevision === undefined ? {} : { mergeRevision }), ...(deployment === undefined ? {} : { deployment }), ...(productionVersion === undefined ? {} : { productionVersion }), observedAt });
}

function failure(outcome: Exclude<ReleaseCorrelationResult["outcome"], "correlated" | "replayed">, message: string): ReleaseCorrelationResult { return { outcome, message }; }
function storageFailure<T>(result: Exclude<StorageResult<T>, { readonly outcome: "success" }>): ReleaseCorrelationResult {
  return failure(result.outcome === "storage_error" ? "storage_error" : "conflict", result.message);
}
function samePullRequest(left: ReleasePullRequestIdentity, right: ReleasePullRequestIdentity): boolean { return left.nodeId === right.nodeId && left.number === right.number && left.url === right.url; }
function sameEvidence(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export class ReleaseCorrelationService {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public correlate(request: ReleaseCorrelationRequest): ReleaseCorrelationResult {
    let input: ReleaseCorrelationInput;
    try { input = validateReleaseCorrelationInput(request); } catch (error: unknown) { return failure("conflict", error instanceof Error ? error.message : "Release correlation request is invalid."); }
    const release = this.#store.releases.get(input.releaseId);
    if (release.outcome !== "success") return storageFailure(release);
    if (release.value.repository !== input.repository || release.value.sourceBranch !== input.sourceBranch || release.value.baseBranch !== input.baseBranch) return failure("unrelated", "Release correlation request does not match the durable Release identity.");
    if (release.value.state === "collecting") return failure("conflict", "Release membership must be immutable before delivery correlation starts.");
    const membership = this.#store.releases.listTasks(input.releaseId);
    if (membership.outcome === "not_found") return failure("missing_evidence", membership.message);
    if (membership.outcome !== "success") return storageFailure(membership);
    const selected = membership.value.map((member) => member.selectedRevision).sort((left, right) => left.localeCompare(right));
    if (new Set(selected).size !== selected.length) return failure("ambiguous", "Multiple ReleaseTask members select the same revision.");
    const requested = input.memberRevisions;
    const missing = selected.filter((revision) => !requested.includes(revision));
    if (missing.length > 0) return failure("missing_evidence", "Release pull request evidence is missing one or more selected Task revisions.");
    const unrelated = requested.filter((revision) => !selected.includes(revision));
    if (unrelated.length > 0) return failure("unrelated", "Release pull request evidence contains revisions outside durable Release membership.");
    for (const member of membership.value) {
      if (member.featurePullRequest === undefined) return failure("missing_evidence", "ReleaseTask membership is missing feature pull request provenance.");
      const ci = this.#store.ciCorrelations.getByTaskAttempt(member.taskId, member.attemptId);
      if (ci.outcome === "not_found") return failure("missing_evidence", "ReleaseTask membership is missing exact successful CI correlation.");
      if (ci.outcome !== "success") return storageFailure(ci);
      if (ci.value.state !== "success") return failure(ci.value.state === "pending" || ci.value.state === "unavailable" ? "missing_evidence" : "stale", "ReleaseTask CI correlation is not exact successful evidence.");
      if (ci.value.repository !== input.repository || !samePullRequest(ci.value.featurePullRequest, member.featurePullRequest)) return failure("unrelated", "ReleaseTask CI evidence belongs to another repository or feature pull request.");
      if (ci.value.pushedCommit !== member.selectedRevision || ci.value.testedRevision !== member.selectedRevision) return failure("stale", "ReleaseTask CI evidence does not match the selected Attempt revision.");
    }
    const previous = this.#store.releaseCorrelations.getByRelease(input.releaseId);
    if (previous.outcome !== "success" && previous.outcome !== "not_found") return storageFailure(previous);
    if (previous.outcome === "success") {
      if (previous.value.releaseHeadRevision !== input.releaseHeadRevision) return failure("superseded", "Release head evidence was superseded by another revision.");
      if (previous.value.workflow !== undefined && input.workflow !== undefined && !sameEvidence(previous.value.workflow, input.workflow)) return failure("superseded", "Release workflow evidence was superseded by another run.");
      if (previous.value.deployment !== undefined && input.deployment !== undefined && !sameEvidence(previous.value.deployment, input.deployment)) return failure("superseded", "Release deployment evidence was superseded by another deployment.");
      if (previous.value.productionVersion !== undefined && input.productionVersion !== undefined && previous.value.productionVersion !== input.productionVersion) return failure("superseded", "Release production evidence was superseded by another version.");
    }
    const saved = this.#store.releaseCorrelations.upsert(input);
    if (saved.outcome !== "success") return storageFailure(saved);
    const replayed = previous.outcome === "success" && previous.value.version === saved.value.version;
    return { outcome: replayed ? "replayed" : "correlated", record: saved.value, message: replayed ? "Replayed the durable Release correlation." : "Release delivery evidence was durably correlated." };
  }

  public getByRelease(id: string): StorageResult<ReleaseCorrelationRecord> { return this.#store.releaseCorrelations.getByRelease(id); }
  public listMembers(id: string): StorageResult<readonly ReleaseTaskRecord[]> { return this.#store.releases.listTasks(id); }
  public getByPullRequest(repository: string, number: number): StorageResult<ReleaseCorrelationRecord> { return this.#store.releaseCorrelations.getByPullRequest(repository, number); }
  public getByWorkflowRun(provider: string, providerRunId: string): StorageResult<ReleaseCorrelationRecord> { return this.#store.releaseCorrelations.getByWorkflowRun(provider, providerRunId); }
  public getByDeployment(provider: string, providerDeploymentId: string): StorageResult<ReleaseCorrelationRecord> { return this.#store.releaseCorrelations.getByDeployment(provider, providerDeploymentId); }
  public getByProductionVersion(repository: string, productionVersion: string): StorageResult<ReleaseCorrelationRecord> { return this.#store.releaseCorrelations.getByProductionVersion(repository, productionVersion); }
}
