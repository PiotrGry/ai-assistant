import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubIssueMutator,
  GitHubIssueLifecycleRoundTrip,
  GitHubIssueReader,
  GitHubWriteQueue,
  type GitHubIssueMutationTransport,
  type GitHubOperationResult,
  type GitHubRequestContext,
  type GitHubRestReadRequest,
  type GitHubRestWriteRequest,
} from "../src/index.js";

const config = { owner: "PiotrGry", repository: "ai-assistant", timeoutMs: 100 } as const;

function success<T>(value: T, correlationId = "mutation-correlation"): GitHubOperationResult<T> {
  return { outcome: "success", value, correlationId, remoteOutcome: "accepted", response: { status: 200, rateLimit: {} } };
}

function errorCode(result: GitHubOperationResult<unknown>): string {
  if (result.outcome === "success") throw new Error("expected failure");
  return result.error.code;
}

function issuePayload(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: `node-${number}`,
    number,
    html_url: `https://github.com/PiotrGry/ai-assistant/issues/${number}`,
    title: "Controlled issue",
    body: "Initial body",
    state: "open",
    user: { login: "piotr" },
    labels: [{ name: "github", color: "0366d6" }],
    assignees: [],
    milestone: null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-02T10:00:00Z",
    closed_at: null,
    ...overrides,
  };
}

class FakeMutationTransport implements GitHubIssueMutationTransport {
  issue = issuePayload(48);
  readonly comments: Array<Record<string, unknown>> = [];
  readonly writes: GitHubRestWriteRequest[] = [];
  readonly reads: GitHubRestReadRequest[] = [];
  nextCommentId = 700;
  writeResult: GitHubOperationResult<unknown> | undefined;

  async restRead<T>(request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    this.reads.push(request);
    if (request.path.endsWith("/comments")) return success(this.comments, context.correlationId) as GitHubOperationResult<T>;
    if (request.path.endsWith("/issues")) return success(this.staleRestList ? [] : [this.issue], context.correlationId) as GitHubOperationResult<T>;
    return success(this.issue, context.correlationId) as GitHubOperationResult<T>;
  }

