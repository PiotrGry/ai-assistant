import { createHash } from "node:crypto";

import type { GitHubIssueRef, GitHubIssueSummary } from "../github/issue-read.js";
import type { GitHubOperationResult } from "../github/outcome.js";
import type { GitHubProjectItem, GitHubProjectMetadata, GitHubProjectResult } from "../github/project-sync.js";
import type { RuntimeSqliteStore } from "./sqlite.js";
import type { UtcTimestamp } from "./task-domain.js";

export const WORK_INTAKE_SCHEMA_VERSION = 1 as const;
export const WORK_INTAKE_STATES = Object.freeze(["accepted", "linking", "linked", "rejected", "uncertain"] as const);
export type WorkIntakeState = (typeof WORK_INTAKE_STATES)[number];
export interface WorkIntakeRecord {
  readonly schemaVersion: typeof WORK_INTAKE_SCHEMA_VERSION;
  readonly id: string;
  readonly operationId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly risk: "Low" | "Medium" | "High" | "Prod-sensitive";
  readonly area: string;
  readonly workType: "Task" | "Bug" | "Experiment";
  readonly queueOrder: number;
  readonly state: WorkIntakeState;
  readonly issueNodeId?: string;
  readonly taskId?: string;
  readonly acceptedAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly version: number;
  readonly lastError?: string;
  readonly contentHash: string;
}
export interface WorkIntakeInput {
  readonly operationId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly priority: WorkIntakeRecord["priority"];
  readonly risk: WorkIntakeRecord["risk"];
  readonly area: string;
  readonly workType: WorkIntakeRecord["workType"];
  readonly queueOrder: number;
  readonly acceptedAt: UtcTimestamp;
}
export interface WorkIntakeTransition {
  readonly id: string;
  readonly expectedVersion: number;
  readonly state: WorkIntakeState;
  readonly updatedAt: UtcTimestamp;
  readonly issueNodeId?: string;
  readonly taskId?: string;
  readonly lastError?: string;
}

export function workIntakeId(operationId: string): string {
  return `intake:${createHash("sha256").update(operationId).digest("hex").slice(0, 48)}`;
}

export interface WorkIntakeIssuePort {
  getIssue(issueNumber: number, options?: { readonly correlationId?: string }): Promise<GitHubOperationResult<GitHubIssueSummary>>;
}
export interface WorkIntakeProjectPort {
  synchronize(issue: GitHubIssueRef, metadata: GitHubProjectMetadata, options?: { readonly correlationId?: string }): Promise<GitHubProjectResult<GitHubProjectItem>>;
}
export interface WorkIntakeRepositoryGateway {
  readonly reader: WorkIntakeIssuePort;
  readonly project: WorkIntakeProjectPort;
}
export type WorkIntakeReconcileResult =
  | { readonly outcome: "idle"; readonly processed: 0 }
  | { readonly outcome: "processed"; readonly processed: number; readonly linked: number; readonly pending: number }
  | { readonly outcome: "retryable"; readonly processed: number; readonly linked: number; readonly pending: number; readonly message: string }
  | { readonly outcome: "storage_error"; readonly processed: number; readonly linked: number; readonly pending: number; readonly message: string };

function issueMatches(record: WorkIntakeRecord, issue: GitHubIssueSummary): boolean {
  if (issue.state !== "open" || issue.number !== record.issueNumber || `${issue.owner}/${issue.repository}` !== record.repository || issue.body === undefined) return false;
  const normalized = issue.body.replace(/\r\n/gu, "\n");
  return normalized.includes(`## Goal\n\n${record.goal}`) && record.acceptanceCriteria.every((criterion) => normalized.includes(`- [ ] ${criterion}`) || normalized.includes(`- [x] ${criterion}`) || normalized.includes(`- [X] ${criterion}`));
}

function projectMetadata(record: WorkIntakeRecord): GitHubProjectMetadata {
  return { status: "Todo", priority: record.priority, worker: "Pirx", area: record.area, risk: record.risk, workType: record.workType, queueOrder: record.queueOrder };
}

function boundedError(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256); }

export class WorkIntakeCoordinator {
  readonly #store: RuntimeSqliteStore;
  readonly #gateways: ReadonlyMap<string, WorkIntakeRepositoryGateway>;
  readonly #now: () => UtcTimestamp;
  public constructor(store: RuntimeSqliteStore, gateways: ReadonlyMap<string, WorkIntakeRepositoryGateway>, options: { readonly now?: () => UtcTimestamp } = {}) {
    this.#store = store; this.#gateways = gateways; this.#now = options.now ?? (() => new Date().toISOString() as UtcTimestamp);
  }

