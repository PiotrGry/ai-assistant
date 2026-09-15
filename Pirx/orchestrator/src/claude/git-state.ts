import { GitWorkspaceCommandRunner } from "../runtime/workspace.js";
import type { WorkerRequest, WorkerResult } from "../runtime/worker-contract.js";
import type { ClaudeCodeRepositoryPolicy } from "./worker-profile.js";

export interface WorkerGitStateVerification {
  readonly ok: boolean;
  readonly message: string;
}

export interface WorkerGitStateVerifier {
  verify(request: WorkerRequest, result: Extract<WorkerResult, { readonly outcome: "CODE_PUSHED" }>, policy: ClaudeCodeRepositoryPolicy): Promise<WorkerGitStateVerification>;
}

function fail(message: string): WorkerGitStateVerification { return { ok: false, message: message.slice(0, 256) }; }

export class GitWorkerStateVerifier implements WorkerGitStateVerifier {
  readonly #git: GitWorkspaceCommandRunner;

  public constructor(git = new GitWorkspaceCommandRunner()) { this.#git = git; }

  public async verify(request: WorkerRequest, result: Extract<WorkerResult, { readonly outcome: "CODE_PUSHED" }>, policy: ClaudeCodeRepositoryPolicy): Promise<WorkerGitStateVerification> {
    if (request.workspace.worktree !== policy.assignedWorktree || result.branch !== request.workspace.branch) return fail("Worker result workspace or branch does not match the assigned policy.");
    if (!/^[0-9a-f]{4,64}$/iu.test(result.finalCommit)) return fail("Worker result final commit is not a valid Git revision.");
    const branch = await this.#git.run(["symbolic-ref", "--short", "HEAD"], request.workspace.worktree, 30_000);
    if (branch.outcome !== "success" || branch.stdout.trim() !== request.workspace.branch) return fail("Assigned worktree is not on the requested branch.");
    const head = await this.#git.run(["rev-parse", "HEAD"], request.workspace.worktree, 30_000);
    if (head.outcome !== "success" || head.stdout.trim().toLowerCase() !== result.finalCommit.toLowerCase()) return fail("Local Git HEAD does not match the worker result.");
    const status = await this.#git.run(["status", "--porcelain=v1", "--untracked-files=all"], request.workspace.worktree, 30_000);
    if (status.outcome !== "success" || status.stdout.length !== 0) return fail("Assigned worktree is not clean after the reported commit.");
    const remote = await this.#git.run(["ls-remote", "--heads", policy.remoteName, `refs/heads/${request.workspace.branch}`], request.workspace.worktree, 30_000);
    if (remote.outcome !== "success") return fail("Assigned remote branch could not be verified.");
    const remoteSha = remote.stdout.trim().split(/\s+/u)[0]?.toLowerCase();
    if (remoteSha !== result.finalCommit.toLowerCase()) return fail("Assigned remote branch does not match the worker result.");
    return { ok: true, message: "Local and remote Git state match the assigned worker result." };
  }
}
