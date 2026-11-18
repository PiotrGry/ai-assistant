import type { GitHubIssueMutator } from "./issue-mutate.js";

export interface TaskIssueCloseRequest {
  readonly issueNumber: number;
  readonly taskId: string;
  readonly attemptId: string;
  readonly commit: string;
  readonly summary: string;
  readonly timestamp: string;
}
export interface TaskIssueCloseResult { readonly closed: boolean; readonly message: string }

/**
 * Projects a completed Task onto its Issue: one idempotent `task_completed` comment with the
 * completion evidence, then the Issue is closed. A project board moves it to Done itself.
 */
export class GitHubTaskIssueCloser {
  readonly #mutator: Pick<GitHubIssueMutator, "publishLifecycleComment" | "closeIssue">;
  public constructor(mutator: Pick<GitHubIssueMutator, "publishLifecycleComment" | "closeIssue">) { this.#mutator = mutator; }

  public async close(request: TaskIssueCloseRequest): Promise<TaskIssueCloseResult> {
    const comment = await this.#mutator.publishLifecycleComment({ issue: request.issueNumber, envelope: { eventId: `task_completed:${request.taskId}`, eventType: "task_completed", taskId: request.taskId, attemptId: request.attemptId, timestamp: request.timestamp, summary: request.summary, commit: request.commit } });
    if (comment.outcome !== "success") return { closed: false, message: `Issue #${request.issueNumber} was not closed: the completion comment failed (${comment.error.message}).` };
    const closed = await this.#mutator.closeIssue({ issue: request.issueNumber, idempotencyKey: `task-completed-close:${request.taskId}` });
    return closed.outcome === "success" ? { closed: true, message: `Closed Issue #${request.issueNumber}.` } : { closed: false, message: `Issue #${request.issueNumber} was not closed: ${closed.error.message}` };
  }
}
