import { isAbsolute, normalize, resolve } from "node:path";

import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";

export const WORKSPACE_OWNERSHIP_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_OWNERSHIP_LIMITS = Object.freeze({
  id: 128,
  repository: 512,
  repositoryRoot: 2_048,
  branch: 512,
  worktree: 2_048,
  revision: 64,
  token: 128,
} as const);

export type WorkspaceOwnershipState = "active" | "released";

export interface WorkspaceOwnershipInput {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repository: string;
  readonly repositoryRoot: string;
  readonly assignedBranch: string;
  readonly worktreePath: string;
  readonly expectedBaseRevision: string;
  readonly acquiredAt: UtcTimestamp;
}

export interface WorkspaceOwnershipRecord extends WorkspaceOwnershipInput {
  readonly schemaVersion: typeof WORKSPACE_OWNERSHIP_SCHEMA_VERSION;
  readonly currentRevision: string;
  readonly state: WorkspaceOwnershipState;
  readonly version: number;
  readonly ownershipToken: string;
  readonly releasedAt?: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface WorkspaceOwnershipTransferInput {
  readonly taskId: TaskId;
  readonly fromAttemptId: AttemptId;
  readonly toAttemptId: AttemptId;
  readonly transferredAt: UtcTimestamp;
}

export type WorkspaceOwnershipMutationResult =
  | { readonly ok: true; readonly value: WorkspaceOwnershipRecord }
  | { readonly ok: false; readonly code: "invalid_input" | "conflict"; readonly message: string };

export function workspaceOwnershipId(value: unknown, label = "workspace identity"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

export function workspaceOwnershipTimestamp(value: unknown, label: string): UtcTimestamp {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return value as UtcTimestamp;
}

export function workspaceOwnershipRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{4,64}$/iu.test(value)) throw new Error(`${label} is invalid.`);
  return value.toLowerCase();
}

function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function branch(value: unknown): string {
  const normalized = bounded(value, WORKSPACE_OWNERSHIP_LIMITS.branch, "Assigned branch");
  if (normalized.startsWith("-") || normalized.includes("..") || /[~^:?*[\\\s]/u.test(normalized) || normalized.endsWith("/") || normalized.endsWith(".")) throw new Error("Assigned branch is invalid.");
  return normalized;
}

function absolutePath(value: unknown, max: number, label: string): string {
  const candidate = bounded(value, max, label);
  if (!isAbsolute(candidate)) throw new Error(`${label} must be absolute.`);
  if (/(?:^|[\\/])\.\.?(?=$|[\\/])/u.test(candidate)) throw new Error(`${label} must not contain traversal segments.`);
  return normalize(resolve(candidate));
}

export function normalizeWorkspaceOwnershipInput(value: WorkspaceOwnershipInput): WorkspaceOwnershipInput {
  return Object.freeze({
    taskId: workspaceOwnershipId(value.taskId, "Task ID") as TaskId,
    attemptId: workspaceOwnershipId(value.attemptId, "Attempt ID") as AttemptId,
    repository: bounded(value.repository, WORKSPACE_OWNERSHIP_LIMITS.repository, "Repository identity"),
    repositoryRoot: absolutePath(value.repositoryRoot, WORKSPACE_OWNERSHIP_LIMITS.repositoryRoot, "Repository root"),
    assignedBranch: branch(value.assignedBranch),
    worktreePath: absolutePath(value.worktreePath, WORKSPACE_OWNERSHIP_LIMITS.worktree, "Worktree path"),
    expectedBaseRevision: workspaceOwnershipRevision(value.expectedBaseRevision, "Expected base revision"),
    acquiredAt: workspaceOwnershipTimestamp(value.acquiredAt, "Acquired timestamp"),
  });
}

export function workspaceOwnershipMatches(record: WorkspaceOwnershipRecord, input: WorkspaceOwnershipInput): boolean {
  return record.taskId === input.taskId && record.attemptId === input.attemptId && record.repository === input.repository && record.repositoryRoot === input.repositoryRoot && record.assignedBranch === input.assignedBranch && record.worktreePath === input.worktreePath && record.expectedBaseRevision === input.expectedBaseRevision;
}

export function validateWorkspaceOwnershipRecord(value: WorkspaceOwnershipRecord): boolean {
  try {
    const normalized = normalizeWorkspaceOwnershipInput(value);
    const currentRevision = workspaceOwnershipRevision(value.currentRevision, "Current revision");
    bounded(value.ownershipToken, WORKSPACE_OWNERSHIP_LIMITS.token, "Ownership token");
    if (value.schemaVersion !== WORKSPACE_OWNERSHIP_SCHEMA_VERSION || !Number.isSafeInteger(value.version) || value.version <= 0 || (value.state !== "active" && value.state !== "released")) return false;
    workspaceOwnershipTimestamp(value.updatedAt, "Updated timestamp");
    if (value.releasedAt !== undefined) workspaceOwnershipTimestamp(value.releasedAt, "Released timestamp");
    return value.taskId === normalized.taskId && value.attemptId === normalized.attemptId && value.repository === normalized.repository && value.repositoryRoot === normalized.repositoryRoot && value.assignedBranch === normalized.assignedBranch && value.worktreePath === normalized.worktreePath && value.expectedBaseRevision === normalized.expectedBaseRevision && value.acquiredAt === normalized.acquiredAt && value.currentRevision === currentRevision && (value.state === "released" ? value.releasedAt !== undefined : value.releasedAt === undefined);
  } catch {
    return false;
  }
}
