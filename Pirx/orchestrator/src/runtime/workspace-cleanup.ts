import { realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { GitWorkspaceCommandRunner, WORKSPACE_PROVISION_LIMITS } from "./workspace.js";
import { workspaceOwnershipTimestamp } from "./workspace-ownership.js";
import type { RuntimeSqliteStore } from "./sqlite.js";
import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";

export const WORKSPACE_CLEANUP_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_CLEANUP_LIMITS = Object.freeze({ remote: 128, timeoutMs: WORKSPACE_PROVISION_LIMITS.timeoutMs } as const);
export type WorkspaceCleanupDisposition = "task_completed" | "attempt_abandoned";
export type WorkspaceCleanupOutcome = "removed" | "already_removed" | "protected_dirty" | "protected_diverged" | "not_eligible" | "not_found" | "conflict" | "git_failure" | "cancelled" | "timeout" | "reconciliation_required" | "invalid_request";

export interface WorkspaceCleanupRequest { readonly taskId: TaskId; readonly attemptId: AttemptId; readonly disposition: WorkspaceCleanupDisposition; readonly remoteName?: string; readonly now: UtcTimestamp; readonly timeoutMs?: number; readonly signal?: AbortSignal; }
export interface WorkspaceCleanupResult { readonly schemaVersion: typeof WORKSPACE_CLEANUP_SCHEMA_VERSION; readonly outcome: WorkspaceCleanupOutcome; readonly taskId: TaskId; readonly attemptId: AttemptId; readonly message: string; readonly worktreePath?: string; readonly assignedBranch?: string; readonly revision?: string; readonly checks: readonly string[]; }
interface WorktreeEntry { readonly path: string; readonly head?: string; readonly branch?: string; }

function parseWorktrees(value: string): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = []; let current: { path?: string; head?: string; branch?: string } = {};
  for (const line of value.split(/\r?\n/u)) {
    if (line === "") { if (current.path !== undefined) entries.push(current as WorktreeEntry); current = {}; }
    else if (line.startsWith("worktree ")) current.path = resolve(line.slice(9));
    else if (line.startsWith("HEAD ")) current.head = line.slice(5).trim().toLowerCase();
    else if (line.startsWith("branch refs/heads/")) current.branch = line.slice(18);
  }
  if (current.path !== undefined) entries.push(current as WorktreeEntry);
  return Object.freeze(entries);
}
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value); }
function validRemote(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value); }
function boundedTimeout(value: number | undefined): number | undefined { const timeout = value ?? 30_000; return Number.isSafeInteger(timeout) && timeout > 0 && timeout <= WORKSPACE_CLEANUP_LIMITS.timeoutMs ? timeout : undefined; }
function commandOutcome(value: "success" | "git_failure" | "cancelled" | "timeout" | "unknown"): WorkspaceCleanupOutcome { return value === "success" || value === "unknown" ? "reconciliation_required" : value; }
function sanitized(value: string): string { return value.replace(/(?:bearer\s+|authorization\s*:\s*|password\s*=|token\s*=|secret\s*=)[^\s\r\n]+/giu, "[REDACTED]").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 512); }
function missing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
function output(request: WorkspaceCleanupRequest, outcome: WorkspaceCleanupOutcome, message: string, checks: readonly string[], identity?: { readonly worktreePath: string; readonly assignedBranch: string; readonly revision: string }): WorkspaceCleanupResult { return Object.freeze({ schemaVersion: 1, outcome, taskId: request.taskId, attemptId: request.attemptId, message: sanitized(message), ...(identity === undefined ? {} : identity), checks: Object.freeze([...checks]) }); }