  public async reconcile(limit = 10): Promise<WorkIntakeReconcileResult> {
    const pending = this.#store.workIntakes.listPending(limit);
    if (pending.outcome !== "success") return { outcome: "storage_error", processed: 0, linked: 0, pending: 0, message: pending.message };
    if (pending.value.length === 0) return { outcome: "idle", processed: 0 };
    let processed = 0; let linked = 0; let retryable: string | undefined;
    for (const intake of pending.value) {
      const task = this.#store.tasks.getByIssue({ owner: intake.repository.split("/")[0]!, repository: intake.repository.split("/")[1]!, issueNumber: intake.issueNumber });
      if (task.outcome === "success") {
        const nodeId = task.value.githubReference?.nodeId;
        if (nodeId === undefined) return { outcome: "storage_error", processed, linked, pending: pending.value.length - processed, message: "Linked runtime Task has no canonical Issue node identity." };
        const updated = this.#store.workIntakes.transition({ id: intake.id, expectedVersion: intake.version, state: "linked", updatedAt: this.#now(), issueNodeId: nodeId, taskId: task.value.id });
        if (updated.outcome !== "success") return { outcome: "storage_error", processed, linked, pending: pending.value.length - processed, message: updated.message };
        processed += 1; linked += 1; continue;
      }
      if (task.outcome !== "not_found") return { outcome: "storage_error", processed, linked, pending: pending.value.length - processed, message: task.message };
      const gateway = this.#gateways.get(intake.repository);
      if (gateway === undefined) {
        const rejected = this.#store.workIntakes.transition({ id: intake.id, expectedVersion: intake.version, state: "rejected", updatedAt: this.#now(), lastError: "Repository is outside the daemon allowlist." });
        if (rejected.outcome !== "success") return { outcome: "storage_error", processed, linked, pending: pending.value.length - processed, message: rejected.message };
        processed += 1; continue;
      }
      const issue = await gateway.reader.getIssue(intake.issueNumber, { correlationId: intake.id });
      if (issue.outcome !== "success") {
        const nextState = issue.remoteOutcome === "unknown" ? "uncertain" : issue.outcome === "permanent_error" ? "rejected" : intake.state;
        const updated = this.#store.workIntakes.transition({ id: intake.id, expectedVersion: intake.version, state: nextState, updatedAt: this.#now(), lastError: boundedError(issue.error.message) });
        if (updated.outcome !== "success") return { outcome: "storage_error", processed, linked, pending: pending.value.length - processed, message: updated.message };
        processed += 1; retryable ??= boundedError(issue.error.message); continue;
      }
      if (!issueMatches(intake, issue.value)) {
        const rejected = this.#store.workIntakes.transition({ id: intake.id, expectedVersion: intake.version, state: "rejected", updatedAt: this.#now(), issueNodeId: issue.value.nodeId, lastError: "Issue scope does not match the accepted intake." });
        if (rejected.outcome !== "success") return { outcome: "storage_error", processed, linked, pending: pending.value.length - processed, message: rejected.message };
        processed += 1; continue;
      }
      const project = await gateway.project.synchronize(issue.value, projectMetadata(intake), { correlationId: intake.id });
      const accepted = project.outcome === "synchronized" || project.outcome === "no_op";
      const nextState: WorkIntakeState = accepted ? "linking" : project.outcome === "unknown" || project.outcome === "partial" ? "uncertain" : ["not_found", "schema_drift", "mapping_error", "invalid_request"].includes(project.outcome) ? "rejected" : intake.state;
      const updated = this.#store.workIntakes.transition({ id: intake.id, expectedVersion: intake.version, state: nextState, updatedAt: this.#now(), issueNodeId: issue.value.nodeId, ...(accepted ? {} : { lastError: boundedError(project.message) }) });
      if (updated.outcome !== "success") return { outcome: "storage_error", processed, linked, pending: pending.value.length - processed, message: updated.message };
      processed += 1;
      if (!accepted && nextState !== "rejected") retryable ??= boundedError(project.message);
    }
    const remaining = this.#store.workIntakes.listPending(limit);
    const remainingCount = remaining.outcome === "success" ? remaining.value.length : 0;
    return retryable === undefined ? { outcome: "processed", processed, linked, pending: remainingCount } : { outcome: "retryable", processed, linked, pending: remainingCount, message: retryable };
  }
}

export interface WorkIntakeQueuePort {
  reconcile(): Promise<{ readonly outcome: string; readonly message?: string }>;
}

/** Runs durable intake projection before the single existing GitHub Queue projection. */
export class WorkIntakeQueueReconciler implements WorkIntakeQueuePort {
  public constructor(
    private readonly intake: WorkIntakeCoordinator,
    private readonly queue: WorkIntakeQueuePort,
  ) {}

  public async reconcile(): Promise<{ readonly outcome: string; readonly message?: string }> {
    const intake = await this.intake.reconcile();
    const queue = await this.queue.reconcile();
    if (queue.outcome !== "synchronized") return queue;
    if (intake.outcome === "storage_error" || intake.outcome === "retryable") {
      return { ...queue, message: `Queue synchronized; work intake remains pending: ${intake.message}` };
    }
    return queue;
  }
}
