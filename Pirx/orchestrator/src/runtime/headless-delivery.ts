import { createHash } from "node:crypto";

import type { ShipmentCycleCoordinator, ShipmentCycleResult } from "./shipment-coordinator.js";
import type { ReleaseMergeCoordinator, ReleaseMergeResult } from "./release-merge.js";
import { releaseId, type ReleaseId, type ReleasePullRequestIdentity } from "./release.js";
import type { RuntimeSqliteStore } from "./sqlite.js";
import type { HeadlessRepositoryConfig } from "./headless-config.js";
import type { TaskSnapshot, TerminalAttemptSnapshot, UtcTimestamp } from "./task-domain.js";

export const HEADLESS_DELIVERY_SCHEMA_VERSION = 1 as const;
export type HeadlessDeliveryOutcome =
  | "idle"
  | "worker_required"
  | "retry_ready"
  | "waiting"
  | "release_merged"
  | "rate_limited"
  | "blocked"
  | "reconciliation_required";

export interface HeadlessDeliveryResult {
  readonly schemaVersion: typeof HEADLESS_DELIVERY_SCHEMA_VERSION;
  readonly outcome: HeadlessDeliveryOutcome;
  readonly allowWorkerCycle: boolean;
  readonly message: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly releaseId?: ReleaseId;
}

export interface HeadlessDeliveryRepositoryRuntime {
  readonly config: HeadlessRepositoryConfig;
  readonly shipment: Pick<ShipmentCycleCoordinator, "run">;
  readonly releaseMerge: Pick<ReleaseMergeCoordinator, "merge">;
}

export interface HeadlessDeliveryCoordinatorOptions {
  readonly now?: () => UtcTimestamp;
  readonly timeoutMs?: number;
}

function bounded(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256); }
function output(outcome: HeadlessDeliveryOutcome, allowWorkerCycle: boolean, message: string, extra: Omit<Partial<HeadlessDeliveryResult>, "schemaVersion" | "outcome" | "allowWorkerCycle" | "message"> = {}): HeadlessDeliveryResult {
  return Object.freeze({ schemaVersion: 1, outcome, allowWorkerCycle, message: bounded(message), ...extra });
}
function splitRepository(value: string): { owner: string; repository: string } | undefined {
  const match = /^([^/]+)\/([^/]+)$/u.exec(value);
  return match === null ? undefined : { owner: match[1]!, repository: match[2]! };
}
function deterministicReleaseId(task: TaskSnapshot, attempt: TerminalAttemptSnapshot): ReleaseId {
  const digest = createHash("sha256").update(`${task.id}\n${attempt.id}\n${attempt.finalCommit ?? ""}`, "utf8").digest("hex").slice(0, 32);
  return releaseId(`release-${digest}`);
}
function pullIdentity(result: ShipmentCycleResult): ReleasePullRequestIdentity | undefined {
  const pull = result.pullRequest;
  return pull === undefined ? undefined : { nodeId: `pr:${String(pull.number)}`, number: pull.number, url: pull.url };
}
function samePull(left: ReleasePullRequestIdentity | undefined, right: ReleasePullRequestIdentity): boolean {
  return left !== undefined && left.nodeId === right.nodeId && left.number === right.number && left.url === right.url;
}
function shipmentFailure(value: ShipmentCycleResult): HeadlessDeliveryResult {
  const extra = { taskId: value.taskId, attemptId: value.attemptId };
  if (value.outcome === "retry_created") return output("retry_ready", true, value.message, extra);
  if (value.outcome === "pending_or_timeout" || value.outcome === "worker_unavailable" || value.outcome === "worker_quota_exhausted") return output("waiting", false, value.message, extra);
  if (value.outcome === "rate_limited") return output("rate_limited", false, value.message, extra);
  if (value.outcome === "reconciliation_required" || value.outcome === "unknown") return output("reconciliation_required", false, value.message, extra);
  return output("blocked", false, value.message, extra);
}
function releaseFailure(task: TaskSnapshot, attempt: TerminalAttemptSnapshot, id: ReleaseId, value: ReleaseMergeResult): HeadlessDeliveryResult {
  const extra = { taskId: task.id, attemptId: attempt.id, releaseId: id };
  if (value.outcome === "ci_pending") return output("waiting", false, value.message, extra);
  if (value.outcome === "rate_limited") return output("rate_limited", false, value.message, extra);
  if (["reconciliation_required", "conflict", "ambiguous", "stale", "superseded"].includes(value.outcome)) return output("reconciliation_required", false, value.message, extra);
  return output("blocked", false, value.message, extra);
}

