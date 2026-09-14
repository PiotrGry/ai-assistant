import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";

export const RELEASE_SCHEMA_VERSION = 1 as const;
export type ReleaseId = string & { readonly __releaseId: unique symbol };
export type ReleaseState = "collecting" | "validating" | "ready_to_merge" | "merging" | "deploying" | "production_verification" | "deployed" | "failed" | "blocked" | "human_action_required" | "rolled_back";

export const RELEASE_STATES = Object.freeze([
  "collecting", "validating", "ready_to_merge", "merging", "deploying", "production_verification", "deployed", "failed", "blocked", "human_action_required", "rolled_back",
] as const);

export const RELEASE_TRANSITIONS: Readonly<Record<ReleaseState, readonly ReleaseState[]>> = Object.freeze({
  collecting: ["validating", "blocked", "failed", "human_action_required"],
  validating: ["ready_to_merge", "blocked", "failed", "human_action_required"],
  ready_to_merge: ["merging", "blocked", "failed", "human_action_required"],
  merging: ["deploying", "blocked", "failed", "human_action_required"],
  deploying: ["production_verification", "blocked", "failed", "human_action_required"],
  production_verification: ["deployed", "blocked", "failed", "human_action_required"],
  deployed: ["rolled_back", "human_action_required"],
  failed: ["validating", "human_action_required"],
  blocked: ["validating", "human_action_required"],
  human_action_required: ["validating", "blocked", "failed"],
  rolled_back: ["validating", "human_action_required"],
});

export interface ReleasePullRequestIdentity {
  readonly nodeId: string;
  readonly number: number;
  readonly url: string;
}

export interface ReleaseRecord {
  readonly schemaVersion: typeof RELEASE_SCHEMA_VERSION;
  readonly id: ReleaseId;
  readonly repository: string;
  readonly sourceBranch: string;
  readonly baseBranch: string;
  readonly state: ReleaseState;
  readonly version: number;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly releasePullRequest?: ReleasePullRequestIdentity;
  readonly mergeRevision?: string;
  readonly deploymentProviderId?: string;
  readonly productionVersion?: string;
  readonly failureReason?: string;
}

export interface ReleaseInput {
  readonly id: ReleaseId;
  readonly repository: string;
  readonly sourceBranch: string;
  readonly baseBranch: string;
  readonly createdAt: UtcTimestamp;
}

export interface ReleaseTaskRecord {
  readonly releaseId: ReleaseId;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly selectedRevision: string;
  readonly featurePullRequest?: ReleasePullRequestIdentity;
  readonly createdAt: UtcTimestamp;
}

export interface ReleaseTaskInput extends ReleaseTaskRecord {}
export interface ReleaseTransitionInput {
  readonly to: ReleaseState;
  readonly expectedVersion: number;
  readonly now: UtcTimestamp;
  readonly failureReason?: string;
  readonly releasePullRequest?: ReleasePullRequestIdentity;
  readonly mergeRevision?: string;
  readonly deploymentProviderId?: string;
  readonly productionVersion?: string;
}

export interface ReleaseRecoveryRecord {
  readonly releaseId: ReleaseId;
  readonly state: ReleaseState;
  readonly version: number;
  readonly updatedAt: UtcTimestamp;
}

export function releaseId(value: string): ReleaseId {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error("Release ID is invalid.");
  return value as ReleaseId;
}
export function releaseTimestamp(value: string): UtcTimestamp {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Release timestamp must be canonical UTC.");
  return value as UtcTimestamp;
}
export function releaseText(value: string, field: string, max = 512): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) throw new Error(`${field} is invalid.`);
  return normalized;
}
export function validatePullRequest(value: ReleasePullRequestIdentity): ReleasePullRequestIdentity {
  const nodeId = releaseText(value.nodeId, "pull request node ID", 256);
  const url = releaseText(value.url, "pull request URL", 2_048);
  if (!Number.isSafeInteger(value.number) || value.number <= 0) throw new Error("Pull request number is invalid.");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || !new RegExp(`^/[^/]+/[^/]+/pull/${String(value.number)}$`, "u").test(parsed.pathname)) throw new Error("Pull request URL is invalid.");
  return Object.freeze({ nodeId, number: value.number, url });
}
export function validateReleaseInput(input: ReleaseInput): ReleaseInput {
  releaseId(input.id);
  releaseText(input.repository, "repository");
  const sourceBranch = releaseText(input.sourceBranch, "source branch");
  const baseBranch = releaseText(input.baseBranch, "base branch");
  if (sourceBranch === baseBranch) throw new Error("Release source and base branches must differ.");
  releaseTimestamp(input.createdAt);
  return input;
}
export function validateReleaseTaskInput(input: ReleaseTaskInput): ReleaseTaskInput {
  releaseId(input.releaseId);
  releaseText(input.taskId, "Task ID", 128);
  releaseText(input.attemptId, "Attempt ID", 128);
  releaseText(input.selectedRevision, "selected revision", 256);
  releaseTimestamp(input.createdAt);
  if (input.featurePullRequest !== undefined) validatePullRequest(input.featurePullRequest);
  return input;
}
export function validateTransition(input: ReleaseTransitionInput): ReleaseTransitionInput {
  if (!RELEASE_STATES.includes(input.to)) throw new Error("Release state is invalid.");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) throw new Error("Release version is invalid.");
  releaseTimestamp(input.now);
  if (input.failureReason !== undefined) releaseText(input.failureReason, "failure reason", 1_000);
  if (input.releasePullRequest !== undefined) validatePullRequest(input.releasePullRequest);
  const optionalFields: Array<[string | undefined, string]> = [[input.mergeRevision, "merge revision"], [input.deploymentProviderId, "deployment provider ID"], [input.productionVersion, "production version"]];
  for (const [value, field] of optionalFields) if (value !== undefined) releaseText(value, field);
  return input;
}
