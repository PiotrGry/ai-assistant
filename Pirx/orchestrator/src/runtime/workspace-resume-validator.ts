import { realpath, stat } from "node:fs/promises";

import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";
import { GitWorkspaceCommandRunner } from "./workspace.js";
import {
  normalizeWorkspaceOwnershipInput,
  workspaceOwnershipId,
  workspaceOwnershipRevision,
  workspaceOwnershipTimestamp,
} from "./workspace-ownership.js";
import type { RuntimeSqliteStore } from "./sqlite.js";

export const WORKSPACE_RESUME_VALIDATION_LIMITS = Object.freeze({ maxTimeoutMs: 120_000, maxObservedText: 512 } as const);

export type WorkspaceResumeValidationOutcome = "valid" | "invalid_input" | "missing_ownership" | "missing_repository" | "missing_worktree" | "missing_branch" | "branch_mismatch" | "detached" | "dirty" | "missing_commit" | "commit_mismatch" | "diverged" | "ownership_mismatch" | "stale_record" | "git_failure" | "cancelled" | "timeout" | "unknown";

export interface WorkspaceResumeValidationRequest {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repository: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly assignedBranch: string;
  readonly expectedCurrentCommit: string;
  readonly expectedOwnershipVersion: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface WorkspaceResumeValidationObserved {
  readonly repositoryRoot?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly currentCommit?: string;
}

export interface WorkspaceResumeValidationResult {
  readonly outcome: WorkspaceResumeValidationOutcome;
  readonly message: string;
  readonly observed?: WorkspaceResumeValidationObserved;
}

function message(value: string): string { return value.slice(0, 256); }
function result(outcome: WorkspaceResumeValidationOutcome, text: string, observed?: WorkspaceResumeValidationObserved): WorkspaceResumeValidationResult {
  return { outcome, message: message(text), ...(observed === undefined ? {} : { observed }) };
}
function validTimeout(value: number | undefined): number | undefined {
  const timeout = value ?? 30_000;
  return Number.isSafeInteger(timeout) && timeout > 0 && timeout <= WORKSPACE_RESUME_VALIDATION_LIMITS.maxTimeoutMs ? timeout : undefined;
}
function invalidRequest(value: WorkspaceResumeValidationRequest): WorkspaceResumeValidationResult | undefined {
  try {
    workspaceOwnershipId(value.taskId, "Task ID");
    workspaceOwnershipId(value.attemptId, "Attempt ID");
    workspaceOwnershipRevision(value.expectedCurrentCommit, "Expected current commit");
    if (!Number.isSafeInteger(value.expectedOwnershipVersion) || value.expectedOwnershipVersion <= 0) throw new Error("Expected ownership version is invalid.");
    if (validTimeout(value.timeoutMs) === undefined) throw new Error("Workspace validation timeout is invalid.");
    normalizeWorkspaceOwnershipInput({ taskId: value.taskId, attemptId: value.attemptId, repository: value.repository, repositoryRoot: value.repositoryRoot, assignedBranch: value.assignedBranch, worktreePath: value.worktreePath, expectedBaseRevision: "0000", acquiredAt: "2026-01-01T00:00:00.000Z" as UtcTimestamp });
    return undefined;
  } catch (error: unknown) { return result("invalid_input", error instanceof Error ? error.message : "Workspace validation input is invalid."); }
}
function observed(value: Partial<WorkspaceResumeValidationObserved>): WorkspaceResumeValidationObserved | undefined {
  const entries = Object.entries(value).filter(([, item]) => typeof item === "string" && item.length <= WORKSPACE_RESUME_VALIDATION_LIMITS.maxObservedText) as Array<[keyof WorkspaceResumeValidationObserved, string]>;
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries) as WorkspaceResumeValidationObserved);
}
function commandFailure(command: { readonly outcome: "success" | "git_failure" | "cancelled" | "timeout" | "unknown" }, text: string, details: Partial<WorkspaceResumeValidationObserved> = {}): WorkspaceResumeValidationResult | undefined {
  if (command.outcome === "cancelled") return result("cancelled", "Workspace validation was cancelled.", observed(details));
  if (command.outcome === "timeout") return result("timeout", `${text} timed out.`, observed(details));
  if (command.outcome === "unknown") return result("unknown", `${text} returned an unknown result.`, observed(details));
  if (command.outcome === "git_failure") return result("git_failure", `${text} failed.`, observed(details));
  return undefined;
}

