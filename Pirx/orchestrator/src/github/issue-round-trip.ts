import { randomUUID } from "node:crypto";

import {
  failure,
  type GitHubOperationResult,
} from "./outcome.js";
import {
  GitHubIssueMutator,
  type GitHubCommentRef,
  type GitHubLifecycleCommentEnvelope,
} from "./issue-mutate.js";
import type { GitHubIssueRef, GitHubIssueReader, GitHubIssueState, GitHubIssueSummary } from "./issue-read.js";

export interface GitHubIssueRoundTripRequest {
  readonly issue: number | GitHubIssueRef;
  readonly lifecycle: GitHubLifecycleCommentEnvelope;
  /** Reuses the same logical operation to prove idempotent replay. */
  readonly replay?: boolean;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly timeoutMs?: number;
}

export interface GitHubIssueRoundTripEvidence {
  readonly issue: GitHubIssueRef;
  readonly initialState: GitHubIssueState;
  readonly verifiedState: GitHubIssueState;
  readonly initialUpdatedAt: string;
  readonly verifiedUpdatedAt: string;
  readonly comment: GitHubCommentRef;
  readonly changed: boolean;
  readonly replayed: boolean;
  readonly replayNoOp?: boolean;
  readonly replayComment?: GitHubCommentRef;
}

function issueNumber(issue: number | GitHubIssueRef): number | undefined {
  if (typeof issue === "number") return Number.isSafeInteger(issue) && issue > 0 ? issue : undefined;
  return Number.isSafeInteger(issue.number) && issue.number > 0 ? issue.number : undefined;
}

function ref(issue: GitHubIssueSummary): GitHubIssueRef {
  return {
    owner: issue.owner,
    repository: issue.repository,
    nodeId: issue.nodeId,
    number: issue.number,
    url: issue.url,
  };
}

export class GitHubIssueLifecycleRoundTrip {
  readonly #reader: GitHubIssueReader;
  readonly #mutator: GitHubIssueMutator;

  constructor(reader: GitHubIssueReader, mutator: GitHubIssueMutator) {
    this.#reader = reader;
    this.#mutator = mutator;
  }

  async execute(request: GitHubIssueRoundTripRequest): Promise<GitHubOperationResult<GitHubIssueRoundTripEvidence>> {
    const correlationId = request.correlationId?.trim() || randomUUID();
    const number = issueNumber(request.issue);
    if (number === undefined) return failure("permanent_error", "invalid_request", "Round-trip Issue number must be a positive integer.", correlationId, "not_accepted");
    const initial = await this.#reader.getIssue(number, { correlationId });
    if (initial.outcome !== "success") return initial as GitHubOperationResult<GitHubIssueRoundTripEvidence>;

    const idempotencyKey = request.idempotencyKey?.trim() || `round-trip:${initial.value.owner}/${initial.value.repository}#${number}:${request.lifecycle.eventId}`;
    const mutation = await this.#mutator.publishLifecycleComment({
      issue: initial.value,
      envelope: request.lifecycle,
      idempotencyKey,
      correlationId,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    if (mutation.outcome !== "success") return mutation as GitHubOperationResult<GitHubIssueRoundTripEvidence>;

    const verified = await this.#reader.getIssue(number, { correlationId });
    if (verified.outcome !== "success") {
      return failure("unknown", "unknown", "GitHub accepted the lifecycle mutation but Issue verification failed.", correlationId, "unknown", verified.response);
    }
    if (verified.value.nodeId !== initial.value.nodeId || verified.value.number !== initial.value.number) {
      return failure("permanent_error", "conflict", "Round-trip verification returned a different Issue identity.", correlationId, "not_accepted", verified.response);
    }

    let replayNoOp: boolean | undefined;
    let replayComment: GitHubCommentRef | undefined;
    if (request.replay !== false) {
      const replay = await this.#mutator.publishLifecycleComment({
        issue: initial.value,
        envelope: request.lifecycle,
        idempotencyKey,
        correlationId,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      });
      if (replay.outcome !== "success") return replay as GitHubOperationResult<GitHubIssueRoundTripEvidence>;
      replayNoOp = replay.value.noOp;
      replayComment = replay.value.comment;
      if (!replay.value.noOp || replay.value.comment.id !== mutation.value.comment.id) {
        return failure("permanent_error", "conflict", "Lifecycle replay produced a duplicate or different comment.", correlationId, "not_accepted");
      }
    }

    return {
      outcome: "success",
      value: {
        issue: ref(initial.value),
        initialState: initial.value.state,
        verifiedState: verified.value.state,
        initialUpdatedAt: initial.value.updatedAt,
        verifiedUpdatedAt: verified.value.updatedAt,
        comment: mutation.value.comment,
        changed: mutation.value.changed,
        replayed: request.replay !== false,
        ...(replayNoOp === undefined ? {} : { replayNoOp }),
        ...(replayComment === undefined ? {} : { replayComment }),
      },
      correlationId,
      remoteOutcome: "accepted",
      ...(verified.response === undefined ? {} : { response: verified.response }),
    };
  }
}