export class WorkspaceCleanupCoordinator {
  readonly #store: RuntimeSqliteStore; readonly #git: GitWorkspaceCommandRunner; readonly #locks = new Map<string, Promise<WorkspaceCleanupResult>>();
  public constructor(store: RuntimeSqliteStore, git = new GitWorkspaceCommandRunner()) { this.#store = store; this.#git = git; }
  public cleanup(request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResult> {
    if (!validId(request.taskId) || !validId(request.attemptId) || !["task_completed", "attempt_abandoned"].includes(request.disposition)) return Promise.resolve(output(request, "invalid_request", "Workspace cleanup identity or disposition is invalid.", []));
    try { workspaceOwnershipTimestamp(request.now, "Cleanup timestamp"); } catch { return Promise.resolve(output(request, "invalid_request", "Workspace cleanup timestamp is invalid.", [])); }
    if (boundedTimeout(request.timeoutMs) === undefined || (request.remoteName !== undefined && !validRemote(request.remoteName))) return Promise.resolve(output(request, "invalid_request", "Workspace cleanup timeout or remote is invalid.", []));
    const key = `${request.taskId}\u0000${request.attemptId}`; const previous = this.#locks.get(key) ?? Promise.resolve(output(request, "reconciliation_required", "unused", []));
    const current = previous.catch(() => output(request, "reconciliation_required", "Prior workspace cleanup failed.", [])).then(() => this.#cleanup(request)); this.#locks.set(key, current);
    void current.finally(() => { if (this.#locks.get(key) === current) this.#locks.delete(key); }); return current;
  }
  async #cleanup(request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResult> {
    const ownership = this.#store.workspaces.getByTaskAttempt(request.taskId, request.attemptId);
    if (ownership.outcome === "not_found") return output(request, "not_found", ownership.message, []);
    if (ownership.outcome !== "success") return output(request, ownership.outcome === "conflict" ? "conflict" : "reconciliation_required", ownership.message, []);
    const identity = { worktreePath: ownership.value.worktreePath, assignedBranch: ownership.value.assignedBranch, revision: ownership.value.currentRevision }; const checks: string[] = ["durable_ownership"];
    if (ownership.value.state === "released") return output(request, "already_removed", "Workspace cleanup was already durably completed.", [...checks, "ownership_released"], identity);
    const task = this.#store.tasks.get(request.taskId); const attempt = this.#store.attempts.get(request.attemptId);
    if (task.outcome !== "success" || attempt.outcome !== "success" || attempt.value.taskId !== request.taskId) return output(request, "reconciliation_required", "Task or Attempt evidence is unavailable.", checks, identity);
    if (attempt.value.state !== "terminal") return output(request, "not_eligible", "A running Attempt workspace cannot be cleaned.", checks, identity);
    if (request.disposition === "task_completed") {
      if (task.value.state !== "completed" || task.value.completionEvidence?.attemptId !== request.attemptId || task.value.completionEvidence.finalCommit !== ownership.value.currentRevision || attempt.value.result !== "CODE_PUSHED" || attempt.value.finalCommit !== ownership.value.currentRevision) return output(request, "not_eligible", "Completed cleanup requires exact Task, Attempt, commit, and ownership evidence.", checks, identity);
    } else if (task.value.state !== "cancelled" || attempt.value.result !== "CANCELLED") return output(request, "not_eligible", "Abandoned cleanup requires an explicitly cancelled Task and Attempt.", checks, identity);
    checks.push("terminal_disposition");
    let root: string; try { root = await realpath(ownership.value.repositoryRoot); if (root !== ownership.value.repositoryRoot) return output(request, "conflict", "Repository root no longer matches durable ownership.", checks, identity); } catch { return output(request, "reconciliation_required", "Repository root is unavailable.", checks, identity); }
    let canonical: string;
    try { canonical = await realpath(ownership.value.worktreePath); }
    catch (error: unknown) {
      if (!missing(error)) return output(request, "reconciliation_required", "Worktree cannot be resolved safely.", checks, identity);
      try { canonical = resolve(await realpath(dirname(ownership.value.worktreePath)), basename(ownership.value.worktreePath)); }
      catch { return output(request, "reconciliation_required", "Worktree parent cannot be resolved safely.", checks, identity); }
    }
    const timeout = boundedTimeout(request.timeoutMs)!; const listed = await this.#git.run(["worktree", "list", "--porcelain"], root, timeout, request.signal);
    if (listed.outcome !== "success") return output(request, commandOutcome(listed.outcome), "Registered worktrees could not be inspected.", checks, identity);
    const entry = parseWorktrees(listed.stdout).find((item) => item.path === canonical); let pathExists = true;
    try { await stat(ownership.value.worktreePath); } catch (error: unknown) { if (missing(error)) pathExists = false; else return output(request, "reconciliation_required", "Worktree path could not be inspected.", checks, identity); }
    if (!pathExists && entry === undefined) return this.#release(request, ownership.value.ownershipToken, ownership.value.version, [...checks, "removal_reconciled"], identity, "Workspace removal was reconciled with durable ownership.");
    if (!pathExists || entry === undefined) return output(request, "conflict", "Worktree registration and filesystem state disagree.", checks, identity); checks.push("registered_worktree");
    if (entry.branch !== ownership.value.assignedBranch || entry.head !== ownership.value.currentRevision) return output(request, "protected_diverged", "Registered worktree identity diverged from durable ownership.", checks, identity);
    const status = await this.#git.run(["-C", canonical, "status", "--porcelain=v1", "--untracked-files=all"], root, timeout, request.signal);
    if (status.outcome !== "success") return output(request, commandOutcome(status.outcome), "Worktree cleanliness could not be inspected.", checks, identity);
    if (status.stdout.trim() !== "") return output(request, "protected_dirty", "Worktree contains uncommitted or untracked changes and was preserved.", checks, identity); checks.push("clean_worktree");
    const head = await this.#git.run(["-C", canonical, "rev-parse", "HEAD"], root, timeout, request.signal); const branch = await this.#git.run(["-C", canonical, "symbolic-ref", "--short", "HEAD"], root, timeout, request.signal);
    if (head.outcome !== "success" || branch.outcome !== "success") return output(request, commandOutcome(head.outcome !== "success" ? head.outcome : branch.outcome), "Worktree revision and branch could not be verified.", checks, identity);
    if (head.stdout.trim().toLowerCase() !== ownership.value.currentRevision || branch.stdout.trim() !== ownership.value.assignedBranch) return output(request, "protected_diverged", "Worktree HEAD or branch changed after ownership was recorded.", checks, identity); checks.push("exact_head");
    if (request.disposition === "task_completed") {
      const remote = request.remoteName ?? "origin"; const remoteHead = await this.#git.run(["ls-remote", "--exit-code", remote, `refs/heads/${ownership.value.assignedBranch}`], root, timeout, request.signal);
      if (remoteHead.outcome !== "success") return output(request, remoteHead.outcome === "git_failure" ? "protected_diverged" : commandOutcome(remoteHead.outcome), "Assigned remote branch could not be verified; worktree was preserved.", checks, identity);
      const rows = remoteHead.stdout.trim().split(/\r?\n/u).filter(Boolean); const remoteRevision = rows.length === 1 ? rows[0]?.split(/\s+/u)[0]?.toLowerCase() : undefined;
      if (remoteRevision !== ownership.value.currentRevision) return output(request, "protected_diverged", "Remote branch does not contain the exact completed Attempt revision.", checks, identity); checks.push("remote_revision");
    } else if (ownership.value.currentRevision !== ownership.value.expectedBaseRevision) return output(request, "protected_diverged", "Abandoned worktree contains commits beyond its base revision and was preserved.", checks, identity); else checks.push("unchanged_abandoned_head");
    const removed = await this.#git.run(["worktree", "remove", canonical], root, timeout, request.signal); if (removed.outcome !== "success") return output(request, commandOutcome(removed.outcome), "Git worktree removal did not complete.", checks, identity);
    const verified = await this.#git.run(["worktree", "list", "--porcelain"], root, timeout, request.signal); if (verified.outcome !== "success" || parseWorktrees(verified.stdout).some((item) => item.path === canonical)) return output(request, "reconciliation_required", "Worktree removal could not be verified.", checks, identity);
    try { await stat(canonical); return output(request, "reconciliation_required", "Removed worktree path still exists.", checks, identity); } catch (error: unknown) { if (!missing(error)) return output(request, "reconciliation_required", "Removed worktree path could not be verified.", checks, identity); }
    checks.push("worktree_removed"); return this.#release(request, ownership.value.ownershipToken, ownership.value.version, checks, identity, "Owned worktree was removed and durable ownership was released.");
  }
  #release(request: WorkspaceCleanupRequest, token: string, version: number, checks: readonly string[], identity: { readonly worktreePath: string; readonly assignedBranch: string; readonly revision: string }, message: string): WorkspaceCleanupResult {
    const released = this.#store.workspaces.release(request.attemptId, token, version, request.now); if (released.outcome === "success") return output(request, "removed", message, [...checks, "ownership_released"], identity);
    const current = this.#store.workspaces.getByTaskAttempt(request.taskId, request.attemptId); if (current.outcome === "success" && current.value.state === "released") return output(request, "already_removed", "Workspace cleanup was already durably completed.", [...checks, "ownership_released"], identity);
    return output(request, "reconciliation_required", "Worktree is absent but durable ownership release requires reconciliation.", checks, identity);
  }
}