interface WorktreeEntry { readonly path: string; readonly head?: string; readonly branch?: string; }
function parseWorktrees(value: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  const flush = () => { if (current.path !== undefined) entries.push({ path: current.path, ...(current.head === undefined ? {} : { head: current.head }), ...(current.branch === undefined ? {} : { branch: current.branch }) }); current = {}; };
  for (const line of value.split("\n")) {
    if (line.startsWith("worktree ")) { flush(); current.path = line.slice("worktree ".length).trim(); }
    else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim();
  }
  flush();
  return entries;
}

export class WorkspaceResumeValidator {
  readonly #store: RuntimeSqliteStore;
  readonly #git: GitWorkspaceCommandRunner;

  public constructor(store: RuntimeSqliteStore, git = new GitWorkspaceCommandRunner()) {
    this.#store = store;
    this.#git = git;
  }

  public async validate(request: WorkspaceResumeValidationRequest): Promise<WorkspaceResumeValidationResult> {
    const invalid = invalidRequest(request);
    if (invalid !== undefined) return invalid;
    const normalized = normalizeWorkspaceOwnershipInput({ taskId: request.taskId, attemptId: request.attemptId, repository: request.repository, repositoryRoot: request.repositoryRoot, assignedBranch: request.assignedBranch, worktreePath: request.worktreePath, expectedBaseRevision: "0000", acquiredAt: "2026-01-01T00:00:00.000Z" as UtcTimestamp });
    const expectedCommit = workspaceOwnershipRevision(request.expectedCurrentCommit, "Expected current commit");
    const ownership = this.#store.workspaces.getByTaskAttempt(request.taskId, request.attemptId);
    if (ownership.outcome === "not_found") return result("missing_ownership", "Durable workspace ownership was not found.");
    if (ownership.outcome !== "success") return result("unknown", "Durable workspace ownership could not be read.");
    const record = ownership.value;
    if (record.state !== "active") return result("ownership_mismatch", "Workspace ownership is not active.");
    if (record.version !== request.expectedOwnershipVersion) return result("stale_record", "Workspace ownership version is stale.");
    if (record.repository !== normalized.repository || record.repositoryRoot !== normalized.repositoryRoot || record.worktreePath !== normalized.worktreePath || record.assignedBranch !== normalized.assignedBranch || record.currentRevision !== expectedCommit) return result("ownership_mismatch", "Requested workspace does not match durable ownership.");
    let repositoryRoot: string;
    try { repositoryRoot = await realpath(normalized.repositoryRoot); const info = await stat(repositoryRoot); if (!info.isDirectory()) return result("missing_repository", "The recorded repository is not a directory."); }
    catch { return result("missing_repository", "The recorded repository is missing or inaccessible."); }
    if (repositoryRoot !== normalized.repositoryRoot) return result("ownership_mismatch", "The repository path is not the canonical path recorded for the workspace.");
    let worktreePath: string;
    try { worktreePath = await realpath(normalized.worktreePath); const info = await stat(worktreePath); if (!info.isDirectory()) return result("missing_worktree", "The recorded worktree is not a directory."); }
    catch { return result("missing_worktree", "The recorded worktree is missing or inaccessible."); }
    if (worktreePath !== normalized.worktreePath) return result("ownership_mismatch", "The worktree path is not the canonical path recorded for the workspace.");
    const commonObserved = { repositoryRoot, worktreePath };
    const top = await this.#git.run(["rev-parse", "--show-toplevel"], worktreePath, validTimeout(request.timeoutMs)!, request.signal);
    const topFailure = commandFailure(top, "Worktree root validation", commonObserved); if (topFailure !== undefined) return topFailure;
    if (top.stdout.trim() !== worktreePath) return result("ownership_mismatch", "Git resolved the worktree to a different path.", observed(commonObserved));
    const listed = await this.#git.run(["worktree", "list", "--porcelain"], repositoryRoot, validTimeout(request.timeoutMs)!, request.signal);
    const listedFailure = commandFailure(listed, "Registered worktree validation", commonObserved); if (listedFailure !== undefined) return listedFailure;
    const entry = parseWorktrees(listed.stdout).find((item) => item.path === worktreePath);
    if (entry === undefined) return result("missing_worktree", "The worktree is not registered under the recorded repository.", observed(commonObserved));
    const branch = await this.#git.run(["symbolic-ref", "--short", "HEAD"], worktreePath, validTimeout(request.timeoutMs)!, request.signal);
    if (branch.outcome === "cancelled") return result("cancelled", "Workspace validation was cancelled.", observed(commonObserved));
    if (branch.outcome === "timeout") return result("timeout", "Branch validation timed out.", observed(commonObserved));
    if (branch.outcome !== "success") return result("detached", "The worktree HEAD is detached.", observed(commonObserved));
    if (branch.stdout.trim() !== normalized.assignedBranch) return result("branch_mismatch", "The checked out branch differs from the assigned branch.", observed({ ...commonObserved, branch: branch.stdout.trim() }));
    if (entry.branch === undefined) return result("missing_branch", "The registered worktree has no branch reference.", observed(commonObserved));
    if (entry.branch !== `refs/heads/${normalized.assignedBranch}`) return result("branch_mismatch", "The registered worktree branch differs from the assigned branch.", observed({ ...commonObserved, branch: entry.branch }));
    const head = await this.#git.run(["rev-parse", "HEAD"], worktreePath, validTimeout(request.timeoutMs)!, request.signal);
    const headFailure = commandFailure(head, "Current commit validation", { ...commonObserved, branch: normalized.assignedBranch }); if (headFailure !== undefined) return headFailure;
    const currentCommit = head.stdout.trim().toLowerCase();
    if (currentCommit.length === 0) return result("missing_commit", "The worktree has no current commit.", observed({ ...commonObserved, branch: normalized.assignedBranch }));
    if (currentCommit !== expectedCommit || entry.head?.toLowerCase() !== expectedCommit) return result("commit_mismatch", "The worktree commit differs from the expected durable commit.", observed({ ...commonObserved, branch: normalized.assignedBranch, currentCommit }));
    const base = await this.#git.run(["merge-base", "--is-ancestor", record.expectedBaseRevision, currentCommit], repositoryRoot, validTimeout(request.timeoutMs)!, request.signal);
    if (base.outcome === "cancelled") return result("cancelled", "Workspace validation was cancelled.", observed({ ...commonObserved, branch: normalized.assignedBranch, currentCommit }));
    if (base.outcome === "timeout") return result("timeout", "Base relation validation timed out.", observed({ ...commonObserved, branch: normalized.assignedBranch, currentCommit }));
    if (base.outcome === "unknown" || base.outcome === "git_failure") return base.exitCode === 1 ? result("diverged", "The workspace commit diverged from the recorded base.", observed({ ...commonObserved, branch: normalized.assignedBranch, currentCommit })) : result("git_failure", "Base relation validation failed.", observed({ ...commonObserved, branch: normalized.assignedBranch, currentCommit }));
    const status = await this.#git.run(["status", "--porcelain=v1", "--untracked-files=all"], worktreePath, validTimeout(request.timeoutMs)!, request.signal);
    const statusFailure = commandFailure(status, "Workspace cleanliness validation", { ...commonObserved, branch: normalized.assignedBranch, currentCommit }); if (statusFailure !== undefined) return statusFailure;
    if (status.stdout.length > 0) return result("dirty", "The worktree contains uncommitted or untracked changes.", observed({ ...commonObserved, branch: normalized.assignedBranch, currentCommit }));
    return result("valid", "The durable workspace and observed Git state match exactly.", observed({ ...commonObserved, branch: normalized.assignedBranch, currentCommit }));
  }
}

export function validateWorkspaceForResume(validator: WorkspaceResumeValidator, request: WorkspaceResumeValidationRequest): Promise<WorkspaceResumeValidationResult> {
  return validator.validate(request);
}