export class HeadlessDeliveryCoordinator {
  readonly #store: RuntimeSqliteStore;
  readonly #repositories: ReadonlyMap<string, HeadlessDeliveryRepositoryRuntime>;
  readonly #now: () => UtcTimestamp;
  readonly #timeoutMs: number | undefined;

  public constructor(store: RuntimeSqliteStore, repositories: readonly HeadlessDeliveryRepositoryRuntime[], options: HeadlessDeliveryCoordinatorOptions = {}) {
    if (repositories.length === 0 || new Set(repositories.map((item) => item.config.repository)).size !== repositories.length) throw new RangeError("Headless delivery repositories must be non-empty and unique.");
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 120_000)) throw new RangeError("Headless delivery timeout is invalid.");
    this.#store = store;
    this.#repositories = new Map(repositories.map((item) => [item.config.repository, item]));
    this.#now = options.now ?? (() => new Date().toISOString() as UtcTimestamp);
    this.#timeoutMs = options.timeoutMs;
  }

  public async reconcile(): Promise<HeadlessDeliveryResult> {
    const tasks = this.#store.tasks.list();
    if (tasks.outcome !== "success") return output("reconciliation_required", false, tasks.message);
    const active = tasks.value.filter((task) => task.state === "in_progress");
    if (active.length === 0) return output("idle", true, "No active Task requires delivery reconciliation.");
    if (active.length !== 1) return output("reconciliation_required", false, "Delivery reconciliation requires exactly one active Task.");
    const task = active[0]!;
    const reference = task.githubReference;
    if (reference === undefined) return output("reconciliation_required", false, "Active Task has no GitHub repository identity.", { taskId: task.id });
    const repositoryName = `${reference.owner}/${reference.repository}`;
    const repository = this.#repositories.get(repositoryName);
    if (repository === undefined) return output("blocked", false, "Active Task repository has no delivery policy.", { taskId: task.id });
    const history = this.#store.attempts.listByTask(task.id);
    if (history.outcome !== "success" || history.value.length === 0) return output("reconciliation_required", false, history.outcome === "success" ? "Active Task has no Attempt history." : history.message, { taskId: task.id });
    const latest = history.value[history.value.length - 1]!;
    if (latest.state === "running") return output("worker_required", true, "The durable retry Attempt is ready for the leased worker.", { taskId: task.id, attemptId: latest.id });
    if (latest.result !== "CODE_PUSHED" || latest.branch === undefined || latest.finalCommit === undefined) return output("blocked", false, "The latest terminal Attempt is not deliverable CODE_PUSHED evidence.", { taskId: task.id, attemptId: latest.id });
    return this.#deliver(task, latest, repository);
  }

  async #deliver(task: TaskSnapshot, attempt: TerminalAttemptSnapshot, repository: HeadlessDeliveryRepositoryRuntime): Promise<HeadlessDeliveryResult> {
    const now = this.#now();
    const parts = splitRepository(repository.config.repository);
    if (parts === undefined) return output("reconciliation_required", false, "Configured repository identity is invalid.", { taskId: task.id, attemptId: attempt.id });
    const correlationId = `delivery:${task.id}:${attempt.id}`.slice(0, 256);
    const shipment = await repository.shipment.run({
      taskId: task.id, attemptId: attempt.id, eventId: `shipment:${attempt.id}`.slice(0, 512), correlationId,
      repository: parts, headBranch: attempt.branch!, baseBranch: repository.config.baseBranch, expectedHeadSha: attempt.finalCommit!,
      provider: "github-actions", workflowName: repository.config.delivery.featureWorkflowName, completionMode: "merge",
      mergePolicy: { headPattern: "^pirx/task-", baseBranch: repository.config.baseBranch, requiredChecks: [repository.config.delivery.featureWorkflowName], requiredApprovals: repository.config.delivery.featureRequiredApprovals, mergeMethod: repository.config.delivery.featureMergeMethod, requireMergeable: repository.config.delivery.requireMergeable },
      now, ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    });
    if (shipment.outcome !== "recovery_success") return shipmentFailure(shipment);
    if (shipment.mergeSha === undefined) return output("reconciliation_required", false, "Successful feature shipment has no exact merge revision.", { taskId: task.id, attemptId: attempt.id });
    const featurePullRequest = pullIdentity(shipment);
    if (featurePullRequest === undefined) return output("reconciliation_required", false, "Successful feature shipment has no pull request identity.", { taskId: task.id, attemptId: attempt.id });
    return this.#release(task, attempt, repository, featurePullRequest, shipment.mergeSha, now, correlationId);
  }

  async #release(task: TaskSnapshot, attempt: TerminalAttemptSnapshot, repository: HeadlessDeliveryRepositoryRuntime, featurePullRequest: ReleasePullRequestIdentity, releaseHead: string, now: UtcTimestamp, correlationId: string): Promise<HeadlessDeliveryResult> {
    const existingMembership = this.#store.releases.listByTaskAttempt(task.id, attempt.id);
    let id: ReleaseId;
    if (existingMembership.outcome === "success") {
      if (existingMembership.value.length !== 1) return output("reconciliation_required", false, "Task/Attempt belongs to multiple Releases.", { taskId: task.id, attemptId: attempt.id });
      const member = existingMembership.value[0]!;
      if (member.selectedRevision !== attempt.finalCommit || !samePull(member.featurePullRequest, featurePullRequest)) return output("reconciliation_required", false, "Durable Release membership conflicts with feature delivery evidence.", { taskId: task.id, attemptId: attempt.id });
      id = member.releaseId;
    } else if (existingMembership.outcome === "not_found") {
      id = deterministicReleaseId(task, attempt);
      const created = this.#store.releases.create({ id, repository: repository.config.repository, sourceBranch: repository.config.baseBranch, baseBranch: repository.config.delivery.releaseBranch, createdAt: attempt.endedAt });
      if (created.outcome !== "success") return output("reconciliation_required", false, created.message, { taskId: task.id, attemptId: attempt.id, releaseId: id });
      const member = this.#store.releases.addTask({ releaseId: id, taskId: task.id, attemptId: attempt.id, selectedRevision: attempt.finalCommit!, featurePullRequest, createdAt: attempt.endedAt });
      if (member.outcome !== "success") return output("reconciliation_required", false, member.message, { taskId: task.id, attemptId: attempt.id, releaseId: id });
    } else return output("reconciliation_required", false, existingMembership.message, { taskId: task.id, attemptId: attempt.id });
    const release = this.#store.releases.get(id);
    if (release.outcome !== "success") return output("reconciliation_required", false, release.message, { taskId: task.id, attemptId: attempt.id, releaseId: id });
    if (release.value.repository !== repository.config.repository || release.value.sourceBranch !== repository.config.baseBranch || release.value.baseBranch !== repository.config.delivery.releaseBranch) return output("reconciliation_required", false, "Durable Release identity conflicts with repository policy.", { taskId: task.id, attemptId: attempt.id, releaseId: id });
    if (release.value.state === "collecting") {
      const validating = this.#store.releases.transition(id, { to: "validating", expectedVersion: release.value.version, now });
      if (validating.outcome !== "success") return output("reconciliation_required", false, validating.message, { taskId: task.id, attemptId: attempt.id, releaseId: id });
    }
    const merged = await repository.releaseMerge.merge({ releaseId: id, expectedReleaseHeadSha: releaseHead, policy: { requiredChecks: repository.config.delivery.releaseRequiredChecks, requiredApprovals: repository.config.delivery.releaseRequiredApprovals, mergeMethod: repository.config.delivery.releaseMergeMethod, requireMergeable: repository.config.delivery.requireMergeable }, correlationId: `${correlationId}:release`.slice(0, 256), now, ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }) });
    if (merged.outcome !== "merged" && merged.outcome !== "replayed") return releaseFailure(task, attempt, id, merged);
    return output("release_merged", false, merged.message, { taskId: task.id, attemptId: attempt.id, releaseId: id });
  }
}