  async restWrite<T>(request: GitHubRestWriteRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    this.writes.push(request);
    if (this.writeResult !== undefined) return this.writeResult as GitHubOperationResult<T>;
    if (request.path.endsWith("/comments")) {
      const body = (request.body as { body: string }).body;
      const comment = { id: this.nextCommentId++, html_url: `https://github.com/PiotrGry/ai-assistant/issues/48#issuecomment-${this.nextCommentId}`, body };
      this.comments.push(comment);
      return success(comment, context.correlationId) as GitHubOperationResult<T>;
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (request.method === "POST") {
      this.issue = issuePayload(49, body);
      return success({ number: 49 }, context.correlationId) as GitHubOperationResult<T>;
    }
    this.issue = issuePayload(48, {
      ...this.issue,
      ...body,
      labels: Array.isArray(body.labels) ? (body.labels as string[]).map((name) => ({ name })) : this.issue.labels,
      assignees: Array.isArray(body.assignees) ? (body.assignees as string[]).map((login) => ({ login })) : this.issue.assignees,
      milestone: body.milestone === null ? null : this.issue.milestone,
      updated_at: "2026-09-03T10:00:00Z",
    });
    return success({ number: 48 }, context.correlationId) as GitHubOperationResult<T>;
  }

  // On GitHub, search and REST Issue lists lag a just-created Issue by seconds; the GraphQL Issue connection does not.
  staleSearch = false;
  staleRestList = false;

  async graphqlRead<T>(request: { query: string; variables?: Readonly<Record<string, unknown>> }, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    const issue = this.issue;
    const node = {
      ...issue,
      id: issue.node_id,
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      labels: { nodes: issue.labels },
      assignees: { nodes: issue.assignees },
    };
    if (!request.query.includes("search(")) {
      const newestFirst = request.query.includes("CREATED_AT") && request.query.includes("DESC");
      return success({ repository: { issues: { nodes: newestFirst ? [node] : [] } } }, context.correlationId) as GitHubOperationResult<T>;
    }
    const text = typeof request.variables?.query === "string" ? request.variables.query : "";
    const issueBody = typeof issue.body === "string" ? issue.body : "";
    // Like GitHub search, matching is fuzzy: any Pirx operation marker matches any marker query.
    const payload = !this.staleSearch && issueBody.length > 0 && text.length > 0 && issueBody.includes("pirx-operation") ? [node] : [];
    return success({ search: { nodes: payload, pageInfo: { hasNextPage: false, endCursor: null } } }, context.correlationId) as GitHubOperationResult<T>;
  }
}

function createMutator(transport: FakeMutationTransport, capacity = 10): GitHubIssueMutator {
  const reader = new GitHubIssueReader(transport, config, { retryPolicy: { maxAttempts: 1 } });
  return new GitHubIssueMutator(transport, reader, new GitHubWriteQueue({ capacity }), config, { retryPolicy: { maxAttempts: 1 } });
}

function postCount(transport: FakeMutationTransport): number {
  return transport.writes.filter((write) => write.method === "POST" && write.path.endsWith("/issues")).length;
}

test("create replay finds a just-created Issue before search and REST lists catch up", async () => {
  const transport = new FakeMutationTransport();
  transport.staleSearch = true;
  transport.staleRestList = true;
  const first = await createMutator(transport).createIssue({ title: "Replayed issue", body: "hello", idempotencyKey: "create-replay-1" });
  assert.equal(first.outcome, "success");

  // A fresh mutator models a new process (for example an MCP server restart) with no in-memory queue state.
  const replay = await createMutator(transport).createIssue({ title: "Replayed issue", body: "hello", idempotencyKey: "create-replay-1" });
  assert.equal(replay.outcome, "success");
  if (replay.outcome !== "success") return;
  assert.equal(postCount(transport), 1);
  assert.equal(replay.value.issue.number, 49);
  assert.equal(replay.value.noOp, true);
});

test("create does not treat an Issue carrying another operation marker as a replay", async () => {
  const transport = new FakeMutationTransport();
  const mutator = createMutator(transport);
  assert.equal((await mutator.createIssue({ title: "First", idempotencyKey: "create-a" })).outcome, "success");

  const second = await mutator.createIssue({ title: "Second", idempotencyKey: "create-b" });
  assert.equal(second.outcome, "success");
  if (second.outcome !== "success") return;
  assert.equal(postCount(transport), 2);
  assert.equal(second.value.noOp, false);
});

test("create and update use focused payloads and verify the canonical Issue", async () => {
  const transport = new FakeMutationTransport();
  const mutator = createMutator(transport);
  const created = await mutator.createIssue({ title: "New controlled issue", body: "hello", idempotencyKey: "create-1", correlationId: "create-correlation" });
  assert.equal(created.outcome, "success");
  assert.equal(transport.writes[0]?.method, "POST");
  assert.equal((transport.writes[0]?.body as { title: string }).title, "New controlled issue");

  const updated = await mutator.updateIssue({
    issue: 48,
    patch: { body: "Updated", labels: [], assignees: [], milestone: "none" },
    expected: { state: "open" },
    idempotencyKey: "update-1",
    correlationId: "update-correlation",
  });
  assert.equal(updated.outcome, "success");
  assert.equal(transport.writes.at(-1)?.method, "PATCH");
  assert.deepEqual(transport.writes.at(-1)?.body, { body: "Updated", labels: [], assignees: [], milestone: null });
});

test("updates avoid writes for no-op patches and reject stale expected state", async () => {
  const transport = new FakeMutationTransport();
  const mutator = createMutator(transport);
  const noOp = await mutator.updateIssue({ issue: 48, patch: { title: "Controlled issue" }, idempotencyKey: "noop-1" });
  assert.equal(noOp.outcome, "success");
  assert.equal(noOp.outcome === "success" ? noOp.value.noOp : false, true);
  assert.equal(transport.writes.length, 0);

  const conflict = await mutator.updateIssue({ issue: 48, patch: { title: "Concurrent edit" }, expected: { state: "closed" }, idempotencyKey: "conflict-1" });
  assert.equal(conflict.outcome, "permanent_error");
  assert.equal(errorCode(conflict), "conflict");
  assert.equal(transport.writes.length, 0);
});

test("close and reopen are explicit state patches", async () => {
  const transport = new FakeMutationTransport();
  const mutator = createMutator(transport);
  assert.equal((await mutator.closeIssue({ issue: 48, idempotencyKey: "close-1" })).outcome, "success");
  assert.deepEqual(transport.writes[0]?.body, { state: "closed" });
  transport.issue = issuePayload(48, { state: "closed" });
  assert.equal((await mutator.reopenIssue({ issue: 48, idempotencyKey: "reopen-1" })).outcome, "success");
  assert.deepEqual(transport.writes[1]?.body, { state: "open" });
});

test("lifecycle comments are sanitized, marked, and deduplicated", async () => {
  const transport = new FakeMutationTransport();
  const mutator = createMutator(transport);
  const request = {
    issue: 48,
    idempotencyKey: "comment-1",
    envelope: {
      eventId: "event-1",
      eventType: "task.completed",
      taskId: "task-1",
      attemptId: "attempt-1",
      timestamp: "2026-09-11T10:00:00Z",
      summary: "  completed\nwithout raw worker output  ",
      branch: "main",
      commit: "abc123",
    },
  } as const;
  const first = await mutator.publishLifecycleComment(request);
  const second = await mutator.publishLifecycleComment(request);
  assert.equal(first.outcome, "success");
  assert.equal(second.outcome, "success");
  assert.equal(first.outcome === "success" ? first.value.changed : false, true);
  assert.equal(second.outcome === "success" ? second.value.noOp : false, true);
  assert.equal(transport.writes.length, 1);
  assert.equal(transport.comments.length, 1);
  assert.match(String(transport.comments[0]?.body), /pirx-operation:v1/u);

  const unsafe = await mutator.publishLifecycleComment({ ...request, idempotencyKey: "unsafe", envelope: { ...request.envelope, summary: "Authorization: Bearer secret" } });
  assert.equal(unsafe.outcome, "permanent_error");
  assert.equal(errorCode(unsafe), "invalid_request");
});

test("queue rejection, malformed responses, and uncertain writes stay normalized", async () => {
  const transport = new FakeMutationTransport();
  const mutator = createMutator(transport, 1);
  transport.writeResult = { outcome: "unknown", correlationId: "uncertain", remoteOutcome: "unknown", error: { code: "timeout", message: "timed out" } };
  const unknown = await mutator.updateIssue({ issue: 48, patch: { title: "new" }, idempotencyKey: "uncertain-1" });
  assert.equal(unknown.outcome, "unknown");

  transport.writeResult = { outcome: "success", correlationId: "malformed", remoteOutcome: "accepted", value: {} };
  const malformed = await mutator.updateIssue({ issue: 48, patch: { title: "newer" }, idempotencyKey: "malformed-1" });
  assert.equal(malformed.outcome, "unknown");
  assert.equal(errorCode(malformed), "malformed_response");
});

test("round-trip reads, mutates, verifies, and proves replay is a no-op", async () => {
  const transport = new FakeMutationTransport();
  const reader = new GitHubIssueReader(transport, config, { retryPolicy: { maxAttempts: 1 } });
  const mutator = new GitHubIssueMutator(transport, reader, new GitHubWriteQueue(), config, { retryPolicy: { maxAttempts: 1 } });
  const roundTrip = new GitHubIssueLifecycleRoundTrip(reader, mutator);
  const result = await roundTrip.execute({
    issue: 48,
    idempotencyKey: "round-trip-1",
    lifecycle: {
      eventId: "round-trip-event",
      eventType: "poc.completed",
      taskId: "task-176",
      timestamp: "2026-09-11T10:00:00Z",
      summary: "Controlled round-trip test.",
    },
    replay: true,
    correlationId: "round-trip-correlation",
  });
  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") return;
  assert.equal(result.value.issue.number, 48);
  assert.equal(result.value.comment.id, result.value.replayComment?.id);
  assert.equal(result.value.replayNoOp, true);
  assert.equal(transport.comments.length, 1);
  assert.equal(transport.writes.length, 1);
});
